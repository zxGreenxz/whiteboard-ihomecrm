import { expect, it, vi } from 'vitest';
import { buildRecipientPatch, updateIncomeExpenseRecipient } from '../incomeExpenseRecipient';
const id = 'aaaaaaaa-0000-4000-8000-000000000001';
const organizationId = 'dddddddd-0000-4000-8000-000000000001';
const recipient = { payerName: 'Người nhận', bankName: ' ACB ', bankAccount: '0123' };
const expected = { ...recipient, approvalVersion: 1, postingVersion: 2, reviewVersion: 3 };
it('sends only changed recipient fields and keeps untouched bank bytes out of the patch', () => {
  expect(buildRecipientPatch(recipient, { ...recipient, payerName: '  Người mới  ' })).toEqual({ payerName: 'Người mới' });
  expect(buildRecipientPatch(recipient, { ...recipient, bankAccount: '' })).toEqual({ bankAccount: null });
  expect(buildRecipientPatch(recipient, recipient)).toEqual({});
});
it('uses only the sparse writer with the exact organization, voucher and expected values', async () => {
  const send = vi.fn().mockResolvedValue({ data: { voucherId: id, organizationId, recipient: { ...recipient, payerName: 'Người mới' } }, error: null });
  await updateIncomeExpenseRecipient({ voucherId: id, organizationId, expected, patch: { payerName: 'Người mới' } }, send);
  expect(send).toHaveBeenCalledExactlyOnceWith('update_income_expense_recipient_v1', {
    p_organization_id: organizationId, p_voucher_id: id, p_expected: expected, p_patch: { payerName: 'Người mới' },
  });
});
it.each([{ amount: 100 }, { bankAccount: '99', account_id: id }, {}])('rejects financial/unknown fields or empty patches before any write', async patch => {
  const send = vi.fn();
  await expect(updateIncomeExpenseRecipient({ voucherId: id, organizationId, expected, patch } as never, send)).rejects.toMatchObject({ kind: 'validation' });
  expect(send).not.toHaveBeenCalled();
});
it.each([
  { voucherId: 'bbbbbbbb-0000-4000-8000-000000000001', organizationId, recipient },
  { voucherId: id, organizationId: id, recipient },
  { voucherId: id, organizationId, recipient: { ...recipient, payerName: 'Sai tên' } },
  { voucherId: id, organizationId, recipient: { ...recipient, payerName: 'Người mới', bankAccount: 'unexpected' } },
])('does not claim success for contradictory returned identity or recipient', async data => {
  const send = vi.fn().mockResolvedValue({ data, error: null });
  await expect(updateIncomeExpenseRecipient({ voucherId: id, organizationId, expected, patch: { payerName: 'Người mới' } }, send)).rejects.toMatchObject({ kind: 'unconfirmed' });
  expect(send).toHaveBeenCalledTimes(1);
});
it('preserves CAS rejection and never retries a lost response automatically', async () => {
  const send = vi.fn().mockResolvedValueOnce({ data: null, error: { code: '40001' } }).mockRejectedValueOnce(new TypeError('network'));
  const input = { voucherId: id, organizationId, expected, patch: { payerName: 'Người mới' } };
  await expect(updateIncomeExpenseRecipient(input, send)).rejects.toMatchObject({ kind: 'concurrency' });
  await expect(updateIncomeExpenseRecipient(input, send)).rejects.toMatchObject({ kind: 'unconfirmed' });
  expect(send).toHaveBeenCalledTimes(2);
});
