import { describe, expect, it, vi } from 'vitest';
import { parseActionSnapshotBatch, readActionSnapshotBatches, actionSnapshotQueryKey, queryActionReadiness } from '../incomeExpenseActionSnapshot';

const scope = { actorId: 'actor', organizationId: 'org' };
const row = (id = 'v') => ({ id, organizationId: 'org', buildingId: null, roomId: null, contractId: null, tenantId: null,
  code: 'PC001', name: 'Chi', type: 'EXPENSE', totalAmount: '2640000.00', userId: 'maker', makerUserId: null,
  payerName: null, receiveBankName: null, receiveBankAccount: null, notes: null, attachments: [], voucherDate: '2026-09-21',
  accountId: null, activePostingId: null, approvalStatus: 'UNAPPROVED', postingStatus: 'UNPOSTED', postingMode: 'CASHBOOK',
  reviewState: 'PENDING', reviewReason: null, approvalVersion: 3, postingVersion: 4, reviewVersion: 5,
  systemSource: 'contract.commission', flowKind: 'CANONICAL_INCOME_EXPENSE', birthState: 'COMMITTED', capabilities: { forfeitPair:false,forfeitAllowed:false,engineBlocked:false,manual:true,legacyCancelAllowed:true,compatCancelOwner:true,birthPrior:true,requiresRealAccount:false,reservationMoneyBlocked:false,reservationRefundReverseAllowed:false },
  permissions: { approve: true, edit: false, cancel: false, reverse: false } });
const batch = (rows: unknown[] = [row()]) => ({ ...scope, isAdmin: false, authorizationVersion: 8,
  routes: { readSemantics: 'CANONICAL', workflow: 'CANONICAL', posting: 'CANONICAL', access: 'CANONICAL', accountingStandardStrict: false }, rows });

describe('strict common voucher action snapshot', () => {
  it('preserves nullable scope and actual versions, owner and money without defaults', () => {
    const value = parseActionSnapshotBatch(batch(), scope, ['v']);
    expect(value.rows.v).toMatchObject({ buildingId: null, totalAmount: 2640000, approvalVersion: 3, postingVersion: 4, reviewVersion: 5, flowKind: 'CANONICAL_INCOME_EXPENSE' });
    expect(parseActionSnapshotBatch(batch([{ ...row(), approvalVersion: null }]), scope, ['v']).rows.v.approvalVersion).toBeNull();
  });
  it.each([
    { totalAmount: 'invalid' }, { totalAmount: 9007199254740992 }, { postingVersion: undefined }, { postingVersion: -1 },
    { flowKind: undefined }, { postingStatus: 'FUTURE_STATE' }, { attachments: [null] }, { birthState: undefined },
  ])('keeps a malformed row unavailable: %j', patch => {
    const result = parseActionSnapshotBatch(batch([{ ...row(), ...patch }]), scope, ['v']);
    expect(result.rows.v).toBeUndefined(); expect(result.unavailable.v).toBe('INVALID_SNAPSHOT');
  });
  it('does not turn a missing or invisible ID into a ready empty voucher', () => {
    expect(parseActionSnapshotBatch(batch([]), scope, ['v']).unavailable.v).toBe('NOT_VISIBLE');
  });
  it.each([
    { actorId: 'other' }, { organizationId: 'other' }, { authorizationVersion: null },
    { routes: null }, { routes: { ...batch().routes, workflow: 'new-route' } },
  ])('rejects unverified envelope %j without legacy fallback', patch => {
    expect(() => parseActionSnapshotBatch({ ...batch(), ...patch }, scope, ['v'])).toThrow();
  });
  it('rejects duplicate, unsolicited and cross-org rows', () => {
    for (const rows of [[row(), row()], [row('other')], [{ ...row(), organizationId: 'other' }]]) {
      expect(() => parseActionSnapshotBatch(batch(rows), scope, ['v'])).toThrow();
    }
  });
  it('chunks all requested IDs, including more than the PostgREST row cap, without N+1 requests', async () => {
    const ids = Array.from({ length: 1005 }, (_, i) => `v${i}`);
    const reader = vi.fn(async (_scope, requested: string[]) => batch(requested.map(row)));
    const result = await readActionSnapshotBatches(scope, [...ids, ids[0]], reader);
    expect(Object.keys(result.rows)).toHaveLength(1005); expect(reader).toHaveBeenCalledTimes(6);
    expect(reader.mock.calls.every(call => call[1].length <= 200)).toBe(true);
  });
  it('rejects changing authorization/routes during a multi-batch read', async () => {
    let calls = 0;
    await expect(readActionSnapshotBatches(scope, Array.from({ length: 201 }, (_, i) => `v${i}`), async (_scope, ids) => ({ ...batch(ids.map(row)), authorizationVersion: ++calls }))).rejects.toThrow('SNAPSHOT_CHANGED');
  });
  it('isolates actor, org and sorted selection in cache keys', () => {
    expect(actionSnapshotQueryKey(scope, ['b', 'a', 'a'])).toEqual(actionSnapshotQueryKey(scope, ['a', 'b']));
    expect(actionSnapshotQueryKey(scope, ['v'])).not.toEqual(actionSnapshotQueryKey({ ...scope, actorId: 'other' }, ['v']));
    expect(actionSnapshotQueryKey(scope, ['v'])[0]).not.toBe('finance-v2-routes');
  });
  it('stale data cannot authorize while refreshing, after an error, or when disabled', () => {
    expect(queryActionReadiness({ data: 42, isFetching: true, isError: false }, true)).toEqual({ state: 'loading' });
    expect(queryActionReadiness({ data: 42, isFetching: false, isError: true }, true).state).toBe('error');
    expect(queryActionReadiness({ data: 42, isFetching: false, isError: false }, false).state).toBe('loading');
    expect(queryActionReadiness({ data: 42, isFetching: false, isError: false }, true)).toEqual({ state: 'ready', value: 42 });
  });
});

it('parses only exact REFUND source capabilities and fails closed on malformed facts',()=>{
 const cap={settlementId:'s',sourceVoucherId:'d',basisFingerprint:'basis',remaining:2640000,basisValid:true,current:true,fullRemaining:true};
 const base={...row(),systemSource:'reservation.refund',capabilities:{...row().capabilities,reservationRefund:cap}};
 expect(parseActionSnapshotBatch(batch([base]),scope,['v']).rows.v.capabilities.reservationRefund).toEqual(cap);
 for(const change of [{remaining:null},{remaining:-1},{remaining:1},{basisValid:'yes'},{current:null},{settlementId:''}])expect(parseActionSnapshotBatch(batch([{...base,capabilities:{...base.capabilities,reservationRefund:{...cap,...change}}}]),scope,['v']).unavailable.v).toBe('INVALID_SNAPSHOT');
 expect(parseActionSnapshotBatch(batch([{...base,systemSource:'reservation.forfeit_offset'}]),scope,['v']).unavailable.v).toBe('INVALID_SNAPSHOT');
});
