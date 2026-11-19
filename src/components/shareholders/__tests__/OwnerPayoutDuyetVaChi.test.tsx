// @vitest-environment jsdom
// "Chủ Duyệt và Chi luôn" (chủ chốt 19/11/2026): hộp chốt chi lợi nhuận cổ đông + hộp chi lương điều hành — MỘT màn,
// khối "Duyệt và Chi" bên dưới, ô ảnh chứng từ như hộp Duyệt và Chi của Thu chi. Chạy hook THẬT (useOwnerPayoutPosting,
// useDeferredPostingEvidence); chỉ giả ở tầng lệnh: lệnh lập phiếu (W2 / E11), đọc lại phiếu, tải / gắn ảnh, duyệt,
// duyệt-và-chi. Kiểm: thứ tự lập → đọc lại → gắn ảnh → Duyệt và Chi đúng phiếu; không giữ sổ ⇒ chỉ duyệt; thiếu ảnh ⇒ không
// lập; bước sau lỗi ⇒ "Làm tiếp" không lập lại; không ra tiền ⇒ không duyệt; đường lùi kho chứng từ. Dữ liệu GIẢ.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const URL_ANH = 'https://demo.supabase.co/storage/v1/object/public/income-expense-attachments/u-1/1-a-chung-tu.png';

const m = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    settle: vi.fn(),
    managerCreate: vi.fn(),
    loadDetails: vi.fn(),
    approveAndPost: vi.fn(),
    approve: vi.fn(),
    upload: vi.fn(),
    commit: vi.fn(),
    discard: vi.fn(),
    uploadEvidence: vi.fn(),
    adopt: vi.fn(),
    invalidateLedger: vi.fn(),
    invalidateMoney: vi.fn(),
    refetchBooks: vi.fn(),
    books: [] as Array<{ id: string; name: string }>,
    zeroCash: false,
    /** get_my_permissions_v2: chủ công ty nhận cờ __superadmin. */
    perms: { __superadmin: true } as Record<string, unknown>,
    // Tham chiếu ỔN ĐỊNH như hook thật (usePostingAttachmentDraft trả đối tượng memo, `discard` là hàm của module).
    draft: null as null | { upload: (...a: unknown[]) => unknown; commit: (...a: unknown[]) => unknown; discard: (...a: unknown[]) => unknown },
  };
});
m.draft = {
  upload: (...a: unknown[]) => m.upload(...a),
  commit: (...a: unknown[]) => { m.calls.push('commit'); return m.commit(...a); },
  discard: (...a: unknown[]) => m.discard(...a),
};

