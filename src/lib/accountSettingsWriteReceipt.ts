/** Returned rows must identify the write and match submitted values before success feedback. */
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, normalize(v)]));
  return value;
};
export class AccountWriteReceiptError extends TypeError {
  constructor(readonly expected: Readonly<Record<string, unknown>>) {
    super('Chưa xác nhận được dữ liệu đã lưu đúng yêu cầu. Giữ nội dung đang sửa và đọc lại trạng thái trước khi thực hiện tiếp.');
    this.name = 'AccountWriteReceiptError';
  }
}
// Mốc thời gian có múi giờ: client gửi `toISOString()` ("…T03:00:00.000Z"), Postgres trả
// timestamptz dạng "…T03:00:00+00:00" — cùng một thời điểm, khác chuỗi. So theo thời điểm.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/;
const sameValue = (actual: unknown, expected: unknown): boolean => {
  if (typeof actual === 'string' && typeof expected === 'string' && ISO_INSTANT.test(actual) && ISO_INSTANT.test(expected)) {
    // Postgres có thể trả múi giờ rút gọn "+07"; Date.parse cần "+07:00".
    const toIso = (s: string) => s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})?$/, (_, h: string, m?: string) => `${h}:${m ?? '00'}`);
    const a = Date.parse(toIso(actual)), b = Date.parse(toIso(expected));
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
};
export function requireAccountWriteReceipt<T>(data: T, expected: Readonly<Record<string, unknown>>): NonNullable<T> {
  const row = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
  if (!row || typeof row.id !== 'string' || !row.id.trim() || Object.entries(expected).some(([key, value]) => value !== undefined && !sameValue(row[key], value))) throw new AccountWriteReceiptError(expected);
  return data as NonNullable<T>;
}
