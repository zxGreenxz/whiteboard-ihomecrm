// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomeExpenseWithRelations } from '../types';
import type { FinanceV2OrgRoutes } from '@/lib/financeV2Route';

const state = vi.hoisted(() => ({
  org: '11111111-1111-4111-8111-111111111111',
  permissions: { __superadmin: true } as unknown,
  read: vi.fn(), adopt: vi.fn(), write: vi.fn(), list: vi.fn(), books: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: state.org }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'actor' } }) }));
vi.mock('@/hooks/useMyPermissions', () => ({
  useMyPermissions: () => ({ data: state.permissions, isSuccess: true, isFetching: false }),
  fetchMyPermissions: async () => state.permissions,
}));
const routes: FinanceV2OrgRoutes = { workflow: 'CANONICAL', posting: 'CANONICAL', readSemantics: 'CANONICAL', access: 'CANONICAL', accountingStandardStrict: true };
vi.mock('@/lib/financeV2Route', async original => ({
  ...await original<typeof import('@/lib/financeV2Route')>(),
  useFinanceV2Routes: () => ({ getOrg: () => routes, isSuccess: true, isFetching: false }),
  fetchFinanceV2ClientFlags: async () => new Map([[state.org, routes]]),
}));
const book = '22222222-2222-4222-8222-222222222222';
vi.mock('../financeV2Mutations', () => ({
  useCustodianCashbooksV2: () => ({ data: [{ id: book }], isSuccess: true, isFetching: false, refetch: state.books }),
  useApproveAndPostIncomeExpenseV2: () => ({ mutateAsync: state.write }),
  useInvalidateMoney: () => vi.fn(),
  adoptVoucherAttachmentsAsEvidence: state.adopt,
}));
vi.mock('../detailRead', () => ({ loadIncomeExpenseDetail: state.read, withDetailReadDeadline: (p: Promise<unknown>) => p }));
vi.mock('../queries', () => ({ incomeExpensesListQuery: (...args: unknown[]) => ({ queryFn: () => state.list(...args) }) }));

import { useQuickExpense } from '../useQuickExpense';
import { quickExpenseReason, sameQuickExpenseSnapshot, type QuickExpenseContext } from '@/lib/quickExpense';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';

