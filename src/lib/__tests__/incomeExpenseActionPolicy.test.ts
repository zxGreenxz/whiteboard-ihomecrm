import { describe, expect, it } from 'vitest';
import { decideIncomeExpenseActions, type IncomeExpenseActionContext } from '../incomeExpenseActionPolicy';

const ready = <T,>(value: T) => ({ state: 'ready' as const, value });
const context = (): IncomeExpenseActionContext => ({
  voucher: ready({ id: 'v', organizationId: 'org', buildingId: 'b', type: 'EXPENSE', userId: 'maker', makerUserId: 'maker',
    approvalStatus: 'UNAPPROVED', postingStatus: 'UNPOSTED', postingMode: 'CASHBOOK', reviewState: 'PENDING',
    activePostingId: null, accountId: null, approvalVersion: 3, postingVersion: 4, reviewVersion: 5 }),
  actor: ready({ id: 'maker', organizationId: 'org', isAdmin: false }),
  permissions: ready({ approve: true, edit: true, cancel: true, reverse: true }),
  routes: ready({ readSemantics: 'CANONICAL', workflow: 'CANONICAL', posting: 'CANONICAL', access: 'CANONICAL', accountingStandardStrict: false }),
  ownership: ready({ flowKind: null, sourceReviewSupported: true, moneyEditAllowed: true }),
  custody: ready({ hasUsableCashbook: true, holdsVoucherCashbook: true }),
  cancellation: ready({ canCancel: true, reason: null, useIncomeDoor: false, useFlexWriter: true, mode: null }),
  handlers: { approveOnly: true, legacyApprove: true, approveAndPost: true, post: true, reverse: true, unapprove: true,
    cancel: true, edit: true, supplement: true, requestChanges: true, resubmitReview: true },
});
function voucher(c: IncomeExpenseActionContext) { if (c.voucher.state !== 'ready') throw new Error('fixture'); return c.voucher.value; }

