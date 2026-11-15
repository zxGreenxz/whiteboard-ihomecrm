// @vitest-environment jsdom
// Hộp "Chi lợi nhuận" theo sổ tổng (D2.2) + hộp lương điều hành (giữ phép kiểm ngày nháp cũ).
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PreviewInput = { shareholderId: string | null; amount: number | null; accountId: string | null; enabled?: boolean };
const m = vi.hoisted(() => ({
  create: vi.fn(),
  managerCreate: vi.fn(),
  route: 'CANONICAL' as string,
  blocked: null as string | null,
  reviewCount: 0,
  balance: 100_000,
  previewCalls: [] as PreviewInput[],
  access: [] as { cashbook_id: string; possession_kind: string }[],
}));
const ok = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, isSuccess: true, isFetching: false, error: null, refetch: vi.fn() });
// Ô tick của Radix đo kích thước bằng ResizeObserver — jsdom không có.
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
vi.mock('@/hooks/profit-ledger/useProfitLedgerMutations', () => ({ useCreateProfitLedgerPayout: () => ({ mutateAsync: m.create, isPending: false }) }));
vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useShareholderProfitLedger: (org: string | null) => (org ? ok({
    organization_id: org, route: m.route, as_of: '2026-11-15T00:00:00Z',
    shareholders: [
      { shareholder_id: 's', name: 'An', is_active: true, is_deleted: false, has_login: true, marker: null, allocated: 0, payouts_approved: 0, payouts_pending: 0, salary_investment: 0, salary_advance_offset: 0, balance: m.balance, status: 'OWED', open_advance: 0, needs_review_count: m.reviewCount },
      { shareholder_id: 'gone', name: 'Đã xoá', is_active: true, is_deleted: true, has_login: false, marker: null, allocated: 0, payouts_approved: 0, payouts_pending: 0, salary_investment: 0, salary_advance_offset: 0, balance: 5, status: 'OWED', open_advance: 0, needs_review_count: 0 },
    ],
  }) : { ...ok(undefined), status: 'pending', isSuccess: false }),
  useProfitPayoutPreview: (input: PreviewInput) => {
    m.previewCalls.push(input);
    if (!input.shareholderId) return { ...ok(undefined), status: 'pending', isSuccess: false };
    const amount = input.amount;
    const within = amount === null ? null : Math.min(amount, Math.max(m.balance, 0));
    const advance = amount === null || within === null ? null : amount - within;
    const blocked = m.route !== 'CANONICAL' ? 'ROUTE' : m.blocked;
    return ok({
      route: m.route, shareholder_id: input.shareholderId, maker_kind: 'OWNER', payee_is_maker: false, balance_before: m.balance,
      within_amount: within, advance_amount: advance, open_estimate: 0,
      warnings: advance ? [{ code: 'ADVANCE', advance_amount: advance }, { code: 'NEEDS_OWNER_APPROVAL' }] : [],
      requires_owner_approval: true, can_submit: !blocked && amount !== null && !!input.accountId, blocked_reason: blocked,
      needs_review: { count: m.reviewCount, suggested: 0 },
    });
  },
}));
vi.mock('@/components/ui/searchable-select', () => ({
  SearchableSelect: ({ options, onValueChange, value, name, ...props }: { options: { value: string; label: string }[]; onValueChange: (s: string) => void; name: string; value: string; 'aria-invalid'?: boolean }) => (
    <select name={name} aria-invalid={props['aria-invalid']} value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="">Chọn</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import ProfitDistributeDialog from '../ProfitDistributeDialog';
import ManagerSalaryPayoutDialog from '../ManagerSalaryPayoutDialog';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';

const ownerProps = { onOpenChange: vi.fn(), organizationId: 'org-a', mode: 'OWNER' as const };
const amountInput = () => document.querySelector('[name="amount"]') as HTMLInputElement;
const accountSelect = () => document.querySelector('[name="accountId"]') as HTMLSelectElement;
const submitButton = () => screen.getByRole('button', { name: 'Lập phiếu chờ duyệt' }) as HTMLButtonElement;
const accountOptions = () => Array.from(accountSelect().options).map((o) => o.value).filter(Boolean);
const fillAmount = async (value: string, expectSplit = true) => {
  fireEvent.change(amountInput(), { target: { value } });
  fireEvent.change(accountSelect(), { target: { value: accountOptions()[0] } });
  // Đợi lần xem trước khớp số đang nhập (chờ 400 ms).
  if (expectSplit) await screen.findByText(/Lần chi này/, undefined, { timeout: 2000 });
};

beforeEach(() => {
  m.route = 'CANONICAL'; m.blocked = null; m.reviewCount = 0; m.balance = 100_000; m.previewCalls = [];
  m.access = [];
  m.create.mockResolvedValue({ voucher_id: 'v9', code: 'PC2611999', within_amount: 50_000, advance_amount: 0 });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('hộp Chi lợi nhuận (OWNER)', () => {
  it('trống thì focus cổ đông, không gọi ghi phiếu', async () => {
    render(<ProfitDistributeDialog open {...ownerProps} />);
    fireEvent.click(submitButton());
    await waitFor(() => expect(document.activeElement?.getAttribute('name')).toBe('shareholderId'));
    expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');
    expect(m.create).not.toHaveBeenCalled();
  });
  it('chỉ cổ đông còn hiệu lực; mọi sổ TIỀN THẬT của đúng công ty', () => {
    render(<ProfitDistributeDialog open {...ownerProps} defaultShareholderId="s" />);
    const shareholderOptions = Array.from((document.querySelector('[name="shareholderId"]') as HTMLSelectElement).options).map((o) => o.value).filter(Boolean);
    expect(shareholderOptions).toEqual(['s']);
    expect(accountOptions()).toEqual(['a1', 'a2']);
  });
  it('mở hộp đã xem số dư (chưa nhập số tiền vẫn gọi xem trước)', async () => {
    render(<ProfitDistributeDialog open {...ownerProps} defaultShareholderId="s" />);
    expect(await screen.findByText(/Còn phải trả/)).toBeTruthy();
    expect(m.previewCalls.some((c) => c.shareholderId === 's' && c.amount === null)).toBe(true);
  });
  it('trong số dư: gửi đúng nội dung, cờ tạm ứng false', async () => {
    render(<ProfitDistributeDialog open {...ownerProps} defaultShareholderId="s" />);
    await fillAmount('50000');
    fireEvent.click(submitButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-a', shareholderId: 's', amount: 50_000, accountId: 'a1', allowAdvance: false, note: null }));
  });
  it('vượt số dư chưa tick ⇒ KHÔNG gọi ghi; tick + lý do ⇒ gửi p_allow_advance = true', async () => {
    render(<ProfitDistributeDialog open {...ownerProps} defaultShareholderId="s" />);
    await fillAmount('120000');
    expect(screen.getByRole('checkbox')).toBeTruthy();
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByRole('checkbox').getAttribute('aria-invalid')).toBe('true'));
    expect(m.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(document.querySelector('[name="note"]')!, { target: { value: 'Ứng trước lợi nhuận tháng 11' } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 120_000, allowAdvance: true, note: 'Ứng trước lợi nhuận tháng 11' }));
  });
  it('máy chủ đòi xác nhận tạm ứng (ADVANCE_CONFIRM) ⇒ hiện ô tick, KHÔNG tự gửi lần hai', async () => {
    m.create.mockRejectedValueOnce({ code: '22023', message: 'PROFIT_LEDGER_ADVANCE_CONFIRM: x', details: '{"balance":100000,"within":40000,"advance":10000}' });
    render(<ProfitDistributeDialog open {...ownerProps} defaultShareholderId="s" />);
    await fillAmount('50000');
    fireEvent.click(submitButton());
    expect(await screen.findByRole('checkbox')).toBeTruthy();
    expect((await screen.findAllByRole('alert')).some((n) => /tạm ứng/.test(n.textContent ?? ''))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(m.create).toHaveBeenCalledTimes(1);
  });
  it('chưa rõ kết quả ⇒ khoá gửi mới, chỉ còn "Kiểm tra lại kết quả"; giữ nguyên nội dung khi đóng/mở', async () => {
    m.create.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận được kết quả lập phiếu chi lợi nhuận.', 'unknown', []));
    const view = render(<ProfitDistributeDialog open {...ownerProps} defaultShareholderId="s" />);
    await fillAmount('50000');
    fireEvent.click(submitButton());
    expect(await screen.findByRole('button', { name: 'Kiểm tra lại kết quả' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lập phiếu chờ duyệt' })).toBeNull();
    expect(amountInput().closest('fieldset')?.disabled).toBe(true);
    view.rerender(<ProfitDistributeDialog open={false} {...ownerProps} defaultShareholderId="s" />);
    view.rerender(<ProfitDistributeDialog open {...ownerProps} defaultShareholderId="s" />);
    expect(screen.getByRole('button', { name: 'Kiểm tra lại kết quả' })).toBeTruthy();
    expect(amountInput().value).toContain('50');
    expect(m.create).toHaveBeenCalledTimes(1);
  });
  it.each(['LEGACY', 'SHADOW', 'FROZEN'])('route %s ⇒ khoá nút gửi + câu báo', async (route) => {
    m.route = route;
    render(<ProfitDistributeDialog open {...ownerProps} defaultShareholderId="s" />);
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    expect(screen.getByRole('status').textContent).toMatch(/Sổ tổng|mốc/);
  });
  it('còn phiếu lương cần xem lại ⇒ khoá gửi, có lối "Xem lại phần lương"', async () => {
    m.blocked = 'SALARY_REVIEW_PENDING'; m.reviewCount = 2;
    const onReviewSalary = vi.fn();
    render(<ProfitDistributeDialog open {...ownerProps} defaultShareholderId="s" onReviewSalary={onReviewSalary} />);
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Xem lại phần lương' }));
    expect(onReviewSalary).toHaveBeenCalledWith('s');
  });
});

describe('hộp Chi lợi nhuận (SELF_ADVANCE — người chỉ có quyền tạm ứng)', () => {
  const me = { shareholderId: 's', name: 'An' };
  it('chỉ sổ đang GIỮ (CUSTODIAN), cùng công ty, không ảo; người nhận cố định là mình', () => {
    m.access = [
      { cashbook_id: 'a2', possession_kind: 'CUSTODIAN' },
      { cashbook_id: 'a1', possession_kind: 'KNOWER' },
      { cashbook_id: 'a3', possession_kind: 'CUSTODIAN' },
      { cashbook_id: 'a4', possession_kind: 'CUSTODIAN' },
    ];
    render(<ProfitDistributeDialog open onOpenChange={vi.fn()} organizationId="org-a" mode="SELF_ADVANCE" me={me} />);
    expect(accountOptions()).toEqual(['a2']);
    expect(document.querySelector('[name="shareholderId"]')).toBeNull();
    expect(within(screen.getByRole('dialog')).getByText('An')).toBeTruthy();
  });
  it('chưa giữ sổ nào ⇒ báo và khoá gửi', async () => {
    m.access = [{ cashbook_id: 'a1', possession_kind: 'KNOWER' }];
    render(<ProfitDistributeDialog open onOpenChange={vi.fn()} organizationId="org-a" mode="SELF_ADVANCE" me={me} />);
    expect(screen.getByText(/chưa giữ sổ quỹ nào/)).toBeTruthy();
    await waitFor(() => expect(submitButton().disabled).toBe(true));
  });
});

it.each(['manager'] as const)('ngày draft sai ở %s không gửi ngày cũ, giữ text/red/focus', async () => {
  const props = { open: true, onOpenChange: vi.fn() };
  render(<ManagerSalaryPayoutDialog {...props} managers={[{ id: 'm', name: 'An' }] as never} defaultManagerId="m" />);
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

it('ngày draft sai ở hộp chi lợi nhuận: không gửi, giữ text, focus ô ngày', async () => {
  render(<ProfitDistributeDialog open {...ownerProps} defaultShareholderId="s" />);
  await fillAmount('50000');
  const date = document.querySelector('[name="voucherDate"]') as HTMLInputElement;
  fireEvent.change(date, { target: { value: '31/02/2026' } });
  fireEvent.click(submitButton());
  await waitFor(() => expect(document.activeElement).toBe(date));
  expect(date.value).toBe('31/02/2026');
  expect(m.create).not.toHaveBeenCalled();
});
