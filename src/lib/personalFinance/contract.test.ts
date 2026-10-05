import { describe, expect, it } from 'vitest';
import { mutationSchema, parseSnapshot, normalizeMutation, parseReceipt } from './contract';
import { createPersonalFinanceService, type PersonalFinanceRpcClient } from './service';

const id = '00000000-0000-4000-8000-000000000001';
const row = { type: 'EXPENSE', amount: 100, txn_date: '2026-10-05', wallet_id: id, category_id: id };
describe('personal finance boundary', () => {
  it('accepts a bounded atomic batch', () => {
    expect(mutationSchema.parse({ action: 'transaction.batch', rows: [row] }).rows).toHaveLength(1);
    expect(mutationSchema.safeParse({ action: 'transaction.batch', rows: Array(201).fill(row) }).success).toBe(false);
  });
  it.each(['2026-02-30', '2026-2-03', '0000-01-01'])('rejects invalid date %s', txn_date => {
    expect(mutationSchema.safeParse({ action: 'transaction.batch', rows: [{ ...row, txn_date }] }).success).toBe(false);
  });
  it('requires expected versions and rejects privileged fields', () => {
    expect(mutationSchema.safeParse({ action: 'wallet.update', id, data: { name: 'X' } }).success).toBe(false);
    expect(mutationSchema.safeParse({ action: 'wallet.create', data: { name: 'X', user_id: id } }).success).toBe(false);
  });
  it('normalizes whitespace and retains duplicate batch entries', () => {
    const input = { action: 'transaction.batch', rows: [{ ...row, description: ' A ' }, { ...row, description: 'A' }] };
    const value = normalizeMutation(input);
    expect(value.rows).toHaveLength(2);
    expect(value.rows?.[0]).toEqual(value.rows?.[1]);
  });
  it('rejects malformed and foreign-owner snapshots', () => {
    expect(() => parseSnapshot({}, id)).toThrow();
    expect(() => parseSnapshot({ owner_id: '00000000-0000-4000-8000-000000000002' }, id)).toThrow();
  });
  it.each([0, -1, 1.5, 1e12 + 1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid new VND amount %s', amount => {
    expect(mutationSchema.safeParse({ action: 'transaction.batch', rows: [{ ...row, amount }] }).success).toBe(false);
  });
  it('accepts ewallet and trims entity names', () => {
    expect(normalizeMutation({ action: 'wallet.create', data: { name: ' Ví điện tử ', kind: 'ewallet' } }).data?.name).toBe('Ví điện tử');
  });
  it('validates receipt contents, owner, key, action and deleted marker', () => {
    const receipt = { owner_id: id, request_key: id, action: 'wallet.delete', entities: [{ id, user_id: id, version: 2, deleted: true }] };
    expect(parseReceipt(receipt, id, id, 'wallet.delete').entities).toHaveLength(1);
    for (const patch of [{ owner_id: '00000000-0000-4000-8000-000000000002' }, { action: 'goal.delete' }, { entities: [{ id, user_id: id, version: 2 }] }, { entities: [{ id, user_id: '00000000-0000-4000-8000-000000000002', version: 2, deleted: true }] }]) {
      expect(() => parseReceipt({ ...receipt, ...patch }, id, id, 'wallet.delete')).toThrow();
    }
  });
  it.each([12.25,12.125,0.1,0.2])('preserves historical decimal VND %s in a snapshot', amount => {
    const snapshot = { owner_id: id, schema_version: 1, wallets: [], categories: [], transfers: [], budgets: [], goals: [], transactions: [{ id, user_id: id, version: 1, ...row, amount, description: null, category: 'legacy', resolved_wallet_id: id, resolved_category_id: id, created_at: '2026-10-05T00:00:00+00:00', updated_at: '2026-10-05T00:00:00+00:00', deleted_at: null }] };
    expect(parseSnapshot(snapshot, id).transactions[0].amount).toBe(amount);
  });
  it.each(['\t', '😀'.repeat(50)])('preserves PostgreSQL-valid legacy category labels verbatim: %j', legacyName => {
    const snapshot = { owner_id: id, schema_version: 1, wallets: [], transactions: [], transfers: [], budgets: [], goals: [], categories: [{ id, user_id: id, version: 1, type: 'EXPENSE', name: legacyName, icon: '🧾', color: '#adafa7', hidden: false, seed_key: null, legacy_name: legacyName }] };
    const category = parseSnapshot(snapshot, id).categories[0];
    expect(category.name).toBe(legacyName);
    expect(category.legacy_name).toBe(legacyName);
    expect(mutationSchema.safeParse({ action: 'category.create', data: { type: 'EXPENSE', name: legacyName } }).success).toBe(false);
  });
  it('marks malformed receipt as unknown outcome and keeps request key for retry', async () => {
    const requests: unknown[] = [];
    const client: PersonalFinanceRpcClient = { rpc: async (_name, args) => { requests.push(args); return { data: {}, error: null }; } };
    const service = createPersonalFinanceService(client, id);
    for (let i = 0; i < 2; i++) await expect(service.mutate(id, { action: 'transaction.batch', rows: [row] })).rejects.toMatchObject({ kind: 'internal', outcomeUnknown: true });
    expect(requests[0]).toEqual(requests[1]);
  });
  it.each([['42501', 'permission'], ['23505', 'conflict'], ['40001', 'conflict'], ['22023', 'validation']])('maps SQL %s to %s', async (code, kind) => {
    const client: PersonalFinanceRpcClient = { rpc: async () => ({ data: null, error: { code } }) };
    await expect(createPersonalFinanceService(client, id).mutate(id, { action: 'transaction.batch', rows: [row] })).rejects.toMatchObject({ kind, outcomeUnknown: false });
  });
  it('marks network mutation error outcome unknown', async () => {
    const client: PersonalFinanceRpcClient = { rpc: async () => { throw new TypeError('Failed to fetch'); } };
    await expect(createPersonalFinanceService(client, id).mutate(id, { action: 'transaction.batch', rows: [row] })).rejects.toMatchObject({ kind: 'network', outcomeUnknown: true });
  });
});
