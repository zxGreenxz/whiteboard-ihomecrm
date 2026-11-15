// @vitest-environment jsdom
// Màn Chờ duyệt (Đợt 2 sổ tổng, D2.9): phiếu chi lợi nhuận / lương điều hành có thẻ số dư sổ tổng (E7),
// nút Duyệt khoá khi máy chủ chắc chắn từ chối (chốt F1), "Duyệt và Chi…" chỉ từ đúng sổ lúc lập, câu báo
// lỗi theo mã PROFIT_LEDGER_… — phiếu thường giữ nguyên. Biên mạng (hộp thư, nguồn phiếu, E7, lệnh duyệt) giả.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerPayoutDetail } from '@/lib/profitLedger/ledgerReaders';

type DetailState = { data?: LedgerPayoutDetail; error?: unknown };
const api = vi.hoisted(() => ({
  mobile: false,
  decide: vi.fn(), approve: vi.fn(), post: vi.fn(), refetch: vi.fn(), read: vi.fn(), invalidate: vi.fn(),
  detailRefetch: vi.fn(),
  books: [{ id: 'so-a', name: 'Quỹ A' }, { id: 'so-b', name: 'Quỹ B' }] as Array<{ id: string; name: string }>,
  details: {} as Record<string, DetailState>,
  e7Calls: [] as Array<string | null>,
  postingProps: null as null | { cashbookOptions: Array<{ id: string }>; voucher: { defaultCashbookId?: string | null; cashbookLocked?: boolean } },
}));

const ROWS = [
  { request_id: 'req-ln', voucher_id: 'phieu-ln', organization_id: 'org-1', voucher_type: 'EXPENSE', voucher_name: 'Chia lợi nhuận: Cổ đông 1',
    voucher_code: 'PC-LN', amount: 300, submitted_at: '2026-11-15T03:00:00Z', step_no: 1, approval_version: 1, posting_version: 1,
    maker_name: 'Chủ A', submission_no: 1, request_version: 1, system_source: null },
  { request_id: 'req-thuong', voucher_id: 'phieu-thuong', organization_id: 'org-1', voucher_type: 'EXPENSE', voucher_name: 'Sửa máy bơm',
    voucher_code: 'PC-1', amount: 100, submitted_at: '2026-11-15T03:00:00Z', step_no: 1, approval_version: 1, posting_version: 1,
    maker_name: 'Kế toán', submission_no: 1, request_version: 1, system_source: null },
];

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/layout/MainLayout', () => ({ default: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock('@/components/errors/QueryRegion', () => ({ QueryRegion: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/approvals/AiSubmittedBadge', () => ({ AiSubmittedBadge: () => null }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => api.mobile }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'chu-b' } }) }));
vi.mock('@/hooks/useApprovals', () => ({
  usePendingApprovals: () => ({ data: ROWS, isLoading: false, isFetching: false, isError: false, refetch: api.refetch }),
  usePendingApprovalSources: () => ({
    data: { 'phieu-ln': { system_source: 'profit.ledger_payout', account_id: 'so-a' }, 'phieu-thuong': { system_source: null, account_id: 'so-b' } },
    isError: false, refetch: vi.fn(),
  }),
  useDecideApproval: () => ({ mutate: api.decide, mutateAsync: api.decide, isPending: false }),
}));
vi.mock('@/lib/financeV2Route', () => ({ useFinanceV2Routes: () => ({ getOrg: () => ({}) }), canWriteWorkflow: () => true, canWritePosting: () => true }));
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({
  useApproveIncomeExpenseV2: () => ({ mutate: api.approve, isPending: false }),
  useApproveAndPostIncomeExpenseV2: () => ({ mutateAsync: api.post, isPending: false }),
  useCustodianCashbooksV2: () => ({ data: api.books, isError: false, refetch: vi.fn() }),
  useAttachPostingEvidence: () => vi.fn(), useRemovePostingAttachment: () => vi.fn(),
  uploadFinanceEvidence: vi.fn(), adoptVoucherAttachmentsAsEvidence: vi.fn(),
}));
vi.mock('@/lib/incomeExpenseDetailRpc', () => ({ loadIncomeExpenseDetails: api.read }));
vi.mock('@/hooks/income-expenses/detailRead', () => ({ withDetailReadDeadline: (read: Promise<unknown>) => read }));
vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useProfitLedgerPayoutDetail: (id: string | null) => {
    api.e7Calls.push(id);
    const state = id ? api.details[id] : undefined;
    return {
      data: state?.data, error: state?.error ?? null, isError: !!state?.error, isPending: !state?.data && !state?.error,
      refetch: api.detailRefetch,
    };
  },
}));
vi.mock('@/hooks/profit-ledger/useProfitLedgerMutations', () => ({ invalidateProfitLedgerQueries: api.invalidate }));
vi.mock('@/components/income-expenses/IncomeExpensePostingDialog', () => ({
  default: (props: NonNullable<typeof api.postingProps>) => {
    api.postingProps = props;
    return <div role="dialog" aria-label="Duyệt và chi">{props.cashbookOptions.map((b) => b.id).join(',')}</div>;
  },
}));

