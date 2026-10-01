import { describe, expect, it } from 'vitest';
import { invoiceLifecycleFeedback, confirmedInvoiceReceipt } from '../invoiceFeedback';
describe('phản hồi hoá đơn theo kết quả máy chủ',()=>{
 it('khôi phục không đoán về đã duyệt',()=>{expect(invoiceLifecycleFeedback({invoice:{id:'i1',invoice_number:'HD-01',status:'PARTIAL_PAID'}},'khôi phục').description).toContain('thu một phần');});
 it('no-op nói không thay đổi',()=>{expect(invoiceLifecycleFeedback({invoice:{id:'i1',status:'CANCELLED'},noop:true},'huỷ').title).toContain('không thay đổi');});
 it('không coi phản hồi thiếu mã là đã tạo',()=>{expect(()=>confirmedInvoiceReceipt(null)).toThrow(TypeError);});
});

const invoiceId = 'ef2bf5f1-7306-4df2-bf7e-03e761b0912f';
const otherId = 'c60beb7e-cc19-4ef2-a419-ed91bfe3cba1';
describe('canonical invoice receipt identity', () => {
 it('normalizes the actual canonical invoice_id receipt without guessing status', () => {
  const receipt = { invoice_id: invoiceId, status: 'DRAFT', invoice_number: 'INV-2026-01012' };
  expect(confirmedInvoiceReceipt(receipt)).toEqual({ ...receipt, id: invoiceId });
  expect(receipt).not.toHaveProperty('id');
 });
 it('preserves existing row and nested receipt compatibility', () => {
  const row = { id: 'legacy-invoice', invoice_number: 'OLD', status: 'APPROVED' };
  expect(confirmedInvoiceReceipt(row)).toEqual(row);
  expect(confirmedInvoiceReceipt({ invoice: row, noop: true })).toEqual(row);
  expect(confirmedInvoiceReceipt({ id: invoiceId, invoice_id: invoiceId, invoice: { id: invoiceId, status: 'DRAFT' } })).toEqual({ id: invoiceId, status: 'DRAFT' });
 });
 it.each([
  null, [], {}, { status: 'DRAFT' }, { invoice_id: '' }, { invoice_id: 'not-an-invoice-id' },
  { invoice_id: 1 }, { invoice_id: null }, { id: ' ' }, { invoice: [] },
  { invoice_id: invoiceId, id: otherId }, { invoice_id: invoiceId, id: null },
  { invoice_id: invoiceId, invoice: { id: otherId } }, { id: invoiceId, invoice: { id: otherId } },
  { invoice_id: invoiceId, invoice: null }, { invoice_id: invoiceId, invoice: {} },
 ].map(receipt => [receipt]))('rejects missing, malformed or contradictory receipt identity: %j', receipt => {
  expect(() => confirmedInvoiceReceipt(receipt)).toThrow(TypeError);
 });
});
