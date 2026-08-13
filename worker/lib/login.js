// =============================================================
// login.js — đăng nhập QR, re-login từ phiên mã hoá, backoff, xử lý kick.
//
// Máy trạng thái re-login (bài học WEB2 §5.5 + §13.3):
//   • Rớt mạng/1006 → backoff [5s,15s,30s,60s,120s], tối đa 10 lần → gaveUp
//     (chờ người bấm "Đăng nhập lại").
//   • Bị KICK (close 3000/3003 = nick đang mở Zalo Web nơi khác): đếm
//     consecutiveKicks; <4 → thử lại sau 30s; ≥4 → nghỉ 10 phút (đấu phiên
//     vô hạn chỉ làm cả hai bên cùng chết).
//   • WRONG_ACCOUNT: uid sau login KHÁC uid đã gắn với slot → KHÔNG attach,
//     KHÔNG ghi đè file phiên (chặn gắn nhầm nick của người khác vào slot).
// =============================================================
import { Zalo } from 'zca-js';
import QRCode from 'qrcode';
import { sb, log, sessions, loggingIn, reloginState, setAccount, uaFor } from './ctx.js';
import { saveSession, loadSession } from './session-store.js';
import { attachSession } from './inbound.js';

const BACKOFF_MS = [5000, 15000, 30000, 60000, 120000];
const MAX_RECONNECT_ATTEMPTS = 10;
const KICK_CODES = new Set([3000, 3003]);
const KICK_RECONNECT_MS = 30_000;
const KICK_CAP = 4;
const KICK_COOLDOWN_MS = 10 * 60_000;
const RECONNECT_COOLDOWN_MS = 3000; // chờ WS cũ đóng hẳn — tránh tự-kick

function stateOf(id) {
  if (!reloginState.has(id)) reloginState.set(id, { attempts: 0, nextAt: 0, kicks: 0, gaveUp: false });
  return reloginState.get(id);
}
export function resetReloginState(id) {
  reloginState.set(id, { attempts: 0, nextAt: 0, kicks: 0, gaveUp: false });
}

// Gọi khi listener báo closed/error. Quyết định lịch thử lại.
export function noteDisconnect(accountId, code) {
  const s = sessions.get(accountId);
  if (s) {
    try { s.api.listener.stop(); } catch { /* */ }
    sessions.delete(accountId);
  }
  const st = stateOf(accountId);
  if (KICK_CODES.has(Number(code))) {
    st.kicks += 1;
    if (st.kicks >= KICK_CAP) {
      st.nextAt = Date.now() + KICK_COOLDOWN_MS;
      setAccount(accountId, { status: 'error', last_error: 'Bị đá phiên liên tục (nick đang mở Zalo Web nơi khác?) — tạm nghỉ 10 phút rồi tự thử lại.' });
      log('kick cap', accountId, '→ nghỉ 10 phút');
    } else {
      st.nextAt = Date.now() + KICK_RECONNECT_MS;
      setAccount(accountId, { status: 'error', last_error: `Bị đá phiên (lần ${st.kicks}) — tự kết nối lại sau 30s.` });
      log('kicked', accountId, 'lần', st.kicks);
    }
    return;
  }
  st.attempts += 1;
  if (st.attempts > MAX_RECONNECT_ATTEMPTS) {
    st.gaveUp = true;
    setAccount(accountId, { status: 'error', last_error: 'Mất kết nối quá 10 lần liên tiếp — bấm "Đăng nhập lại" để nối lại.' });
    log('gave up relogin', accountId);
    return;
  }
  const delay = BACKOFF_MS[Math.min(st.attempts - 1, BACKOFF_MS.length - 1)];
  st.nextAt = Date.now() + delay;
  log('mất kết nối', accountId, 'code', code, '→ thử lại sau', delay / 1000, 's (lần', st.attempts + ')');
}

// Tick hỏi: account này giờ có nên thử re-login không?
export function shouldRelogin(accountId) {
  if (sessions.has(accountId) || loggingIn.has(accountId)) return false;
  const st = stateOf(accountId);
  if (st.gaveUp) return false;
  return Date.now() >= st.nextAt;
}

