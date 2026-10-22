// R2e (21/10/2026): đổi mốc giờ UTC trong kết quả công cụ sang giờ Việt Nam (+07:00) trước khi tới mô hình.
// Sự cố full50e câu 66 và lượt kiểm s45: hạn việc `2026-10-08T16:59:59.999+00:00` (23:59 ngày 08/10 giờ VN) bị mô hình
// đọc thành 09/10 — một trên ba lần, dù SOUL đã có luật và ví dụ. Máy chủ đổi sẵn thì mô hình chỉ việc đọc ngày.
// Chỉ đổi chuỗi đúng dạng ngày-giờ ISO có đuôi UTC (Z, +00:00, +0000, +00). Ngày thuần (YYYY-MM-DD), chuỗi có múi giờ
// khác và mọi chuỗi khác giữ nguyên. Khoá con trỏ phân trang giữ nguyên để lượt sau gửi lại đúng như máy chủ trả.
// Việt Nam không có giờ mùa hè nên +07:00 là cố định.
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(?:Z|\+00(?::?00)?)$/;
const SKIP_KEYS = new Set(['nextCursor', 'cursor', 'prevCursor', 'previousCursor']);
const MAX_DEPTH = 64;
const pad = (value, width = 2) => String(value).padStart(width, '0');

/** Một chuỗi ISO UTC ⇒ cùng thời điểm theo giờ Việt Nam, đuôi +07:00; chuỗi khác trả nguyên. */
export function toVietnamTime(value) {
  if (typeof value !== 'string' || value.length > 40) return value;
  const match = ISO_UTC.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute, second = '00', fraction = ''] = match;
  const instant = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (!Number.isFinite(instant)) return value;
  const local = new Date(instant + 7 * 3_600_000);
  // Date.UTC tự cuộn ngày/giờ ngoài khoảng (vd. giờ 25) — chuỗi như vậy không phải mốc hợp lệ, giữ nguyên.
  const check = new Date(instant);
  if (check.getUTCFullYear() !== Number(year) || check.getUTCMonth() + 1 !== Number(month) || check.getUTCDate() !== Number(day) ||
      check.getUTCHours() !== Number(hour) || check.getUTCMinutes() !== Number(minute) || check.getUTCSeconds() !== Number(second)) {
    return value;
  }
  return `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${fraction}+07:00`;
}

/** Duyệt sâu một giá trị JSON, đổi mọi mốc giờ UTC; không đụng khoá con trỏ; quá sâu thì trả nguyên nhánh đó. */
export function vietnamTimes(value, depth = 0) {
  if (typeof value === 'string') return toVietnamTime(value);
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map(item => vietnamTimes(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = SKIP_KEYS.has(key) ? item : vietnamTimes(item, depth + 1);
  return out;
}

/** Kết quả `tools/call` dạng MCP: đổi trong từng khối text là JSON; khối không phải JSON giữ nguyên. */
export function vietnamToolResult(result) {
  if (result === null || typeof result !== 'object' || !Array.isArray(result.content)) return result;
  let changed = false;
  const content = result.content.map(block => {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
    let parsed;
    try { parsed = JSON.parse(block.text); } catch { return block; }
    const text = JSON.stringify(vietnamTimes(parsed));
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? { ...result, content } : result;
}
