import { beforeEach, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
import { adjustInvoice, reviewInvoiceAdjustment, InvoiceAdjustmentError } from '../invoiceAdjustmentRpc';

const request = { invoiceId: 'inv', afterItems: [], discountAmount: 123, discountNotes: 'Giảm giá', notes: 'Ghi chú', reason: 'Lý do', expectedRevision: 2, expectedPaidAmount: 100, expectedUpdatedAt: '2026-09-12T10:00:00Z', idempotencyKey: 'same' };
const result = { id: 'dddd0000-0000-4000-8000-000000000001', organization_id: 'dddd0000-0000-4000-8000-000000000001', invoice_id: 'dddd0000-0000-4000-8000-000000000002', revision: 3, idempotency_key: 'same', reason: 'Lý do', before_snapshot: { items: [] }, after_snapshot: { items: [] }, before_total: 100, after_total: 200, delta: 100, adjusted_by: 'dddd0000-0000-4000-8000-000000000003', adjusted_at: '2026-09-12T10:00:00Z', review_status: 'PENDING', checked_by: null, checked_at: null };
beforeEach(() => rpc.mockReset());
it('passes every editable value and opening concurrency token through the exact v2 signature', async () => {
  rpc.mockResolvedValue({ data: result, error: null });
  expect(await adjustInvoice(request)).toEqual(result);
  expect(rpc).toHaveBeenCalledWith('adjust_invoice_v2', { p_invoice_id: 'inv', p_after_items: [], p_discount_amount: 123, p_discount_notes: 'Giảm giá', p_notes: 'Ghi chú', p_reason: 'Lý do', p_expected_revision: 2, p_expected_paid_amount: 100, p_expected_updated_at: request.expectedUpdatedAt, p_idempotency_key: 'same' });
});
it('requires the expected revision when reviewing', async () => {
  rpc.mockResolvedValue({ data: result, error: null });
  await reviewInvoiceAdjustment({ adjustmentId: result.id, expectedRevision: 3 });
  expect(rpc).toHaveBeenCalledWith('review_invoice_adjustment_v2', { p_adjustment_id: result.id, p_expected_revision: 3 });
});
it('omits nullable notes at serialization so SQL defaults preserve NULL', async () => {
  rpc.mockResolvedValue({ data: result, error: null });
  const nullableRequest = { ...request, notes: null, discountNotes: null };
  await adjustInvoice(nullableRequest);
  const args = rpc.mock.calls[0]?.[1];
  expect(args.p_notes).toBeUndefined();
  expect(args.p_discount_notes).toBeUndefined();
  const serialized: Record<string, unknown> = JSON.parse(JSON.stringify(args));
  expect(serialized).not.toHaveProperty('p_notes');
  expect(serialized).not.toHaveProperty('p_discount_notes');
  expect(nullableRequest).toMatchObject({ notes: null, discountNotes: null });
});
it('keeps explicit empty notes in the serialized request', async () => {
  rpc.mockResolvedValue({ data: result, error: null });
  await adjustInvoice({ ...request, notes: '', discountNotes: '' });
  const serialized: Record<string, unknown> = JSON.parse(JSON.stringify(rpc.mock.calls[0]?.[1]));
  expect(serialized).toMatchObject({ p_notes: '', p_discount_notes: '' });
});
it.each([null, {}, { ...result, delta: '100' }, { ...result, review_status: 'UNKNOWN' }])('rejects malformed RPC success %j', async data => {
  rpc.mockResolvedValue({ data, error: null });
  await expect(adjustInvoice(request)).rejects.toMatchObject({ kind: 'internal' });
});
it.each([['PT409', 'conflict'], ['40001', 'conflict'], ['42501', 'permission'], ['22023', 'validation'], ['23505', 'conflict'], ['55000', 'constraint'], ['XX000', 'internal']])('classifies %s without reporting success', async (code, kind) => {
  rpc.mockResolvedValue({ data: null, error: { code, message: 'Lỗi nội dung' } });
  await expect(adjustInvoice(request)).rejects.toMatchObject({ kind });
});
it('offers payment history for allocated, credit, rounding and carried debt constraints', () => {
  for (const message of ['tiền đã phân bổ', 'credit đang hiệu lực', 'làm tròn', 'Nợ đã chuyển sang hóa đơn sau']) {
    expect(new InvoiceAdjustmentError({ code: '55000', message }).showPaymentHistory).toBe(true);
  }
});
it('does not expose a raw permission or network error to the user', async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied for schema app_private' } });
  await expect(adjustInvoice(request)).rejects.toThrow('Bạn không có quyền');
  rpc.mockRejectedValueOnce(new TypeError('Failed to fetch internal URL'));
  await expect(adjustInvoice(request)).rejects.toMatchObject({ kind: 'internal' });
});