function voucher(i = 1, patch: Partial<IncomeExpenseWithRelations> = {}): IncomeExpenseWithRelations {
  return { id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`, code: `PC-${i}`, name: `Chi ${i}`,
    organization_id: state.org, type: 'EXPENSE', building_id: null, total_amount: 100,
    approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', posting_mode: 'CASHBOOK', review_state: 'PENDING',
    approval_version: 1, posting_version: 1, updated_at: '2026-10-19T00:00:00Z',
    account_id: book, account_is_virtual: false, attachments: ['https://storage.test/receipt.jpg'],
    detail_read: { complete: true, expected_item_count: 0 }, items: [], system_source: null,
    ...patch } as IncomeExpenseWithRelations;
}
function context(): QuickExpenseContext {
  return { organizationId: state.org, permissions: { income_expenses: { approve: true } }, routes, cashbookIds: new Set([book]), ready: true };
}
beforeEach(() => {
  vi.clearAllMocks(); state.org = '11111111-1111-4111-8111-111111111111'; state.permissions = { __superadmin: true };
  state.read.mockImplementation(async (id: string) => voucher(Number(id.slice(-12))));
  state.adopt.mockResolvedValue({ evidenceIds: ['evidence-1'], skipped: [] });
  state.write.mockResolvedValue({}); state.books.mockResolvedValue({ data: [{ id: book }], error: null });
});
afterEach(cleanup);

describe('điều kiện chọn chi nhanh', () => {
  it('cho chọn phiếu có đủ quyền, đúng công ty, sổ thật và chứng từ', () => expect(quickExpenseReason(voucher(), context())).toBeNull());
  it.each([
    { type: 'INCOME' }, { approval_status: 'APPROVED' }, { approval_status: 'CANCELLED' },
    { posting_status: 'POSTED' }, { posting_status: 'REVERSED' }, { posting_status: null },
    { posting_mode: 'NON_CASH' }, { review_state: 'DISPUTED' }, { account_id: null },
    { account_is_virtual: true }, { account_is_virtual: null }, { attachments: [] },
    { system_source: 'reservation.refund' }, { total_amount: 0 }, { organization_id: 'other' },
    { detail_read: { complete: false, expected_item_count: 0 } },
  ] as Partial<IncomeExpenseWithRelations>[] )('chặn phiếu không đủ điều kiện %j', patch => expect(quickExpenseReason(voucher(1, patch), context())).toBeTruthy());
  it('kiểm quyền theo đúng tòa nhà và đúng sổ', () => {
    const ctx = context(); ctx.permissions = { income_expenses: { approve: { org_wide: false, building_ids: ['building-a'] } } };
    expect(quickExpenseReason(voucher(1, { building_id: 'building-b' }), ctx)).toMatch(/quyền duyệt/);
    expect(quickExpenseReason(voucher(1, { building_id: null }), ctx)).toMatch(/quyền duyệt/);
    ctx.permissions = { income_expenses: { approve: true } }; ctx.cashbookIds = new Set(['other']);
    expect(quickExpenseReason(voucher(), ctx)).toMatch(/quyền chi/);
  });
  it('không cho ghi khi route bị đóng hoặc chưa đọc đủ quyền', () => {
    expect(quickExpenseReason(voucher(), { ...context(), ready: false })).toBeTruthy();
    expect(quickExpenseReason(voucher(), { ...context(), routes: { ...routes, posting: 'FROZEN' } })).toBeTruthy();
  });
  it('phát hiện sửa sổ, số tiền và chứng từ dù phiên bản không đổi', () => {
    for (const patch of [{ account_id: 'other' }, { total_amount: 101 }, { attachments: ['new'] }]) {
      expect(sameQuickExpenseSnapshot(voucher(), voucher(1, patch))).toBe(false);
    }
  });
});

describe('thực thi và chọn hàng loạt', () => {
  it('gọi đúng writer một lần với sổ, ảnh và phiên bản đã chọn; không truyền số tiền sửa tay', async () => {
    const { result } = renderHook(() => useQuickExpense('filter'));
    await act(async () => { await Promise.all([result.current.run([voucher()]), result.current.run([voucher()])]); });
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(state.write).toHaveBeenCalledWith(expect.objectContaining({ subjectId: voucher().id, cashbookId: book, evidenceIds: ['evidence-1'], expectedApprovalVersion: 1, expectedPostingVersion: 1 }));
    expect(state.write.mock.calls[0][0]).not.toHaveProperty('amount');
    expect(result.current.results[0].status).toBe('success');
  });
  it('không ghi khi chứng từ bị bỏ qua hoặc ảnh không hợp lệ', async () => {
    state.adopt.mockResolvedValue({ evidenceIds: ['e1'], skipped: [{ url: 'bad', reason: 'invalid' }] });
    const { result } = renderHook(() => useQuickExpense('filter'));
    await act(() => result.current.run([voucher()]));
    expect(state.write).not.toHaveBeenCalled(); expect(result.current.results[0].status).toBe('skipped');
  });
  it('không duyệt dữ liệu bị sửa sau khi chọn hoặc sau khi nhận chứng từ', async () => {
    state.read.mockResolvedValueOnce(voucher()).mockResolvedValueOnce(voucher(1, { attachments: ['changed'] }));
    const { result } = renderHook(() => useQuickExpense('filter'));
    await act(() => result.current.run([voucher()]));
    expect(state.write).not.toHaveBeenCalled(); expect(result.current.results[0].message).toMatch(/thay đổi/);
  });
  it('bỏ qua phiếu không hợp lệ, vẫn xử lý phiếu hợp lệ và xóa lựa chọn đã xong', async () => {
    state.read.mockImplementation(async (id: string) => voucher(Number(id.slice(-12)), id === voucher().id ? { approval_version: 2 } : {}));
    const { result } = renderHook(() => useQuickExpense('filter'));
    act(() => result.current.togglePage([voucher(), voucher(2)], true));
    await act(() => result.current.run(result.current.selected));
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(result.current.results.map(r => r.status)).toEqual(['skipped', 'success']); expect(result.current.selected).toEqual([]);
  });
  it('dừng đợt chi khi kết quả không rõ; khóa phiếu đó và không gửi những phiếu còn lại', async () => {
    state.write.mockRejectedValue(new FinancialWorkflowError('Mất kết nối', 'unknown', []));
    const { result } = renderHook(() => useQuickExpense('filter'));
    await act(() => result.current.run([voucher(), voucher(2)]));
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(result.current.results.map(r => r.status)).toEqual(['unknown', 'skipped']);
    expect(result.current.reason(voucher())).toMatch(/đối chiếu/);
    await act(() => result.current.run([voucher()])); expect(state.write).toHaveBeenCalledTimes(1);
  });
  it('chọn cả các trang sau, loại phiếu không hợp lệ và gửi đúng bộ lọc/công ty', async () => {
    state.list.mockImplementation(async (_f, { page }) => ({ data: page === 1 ? [voucher(), voucher(2, { attachments: [] })] : [voucher(3)], totalCount: 3 }));
    const { result } = renderHook(() => useQuickExpense('filter'));
    const filters = { building_ids: ['building-a'], layer: 'PENDING' as const };
    await act(() => result.current.selectAll(filters, 'search'));
    expect(result.current.selected.map(v => v.id)).toEqual([voucher().id, voucher(3).id]);
    expect(state.list).toHaveBeenLastCalledWith(filters, { page: 2, pageSize: 100 }, 'search', state.org);
  });
  it('không báo chọn tất cả nếu tải lỗi giữa chừng', async () => {
    state.list.mockResolvedValueOnce({ data: [voucher()], totalCount: 2 }).mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useQuickExpense('filter'));
    await act(() => result.current.selectAll({}));
    expect(result.current.selected).toEqual([]); expect(result.current.error).toBeTruthy();
  });
  it('bỏ lựa chọn khi đổi bộ lọc và không khôi phục ngầm khi quay lại', () => {
    const { result, rerender } = renderHook(({ filter }) => useQuickExpense(filter), { initialProps: { filter: 'a' } });
    act(() => result.current.toggle(voucher(), true)); expect(result.current.selected).toHaveLength(1);
    rerender({ filter: 'b' }); rerender({ filter: 'a' }); expect(result.current.selected).toEqual([]);
  });
  it('đổi công ty trong lúc đọc phiếu thì không gửi lệnh chi', async () => {
    let resolve!: (v: IncomeExpenseWithRelations) => void;
    state.read.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const { result, rerender } = renderHook(() => useQuickExpense('a'));
    const target = voucher(); let running!: Promise<void>;
    await act(async () => { running = result.current.run([target]); });
    state.org = '44444444-4444-4444-8444-444444444444'; rerender();
    await act(async () => { resolve(target); await running; });
    expect(state.write).not.toHaveBeenCalled();
  });
});