import ApprovalsPage from '../ApprovalsPage';

function e7(patch: Partial<LedgerPayoutDetail> = {}, voucher: Partial<LedgerPayoutDetail['voucher']> = {}): LedgerPayoutDetail {
  return {
    organization_id: 'org-1', route: 'CANONICAL',
    voucher: { id: 'phieu-ln', code: 'PC-LN', voucher_date: '2026-11-15', amount: 300, approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED',
      system_source: 'profit.ledger_payout', account_id: 'so-a', account_name: 'Quỹ A', is_live: true, created_at: '2026-11-15T03:00:00Z', ...voucher },
    subject: { kind: 'SHAREHOLDER', id: 'sh-1', name: 'Cổ đông 1', is_deleted: false, has_login: true },
    at_create: { balance_before: 250, within: 250, advance: 50, warnings: [{ code: 'ADVANCE', advance_amount: 50 }], maker_kind: 'OWNER', payee_is_maker: false },
    now: { balance_excluding_this: 1000, within: 300, advance: 0 },
    ...patch,
  };
}

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const ledgerNote = () => screen.getByTestId('ledger-approval-note');
const approveButtons = () => screen.getAllByRole('button', { name: 'Duyệt' }) as HTMLButtonElement[];

beforeEach(() => {
  vi.clearAllMocks();
  api.mobile = false;
  api.books = [{ id: 'so-a', name: 'Quỹ A' }, { id: 'so-b', name: 'Quỹ B' }];
  api.details = { 'phieu-ln': { data: e7() } };
  api.e7Calls = [];
  api.postingProps = null;
});
afterEach(cleanup);

