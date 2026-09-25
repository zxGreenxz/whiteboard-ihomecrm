// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettlementActions } from '@/hooks/useSettlementActions';
import type { SettlementRow } from '@/lib/contractSettlement';
import type { PostFinanceExecutionInput } from '@/lib/incomeExpensePostingValidation';

const H = vi.hoisted(() => ({
  cancelPermission: true, ids: [] as string[], writer: vi.fn(), revise: vi.fn(),
  legacyWriter: vi.fn(), workflowCanonical: true,
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: (_p: unknown, _page: string, action: string) => action !== 'cancel' || H.cancelPermission }));
vi.mock('@/lib/financeV2Route', () => ({
  useFinanceV2Routes: () => ({ isLoading: false, getOrg: () => ({}) }),
  isCanonicalRead: () => true, canWriteWorkflow: () => H.workflowCanonical, canWritePosting: () => true,
}));
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({
  useApproveIncomeExpenseV2: () => ({ mutateAsync: H.writer }),
  useApproveAndPostIncomeExpenseV2: () => ({ mutateAsync: H.writer }),
  usePostApprovedIncomeExpenseV2: () => ({ mutateAsync: H.writer }),
}));
vi.mock('@/hooks/income-expenses/statusMutations', () => ({
  useApproveVoucher: () => ({ mutateAsync: H.legacyWriter }),
  useCancelIncomeExpense: () => ({ mutateAsync: H.writer }),
}));
vi.mock('@/hooks/income-expenses/flexMutations', () => ({
  useCancelVoucherFlex: () => ({ mutateAsync: H.writer }),
  useFlexCancelEligibility: (ids: string[]) => { H.ids = ids; return { data: {} }; },
  flexCancelGate: () => ({ canCancel: true }),
}));
vi.mock('@/hooks/income-expenses/incomeVoucherCancel', () => ({
  useCancelIncomeVoucher: () => ({ mutateAsync: H.writer }),
  voucherCancelDecision: () => ({ canCancel: true }),
}));
vi.mock('@/hooks/income-expenses/supplements', () => ({
  useAppendIncomeExpenseSupplement: () => ({ mutateAsync: H.writer }),
}));
vi.mock('@/hooks/income-expenses/revisions', () => ({
  reviseIncomeExpense: H.revise,
  VOUCHER_QUERY_KEYS: [['income-expenses']],
}));

const row = (patch: Partial<SettlementRow> = {}): SettlementRow => ({
  key: 'v', voucherId: 'v', organizationId: 'org', approvalStatus: 'UNAPPROVED',
  postingStatus: 'UNPOSTED', postingMode: 'CASH', validationState: 'ready',
  supplementPending: false, approvalVersion: 3, ...patch,
} as SettlementRow);
const input = (id = 'v'): PostFinanceExecutionInput => ({
  subjectKind: 'VOUCHER', subjectId: id, cashbookId: 'book', postedOn: '2026-09-22',
  evidenceIds: [], expectedExecutionRevision: 0, expectedApprovalVersion: 0,
  expectedPostingVersion: 0, idempotencyKey: 'command',
});
const run = (rows: SettlementRow[]) => {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useSettlementActions(rows), { wrapper });
};
beforeEach(() => {
  H.cancelPermission = true; H.ids = []; H.workflowCanonical = true;
  H.writer.mockReset(); H.writer.mockResolvedValue({});
  H.legacyWriter.mockReset(); H.legacyWriter.mockResolvedValue({});
  H.revise.mockReset(); H.revise.mockResolvedValue({ id: 'v', changed: true, approval_version: 4, changed_fields: [] });
});

describe('useSettlementActions — nguồn bắt buộc và eligibility', () => {
  it.each(['loading', 'error'] as const)('chặn duyệt/chi khi đối chiếu %s, vẫn cho bổ sung', async (validationState) => {
    const pending = row({ validationState });
    const approved = row({ validationState, approvalStatus: 'APPROVED' });
    const { result } = run([pending]);
    expect(result.current.availabilityOf(pending)).toMatchObject({ approve: false, approveAndPost: false, requestSupplement: true });
    expect(result.current.availabilityOf(approved).post).toBe(false);
    await expect(result.current.approve(pending)).rejects.toThrow();
    await expect(result.current.approveAndPost(input())).rejects.toThrow();
    await expect(result.current.post(input())).rejects.toThrow();
    expect(H.writer).not.toHaveBeenCalled();
  });
  it('không gửi lệnh của UUID không có trong tập phiếu đang thao tác', async () => {
    const { result } = run([row()]);
    await expect(result.current.post(input('another'))).rejects.toThrow();
    expect(H.writer).not.toHaveBeenCalled();
  });
  it('nguồn ready vẫn đi qua writer duyệt cũ', async () => {
    const pending = row();
    const { result } = run([pending]);
    expect(result.current.availabilityOf(pending).approveAndPost).toBe(true);
    await result.current.approve(pending);
    expect(H.writer).toHaveBeenCalledOnce();
  });
  it('không hỏi điều kiện hủy khi không có quyền hoặc chưa mở phiếu', () => {
    H.cancelPermission = false;
    run([row()]);
    expect(H.ids).toEqual([]);
    H.cancelPermission = true;
    run([]);
    expect(H.ids).toEqual([]);
    run([row(), row({ voucherId: 'cancelled', approvalStatus: 'CANCELLED' })]);
    expect(H.ids).toEqual(['v']);
  });
});

describe('useSettlementActions — sửa người nhận / duyệt kèm phiên bản (đợt 1 sửa phiếu)', () => {
  it('sửa người nhận đi cửa sửa phiếu có lưu vết, patch thưa + phiên bản đang xem', async () => {
    const { result } = run([row()]);
    await result.current.editRecipient({ voucherId: 'v', payerName: 'Anh Tư' });
    expect(H.revise).toHaveBeenCalledWith({
      voucherId: 'v', expectedApprovalVersion: 3, patch: { payer_name: 'Anh Tư' },
    });
  });
  it('không đổi ô nào ⇒ không gọi máy chủ; phiếu lạ ⇒ từ chối', async () => {
    const { result } = run([row()]);
    await result.current.editRecipient({ voucherId: 'v' });
    await expect(result.current.editRecipient({ voucherId: 'khac', payerName: 'X' })).rejects.toThrow();
    expect(H.revise).not.toHaveBeenCalled();
  });
  it('org LEGACY: duyệt kèm phiên bản để phiếu vừa bị sửa không bị duyệt nhầm', async () => {
    H.workflowCanonical = false;
    const pending = row();
    const { result } = run([pending]);
    await result.current.approve(pending);
    expect(H.legacyWriter).toHaveBeenCalledWith({ id: 'v', expectedApprovalVersion: 3 });
  });
});
