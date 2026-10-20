// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomeExpenseBatchSummary, IncomeExpenseWithRelations } from '../types';
import type { FinanceV2OrgRoutes } from '@/lib/financeV2Route';

const state = vi.hoisted(() => ({
  org: '11111111-1111-4111-8111-111111111111',
  actor: 'actor',
  permissions: { __superadmin: true } as unknown,
  read: vi.fn(), adopt: vi.fn(), write: vi.fn(), list: vi.fn(), books: vi.fn(),
  batchRead: vi.fn(), membershipRead: vi.fn(), snapshotRead: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: state.org }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: state.actor } }) }));
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
  createQuickExpenseBatchEvidenceSession: () => (row: IncomeExpenseWithRelations) => state.adopt(row.id),
}));
vi.mock('@/lib/incomeExpenseDetailRpc', () => ({ loadIncomeExpenseDetails: state.snapshotRead }));
vi.mock('../detailRead', () => ({ loadIncomeExpenseDetail: state.read, withDetailReadDeadline: (p: Promise<unknown>) => p }));
vi.mock('../queries', () => ({ incomeExpensesListQuery: (...args: unknown[]) => ({ queryFn: () => state.list(...args) }) }));
vi.mock('@/hooks/useVoucherDetail', () => ({
  loadIncomeExpenseBatch: state.batchRead,
  readIncomeExpenseBatchMembership: state.membershipRead,
}));

import { useQuickExpense } from '../useQuickExpense';
import { quickExpenseBatchReason, quickExpenseBatchTargets, quickExpenseReason, sameQuickExpenseBatchSnapshot, sameQuickExpenseSnapshot, type QuickExpenseContext } from '@/lib/quickExpense';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';