const ok = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, isSuccess: true, isFetching: false, isPlaceholderData: false, error: null, refetch: vi.fn() });

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), auth: { getSession: vi.fn(async () => ({ data: {} })) } } }));
vi.mock('@/lib/storage/resilientUpload', () => ({ warmUploadConnection: vi.fn() }));
vi.mock('@/components/ui/storage-image', () => ({ StorageImage: ({ alt }: { alt: string }) => <img alt={alt} /> }));
vi.mock('@/components/income-expenses/AttachmentUpload', () => ({ validateAttachmentFile: () => null, default: () => null }));
vi.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => ok([
    { id: 'a1', name: 'Quỹ chủ', code: 'Q1', is_virtual: false, organization_id: 'org-a' },
    { id: 'a2', name: 'Quỹ người giữ', code: 'Q2', is_virtual: false, organization_id: 'org-a' },
  ]),
}));
// Tầng lệnh của màn Chờ duyệt / hộp Thu-Chi — giả, ghi THỨ TỰ gọi.
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({
  useCustodianCashbooksV2: () => ({ data: m.books, isError: false, refetch: m.refetchBooks }),
  useApproveAndPostIncomeExpenseV2: () => ({ mutateAsync: (input: unknown) => { m.calls.push('approveAndPost'); return m.approveAndPost(input); }, isPending: false }),
  useApproveIncomeExpenseV2: () => ({ mutateAsync: (args: unknown) => { m.calls.push('approve'); return m.approve(args); }, isPending: false }),
  useInvalidateMoney: () => m.invalidateMoney,
  usePostingAttachmentDraft: () => m.draft,
  uploadFinanceEvidence: (...a: unknown[]) => { m.calls.push('uploadEvidence'); return m.uploadEvidence(...a); },
  adoptVoucherAttachmentsAsEvidence: (...a: unknown[]) => m.adopt(...a),
}));
vi.mock('@/lib/incomeExpenseDetailRpc', () => ({
  loadIncomeExpenseDetails: (...a: unknown[]) => { m.calls.push('loadDetails'); return m.loadDetails(...a); },
}));
vi.mock('@/hooks/income-expenses/detailRead', () => ({ withDetailReadDeadline: (read: Promise<unknown>) => read }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: m.perms }) }));
vi.mock('@/hooks/profit-ledger/useProfitLedgerMutations', () => ({
  useSettleShareholderProfit: () => ({ mutateAsync: (input: unknown) => { m.calls.push('settle'); return m.settle(input); }, isPending: false }),
  useVoidProfitSettlement: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCancelProfitLedgerPayout: () => ({ mutateAsync: vi.fn(), isPending: false }),
  invalidateProfitLedgerQueries: (...a: unknown[]) => m.invalidateLedger(...a),
}));
vi.mock('@/hooks/useIncomeExpenses', () => ({
  useCreateManagerSalaryPayout: () => ({ mutateAsync: (input: unknown) => { m.calls.push('managerCreate'); return m.managerCreate(input); }, isPending: false }),
}));
const position = {
  unpaid_profit: 100_000, advance_outstanding: 40_000, advance_pending: 0, settlement_cash_pending: 0, balance: 60_000,
  settled: { recognized: 0, offset: 0, cash: 0 }, last_settled_through_month: null, marker_month: '2026-08-01',
  needs_review: { count: 0, suggested: 0 },
  components: { allocated: 100_000, payouts_pending: 0, payouts_approved: 40_000, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: 100_000, advance_outstanding_raw: 40_000, advance_overoffset: 0 },
};
vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useShareholderProfitLedger: () => ok(undefined),
  useProfitSettlementPreview: (input: { shareholderId: string | null; accountId: string | null }) => {
    if (!input.shareholderId) return { ...ok(undefined), status: 'pending', isSuccess: false };
    const offset = m.zeroCash ? 100_000 : 40_000;
    const cash = 100_000 - offset;
    const blocked = cash > 0 && !input.accountId ? 'ACCOUNT_REQUIRED' : null;
    return ok({
      route: 'CANONICAL', shareholder_id: input.shareholderId,
      months: [{ month: '2026-10-01', allocated: 100_000, selectable: true, unpaid_through: 100_000 }],
      min_through_month: '2026-10-01', through_month: '2026-10-01', position,
      recognized_amount: 100_000, advance_offset_amount: offset, cash_amount: cash, advance_left: 0, advance_pending: 0,
      settlements: [], can_submit: blocked === null, blocked_reason: blocked,
    });
  },
}));
vi.mock('@/components/ui/searchable-select', () => ({
  SearchableSelect: ({ options, onValueChange, value, name, disabled }: { options: { value: string; label: string }[]; onValueChange: (s: string) => void; name: string; value: string; disabled?: boolean }) => (
    <select name={name} disabled={disabled} value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="">Chọn</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import { toast } from 'sonner';
import { FinancialWorkflowError } from '@/lib/financialWorkflowError';
import ProfitDistributeDialog from '../ProfitDistributeDialog';
import ManagerSalaryPayoutDialog from '../ManagerSalaryPayoutDialog';

const LEDGER_ROWS = [{
  shareholder_id: 's', name: 'An', is_active: true, is_deleted: false, has_login: true, marker: null, allocated: 100_000,
  payouts_approved: 40_000, payouts_pending: 0, salary_investment: 0, salary_advance_offset: 0, balance: 60_000, status: 'OWED' as const,
  open_advance: 0, needs_review_count: 0,
}];
const MANAGER_LEDGER = {
  organization_id: 'org-a', route: 'CANONICAL' as const, as_of: '2026-11-19T00:00:00Z',
  managers: [{ manager_id: 'm1', name: 'Quản lý 1', is_active: true, is_deleted: false, has_login: true, marker: null, allocated: 2_000, payouts_approved: 0, payouts_pending: 0, balance: 2_000, status: 'OWED' as const }],
};
const onOpenChange = vi.fn();
const field = (name: string) => document.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const ANH = new File([new Uint8Array([137, 80, 78, 71])], 'chung-tu.png', { type: 'image/png' });

function renderWith(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
const settleDialog = () => renderWith(<ProfitDistributeDialog open onOpenChange={onOpenChange} organizationId="org-a" ledgerRows={LEDGER_ROWS} defaultShareholderId="s" />);
const managerDialog = () => renderWith(<ManagerSalaryPayoutDialog open onOpenChange={onOpenChange} organizationId="org-a" ledger={MANAGER_LEDGER} defaultManagerId="m1" />);

/** Chọn / dán một ảnh vào ô chứng từ của khối "Duyệt và Chi"; chờ ảnh nằm trong kho (chưa gắn phiếu). */
async function addImage() {
  const block = await screen.findByTestId('owner-payout-evidence');
  const input = block.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [ANH] } });
  await waitFor(() => expect(block.querySelector('[data-evidence-url]')?.getAttribute('data-evidence-url')).toBe(URL_ANH));
}

beforeEach(() => {
  m.calls.length = 0;
  m.books = [{ id: 'a1', name: 'Quỹ chủ' }];
  m.zeroCash = false;
  m.perms = { __superadmin: true };
  m.settle.mockReset().mockResolvedValue({
    settlement_id: 'st-9', through_month: '2026-10-01', recognized_amount: 100_000, advance_offset_amount: 40_000, cash_amount: 60_000,
    voucher_id: 'v9', approval_request_id: 'r9', state: 'PENDING_APPROVAL', code: 'PC2611999',
  });
  m.managerCreate.mockReset().mockResolvedValue({ id: 'vm1', voucher_id: 'vm1', code: 'PCM1', approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', balance_before: 2_000 });
  m.loadDetails.mockReset().mockImplementation(async (org: string, ids: string[]) => [{
    id: ids[0], organization_id: org, approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', approval_version: 3, posting_version: 5, account_id: 'a1',
  }]);
  m.approveAndPost.mockReset().mockResolvedValue({});
  m.approve.mockReset().mockResolvedValue({});
  m.upload.mockReset().mockImplementation(async (file: File) => ({ url: URL_ANH, size: 4, elapsedMs: 1, attempts: 1, file }));
  m.commit.mockReset().mockResolvedValue({ ok: true, evidenceIds: ['ev-1'], skipped: [], message: null, periodBlocked: false });
  m.discard.mockReset().mockResolvedValue(undefined);
  m.uploadEvidence.mockReset().mockResolvedValue('ev-kho');
  m.adopt.mockReset().mockResolvedValue({ evidenceIds: ['ev-1'], skipped: [] });
  onOpenChange.mockReset();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('hộp chốt chi lợi nhuận: một nút lập phiếu rồi Duyệt và Chi', () => {
  it('giữ sổ + có ảnh ⇒ lập (W2) → đọc lại phiếu → gắn ảnh → Duyệt và Chi ĐÚNG phiếu vừa lập, đúng sổ, đúng phiên bản', async () => {
    settleDialog();
    fireEvent.change(field('accountId'), { target: { value: 'a1' } });
    await addImage();
    fireEvent.click(button('Duyệt và Chi'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(m.calls).toEqual(['settle', 'loadDetails', 'commit', 'approveAndPost']);
    expect(m.loadDetails).toHaveBeenCalledWith('org-a', ['v9']);
    expect(m.commit).toHaveBeenCalledWith('v9', { add: [URL_ANH], remove: [] });
    const voucherDate = (m.settle.mock.calls[0]![0] as { voucherDate: string }).voucherDate;
    expect(m.approveAndPost).toHaveBeenCalledWith(expect.objectContaining({
      subjectKind: 'VOUCHER', subjectId: 'v9', cashbookId: 'a1', postedOn: voucherDate, evidenceIds: ['ev-1'],
      expectedExecutionRevision: 0, expectedApprovalVersion: 3, expectedPostingVersion: 5, organizationId: 'org-a',
    }));
    expect(m.approve).not.toHaveBeenCalled();
    // Ảnh đã gắn lên phiếu: không bị xoá như rác khi hộp đóng.
    expect(m.discard).not.toHaveBeenCalledWith([URL_ANH]);
    expect(vi.mocked(toast.success).mock.calls[0]![0]).toMatch(/thực chi 60\.000.*Phiếu PC2611999 đã duyệt và chi từ sổ Quỹ chủ/);
    expect(m.invalidateLedger).toHaveBeenCalled();
  });

  it('giữ sổ mà chưa đính ảnh ⇒ không lập phiếu, báo thiếu chứng từ (như hộp Duyệt và Chi bình thường)', async () => {
    settleDialog();
    fireEvent.change(field('accountId'), { target: { value: 'a1' } });
    await screen.findByTestId('owner-payout-evidence');
    fireEvent.click(button('Duyệt và Chi'));
    expect((await screen.findByTestId('owner-payout-evidence-error')).textContent).toMatch(/Thêm ít nhất một ảnh hoặc tệp chứng từ/);
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.calls).toEqual([]);
  });

  it('không giữ sổ đã chọn ⇒ không có ô ảnh, nút "Lập phiếu và duyệt": lập rồi CHỈ duyệt (người giữ sổ bấm Chi)', async () => {
    m.books = [{ id: 'a2', name: 'Quỹ người giữ' }];
    settleDialog();
    fireEvent.change(field('accountId'), { target: { value: 'a1' } });
    expect((await screen.findByTestId('owner-payout-approve-only')).textContent).toMatch(/không giữ sổ Quỹ chủ/);
    expect(screen.queryByTestId('owner-payout-evidence')).toBeNull();
    fireEvent.click(button('Lập phiếu và duyệt'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(m.calls).toEqual(['settle', 'loadDetails', 'approve']);
    expect(m.approve).toHaveBeenCalledWith({ voucherId: 'v9', expectedApprovalVersion: 3, organizationId: 'org-a' });
    expect(m.approveAndPost).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
    expect(vi.mocked(toast.success).mock.calls[0]![0]).toMatch(/Phiếu PC2611999 đã duyệt — người giữ sổ Quỹ chủ bấm Chi/);
  });

  it('bước sau lỗi ⇒ phiếu ở Chờ duyệt, hộp nói đúng trạng thái; "Làm tiếp" làm lại bước sau cho ĐÚNG phiếu, không lập phiếu thứ hai', async () => {
    m.approveAndPost.mockRejectedValueOnce({ code: '55000', message: 'approval_version mismatch (expected 3, found 4)' });
    settleDialog();
    fireEvent.change(field('accountId'), { target: { value: 'a1' } });
    await addImage();
    fireEvent.click(button('Duyệt và Chi'));
    const failure = await screen.findByTestId('owner-payout-step-failure');
    expect(failure.textContent).toMatch(/Đã lập phiếu PC2611999 — phiếu đang CHỜ DUYỆT, chưa duyệt và chi được/);
    expect(failure.textContent).toMatch(/không lập phiếu mới/);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.queryByRole('button', { name: 'Duyệt và Chi' })).toBeNull();
    expect(vi.mocked(toast.warning).mock.calls.some(([text]) => /PC2611999 đã lập, đang chờ duyệt/.test(String(text)))).toBe(true);
    // Form khoá: không chốt lại được.
    expect((field('note').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    fireEvent.click(button('Làm tiếp'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(m.settle).toHaveBeenCalledTimes(1);
    expect(m.commit).toHaveBeenCalledTimes(1); // chứng từ đã gắn được dùng lại
    expect(m.approveAndPost).toHaveBeenCalledTimes(2);
    for (const [input] of m.approveAndPost.mock.calls) expect(input).toMatchObject({ subjectId: 'v9', evidenceIds: ['ev-1'] });
    expect(m.calls).toEqual(['settle', 'loadDetails', 'commit', 'approveAndPost', 'loadDetails', 'approveAndPost']);
  });

  it('chưa rõ kết quả bước sau ⇒ không cho làm tiếp ở hộp, chỉ đường đối chiếu ở Thu chi', async () => {
    m.approveAndPost.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận được kết quả duyệt và ghi nhận thu/chi.', 'unknown', []));
    settleDialog();
    fireEvent.change(field('accountId'), { target: { value: 'a1' } });
    await addImage();
    fireEvent.click(button('Duyệt và Chi'));
    expect((await screen.findByTestId('owner-payout-step-failure')).textContent).toMatch(/Chưa rõ kết quả bước này/);
    expect(button('Làm tiếp').disabled).toBe(true);
    expect(m.settle).toHaveBeenCalledTimes(1);
  });

  it('máy chủ không cho gắn ảnh lên phiếu (hạng mục hạn chế) ⇒ đường lùi kho chứng từ riêng bằng đúng tệp, rồi mới Duyệt và Chi', async () => {
    m.commit.mockResolvedValueOnce({ ok: false, evidenceIds: [], skipped: [], message: 'Không có quyền sửa phiếu', periodBlocked: false });
    settleDialog();
    fireEvent.change(field('accountId'), { target: { value: 'a1' } });
    await addImage();
    fireEvent.click(button('Duyệt và Chi'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(m.calls).toEqual(['settle', 'loadDetails', 'commit', 'uploadEvidence', 'approveAndPost']);
    expect(m.uploadEvidence).toHaveBeenCalledWith(ANH, 'org-a');
    expect(m.approveAndPost).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 'v9', evidenceIds: ['ev-kho'] }));
    expect(m.discard).toHaveBeenCalledWith([URL_ANH]);
    expect(vi.mocked(toast.warning).mock.calls.some(([text]) => /chưa đính được lên phiếu/.test(String(text)))).toBe(true);
  });

  // Máy chủ chỉ miễn "người nhận không tự Chi" khi quyền chi phủ CẢ CÔNG TY — hộp chưa biết người bấm có phải người nhận.
  it('giữ sổ nhưng quyền chi lợi nhuận chỉ theo toà (không phủ cả công ty) ⇒ không hứa Chi: lập rồi chỉ Duyệt', async () => {
    m.perms = {
      shareholder_profit: { distribute: { org_wide: false, building_ids: ['b-ao'] } },
      income_expenses: { approve: { org_wide: true, building_ids: [] } },
    };
    settleDialog();
    fireEvent.change(field('accountId'), { target: { value: 'a1' } });
    expect((await screen.findByTestId('owner-payout-approve-only')).textContent).toMatch(/không phủ cả công ty/);
    expect(screen.queryByTestId('owner-payout-evidence')).toBeNull();
    fireEvent.click(button('Lập phiếu và duyệt'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(m.calls).toEqual(['settle', 'loadDetails', 'approve']);
  });

  it('không có quyền duyệt thu chi ⇒ không hứa Duyệt: chỉ lập phiếu chờ duyệt như trước', async () => {
    m.perms = { shareholder_profit: { distribute: { org_wide: true, building_ids: [] } } };
    settleDialog();
    fireEvent.change(field('accountId'), { target: { value: 'a1' } });
    expect((await screen.findByTestId('owner-payout-create-only')).textContent).toMatch(/chưa có quyền duyệt thu chi/);
    fireEvent.click(button('Lập phiếu chờ duyệt'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(m.calls).toEqual(['settle']);
    expect(vi.mocked(toast.success).mock.calls[0]![0]).toMatch(/Phiếu PC2611999 chờ duyệt, chưa chi tiền/);
  });

  it('máy chủ chặn người nhận tự chi (PROFIT_LEDGER_PAYEE_SELF_POST) ⇒ "Làm tiếp" hạ về chỉ Duyệt, không lập lại, không chi lại', async () => {
    m.approveAndPost.mockRejectedValueOnce({ code: '55000', message: 'PROFIT_LEDGER_PAYEE_SELF_POST: người nhận không tự chi' });
    settleDialog();
    fireEvent.change(field('accountId'), { target: { value: 'a1' } });
    await addImage();
    fireEvent.click(button('Duyệt và Chi'));
    const failure = await screen.findByTestId('owner-payout-step-failure');
    expect(failure.textContent).toMatch(/Người nhận tiền không tự chi khoản này/);
    expect(failure.textContent).toMatch(/để chỉ duyệt/);
    expect(screen.getByTestId('owner-payout-approve-only')).toBeTruthy();
    fireEvent.click(button('Làm tiếp'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(m.calls).toEqual(['settle', 'loadDetails', 'commit', 'approveAndPost', 'loadDetails', 'approve']);
    expect(m.approve).toHaveBeenCalledWith({ voucherId: 'v9', expectedApprovalVersion: 3, organizationId: 'org-a' });
  });

  it('thực chi = 0 (W2 trả SETTLED) ⇒ không có khối Duyệt và Chi, không có phiếu, không gọi duyệt / chi', async () => {
    m.zeroCash = true;
    m.settle.mockResolvedValue({
      settlement_id: 'st-0', through_month: '2026-10-01', recognized_amount: 100_000, advance_offset_amount: 100_000, cash_amount: 0,
      voucher_id: null, approval_request_id: null, state: 'SETTLED', code: null,
    });
    settleDialog();
    expect(screen.queryByTestId('owner-payout-posting')).toBeNull();
    fireEvent.click(button('Chốt, không ra tiền'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Xác nhận chốt' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(m.calls).toEqual(['settle']);
    expect(vi.mocked(toast.success).mock.calls[0]![0]).toMatch(/Không ra tiền — có hiệu lực ngay/);
  });
});

describe('hộp chi lương điều hành (sổ tổng chạy thật): cùng khối Duyệt và Chi', () => {
  const fill = () => {
    fireEvent.change(field('amount'), { target: { value: '800' } });
    fireEvent.change(field('accountId'), { target: { value: 'a1' } });
  };

  it('giữ sổ + có ảnh ⇒ lập (E11) → đọc lại → gắn ảnh → Duyệt và Chi đúng phiếu vừa lập', async () => {
    managerDialog();
    fill();
    await addImage();
    fireEvent.click(button('Duyệt và Chi'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(m.calls).toEqual(['managerCreate', 'loadDetails', 'commit', 'approveAndPost']);
    expect(m.commit).toHaveBeenCalledWith('vm1', { add: [URL_ANH], remove: [] });
    expect(m.approveAndPost).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 'vm1', cashbookId: 'a1', evidenceIds: ['ev-1'], organizationId: 'org-a' }));
    expect(vi.mocked(toast.success).mock.calls[0]![0]).toMatch(/Đã chi lương điều hành 800.*cho Quản lý 1: phiếu PCM1 đã duyệt và chi từ sổ Quỹ chủ.*còn lại: 1\.200/);
  });

  it('không giữ sổ ⇒ lập rồi chỉ duyệt', async () => {
    m.books = [];
    managerDialog();
    fill();
    await screen.findByTestId('owner-payout-approve-only');
    fireEvent.click(button('Lập phiếu và duyệt'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(m.calls).toEqual(['managerCreate', 'loadDetails', 'approve']);
    expect(m.approve).toHaveBeenCalledWith({ voucherId: 'vm1', expectedApprovalVersion: 3, organizationId: 'org-a' });
  });

  it('bước sau lỗi ⇒ "Làm tiếp" không lập phiếu lương thứ hai', async () => {
    m.approveAndPost.mockRejectedValueOnce({ code: '55000', message: 'approval_version mismatch (expected 3, found 4)' });
    managerDialog();
    fill();
    await addImage();
    fireEvent.click(button('Duyệt và Chi'));
    expect((await screen.findByTestId('owner-payout-step-failure')).textContent).toMatch(/Đã lập phiếu PCM1 — phiếu đang CHỜ DUYỆT/);
    fireEvent.click(button('Làm tiếp'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(m.managerCreate).toHaveBeenCalledTimes(1);
    expect(m.approveAndPost).toHaveBeenCalledTimes(2);
  });
});
