// @vitest-environment jsdom
vi.mock('@/hooks/useDepositIncomeHold',()=>({useDepositIncomeHold:()=>({data:null,isError:false,isLoading:false,refetch:vi.fn()})}));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'o1' }) }));
//
// Form Thu chi — chế độ "Tạm Ứng" (tạm ứng lợi nhuận cổ đông, 18/11/2026). Chốt các điều người dùng thấy:
//   1. mục "Tạm Ứng" chỉ hiện ở phiếu CHI tạo mới và chỉ khi máy chủ nói lập được (`can_create`);
//   2. chọn rồi thì: toà khoá về Kho Văn Phòng Chung, "người nhận" là dropdown người được cấp quyền tạm ứng,
//      sổ quỹ chỉ còn sổ đang giữ, một số tiền, các ô không dùng biến mất;
//   3. người lập HỘ không thấy con số nào của cổ đông;
//   4. Lưu gọi lệnh tạm ứng — KHÔNG gọi lệnh tạo phiếu thường.
// Dữ liệu GIẢ.
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AdvancePreviewInput = { shareholderId: string | null; amount: number | null; accountId: string | null; enabled?: boolean };
const h = vi.hoisted(() => ({
  create: vi.fn(),
  advance: vi.fn(),
  toastSuccess: vi.fn(),
  mobile: false,
  /** R3: dữ liệu, null (không thuộc công ty), hoặc lỗi đọc. */
  options: null as unknown,
  optionsOrgs: [] as (string | null)[],
  refetchOptions: vi.fn(),
  previewCalls: [] as { shareholderId: string | null; amount: number | null; accountId: string | null }[],
  blocked: null as string | null,
  /** Lần kiểm của người nhận MỚI chưa về: hook còn trả lần kiểm trước (của người nhận cũ), đang tải. */
  holdPreview: false,
  lastPreview: null as Record<string, unknown> | null,
}));

vi.mock('@/hooks/income-expenses/detailRead', () => ({
  useIncomeExpenseDetail: () => ({ data: null, isFetching: false, isError: false, isSuccess: true, isFetchedAfterMount: true, refetch: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: h.toastSuccess, info: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } } }));
