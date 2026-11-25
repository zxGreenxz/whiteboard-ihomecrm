// @vitest-environment jsdom
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'o1'})}));
//
// Sale phòng đợt 3 trên form Thu chi của #499 (cơ chế chọn đích cọc của #499 giữ nguyên):
//  • phiếu THU có hạng mục cọc thì tổng dòng cọc > 0 — chặn ở trình duyệt, câu của hộp Cọc trang Sale (lỗi 5);
//  • TẠO BẢN SAO phiếu thu cọc không mang hợp đồng của phiếu gốc: người lập chọn lại đích (điểm chủ chốt 4, 24/11/2026).
// Phần chặn nằm TRƯỚC bước lưu: test giả `createVoucherFromForm` để thấy đúng dữ liệu đi tới bước lưu.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomeExpenseWithRelations } from '@/hooks/income-expenses/types';

type Contract = { id: string; contract_number: string; status: string; deposit_paid: number; total_deposit: number;
  actual_end_date: string | null; expected_move_out_date: string | null; tenant: { full_name: string } | null };
const h = vi.hoisted(() => ({ save: vi.fn(), toastError: vi.fn(), contracts: [] as Contract[], detail: null as unknown }));

vi.mock('@/hooks/income-expenses/detailRead', () => ({
  useIncomeExpenseDetail: () => ({ data: h.detail, isFetching: false, isError: false, isSuccess: true, isFetchedAfterMount: true, refetch: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: h.toastError, warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } } }));
