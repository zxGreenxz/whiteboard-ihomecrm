// @vitest-environment jsdom
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'o1'})}));
//
// Sale phòng đợt 3 (chủ chốt 24/11/2026): phiếu THU có hạng mục cọc ở phòng đang có hợp đồng hiệu lực ⇒ form KHÔNG tự
// gắn HĐ, LUÔN bắt chọn «Bổ sung cọc cho khách đang ở» hay «Cọc giữ phòng của khách mới». Ca gốc 331PHI·201 (audit
// 24/11): HĐ cũ HD-2026-00411 mới đóng 0/4.800.000 cọc ⇒ ô Hợp đồng tự chọn HĐ cũ, không cảnh báo ⇒ cọc khách mới thành
// cọc khách cũ. Kèm luật cọc phải có tiền (lỗi 5). Phần hỏi / chặn nằm TRƯỚC bước lưu có đối chiếu rớt mạng: test giả
// `createVoucherFromForm` để thấy đúng dữ liệu đi tới bước lưu.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Contract = { id: string; contract_number: string; status: string; deposit_paid: number; total_deposit: number;
  actual_end_date: string | null; expected_move_out_date: string | null; tenant: { full_name: string } | null };
const h = vi.hoisted(() => ({ save: vi.fn(), toastError: vi.fn(), contracts: [] as Contract[] }));

vi.mock('@/hooks/income-expenses/detailRead', () => ({
  useIncomeExpenseDetail: () => ({ data: null, isFetching: false, isError: false, isSuccess: true, isFetchedAfterMount: true, refetch: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: h.toastError, warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } } }));