vi.mock('@/hooks/useIncomeExpenses', () => ({ useCreateIncomeExpense: () => ({ mutateAsync: h.create, isPending: false }) }));
vi.mock('@/hooks/income-expenses/revisions', () => ({ useReviseIncomeExpense: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/income-expenses/forfeitKqkd', () => ({ useSetForfeitVoucherKqkd: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({ useMyCashbookAccessV2: () => ({ data: undefined }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'u1' } }) }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsAdmin: () => ({ data: false }) }));
vi.mock('@/hooks/useIsCompanyOwner', () => ({ useIsCompanyOwner: () => ({ data: false }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => h.mobile }));
vi.mock('@/hooks/useIncomeExpenseFormScope', () => ({
  useIncomeExpenseFormBuildings: () => ({ data: [
    { id: 'b1', name: 'Toà A', managed: true, is_virtual: false },
    { id: 'kho', name: 'Kho VP Chung (toà ảo)', managed: false, is_virtual: true },
  ] }),
  useIncomeExpenseFormRooms: () => ({ data: [] }),
}));
vi.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: [
    { id: 'a-giu', name: 'Sổ người giữ', bank_name: null, is_virtual: false },
    { id: 'a-khac', name: 'Sổ người khác giữ', bank_name: null, is_virtual: false },
  ] }),
}));
vi.mock('@/hooks/useContracts', () => ({ useContractsLegacy: () => ({ data: [] }) }));
vi.mock('@/hooks/useIncomeExpenseTypes', () => ({
  useIncomeExpenseTypes: (kind: string) => ({
    isLoading: false,
    data: kind === 'expense'
      ? [
          { id: 'tien-dien', name: 'Tiền điện', type: 'expense', category: 'Cố định hằng tháng' },
          // Dòng hạng mục thật của "Tạm Ứng" (chủ đọc được qua RLS): system_only ⇒ danh mục KHÔNG bày ra.
          { id: 'type-tam-ung', name: 'Tạm Ứng', type: 'expense', category: 'Chia lợi nhuận', system_only: true, is_restricted: true, rule_key: 'tam_ung_co_dong' },
        ]
      : [{ id: 'tien-phong', name: 'Tiền phòng', type: 'income', category: null }],
  }),
}));
vi.mock('@/hooks/useVoucherSlotWarning', () => ({
  useVoucherSlotWarning: () => ({ data: [], status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock('@/hooks/useProfitPostLock', () => ({ useProfitLockedMonthsForForm: () => ({ data: undefined }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/hooks/useCanManageIeTypes', () => ({ useCanManageIeTypes: () => ({ canManage: false, isLoading: false }) }));
vi.mock('@/components/income-expense-types/IncomeExpenseTypeForm', () => ({ default: () => null }));
vi.mock('@/components/income-expense-types/EditIncomeExpenseTypeDialog', () => ({ default: () => null }));
vi.mock('../AttachmentUpload', () => ({ default: () => <div data-testid="attachment-upload" /> }));
vi.mock('@/hooks/profit-ledger/useProfitLedgerQueries', () => ({
  useShareholderAdvanceOptions: (org: string | null) => {
    h.optionsOrgs.push(org);
    if (h.options && typeof h.options === 'object' && 'code' in h.options) return { data: undefined, isError: true, error: h.options, refetch: h.refetchOptions };
    return { data: h.options, isError: false, error: null, refetch: h.refetchOptions };
  },
  // Người giữ sổ lập HỘ: máy chủ KHÔNG gửi số của cổ đông (position = null); chính mình thì có.
  useShareholderAdvancePreview: (input: AdvancePreviewInput) => {
    h.previewCalls.push({ shareholderId: input.shareholderId, amount: input.amount, accountId: input.accountId });
    if (!input.shareholderId) return { data: undefined, isFetching: false, isError: false, error: null, refetch: vi.fn() };
    if (h.holdPreview && h.lastPreview && h.lastPreview.shareholder_id !== input.shareholderId) {
      return { data: h.lastPreview, isFetching: true, isError: false, error: null, refetch: vi.fn() };
    }
    const self = input.shareholderId === 'sh-toi';
    const result = {
      data: {
        route: 'CANONICAL', shareholder_id: input.shareholderId, maker_kind: self ? 'CUSTODIAN_ADVANCE' : 'CUSTODIAN_FOR_PAYEE',
        payee_is_maker: self, can_submit: !h.blocked && input.amount !== null && !!input.accountId, blocked_reason: h.blocked,
        warnings: input.amount === null ? [] : [{ code: 'ADVANCE', advance_amount: input.amount }, { code: 'NEEDS_OWNER_APPROVAL' }],
        position: self ? {
          unpaid_profit: 7_777_000, advance_outstanding: 1_111_000, advance_pending: 0, settlement_cash_pending: 0, balance: 6_666_000,
          settled: { recognized: 0, offset: 0, cash: 0 }, last_settled_through_month: null, marker_month: null,
          needs_review: { count: 0, suggested: 0 },
          components: { allocated: 0, payouts_pending: 0, payouts_approved: 0, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: 7_777_000, advance_outstanding_raw: 1_111_000, advance_overoffset: 0 },
          after_advance: input.amount === null ? null : { advance_pending: input.amount, balance: 6_666_000 - input.amount },
        } : null,
      },
      isFetching: false, isError: false, error: null, refetch: vi.fn(),
    };
    h.lastPreview = result.data;
    return result;
  },
}));
vi.mock('@/hooks/profit-ledger/useOwnerPayoutPosting', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/hooks/profit-ledger/useOwnerPayoutPosting')>(),
  useOwnerPayoutPosting: () => ({ stepFor: () => null }),
}));
vi.mock('@/hooks/profit-ledger/useProfitLedgerMutations', () => ({
  useCreateShareholderAdvance: () => ({ mutateAsync: h.advance, isPending: false }),
}));
vi.mock('@/components/ui/searchable-select', () => ({
  SearchableSelect: ({ options, onValueChange, value, name, disabled, ...props }: { options: { value: string; label: string }[]; onValueChange: (s: string) => void; name?: string; value?: string; disabled?: boolean; 'aria-invalid'?: boolean }) => (
    <select name={name} aria-invalid={props['aria-invalid']} disabled={disabled} value={value ?? ''} onChange={(e) => onValueChange(e.target.value)}>
      <option value="">Chọn</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import IncomeExpenseForm from '../IncomeExpenseForm';

if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverGia { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverGia;
}

const OPTIONS = {
  route: 'CANONICAL', can_create: true,
  accounts: [{ account_id: 'a-giu', name: 'Sổ người giữ' }],
  payees: [
    { shareholder_id: 'sh-1', name: 'Cổ đông Một', is_self: false },
    { shareholder_id: 'sh-toi', name: 'Cổ đông Tôi', is_self: true },
  ],
  advance_type: { id: 'type-tam-ung', name: 'Tạm Ứng' },
};

const onOpenChange = vi.fn();
const onSaved = vi.fn();
const moForm = (defaultType: 'INCOME' | 'EXPENSE' = 'EXPENSE') =>
  render(<IncomeExpenseForm open onOpenChange={onOpenChange} voucher={null} defaultType={defaultType} onSaved={onSaved} />);
const moOChon = () => fireEvent.click(screen.getByRole('button', { name: /Thêm hạng mục/ }));
const mucTamUng = () => screen.queryByTestId('shareholder-advance-option');
const chonTamUng = () => {
  moOChon();
  fireEvent.click(within(mucTamUng()!).getByRole('button'));
};
const panel = () => screen.getByTestId('shareholder-advance-panel');
const o = (name: string) => panel().querySelector(`[name="${name}"]`) as HTMLSelectElement | HTMLInputElement | null;
const giaTri = (name: string) => Array.from((o(name) as HTMLSelectElement).options).map((x) => x.value).filter(Boolean);

beforeEach(() => {
  h.create.mockReset().mockResolvedValue({ id: 'v-thuong' });
  h.advance.mockReset().mockResolvedValue({ voucher_id: 'v-tu', code: 'PC2611777', amount: 500_000, within_amount: 0, advance_amount: 500_000, balance_before: null, maker_kind: 'CUSTODIAN_FOR_PAYEE' });
  h.toastSuccess.mockReset(); h.refetchOptions.mockReset();
  h.mobile = false; h.options = OPTIONS; h.optionsOrgs = []; h.previewCalls = []; h.blocked = null;
  h.holdPreview = false; h.lastPreview = null;
  onOpenChange.mockReset(); onSaved.mockReset();
});
afterEach(cleanup);

describe('mục "Tạm Ứng" trong ô chọn hạng mục', () => {
  it('phiếu CHI + máy chủ nói lập được ⇒ hiện mục riêng; hạng mục hệ thống KHÔNG lọt vào danh mục thường', () => {
    moForm();
    expect(h.optionsOrgs).toEqual([]); // chưa mở ô chọn thì chưa hỏi máy chủ
    moOChon();
    expect(h.optionsOrgs).toContain('o1');
    expect(within(mucTamUng()!).getByText('Tạm Ứng')).toBeTruthy();
    // Danh mục thường: chỉ mục chọn được — dòng "Tạm Ứng" (system_only) không thành ô tick.
    const tick = screen.getAllByRole('checkbox').map((c) => c.closest('label')?.textContent);
    expect(tick).toEqual(['Tiền điện']);
  });
  it.each([
    ['máy chủ nói KHÔNG lập được (không giữ sổ nào)', { ...OPTIONS, can_create: false, accounts: [], payees: [] }],
    ['người gọi không thuộc công ty (null)', null],
    ['đang tải', undefined],
  ])('%s ⇒ không có mục Tạm Ứng', (_name, options) => {
    h.options = options;
    moForm();
    moOChon();
    expect(mucTamUng()).toBeNull();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });
  it('phiếu THU ⇒ không có mục Tạm Ứng và không hỏi máy chủ', () => {
    moForm('INCOME');
    moOChon();
    expect(mucTamUng()).toBeNull();
    expect(h.optionsOrgs).toEqual([]);
  });
  it('chưa kiểm tra được ⇒ nói rõ + nút tải lại (không im lặng coi như không lập được)', () => {
    h.options = { code: '40P01', message: 'deadlock detected' };
    moForm();
    moOChon();
    expect(mucTamUng()).toBeNull();
    const note = screen.getByTestId('shareholder-advance-option-error');
    expect(note.textContent).toMatch(/Chưa kiểm tra được hạng mục Tạm Ứng/);
    fireEvent.click(within(note).getByRole('button', { name: 'Tải lại' }));
    expect(h.refetchOptions).toHaveBeenCalled();
  });
  it('gõ tìm không khớp thì mục Tạm Ứng ẩn như mọi hạng mục khác; gõ "tam ung" thì còn', () => {
    moForm();
    moOChon();
    const search = screen.getByLabelText('Tìm hạng mục');
    fireEvent.change(search, { target: { value: 'tien dien' } });
    expect(mucTamUng()).toBeNull();
    fireEvent.change(search, { target: { value: 'tam ung' } });
    expect(mucTamUng()).not.toBeNull();
  });
});

describe('chỉ form Thu chi đầy đủ có mục Tạm Ứng', () => {
  it('form lô, tạo nhanh, Báo chi nhanh không gắn mục Tạm Ứng và không đọc lựa chọn tạm ứng', () => {
    for (const file of [
      'src/components/income-expenses/IncomeExpenseBatchForm.tsx',
      'src/components/income-expenses/IncomeExpenseQuickCreateDialog.tsx',
      'src/components/income-expenses/IncomeExpenseQuickEditDialog.tsx',
      'src/components/income-expenses/QuickCategoryInput.tsx',
      'src/components/income-expenses/QuickExpenseActions.tsx',
      'src/components/income-expenses/QuickExpenseProvider.tsx',
    ]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/shareholderAdvance|ShareholderAdvance|shareholder_profit_advance/);
    }
    // Ô chọn hạng mục chỉ dựng mục Tạm Ứng khi form truyền prop VÀ phiếu là phiếu chi.
    const selector = readFileSync('src/components/income-expenses/IncomeExpenseItemSelector.tsx', 'utf8');
    expect(selector).toContain("shareholderAdvance && voucherType === 'EXPENSE'");
    // Luật ô chọn lập tay không đổi: hạng mục hệ thống vẫn bị ẩn (mục Tạm Ứng không đi qua danh mục).
    expect(readFileSync('src/lib/ieTypeCatalog.ts', 'utf8')).toContain('!t.archived_at && !t.system_only && !t.manual_hidden');
  });
});

describe('chế độ Tạm Ứng của form', () => {
  it('toà khoá về toà ảo; người nhận là dropdown người được tạm ứng; sổ quỹ chỉ còn sổ đang giữ; ô không dùng biến mất', () => {
    moForm();
    chonTamUng();
    expect(screen.getByTestId('ie-form-advance-mode')).toBeTruthy();
    // Thân form thường bị ẩn (không gửi được), không mất.
    expect((screen.getByTestId('ie-form-save').closest('form') as HTMLFormElement).className).toBe('hidden');
    const building = panel().querySelector('#shareholder-advance-building') as HTMLInputElement;
    expect(building.value).toBe('Kho VP Chung (toà ảo)');
    expect(building.disabled).toBe(true);
    expect(giaTri('shareholderId')).toEqual(['sh-1', 'sh-toi']);
    expect(Array.from((o('shareholderId') as HTMLSelectElement).options).map((x) => x.textContent)).toEqual(['Chọn', 'Cổ đông Một', 'Cổ đông Tôi (bạn)']);
    expect(giaTri('accountId')).toEqual(['a-giu']);
    expect(panel().querySelectorAll('[name="amount"]')).toHaveLength(1);
    for (const name of ['room_id', 'building_id', 'payer_name', 'receive_bank_account', 'name', 'repeat_count', 'items.0.start_date']) {
      expect(o(name), name).toBeNull();
    }
    expect(within(panel()).queryByText(/Hạch toán kết quả kinh doanh/)).toBeNull();
    expect(within(panel()).queryByText(/Cài đặt lặp lại/)).toBeNull();
    expect(within(panel()).queryByTestId('attachment-upload')).toBeNull();
    expect(within(panel()).queryByRole('button', { name: /Thêm hạng mục/ })).toBeNull();
  });
  it('người lập HỘ không thấy con số nào của cổ đông; tự ứng cho mình thì thấy', async () => {
    moForm();
    chonTamUng();
    fireEvent.change(o('shareholderId')!, { target: { value: 'sh-1' } });
    fireEvent.change(o('accountId')!, { target: { value: 'a-giu' } });
    const box = await screen.findByTestId('profit-advance-preview');
    expect(box.textContent).toMatch(/Bạn lập hộ: phiếu chờ người có quyền duyệt/);
    expect(screen.queryByTestId('profit-advance-position')).toBeNull();
    expect(panel().textContent).not.toMatch(/Lợi nhuận chưa chi|Tạm ứng đang có|7\.777\.000|1\.111\.000|6\.666\.000/);
    fireEvent.change(o('shareholderId')!, { target: { value: 'sh-toi' } });
    expect((await screen.findByTestId('profit-advance-position')).textContent).toMatch(/Lợi nhuận chưa chi: 7\.777\.000.*Tạm ứng đang có: 1\.111\.000/);
  });
  // R8 (review chéo 18/11): chiều ngược lại — đang tự ứng (thấy số của mình) rồi đổi sang lập HỘ.
  it('đổi người nhận từ CHÍNH MÌNH sang người khác ⇒ khối số của mình biến mất ngay, kể cả khi lần kiểm mới chưa về', async () => {
    moForm();
    chonTamUng();
    fireEvent.change(o('shareholderId')!, { target: { value: 'sh-toi' } });
    fireEvent.change(o('accountId')!, { target: { value: 'a-giu' } });
    fireEvent.change(o('amount')!, { target: { value: '500000' } });
    await waitFor(() => expect(screen.getByTestId('profit-advance-after').textContent).toMatch(/500\.000/), { timeout: 2000 });
    expect(screen.getByTestId('profit-advance-position').textContent).toMatch(/7\.777\.000/);
    // Lần kiểm của người nhận mới chưa về: hook còn trả số của "Cổ đông Tôi" — không được hiện cho người nhận mới.
    h.holdPreview = true;
    fireEvent.change(o('shareholderId')!, { target: { value: 'sh-1' } });
    expect(h.previewCalls.at(-1)).toMatchObject({ shareholderId: 'sh-1' });
    expect(screen.queryByTestId('profit-advance-position')).toBeNull();
    expect(screen.queryByTestId('profit-advance-after')).toBeNull();
    expect(panel().textContent).not.toMatch(/Lợi nhuận chưa chi|Tạm ứng đang có|7\.777\.000|1\.111\.000|1\.611\.000|6\.666\.000|6\.166\.000/);
    // Lần kiểm mới về (máy chủ không gửi số cho người lập hộ): vẫn không có số nào.
    h.holdPreview = false;
    fireEvent.change(o('note')!, { target: { value: 'Ứng hộ' } });
    expect((await screen.findByTestId('profit-advance-preview')).textContent).toMatch(/Bạn lập hộ: phiếu chờ người có quyền duyệt/);
    expect(panel().textContent).not.toMatch(/Lợi nhuận chưa chi|Tạm ứng đang có|7\.777\.000|1\.111\.000|1\.611\.000|6\.666\.000|6\.166\.000/);
  });
  it('Lưu ⇒ gọi lệnh tạm ứng đúng nội dung, KHÔNG gọi lệnh tạo phiếu thường; xong thì đóng hộp', async () => {
    moForm();
    chonTamUng();
    fireEvent.change(o('shareholderId')!, { target: { value: 'sh-1' } });
    fireEvent.change(o('accountId')!, { target: { value: 'a-giu' } });
    fireEvent.change(o('amount')!, { target: { value: '500000' } });
    fireEvent.change(o('note')!, { target: { value: '  Ứng đợt 1  ' } });
    // Đợi lần kiểm khớp số đang nhập (chờ 400 ms).
    await waitFor(() => expect(h.previewCalls.some((c) => c.shareholderId === 'sh-1' && c.amount === 500_000 && c.accountId === 'a-giu')).toBe(true), { timeout: 2000 });
    fireEvent.click(screen.getByTestId('shareholder-advance-save'));
    await waitFor(() => expect(h.advance).toHaveBeenCalledTimes(1));
    expect(h.advance).toHaveBeenCalledWith({
      organizationId: 'o1', shareholderId: 'sh-1', amount: 500_000, accountId: 'a-giu',
      voucherDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), note: 'Ứng đợt 1',
    });
    expect(h.create).not.toHaveBeenCalled();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSaved).toHaveBeenCalledWith(500_000);
    expect(h.toastSuccess.mock.calls[0]![0]).toMatch(/phiếu PC2611777 tạm ứng 500\.000.*cho Cổ đông Một.*chờ người có quyền duyệt/);
  });
  it('thiếu người nhận / sổ quỹ / số tiền ⇒ báo đúng ô, không gọi máy chủ', async () => {
    moForm();
    chonTamUng();
    fireEvent.click(screen.getByTestId('shareholder-advance-save'));
    await screen.findByText('Chọn người nhận tạm ứng.');
    expect(screen.getByText('Chọn sổ quỹ chi.')).toBeTruthy();
    expect(screen.getByText('Nhập số tiền lớn hơn 0.')).toBeTruthy();
    expect(h.advance).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('máy chủ báo người nhận chưa có quyền ⇒ câu tại chỗ, nút Lưu khoá', async () => {
    h.blocked = 'PAYEE_NO_RIGHT';
    moForm();
    chonTamUng();
    fireEvent.change(o('shareholderId')!, { target: { value: 'sh-1' } });
    expect((await screen.findByTestId('profit-advance-blocked')).textContent).toMatch(/Người nhận chưa được cấp quyền tạm ứng/);
    expect((screen.getByTestId('shareholder-advance-save') as HTMLButtonElement).disabled).toBe(true);
  });
  it('máy chủ từ chối lúc lưu (còn phiếu lương cần xem lại, không kèm số) ⇒ câu tiếng Việt, hộp không đóng', async () => {
    h.advance.mockRejectedValueOnce({ code: '55000', message: 'PROFIT_LEDGER_SALARY_REVIEW_PENDING: cổ đông còn phiếu lương cần chủ xem lại — xác nhận số trước khi tạm ứng lợi nhuận', details: null });
    moForm();
    chonTamUng();
    fireEvent.change(o('shareholderId')!, { target: { value: 'sh-1' } });
    fireEvent.change(o('accountId')!, { target: { value: 'a-giu' } });
    fireEvent.change(o('amount')!, { target: { value: '500000' } });
    await waitFor(() => expect(h.previewCalls.some((c) => c.amount === 500_000 && c.accountId === 'a-giu')).toBe(true), { timeout: 2000 });
    fireEvent.click(screen.getByTestId('shareholder-advance-save'));
    const failure = await screen.findByTestId('shareholder-advance-failure');
    expect(failure.textContent).toBe('Cổ đông còn phiếu lương cần chủ xem lại phần lợi nhuận. Chủ công ty xác nhận phần lương trước rồi mới tạm ứng được.');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('bỏ hạng mục Tạm Ứng ⇒ quay về form phiếu chi thường; bấm "Phiếu thu" cũng thoát chế độ', () => {
    moForm();
    chonTamUng();
    fireEvent.click(screen.getByRole('button', { name: 'Bỏ hạng mục Tạm Ứng' }));
    expect(screen.queryByTestId('ie-form-advance-mode')).toBeNull();
    expect((screen.getByTestId('ie-form-save').closest('form') as HTMLFormElement).className).toBe('space-y-4');
    chonTamUng();
    expect(screen.getByTestId('ie-form-advance-mode')).toBeTruthy();
    fireEvent.mouseDown(within(screen.getByTestId('ie-form-advance-mode')).getByRole('tab', { name: /Phiếu thu/ }), { button: 0 });
    expect(screen.queryByTestId('ie-form-advance-mode')).toBeNull();
  });
  it('điện thoại: cùng nội dung, dòng hạng mục không dùng cột rộng cố định', () => {
    h.mobile = true;
    moForm();
    chonTamUng();
    const row = screen.getByRole('button', { name: 'Bỏ hạng mục Tạm Ứng' }).parentElement!;
    expect(row.className).not.toMatch(/\d+px/);
    expect(within(row).getByText('Số tiền')).toBeTruthy();
  });
});