function voucher(i = 1, patch: Partial<IncomeExpenseWithRelations> = {}): IncomeExpenseWithRelations {
  return { id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`, code: `PC-${i}`, name: `Chi ${i}`,
    organization_id: state.org, type: 'EXPENSE', building_id: null, total_amount: 100,
    approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', posting_mode: 'CASHBOOK', review_state: 'PENDING',
    approval_version: 1, posting_version: 1, updated_at: '2026-10-19T00:00:00Z',
    account_id: book, account_is_virtual: false, attachments: ['https://storage.test/shared-receipt.jpg'],
    detail_read: { complete: true, expected_item_count: 0 }, items: [], system_source: null,
    ...patch } as IncomeExpenseWithRelations;
}
function context(): QuickExpenseContext {
  return { organizationId: state.org, permissions: { income_expenses: { approve: true } }, routes, cashbookIds: new Set([book]), ready: true };
}
function batch(rows = [voucher(), voucher(2)], patch: Partial<IncomeExpenseBatchSummary> = {}): IncomeExpenseBatchSummary {
  return {
    id: '55555555-5555-4555-8555-555555555555', organization_id: state.org,
    name: 'Đợt chi tháng 10', type: 'EXPENSE', user_id: 'actor', payer_name: null,
    attachments: ['https://storage.test/receipt.jpg'], notes: null, created_at: '2026-10-19T00:00:00Z',
    voucher_date: '2026-10-19', account_id: book, account_name: 'Quỹ tiền mặt',
    business_result_accounting: null, creator_name: null, vouchers: rows,
    voucher_ids: rows.map(row => row.id), voucher_count: rows.length,
    total_amount: rows.reduce((sum, row) => sum + row.total_amount, 0), building_names: [],
    has_approved: rows.some(row => row.approval_status === 'APPROVED'),
    all_cancelled: rows.every(row => row.approval_status === 'CANCELLED'), ...patch,
  };
}
function membership(target = batch()) {
  return { id: target.id, organization_id: target.organization_id, type: target.type, voucher_ids: target.voucher_ids };
}
function setBatchReads(target: IncomeExpenseBatchSummary) {
  state.batchRead.mockResolvedValue(target);
  state.membershipRead.mockResolvedValue(membership(target));
  state.read.mockImplementation(async (id: string) => target.vouchers.find(row => row.id === id) ?? null);
  state.snapshotRead.mockImplementation(async (_org: string, ids: string[]) => target.vouchers.filter(row => ids.includes(row.id)));
}
beforeEach(() => {
  vi.resetAllMocks(); state.org = '11111111-1111-4111-8111-111111111111'; state.permissions = { __superadmin: true };
  state.actor = 'actor';
  state.read.mockImplementation(async (id: string) => voucher(Number(id.slice(-12))));
  state.snapshotRead.mockImplementation(async (_org: string, ids: string[]) => ids.map(id => voucher(Number(id.slice(-12)))));
  state.adopt.mockResolvedValue({ evidenceIds: ['evidence-1'], skipped: [] });
  state.write.mockResolvedValue({}); state.books.mockResolvedValue({ data: [{ id: book }], error: null });
  state.batchRead.mockResolvedValue(batch()); state.membershipRead.mockResolvedValue(membership());
});

describe('điều kiện chi nhanh phiếu tổng', () => {
  it('chỉ chọn con còn chờ duyệt; bỏ qua con đã chi và đã hủy', () => {
    const target = batch([voucher(), voucher(2, { approval_status: 'APPROVED', posting_status: 'POSTED', review_state: 'RESOLVED' }),
      voucher(3, { approval_status: 'CANCELLED' })]);
    expect(quickExpenseBatchTargets(target).map(row => row.id)).toEqual([voucher().id]);
    expect(quickExpenseBatchReason(target, context())).toBeNull();
  });
  it.each([
    () => batch([voucher()], { voucher_ids: [voucher().id, voucher(2).id] }),
    () => batch([voucher(), voucher(2)], { voucher_ids: [voucher().id] }),
    () => batch([voucher(), voucher(2)], { voucher_ids: [voucher().id, voucher().id] }),
    () => batch([voucher(), voucher()], { voucher_ids: [voucher().id, voucher(2).id] }),
    () => batch([voucher()], { voucher_ids: undefined }),
    () => batch([voucher()], { voucher_count: 2 }),
    () => batch([voucher()], { organization_id: undefined }),
    () => batch([voucher()], { organization_id: 'other-org' }),
    () => batch([voucher(1, { organization_id: 'other-org' })]),
    () => batch([voucher(1, { type: 'INCOME' })]),
  ])('khóa phiếu tổng nếu thiếu toàn bộ tập con hoặc sai tổ chức/loại #%#', create => {
    expect(quickExpenseBatchReason(create(), context())).toBeTruthy();
  });
  it.each([
    { approval_status: 'APPROVED', posting_status: 'UNPOSTED', review_state: 'RESOLVED' },
    { attachments: [] },
    { account_id: null },
    { posting_status: 'REVERSED' },
  ] as Partial<IncomeExpenseWithRelations>[])('một con chưa xong không hợp lệ thì khóa cả đợt %j', patch => {
    expect(quickExpenseBatchReason(batch([voucher(), voucher(2, patch)]), context())).toBeTruthy();
  });
  it('không cho chạy lại đợt đã hoàn tất hoặc không có con', () => {
    expect(quickExpenseBatchReason(batch([voucher(1, { approval_status: 'APPROVED', posting_status: 'POSTED' })]), context())).toBeTruthy();
    expect(quickExpenseBatchReason(batch([]), context())).toBeTruthy();
  });
  it('snapshot chặn thêm, bớt, sửa con và sửa ảnh tổng nhưng không phụ thuộc thứ tự con', () => {
    const initial = batch();
    expect(sameQuickExpenseBatchSnapshot(initial, batch([...initial.vouchers].reverse()))).toBe(true);
    for (const changed of [
      batch([voucher()]), batch([voucher(), voucher(2), voucher(3)]),
      batch([voucher(), voucher(2, { total_amount: 200 })]),
      batch([voucher(), voucher(2, { attachments: ['different'] })]),
      batch(initial.vouchers, { attachments: ['different'] }),
    ]) expect(sameQuickExpenseBatchSnapshot(initial, changed)).toBe(false);
  });
});

describe('thực thi chi nhanh phiếu tổng', () => {
  it('duyệt và chi tất cả con bằng sổ, ảnh và phiên bản riêng của từng con', async () => {
    const target = batch();
    state.adopt.mockImplementation(async (id: string) => ({ evidenceIds: [`evidence-${id}`], skipped: [] }));
    const { result } = renderHook(() => useQuickExpense('batch-view'));
    await act(() => result.current.runBatch(target));
    expect(state.batchRead).toHaveBeenCalledWith(target.id, state.org);
    expect(state.write).toHaveBeenCalledTimes(2);
    expect(state.write.mock.calls.map(call => call[0])).toEqual(target.vouchers.map(row => expect.objectContaining({
      subjectId: row.id, organizationId: row.organization_id, cashbookId: row.account_id,
      evidenceIds: [`evidence-${row.id}`], expectedApprovalVersion: row.approval_version, expectedPostingVersion: row.posting_version,
    })));
    expect(result.current.results.map(row => row.status)).toEqual(['success', 'success']);
    expect(result.current.activeBatchId).toBeNull(); expect(result.current.busy).toBe(false);
  });
  it('danh sách bị lọc mất con không được âm thầm chi phần con đang thấy', async () => {
    const partial = batch([voucher()], { voucher_ids: [voucher().id, voucher(2).id] });
    const { result } = renderHook(() => useQuickExpense('batch-view'));
    await act(() => result.current.runBatch(partial));
    expect(state.write).not.toHaveBeenCalled(); expect(state.adopt).not.toHaveBeenCalled();
  });
  it.each([
    () => null,
    () => batch([voucher(), voucher(2, { total_amount: 200 })]),
    () => batch([voucher(), voucher(2, { attachments: ['changed'] })]),
    () => batch([voucher(), voucher(2), voucher(3)]),
    () => batch([voucher()]),
  ])('đọc mới thấy đợt bị xóa/thay đổi thì không ghi con nào #%#', async fresh => {
    state.batchRead.mockResolvedValue(fresh());
    const { result } = renderHook(() => useQuickExpense('batch-view'));
    await act(() => result.current.runBatch(batch()));
    expect(state.write).not.toHaveBeenCalled(); expect(state.adopt).not.toHaveBeenCalled();
    expect(result.current.error).toBeTruthy();
  });
  it.each([
    { approval_status: 'APPROVED', posting_status: 'UNPOSTED', review_state: 'RESOLVED' },
    { attachments: [] },
  ] as Partial<IncomeExpenseWithRelations>[])('kiểm toàn đợt trước lệnh đầu, không chi con đầu nếu con sau không hợp lệ %j', async patch => {
    const target = batch([voucher(), voucher(2, patch)]); setBatchReads(target);
    const { result } = renderHook(() => useQuickExpense('batch-view'));
    await act(() => result.current.runBatch(target));
    expect(state.write).not.toHaveBeenCalled(); expect(state.adopt).not.toHaveBeenCalled();
  });
  it('tiếp tục chỉ con còn chờ duyệt trong đợt có con đã chi hoặc hủy', async () => {
    const target = batch([voucher(), voucher(2, { approval_status: 'APPROVED', posting_status: 'POSTED', review_state: 'RESOLVED' }),
      voucher(3, { approval_status: 'CANCELLED' })]); setBatchReads(target);
    const { result } = renderHook(() => useQuickExpense('batch-view'));
    await act(() => result.current.runBatch(target));
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(state.write).toHaveBeenCalledWith(expect.objectContaining({ subjectId: voucher().id }));
    expect(result.current.results).toHaveLength(1);
  });
  it('tập con đổi trong lúc nhận chứng từ thì dừng cả đợt trước lệnh đầu', async () => {
    state.adopt.mockImplementation(async () => {
      state.membershipRead.mockResolvedValue(membership(batch([voucher(), voucher(2), voucher(3)])));
      return { evidenceIds: ['e1'], skipped: [] };
    });
    const { result } = renderHook(() => useQuickExpense('batch-view'));
    await act(() => result.current.runBatch(batch()));
    expect(state.write).not.toHaveBeenCalled();
    expect(result.current.results.every(row => row.status !== 'success')).toBe(true);
  });
  it('tập con đổi sau một lần chi thì giữ kết quả thành công và không gửi các con còn lại', async () => {
    const target = batch([voucher(), voucher(2), voucher(3)]); setBatchReads(target);
    state.write.mockImplementation(async () => {
      state.membershipRead.mockResolvedValue(membership(batch([voucher(), voucher(2)])));
      return {};
    });
    const { result } = renderHook(() => useQuickExpense('batch-view'));
    await act(() => result.current.runBatch(target));
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(result.current.results.map(row => row.status)).toEqual(['success', 'skipped', 'skipped']);
  });
  it('mất quyền đọc đợt trước lệnh chi thì dừng và không gửi các con còn lại', async () => {
    state.membershipRead.mockResolvedValue(null);
    const { result } = renderHook(() => useQuickExpense('batch-view'));
    await act(() => result.current.runBatch(batch()));
    expect(state.write).not.toHaveBeenCalled();
    expect(result.current.results.map(row => row.status)).toEqual(['skipped', 'skipped']);
  });
  it('khóa chung phiếu tổng và phiếu lẻ ngay khi bắt đầu đọc đợt', async () => {
    let finish!: (value: IncomeExpenseBatchSummary) => void;
    state.batchRead.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const target = batch();
    const { result } = renderHook(() => useQuickExpense('batch-view'));
    let running!: Promise<void>;
    await act(async () => { running = result.current.runBatch(target); });
    expect(result.current.activeBatchId).toBe(target.id);
    await act(async () => { await Promise.all([result.current.runBatch(target), result.current.run([voucher()])]); });
    expect(state.batchRead).toHaveBeenCalledTimes(1); expect(state.write).not.toHaveBeenCalled();
    await act(async () => { finish(target); await running; });
    expect(state.write).toHaveBeenCalledTimes(2);
  });
  it('đổi tab trong lúc đọc đợt vẫn hoàn tất các phiếu đã bắt đầu', async () => {
    let finish!: (value: IncomeExpenseBatchSummary) => void;
    state.batchRead.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const target = batch();
    const { result, rerender } = renderHook(({ filter }) => useQuickExpense(filter), { initialProps: { filter: 'a' } });
    let running!: Promise<void>;
    await act(async () => { running = result.current.runBatch(target); });
    rerender({ filter: 'b' });
    await act(async () => { finish(target); await running; });
    expect(state.write).toHaveBeenCalledTimes(2);
    expect(result.current.results.map(row => row.status)).toEqual(['success', 'success']);
  });
  it('đổi tab và bộ lọc giữa hai lần chi vẫn giữ tiến trình, khóa và tập phiếu ban đầu', async () => {
    let finish!: (value: unknown) => void;
    state.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const target = batch();
    const { result, rerender } = renderHook(({ filter }) => useQuickExpense(filter), { initialProps: { filter: 'batch' } });
    let running!: Promise<void>;
    await act(async () => { running = result.current.runBatch(target); });
    rerender({ filter: 'individual:other-filter' });
    expect(result.current.busy).toBe(true);
    expect(result.current.activeBatchId).toBe(target.id);
    await act(async () => { await result.current.run([voucher(3)]); });
    expect(state.write).toHaveBeenCalledTimes(1);
    await act(async () => { finish({}); await running; });
    expect(state.write.mock.calls.map(call => call[0].subjectId)).toEqual(target.voucher_ids);
    expect(result.current.progress).toEqual({ done: 2, total: 2 });
    expect(result.current.results.map(row => row.status)).toEqual(['success', 'success']);
  });
  it('lỗi ghi xác định dừng phiếu tổng chưa gửi, vẫn ghi nhận các lệnh đã gửi đồng thời', async () => {
    const target = batch([voucher(), voucher(2), voucher(3), voucher(4), voucher(5)]); setBatchReads(target);
    state.write.mockResolvedValueOnce({}).mockRejectedValueOnce(new FinancialWorkflowError('Kỳ sổ đã khóa', 'failure', []));
    const { result } = renderHook(() => useQuickExpense('batch-view'));
    await act(() => result.current.runBatch(target));
    expect(state.write).toHaveBeenCalledTimes(4);
    expect(result.current.results.map(row => row.status)).toEqual(['success', 'skipped', 'success', 'success', 'skipped']);
  });
  it('kết quả không rõ ở con thứ hai dừng phần còn lại và giữ phiếu đầu đã thành công', async () => {
    const target = batch([voucher(), voucher(2), voucher(3), voucher(4), voucher(5)]); setBatchReads(target);
    state.write.mockResolvedValueOnce({}).mockRejectedValueOnce(new FinancialWorkflowError('Mất kết nối', 'unknown', []));
    const { result } = renderHook(() => useQuickExpense('batch-view'));
    await act(() => result.current.runBatch(target));
    expect(state.write).toHaveBeenCalledTimes(4);
    expect(result.current.results.map(row => row.status)).toEqual(['success', 'unknown', 'success', 'success', 'skipped']);
    expect(result.current.reason(voucher(2))).toMatch(/đối chiếu/);
    expect(result.current.batchReason(target)).toBeTruthy();
  });
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
    state.snapshotRead.mockResolvedValueOnce([voucher(1, { attachments: ['changed'] })]);
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
  it('đổi tài khoản trong lúc đọc phiếu thì không gửi lệnh chi', async () => {
    let finish!: (v: IncomeExpenseWithRelations) => void;
    state.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result, rerender } = renderHook(() => useQuickExpense('a'));
    const target = voucher(); let running!: Promise<void>;
    await act(async () => { running = result.current.run([target]); });
    state.actor = 'other-actor'; rerender();
    await act(async () => { finish(target); await running; });
    expect(state.adopt).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
  });
  it('rời trang vẫn dừng phần chưa gửi và giữ lần chi đã hoàn tất', async () => {
    let finish!: (value: unknown) => void;
    state.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result, unmount } = renderHook(() => useQuickExpense('a'));
    let running!: Promise<void>;
    await act(async () => { running = result.current.runBatch(batch()); });
    unmount();
    await act(async () => { finish({}); await running; });
    expect(state.write).toHaveBeenCalledTimes(1);
  });
  it('đổi tab hủy kết quả chọn tất cả đang tải, không khôi phục lựa chọn cũ', async () => {
    let finish!: (value: unknown) => void;
    state.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useQuickExpense('page-owner'));
    let collecting!: Promise<void>;
    await act(async () => { collecting = result.current.selectAll({}); });
    act(() => result.current.resetSelection());
    await act(async () => { finish({ data: [voucher()], totalCount: 1 }); await collecting; });
    expect(result.current.selected).toEqual([]);
    expect(result.current.collecting).toBe(false);
  });
  it('đọc snapshot và membership song song, chỉ chi sau khi cả hai xác nhận', async () => {
    let finishSnapshot!: (value: IncomeExpenseWithRelations[]) => void;
    let finishMembership!: (value: ReturnType<typeof membership>) => void;
    const target = batch([voucher()]);
    setBatchReads(target);
    state.snapshotRead.mockImplementationOnce(() => new Promise(resolve => { finishSnapshot = resolve; }));
    state.membershipRead.mockImplementationOnce(() => new Promise(resolve => { finishMembership = resolve; }));
    const { result } = renderHook(() => useQuickExpense('batch'));
    let running!: Promise<void>;
    await act(async () => { running = result.current.runBatch(target); });
    expect(state.snapshotRead).toHaveBeenCalledWith(state.org, [voucher().id]);
    expect(state.membershipRead).toHaveBeenCalledTimes(1);
    expect(state.write).not.toHaveBeenCalled();
    await act(async () => { finishSnapshot([voucher()]); });
    expect(state.write).not.toHaveBeenCalled();
    await act(async () => { finishMembership(membership(target)); await running; });
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(state.read).toHaveBeenCalledTimes(1);
  });
  it('snapshot rỗng/lỗi sau khi nhận chứng từ vẫn dừng trước chi', async () => {
    state.snapshotRead.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useQuickExpense('batch'));
    await act(() => result.current.runBatch(batch()));
    expect(state.write).not.toHaveBeenCalled();
    expect(result.current.results.map(row => row.status)).toEqual(['skipped', 'skipped']);
  });
  it.each(['individual', 'batch'] as const)('%s chạy 3 phiếu độc lập cùng lúc và giữ thứ tự kết quả khi phản hồi đảo thứ tự', async mode => {
    const rows = Array.from({ length: 5 }, (_, index) => voucher(index + 1, {
      attachments: [`https://storage.test/receipt-${index + 1}.jpg`],
    }));
    const target = batch(rows); setBatchReads(target);
    const finish: ((value: object) => void)[] = [];
    for (let i = 0; i < 3; i++) {
      state.write.mockImplementationOnce(() => new Promise(resolve => { finish.push(resolve); }));
    }
    const { result, rerender } = renderHook(({ scope }) => useQuickExpense(scope), { initialProps: { scope: 'batch' } });
    let running!: Promise<void>;
    await act(async () => { running = mode === 'batch' ? result.current.runBatch(target) : result.current.run(rows); });
    expect(state.write).toHaveBeenCalledTimes(3);
    expect(result.current.activeIds).toEqual(rows.slice(0, 3).map(row => row.id));
    rerender({ scope: 'individual' });
    await act(async () => { await result.current.run(rows); });
    expect(state.write).toHaveBeenCalledTimes(3);
    await act(async () => { finish[1]({}); });
    expect(state.write).toHaveBeenCalledTimes(5);
    expect(result.current.busy).toBe(true);
    expect(result.current.results.map(row => row.id)).toEqual([rows[1].id, rows[3].id, rows[4].id]);
    await act(async () => { finish[0]({}); finish[2]({}); await running; });
    expect(result.current.results.map(row => row.id)).toEqual(rows.map(row => row.id));
    expect(result.current.results.every(row => row.status === 'success')).toBe(true);
    expect(result.current.progress).toEqual({ done: 5, total: 5 });
    expect(result.current.activeIds).toEqual([]);
  });
  it('kết quả không rõ chặn phiếu chưa gửi và giữ khóa đến khi mọi lệnh đang chạy trả về', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => voucher(index + 1, {
      attachments: [`https://storage.test/receipt-${index + 1}.jpg`],
    }));
    setBatchReads(batch(rows));
    let fail!: (error: unknown) => void;
    let finish!: (value: object) => void;
    let finishThird!: (value: object) => void;
    state.write
      .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishThird = resolve; }));
    const { result } = renderHook(() => useQuickExpense('individual'));
    let running!: Promise<void>;
    await act(async () => { running = result.current.run(rows); });
    expect(state.write).toHaveBeenCalledTimes(3);
    await act(async () => { fail(new FinancialWorkflowError('Mất kết nối', 'unknown', [])); });
    expect(result.current.busy).toBe(true);
    await act(async () => { await result.current.run(rows); });
    expect(state.write).toHaveBeenCalledTimes(3);
    await act(async () => { finish({}); finishThird({}); await running; });
    expect(result.current.busy).toBe(false);
    expect(result.current.reason(rows[0])).toMatch(/đối chiếu/);
    expect(result.current.results).toHaveLength(5);
    expect(result.current.results[0].status).toBe('unknown');
    expect(result.current.results[1].status).toBe('success');
    expect(result.current.results.map(row => row.status)).toEqual(['unknown', 'success', 'success', 'skipped', 'skipped']);
  });
});
