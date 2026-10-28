// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomeExpenseWithRelations } from '@/hooks/useIncomeExpenses';

// Bộ thao tác dùng chung của Thu chi (máy tính, điện thoại, Báo cáo LN). Ghi máy chủ được thay bằng
// hàm giả để kiểm: đi ĐÚNG cửa nào, gửi phiên bản nào, khi nào chặn ở client, khi nào báo onChanged.
const m = vi.hoisted(() => ({
  cancelLegacy: vi.fn(), cancelFlex: vi.fn(), cancelIncome: vi.fn(), restore: vi.fn(), cancelBatch: vi.fn(),
  approveLegacy: vi.fn(), unapprove: vi.fn(), revise: vi.fn(), stopRecurring: vi.fn(),
  approveV2: vi.fn(), approveAndPost: vi.fn(), postApproved: vi.fn(), reverse: vi.fn(),
  selfCheck: vi.fn(),
  routes: { readSemantics: 'CANONICAL', workflow: 'CANONICAL', posting: 'CANONICAL', access: 'CANONICAL', accountingStandardStrict: false },
  flexRows: {} as Record<string, unknown>,
  incomeRows: {} as Record<string, unknown>,
  accounts: [] as Array<{ id: string; name: string; is_virtual: boolean }>,
}));
const mutation = (fn: ReturnType<typeof vi.fn>) => ({ mutateAsync: fn, mutate: fn, isPending: false });

vi.mock('@/hooks/useIncomeExpenses', () => ({
  useCancelIncomeExpense: () => mutation(m.cancelLegacy),
  useRestoreIncomeExpense: () => mutation(m.restore),
  useApproveVoucher: () => mutation(m.approveLegacy),
  useUnapproveVoucher: () => mutation(m.unapprove),
  useStopRecurring: () => mutation(m.stopRecurring),
  useCancelIncomeExpenseBatch: () => mutation(m.cancelBatch),
}));
vi.mock('@/hooks/income-expenses/revisions', () => ({
  useIncomeExpenseRevisions: () => ({ isError: false, isLoading: false, data: [] }),
  useReviseIncomeExpense: () => mutation(m.revise),
}));
vi.mock('@/hooks/income-expenses/selfApproveGate', () => ({
  checkSelfApproveBeforeApprove: (...args: unknown[]) => m.selfCheck(...args),
  useSelfApproveGate: () => ({ blocked: false, message: null }),
}));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: m.accounts }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'u-1' } }) }));
vi.mock('@/lib/financeV2Route', async (orig) => ({
  ...(await orig<typeof import('@/lib/financeV2Route')>()),
  useFinanceV2Routes: () => ({ getOrg: () => m.routes, isLoading: false }),
}));
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({
  useApproveIncomeExpenseV2: () => mutation(m.approveV2),
  useApproveAndPostIncomeExpenseV2: () => mutation(m.approveAndPost),
  usePostApprovedIncomeExpenseV2: () => mutation(m.postApproved),
  useReversePostingV2: () => mutation(m.reverse),
  useCustodianCashbooksV2: () => ({ data: [], isError: false, refetch: vi.fn() }),
  useAttachPostingEvidence: () => vi.fn(),
  useRemovePostingAttachment: () => vi.fn(),
}));
vi.mock('@/hooks/income-expenses/flexMutations', async (orig) => ({
  ...(await orig<typeof import('@/hooks/income-expenses/flexMutations')>()),
  useFlexCancelEligibility: () => ({ data: m.flexRows }),
  useCancelVoucherFlex: () => mutation(m.cancelFlex),
}));
vi.mock('@/hooks/income-expenses/incomeVoucherCancel', async (orig) => ({
  ...(await orig<typeof import('@/hooks/income-expenses/incomeVoucherCancel')>()),
  useIncomeCancelEligibility: () => ({ data: m.incomeRows }),
  useCancelIncomeVoucher: () => mutation(m.cancelIncome),
}));

import { useVoucherActions } from '@/hooks/income-expenses/useVoucherActions';

const phieu = (p: Partial<IncomeExpenseWithRelations> = {}): IncomeExpenseWithRelations => ({
  id: 'v-1', type: 'EXPENSE', approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', approval_version: 3,
  posting_version: 2, account_id: 'acc-1', shareholder_id: null, attachments: [], organization_id: 'org-1',
  system_source: null, commission_kind: null, items: [], user_id: 'u-lap', building_id: 'b1', invoice_id: null,
  ...p,
} as IncomeExpenseWithRelations);

function setup(vouchers: IncomeExpenseWithRelations[]) {
  const onChanged = vi.fn();
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useVoucherActions({ vouchers, onChanged }), { wrapper });
  return { ...hook, onChanged };
}

