import { describe, expect, it, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
import { createEmailBillRepository } from '../importRpc';

const org = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const source = { provider: 'grab' as const, mailbox: 'owner@gmail.com', message_id: 'abcdef123', receipt_id: 'GRAB-123' };
const voucher = { type: 'EXPENSE' as const, name: 'Chi Grab', building_id: org, account_id: id, voucher_date: '2026-10-04',
  attachments: [], business_result_accounting: null, items: [{ income_expense_type_id: id, quantity: 1, unit_price: 85000, start_date: '2026-10-01', end_date: '2026-10-31' }] };

describe('email bill financial boundary', () => {
  it('calls only atomic import with explicit org, source and reviewed fields', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id, created: true }, error: null });
    const repo = createEmailBillRepository(rpc);
    expect(await repo.create(org, source, voucher)).toEqual({ id, created: true });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0][0]).toBe('create_income_expense_from_email_v1');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_organization_id: org, p_source: source, p_voucher: { type: 'EXPENSE', name: 'Chi Grab' }, p_items: voucher.items });
    expect(rpc.mock.calls[0][1].p_voucher).not.toHaveProperty('items');
  });
  it.each([null, {}, { id }, { id: 'not-uuid', created: true }])('rejects unconfirmed result %j', async (data) => {
    const repo = createEmailBillRepository(vi.fn().mockResolvedValue({ data, error: null }));
    await expect(repo.create(org, source, voucher)).rejects.toThrow(/xác nhận/);
  });
  it('does not fallback or issue another write after timeout; retry retains source', async () => {
    const rpc = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ data: { id, created: false }, error: null });
    const repo = createEmailBillRepository(rpc);
    await expect(repo.create(org, source, voucher)).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await repo.create(org, source, voucher)).toEqual({ id, created: false });
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
  it.each([{ ...source, receipt_id: '' }, { ...source, mailbox: 'bad' }, { ...source, provider: 'evil' }])('rejects bad source before RPC', async (bad) => {
    const rpc = vi.fn();
    await expect(createEmailBillRepository(rpc).create(org, bad as typeof source, voucher)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects recurring or INCOME payload rather than silently dropping fields', async () => {
    const rpc = vi.fn(); const repo = createEmailBillRepository(rpc);
    await expect(repo.create(org, source, { ...voucher, repeat_cycle: 'MONTH' })).rejects.toThrow();
    await expect(repo.create(org, source, { ...voucher, type: 'INCOME' })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('lookup requires exact receipts; absent or unrelated rows cannot mean not imported', async () => {
    for (const data of [null, [], [{ provider: 'grab', receipt_id: 'other', imported: false }], [{ provider: 'grab', receipt_id: source.receipt_id }]]) {
      await expect(createEmailBillRepository(vi.fn().mockResolvedValue({ data, error: null })).lookup(org, [source])).rejects.toThrow(/kiểm tra/);
    }
    const repo = createEmailBillRepository(vi.fn().mockResolvedValue({ data: [{ provider: 'grab', receipt_id: source.receipt_id, imported: true }], error: null }));
    expect(await repo.lookup(org, [source])).toEqual(new Set(['grab:GRAB-123']));
  });
});
