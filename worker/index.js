// =============================================================
// Worker zca-js cho Chat Zalo (CRM iHomeCRM)
//
// Vai trò: giữ phiên Zalo CÁ NHÂN (QR login), đọc hàng đợi gửi (zalo_send_queue)
// rồi gửi bằng zca-js, và nghe tin đến rồi ghi vào zalo_messages. Web chỉ nói
// chuyện với Supabase; Realtime tự đẩy thay đổi sang trình duyệt.
//
// Chạy LOCAL trước (máy bạn) để quét QR/test, rồi đưa lên VPS (pm2/systemd) để
// giữ phiên 24/7. KHÔNG deploy lên Vercel. Xem ../docs/zalo/ZALO-WORKER-SETUP.md
//
// Đa tài khoản: 1 worker giữ nhiều phiên (Map theo account_id). Web bấm "Kết nối"
// → account.status='connecting' → worker loginQR → ghi qr_data → user quét →
// status='connected'.
//
// ⚠️ zca-js là API Zalo cá nhân không chính thức (rủi ro khoá nick) — dùng tài
// khoản phụ, KHÔNG mở Zalo Web nơi khác cùng nick. Một số tên hàm/event của
// zca-js có thể đổi theo phiên bản — chỗ nào nhạy cảm đã chú thích để bạn chỉnh.
// =============================================================
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { createClient } from '@supabase/supabase-js';
import { Zalo, ThreadType } from 'zca-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, 'sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY trong .env');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const POLL_MS = 2000;
const sessions = new Map();          // account_id -> { api, ownId }
const loggingIn = new Set();         // account_id đang chạy loginQR

