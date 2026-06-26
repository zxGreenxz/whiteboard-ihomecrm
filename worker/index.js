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
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { createClient } from '@supabase/supabase-js';
import { Zalo, ThreadType } from 'zca-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Nạp .env NẰM CẠNH worker (chạy từ bất kỳ thư mục nào cũng đúng)
dotenv.config({ path: path.join(__dirname, '.env') });
const SESSION_DIR = path.join(__dirname, 'sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY trong', path.join(__dirname, '.env'));
  console.error('→ Mở worker/.env và điền SUPABASE_SERVICE_ROLE_KEY (Supabase ▸ Settings ▸ API ▸ service_role).');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const POLL_MS = 2000;
const sessions = new Map();          // account_id -> { api, ownId }
const loggingIn = new Set();         // account_id đang chạy loginQR

const sessFile = (id) => path.join(SESSION_DIR, `${id}.json`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Cô lập "thiết bị" đa-nick: mỗi nick một user-agent THẬT, cố định theo account_id.
// (imei = randomUUID + MD5(UA) nên UA khác ⇒ imei khác; cookie đã tách theo file phiên.)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
function uaFor(accountId) {
  let h = 0;
  const s = String(accountId);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return USER_AGENTS[h % USER_AGENTS.length];
}

async function setAccount(id, patch) {
  const { error } = await sb.from('zalo_accounts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) log('setAccount error', id, error.message);
}

// ── Web Push: gọi edge function send-push (service role) — fire & forget ──
async function notifyPush({ userId, title, body, url, tag }) {
  if (!userId) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({ userId, title, body, url, tag }),
    });
    if (!res.ok) log('notifyPush http', res.status);
  } catch (e) { log('notifyPush error', e?.message || e); }
}

// ── Map event message zca-js → row inbound ──
const MSGTYPE_LABEL = {
  'chat.photo': '[Hình ảnh]', 'chat.sticker': '[Sticker]', 'share.file': '[Tệp tin]',
  'chat.voice': '[Tin nhắn thoại]', 'chat.video.msg': '[Video]', 'chat.gif': '[GIF]',
  'chat.recommended': '[Danh thiếp]', 'share.contact': '[Danh thiếp]',
  'chat.location.new': '[Vị trí]', 'chat.location': '[Vị trí]', 'group.poll': '[Bình chọn]',
};
function pickText(m) {
  const d = m?.data || {};
  const c = d.content;
  if (typeof c === 'string' && c.trim()) return c;
  if (c && typeof c === 'object') {
    if (c.title && String(c.title).trim()) return String(c.title);
    if (c.description && String(c.description).trim()) return String(c.description);
    if (c.text && String(c.text).trim()) return String(c.text);
  }
  const lbl = MSGTYPE_LABEL[String(d.msgType || '')];
  if (lbl) return lbl;
  if (c && typeof c === 'object') return '[Hình ảnh / Tệp]';
  return typeof c === 'string' ? c : '[Tin nhắn]';
}

// Phân loại tin → {msg_type, body, media_url, media_label}. Ảnh giữ URL để FE hiện thật.
function classifyMessage(m) {
  const d = m?.data || {};
  const mt = String(d.msgType || '');
  const c = d.content;
  if (mt === 'chat.photo' && c && typeof c === 'object') {
    const url = c.href || c.thumb || c.normalUrl || null;
    const cap = c.title && String(c.title).trim() ? String(c.title) : '';
    return { msg_type: 'image', body: cap || '[Hình ảnh]', media_url: url, media_label: cap || 'Ảnh', media_meta: null };
  }
  if (mt === 'chat.video.msg' && c && typeof c === 'object') {
    const cap = c.title && String(c.title).trim() ? String(c.title) : '';
    let dur = null;
    try { dur = c.params ? JSON.parse(c.params).duration : null; } catch { /* */ }
    return { msg_type: 'video', body: cap || '[Video]', media_url: c.href || null, media_label: cap || 'Video', media_meta: { thumb: c.thumb || null, duration: dur } };
  }
  return { msg_type: 'text', body: pickText(m), media_url: null, media_label: null, media_meta: null };
}

