import { createHash } from 'node:crypto';

// Nhớ quyền CRM của từng kết nối Hermes trong tiến trình connector (28/10/2026, chủ: "nhớ quyền 30 phút").
// Đo production 28/10: mỗi lần dựng authority đầy đủ = /auth/v1/user + 15 RPC PostgREST (get_authorization_context_v1,
// get_my_organizations, hermes_scope_buildings_v1 và 12 hàm capability), ~7,5 s thời gian DB; ~100 lần/giờ kể cả đêm —
// keepalive `ping` 180 s của MCP client Hermes (mỗi ping dựng 2 lần) và vòng gia hạn kết nối ~10 phút (9–11 lần mỗi lượt).
//
// Chỉ nhớ KẾT QUẢ auth.readAuthorization (phần đọc quyền CRM). Phiên Auth (/auth/v1/user) và ảnh chụp kết nối trong kho
// vẫn đọc thật mỗi lượt. Chỉ người gọi tin cậy đặt AUTHORITY_CONTEXT_CACHE trên lời gọi authority mới được dùng lại:
// authenticate/ping/initialize, tools/list và vòng gia hạn của host. tools/call (mọi lệnh đọc/ghi) không đặt cờ nên luôn đọc
// quyền thật; lượt đọc thật đó cũng làm mới mục nhớ.
//
// Khoá mục nhớ = vân tay ảnh chụp kho của kết nối (bỏ hạn token): id/epoch/trạng thái/giới hạn/phạm vi kết nối,
// credentialRef + revision + hạn + binding (user/công ty/assistant/session) của phiên, membershipId + authorizationVersion
// (tổ chức tự tăng khi đổi vai trò/override/phạm vi/thành viên) + isSuperadmin, phiên bản + quyền + phạm vi chính sách
// trợ lý. Lệch bất kỳ phần nào ⇒ không dùng, đọc lại. Hết hạn sau ttlMs (mặc định 30 phút) hoặc khi phiên Auth hết hạn.
export const AUTHORITY_CONTEXT_CACHE = Symbol('hermes.authority-context-cache');
export const DEFAULT_AUTHORITY_CACHE_TTL_MS = 30 * 60_000;
export const MIN_AUTHORITY_CACHE_TTL_MS = 60_000;
export const MAX_AUTHORITY_CACHE_TTL_MS = 60 * 60_000;
// Lỗi BrokerError mà authority/broker thấy ⇒ bỏ ngay mục nhớ của token đó (lượt sau đọc lại quyền thật).
export const AUTHORITY_CACHE_FORGET_CODES = Object.freeze(['unauthorized', 'forbidden', 'context_changed']);
// action_rejected mang lý do quyền/khoá từ SQL (42501 của RPC trang, khoá tắt trong registry) cũng bỏ mục nhớ.
export const AUTHORITY_CACHE_FORGET_REASONS = Object.freeze(['forbidden', 'not_allowed', 'action_disabled']);

const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

/** 0 = tắt; còn lại phải trong [1 phút, 60 phút]. Dùng chung cho cấu hình host và backend. */
export function validAuthorityCacheTtl(value) {
  return value === 0 || (Number.isSafeInteger(value) && value >= MIN_AUTHORITY_CACHE_TTL_MS && value <= MAX_AUTHORITY_CACHE_TTL_MS);
}

/** Mã lỗi (và lý do action_rejected) nào làm bỏ mục nhớ. */
export function forgetsAuthorityContext(error) {
  const code = error?.code;
  return AUTHORITY_CACHE_FORGET_CODES.includes(code) ||
    (code === 'action_rejected' && AUTHORITY_CACHE_FORGET_REASONS.includes(error?.reason));
}

/** Vân tay các phần của ảnh chụp kho mà kết quả đọc quyền CRM phụ thuộc; không chứa token hay bản mã phiên. */
export function authorityContextKey(snapshot) {
  const { connection, session, membership, policy } = snapshot;
  return sha(JSON.stringify({ connection: { ...connection, expiresAt: null },
    session: { credentialRef: session.credentialRef, revision: session.revision, expiresAt: session.expiresAt, binding: session.binding },
    membership, policy }));
}

/** Process-local, per-connection memory for the trusted authority only. It is never authority by itself:
 * the durable authority still reads the joined store snapshot and verifies the Auth session on every
 * lookup, and only callers that set AUTHORITY_CONTEXT_CACHE (never tools/call) may reuse an entry. */
export function createAuthorityContextCache({ ttlMs = DEFAULT_AUTHORITY_CACHE_TTL_MS, clock = Date.now, maxEntries = 256 } = {}) {
  if (!validAuthorityCacheTtl(ttlMs) || typeof clock !== 'function' || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1024) {
    throw new TypeError('invalid_authority_context_cache');
  }
  const entries = new Map();
  // Bumped by every forget (a permission-type refusal: forbidden/context_changed/permission action_rejected):
  // a CRM read that started before it is never remembered afterwards, so a dropped entry cannot come back
  // from an in-flight read. discardDigest (token/session no longer valid in the store) does not bump: any
  // in-flight build of that token fails its own closing store read and remembers nothing.
  let forgets = 0;
  const now = () => { const value = clock(); return positive(value) ? value : undefined; };
  const drop = tokenDigest => { forgets++; entries.delete(tokenDigest); };
  return Object.freeze({
    ttlMs,
    /** Taken before a CRM read starts; remember() refuses the read if any forget happened since. */
    mark() { return forgets; },
    lookup(tokenDigest, key) {
      if (!ttlMs || typeof tokenDigest !== 'string' || !DIGEST.test(tokenDigest)) return undefined;
      const entry = entries.get(tokenDigest), time = now();
      if (!entry) return undefined;
      if (entry.key !== key || time === undefined || entry.until <= time) { entries.delete(tokenDigest); return undefined; }
      return entry.value;
    },
    remember(tokenDigest, key, value, notAfter, mark) {
      if (!ttlMs || typeof tokenDigest !== 'string' || !DIGEST.test(tokenDigest) || typeof key !== 'string' || !DIGEST.test(key)) return;
      if (mark !== forgets) return;
      const time = now(), until = time === undefined || !positive(notAfter) ? 0 : Math.min(time + ttlMs, notAfter);
      entries.delete(tokenDigest);
      if (!(until > time)) return;
      let frozen;
      try { frozen = deepFreeze(structuredClone(value)); } catch { return; }
      while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(tokenDigest, Object.freeze({ key, value: frozen, until }));
    },
    forget(presentedToken) { if (typeof presentedToken === 'string' && TOKEN.test(presentedToken)) drop(sha(presentedToken)); },
    forgetDigest(tokenDigest) { if (typeof tokenDigest === 'string') drop(tokenDigest); },
    discardDigest(tokenDigest) { if (typeof tokenDigest === 'string') entries.delete(tokenDigest); },
    size() { return entries.size; },
  });
}
