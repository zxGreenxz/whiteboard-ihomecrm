import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ answer: 't', closed: 0, guarded: 0 }));
vi.mock('../test-env/lib.mjs', () => ({
  batBuocDichTest: async () => { state.guarded++; },
  PhienPsql: class {
    p = { once() {}, off() {} };
    async chay(sql) { return sql.includes('try_advisory') ? state.answer : '1'; }
    async dong() { state.closed++; }
  },
}));
import { assertTestLease, withTestLock } from '../test-env/lock.mjs';
import { assertSuite, catalogDigest, checkSnapshot } from '../test-env/receipt.mjs';

beforeEach(() => { Object.assign(state, { answer: 't', closed: 0, guarded: 0 }); });
describe('TEST workflow safety', () => {
  it('busy lock prevents work and closes connection', async () => {
    state.answer = 'f'; let wrote = false;
    await expect(withTestLock({ cred: {}, test: 'test-db' }, async () => { wrote = true; })).rejects.toThrow(/TEST/);
    expect(wrote).toBe(false); expect(state.closed).toBe(1);
  });
  it('lease cannot be forged, reused after release or used for another database', async () => {
    await expect(assertTestLease({}, 'test-db')).rejects.toThrow();
    let held;
    await withTestLock({ cred: {}, test: 'test-db' }, async lease => {
      held = lease; await assertTestLease(lease, 'test-db');
      await expect(assertTestLease(lease, 'wrong-db')).rejects.toThrow();
    });
    await expect(assertTestLease(held, 'test-db')).rejects.toThrow();
    expect(state.guarded).toBe(1); expect(state.closed).toBe(1);
  });
  it('failed work releases the lock and preserves failure', async () => {
    await expect(withTestLock({ cred: {}, test: 'test-db' }, async () => { throw new Error('failed test'); })).rejects.toThrow('failed test');
    expect(state.closed).toBe(1);
  });
  it('quick run rejects failed, stale, missing and changed-schema snapshots', () => {
    const receipt = { ket_qua: 'DAT', snapshot_prod: '2026-10-06T00:00:00Z', chi_tiet: { schemaDigest: 'same' } };
    const args = { digest: 'same', now: Date.parse('2026-10-06T01:00:00Z'), maxAgeHours: 24 };
    expect(checkSnapshot(receipt, args).ageHours).toBe(1);
    for (const r of [null, { ...receipt, ket_qua: 'LECH' }, { ...receipt, chi_tiet: {} }, { ...receipt, snapshot_prod: '2026-10-04T00:00:00Z' }]) {
      expect(() => checkSnapshot(r, args)).toThrow();
    }
    expect(() => checkSnapshot(receipt, { ...args, digest: 'changed' })).toThrow();
    expect(() => checkSnapshot(receipt, { ...args, maxAgeHours: NaN })).toThrow();
  });
  it('catalog digest ignores order but changes when ACL/owner fingerprint changes', () => {
    const rows = [{ k: 'fn:a', v: 'abc' }, { k: 'fn:b', v: 'def' }];
    expect(catalogDigest(rows)).toBe(catalogDigest([...rows].reverse()));
    expect(catalogDigest(rows)).not.toBe(catalogDigest([{ k: 'fn:a', v: 'wrong' }, rows[1]]));
    expect(() => catalogDigest([])).toThrow();
  });
  it('empty, skipped and failed suites never count as green', () => {
    expect(() => assertSuite({ passed: 33 }, 33)).not.toThrow();
    for (const report of [{ passed: 0 }, { passed: 32 }, { passed: 33, skipped: 1 }, { passed: 33, failed: 1 }, { passed: 33, cleanup: 'failed' }]) {
      expect(() => assertSuite(report, 33)).toThrow();
    }
  });
});