// Reaction Zalo (zca code) ↔ emoji hiển thị
const ZCA_REACTIONS = [
  { emoji: '❤️', zca: '/-heart' }, { emoji: '👍', zca: '/-strong' }, { emoji: '😆', zca: ':>' },
  { emoji: '😮', zca: ':o' }, { emoji: '😢', zca: ':-((' }, { emoji: '😠', zca: ':-h' },
];
const zcaToEmoji = (code) => (ZCA_REACTIONS.find((r) => r.zca === code) || {}).emoji || code;
const emojiToZca = (e) => (ZCA_REACTIONS.find((r) => r.emoji === e) || {}).zca || e;

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
    // isSelf = tin do CHÍNH tài khoản gửi (kể cả từ điện thoại / máy khác) → lưu là 'out'.
    // Tin gửi từ web đã có sẵn (RPC); upsert theo zalo_msg_id chống trùng.
    const out = !!m?.isSelf;
    const conv = await upsertConversation(accountId, ownerId, m);
    if (!conv) return;
    const cm = classifyMessage(m);
    const body = cm.body;
    await sb.from('zalo_messages').upsert({
      user_id: ownerId, conversation_id: conv.id, account_id: accountId,
      direction: out ? 'out' : 'in', msg_type: cm.msg_type, body, media_url: cm.media_url, media_label: cm.media_label, media_meta: cm.media_meta || null,
      zalo_msg_id: m?.data?.msgId ? String(m.data.msgId) : null,
      cli_msg_id: m?.data?.cliMsgId ? String(m.data.cliMsgId) : null,
      status: out ? 'sent' : 'delivered', created_at: new Date().toISOString(),
    }, { onConflict: 'account_id,zalo_msg_id', ignoreDuplicates: true });
    await sb.from('zalo_conversations').update({
      last_message_text: body || '[Tin nhắn]', last_message_at: new Date().toISOString(),
      last_message_dir: out ? 'out' : 'in',
      unread_count: out ? 0 : (conv.unread_count || 0) + 1,   // tự gửi → coi như đã đọc
    }).eq('id', conv.id);
    log(out ? 'self →' : 'inbound →', conv.id, (body || '').slice(0, 40));
    // Tin ĐẾN (không phải mình gửi) → đẩy Web Push cho chủ tài khoản
    if (!out) {
      const peerName = m?.data?.dName || m?.data?.fromName || 'Zalo';
      notifyPush({
        userId: ownerId,
        title: `Tin nhắn Zalo · ${peerName}`,
        body: (body || '[Tin nhắn]').slice(0, 120),
        url: '/chat-zalo',
        tag: `zalo-${conv.id}`,
      });
    }
  } catch (e) { log('handleInbound error', e.message); }
}

async function attachSession(accountId, ownerId, api) {
  let ownId = '';
  try { ownId = await api.getOwnId?.(); } catch { /* ignore */ }
  sessions.set(accountId, { api, ownId });
  try {
    api.listener.on('message', (m) => handleInbound(accountId, ownerId, m));
    api.listener.on('old_messages', (msgs, type) => handleOldMessages(accountId, ownerId, msgs, type));
    api.listener.on('reaction', (e) => handleReaction(accountId, e));
    api.listener.on('undo', (e) => handleUndo(accountId, e));
    api.listener.on('seen_messages', (e) => handleSeen(accountId, e));
    api.listener.on('error', (e) => log('listener error', accountId, e?.message || e));
    api.listener.start();
    // Yêu cầu Zalo đẩy TIN GẦN ĐÂY (1-1 + nhóm) — đúng cách Zalo Web đồng bộ khi
    // kết nối; tin về qua event 'old_messages'. Chờ WS connect rồi mới gọi.
    setTimeout(() => {
      try { api.listener.requestOldMessages(ThreadType.User); } catch (e) { log('reqOld user', e?.message || e); }
      try { api.listener.requestOldMessages(ThreadType.Group); } catch (e) { log('reqOld group', e?.message || e); }
    }, 2000);
  } catch (e) { log('listener start error', e.message); }
  // Đồng bộ DANH BẠ + NHÓM về làm hội thoại (để web thấy ngay sau khi kết nối)
  syncContacts(api, accountId, ownerId).catch((e) => log('syncContacts error', e?.message || e));
}

