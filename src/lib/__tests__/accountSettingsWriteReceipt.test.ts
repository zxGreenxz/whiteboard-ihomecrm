import { describe, expect, it } from 'vitest';
import { requireAccountWriteReceipt, AccountWriteReceiptError } from '../accountSettingsWriteReceipt';

describe('requireAccountWriteReceipt', () => {
  // Sửa công việc: TaskEditDialog gửi toISOString(), PostgREST trả timestamptz "+00:00" — cùng thời điểm.
  it('nhận mốc thời gian Postgres trả về khác chuỗi nhưng cùng thời điểm', () => {
    const row = { id: 'j1', deadline: '2026-10-01T03:00:00+00:00', title: 'Sửa vòi' };
    expect(requireAccountWriteReceipt(row, { id: 'j1', deadline: '2026-10-01T03:00:00.000Z', title: 'Sửa vòi' })).toBe(row);
    expect(requireAccountWriteReceipt({ id: 'j1', deadline: '2026-10-01 10:00:00+07' }, { deadline: '2026-10-01T03:00:00.000Z' })).toBeTruthy();
  });
  it('vẫn từ chối khi thời điểm đã lưu khác thời điểm gửi', () => {
    expect(() => requireAccountWriteReceipt({ id: 'j1', deadline: '2026-10-01T04:00:00+00:00' }, { deadline: '2026-10-01T03:00:00.000Z' })).toThrow(AccountWriteReceiptError);
  });
  it('chuỗi không phải mốc thời gian vẫn so đúng nguyên văn', () => {
    expect(() => requireAccountWriteReceipt({ id: 'j1', due: '2026-10-01' }, { due: '2026-10-02' })).toThrow(AccountWriteReceiptError);
    expect(() => requireAccountWriteReceipt({ id: 'j1', title: 'a' }, { title: 'b' })).toThrow(AccountWriteReceiptError);
    expect(requireAccountWriteReceipt({ id: 'j1', deadline: null }, { deadline: null })).toBeTruthy();
  });
  it('thiếu id vẫn là phản hồi chưa xác nhận', () => {
    expect(() => requireAccountWriteReceipt({ deadline: '2026-10-01T03:00:00+00:00' }, { deadline: '2026-10-01T03:00:00.000Z' })).toThrow(AccountWriteReceiptError);
  });
});
