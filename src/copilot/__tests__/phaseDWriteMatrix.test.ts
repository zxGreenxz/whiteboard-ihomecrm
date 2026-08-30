import { describe, expect, it } from 'vitest';

import {
  FINANCE_DRAFT_INVARIANTS,
  PHASE_D_FINANCE_MATRIX,
  classifyFinanceDraftOutcome,
} from '../phaseDWriteMatrix';

describe('Phase D finance preview/execute matrix', () => {
  it('covers role, organization, revoke, replay, concurrency, and injection boundaries', () => {
    expect(PHASE_D_FINANCE_MATRIX.map((item) => item.id)).toEqual([
      'superadmin-org-a',
      'manager-authorized-building',
      'staff-missing-permission',
      'wrong-org-b',
      'permission-revoked-after-preview',
      'replayed-confirmation',
      'concurrent-double-execute',
      'injection-auto-approve',
    ]);
  });

  it('permits success only as one UNAPPROVED, unposted draft with one audit row', () => {
    expect(
      classifyFinanceDraftOutcome({
        voucherCount: 1,
        auditCount: 1,
        approvalStatus: 'UNAPPROVED',
        postingCount: 0,
        executorCallCount: 1,
      }),
    ).toEqual({ ok: true, reason: 'draft_created' });
  });

  it.each([
    ['approved at birth', { approvalStatus: 'APPROVED' }],
    ['posted at birth', { postingCount: 1 }],
    ['duplicate voucher', { voucherCount: 2 }],
    ['missing audit', { auditCount: 0 }],
    ['double executor', { executorCallCount: 2 }],
  ])('rejects %s', (_label, override) => {
    expect(
      classifyFinanceDraftOutcome({
        voucherCount: 1,
        auditCount: 1,
        approvalStatus: 'UNAPPROVED',
        postingCount: 0,
        executorCallCount: 1,
        ...override,
      }),
    ).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('defines immutable success invariants shared with the E2E scaffold', () => {
    expect(FINANCE_DRAFT_INVARIANTS).toEqual({
      approvalStatus: 'UNAPPROVED',
      voucherCount: 1,
      auditCount: 1,
      postingCount: 0,
      executorCallCount: 1,
    });
  });
});
