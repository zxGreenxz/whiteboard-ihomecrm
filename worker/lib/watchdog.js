// =============================================================
// watchdog.js — giữ phiên sống (bài học WEB2 §5.5):
//   • Mỗi 90s probe từng phiên bằng api.keepAlive() (timeout 8s). Fail 2 lần
//     liên tiếp → coi như WS chết âm thầm → teardown + vào máy backoff.
//   • PROACTIVE RE-LOGIN: zpw_sek sống ~7 ngày và KHÔNG có refresh token —
//     phải chủ động login lại TRƯỚC hạn (3.5 ngày sau lần lưu phiên gần nhất)
//     để lấy cookie mới; đợi hết hạn rồi mới login là phải quét QR lại.
//     Swap có kế hoạch: login phiên MỚI xong mới đóng phiên cũ; fail thì giữ
//     phiên cũ chạy tiếp, thử lại sau 6h.
// =============================================================
import { Zalo } from 'zca-js';
import { log, sessions, loggingIn } from './ctx.js';
import { loadSession } from './session-store.js';
import { noteDisconnect, tryRelogin } from './login.js';

export const WATCHDOG_MS = 90_000;
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_FAIL_CAP = 2;
const PROACTIVE_RELOGIN_MS = 3.5 * 24 * 60 * 60 * 1000;
const PROACTIVE_RETRY_MS = 6 * 60 * 60 * 1000;

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), ms));

async function probe(accountId, s) {
  try {
    await Promise.race([s.api.keepAlive(), timeout(PROBE_TIMEOUT_MS)]);
    s.probeFails = 0;
  } catch (e) {
    s.probeFails = (s.probeFails || 0) + 1;
    log('watchdog probe fail', accountId, s.probeFails + '/' + PROBE_FAIL_CAP, e?.message || e);
    if (s.probeFails >= PROBE_FAIL_CAP) {
      log('watchdog: phiên chết âm thầm →', accountId);
      noteDisconnect(accountId, 1006);
    }
  }
}

// Login phiên MỚI trước, thành công mới đóng phiên cũ (không có cửa sổ rớt tin dài).
async function proactiveRelogin(accountId, s, accountRow) {
  if (loggingIn.has(accountId)) return;
  const payload = loadSession(accountId);
  if (!payload || payload.corrupt) return;
  loggingIn.add(accountId);
  log('proactive re-login (phiên sắp hết hạn) →', accountId);
  try {
    const zalo = new Zalo({ selfListen: true });
    const api = await zalo.login(payload.creds);
    // Phiên mới OK (chứng minh creds còn dùng được) → đóng cả hai: phiên cũ
    // lẫn phiên thăm dò, rồi login lại qua đường chuẩn tryRelogin (có guard
    // WRONG_ACCOUNT + lưu phiên mới). Hai phiên song song lâu sẽ tự đá nhau.
    try { api.listener?.stop?.(); } catch { /* phiên thăm dò chưa start listener */ }
    try { s.api.listener.stop(); } catch { /* */ }
    sessions.delete(accountId);
    loggingIn.delete(accountId);
    await tryRelogin(accountRow);
  } catch (e) {
    log('proactive re-login fail (giữ phiên cũ) →', accountId, e?.message || e);
    s.nextProactiveAt = Date.now() + PROACTIVE_RETRY_MS;
  } finally {
    loggingIn.delete(accountId);
  }
}

// accountRows: dòng zalo_accounts mới nhất (tick truyền vào — khỏi query lại).
export async function watchdogTick(accountRows) {
  const rowById = new Map((accountRows || []).map((a) => [a.id, a]));
  for (const [accountId, s] of sessions) {
    // proactive trước — phiên sắp hết hạn thì probe cũng vô ích
    const due = (s.sessionSavedAt || 0) + PROACTIVE_RELOGIN_MS;
    if (Date.now() >= due && Date.now() >= (s.nextProactiveAt || 0)) {
      await proactiveRelogin(accountId, s, rowById.get(accountId) || { id: accountId });
      continue;
    }
    await probe(accountId, s);
  }
}