describe('shared income expense action policy', () => {
  it('separates canonical approval from legacy and post-only commands', () => {
    const a = decideIncomeExpenseActions(context());
    expect(a.approveOnly.enabled).toBe(true); expect(a.approveAndPost.enabled).toBe(true);
    expect(a.legacyApprove.visible).toBe(false); expect(a.post.visible).toBe(false);
    expect(a.requestChanges.enabled).toBe(true); expect(a.resubmitReview.visible).toBe(false);
  });
  it('legacy approval keeps its own cash-changing semantics', () => {
    const c = context(); c.routes = ready({ ...(c.routes as { state: 'ready'; value: import('../financeV2Route').FinanceV2OrgRoutes }).value, workflow: 'LEGACY', posting: 'LEGACY', readSemantics: 'LEGACY' });
    const a = decideIncomeExpenseActions(c);
    expect(a.legacyApprove.enabled).toBe(true); expect(a.approveOnly.enabled).toBe(false);
    expect(a.approveAndPost.enabled).toBe(false); expect(a.requestChanges.enabled).toBe(false);
    voucher(c).approvalVersion = null; expect(decideIncomeExpenseActions(c).legacyApprove.enabled).toBe(false);
  });
  it.each(['loading', 'error'] as const)('does not interpret %s route as legacy authorization', state => {
    const c = context(); c.routes = state === 'loading' ? { state } : { state, reason: 'network' };
    const a = decideIncomeExpenseActions(c);
    expect(a.approveOnly.visible).toBe(true); expect(a.approveOnly.enabled).toBe(false);
    expect(a.legacyApprove.enabled).toBe(false); expect(a.approveOnly.reason).toBeTruthy();
  });
  it('frozen is never a fallback to legacy', () => {
    const c = context(); c.routes = ready({ ...(context().routes as { state: 'ready'; value: import('../financeV2Route').FinanceV2OrgRoutes }).value, workflow: 'FROZEN', posting: 'FROZEN' });
    const a = decideIncomeExpenseActions(c);
    expect(a.legacyApprove.enabled).toBe(false); expect(a.approveOnly.enabled).toBe(false); expect(a.approveAndPost.enabled).toBe(false);
  });
  it('custodian can post approved/reversed vouchers without approve permission', () => {
    const c = context(); c.permissions = ready({ approve: false, edit: false, cancel: false, reverse: false });
    Object.assign(voucher(c), { approvalStatus: 'APPROVED', reviewState: 'RESOLVED', postingStatus: 'REVERSED' });
    expect(decideIncomeExpenseActions(c).post.enabled).toBe(true);
    c.custody = ready({ hasUsableCashbook: false, holdsVoucherCashbook: false });
    expect(decideIncomeExpenseActions(c).post.enabled).toBe(false);
  });
  it('unknown custody is visible with a loading reason, not false custody', () => {
    const c = context(); Object.assign(voucher(c), { approvalStatus: 'APPROVED', reviewState: 'RESOLVED' }); c.custody = { state: 'loading' };
    const a = decideIncomeExpenseActions(c).post;
    expect(a.visible).toBe(true); expect(a.enabled).toBe(false); expect(a.loading).toBe(true);
  });
  it('does not offer cash for noncash or inconsistent active posting', () => {
    const c = context(); voucher(c).postingMode = 'NON_CASH'; expect(decideIncomeExpenseActions(c).approveAndPost.enabled).toBe(false);
    Object.assign(voucher(c), { approvalStatus: 'APPROVED', postingStatus: 'NOT_APPLICABLE' }); expect(decideIncomeExpenseActions(c).post.visible).toBe(false);
    Object.assign(voucher(c), { postingMode: 'CASHBOOK', postingStatus: 'UNPOSTED', activePostingId: 'posting' });
    expect(decideIncomeExpenseActions(c).post.enabled).toBe(false);
  });
  it('reverse requires the current voucher cashbook; unapprove still requires admin', () => {
    const c = context(); Object.assign(voucher(c), { approvalStatus: 'APPROVED', reviewState: 'RESOLVED', postingStatus: 'POSTED', activePostingId: 'p', accountId: 'book' });
    expect(decideIncomeExpenseActions(c).reverse.enabled).toBe(true); expect(decideIncomeExpenseActions(c).unapprove.enabled).toBe(false);
    c.custody = ready({ hasUsableCashbook: true, holdsVoucherCashbook: false }); expect(decideIncomeExpenseActions(c).reverse.enabled).toBe(false);
  });
  it('custody does not replace scoped reverse permission', () => {
    const c = context(); Object.assign(voucher(c), { approvalStatus: 'APPROVED', postingStatus: 'POSTED', activePostingId: 'p', accountId: 'book' });
    c.permissions = ready({ approve: true, edit: true, cancel: true, reverse: false });
    expect(decideIncomeExpenseActions(c).reverse).toMatchObject({ visible: true, enabled: false, loading: false, reasonCode: 'PERMISSION' });
    expect(decideIncomeExpenseActions(c).reverse.reason).toContain('hoàn tác');
  });
  it.each(['loading', 'error'] as const)('reverse waits for %s permission readiness even with custody', state => {
    const c = context(); Object.assign(voucher(c), { approvalStatus: 'APPROVED', postingStatus: 'POSTED', activePostingId: 'p', accountId: 'book' });
    c.permissions = state === 'loading' ? { state } : { state, reason: 'Không tải được quyền hoàn tác' };
    expect(decideIncomeExpenseActions(c).reverse).toMatchObject({ visible: true, enabled: false, loading: state === 'loading', reasonCode: state === 'loading' ? 'LOADING' : 'READ_ERROR' });
    expect(decideIncomeExpenseActions(c).reverse.reason).toBeTruthy();
  });
  it.each(['INVOICE_REFUND', 'TERMINATION_REFUND'])('does not reverse posted %s through a canonical-only writer', flowKind => {
    const c = context(); Object.assign(voucher(c), { approvalStatus: 'APPROVED', postingStatus: 'POSTED', activePostingId: 'p', accountId: 'book' });
    c.ownership = ready({ flowKind, sourceReviewSupported: false, moneyEditAllowed: false });
    expect(decideIncomeExpenseActions(c).reverse).toMatchObject({ visible: true, enabled: false, reasonCode: 'SOURCE_WRITER_UNSUPPORTED' });
  });
  it.each([null, 'CANONICAL_INCOME_EXPENSE'])('keeps reverse for supported owner %s with scoped reverse permission', flowKind => {
    const c = context(); Object.assign(voucher(c), { approvalStatus: 'APPROVED', postingStatus: 'POSTED', activePostingId: 'p', accountId: 'book' });
    c.ownership = ready({ flowKind, sourceReviewSupported: true, moneyEditAllowed: false });
    c.permissions = ready({ approve: false, edit: false, cancel: false, reverse: true });
    expect(decideIncomeExpenseActions(c).reverse.enabled).toBe(true);
  });
  it('approve-and-post requires UNPOSTED while post-only can use REVERSED', () => {
    const c = context(); voucher(c).postingStatus = 'REVERSED';
    expect(decideIncomeExpenseActions(c).approveAndPost).toMatchObject({ visible: true, enabled: false, reasonCode: 'POSTING_STATE' });
    Object.assign(voucher(c), { approvalStatus: 'APPROVED', reviewState: 'RESOLVED' });
    expect(decideIncomeExpenseActions(c).post.enabled).toBe(true);
  });
  it.each(['loading', 'error'] as const)('post-only remains custody-based when approval/reverse permissions are %s', state => {
    const c = context(); Object.assign(voucher(c), { approvalStatus: 'APPROVED', reviewState: 'RESOLVED', postingStatus: 'REVERSED' });
    c.permissions = state === 'loading' ? { state } : { state, reason: 'Không tải được quyền duyệt' };
    expect(decideIncomeExpenseActions(c).post.enabled).toBe(true);
  });
  it('keeps server cancel denial and writer selection; missing eligibility disables', () => {
    const c = context(); c.cancellation = ready({ canCancel: false, reason: 'Sổ đã khoá', useIncomeDoor: false, useFlexWriter: false, mode: null });
    expect(decideIncomeExpenseActions(c).cancel).toMatchObject({ enabled: false, reason: 'Sổ đã khoá' });
    c.cancellation = { state: 'loading' }; expect(decideIncomeExpenseActions(c).cancel.enabled).toBe(false);
    c.cancellation = ready({ canCancel: true, reason: null, useIncomeDoor: true, useFlexWriter: false, mode: 'MANUAL' }); voucher(c).type = 'INCOME';
    expect(decideIncomeExpenseActions(c).cancel.writer).toBe('income');
  });
  it('supplement is independent of cancelled status and requires existing annotate rights', () => {
    const c = context(); voucher(c).approvalStatus = 'CANCELLED'; expect(decideIncomeExpenseActions(c).supplement.enabled).toBe(true);
    c.actor = ready({ id: 'outsider', organizationId: 'org', isAdmin: false }); c.permissions = ready({ approve: false, edit: false, cancel: false, reverse: false });
    expect(decideIncomeExpenseActions(c).supplement.enabled).toBe(false);
  });
  it('does not infer bank edit from lack of system ownership', () => {
    const c = context(); c.ownership = ready({ flowKind: 'CANONICAL_INCOME_EXPENSE', sourceReviewSupported: true, moneyEditAllowed: false });
    expect(decideIncomeExpenseActions(c).edit.enabled).toBe(false);
    c.ownership = { state: 'loading' }; expect(decideIncomeExpenseActions(c).edit.loading).toBe(true);
  });
  it('returns the existing changes-requested voucher only for original maker or an editor when maker is NULL', () => {
    const c = context(); voucher(c).reviewState = 'CHANGES_REQUESTED';
    expect(decideIncomeExpenseActions(c).resubmitReview.enabled).toBe(true);
    c.actor = ready({ id: 'editor', organizationId: 'org', isAdmin: false });
    expect(decideIncomeExpenseActions(c).resubmitReview.enabled).toBe(false);
    voucher(c).makerUserId = null; expect(decideIncomeExpenseActions(c).resubmitReview.enabled).toBe(true);
    c.permissions = ready({ approve: true, edit: false, cancel: false, reverse: false }); expect(decideIncomeExpenseActions(c).resubmitReview.enabled).toBe(false);
  });
  it.each(['INVOICE_REFUND', 'TERMINATION_REFUND', 'ANOTHER_DOMAIN'])('blocks unsupported owned review %s with a reason, not a kind-specific bypass', flowKind => {
    const c = context(); voucher(c).reviewState = 'CHANGES_REQUESTED'; c.ownership = ready({ flowKind, sourceReviewSupported: true, moneyEditAllowed: false });
    expect(decideIncomeExpenseActions(c).resubmitReview).toMatchObject({ visible: true, enabled: false, reasonCode: 'SOURCE_REVIEW_UNSUPPORTED' });
  });
  it('unowned reservation review is still blocked by its source guard', () => {
    const c = context(); c.ownership = ready({ flowKind: null, sourceReviewSupported: false, moneyEditAllowed: false });
    expect(decideIncomeExpenseActions(c).requestChanges.enabled).toBe(false);
  });
  it('missing CAS/scope data never becomes version 1 or authorizes another organization', () => {
    const c = context(); voucher(c).reviewVersion = null; expect(decideIncomeExpenseActions(c).requestChanges.enabled).toBe(false);
    voucher(c).approvalVersion = null; expect(decideIncomeExpenseActions(c).approveOnly.enabled).toBe(false);
    c.actor = ready({ id: 'maker', organizationId: 'other-org', isAdmin: true });
    expect(Object.values(decideIncomeExpenseActions(c)).some(a => a.enabled)).toBe(false);
  });
  it('does not enable approve-only on a pending voucher carrying a posting', () => {
    const c = context(); voucher(c).activePostingId = 'p';
    expect(decideIncomeExpenseActions(c).approveOnly.enabled).toBe(false);
    voucher(c).activePostingId = null; voucher(c).postingStatus = 'POSTED';
    expect(decideIncomeExpenseActions(c).approveOnly.enabled).toBe(false);
  });
  it('unapprove requires a loaded approval version even for admin', () => {
    const c = context(); c.actor = ready({ id: 'maker', organizationId: 'org', isAdmin: true });
    Object.assign(voucher(c), { approvalStatus: 'APPROVED', reviewState: 'RESOLVED', approvalVersion: null });
    expect(decideIncomeExpenseActions(c).unapprove.enabled).toBe(false);
    voucher(c).approvalVersion = 5; expect(decideIncomeExpenseActions(c).unapprove.enabled).toBe(true);
  });
  it('noncash review and approval remain available without making cash available', () => {
    const c = context(); Object.assign(voucher(c), { postingMode: 'NON_CASH', postingStatus: 'NOT_APPLICABLE' });
    expect(decideIncomeExpenseActions(c).requestChanges.enabled).toBe(true);
    expect(decideIncomeExpenseActions(c).approveOnly.enabled).toBe(true);
    expect(decideIncomeExpenseActions(c).approveAndPost.enabled).toBe(false);
  });
  it.each(['INVOICE_REFUND', 'TERMINATION_REFUND'])('keeps %s approve-only dispatcher and blocks cash writers without owner support', flowKind => {
    const c = context(); c.ownership = ready({ flowKind, sourceReviewSupported: false, moneyEditAllowed: false });
    expect(decideIncomeExpenseActions(c).approveOnly).toMatchObject({ enabled: true, writer: 'owned' });
    expect(decideIncomeExpenseActions(c).approveAndPost.enabled).toBe(false);
    voucher(c).approvalStatus = 'APPROVED'; expect(decideIncomeExpenseActions(c).post.enabled).toBe(false);
  });
});
