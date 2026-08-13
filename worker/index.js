// =============================================================
// Worker zca-js cho Chat Zalo (CRM iHomeCRM) — bootstrap.
//
// Vai trò: giữ phiên Zalo CÁ NHÂN (QR login), đọc hàng đợi gửi
// (zalo_send_queue) rồi gửi bằng zca-js, nghe tin đến rồi ghi vào
// zalo_messages. Web chỉ nói chuyện với Supabase; Realtime đẩy sang trình
// duyệt. Logic nằm trong lib/: ctx (state chung) · session-store (mã hoá
// phiên AES-256-GCM) · lease (đơn-instance) · login (QR/re-login/backoff/
// kick) · watchdog (keepalive + proactive re-login) · inbound (tin đến) ·
// media (gửi ảnh/file/voice/sticker) · queue (job dispatch).
//
// Chạy LOCAL trước để quét QR/test, rồi VPS (pm2, kill_timeout ≥15s).
// KHÔNG deploy lên Vercel. Xem ../docs/zalo/ZALO-WORKER-SETUP.md
//
// MULTI-ORG: mỗi công ty (organization) có account Zalo riêng; worker stamp
// organization_id vào MỌI dòng nó ghi (service-role bypass RLS nên kỷ luật
// nằm ở code + trigger autofill fail-closed phía DB). Muốn tách hẳn worker
// theo công ty → đặt WORKER_ORG_IDS="uuid1,uuid2" trong .env.
//
// ⚠️ zca-js là API Zalo cá nhân KHÔNG chính thức (rủi ro khoá nick) — dùng
// tài khoản phụ, KHÔNG mở Zalo Web nơi khác cùng nick.
// =============================================================
import {
  sb, log, sleep, POLL_MS, ORG_FILTER,
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  sessions, orgCache,
} from './lib/ctx.js';
import { sessionKeyReady } from './lib/session-store.js';
import { claimLease, heartbeatLease, releaseLease, INSTANCE_ID } from './lib/lease.js';
import { startLoginQR, tryRelogin, shouldRelogin } from './lib/login.js';
import { watchdogTick, WATCHDOG_MS } from './lib/watchdog.js';
import { processJob } from './lib/queue.js';

// ── Fail-closed từ boot: thiếu credential/khoá là DỪNG, không chạy nửa vời ──
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY trong worker/.env');
  console.error('→ Điền SUPABASE_SERVICE_ROLE_KEY (Supabase ▸ Settings ▸ API ▸ service_role).');
  process.exit(1);
}
if (!sessionKeyReady()) {
  console.error('Thiếu hoặc sai ZALO_SESSION_KEY trong worker/.env (phải là 64 ký tự hex).');
  console.error('Phiên Zalo được mã hoá at-rest AES-256-GCM — worker TỪ CHỐI chạy không có khoá.');
  console.error('Sinh khoá: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

let booted = false;
let ticking = false;
let shuttingDown = false;

async function tick() {
  if (ticking || shuttingDown) return;   // CHỐNG tick chồng nhau
  ticking = true;
  try {
    // Lease đơn-instance: mất lease = instance mới đã lên → tự thoát êm.
    if (!(await heartbeatLease())) {
      log('lease đã đổi chủ — instance này tự thoát.');
      await shutdown(false);
      return;
    }

    // accounts: nạp org cache + luồng đăng nhập / re-login
    let accQ = sb.from('zalo_accounts')
      .select('id, user_id, organization_id, name, status, meta, zalo_uid')
      .eq('kind', 'personal');
    if (ORG_FILTER.length) accQ = accQ.in('organization_id', ORG_FILTER);
    const { data: accounts } = await accQ;
    for (const a of accounts || []) orgCache.set(a.id, a.organization_id);
    for (const a of accounts || []) {
      if (a.status === 'connecting' || a.status === 'waiting_scan') {
        startLoginQR(a);
      } else if ((a.status === 'connected' || a.status === 'error')
                 && !sessions.has(a.id) && shouldRelogin(a.id)) {
        // 'connected' mà không có phiên RAM = vừa boot / rớt âm thầm;
        // 'error' = máy trạng thái backoff/kick trong login.js quyết nhịp thử lại.
        // 'disconnected' là Ý NGƯỜI DÙNG — tuyệt đối không tự nối lại.
        tryRelogin(a);
      }
    }
    booted = true;

    // hàng đợi gửi — RẢI NHỊP giữa các job (chống Zalo coi broadcast là spam)
    let jobQ = sb.from('zalo_send_queue')
      .select('*').eq('channel', 'personal').eq('status', 'queued')
      .or(`not_before.is.null,not_before.lte."${new Date().toISOString()}"`)
      .order('created_at', { ascending: true }).limit(10);
    if (ORG_FILTER.length) jobQ = jobQ.in('organization_id', ORG_FILTER);
    const { data: jobs } = await jobQ;
    for (let i = 0; i < (jobs || []).length; i++) {
      if (shuttingDown) break;
      await processJob(jobs[i]);
      if (i < jobs.length - 1) await sleep(700 + Math.floor(Math.random() * 800));
    }
  } finally { ticking = false; }
}

let tickTimer = null;
let watchdogTimer = null;

async function main() {
  log('Zalo worker khởi động →', SUPABASE_URL, '· instance', INSTANCE_ID.slice(0, 8));
  if (ORG_FILTER.length) log('chỉ phục vụ org:', ORG_FILTER.join(', '));

  // Giành lease trước khi làm bất cứ gì — instance cũ có 30s để nhả.
  for (let i = 0; ; i++) {
    if (await claimLease()) break;
    if (i === 0) log('lease đang thuộc instance khác — chờ nhả (tối đa ~35s)…');
    await sleep(5000);
    if (i > 12) { console.error('Không giành được lease sau 60s — kiểm tra instance khác còn sống?'); process.exit(1); }
  }
  log('đã giữ lease đơn-instance.');

  await tick();
  tickTimer = setInterval(() => { tick().catch((e) => log('tick error', e.message)); }, POLL_MS);
  watchdogTimer = setInterval(() => {
    sb.from('zalo_accounts').select('id, user_id, organization_id, name, status, meta, zalo_uid').eq('kind', 'personal')
      .then(({ data }) => watchdogTick(data || []))
      .then(() => {}, (e) => log('watchdog error', e?.message || e));
  }, WATCHDOG_MS);
}

// Graceful shutdown (bài học WEB2 §13.22): đóng listener + nhả lease TRƯỚC khi
// thoát, để instance mới không phải "đấu" phiên với xác chết (kick 3000/3003).
async function shutdown(fromSignal = true) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down…');
  clearInterval(tickTimer);
  clearInterval(watchdogTimer);
  // đợi job đang processing xong (tối đa 10s)
  for (let i = 0; i < 20 && ticking; i++) await sleep(500);
  for (const [id, s] of sessions) {
    try { s.api.listener.stop(); } catch { /* */ }
    log('stopped', id);
  }
  await releaseLease();
  if (fromSignal) process.exit(0);
}
process.on('SIGTERM', () => shutdown(true));
process.on('SIGINT', () => shutdown(true));

main().catch((e) => { console.error('boot error', e); process.exit(1); });
