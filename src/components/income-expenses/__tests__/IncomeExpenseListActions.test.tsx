// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import IncomeExpenseList from '../IncomeExpenseList';
import type { IncomeExpenseWithRelations } from '@/hooks/useIncomeExpenses';
import { pendingIncomeExpenseActionContext, type IncomeExpenseActionContext } from '@/lib/incomeExpenseActionPolicy';
vi.mock('@/hooks/useIsAdmin', () => ({ useIsAdmin: () => ({ data: false }), useIsSuperAdmin: () => ({ data: false }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'actor' } }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/financeV2Route', () => ({ useFinanceV2Routes: () => ({ getOrg: () => ({ readSemantics: 'CANONICAL' }) }), isCanonicalRead: () => true }));
const voucher = { id: 'v', code: 'PC-test', name: 'Phiếu chi', user_id: 'actor', type: 'EXPENSE', approval_status: 'UNAPPROVED',
  review_state: 'CHANGES_REQUESTED', posting_status: 'UNPOSTED', voucher_date: '2026-09-20', total_amount: 100,
  attachments: [], items: [], repeat_cycle: 'NONE' } as unknown as IncomeExpenseWithRelations;
function fixture(actionContexts?: Record<string, IncomeExpenseActionContext>) {
  const onCancel = vi.fn(), onResubmitReview = vi.fn();
  const view = render(<QueryClientProvider client={new QueryClient()}><IncomeExpenseList vouchers={[voucher]} isLoading={false}
    onView={() => {}} onCancel={onCancel} onApprove={() => {}} onQuickEdit={() => {}} onResubmitReview={onResubmitReview}
    actionContexts={actionContexts} pagination={{ page: 1, pageSize: 20, offset: 0, setPage: () => {}, setPageSize: () => {},
      nextPage: () => {}, prevPage: () => {}, goToFirstPage: () => {}, goToLastPage: () => {}, reset: () => {} }} totalCount={1} /></QueryClientProvider>);
  return { ...view, onCancel, onResubmitReview };
}
afterEach(cleanup);
describe('IncomeExpenseList shared action decisions', () => {
  it('keeps unknown actions visible and disabled instead of optimistic legacy/cancel writes', () => {
    const { onCancel } = fixture();
    const cancel = screen.getByRole('button', { name: 'Huỷ phiếu' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true); expect(cancel.title).toContain('Đang tải'); fireEvent.click(cancel); expect(onCancel).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Chuyển chờ duyệt' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('uses the same loaded context for source denial and the existing-voucher review command', () => {
    const c = pendingIncomeExpenseActionContext({ resubmitReview: true, cancel: true, supplement: true });
    c.voucher = { state: 'ready', value: { id: 'v', organizationId: 'org', buildingId: 'b', type: 'EXPENSE', userId: 'actor', makerUserId: null,
      approvalStatus: 'UNAPPROVED', postingStatus: 'UNPOSTED', postingMode: 'CASHBOOK', reviewState: 'CHANGES_REQUESTED',
      activePostingId: null, accountId: null, approvalVersion: 3, postingVersion: 4, reviewVersion: 5 } };
    c.actor = { state: 'ready', value: { id: 'actor', organizationId: 'org', isAdmin: false } };
    c.permissions = { state: 'ready', value: { approve: false, edit: true, cancel: true, reverse: false } };
    c.routes = { state: 'ready', value: { workflow: 'CANONICAL', posting: 'CANONICAL', readSemantics: 'CANONICAL', access: 'CANONICAL', accountingStandardStrict: true } };
    c.source = {state:'ready',value:{moneyActionsAllowed:true,refundReverseAllowed:false}};
    c.ownership = { state: 'ready', value: { flowKind: null, sourceReviewSupported: true, moneyEditAllowed: false } };
    c.cancellation = { state: 'ready', value: { canCancel: false, reason: 'Nguồn đã khóa', useIncomeDoor: false, useFlexWriter: false, mode: null } };
    const { onResubmitReview } = fixture({ v: c });
    const submit = screen.getByRole('button', { name: 'Chuyển chờ duyệt' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false); fireEvent.click(submit); expect(onResubmitReview).toHaveBeenCalledExactlyOnceWith(voucher);
    expect((screen.getByRole('button', { name: 'Huỷ phiếu' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