vi.mock('@/hooks/useIncomeExpenses', () => ({ useCreateIncomeExpense: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/income-expenses/formCreatePending', () => ({
  createVoucherFromForm: (data: unknown) => h.save(data),
  pendingCreateElsewhere: () => null,
  voucherFormCreateKey: () => 'k',
}));
vi.mock('@/hooks/useDepositIncomeHold', () => ({ useDepositIncomeHold: () => ({ data: null, isLoading: false, isError: false }) }));
vi.mock('@/hooks/income-expenses/revisions', () => ({ useReviseIncomeExpense: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/income-expenses/forfeitKqkd', () => ({ useSetForfeitVoucherKqkd: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({ useMyCashbookAccessV2: () => ({ data: undefined }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'u1' } }) }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsAdmin: () => ({ data: false }) }));
vi.mock('@/hooks/useIsCompanyOwner', () => ({ useIsCompanyOwner: () => ({ data: false }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useIncomeExpenseFormScope', () => ({
  useIncomeExpenseFormBuildings: () => ({ data: [{ id: 'b1', name: '331PHI', managed: true }] }),
  useIncomeExpenseFormRooms: () => ({ data: [{ id: 'p201', name: '201' }] }),
}));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [{ id: 'a1', name: 'TKHIEP', bank_name: null, is_virtual: false }] }) }));
vi.mock('@/hooks/useContracts', () => ({ useContractsLegacy: () => ({ data: h.contracts }) }));
vi.mock('@/hooks/useIncomeExpenseTypes', () => ({
  useIncomeExpenseTypes: (kind: string) => ({
    data: kind === 'income'
      ? [{ id: 'tien-coc', name: 'Tiền Cọc', type: 'income', is_deposit: true }, { id: 'tien-phong', name: 'Tiền phòng', type: 'income', is_deposit: false }]
      : [],
  }),
}));
vi.mock('@/hooks/useVoucherSlotWarning', () => ({
  useVoucherSlotWarning: () => ({ data: [], status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock('@/hooks/useProfitPostLock', () => ({ useProfitLockedMonthsForForm: () => ({ data: undefined }) }));
vi.mock('../IncomeExpenseItemSelector', () => ({ default: () => null }));
vi.mock('../AttachmentUpload', () => ({ default: () => null }));
vi.mock('@/components/deposits/DepositScheduleFields', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/deposits/DepositScheduleFields')>(),
  DepositScheduleFields: () => null,
}));
// Ô chọn thay bằng <select> thật để bấm được trong jsdom.
vi.mock('@/components/ui/searchable-select', () => ({
  SearchableSelect: ({ options, onValueChange, value }: { options: { value: string; label: string }[]; onValueChange: (v: string) => void; value?: string }) => (
    <select value={value ?? ''} onChange={(e) => onValueChange(e.target.value)}>
      <option value="">Chọn</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) =>
    <select data-testid="o-select" value={value} onChange={(e) => onValueChange(e.target.value)}><option value="">(trống)</option>{children}</select>,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
  SelectTrigger: () => null, SelectValue: () => null,
}));

import IncomeExpenseForm from '../IncomeExpenseForm';
import { DEPOSIT_AMOUNT_CONTRACT_MESSAGE, DEPOSIT_AMOUNT_REQUIRED_MESSAGE } from '@/lib/incomeExpenseValidation';

if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverGia { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverGia;
}

const HD_CU: Contract = { id: 'hd-411', contract_number: 'HD-2026-00411', status: 'ACTIVE', deposit_paid: 0, total_deposit: 4_800_000,
  actual_end_date: null, expected_move_out_date: null, tenant: { full_name: 'Khách Cũ' } };
const CHON_DICH = 'Chọn bổ sung cho hợp đồng đang thuê hoặc giữ chỗ cho lượt thuê kế tiếp.';

const moFormTao = (typeId = 'tien-coc', typeName = 'Tiền Cọc', unitPrice = 1_000_000) =>
  render(
    <IncomeExpenseForm
      open
      onOpenChange={() => {}}
      voucher={null}
      defaultType="INCOME"
      defaultPrefill={{
        building_id: 'b1', room_id: 'p201', name: 'cọc 331PHI 201',
        items: [{ income_expense_type_id: typeId, type_name: typeName, quantity: 1, unit_price: unitPrice }],
      }}
    />,
  );
const phieuCocGoc = (over: Partial<IncomeExpenseWithRelations> = {}) => ({
  detail_read: { complete: true, expected_item_count: 1 },
  id: 'v-goc', code: 'PT2611001', type: 'INCOME', name: 'Cọc 201', building_id: 'b1', building_name: '331PHI', room_id: 'p201',
  tenant_id: null, contract_id: 'hd-411', payer_name: 'Khách Cũ', receive_bank_account: null, receive_bank_name: null, account_id: 'a1',
  voucher_date: '2026-11-20', business_result_accounting: null, repeat_cycle: 'NONE', repeat_infinity: false, repeat_count: 0, attachments: [],
  approval_status: 'CANCELLED', posting_status: 'UNPOSTED', approval_version: 2, system_source: null, invoice_id: null, shareholder_id: null,
  total_amount: 1_000_000, updated_at: '2026-11-20T00:00:00Z',
  items: [{ id: 'i1', income_expense_id: 'v-goc', income_expense_type_id: 'tien-coc', type_name: 'Tiền Cọc', category: null, is_deposit: true,
    description: null, quantity: 1, unit_price: 1_000_000, amount: 1_000_000, start_date: '2026-11-01', end_date: '2026-11-30' }],
  ...over,
}) as unknown as IncomeExpenseWithRelations;
const chonSo = () => {
  const so = screen.getAllByRole('combobox').find((el) => within(el).queryByText('TKHIEP'))!;
  fireEvent.change(so, { target: { value: 'a1' } });
};
const oHopDong = () => screen.getAllByTestId('o-select').find((el) => within(el).queryByText('Giữ chỗ cho lượt thuê kế tiếp') || within(el).queryByText('-- Không gắn HĐ --'))! as HTMLSelectElement;
const nutLuu = () => screen.getByTestId('ie-form-save') as HTMLButtonElement;
const daLuu = () => h.save.mock.calls.at(-1)?.[0] as { contract_id: string | null } | undefined;

beforeEach(() => {
  h.save.mockReset().mockResolvedValue({ id: 'v-moi' });
  h.toastError.mockReset();
  h.contracts = [HD_CU];
  h.detail = null;
});
afterEach(cleanup);

describe('Phiếu cọc phải có số tiền lớn hơn 0 (chặn ở trình duyệt)', () => {
  it('dòng Tiền Cọc 0 đ ⇒ không lưu, ô Số tiền báo đúng câu của hộp Cọc trang Sale', async () => {
    h.contracts = [];
    moFormTao('tien-coc', 'Tiền Cọc', 0);
    chonSo();
    fireEvent.click(nutLuu());
    await screen.findByText(DEPOSIT_AMOUNT_REQUIRED_MESSAGE);
    expect(document.querySelector('[name="items.0.unit_price"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('đã chọn hợp đồng (bổ sung cọc cho khách đang ở) ⇒ vẫn chặn 0 đ, nhưng KHÔNG gợi ý Lock tạm (phiếu không giữ phòng)', async () => {
    moFormTao('tien-coc', 'Tiền Cọc', 0);
    chonSo();
    fireEvent.change(oHopDong(), { target: { value: 'hd-411' } });
    fireEvent.click(nutLuu());
    await screen.findByText(DEPOSIT_AMOUNT_CONTRACT_MESSAGE);
    expect(screen.queryByText(DEPOSIT_AMOUNT_REQUIRED_MESSAGE)).toBeNull();
    expect(document.body.textContent).not.toContain('Lock tạm');
    expect(h.save).not.toHaveBeenCalled();
    // Bỏ chọn hợp đồng (giữ chỗ lượt kế tiếp) ⇒ câu có gợi ý Lock tạm.
    fireEvent.change(oHopDong(), { target: { value: '__none__' } });
    fireEvent.click(nutLuu());
    await screen.findByText(DEPOSIT_AMOUNT_REQUIRED_MESSAGE);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('dòng thường 0 đ (không phải cọc) ⇒ luật cọc không chặn', async () => {
    h.contracts = [];
    moFormTao('tien-phong', 'Tiền phòng', 0);
    chonSo();
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(screen.queryByText(DEPOSIT_AMOUNT_REQUIRED_MESSAGE)).toBeNull();
  });

  it('cọc có tiền ở phòng trống ⇒ lưu được (đi đường đợt giữ chỗ của #499)', async () => {
    h.contracts = [];
    moFormTao();
    chonSo();
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(daLuu()?.contract_id ?? null).toBeNull();
  });
});

describe('Tạo bản sao phiếu thu cọc không giữ hợp đồng của phiếu gốc', () => {
  it('bản sao phiếu cọc gắn HĐ ⇒ ô Hợp đồng để trống, bấm Lưu bị hỏi chọn đích; chọn HĐ thì lưu với HĐ đó', async () => {
    const goc = phieuCocGoc();
    h.detail = goc;
    render(<IncomeExpenseForm open onOpenChange={() => {}} copyFrom={goc} />);
    await waitFor(() => expect(oHopDong().value).toBe(''));
    fireEvent.click(nutLuu());
    await screen.findByText(CHON_DICH);
    expect(h.save).not.toHaveBeenCalled();
    fireEvent.change(oHopDong(), { target: { value: 'hd-411' } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(daLuu()?.contract_id).toBe('hd-411');
  });

  it('bản sao phiếu thường (không cọc) giữ nguyên hợp đồng của phiếu gốc', async () => {
    const goc = phieuCocGoc({ items: [{ id: 'i1', income_expense_id: 'v-goc', income_expense_type_id: 'tien-phong', type_name: 'Tiền phòng',
      category: null, is_deposit: false, description: null, quantity: 1, unit_price: 1_000_000, amount: 1_000_000, start_date: '2026-11-01',
      end_date: '2026-11-30' }] as never });
    h.detail = goc;
    render(<IncomeExpenseForm open onOpenChange={() => {}} copyFrom={goc} />);
    await waitFor(() => expect(oHopDong().value).toBe('hd-411'));
  });
});