// Sau khi login OK: lưu phiên MỚI (cookie xoay theo mỗi login) + reset counters.
async function afterLogin(account, api, { viaQR = false } = {}) {
  const id = account.id;
  let uid = '';
  try { uid = String((await api.getOwnId?.()) || ''); } catch { /* */ }

  // Guard WRONG_ACCOUNT — chỉ áp khi slot ĐÃ gắn một uid trước đó.
  const expected = String(account.zalo_uid || '').trim();
  if (!viaQR && expected && uid && uid !== expected) {
    await setAccount(id, { status: 'error', last_error: `WRONG_ACCOUNT: phiên trả về uid ${uid}, slot này thuộc uid ${expected}. Không gắn.` });
    stateOf(id).gaveUp = true;
    log('WRONG_ACCOUNT', id, uid, '≠', expected);
    return null;
  }

  let name = account.name, avatar = null;
  try {
    const info = await api.fetchAccountInfo?.();
    const p = info?.profile || info;
    name = p?.displayName || p?.zaloName || name;
    avatar = p?.avatar || null;
  } catch { /* */ }

  const savedAt = Date.now();
  try {
    const ctx = api.getContext?.();
    if (ctx) {
      const cookie = ctx.cookie && typeof ctx.cookie.toJSON === 'function' ? ctx.cookie.toJSON() : ctx.cookie;
      saveSession(id, {
        creds: { imei: ctx.imei, userAgent: ctx.userAgent, cookie },
        savedAt,
        expectedUid: uid || expected || null,
      });
    }
  } catch (e) { log('save ctx error', e.message); }

  await setAccount(id, {
    status: 'connected', qr_data: null, qr_expires_at: null, last_error: null,
    name, zalo_uid: uid || expected || '', ...(avatar ? { avatar_url: avatar } : {}),
  });
  await attachSession(id, account.user_id, api, {
    onClosed: (code) => noteDisconnect(id, code),
    sessionSavedAt: savedAt,
  });
  resetReloginState(id);
  return api;
}

// ── Đăng nhập QR cho account đang 'connecting' ──
export async function startLoginQR(account) {
  const id = account.id;
  if (loggingIn.has(id) || sessions.has(id)) return;
  loggingIn.add(id);
  log('loginQR start', id);

  const ua = account.meta?.userAgent || uaFor(id);
  // selfListen: true → listener phát cả tin MÌNH gửi từ thiết bị khác.
  const zalo = new Zalo({ selfListen: true });
  try {
    const api = await zalo.loginQR({ userAgent: ua }, async (ev) => {
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
    await setAccount(id, { meta: { ...(account.meta || {}), userAgent: ua } });
    await afterLogin(account, api, { viaQR: true });
    log('connected (QR)', id);
  } catch (e) {
    log('loginQR error', id, e?.message || e);
    await setAccount(id, { status: 'error', qr_data: null, last_error: String(e?.message || e).slice(0, 300) });
  } finally {
    loggingIn.delete(id);
  }
}

// ── Re-login từ phiên đã lưu (boot / rớt mạng / proactive) ──
export async function tryRelogin(account) {
  const id = account.id;
  if (sessions.has(id) || loggingIn.has(id)) return;
  const payload = loadSession(id);
  if (!payload) return; // chưa từng login trên máy này
  if (payload.corrupt) {
    // FAIL-CLOSED: không giải mã được (đổi key / hỏng file) — không đoán.
    stateOf(id).gaveUp = true;
    await setAccount(id, { status: 'error', last_error: 'Không giải mã được phiên đã lưu — kiểm tra ZALO_SESSION_KEY hoặc bấm "Đăng nhập lại".' });
    return;
  }
  loggingIn.add(id);
  try {
    await new Promise((r) => setTimeout(r, RECONNECT_COOLDOWN_MS));
    const zalo = new Zalo({ selfListen: true });
    const api = await zalo.login(payload.creds);
    // expectedUid trong file phiên ưu tiên hơn cột DB (file đi cùng cookie).
    const acc = { ...account, zalo_uid: payload.expectedUid || account.zalo_uid };
    const ok = await afterLogin(acc, api);
    if (ok) log('re-login ok', id);
  } catch (e) {
    log('re-login fail', id, e?.message || e);
    noteDisconnect(id, 1006);
    // Cookie hết hạn thật sự thì mọi lần thử đều fail → sau MAX attempts sẽ
    // gaveUp với hướng dẫn quét QR lại.
    await setAccount(id, { status: 'error', last_error: 'Phiên Zalo lỗi/hết hạn — đang tự thử lại; nếu không được hãy bấm "Đăng nhập lại" để quét QR.' });
  } finally { loggingIn.delete(id); }
}