vi.mock('@/hooks/useIncomeExpenses', () => ({ useCreateIncomeExpense: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/income-expenses/formCreatePending', () => ({
  createVoucherFromForm: (data: unknown) => h.save(data),
  pendingCreateElsewhere: () => null,
  voucherFormCreateKey: () => 'k',
}));
vi.mock('@/hooks/income-expenses/revisions', () => ({ useReviseIncomeExpense: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/income-expenses/forfeitKqkd', () => ({ useSetForfeitVoucherKqkd: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({ useMyCashbookAccessV2: () => ({ data: undefined }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'u1' } }) }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsAdmin: () => ({ data: false }) }));
vi.mock('@/hooks/useIsCompanyOwner', () => ({ useIsCompanyOwner: () => ({ data: false }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useIncomeExpenseFormScope', () => ({
  useIncomeExpenseFormBuildings: () => ({ data: [{ id: 'b1', name: '331PHI', managed: true }] }),
  useIncomeExpenseFormRooms: () => ({ data: [{ id: 'p201', name: '201' }, { id: 'p202', name: '202' }] }),
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
    <select data-testid="o-hop-dong-hoac-lap" value={value} onChange={(e) => onValueChange(e.target.value)}>{children}</select>,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
  SelectTrigger: () => null, SelectValue: () => null,
}));

import IncomeExpenseForm from '../IncomeExpenseForm';
import { DEPOSIT_CONTRACT_CHOICE_REQUIRED_MESSAGE, DEPOSIT_CONTRACT_EXISTING_MISSING_MESSAGE } from '@/lib/depositContractChoice';
import { DEPOSIT_AMOUNT_REQUIRED_MESSAGE } from '@/lib/incomeExpenseValidation';

if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverGia { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverGia;
}

const HD_CU: Contract = { id: 'hd-411', contract_number: 'HD-2026-00411', status: 'ACTIVE', deposit_paid: 0, total_deposit: 4_800_000,
  actual_end_date: null, expected_move_out_date: null, tenant: { full_name: 'Khách Cũ' } };

const moForm = (typeId = 'tien-coc', typeName = 'Tiền Cọc', unitPrice = 1_000_000) =>
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
const chonSo = () => {
  const so = screen.getAllByRole('combobox').find((el) => within(el).queryByText('TKHIEP'))!;
  fireEvent.change(so, { target: { value: 'a1' } });
};
const oHopDong = () => screen.getAllByTestId('o-hop-dong-hoac-lap').find((el) => within(el).queryByText('-- Không gắn HĐ --'))! as HTMLSelectElement;
const nutLuu = () => screen.getByTestId('ie-form-save') as HTMLButtonElement;
const daLuu = () => h.save.mock.calls.at(-1)?.[0] as { contract_id: string | null } | undefined;

beforeEach(() => {
  h.save.mockReset().mockResolvedValue({ id: 'v-moi' });
  h.toastError.mockReset();
  h.contracts = [HD_CU];
});
afterEach(cleanup);

describe('Cọc ở phòng đang có hợp đồng: luôn bắt chọn cọc của ai', () => {
  it('ca 331PHI·201 (HĐ cũ thiếu cọc): không tự gắn HĐ, hỏi rõ; bấm Lưu chưa chọn ⇒ không lưu, báo lỗi', async () => {
    moForm();
    chonSo();
    expect(screen.getByTestId('ie-deposit-contract-choice')).toBeTruthy();
    expect(oHopDong().value).toBe('__none__');
    expect(screen.getByRole('radio', { name: /Bổ sung cọc cho khách đang ở/ }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('radio', { name: /Cọc giữ phòng của khách mới/ }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(nutLuu());
    await screen.findByText(DEPOSIT_CONTRACT_CHOICE_REQUIRED_MESSAGE);
    expect(h.toastError).toHaveBeenCalledWith(DEPOSIT_CONTRACT_CHOICE_REQUIRED_MESSAGE);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('«Bổ sung cọc cho khách đang ở» ⇒ phiếu gắn đúng HĐ đang ở; lỗi tự tắt khi đã chọn', async () => {
    moForm();
    chonSo();
    fireEvent.click(nutLuu());
    await screen.findByText(DEPOSIT_CONTRACT_CHOICE_REQUIRED_MESSAGE);
    expect(screen.getByText(/Gắn vào HD-2026-00411 · Khách Cũ/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Bổ sung cọc cho khách đang ở/ }));
    await waitFor(() => expect(screen.queryByText(DEPOSIT_CONTRACT_CHOICE_REQUIRED_MESSAGE)).toBeNull());
    expect(oHopDong().value).toBe('hd-411');
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(daLuu()?.contract_id).toBe('hd-411');
  });

  it('«Cọc giữ phòng của khách mới» ⇒ không gắn HĐ; HĐ đang ở chưa báo trả ⇒ cảnh báo nhưng vẫn lưu', async () => {
    moForm();
    chonSo();
    fireEvent.click(screen.getByRole('radio', { name: /Cọc giữ phòng của khách mới/ }));
    expect(screen.getByText(/Phòng chưa báo trả: HD-2026-00411 · Khách Cũ chưa có ngày trả phòng/)).toBeTruthy();
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(daLuu()?.contract_id).toBeNull();
  });

  it('khách đang ở đã báo trả ⇒ chọn khách mới không cảnh báo; HĐ đã gia hạn cũng là HĐ hiệu lực', async () => {
    h.contracts = [{ ...HD_CU, status: 'EXTENDED', deposit_paid: 4_800_000, expected_move_out_date: '2026-12-01' }];
    moForm();
    chonSo();
    expect(screen.getByTestId('ie-deposit-contract-choice')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Cọc giữ phòng của khách mới/ }));
    expect(screen.queryByText(/Phòng chưa báo trả/)).toBeNull();
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(daLuu()?.contract_id).toBeNull();
  });

  it('hai HĐ hiệu lực: «khách đang ở» bắt chọn HĐ ở ô dưới; tự chọn HĐ ở ô Hợp đồng là một lựa chọn rõ', async () => {
    h.contracts = [HD_CU, { ...HD_CU, id: 'hd-412', contract_number: 'HD-2026-00412', tenant: { full_name: 'Khách Hai' } }];
    moForm();
    chonSo();
    fireEvent.click(screen.getByRole('radio', { name: /Bổ sung cọc cho khách đang ở/ }));
    expect(oHopDong().value).toBe('__none__');
    fireEvent.click(nutLuu());
    await screen.findByText(DEPOSIT_CONTRACT_EXISTING_MISSING_MESSAGE);
    expect(h.save).not.toHaveBeenCalled();
    fireEvent.change(oHopDong(), { target: { value: 'hd-412' } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(daLuu()?.contract_id).toBe('hd-412');
  });

  it('chọn «-- Không gắn HĐ --» ở ô Hợp đồng = cọc giữ phòng của khách mới', async () => {
    moForm();
    chonSo();
    fireEvent.change(oHopDong(), { target: { value: '__none__' } });
    expect(screen.getByRole('radio', { name: /Cọc giữ phòng của khách mới/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(daLuu()?.contract_id).toBeNull();
  });

  it('đổi phòng sau khi đã chọn ⇒ quên lựa chọn, phải chọn lại cho phòng mới', async () => {
    moForm();
    chonSo();
    fireEvent.click(screen.getByRole('radio', { name: /Cọc giữ phòng của khách mới/ }));
    const phong = screen.getAllByRole('combobox').find((el) => within(el).queryByText('202'))!;
    fireEvent.change(phong, { target: { value: 'p202' } });
    await waitFor(() => expect(screen.getByRole('radio', { name: /Cọc giữ phòng của khách mới/ }).getAttribute('aria-checked')).toBe('false'));
    fireEvent.click(nutLuu());
    await screen.findByText(DEPOSIT_CONTRACT_CHOICE_REQUIRED_MESSAGE);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('HĐ đã thanh lý (có ngày trả thực tế) không tính là đang ở ⇒ không hỏi', async () => {
    h.contracts = [{ ...HD_CU, status: 'TERMINATED', actual_end_date: '2026-11-01' }];
    moForm();
    expect(screen.queryByTestId('ie-deposit-contract-choice')).toBeNull();
  });

  it('phiếu không có hạng mục cọc ⇒ không hỏi, tự gắn HĐ đang ở như trước', async () => {
    moForm('tien-phong', 'Tiền phòng');
    chonSo();
    expect(screen.queryByTestId('ie-deposit-contract-choice')).toBeNull();
    await waitFor(() => expect(oHopDong().value).toBe('hd-411'));
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(daLuu()?.contract_id).toBe('hd-411');
  });
});

describe('Phiếu cọc phải có số tiền lớn hơn 0', () => {
  it('dòng Tiền Cọc 0 đ ⇒ không lưu, ô Số tiền báo đúng câu của hộp Cọc trang Sale', async () => {
    h.contracts = [];
    moForm('tien-coc', 'Tiền Cọc', 0);
    chonSo();
    fireEvent.click(nutLuu());
    await screen.findByText(DEPOSIT_AMOUNT_REQUIRED_MESSAGE);
    const o = document.querySelector('[name="items.0.unit_price"]');
    expect(o?.getAttribute('aria-invalid')).toBe('true');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('dòng thường 0 đ (không phải cọc) ⇒ luật cọc không chặn', async () => {
    h.contracts = [];
    moForm('tien-phong', 'Tiền phòng', 0);
    chonSo();
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(screen.queryByText(DEPOSIT_AMOUNT_REQUIRED_MESSAGE)).toBeNull();
  });
});