// ── Upsert N tin vào 1 hội thoại (theo account+thread); tạo hội thoại nếu chưa có ──
async function upsertMessagesForThread(accountId, ownerId, threadId, tt, msgs) {
  if (!Array.isArray(msgs) || !msgs.length) return 0;
  let { data: conv } = await sb.from('zalo_conversations').select('id').eq('account_id', accountId).eq('thread_id', threadId).maybeSingle();
  if (!conv) {
    const f = msgs[0];
    const ins = await sb.from('zalo_conversations').insert({
      user_id: ownerId, account_id: accountId, thread_id: threadId, thread_type: tt,
      peer_name: f?.data?.dName || (tt === 'group' ? 'Nhóm Zalo' : 'Zalo'), peer_zalo_uid: String(f?.data?.uidFrom || ''),
    }).select('id').single();
    conv = ins.data;
  }
  if (!conv) return 0;
  const rows = msgs.map((m) => {
    const cm = classifyMessage(m);
    return {
      user_id: ownerId, conversation_id: conv.id, account_id: accountId,
      direction: m.isSelf ? 'out' : 'in', msg_type: cm.msg_type, body: cm.body, media_url: cm.media_url, media_label: cm.media_label, media_meta: cm.media_meta || null,
      zalo_msg_id: m?.data?.msgId ? String(m.data.msgId) : null,
      cli_msg_id: m?.data?.cliMsgId ? String(m.data.cliMsgId) : null,
      status: m.isSelf ? 'sent' : 'delivered',
      created_at: m?.data?.ts ? new Date(Number(m.data.ts)).toISOString() : new Date().toISOString(),
    };
  }).filter((r) => r.zalo_msg_id);
  if (rows.length) await sb.from('zalo_messages').upsert(rows, { onConflict: 'account_id,zalo_msg_id', ignoreDuplicates: false });
  // cập nhật preview từ tin mới nhất (chỉ khi mới hơn)
  const last = msgs[msgs.length - 1];
  const lastTs = last?.data?.ts ? new Date(Number(last.data.ts)).toISOString() : null;
  if (lastTs) {
    const cmLast = classifyMessage(last);
    await sb.from('zalo_conversations').update({ last_message_text: cmLast.body || '[Tin nhắn]', last_message_at: lastTs, last_message_dir: last.isSelf ? 'out' : 'in' }).eq('id', conv.id).lt('last_message_at', lastTs);
  }
  return rows.length;
}

// ── Đồng bộ TIN GẦN ĐÂY (event old_messages) — gom theo thread rồi upsert ──
async function handleOldMessages(accountId, ownerId, messages, type) {
  try {
    if (!Array.isArray(messages) || !messages.length) return;
    const tt = type === ThreadType.Group ? 'group' : 'user';
    const byThread = new Map();
    for (const m of messages) {
      const tid = threadIdOf(m);
      if (!tid) continue;
      if (!byThread.has(tid)) byThread.set(tid, []);
      byThread.get(tid).push(m);
    }
    let total = 0;
    for (const [tid, msgs] of byThread) total += await upsertMessagesForThread(accountId, ownerId, tid, tt, msgs);
    log('old_messages', tt, '→', total, 'tin /', byThread.size, 'hội thoại');
  } catch (e) { log('handleOldMessages', e?.message || e); }
}

// ── Đồng bộ bạn bè + nhóm → zalo_conversations (upsert theo account_id+thread_id) ──
function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }

async function upsertConvRows(rows) {
  for (const c of chunk(rows, 200)) {
    const { error } = await sb.from('zalo_conversations').upsert(c, { onConflict: 'account_id,thread_id', ignoreDuplicates: false });
    if (error) log('upsert conv error', error.message);
  }
}

async function syncContacts(api, accountId, ownerId) {
  // Bạn bè
  let friends = [];
  try { friends = await api.getAllFriends(20000, 0); } catch (e) { log('getAllFriends', e?.message || e); }
  const friendRows = (friends || []).filter((u) => u && u.userId).map((u) => ({
    user_id: ownerId, account_id: accountId, thread_id: String(u.userId), thread_type: 'user',
    peer_name: u.displayName || u.zaloName || 'Bạn Zalo', peer_avatar_url: u.avatar || null,
    peer_phone: u.phoneNumber || null, peer_zalo_uid: String(u.userId),
  }));
  if (friendRows.length) await upsertConvRows(friendRows);

  // Nhóm: getAllGroups trả map id→version; chi tiết qua getGroupInfo
  let gids = [];
  try { const g = await api.getAllGroups(); gids = Object.keys(g?.gridVerMap || {}); } catch (e) { log('getAllGroups', e?.message || e); }
  let groupCount = 0;
  for (const ids of chunk(gids, 50)) {
    try {
      const info = await api.getGroupInfo(ids);
      const map = info?.gridInfoMap || {};
      const rows = Object.values(map).filter((g) => g && g.groupId).map((g) => ({
        user_id: ownerId, account_id: accountId, thread_id: String(g.groupId), thread_type: 'group',
        peer_name: g.name || 'Nhóm Zalo', peer_avatar_url: g.fullAvt || g.avt || null,
        profile: { kind: 'unknown', isGroup: true, members: g.totalMember || (Array.isArray(g.memberIds) ? g.memberIds.length : null), desc: g.desc || null },
      }));
      if (rows.length) { await upsertConvRows(rows); groupCount += rows.length; }
    } catch (e) { log('getGroupInfo', e?.message || e); }
  }
  log('synced', friendRows.length, 'bạn,', groupCount, 'nhóm →', accountId);
}

