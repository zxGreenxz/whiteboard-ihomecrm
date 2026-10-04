import { describe, expect, it, vi } from 'vitest';
import { createFinancialPendingStore } from '../financialPending';
import { executeBankEmailReview } from '../bankEmailReview';
import type { BankEmailTransaction } from '../bankEmail';

const transactionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const invoiceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const otherInvoiceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const receipt = {
  collection_id: '11111111-1111-4111-8111-111111111111', invoice_id: invoiceId,
  gross_amount: 500000, applied_amount: 500000, change_amount: 0, credit_amount: 0,
  rounding_amount: 0, credit_lot_id: null,
  tenders: [{ tender_id: '22222222-2222-4222-8222-222222222222', payment_id: '33333333-3333-4333-8333-333333333333', voucher_id: '44444444-4444-4444-8444-444444444444', applied_amount: 500000 }],
  invoice: { id: invoiceId },
};
const pending: BankEmailTransaction = {
  id: transactionId, connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', messageId: 'mail-1', internalDate: '2026-10-05T01:00:00Z', verified: true,
  account: '1234567890', amount: 500000, balance: 600000, currency: 'VND', direction: 'CREDIT', occurredAt: '2026-10-05T01:00:00Z',
  bankReference: 'FT123', description: 'ACB-E2E-01', status: 'PENDING', reason: 'INVOICE_NOT_UNIQUE', invoiceId: null, receipt: null, createdAt: '2026-10-05T01:01:00Z',
};
const posted: BankEmailTransaction = { ...pending, status: 'POSTED', reason: null, invoiceId, receipt };
const input = {
  actorId: 'actor-1', organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', transactionId,
  action: 'post' as const, invoiceNumber: 'ACB-E2E-01', expectedInvoiceId: invoiceId, expectedAmount: 500000,
};

function memoryStore() {
  const map = new Map<string, string>();
  const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
  return { store: createFinancialPendingStore({ storage }), map };
}

describe('bank email review recovery', () => {
  it('keeps unknown marker, then retries only after authoritative source remains pending', async () => {
    const { store, map } = memoryStore();
    const send = vi.fn().mockRejectedValueOnce(new TypeError('network lost')).mockResolvedValueOnce({ id: transactionId, status: 'POSTED', reason: null, invoiceId, receipt });
    const read = vi.fn().mockResolvedValue(pending);
    await expect(executeBankEmailReview(input, { store, send, read })).rejects.toThrow(/Chưa xác nhận/);
    expect(map.size).toBe(1);
    await expect(executeBankEmailReview(input, { store, send, read })).resolves.toMatchObject({ status: 'POSTED', invoiceId });
    expect(read).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ expectedInvoiceId: invoiceId, expectedAmount: 500000 }));
    expect(map.size).toBe(0);
  });

  it('reports the actual posted invoice and does not retry a different selected invoice', async () => {
    const { store, map } = memoryStore();
    const send = vi.fn().mockRejectedValueOnce(new TypeError('network lost'));
    await expect(executeBankEmailReview(input, { store, send, read: vi.fn().mockResolvedValue(pending) })).rejects.toThrow();
    const changedSelection = { ...input, expectedInvoiceId: otherInvoiceId };
    await expect(executeBankEmailReview(changedSelection, { store, send, read: vi.fn().mockResolvedValue(posted) })).rejects.toThrow(/khác lựa chọn/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(0);
  });

  it('retains marker when authoritative source cannot be read', async () => {
    const { store, map } = memoryStore();
    const send = vi.fn().mockRejectedValueOnce(new TypeError('network lost'));
    await expect(executeBankEmailReview(input, { store, send, read: vi.fn() })).rejects.toThrow();
    await expect(executeBankEmailReview(input, { store, send, read: vi.fn().mockRejectedValue(new Error('read denied')) })).rejects.toThrow(/Chưa xác nhận/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(1);
  });

  it.each(['PT409', '40001'])('reconciles a %s conflict against the source and reports the actual posted invoice', async code => {
    const { store, map } = memoryStore();
    const actual = {
      ...posted,
      invoiceId: otherInvoiceId,
      receipt: { ...receipt, invoice_id: otherInvoiceId, invoice: { id: otherInvoiceId } },
    };
    const send = vi.fn().mockRejectedValue({ code, message: 'invoice changed' });
    const read = vi.fn().mockResolvedValue(actual);
    await expect(executeBankEmailReview(input, { store, send, read })).rejects.toThrow(/khác lựa chọn/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(transactionId);
    expect(map.size).toBe(0);
  });
});
