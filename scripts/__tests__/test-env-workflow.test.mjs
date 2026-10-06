import { describe, expect, it } from 'vitest';
import { assertSuite, catalogDigest, checkSnapshot } from '../test-env/receipt.mjs';

describe('TEST workflow safety', () => {
  it('quick run rejects failed, stale, missing and changed-schema snapshots', () => {
    const receipt = { ket_qua: 'DAT', snapshot_prod: '2026-10-06T00:00:00Z', chi_tiet: { schemaDigest: 'same', ownersDigest: 'same-owners' } };
    const args = { digest: 'same', ownersDigest: 'same-owners', now: Date.parse('2026-10-06T01:00:00Z'), maxAgeHours: 24 };
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