describe.each([false, true])('Chờ duyệt — phiếu chi theo sổ tổng (điện thoại=%s)', (mobile) => {
  beforeEach(() => { api.mobile = mobile; });

  it('chỉ phiếu sổ tổng mới đọc E7 và có thẻ số dư: lúc lập + bây giờ, tách trong số dư / tạm ứng, sổ chi cố định', () => {
    render(<ApprovalsPage />, { wrapper: wrap() });
    expect(new Set(api.e7Calls.filter(Boolean))).toEqual(new Set(['phieu-ln']));
    expect(screen.getAllByTestId('ledger-approval-note')).toHaveLength(1);
    const note = ledgerNote().textContent ?? '';
    expect(note).toContain('Chi lợi nhuận cổ đông · Cổ đông 1');
    expect(note).toMatch(/Lúc lập: còn phải trả 250\.000\s?₫|Lúc lập: còn phải trả 250/);
    expect(note).toMatch(/tạm ứng 50/);
    expect(note).toMatch(/Bây giờ \(không tính phiếu này\): còn phải trả 1\.000/);
    expect(note).toContain('Chỉ chi được từ sổ đã chọn lúc lập: Quỹ A.');
    expect(screen.queryByTestId('ledger-approval-block')).toBeNull();
    expect(approveButtons().every((b) => !b.disabled)).toBe(true);
  });

  it('sổ tổng đóng băng ⇒ thẻ báo trước, Duyệt của dòng đó khoá, không chào Duyệt và Chi; dòng thường không đổi', () => {
    api.details['phieu-ln'] = { data: e7({ route: 'FROZEN' }) };
    render(<ApprovalsPage />, { wrapper: wrap() });
    expect(screen.getByTestId('ledger-approval-block').textContent).toMatch(/đóng băng/);
    const [ledgerApprove, normalApprove] = approveButtons();
    expect(ledgerApprove!.disabled).toBe(true);
    expect(normalApprove!.disabled).toBe(false);
    // Còn đúng MỘT "Duyệt và Chi…" — của phiếu thường.
    expect(screen.getAllByRole('button', { name: 'Duyệt và Chi…' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Từ chối' }).every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('E7 lỗi ⇒ báo tại chỗ + Thử lại, khoá Duyệt của dòng đó (không duyệt mù)', () => {
    api.details['phieu-ln'] = { error: { code: '42501', message: 'PROFIT_LEDGER_FORBIDDEN: không xem được phiếu này' } };
    render(<ApprovalsPage />, { wrapper: wrap() });
    const note = ledgerNote();
    expect(note.getAttribute('role')).toBe('alert');
    expect(note.textContent).toMatch(/Chưa duyệt được phiếu này ở đây/);
    fireEvent.click(within(note).getByRole('button', { name: 'Thử lại' }));
    expect(api.detailRefetch).toHaveBeenCalled();
    expect(approveButtons()[0]!.disabled).toBe(true);
  });
});

describe('Chờ duyệt — chặn trước theo E7', () => {
  it.each([
    ['phiếu đã bị từ chối (không còn sống)', e7({}, { is_live: false }), /chỉ còn Huỷ/],
    ['người nhận đã xoá', e7({ subject: { kind: 'SHAREHOLDER', id: 'sh-1', name: 'Cổ đông 1', is_deleted: true, has_login: false } }), /Người nhận đã bị xoá/],
    ['lương điều hành vượt số còn lại', e7({ subject: { kind: 'MANAGER', id: 'm-1', name: 'Quản lý 1', is_deleted: false, has_login: false },
      now: { balance_excluding_this: 200, within: 200, advance: 100 } }), /vượt lương điều hành còn lại/],
    ['sổ tổng chưa bật', e7({ route: 'LEGACY' }), /chưa bật/],
  ])('%s ⇒ Duyệt khoá, có câu lý do', (_label, detail, reason) => {
    api.details['phieu-ln'] = { data: detail };
    render(<ApprovalsPage />, { wrapper: wrap() });
    expect(screen.getByTestId('ledger-approval-block').textContent).toMatch(reason);
    expect(approveButtons()[0]!.disabled).toBe(true);
  });

  it('người giữ sổ tự tạm ứng cho mình ⇒ thẻ nói rõ người duyệt phải là chủ khác', () => {
    api.details['phieu-ln'] = { data: e7({ at_create: { balance_before: 0, within: 0, advance: 300, warnings: [], maker_kind: 'CUSTODIAN_ADVANCE', payee_is_maker: true } }) };
    render(<ApprovalsPage />, { wrapper: wrap() });
    expect(ledgerNote().textContent).toMatch(/tự lập phiếu tạm ứng cho chính mình/);
  });
});

describe('Chờ duyệt — Duyệt và Chi phiếu sổ tổng chỉ từ đúng sổ lúc lập', () => {
  const ledgerDetail = { id: 'phieu-ln', organization_id: 'org-1', type: 'EXPENSE', name: 'Chia lợi nhuận: Cổ đông 1', total_amount: 300,
    system_source: 'profit.ledger_payout', account_id: 'so-a', commission_kind: null, approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED',
    approval_version: 1, posting_version: 1, items: [], detail_read: { complete: true, expected_item_count: 0 } };

  it('người duyệt giữ sổ của phiếu ⇒ hộp Duyệt và Chi chỉ chào sổ đó, khoá sổ', async () => {
    api.read.mockResolvedValue([ledgerDetail]);
    render(<ApprovalsPage />, { wrapper: wrap() });
    const [ledgerPost] = screen.getAllByRole('button', { name: 'Duyệt và Chi…' });
    fireEvent.click(ledgerPost!);
    await screen.findByRole('dialog');
    expect(api.postingProps!.cashbookOptions.map((b) => b.id)).toEqual(['so-a']);
    expect(api.postingProps!.voucher).toMatchObject({ defaultCashbookId: 'so-a', cashbookLocked: true });
  });

  it('người duyệt không giữ sổ của phiếu ⇒ không chào Duyệt và Chi cho phiếu đó (chỉ Duyệt)', () => {
    api.books = [{ id: 'so-b', name: 'Quỹ B' }];
    render(<ApprovalsPage />, { wrapper: wrap() });
    expect(screen.getAllByRole('button', { name: 'Duyệt và Chi…' })).toHaveLength(1);
    expect(approveButtons()[0]!.disabled).toBe(false);
  });

  it('sổ trên phiếu đọc lại lúc bấm khác sổ đã chào ⇒ không mở hộp, báo tải lại', async () => {
    api.read.mockResolvedValue([{ ...ledgerDetail, account_id: 'so-b' }]);
    render(<ApprovalsPage />, { wrapper: wrap() });
    fireEvent.click(screen.getAllByRole('button', { name: 'Duyệt và Chi…' })[0]!);
    expect((await screen.findByRole('alert')).textContent).toMatch(/sổ quỹ đã chọn lúc lập/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Chờ duyệt — câu báo lỗi và làm mới sổ tổng', () => {
  it('máy chủ chặn duyệt bằng mã sổ tổng ⇒ câu tiếng Việt riêng (không phải "chưa xác định nguyên nhân")', async () => {
    api.approve.mockImplementation((_input: unknown, opts: { onError: (e: unknown) => void }) =>
      opts.onError({ code: '42501', message: 'PROFIT_LEDGER_MAKER_SELF_APPROVE: người lập không tự duyệt', details: null }));
    render(<ApprovalsPage />, { wrapper: wrap() });
    fireEvent.click(approveButtons()[0]!);
    expect((await screen.findByRole('alert')).textContent).toBe('Người lập phiếu không tự duyệt được — cần một chủ khác duyệt.');
    expect(api.invalidate).not.toHaveBeenCalled();
  });

  it('duyệt xong phiếu sổ tổng ⇒ làm mới các màn sổ tổng; phiếu thường thì không', async () => {
    api.approve.mockImplementation((_input: unknown, opts: { onSuccess: () => void }) => opts.onSuccess());
    render(<ApprovalsPage />, { wrapper: wrap() });
    fireEvent.click(approveButtons()[1]!);
    expect(api.invalidate).not.toHaveBeenCalled();
    fireEvent.click(approveButtons()[0]!);
    await waitFor(() => expect(api.invalidate).toHaveBeenCalledTimes(1));
  });

  it('hộp Từ chối phiếu sổ tổng nói trước: số dư trả lại, phiếu chỉ còn Huỷ', () => {
    render(<ApprovalsPage />, { wrapper: wrap() });
    fireEvent.click(screen.getAllByRole('button', { name: 'Từ chối' })[0]!);
    expect(screen.getByText(/từ chối xong số dư sổ tổng trả lại ngay/)).toBeTruthy();
  });
});
