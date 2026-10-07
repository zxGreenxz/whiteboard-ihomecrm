import { describe, expect, it } from 'vitest';
import { mutationSchema, parseReceipt, parseSnapshot } from './contract';
import { transactionChanges } from './transactionInput';

const owner = '11111111-1111-4111-8111-111111111111';
const path = `${owner}/22222222-2222-4222-8222-222222222222.webp`;
const row = { id: owner, user_id: owner, version: 1, type: 'EXPENSE' as const, amount: 100_000,
  wallet_id: owner, category_id: owner, resolved_wallet_id: owner, resolved_category_id: owner,
  txn_date: '2026-10-07', description: 'Đồ ăn', category: 'Ăn uống', deleted_at: null,
  created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z' };
const input = { type: row.type, amount: row.amount, wallet_id: owner, category_id: owner, txn_date: row.txn_date };
const snapshot = (transaction: unknown) => parseSnapshot({ owner_id: owner, schema_version: 1, wallets: [], categories: [], transfers: [], budgets: [], goals: [], transactions: [transaction] }, owner);

describe('personal transaction attachment contract', () => {
  it('round trips paths through create, batch, snapshot and receipt', () => {
    expect(mutationSchema.parse({ action: 'transaction.create', data: { ...input, attachment_paths: [path] } }).data?.attachment_paths).toEqual([path]);
    expect(mutationSchema.parse({ action: 'transaction.batch', rows: [{ ...input, attachment_paths: [path] }] }).rows?.[0].attachment_paths).toEqual([path]);
    expect(snapshot({ ...row, attachment_paths: [path] }).transactions[0].attachment_paths).toEqual([path]);
    const receipt = parseReceipt({ owner_id: owner, request_key: owner, action: 'transaction.create', entities: [{ ...row, attachment_paths: [path] }] }, owner, owner, 'transaction.create');
    expect(receipt.entities[0].attachment_paths).toEqual([path]);
  });
  it('reads old snapshots and receipts without altering an old pending payload', () => {
    expect(snapshot(row).transactions[0].attachment_paths).toEqual([]);
    expect(parseReceipt({ owner_id: owner, request_key: owner, action: 'transaction.create', entities: [row] }, owner, owner, 'transaction.create').entities[0].attachment_paths).toEqual([]);
    expect(mutationSchema.parse({ action: 'transaction.batch', rows: [input] }).rows?.[0]).not.toHaveProperty('attachment_paths');
    expect(mutationSchema.parse({ action: 'transaction.update', id: owner, expected_version: 1, data: { description: 'mới' } }).data).toEqual({ description: 'mới' });
  });
  it('supports explicit unlink and omits unchanged arrays', () => {
    const before = snapshot({ ...row, attachment_paths: [path] }).transactions[0];
    expect(transactionChanges(before, { ...input, description: 'mới', attachment_paths: [path] })).toEqual({ description: 'mới' });
    expect(transactionChanges(before, { ...input, attachment_paths: [] })).toEqual({ attachment_paths: [] });
  });
  it.each([null, {}, [1], ['https://example.com/bill.jpg'], ['../other/bill.jpg'], [`${owner}/../../bill.jpg`], Array(21).fill(path)])('rejects invalid attachment paths %j', attachment_paths => {
    expect(mutationSchema.safeParse({ action: 'transaction.batch', rows: [{ ...input, attachment_paths }] }).success).toBe(false);
  });
});
