// @vitest-environment jsdom
// Hộp CHỐT "Chi lợi nhuận cổ đông" của chủ (không nhập tay số tiền), hộp "Chi tạm ứng cho tôi" của cổ đông,
// và hộp lương điều hành (giữ phép kiểm ngày nháp cũ). Dữ liệu GIẢ.
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SettleInput = { shareholderId: string | null; throughMonth: string | null; accountId: string | null; enabled?: boolean };
type AdvanceInput = { shareholderId: string | null; amount: number | null; accountId: string | null; enabled?: boolean };
type Month = { month: string; allocated: number; selectable: boolean; unpaid_through: number };
const MONTHS: Month[] = [
  { month: '2026-09-01', allocated: 60_000, selectable: true, unpaid_through: 60_000 },
  { month: '2026-10-01', allocated: 40_000, selectable: true, unpaid_through: 100_000 },
];
const m = vi.hoisted(() => ({
  settle: vi.fn(),
  advance: vi.fn(),
  voidSettle: vi.fn(),
  cancel: vi.fn(),
  managerCreate: vi.fn(),
  route: 'CANONICAL' as string,
  months: [] as { month: string; allocated: number; selectable: boolean; unpaid_through: number }[],
  /** Tạm ứng đã duyệt đang có / còn chờ duyệt của cổ đông. */
  advanceOutstanding: 40_000,
  advancePending: 0,
  overoffset: 0,
  markerMonth: null as string | null,
  settlements: [] as Record<string, unknown>[],
  reviewCount: 0,
  settleCalls: [] as { shareholderId: string | null; throughMonth: string | null; accountId: string | null }[],
  advanceCalls: [] as { shareholderId: string | null; amount: number | null; accountId: string | null }[],
  access: [] as { cashbook_id: string; possession_kind: string }[],
  /** Xem trước tạm ứng: lý do khoá, có trả số của cổ đông không. */
  advanceBlocked: null as string | null,
  hidePosition: false,
  // Xem trước đang tải lại (vẫn giữ số cũ) / lần tải lại lỗi (vẫn giữ số cũ).
  fetching: false,
  previewError: false,
  refetch: vi.fn(),
  /** Có thêm cổ đông thứ hai "Bình" (s2) trong sổ tổng; tháng riêng của từng cổ đông (mặc định dùng `months`). */
  secondShareholder: false,
  monthsBy: {} as Record<string, { month: string; allocated: number; selectable: boolean; unpaid_through: number }[]>,
  /**
   * Mô phỏng `placeholderData: keepPreviousData`: bật ⇒ khoá xem trước MỚI (cổ đông / tháng / sổ khác lần trước) chưa tải
   * xong — hook trả lại số của lần trước (có thể của cổ đông / tháng KHÁC) kèm isPlaceholderData + isFetching.
   */
  hold: false,
  /** Số giữ tạm kèm isFetching (mặc định) hay không (observer không tải — vd query đang tắt). */
  holdFetching: true,
  lastSettle: null as { key: string; data: Record<string, unknown> } | null,
  /** Tháng mà xem trước trả lỗi (khi chủ tự chọn) và lỗi trả về. */
  failMonth: null as string | null,
  failError: null as unknown,
  /** Xem trước tạm ứng kèm cảnh báo "vượt ước tính các tháng chưa chốt" của máy chủ. */
  exceedsEstimate: false,
}));
const ok = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, isSuccess: true, isFetching: false, isPlaceholderData: false, error: null, refetch: vi.fn() });
// Ô tick / hộp xác nhận của Radix đo kích thước bằng ResizeObserver — jsdom không có.
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => ok([
    { id: 'a1', name: 'Quỹ chủ', code: 'Q1', is_virtual: false, organization_id: 'org-a' },
    { id: 'a2', name: 'Quỹ người giữ', code: 'Q2', is_virtual: false, organization_id: 'org-a' },
    { id: 'a3', name: 'CỌC giữ hộ', code: 'Q3', is_virtual: true, organization_id: 'org-a' },
    { id: 'a4', name: 'Quỹ công ty khác', code: 'Q4', is_virtual: false, organization_id: 'org-b' },
  ]),
}));
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({ useMyCashbookAccessV2: () => ok(m.access) }));
vi.mock('@/hooks/useIncomeExpenses', () => ({ useCreateManagerSalaryPayout: () => ({ mutateAsync: m.managerCreate, isPending: false }) }));
vi.mock('@/hooks/profit-ledger/useProfitLedgerMutations', () => ({
  useSettleShareholderProfit: () => ({ mutateAsync: m.settle, isPending: false }),
  useCreateShareholderAdvance: () => ({ mutateAsync: m.advance, isPending: false }),
  useVoidProfitSettlement: () => ({ mutateAsync: m.voidSettle, isPending: false }),
  useCancelProfitLedgerPayout: () => ({ mutateAsync: m.cancel, isPending: false }),
}));
const positionOf = (unpaid: number) => ({
  unpaid_profit: unpaid, advance_outstanding: m.advanceOutstanding, advance_pending: m.advancePending, settlement_cash_pending: 0,
  balance: unpaid - m.advanceOutstanding - m.advancePending, settled: { recognized: 0, offset: 0, cash: 0 },
  last_settled_through_month: null, marker_month: m.markerMonth, needs_review: { count: m.reviewCount, suggested: 0 },
  components: { allocated: unpaid, payouts_pending: m.advancePending, payouts_approved: m.advanceOutstanding, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: unpaid - m.overoffset, advance_outstanding_raw: m.advanceOutstanding - m.overoffset, advance_overoffset: m.overoffset },
});
vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useShareholderProfitLedger: (org: string | null) => (org ? ok({
    organization_id: org, route: m.route, as_of: '2026-11-18T00:00:00Z',
    shareholders: [
      { shareholder_id: 's', name: 'An', is_active: true, is_deleted: false, has_login: true, marker: null, allocated: 0, payouts_approved: 0, payouts_pending: 0, salary_investment: 0, salary_advance_offset: 0, balance: 60_000, status: 'OWED', open_advance: 0, needs_review_count: m.reviewCount },
      ...(m.secondShareholder
        ? [{ shareholder_id: 's2', name: 'Bình', is_active: true, is_deleted: false, has_login: true, marker: null, allocated: 0, payouts_approved: 0, payouts_pending: 0, salary_investment: 0, salary_advance_offset: 0, balance: 30_000, status: 'OWED', open_advance: 0, needs_review_count: 0 }]
        : []),
      { shareholder_id: 'gone', name: 'Đã xoá', is_active: true, is_deleted: true, has_login: false, marker: null, allocated: 0, payouts_approved: 0, payouts_pending: 0, salary_investment: 0, salary_advance_offset: 0, balance: 5, status: 'OWED', open_advance: 0, needs_review_count: 0 },
    ],
  }) : { ...ok(undefined), status: 'pending', isSuccess: false }),
  // Dựng đúng luật máy chủ: X = luỹ kế của tháng, K = min(X, tạm ứng đang có), tiền = X − K.
  useProfitSettlementPreview: (input: SettleInput) => {
    m.settleCalls.push({ shareholderId: input.shareholderId, throughMonth: input.throughMonth, accountId: input.accountId });
    if (!input.shareholderId) return { ...ok(undefined), status: 'pending', isSuccess: false };
    // Tháng tự chọn mà máy chủ từ chối (vd 22023 SETTLE_MONTH): như react-query khi khoá mới lỗi — không còn số giữ tạm.
    if (input.throughMonth !== null && input.throughMonth === m.failMonth) {
      return { ...ok(undefined), status: 'error', isSuccess: false, isError: true, error: m.failError, refetch: m.refetch };
    }
    const key = `${input.shareholderId}|${input.throughMonth}|${input.accountId}`;
    if (m.hold && m.lastSettle && m.lastSettle.key !== key) {
      return { ...ok(m.lastSettle.data), isFetching: m.holdFetching, isPlaceholderData: true, refetch: m.refetch };
    }
    const months = m.monthsBy[input.shareholderId] ?? m.months;
    const through = input.throughMonth ?? months[months.length - 1]?.month ?? null;
    const row = months.find((x) => x.month === through);
    const recognized = row ? row.unpaid_through : null;
    const settleable = recognized !== null && recognized > 0;
    const offset = settleable ? Math.min(recognized, m.advanceOutstanding) : null;
    const cash = settleable && offset !== null ? recognized - offset : null;
    const selectable = months.filter((x) => x.selectable);
    const blocked = m.route !== 'CANONICAL' ? 'ROUTE'
      : m.reviewCount > 0 ? 'SALARY_REVIEW_PENDING'
      : !settleable ? 'NOTHING_TO_SETTLE'
      : cash !== null && cash > 0 && !input.accountId ? 'ACCOUNT_REQUIRED' : null;
    const data = {
      route: m.route, shareholder_id: input.shareholderId, months, min_through_month: selectable[0]?.month ?? null,
      through_month: through, position: positionOf(months[months.length - 1]?.unpaid_through ?? 0),
      recognized_amount: recognized, advance_offset_amount: offset, cash_amount: cash,
      advance_left: offset === null ? null : m.advanceOutstanding - offset, advance_pending: m.advancePending,
      settlements: m.settlements, can_submit: blocked === null, blocked_reason: blocked,
    };
    m.lastSettle = { key, data };
    return {
      ...ok(data),
      isFetching: m.fetching,
      isError: m.previewError,
      error: m.previewError ? { code: '40P01', message: 'deadlock detected' } : null,
      refetch: m.refetch,
    };
  },
  useShareholderAdvancePreview: (input: AdvanceInput) => {
    m.advanceCalls.push({ shareholderId: input.shareholderId, amount: input.amount, accountId: input.accountId });
    if (!input.shareholderId) return { ...ok(undefined), status: 'pending', isSuccess: false };
    const base = positionOf(100_000);
    const blocked = m.route !== 'CANONICAL' ? 'ROUTE' : m.advanceBlocked;
    return {
      ...ok({
        route: m.route, shareholder_id: input.shareholderId, maker_kind: 'CUSTODIAN_ADVANCE', payee_is_maker: true,
        can_submit: !blocked && input.amount !== null && !!input.accountId, blocked_reason: blocked,
        warnings: input.amount === null ? [] : [
          { code: 'ADVANCE', advance_amount: input.amount },
          ...(m.exceedsEstimate
            ? [{ code: 'ADVANCE_EXCEEDS_ESTIMATE', outstanding_advance: m.advanceOutstanding + m.advancePending + input.amount - 100_000, open_estimate: 0 }]
            : []),
          { code: 'NEEDS_OWNER_APPROVAL' },
        ],
        position: m.hidePosition ? null : {
          ...base,
          after_advance: input.amount === null ? null : { advance_pending: base.advance_pending + input.amount, balance: base.balance - input.amount },
        },
      }),
      isFetching: m.fetching,
      isError: m.previewError,
      error: m.previewError ? { code: '40P01', message: 'deadlock detected' } : null,
      refetch: m.refetch,
    };
  },
}));
vi.mock('@/components/ui/searchable-select', () => ({
  SearchableSelect: ({ options, onValueChange, value, name, disabled, ...props }: { options: { value: string; label: string }[]; onValueChange: (s: string) => void; name: string; value: string; disabled?: boolean; 'aria-invalid'?: boolean }) => (
    <select name={name} aria-invalid={props['aria-invalid']} disabled={disabled} value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="">Chọn</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import ProfitDistributeDialog from '../ProfitDistributeDialog';
import ProfitSelfAdvanceDialog from '../ProfitSelfAdvanceDialog';
import ManagerSalaryPayoutDialog from '../ManagerSalaryPayoutDialog';
import { toast } from 'sonner';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { ProfitLedgerPriorWrittenError } from '@/lib/profitLedger/errors';

const ownerProps = { onOpenChange: vi.fn(), organizationId: 'org-a' };
const select = (name: string) => document.querySelector(`[name="${name}"]`) as HTMLSelectElement | null;
const optionsOf = (name: string) => Array.from(select(name)!.options).map((o) => o.value).filter(Boolean);
const submitButton = (name = 'Lập phiếu chờ duyệt') => screen.getByRole('button', { name }) as HTMLButtonElement;
const text = (testId: string) => screen.getByTestId(testId).textContent ?? '';
const pickAccount = (id = 'a1') => fireEvent.change(select('accountId')!, { target: { value: id } });
const noteInput = () => document.querySelector('[name="note"]') as HTMLTextAreaElement;

beforeEach(() => {
  m.route = 'CANONICAL'; m.months = MONTHS.map((x) => ({ ...x })); m.advanceOutstanding = 40_000; m.advancePending = 0; m.overoffset = 0;
  m.markerMonth = '2026-08-01'; m.settlements = []; m.reviewCount = 0; m.settleCalls = []; m.advanceCalls = []; m.access = [];
  m.advanceBlocked = null; m.hidePosition = false; m.fetching = false; m.previewError = false;
  m.secondShareholder = false; m.monthsBy = {}; m.hold = false; m.holdFetching = true; m.lastSettle = null; m.failMonth = null; m.failError = null;
  m.exceedsEstimate = false;
  m.settle.mockResolvedValue({ settlement_id: 'st-9', through_month: '2026-10-01', recognized_amount: 100_000, advance_offset_amount: 40_000, cash_amount: 60_000, voucher_id: 'v9', approval_request_id: 'r9', state: 'PENDING_APPROVAL', code: 'PC2611999' });
  m.advance.mockResolvedValue({ voucher_id: 'v8', code: 'PC2611888', amount: 50_000, within_amount: 0, advance_amount: 50_000, balance_before: 60_000, maker_kind: 'CUSTODIAN_ADVANCE' });
  m.voidSettle.mockResolvedValue({ settlement_id: 'st-0', state: 'VOID' });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('hộp chốt Chi lợi nhuận cổ đông (chủ)', () => {
  const dialog = (extra: Record<string, unknown> = {}) => <ProfitDistributeDialog open {...ownerProps} defaultShareholderId="s" {...extra} />;

  it('trống thì focus cổ đông, không gọi lệnh chốt', async () => {
    render(<ProfitDistributeDialog open {...ownerProps} />);
    fireEvent.click(submitButton());
    await waitFor(() => expect(document.activeElement?.getAttribute('name')).toBe('shareholderId'));
    expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');
    expect(m.settle).not.toHaveBeenCalled();
  });
  it('KHÔNG có ô nhập số tiền; chỉ cổ đông còn hiệu lực; sổ quỹ chỉ sổ TIỀN THẬT của đúng công ty', () => {
    render(dialog());
    expect(document.querySelector('[name="amount"]')).toBeNull();
    expect(optionsOf('shareholderId')).toEqual(['s']);
    expect(optionsOf('accountId')).toEqual(['a1', 'a2']);
  });
  it('mở hộp: máy chủ chọn tháng (không gửi tháng), hiện ba dòng máy tính, thực chi không sửa được', () => {
    render(dialog());
    expect(m.settleCalls.some((c) => c.shareholderId === 's' && c.throughMonth === null)).toBe(true);
    expect(m.settleCalls.every((c) => c.throughMonth === null)).toBe(true);
    expect(select('throughMonth')!.value).toBe('2026-10-01');
    expect(text('profit-settle-preview')).toContain('Lợi nhuận chưa chi đến hết 10/2026');
    expect(text('profit-settle-recognized')).toMatch(/100\.000/);
    expect(text('profit-settle-offset')).toMatch(/40\.000/);
    expect(text('profit-settle-cash')).toMatch(/60\.000/);
    expect(within(screen.getByTestId('profit-settle-preview')).queryByRole('textbox')).toBeNull();
    expect(within(screen.getByTestId('profit-settle-preview')).queryByRole('spinbutton')).toBeNull();
  });
  it('có tiền thực chi mà chưa chọn sổ ⇒ không gửi; chọn sổ ⇒ gửi CẢ hai số đang hiện', async () => {
    render(dialog());
    fireEvent.click(submitButton());
    await waitFor(() => expect(select('accountId')!.getAttribute('aria-invalid')).toBe('true'));
    expect(m.settle).not.toHaveBeenCalled();
    pickAccount();
    fireEvent.click(submitButton());
    await waitFor(() => expect(m.settle).toHaveBeenCalledTimes(1));
    expect(m.settle).toHaveBeenCalledWith({
      organizationId: 'org-a', shareholderId: 's', throughMonth: '2026-10-01', expectedRecognized: 100_000, expectedCash: 60_000,
      accountId: 'a1', voucherDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), note: null,
    });
    await waitFor(() => expect(ownerProps.onOpenChange).toHaveBeenCalledWith(false));
    expect(vi.mocked(toast.success).mock.calls[0]![0]).toMatch(/Đã chốt chi lợi nhuận đến hết 10\/2026 cho An.*khấu trừ tạm ứng 40\.000.*thực chi 60\.000.*PC2611999 chờ duyệt/);
  });
  it('chủ đổi sang tháng chọn được khác ⇒ xem trước đúng tháng đó, gửi đúng số của tháng đó', async () => {
    render(dialog());
    fireEvent.change(select('throughMonth')!, { target: { value: '2026-09-01' } });
    await waitFor(() => expect(text('profit-settle-recognized')).toMatch(/60\.000/));
    expect(m.settleCalls.some((c) => c.throughMonth === '2026-09-01')).toBe(true);
    expect(text('profit-settle-cash')).toMatch(/20\.000/);
    pickAccount('a2');
    m.settle.mockResolvedValueOnce({ settlement_id: 'st-9', through_month: '2026-09-01', recognized_amount: 60_000, advance_offset_amount: 40_000, cash_amount: 20_000, voucher_id: 'v9', approval_request_id: 'r9', state: 'PENDING_APPROVAL', code: null });
    fireEvent.click(submitButton());
    await waitFor(() => expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ throughMonth: '2026-09-01', expectedRecognized: 60_000, expectedCash: 20_000, accountId: 'a2' })));
  });
  it('thực chi = 0: không có ô sổ quỹ / ngày; "Chốt, không ra tiền" phải qua bước xác nhận', async () => {
    m.advanceOutstanding = 150_000;
    m.settle.mockResolvedValue({ settlement_id: 'st-9', through_month: '2026-10-01', recognized_amount: 100_000, advance_offset_amount: 100_000, cash_amount: 0, voucher_id: null, approval_request_id: null, state: 'SETTLED', code: null });
    render(dialog());
    expect(text('profit-settle-cash')).toMatch(/^0/);
    expect(select('accountId')).toBeNull();
    expect(document.querySelector('[name="voucherDate"]')).toBeNull();
    expect(screen.getByTestId('profit-settle-zero-cash')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lập phiếu chờ duyệt' })).toBeNull();
    fireEvent.click(submitButton('Chốt, không ra tiền'));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toMatch(/đến hết 10\/2026 cho An/);
    expect(confirm.textContent).toMatch(/có hiệu lực ngay/);
    expect(m.settle).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Quay lại' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(m.settle).not.toHaveBeenCalled();
    fireEvent.click(submitButton('Chốt, không ra tiền'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Xác nhận chốt' }));
    await waitFor(() => expect(m.settle).toHaveBeenCalledTimes(1));
    expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ expectedRecognized: 100_000, expectedCash: 0, accountId: null, voucherDate: null }));
    await waitFor(() => expect(vi.mocked(toast.success).mock.calls[0]![0]).toMatch(/Không ra tiền — có hiệu lực ngay/));
  });
  it('PT409 số liệu vừa đổi ⇒ báo, tải lại xem trước, KHÔNG tự gửi lại, hộp không đóng', async () => {
    m.settle.mockRejectedValueOnce({ code: 'PT409', message: 'PROFIT_LEDGER_SETTLE_CHANGED: số liệu vừa đổi so với lúc xem trước — tải lại rồi xem trước lần nữa', details: '{"cash_amount": 40000, "expected_cash": 60000}' });
    render(dialog());
    pickAccount();
    fireEvent.click(submitButton());
    expect(await screen.findByText(/Số liệu vừa đổi so với lúc xem trước — chưa chốt gì/)).toBeTruthy();
    expect(m.refetch).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(m.settle).toHaveBeenCalledTimes(1);
    expect(ownerProps.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.queryByRole('button', { name: 'Kiểm tra lại kết quả' })).toBeNull();
    // Chủ xem số mới rồi tự bấm lại: là một lần gửi mới.
    fireEvent.click(submitButton());
    await waitFor(() => expect(m.settle).toHaveBeenCalledTimes(2));
  });
  it('tháng mặc định không còn gì để chốt ⇒ nói rõ, khoá gửi, KHÔNG tự nhảy sang tháng sớm hơn', async () => {
    m.months = [
      { month: '2026-09-01', allocated: 100_000, selectable: true, unpaid_through: 100_000 },
      { month: '2026-10-01', allocated: -120_000, selectable: false, unpaid_through: -20_000 },
    ];
    render(dialog());
    expect(text('profit-settle-nothing')).toMatch(/không còn gì để chi/);
    expect(text('profit-settle-nothing')).toMatch(/tự chọn/);
    expect(select('throughMonth')!.value).toBe('2026-10-01');
    expect(optionsOf('throughMonth')).toEqual(['2026-10-01', '2026-09-01']);
    expect(screen.queryByTestId('profit-settle-cash')).toBeNull();
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    expect(m.settleCalls.every((c) => c.throughMonth === null)).toBe(true);
  });
  it('cổ đông không còn tháng nào đủ điều kiện ⇒ nói rõ, khoá gửi', async () => {
    m.months = [];
    render(dialog());
    expect(text('profit-settle-nothing')).toMatch(/chưa có tháng nào chốt chi được/);
    expect(select('throughMonth')!.disabled).toBe(true);
    await waitFor(() => expect(submitButton().disabled).toBe(true));
  });
  it('chưa có mốc và chưa chốt lần nào ⇒ nhắc đặt mốc trước (không chặn); có mốc hoặc đã chốt thì không nhắc', () => {
    m.markerMonth = null;
    const onSetMarker = vi.fn();
    const view = render(dialog({ onSetMarker }));
    expect(text('profit-settle-marker-reminder')).toMatch(/TOÀN BỘ phần được chia từ đầu/);
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Đặt mốc trước' }));
    expect(onSetMarker).toHaveBeenCalledWith('s');
    view.unmount();
    m.settlements = [{ id: 'st-0', through_month: '2026-09-01', recognized_amount: 60_000, advance_offset_amount: 60_000, cash_amount: 0, cash_voucher_id: null, cash_voucher_code: null, cash_voucher_status: null, cash_voucher_posting_status: null, created_at: '2026-11-01T00:00:00Z', excluded_by_marker: false }];
    const again = render(dialog({ onSetMarker }));
    expect(screen.queryByTestId('profit-settle-marker-reminder')).toBeNull();
    again.unmount();
    m.settlements = []; m.markerMonth = '2026-08-01';
    render(dialog({ onSetMarker }));
    expect(screen.queryByTestId('profit-settle-marker-reminder')).toBeNull();
  });
  it('còn tạm ứng chờ duyệt ⇒ nhắc chưa được khấu trừ (không chặn)', () => {
    m.advancePending = 15_000;
    render(dialog());
    expect(text('profit-settle-pending-advance')).toMatch(/Còn 15\.000.*tạm ứng chờ duyệt — chưa được khấu trừ/);
    expect(submitButton().disabled).toBe(false);
  });
  it('lần chốt không phiếu tiền: "Huỷ chốt" đòi lý do 8 ký tự; lần có phiếu: mở hộp huỷ phiếu chi', async () => {
    m.settlements = [
      { id: 'st-0', through_month: '2026-09-01', recognized_amount: 60_000, advance_offset_amount: 60_000, cash_amount: 0, cash_voucher_id: null, cash_voucher_code: null, cash_voucher_status: null, cash_voucher_posting_status: null, created_at: '2026-11-01T00:00:00Z', excluded_by_marker: false },
      { id: 'st-1', through_month: '2026-08-01', recognized_amount: 30_000, advance_offset_amount: 0, cash_amount: 30_000, cash_voucher_id: 'v-cash', cash_voucher_code: 'PC2611001', cash_voucher_status: 'UNAPPROVED', cash_voucher_posting_status: 'UNPOSTED', created_at: '2026-10-01T00:00:00Z', excluded_by_marker: false },
    ];
    render(dialog());
    const voidRow = screen.getByTestId('profit-settle-row-st-0');
    expect(voidRow.textContent).toMatch(/Đến hết 09\/2026.*Không ra tiền/);
    fireEvent.click(within(voidRow).getByRole('button', { name: 'Huỷ chốt' }));
    const voidDialog = (await screen.findByText('Huỷ lần chốt chi lợi nhuận')).closest('[role="dialog"]') as HTMLElement;
    const reason = voidDialog.querySelector('[name="reason"]') as HTMLTextAreaElement;
    fireEvent.change(reason, { target: { value: 'ngắn' } });
    fireEvent.click(within(voidDialog).getByRole('button', { name: 'Huỷ chốt' }));
    await waitFor(() => expect(reason.getAttribute('aria-invalid')).toBe('true'));
    expect(m.voidSettle).not.toHaveBeenCalled();
    fireEvent.change(reason, { target: { value: 'Chốt nhầm tháng, chốt lại sau' } });
    fireEvent.click(within(voidDialog).getByRole('button', { name: 'Huỷ chốt' }));
    await waitFor(() => expect(m.voidSettle).toHaveBeenCalledWith({ organizationId: 'org-a', settlementId: 'st-0', reason: 'Chốt nhầm tháng, chốt lại sau' }));
    await waitFor(() => expect(m.refetch).toHaveBeenCalled());
    const cashRow = screen.getByTestId('profit-settle-row-st-1');
    expect(cashRow.textContent).toMatch(/Phiếu chi chờ duyệt · phiếu PC2611001/);
    expect(within(cashRow).queryByRole('button', { name: 'Huỷ chốt' })).toBeNull();
    fireEvent.click(within(cashRow).getByRole('button', { name: 'Huỷ phiếu chi' }));
    expect(await screen.findByText('Huỷ phiếu chi lợi nhuận')).toBeTruthy();
    expect(m.cancel).not.toHaveBeenCalled();
  });
  it('chưa rõ kết quả ⇒ khoá gửi mới, "Kiểm tra lại kết quả" gửi lại ĐÚNG nội dung; giữ nguyên khi đóng/mở', async () => {
    m.settle.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận được kết quả chốt chi lợi nhuận.', 'unknown', []));
    const view = render(dialog());
    pickAccount();
    fireEvent.change(noteInput(), { target: { value: 'Chốt đợt tháng 10' } });
    fireEvent.click(submitButton());
    expect(await screen.findByRole('button', { name: 'Kiểm tra lại kết quả' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lập phiếu chờ duyệt' })).toBeNull();
    expect(noteInput().closest('fieldset')?.disabled).toBe(true);
    view.rerender(<ProfitDistributeDialog open={false} {...ownerProps} defaultShareholderId="s" />);
    view.rerender(dialog());
    expect(noteInput().value).toBe('Chốt đợt tháng 10');
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra lại kết quả' }));
    await waitFor(() => expect(m.settle).toHaveBeenCalledTimes(2));
    expect(m.settle.mock.calls[1]![0]).toEqual(m.settle.mock.calls[0]![0]);
  });
  it('máy chủ báo lần gửi trước đã ghi ⇒ báo "tải lại để xem", KHÔNG khoá', async () => {
    m.settle.mockRejectedValueOnce(new ProfitLedgerPriorWrittenError('settle'));
    render(dialog());
    pickAccount();
    fireEvent.click(submitButton());
    expect(await screen.findByText(/Yêu cầu trước đó đã được ghi; tải lại để xem/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Kiểm tra lại kết quả' })).toBeNull();
    expect(m.refetch).toHaveBeenCalled();
  });
  it.each(['LEGACY', 'SHADOW', 'FROZEN'])('route %s ⇒ khoá nút gửi + câu báo', async (route) => {
    m.route = route;
    render(dialog());
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    expect(screen.getAllByRole('status').some((n) => /Sổ tổng|mốc/.test(n.textContent ?? ''))).toBe(true);
  });
  it('còn phiếu lương cần xem lại ⇒ khoá gửi, có lối "Xem lại phần lương"', async () => {
    m.reviewCount = 2;
    const onReviewSalary = vi.fn();
    render(dialog({ onReviewSalary }));
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Xem lại phần lương' }));
    expect(onReviewSalary).toHaveBeenCalledWith('s');
  });
  it('đang tải lại số chốt ⇒ không gửi theo số cũ; tải xong thì gửi được', async () => {
    const view = render(dialog());
    pickAccount();
    m.fetching = true;
    view.rerender(dialog());
    expect(screen.getByText(/Đang tính lại/)).toBeTruthy();
    fireEvent.click(submitButton());
    expect(await screen.findByText(/Đang tính số chốt — đợi kết quả rồi bấm lại/)).toBeTruthy();
    expect(m.settle).not.toHaveBeenCalled();
    m.fetching = false;
    view.rerender(dialog());
    await waitFor(() => expect(screen.queryByText(/Đang tính số chốt — đợi kết quả/)).toBeNull());
    fireEvent.click(submitButton());
    await waitFor(() => expect(m.settle).toHaveBeenCalledTimes(1));
  });
  it('tải lại lỗi ⇒ không gửi theo số cũ; có nút "Tính lại"', async () => {
    const view = render(dialog());
    pickAccount();
    m.previewError = true;
    view.rerender(dialog());
    fireEvent.click(submitButton());
    expect(await screen.findByText(/Chưa tính được số chốt/)).toBeTruthy();
    expect(m.settle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Tính lại' }));
    expect(m.refetch).toHaveBeenCalled();
  });
  it('ngày chi nháp sai: không gửi, giữ text, focus ô ngày', async () => {
    render(dialog());
    pickAccount();
    const date = document.querySelector('[name="voucherDate"]') as HTMLInputElement;
    fireEvent.change(date, { target: { value: '31/02/2026' } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(document.activeElement).toBe(date));
    expect(date.value).toBe('31/02/2026');
    expect(m.settle).not.toHaveBeenCalled();
  });

  // R5 (review chéo 18/11) — mức hộp thoại; hook giả trả đúng thứ hook thật ném ở lượt đối chiếu (hook thật + máy chủ
  // giả: ProfitDistributeDialog.reconcile.test.tsx).
  it('"Kiểm tra lại kết quả" gặp PT409 số liệu vừa đổi (lần trước CHƯA ghi) ⇒ gỡ khoá, tải lại xem trước, không còn nút đối chiếu', async () => {
    m.settle
      .mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận được kết quả chốt chi lợi nhuận.', 'unknown', []))
      .mockRejectedValueOnce({ code: 'PT409', message: 'PROFIT_LEDGER_SETTLE_CHANGED: số liệu vừa đổi so với lúc xem trước — tải lại rồi xem trước lần nữa', details: '{"cash_amount": 40000, "expected_cash": 60000}' });
    render(dialog());
    pickAccount();
    fireEvent.click(submitButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Kiểm tra lại kết quả' }));
    expect(await screen.findByText(/Số liệu vừa đổi so với lúc xem trước — chưa chốt gì/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Kiểm tra lại kết quả' })).toBeNull();
    expect(submitButton().disabled).toBe(false);
    expect(noteInput().closest('fieldset')?.disabled).toBe(false);
    expect(m.refetch).toHaveBeenCalled();
    expect(m.settle).toHaveBeenCalledTimes(2);
    expect(ownerProps.onOpenChange).not.toHaveBeenCalledWith(false);
  });
  it('"Kiểm tra lại kết quả" gặp lỗi khác (hook vẫn báo chưa rõ kết quả: mất mạng, 55000…) ⇒ VẪN khoá', async () => {
    m.settle
      .mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận được kết quả chốt chi lợi nhuận.', 'unknown', []))
      .mockRejectedValueOnce(new FinancialWorkflowError('Chưa đối chiếu xong yêu cầu chốt chi lợi nhuận trước đó.', 'unknown', [], { code: '55000', message: 'PROFIT_LEDGER_FROZEN: x' }));
    render(dialog());
    pickAccount();
    fireEvent.click(submitButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Kiểm tra lại kết quả' }));
    await waitFor(() => expect(m.settle).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Kiểm tra lại kết quả' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lập phiếu chờ duyệt' })).toBeNull();
    expect(noteInput().closest('fieldset')?.disabled).toBe(true);
  });

  // R6 (review chéo 18/11): tháng tự chọn mà xem trước lỗi ⇒ về tháng mặc định, không khoá ô tháng.
  it.each([
    ['22023 PROFIT_LEDGER_SETTLE_MONTH', { code: '22023', message: 'PROFIT_LEDGER_SETTLE_MONTH: tháng chốt phải là tháng đã chốt lợi nhuận của cổ đông', details: '{"through_month": "2026-09-01", "min": "2026-10-01", "max": "2026-10-01"}' }, /Tháng này chưa chốt chi được/],
    ['lỗi bất kỳ (mất mạng)', { code: '', message: 'FetchError: Failed to fetch' }, /Mất kết nối/],
  ])('tháng tự chọn mà xem trước lỗi (%s) ⇒ quay về tháng mặc định của máy chủ, nói vì sao, ô tháng không khoá', async (_name, error, reason) => {
    m.failMonth = '2026-09-01';
    m.failError = error;
    render(dialog());
    expect(select('throughMonth')!.value).toBe('2026-10-01');
    fireEvent.change(select('throughMonth')!, { target: { value: '2026-09-01' } });
    expect(m.settleCalls.some((c) => c.throughMonth === '2026-09-01')).toBe(true);
    const notice = await screen.findByTestId('profit-settle-month-reset');
    expect(notice.textContent).toMatch(/Đã quay về tháng mặc định vì không xem trước được tháng 09\/2026/);
    expect(notice.textContent).toMatch(reason);
    expect(m.settleCalls.at(-1)).toMatchObject({ shareholderId: 's', throughMonth: null });
    await waitFor(() => expect(select('throughMonth')!.value).toBe('2026-10-01'));
    expect(select('throughMonth')!.disabled).toBe(false);
    expect(text('profit-settle-recognized')).toMatch(/100\.000/);
    // Chủ chọn lại tháng khác: câu báo cũ biến mất.
    m.failMonth = null;
    fireEvent.change(select('throughMonth')!, { target: { value: '2026-09-01' } });
    await waitFor(() => expect(text('profit-settle-recognized')).toMatch(/60\.000/));
    expect(screen.queryByTestId('profit-settle-month-reset')).toBeNull();
  });

  // R8 (review chéo 18/11): đổi cổ đông / đổi tháng — hook giả mô phỏng keepPreviousData (số giữ tạm của lần trước,
  // kèm isPlaceholderData): số của cổ đông / tháng CŨ không được hiện như số mới, không được gửi.
  it('đổi cổ đông: số giữ tạm là của cổ đông CŨ ⇒ không hiện, không gửi; tải xong thì gửi đúng số của cổ đông mới', async () => {
    m.secondShareholder = true;
    m.monthsBy = { s2: [{ month: '2026-10-01', allocated: 70_000, selectable: true, unpaid_through: 70_000 }] };
    const view = render(dialog());
    pickAccount();
    expect(text('profit-settle-recognized')).toMatch(/100\.000/);
    m.hold = true;
    fireEvent.change(select('shareholderId')!, { target: { value: 's2' } });
    expect(m.settleCalls.at(-1)).toMatchObject({ shareholderId: 's2', throughMonth: null });
    // Hook đang trả số của "An" (100.000 / 60.000) kèm isPlaceholderData: hộp không hiện số đó cho "Bình".
    expect(screen.queryByTestId('profit-settle-recognized')).toBeNull();
    expect(screen.queryByTestId('profit-settle-cash')).toBeNull();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/100\.000|60\.000/);
    fireEvent.click(submitButton());
    expect(await screen.findByText(/Đang tính số chốt — đợi kết quả rồi bấm lại/)).toBeTruthy();
    expect(m.settle).not.toHaveBeenCalled();
    m.hold = false;
    view.rerender(dialog());
    await waitFor(() => expect(text('profit-settle-recognized')).toMatch(/70\.000/));
    expect(text('profit-settle-cash')).toMatch(/30\.000/);
    m.settle.mockResolvedValueOnce({ settlement_id: 'st-8', through_month: '2026-10-01', recognized_amount: 70_000, advance_offset_amount: 40_000, cash_amount: 30_000, voucher_id: 'v8', approval_request_id: 'r8', state: 'PENDING_APPROVAL', code: null });
    fireEvent.click(submitButton());
    await waitFor(() => expect(m.settle).toHaveBeenCalledTimes(1));
    expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ shareholderId: 's2', throughMonth: '2026-10-01', expectedRecognized: 70_000, expectedCash: 30_000 }));
  });
  it('đổi tháng: số giữ tạm là của tháng CŨ ⇒ không hiện, không gửi, ô tháng không khoá chớp; tải xong gửi đúng số tháng mới', async () => {
    const view = render(dialog());
    pickAccount();
    m.hold = true;
    fireEvent.change(select('throughMonth')!, { target: { value: '2026-09-01' } });
    expect(m.settleCalls.at(-1)).toMatchObject({ shareholderId: 's', throughMonth: '2026-09-01' });
    expect(screen.queryByTestId('profit-settle-recognized')).toBeNull();
    expect(select('throughMonth')!.disabled).toBe(false);
    expect(select('throughMonth')!.value).toBe('2026-09-01');
    fireEvent.click(submitButton());
    expect(await screen.findByText(/Đang tính số chốt — đợi kết quả rồi bấm lại/)).toBeTruthy();
    expect(m.settle).not.toHaveBeenCalled();
    m.hold = false;
    view.rerender(dialog());
    await waitFor(() => expect(text('profit-settle-recognized')).toMatch(/60\.000/));
    m.settle.mockResolvedValueOnce({ settlement_id: 'st-7', through_month: '2026-09-01', recognized_amount: 60_000, advance_offset_amount: 40_000, cash_amount: 20_000, voucher_id: 'v7', approval_request_id: 'r7', state: 'PENDING_APPROVAL', code: null });
    fireEvent.click(submitButton());
    await waitFor(() => expect(m.settle).toHaveBeenCalledTimes(1));
    expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ shareholderId: 's', throughMonth: '2026-09-01', expectedRecognized: 60_000, expectedCash: 20_000 }));
  });
  it.each([
    ['đang tải', true],
    // Observer không tải (vd query đang tắt) vẫn có thể trả số giữ tạm: chỉ cờ isPlaceholderData chặn được.
    ['không đang tải', false],
  ])('đổi sổ quỹ: số giữ tạm (%s) của ĐÚNG cổ đông + tháng vẫn hiện (không chớp) nhưng chưa gửi được cho tới khi tải xong', async (_name, fetching) => {
    const view = render(dialog());
    pickAccount('a1');
    m.hold = true;
    m.holdFetching = fetching;
    pickAccount('a2');
    expect(text('profit-settle-cash')).toMatch(/60\.000/);
    fireEvent.click(submitButton());
    expect(await screen.findByText(/Đang tính số chốt — đợi kết quả rồi bấm lại/)).toBeTruthy();
    expect(m.settle).not.toHaveBeenCalled();
    m.hold = false;
    view.rerender(dialog());
    await waitFor(() => expect(screen.queryByText(/Đang tính số chốt — đợi kết quả/)).toBeNull());
    fireEvent.click(submitButton());
    await waitFor(() => expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a2', expectedRecognized: 100_000, expectedCash: 60_000 })));
  });
});

describe('hộp Chi tạm ứng cho tôi (cổ đông có quyền tạm ứng)', () => {
  const me = { shareholderId: 's', name: 'An' };
  const dialog = () => <ProfitSelfAdvanceDialog open onOpenChange={ownerProps.onOpenChange} organizationId="org-a" me={me} />;
  const amountInput = () => document.querySelector('[name="amount"]') as HTMLInputElement;
  const fill = async (value: string) => {
    fireEvent.change(amountInput(), { target: { value } });
    pickAccount('a2');
    // Đợi lần xem trước khớp số đang nhập (chờ 400 ms).
    await screen.findByTestId('profit-advance-after', undefined, { timeout: 2000 });
  };
  beforeEach(() => { m.access = [{ cashbook_id: 'a2', possession_kind: 'CUSTODIAN' }]; });

  it('chỉ sổ đang GIỮ (CUSTODIAN), cùng công ty, không ảo; người nhận cố định là mình', () => {
    m.access = [
      { cashbook_id: 'a2', possession_kind: 'CUSTODIAN' },
      { cashbook_id: 'a1', possession_kind: 'KNOWER' },
      { cashbook_id: 'a3', possession_kind: 'CUSTODIAN' },
      { cashbook_id: 'a4', possession_kind: 'CUSTODIAN' },
    ];
    render(dialog());
    expect(optionsOf('accountId')).toEqual(['a2']);
    expect(select('shareholderId')).toBeNull();
    expect(within(screen.getByRole('dialog')).getByText('An')).toBeTruthy();
  });
  it('KHÔNG còn ô tick xác nhận phần vượt; ghi chú không bắt buộc; hiện hai con số của mình', async () => {
    render(dialog());
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(text('profit-advance-position')).toMatch(/Lợi nhuận chưa chi: 100\.000.*Tạm ứng đang có: 40\.000/);
    await fill('50000');
    expect(text('profit-advance-after')).toMatch(/tạm ứng chờ duyệt 50\.000.*tổng tạm ứng 90\.000/);
    expect(screen.queryByTestId('profit-advance-over')).toBeNull();
    fireEvent.click(submitButton());
    await waitFor(() => expect(m.advance).toHaveBeenCalledTimes(1));
    expect(m.advance).toHaveBeenCalledWith({
      organizationId: 'org-a', shareholderId: 's', amount: 50_000, accountId: 'a2', voucherDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), note: null,
    });
    await waitFor(() => expect(vi.mocked(toast.success).mock.calls[0]![0]).toMatch(/phiếu PC2611888 tạm ứng 50\.000.*chờ chủ duyệt/));
  });
  it('ứng vượt lợi nhuận chưa chi ⇒ chỉ CẢNH BÁO, vẫn gửi được không cần lý do', async () => {
    render(dialog());
    await fill('80000');
    // 40.000 đang có + 80.000 chờ duyệt − 100.000 chưa chi = vượt 20.000
    expect(text('profit-advance-over')).toMatch(/Ứng vượt lợi nhuận chưa chi 20\.000/);
    expect(noteInput().value).toBe('');
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() => expect(m.advance).toHaveBeenCalledWith(expect.objectContaining({ amount: 80_000, note: null })));
  });
  it('máy chủ kèm cảnh báo "vượt ước tính" ⇒ vẫn chỉ MỘT câu cảnh báo dễ hiểu (không còn câu "ước tính các tháng chưa chốt")', async () => {
    m.exceedsEstimate = true;
    render(dialog());
    await fill('80000');
    const box = screen.getByTestId('profit-advance-preview');
    expect(text('profit-advance-over')).toBe('Ứng vượt lợi nhuận chưa chi 20.000 đ — vẫn lập được, phiếu chờ chủ duyệt.');
    expect(box.textContent).not.toMatch(/ước tính|còn treo/);
    expect(within(box).getAllByText(/vượt/)).toHaveLength(1);
  });
  it('có quyền tạm ứng mà chưa giữ sổ nào ⇒ chỉ đường (nhờ người giữ sổ lập Tạm Ứng ở Thu chi) và khoá gửi', async () => {
    m.access = [{ cashbook_id: 'a1', possession_kind: 'KNOWER' }];
    render(dialog());
    expect(text('profit-advance-no-cashbook')).toBe('Bạn chưa giữ sổ quỹ nào — nhờ người đang giữ sổ quỹ lập phiếu Tạm Ứng cho bạn ở Thu chi.');
    expect(screen.queryByText(/chưa tạm ứng được/)).toBeNull();
    await waitFor(() => expect(submitButton().disabled).toBe(true));
  });
  it.each([
    ['SALARY_REVIEW_PENDING', /phiếu lương cần chủ xem lại/],
    ['PAYEE_NO_RIGHT', /Bạn chưa được cấp quyền tạm ứng/],
    ['NOT_CUSTODIAN', /sổ quỹ bạn đang giữ/],
  ])('máy chủ báo %s ⇒ câu tại chỗ + khoá gửi', async (reason, pattern) => {
    m.advanceBlocked = reason;
    render(dialog());
    expect(text('profit-advance-blocked')).toMatch(pattern);
    await waitFor(() => expect(submitButton().disabled).toBe(true));
  });
  it('sổ tổng chưa chạy thật ⇒ khoá + banner', async () => {
    m.route = 'SHADOW';
    render(dialog());
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    expect(screen.getAllByRole('status').some((n) => /mốc|Sổ tổng/.test(n.textContent ?? ''))).toBe(true);
  });
  it('máy chủ từ chối (người nhận chưa có quyền) ⇒ câu tiếng Việt, không khoá, không đóng', async () => {
    m.advance.mockRejectedValueOnce({ code: '42501', message: 'PROFIT_LEDGER_ADVANCE_PAYEE_NO_RIGHT: người nhận chưa được cấp quyền tạm ứng' });
    render(dialog());
    await fill('50000');
    fireEvent.click(submitButton());
    expect((await screen.findByTestId('profit-advance-failure')).textContent).toMatch(/chưa được cấp quyền tạm ứng/);
    expect(screen.queryByRole('button', { name: 'Kiểm tra lại kết quả' })).toBeNull();
    expect(ownerProps.onOpenChange).not.toHaveBeenCalledWith(false);
  });
  it('chưa rõ kết quả ⇒ khoá gửi mới, chỉ còn "Kiểm tra lại kết quả"', async () => {
    m.advance.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận được kết quả lập phiếu tạm ứng.', 'unknown', []));
    render(dialog());
    await fill('50000');
    fireEvent.click(submitButton());
    expect(await screen.findByRole('button', { name: 'Kiểm tra lại kết quả' })).toBeTruthy();
    expect(amountInput().closest('fieldset')?.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra lại kết quả' }));
    await waitFor(() => expect(m.advance).toHaveBeenCalledTimes(2));
    expect(m.advance.mock.calls[1]![0]).toEqual(m.advance.mock.calls[0]![0]);
  });
  it('đang kiểm tra lại ⇒ không gửi theo lần kiểm cũ', async () => {
    const view = render(dialog());
    await fill('50000');
    m.fetching = true;
    view.rerender(dialog());
    fireEvent.click(submitButton());
    expect(await screen.findByText(/Đang kiểm tra phiếu tạm ứng này/)).toBeTruthy();
    expect(m.advance).not.toHaveBeenCalled();
  });
});

// U2 (18/11): hàng nút cuối của hai hộp dài dính đáy hộp (thân cuộn, nút luôn thấy — kiểu thanh nút form Thu chi điện thoại).
it.each([
  ['hộp chốt', () => <ProfitDistributeDialog open {...ownerProps} defaultShareholderId="s" />, 'Lập phiếu chờ duyệt'],
  ['hộp tự tạm ứng', () => <ProfitSelfAdvanceDialog open onOpenChange={ownerProps.onOpenChange} organizationId="org-a" me={{ shareholderId: 's', name: 'An' }} />, 'Lập phiếu chờ duyệt'],
])('%s: thân giới hạn theo khung nhìn + cuộn; hàng nút dính đáy, cả hai nút chia đôi trên màn hẹp', (_name, view, submitName) => {
  m.access = [{ cashbook_id: 'a2', possession_kind: 'CUSTODIAN' }];
  render(view());
  const dialog = screen.getByRole('dialog');
  expect(dialog.className).toMatch(/max-h-\[90dvh\]/);
  expect(dialog.className).toMatch(/overflow-y-auto/);
  const footer = screen.getByRole('button', { name: submitName }).parentElement!;
  expect(footer.className).toMatch(/\bsticky bottom-0\b/);
  expect(within(footer).getByRole('button', { name: 'Đóng' }).className).toMatch(/flex-1 sm:flex-none/);
});

it.each(['manager'] as const)('ngày draft sai ở %s không gửi ngày cũ, giữ text/red/focus', async () => {
  const props = { open: true, onOpenChange: vi.fn() };
  // Hộp lương điều hành đọc người nhận + số còn lại từ sổ lương điều hành (E10) — D2.5.
  const ledger = {
    organization_id: 'org-a', route: 'LEGACY' as const, as_of: '2026-11-15T00:00:00Z',
    managers: [{ manager_id: 'm', name: 'An', is_active: true, is_deleted: false, has_login: true, marker: null, allocated: 9_000_000, payouts_approved: 0, payouts_pending: 0, balance: 9_000_000, status: 'OWED' as const }],
  };
  render(<ManagerSalaryPayoutDialog {...props} organizationId="org-a" ledger={ledger} defaultManagerId="m" />);
  fireEvent.change(document.querySelector('[name="amount"]')!, { target: { value: '500000' } });
  fireEvent.change(document.querySelector('[name="accountId"]')!, { target: { value: 'a1' } });
  const date = document.querySelector('[name="voucherDate"]') as HTMLInputElement;
  fireEvent.change(date, { target: { value: '31/02/2026' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ghi phiếu chi' }));
  await waitFor(() => expect(document.activeElement).toBe(date));
  expect(date.getAttribute('aria-invalid')).toBe('true');
  expect(date.value).toBe('31/02/2026');
  expect(m.managerCreate).not.toHaveBeenCalled();
  expect(props.onOpenChange).not.toHaveBeenCalled();
});
