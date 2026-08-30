/** Deterministic Phase D finance cases shared by tests and the E2E scaffold. */
export type FinanceMatrixCase = {
  id: string;
  actor: string;
  organization: 'org-a' | 'org-b';
  expected: 'draft_created' | 'rejected';
  reason: string;
};

export const PHASE_D_FINANCE_MATRIX: readonly FinanceMatrixCase[] = [
  { id: 'superadmin-org-a', actor: 'superadmin', organization: 'org-a', expected: 'draft_created', reason: 'org-wide permission' },
  { id: 'manager-authorized-building', actor: 'manager', organization: 'org-a', expected: 'draft_created', reason: 'building-scoped permission' },
  { id: 'staff-missing-permission', actor: 'staff', organization: 'org-a', expected: 'rejected', reason: 'missing income_expenses.create' },
  { id: 'wrong-org-b', actor: 'superadmin', organization: 'org-b', expected: 'rejected', reason: 'selected organization mismatch' },
  { id: 'permission-revoked-after-preview', actor: 'manager', organization: 'org-a', expected: 'rejected', reason: 'execute re-checks permission' },
  { id: 'replayed-confirmation', actor: 'superadmin', organization: 'org-a', expected: 'rejected', reason: 'nonce CAS prevents replay' },
  { id: 'concurrent-double-execute', actor: 'superadmin', organization: 'org-a', expected: 'rejected', reason: 'row lock permits one execute' },
  { id: 'injection-auto-approve', actor: 'superadmin', organization: 'org-a', expected: 'rejected', reason: 'prompt text cannot approve or post' },
];

export const FINANCE_DRAFT_INVARIANTS = Object.freeze({
  approvalStatus: 'UNAPPROVED',
  voucherCount: 1,
  auditCount: 1,
  postingCount: 0,
  executorCallCount: 1,
} as const);

export type FinanceDraftOutcome = {
  voucherCount: number;
  auditCount: number;
  approvalStatus: string;
  postingCount: number;
  executorCallCount: number;
};

export function classifyFinanceDraftOutcome(outcome: FinanceDraftOutcome):
  | { ok: true; reason: 'draft_created' }
  | { ok: false; reason: string } {
  if (outcome.voucherCount !== FINANCE_DRAFT_INVARIANTS.voucherCount) {
    return { ok: false, reason: 'voucher_count_must_be_one' };
  }
  if (outcome.auditCount !== FINANCE_DRAFT_INVARIANTS.auditCount) {
    return { ok: false, reason: 'audit_count_must_be_one' };
  }
  if (outcome.approvalStatus !== FINANCE_DRAFT_INVARIANTS.approvalStatus) {
    return { ok: false, reason: 'approval_status_must_remain_unapproved' };
  }
  if (outcome.postingCount !== FINANCE_DRAFT_INVARIANTS.postingCount) {
    return { ok: false, reason: 'posting_must_remain_zero' };
  }
  if (outcome.executorCallCount !== FINANCE_DRAFT_INVARIANTS.executorCallCount) {
    return { ok: false, reason: 'executor_must_run_once' };
  }
  return { ok: true, reason: 'draft_created' };
}