beforeEach(() => {
  for (const fn of [m.cancelLegacy, m.cancelFlex, m.cancelIncome, m.restore, m.cancelBatch, m.approveLegacy,
    m.unapprove, m.revise, m.stopRecurring, m.approveV2, m.approveAndPost, m.postApproved, m.reverse]) {
    fn.mockReset();
    fn.mockResolvedValue({});
  }
  m.selfCheck.mockReset();
  m.selfCheck.mockResolvedValue({ ok: true, reason: null, message: null });
  m.routes = { readSemantics: 'CANONICAL', workflow: 'CANONICAL', posting: 'CANONICAL', access: 'CANONICAL', accountingStandardStrict: false };
  m.flexRows = {};
  m.incomeRows = {};
  m.accounts = [];
});

const LY_DO = 'ghi nhầm số tiền';

describe('Huỷ — đi đúng MỘT trong ba cửa như Thu chi', () => {
  it('phiếu THU ⇒ cửa riêng (cancel_income_voucher_v1); xong ⇒ báo làm mới, đóng hộp', async () => {
    const thu = phieu({ type: 'INCOME', approval_status: 'APPROVED', posting_status: 'POSTED' });
    const { result, onChanged } = setup([thu]);
    act(() => result.current.cancel('v-1', 'INCOME'));
    act(() => result.current.dialogs.cancel.setReason(LY_DO));
    await act(async () => { await result.current.dialogs.cancel.confirm(); });
    expect(m.cancelIncome).toHaveBeenCalledWith({ voucherId: 'v-1', reason: LY_DO });
    expect(m.cancelFlex).not.toHaveBeenCalled();
    expect(m.cancelLegacy).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(result.current.anyOpen).toBe(false);
  });

  it('phiếu CHI máy chủ cho huỷ nhanh ⇒ writer flex kèm HAI phiên bản (chống huỷ đè)', async () => {
    m.flexRows = { 'v-1': { id: 'v-1', eligible: true, reason_code: null } };
    const { result } = setup([phieu()]);
    act(() => result.current.cancel('v-1', 'EXPENSE'));
    act(() => result.current.dialogs.cancel.setReason(LY_DO));
    await act(async () => { await result.current.dialogs.cancel.confirm(); });
    expect(m.cancelFlex).toHaveBeenCalledWith({ voucherId: 'v-1', reason: LY_DO, expectedApprovalVersion: 3, expectedPostingVersion: 2 });
  });

  it('phiếu CHI chưa có câu trả lời của máy chủ ⇒ thang huỷ cũ', async () => {
    const { result } = setup([phieu()]);
    act(() => result.current.cancel('v-1', 'EXPENSE'));
    act(() => result.current.dialogs.cancel.setReason(LY_DO));
    await act(async () => { await result.current.dialogs.cancel.confirm(); });
    expect(m.cancelLegacy).toHaveBeenCalledWith({ id: 'v-1', reason: LY_DO });
  });

  it('lý do dưới 8 ký tự ⇒ chặn ở client, không gọi máy chủ', async () => {
    const { result, onChanged } = setup([phieu()]);
    act(() => result.current.cancel('v-1', 'EXPENSE'));
    act(() => result.current.dialogs.cancel.setReason('ngắn'));
    await act(async () => { await result.current.dialogs.cancel.confirm(); });
    expect(m.cancelLegacy).not.toHaveBeenCalled();
    expect(result.current.dialogs.reasonError).toBe('cancelReason');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('máy chủ nói không huỷ được (tháng đã chốt) ⇒ hộp biết trước, kèm lý do', () => {
    m.flexRows = { 'v-1': { id: 'v-1', eligible: false, reason_code: 'PROFIT_LOCKED' } };
    const { result } = setup([phieu()]);
    act(() => result.current.cancel('v-1', 'EXPENSE'));
    expect(result.current.dialogs.cancel.gate.canCancel).toBe(false);
    expect(result.current.dialogs.cancel.gate.reason).toMatch(/chốt lợi nhuận/);
  });
});

describe('Duyệt', () => {
  it('tổ chức ghi sổ kiểu mới ⇒ "Chỉ duyệt" qua approve v2 đúng phiên bản, không sửa phiếu', async () => {
    const { result, onChanged } = setup([phieu()]);
    act(() => result.current.approve(phieu()));
    expect(result.current.dialogs.approve.v2ApproveOnly).toBe(true);
    await act(async () => { await result.current.dialogs.approve.confirm(); });
    expect(m.approveV2).toHaveBeenCalledWith({ voucherId: 'v-1', expectedApprovalVersion: 3 });
    expect(m.revise).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('kiểu cũ có đổi sổ ⇒ bắt lý do; đủ lý do ⇒ sửa phiếu rồi duyệt ĐÚNG phiên bản vừa sửa', async () => {
    m.routes = { readSemantics: 'LEGACY', workflow: 'LEGACY', posting: 'LEGACY', access: 'LEGACY', accountingStandardStrict: true };
    m.accounts = [{ id: 'acc-1', name: 'Sổ A', is_virtual: false }, { id: 'acc-2', name: 'Sổ B', is_virtual: false }];
    m.revise.mockResolvedValue({ approval_version: 4, changed: true });
    const { result } = setup([phieu()]);
    act(() => result.current.approve(phieu()));
    act(() => result.current.dialogs.approve.setAccountId('acc-2'));
    expect(result.current.dialogs.approve.needsReason).toBe(true);
    await act(async () => { await result.current.dialogs.approve.confirm(); });
    expect(m.revise).not.toHaveBeenCalled();
    act(() => result.current.dialogs.approve.setReason('đổi sang sổ đúng của toà'));
    await act(async () => { await result.current.dialogs.approve.confirm(); });
    expect(m.revise).toHaveBeenCalledWith(expect.objectContaining({ voucherId: 'v-1', expectedApprovalVersion: 3, patch: { account_id: 'acc-2' } }));
    expect(m.approveLegacy).toHaveBeenCalledWith({ id: 'v-1', expectedApprovalVersion: 4 });
  });

  it('cổng tự duyệt chưa kiểm được ⇒ báo lỗi, KHÔNG ghi gì', async () => {
    m.selfCheck.mockResolvedValue({ ok: false, reason: 'unverified', message: 'Chưa kiểm được quyền tự duyệt.' });
    const { result, onChanged } = setup([phieu()]);
    act(() => result.current.approve(phieu()));
    await act(async () => { await result.current.dialogs.approve.confirm(); });
    expect(m.approveV2).not.toHaveBeenCalled();
    expect(result.current.dialogs.actionError).toBe('Chưa kiểm được quyền tự duyệt.');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('chi cổ đông kiểu cũ: chỉ cho chọn sổ thật, sổ ảo đang gắn bị bỏ trống để buộc chọn lại', () => {
    m.routes = { readSemantics: 'LEGACY', workflow: 'LEGACY', posting: 'LEGACY', access: 'LEGACY', accountingStandardStrict: true };
    m.accounts = [{ id: 'acc-ao', name: 'Sổ ảo', is_virtual: true }, { id: 'acc-1', name: 'Sổ A', is_virtual: false }];
    const coDong = phieu({ shareholder_id: 'sh-1', account_id: 'acc-ao' });
    const { result } = setup([coDong]);
    act(() => result.current.approve(coDong));
    expect(result.current.dialogs.approve.isShareholderPayout).toBe(true);
    expect(result.current.dialogs.approve.accounts.map((a) => a.id)).toEqual(['acc-1']);
    expect(result.current.dialogs.approve.accountId).toBe('');
  });
});

describe('Huỷ duyệt / Khôi phục / đóng form / Dừng lặp', () => {
  it('huỷ duyệt phiếu hoa hồng bắt lý do 8–2000 ký tự', async () => {
    const hoaHong = phieu({ approval_status: 'APPROVED', system_source: 'contract.commission' });
    const { result } = setup([hoaHong]);
    act(() => result.current.unapprove('v-1'));
    expect(result.current.dialogs.unapprove.needsReason).toBe(true);
    await act(async () => { await result.current.dialogs.unapprove.confirm(); });
    expect(m.unapprove).not.toHaveBeenCalled();
    act(() => result.current.dialogs.unapprove.setReason('khách đổi người nhận hoa hồng'));
    await act(async () => { await result.current.dialogs.unapprove.confirm(); });
    expect(m.unapprove).toHaveBeenCalledWith({ id: 'v-1', reason: 'khách đổi người nhận hoa hồng' });
  });

  it('khôi phục phiếu thường không cần lý do; xong ⇒ báo làm mới', async () => {
    const { result, onChanged } = setup([phieu({ approval_status: 'CANCELLED' })]);
    act(() => result.current.restore('v-1'));
    await act(async () => { await result.current.dialogs.restore.confirm(); });
    expect(m.restore).toHaveBeenCalledWith({ id: 'v-1', reason: undefined });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('đóng form sửa / bản sao / bổ sung / đánh dấu đã kiểm ⇒ báo làm mới; đóng lịch sử thì không', () => {
    const { result, onChanged } = setup([phieu()]);
    for (const [open, close] of [
      ['edit', 'closeEdit'], ['copy', 'closeCopy'], ['quickEdit', 'closeQuickEdit'], ['verify', 'closeVerify'],
    ] as const) {
      act(() => result.current[open](phieu()));
      expect(result.current.anyOpen).toBe(true);
      act(() => result.current.dialogs[close]());
      expect(result.current.anyOpen).toBe(false);
    }
    expect(onChanged).toHaveBeenCalledTimes(4);
    act(() => result.current.history(phieu()));
    act(() => result.current.dialogs.closeHistory());
    expect(onChanged).toHaveBeenCalledTimes(4);
  });

  it('dừng lặp lại ghi ngay (như danh sách), xong ⇒ báo làm mới', () => {
    m.stopRecurring.mockImplementation((_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    const { result, onChanged } = setup([phieu()]);
    act(() => result.current.stopRecurring('v-1'));
    expect(m.stopRecurring).toHaveBeenCalledWith('v-1', expect.anything());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
