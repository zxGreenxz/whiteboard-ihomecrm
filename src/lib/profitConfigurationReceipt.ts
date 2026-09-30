import { requireAccountWriteReceipt } from './accountSettingsWriteReceipt';
/** Arrays of affected rows are receipts; absence of a read model is never proof of rollback. */
export function requireProfitRows(data: unknown, expected?: readonly Readonly<Record<string, unknown>>[]): Record<string, unknown>[] {
  if (!Array.isArray(data) || data.some(row => !row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id.trim()) || new Set(data.map(row => row.id)).size !== data.length) throw new TypeError('Unconfirmed profit configuration rows');
  if (expected && (data.length !== expected.length || expected.some(fields => !data.some(row => {
    try { requireAccountWriteReceipt(row, fields); return true; } catch { return false; }
  })))) throw new TypeError('Unconfirmed profit configuration write receipt');
  return data;
}
