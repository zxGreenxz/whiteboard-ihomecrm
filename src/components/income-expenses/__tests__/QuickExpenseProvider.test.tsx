// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomeExpenseBatchSummary, IncomeExpenseWithRelations } from '@/hooks/income-expenses/types';
import type { FinanceV2OrgRoutes } from '@/lib/financeV2Route';

const state = vi.hoisted(() => ({
  org: '11111111-1111-4111-8111-111111111111',
  permissions: { __superadmin: true } as unknown, actor: 'actor',
  read: vi.fn(), adopt: vi.fn(), write: vi.fn(), list: vi.fn(), books: vi.fn(),
  batchRead: vi.fn(), membershipRead: vi.fn(),
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
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({
  useCustodianCashbooksV2: () => ({ data: [{ id: book }], isSuccess: true, isFetching: false, refetch: state.books }),
  useApproveAndPostIncomeExpenseV2: () => ({ mutateAsync: state.write }),
  useInvalidateMoney: () => vi.fn(),
  adoptVoucherAttachmentsAsEvidence: state.adopt,
  createQuickExpenseBatchEvidenceSession: () => (row: IncomeExpenseWithRelations) => state.adopt(row.id),
}));
vi.mock('@/hooks/income-expenses/detailRead', () => ({ loadIncomeExpenseDetail: state.read, withDetailReadDeadline: (p: Promise<unknown>) => p }));
vi.mock('@/lib/incomeExpenseDetailRpc', () => ({
  loadIncomeExpenseDetails: (_organizationId: string, ids: string[]) => Promise.all(ids.map(id => state.read(id))),
}));
vi.mock('@/hooks/income-expenses/queries', () => ({ incomeExpensesListQuery: (...args: unknown[]) => ({ queryFn: () => state.list(...args) }) }));
vi.mock('@/hooks/useVoucherDetail', () => ({
  loadIncomeExpenseBatch: state.batchRead,
  readIncomeExpenseBatchMembership: state.membershipRead,
}));

import { QuickExpenseProvider, usePageQuickExpense } from '../QuickExpenseProvider';
import type { QuickExpenseActions } from '@/hooks/income-expenses/useQuickExpense';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { usePhoneViewport } from '@/hooks/use-mobile';

function voucher(i = 1, patch: Partial<IncomeExpenseWithRelations> = {}): IncomeExpenseWithRelations {
  return { id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`, code: `PC-${i}`, name: `Chi ${i}`,
    organization_id: state.org, type: 'EXPENSE', building_id: null, total_amount: 100,
    approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', posting_mode: 'CASHBOOK', review_state: 'PENDING',
    approval_version: 1, posting_version: 1, updated_at: '2026-10-19T00:00:00Z',
    account_id: book, account_is_virtual: false, attachments: ['https://storage.test/shared-receipt.jpg'],
    detail_read: { complete: true, expected_item_count: 0 }, items: [], system_source: null,
    ...patch } as IncomeExpenseWithRelations;
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
beforeEach(() => {
  vi.resetAllMocks(); state.actor = 'actor'; state.org = '11111111-1111-4111-8111-111111111111'; state.permissions = { __superadmin: true };
  state.read.mockImplementation(async (id: string) => voucher(Number(id.slice(-12))));
  state.adopt.mockResolvedValue({ evidenceIds: ['evidence-1'], skipped: [] });
  state.write.mockResolvedValue({}); state.books.mockResolvedValue({ data: [{ id: book }], error: null });
  state.batchRead.mockResolvedValue(batch()); state.membershipRead.mockResolvedValue(membership());
});

type ViewProps = { scope: string; ready?: boolean };
let current: QuickExpenseActions;
function Desktop({ scope, ready = true }: ViewProps) {
  current = usePageQuickExpense(scope, ready);
  return <div>desktop {current.progress.done}/{current.progress.total}</div>;
}
function Mobile({ scope, ready = true }: ViewProps) {
  current = usePageQuickExpense(scope, ready);
  return <div>mobile {current.progress.done}/{current.progress.total}</div>;
}
function Page(props: ViewProps) {
  const mobile = usePhoneViewport();
  return <QuickExpenseProvider>{mobile ? <Mobile {...props} /> : <Desktop {...props} />}</QuickExpenseProvider>;
}
let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
beforeEach(() => {
  media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => media });
});
afterEach(cleanup);

async function startHeldBatch() {
  let finish!: (value: object) => void;
  state.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let running!: Promise<void>;
  await act(async () => { running = current.runBatch(batch()); });
  expect(state.write).toHaveBeenCalledTimes(1);
  return { finish, running };
}

describe('chủ sở hữu đợt chi nhanh trên trang Thu chi', () => {
  it('giữ tiến độ và khóa gửi trùng khi đổi desktop sang mobile trong lúc đang chi', async () => {
    render(<Page scope="batch" />);
    const held = await startHeldBatch();
    expect(current.busy).toBe(true);
    expect(current.progress).toEqual({ done: 0, total: 2 });
    act(() => { media.matches = true; media.addEventListener.mock.calls[0][1](); });
    expect(current.busy).toBe(true);
    expect(current.progress).toEqual({ done: 0, total: 2 });
    expect(current.activeBatchId).toBe(batch().id);
    await act(async () => { await current.runBatch(batch()); });
    expect(state.write).toHaveBeenCalledTimes(1);
    await act(async () => { held.finish({}); await held.running; });
    expect(state.write).toHaveBeenCalledTimes(2);
    expect(current.results.map(row => row.status)).toEqual(['success', 'success']);
    expect(current.busy).toBe(false);
  });

  it('chuyển tab và bộ lọc chỉ xóa lựa chọn, tiếp tục đúng các phiếu đã bắt đầu', async () => {
    const view = render(<Page scope="batch:all" />);
    act(() => current.toggle(voucher(), true));
    expect(current.selected).toHaveLength(1);
    const held = await startHeldBatch();
    view.rerender(<Page scope="individual:search" />);
    expect(current.selected).toEqual([]);
    expect(current.busy).toBe(true);
    await act(async () => { held.finish({}); await held.running; });
    expect(state.write).toHaveBeenCalledTimes(2);
    expect(current.results.map(row => row.id)).toEqual(batch().voucher_ids);
  });

  it('đang tải lại danh sách khóa các lệnh mới nhưng không dừng đợt đã chạy', async () => {
    const view = render(<Page scope="batch" />);
    const held = await startHeldBatch();
    view.rerender(<Page scope="batch" ready={false} />);
    expect(current.ready).toBe(false);
    expect(current.batchReason(batch())).toMatch(/Đang tải/);
    await act(async () => { held.finish({}); await held.running; });
    expect(state.write).toHaveBeenCalledTimes(2);
    await act(async () => {
      await current.runBatch(batch());
      await current.run([voucher()]);
      await current.selectAll({});
    });
    act(() => { current.toggle(voucher(), true); current.togglePage([voucher()], true); });
    expect(state.write).toHaveBeenCalledTimes(2);
    expect(state.list).not.toHaveBeenCalled();
    expect(current.selected).toEqual([]);
    expect(current.reason(voucher())).toMatch(/Đang tải/);
  });

  it('đổi bộ lọc bỏ kết quả chọn tất cả đang tải từ danh sách cũ', async () => {
    const view = render(<Page scope="individual:old" />);
    let finish!: (value: { data: IncomeExpenseWithRelations[]; totalCount: number }) => void;
    state.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let collecting!: Promise<void>;
    await act(async () => { collecting = current.selectAll({}); });
    expect(current.collecting).toBe(true);
    view.rerender(<Page scope="individual:new" />);
    await act(async () => { finish({ data: [voucher()], totalCount: 1 }); await collecting; });
    expect(current.selected).toEqual([]);
    expect(current.collecting).toBe(false);
    expect(state.write).not.toHaveBeenCalled();
  });

  it.each(['organization', 'actor'] as const)('đổi %s vẫn dừng những phiếu chưa gửi', async change => {
    const view = render(<Page scope="batch" />);
    const held = await startHeldBatch();
    if (change === 'organization') state.org = '44444444-4444-4444-8444-444444444444';
    else state.actor = 'other-actor';
    view.rerender(<Page scope="batch" />);
    await act(async () => { held.finish({}); await held.running; });
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(current.results.map(row => row.status)).toEqual(['success', 'skipped']);
  });

  it('rời trang vẫn dừng phần chưa gửi sau khi lệnh đang chờ có kết quả', async () => {
    const view = render(<Page scope="batch" />);
    const held = await startHeldBatch();
    view.unmount();
    await act(async () => { held.finish({}); await held.running; });
    expect(state.write).toHaveBeenCalledTimes(1);
  });

  it('kết quả không rõ vẫn khóa phiếu sau khi đổi giao diện', async () => {
    render(<Page scope="batch" />);
    state.write.mockRejectedValueOnce(new FinancialWorkflowError('Mất kết nối', 'unknown', []));
    await act(async () => { await current.runBatch(batch()); });
    expect(current.results.map(row => row.status)).toEqual(['unknown', 'skipped']);
    act(() => { media.matches = true; media.addEventListener.mock.calls[0][1](); });
    expect(current.results.map(row => row.status)).toEqual(['unknown', 'skipped']);
    expect(current.reason(voucher())).toMatch(/đối chiếu/);
    await act(async () => { await current.runBatch(batch()); });
    expect(state.write).toHaveBeenCalledTimes(1);
  });
});
