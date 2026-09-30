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
export function requireAccountWriteReceipt<T>(data: T, expected: Readonly<Record<string, unknown>>): NonNullable<T> {
  const row = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
  if (!row || typeof row.id !== 'string' || !row.id.trim() || Object.entries(expected).some(([key, value]) => value !== undefined && JSON.stringify(normalize(row[key])) !== JSON.stringify(normalize(value)))) throw new AccountWriteReceiptError(expected);
  return data as NonNullable<T>;
}