// ── Inbound: reaction / undo / seen (best-effort, defensive) ──
function evMsgIds(e) {
  const d = e?.data || e;
  const ids = [];
  const push = (x) => { if (x) ids.push(String(x)); };
  push(d?.msgId); push(d?.globalMsgId); push(d?.content?.rMsg?.[0]?.gMsgID);
  if (Array.isArray(d?.msgIds)) d.msgIds.forEach(push);
  return ids;
}
function evThreadId(e) { const d = e?.data || e; return String(e?.threadId ?? d?.threadId ?? d?.idTo ?? d?.uidFrom ?? ''); }

async function handleReaction(accountId, e) {
  try {
    const d = e?.data || e;
    const icon = d?.content?.rIcon || d?.rIcon || d?.icon;
    const ids = evMsgIds(e);
    if (!icon || !ids.length) return;
    await sb.from('zalo_messages').update({ reaction_emoji: zcaToEmoji(icon) }).eq('account_id', accountId).in('zalo_msg_id', ids);
    log('reaction', accountId, zcaToEmoji(icon));
  } catch (err) { log('handleReaction', err?.message || err); }
}
async function handleUndo(accountId, e) {
  try {
    const ids = evMsgIds(e);
    if (!ids.length) return;
    await sb.from('zalo_messages').update({ body: '(Tin đã được thu hồi)', msg_type: 'sys' }).eq('account_id', accountId).in('zalo_msg_id', ids);
    log('undo', accountId, ids.join(','));
  } catch (err) { log('handleUndo', err?.message || err); }
}
async function handleSeen(accountId, e) {
  try {
    const tid = evThreadId(e);
    if (!tid) return;
    const { data: conv } = await sb.from('zalo_conversations').select('id').eq('account_id', accountId).eq('thread_id', tid).maybeSingle();
    if (!conv) return;
    await sb.from('zalo_messages').update({ status: 'seen' })
      .eq('conversation_id', conv.id).eq('direction', 'out').in('status', ['sent', 'delivered']);
    log('seen', accountId, tid);
  } catch (err) { log('handleSeen', err?.message || err); }
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

  const ua = account.meta?.userAgent || uaFor(id);
  log('loginQR UA', id, ua.slice(0, 40) + '…');
  // selfListen: true → listener phát cả tin MÌNH gửi từ thiết bị khác (điện thoại…)
  const zalo = new Zalo({ selfListen: true });
  try {
    const api = await zalo.loginQR({ userAgent: ua }, async (ev) => {
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

    // Đăng nhập thành công — lưu Credentials {imei,userAgent,cookie} để re-login
    let name = account.name, uid = '', avatar = null;
    try {
      const ctx = api.getContext?.();
      if (ctx) {
        const cookie = ctx.cookie && typeof ctx.cookie.toJSON === 'function' ? ctx.cookie.toJSON() : ctx.cookie;
        saveSession(id, { imei: ctx.imei, userAgent: ctx.userAgent, cookie });
      }
    } catch (e) { log('save ctx error', e.message); }
    try { const info = await api.fetchAccountInfo?.(); const p = info?.profile || info; name = p?.displayName || p?.zaloName || name; avatar = p?.avatar || null; } catch { /* */ }
    try { uid = await api.getOwnId?.(); } catch { /* */ }
    await setAccount(id, { status: 'connected', qr_data: null, qr_expires_at: null, last_error: null, name, zalo_uid: String(uid || ''), avatar_url: avatar, meta: { ...(account.meta || {}), userAgent: ua } });
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
    const zalo = new Zalo({ selfListen: true });
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
  // Nhận job NGUYÊN TỬ: chỉ xử lý nếu chuyển được queued→processing. Nếu 0 dòng
  // đổi (tick khác đã nhận) → bỏ qua → CHỐNG GỬI TRÙNG khi tick chồng nhau.
  const { data: claimed, error: claimErr } = await sb.from('zalo_send_queue')
    .update({ status: 'processing' }).eq('id', job.id).eq('status', 'queued').select('id');
  if (claimErr || !claimed || !claimed.length) return;
  const s = sessions.get(job.account_id);
  if (!s) {
    await sb.from('zalo_send_queue').update({ status: 'failed', last_error: 'Tài khoản chưa kết nối', attempts: (job.attempts || 0) + 1 }).eq('id', job.id);
    if (job.message_id) await sb.from('zalo_messages').update({ status: 'failed' }).eq('id', job.message_id);
    return;
  }
  try {
    const p = job.payload || {};
    const type = p.thread_type === 'group' ? ThreadType.Group : ThreadType.User;
    if (p.action === 'react') {
      await s.api.addReaction(emojiToZca(p.emoji), { data: { msgId: String(p.target_msg_id || ''), cliMsgId: String(p.target_cli_msg_id || '') }, threadId: String(p.thread_id), type });
      log('reacted', job.id, p.emoji);
    } else if (p.action === 'recall') {
      await s.api.undo({ msgId: String(p.target_msg_id || ''), cliMsgId: String(p.target_cli_msg_id || '') }, String(p.thread_id), type);
      log('recalled', job.id);
    } else if (p.action === 'load_history') {
      const h = await s.api.getGroupChatHistory(String(p.thread_id), Number(p.count) || 50);
      const n = await upsertMessagesForThread(job.account_id, job.user_id, String(p.thread_id), 'group', h?.groupMsgs || []);
      log('history', job.id, '→', n, 'tin');
    } else {
      const { data: conv } = await sb.from('zalo_conversations').select('thread_id, thread_type').eq('id', job.conversation_id).single();
      const t2 = conv?.thread_type === 'group' ? ThreadType.Group : ThreadType.User;
      const res = await s.api.sendMessage({ msg: p.body || '', ...(p.reply_to ? { quote: p.reply_to } : {}) }, conv.thread_id, t2);
      const zid = res?.message?.msgId || res?.msgId || '';
      const cid = res?.message?.cliMsgId || res?.cliMsgId || '';
      if (job.message_id) {
        if (zid) {
          // selfListen có thể đã chèn echo của chính tin này → tránh trùng:
          const { data: dup } = await sb.from('zalo_messages').select('id').eq('account_id', job.account_id).eq('zalo_msg_id', String(zid)).maybeSingle();
          if (dup && dup.id !== job.message_id) {
            await sb.from('zalo_messages').delete().eq('id', job.message_id);   // bỏ row 'pending' của web, giữ echo
          } else {
            await sb.from('zalo_messages').update({ status: 'sent', zalo_msg_id: String(zid), cli_msg_id: cid ? String(cid) : null }).eq('id', job.message_id);
          }
        } else {
          await sb.from('zalo_messages').update({ status: 'sent' }).eq('id', job.message_id);
        }
      }
      log('sent', job.id);
    }
    await sb.from('zalo_send_queue').update({ status: 'sent', processed_at: new Date().toISOString() }).eq('id', job.id);
  } catch (e) {
    log('send error', job.id, e?.message || e);
    await sb.from('zalo_send_queue').update({ status: 'failed', last_error: String(e?.message || e).slice(0, 300), attempts: (job.attempts || 0) + 1 }).eq('id', job.id);
    if (job.message_id) await sb.from('zalo_messages').update({ status: 'failed' }).eq('id', job.message_id);
  }
}

// ── Vòng lặp chính ──
let booted = false;
let ticking = false;
async function tick() {
  if (ticking) return;              // CHỐNG tick chồng nhau (send chậm → gửi trùng)
  ticking = true;
  try {
    // accounts cần đăng nhập / re-login
    const { data: accounts } = await sb.from('zalo_accounts').select('id, user_id, name, status, meta').eq('kind', 'personal');
    for (const a of accounts || []) {
      if (a.status === 'connecting' || a.status === 'waiting_scan') startLoginQR(a, a.user_id);
      else if (!booted && a.status === 'connected') tryRelogin(a, a.user_id);
    }
    booted = true;

    // hàng đợi gửi
    const { data: jobs } = await sb.from('zalo_send_queue')
      .select('*').eq('channel', 'personal').eq('status', 'queued').order('created_at', { ascending: true }).limit(10);
    for (const j of jobs || []) await processJob(j);
  } finally { ticking = false; }
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
