import { describe, expect, it } from 'vitest';
import { checkSnapshot } from '../test-env/receipt.mjs';

const receipt = {
  ket_qua: 'DAT', snapshot_prod: '2026-10-06T00:00:00Z',
  chi_tiet: { schemaDigest: 'catalog-match', ownersDigest: 'owners-match' },
};
const args = { digest: 'catalog-match', ownersDigest: 'owners-match', now: Date.parse('2026-10-06T01:00:00Z') };

describe('quick TEST receipt checks custom role, owner and ACL metadata', () => {
  it('returns both digests only when both match the latest successful snapshot', () => {
    expect(checkSnapshot(receipt, args)).toEqual({ snapshotAt: receipt.snapshot_prod, ageHours: 1,
      schemaDigest: 'catalog-match', ownersDigest: 'owners-match' });
  });

  it('rejects role/owner/ACL drift even when the application catalog still matches', () => {
    expect(() => checkSnapshot(receipt, { ...args, ownersDigest: 'owners-drift' })).toThrow(/snapshot|Snapshot/);
  });

  it('requires a new full sync for legacy DAT receipts without an owners digest', () => {
    const old = { ...receipt, chi_tiet: { schemaDigest: 'catalog-match' } };
    expect(() => checkSnapshot(old, args)).toThrow(/--sync/);
  });

  it.each([undefined, null, '', 0])('rejects missing current owners digest %s instead of bypassing the check', (ownersDigest) => {
    expect(() => checkSnapshot(receipt, { ...args, ownersDigest })).toThrow(/--sync/);
  });
});