const sessFile = (id) => path.join(SESSION_DIR, `${id}.json`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function setAccount(id, patch) {
  const { error } = await sb.from('zalo_accounts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) log('setAccount error', id, error.message);
}

// ── Map event message zca-js → row inbound ──
function pickText(m) {
  const c = m?.data?.content;
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') return c.title || c.text || '';
  return m?.data?.message || '';
}
function threadTypeOf(m) {
  return m?.type === ThreadType.Group ? 'group' : 'user';
}
function threadIdOf(m) {
  return String(m?.threadId ?? m?.data?.threadId ?? m?.data?.uidFrom ?? '');
}

async function upsertConversation(accountId, ownerId, m) {
  const threadId = threadIdOf(m);
  const ttype = threadTypeOf(m);
  let { data: conv } = await sb.from('zalo_conversations')
    .select('id, unread_count').eq('account_id', accountId).eq('thread_id', threadId).maybeSingle();
  if (!conv) {
    const peerName = m?.data?.dName || m?.data?.fromName || 'Khách Zalo';
    const ins = await sb.from('zalo_conversations').insert({
      user_id: ownerId, account_id: accountId, thread_id: threadId, thread_type: ttype,
      peer_name: peerName, peer_zalo_uid: String(m?.data?.uidFrom ?? ''), kind: 'unknown',
    }).select('id, unread_count').single();
    conv = ins.data;
  }
  return conv;
}

async function handleInbound(accountId, ownerId, m) {
  try {
    if (m?.isSelf) return;                       // tin mình gửi đã có trong DB
    const conv = await upsertConversation(accountId, ownerId, m);
    if (!conv) return;
    const body = pickText(m);
    await sb.from('zalo_messages').insert({
      user_id: ownerId, conversation_id: conv.id, account_id: accountId,
      direction: 'in', msg_type: 'text', body,
      zalo_msg_id: String(m?.data?.msgId ?? ''), cli_msg_id: String(m?.data?.cliMsgId ?? ''),
      status: 'delivered', created_at: new Date().toISOString(),
    });
    await sb.from('zalo_conversations').update({
      last_message_text: body || '[Tin nhắn]', last_message_at: new Date().toISOString(),
      last_message_dir: 'in', unread_count: (conv.unread_count || 0) + 1,
    }).eq('id', conv.id);
    log('inbound →', conv.id, body.slice(0, 40));
  } catch (e) { log('handleInbound error', e.message); }
}

async function attachSession(accountId, ownerId, api) {
  let ownId = '';
  try { ownId = await api.getOwnId?.(); } catch { /* ignore */ }
  sessions.set(accountId, { api, ownId });
  try {
    api.listener.on('message', (m) => handleInbound(accountId, ownerId, m));
    api.listener.on('error', (e) => log('listener error', accountId, e?.message || e));
    api.listener.start();
  } catch (e) { log('listener start error', e.message); }
}

function saveSession(accountId, ctx) {
  try { fs.writeFileSync(sessFile(accountId), JSON.stringify(ctx), 'utf8'); } catch (e) { log('saveSession error', e.message); }
}
function loadSession(accountId) {
  try { return JSON.parse(fs.readFileSync(sessFile(accountId), 'utf8')); } catch { return null; }
}

// ── Đăng nhập QR cho 1 account đang 'connecting' ──
async function startLoginQR(account, ownerId) {
  const id = account.id;
  if (loggingIn.has(id) || sessions.has(id)) return;
  loggingIn.add(id);
  log('loginQR start', id);

  const zalo = new Zalo();
  try {
    const api = await zalo.loginQR({}, async (ev) => {
      // zca-js phát event khi sinh QR / quét / đăng nhập. Tên có thể khác theo
      // phiên bản → bắt linh hoạt: lấy ảnh QR base64 hoặc URL để render.
      const t = String(ev?.type ?? '');
      const d = ev?.data || {};
      const img = d.image || d.qrCode || d.content?.image;
      const codeStr = d.code || d.url || d.content?.code;
      if (img || (/qr/i.test(t) && codeStr)) {
        let dataUrl = null;
        if (img) dataUrl = String(img).startsWith('data:') ? img : `data:image/png;base64,${img}`;
        else if (codeStr) dataUrl = await QRCode.toDataURL(String(codeStr));
        if (dataUrl) {
          await setAccount(id, { status: 'waiting_scan', qr_data: dataUrl, qr_expires_at: new Date(Date.now() + 4 * 60000).toISOString() });
          log('QR ready', id);
        }
      }
    });

    // Đăng nhập thành công
    let ctx = null, name = account.name, uid = '';
    try { ctx = api.getContext?.(); } catch { /* */ }
    try { const info = await api.fetchAccountInfo?.(); name = info?.profile?.displayName || info?.displayName || name; } catch { /* */ }
    try { uid = await api.getOwnId?.(); } catch { /* */ }
    if (ctx) saveSession(id, ctx);
    await setAccount(id, { status: 'connected', qr_data: null, qr_expires_at: null, last_error: null, name, zalo_uid: String(uid || '') });
    await attachSession(id, ownerId, api);
    log('connected', id, name);
  } catch (e) {
    log('loginQR error', id, e?.message || e);
    await setAccount(id, { status: 'error', qr_data: null, last_error: String(e?.message || e).slice(0, 300) });
  } finally {
    loggingIn.delete(id);
  }
}

// ── Re-login từ cookie đã lưu (khởi động lại / VPS) ──
async function tryRelogin(account, ownerId) {
  if (sessions.has(account.id) || loggingIn.has(account.id)) return;
  const ctx = loadSession(account.id);
  if (!ctx) return;
  loggingIn.add(account.id);
  try {
    const zalo = new Zalo();
    const api = await zalo.login(ctx);          // login bằng {cookie, imei, userAgent}
    await attachSession(account.id, ownerId, api);
    await setAccount(account.id, { status: 'connected', last_error: null });
    log('re-login ok', account.id);
  } catch (e) {
    log('re-login fail', account.id, e?.message || e);
  } finally { loggingIn.delete(account.id); }
}

// ── Gửi 1 job trong hàng đợi ──
async function processJob(job) {
  const s = sessions.get(job.account_id);
  await sb.from('zalo_send_queue').update({ status: 'processing' }).eq('id', job.id);
  if (!s) {
    await sb.from('zalo_send_queue').update({ status: 'failed', last_error: 'Tài khoản chưa kết nối', attempts: (job.attempts || 0) + 1 }).eq('id', job.id);
    if (job.message_id) await sb.from('zalo_messages').update({ status: 'failed' }).eq('id', job.message_id);
    return;
  }
  try {
    const { data: conv } = await sb.from('zalo_conversations').select('thread_id, thread_type').eq('id', job.conversation_id).single();
    const type = conv?.thread_type === 'group' ? ThreadType.Group : ThreadType.User;
    const p = job.payload || {};
    const res = await s.api.sendMessage({ msg: p.body || '', ...(p.reply_to ? { quote: p.reply_to } : {}) }, conv.thread_id, type);
    const zid = res?.message?.msgId || res?.msgId || '';
    const cid = res?.message?.cliMsgId || res?.cliMsgId || '';
    if (job.message_id) await sb.from('zalo_messages').update({ status: 'sent', zalo_msg_id: String(zid), cli_msg_id: String(cid) }).eq('id', job.message_id);
    await sb.from('zalo_send_queue').update({ status: 'sent', processed_at: new Date().toISOString() }).eq('id', job.id);
    log('sent', job.id);
  } catch (e) {
    log('send error', job.id, e?.message || e);
    await sb.from('zalo_send_queue').update({ status: 'failed', last_error: String(e?.message || e).slice(0, 300), attempts: (job.attempts || 0) + 1 }).eq('id', job.id);
    if (job.message_id) await sb.from('zalo_messages').update({ status: 'failed' }).eq('id', job.message_id);
  }
}

// ── Vòng lặp chính ──
let booted = false;
async function tick() {
  // accounts cần đăng nhập / re-login
  const { data: accounts } = await sb.from('zalo_accounts').select('id, user_id, name, status').eq('kind', 'personal');
  for (const a of accounts || []) {
    if (a.status === 'connecting' || a.status === 'waiting_scan') startLoginQR(a, a.user_id);
    else if (!booted && a.status === 'connected') tryRelogin(a, a.user_id);
  }
  booted = true;

  // hàng đợi gửi
  const { data: jobs } = await sb.from('zalo_send_queue')
    .select('*').eq('channel', 'personal').eq('status', 'queued').order('created_at', { ascending: true }).limit(10);
  for (const j of jobs || []) await processJob(j);
}

log('Zalo worker khởi động →', SUPABASE_URL);
tick();
const timer = setInterval(() => { tick().catch((e) => log('tick error', e.message)); }, POLL_MS);

// Graceful shutdown
function shutdown() {
  log('shutting down…');
  clearInterval(timer);
  for (const [id, s] of sessions) { try { s.api.listener.stop(); } catch { /* */ } log('stopped', id); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
