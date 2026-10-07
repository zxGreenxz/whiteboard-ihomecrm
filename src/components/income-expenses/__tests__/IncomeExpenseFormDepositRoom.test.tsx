// @vitest-environment jsdom
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'o1'})}));
//
// Phiếu có hạng mục Tiền cọc phải chọn phòng (07/10/2026). Ca thật PT2609155: cọc G03 chỉ chọn toà
// ⇒ không hợp đồng nào nhận, người lập nhập lại thành PT2610026 ⇒ sổ thừa 1.000.000đ.
// Chốt điều người dùng thấy: bấm Tạo ⇒ không gọi máy chủ, báo lỗi, ô Phòng đỏ và được focus.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ create: vi.fn(), toastError: vi.fn(), mobile: false }));

vi.mock('@/hooks/income-expenses/detailRead', () => ({
  useIncomeExpenseDetail: () => ({ data: null, isFetching: false, isError: false, isSuccess: true, isFetchedAfterMount: true, refetch: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: h.toastError, warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } },
}));
vi.mock('@/hooks/useIncomeExpenses', () => ({
  useCreateIncomeExpense: () => ({ mutateAsync: h.create, isPending: false }),
}));
vi.mock('@/hooks/income-expenses/revisions', () => ({
  useReviseIncomeExpense: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/income-expenses/forfeitKqkd', () => ({
  useSetForfeitVoucherKqkd: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({
  useMyCashbookAccessV2: () => ({ data: undefined }),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'u1' } }) }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsAdmin: () => ({ data: false }) }));
vi.mock('@/hooks/useIsCompanyOwner', () => ({ useIsCompanyOwner: () => ({ data: false }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => h.mobile }));
vi.mock('@/hooks/useIncomeExpenseFormScope', () => ({
  useIncomeExpenseFormBuildings: () => ({ data: [{ id: 'b1', name: '1392QT', managed: true }] }),
  useIncomeExpenseFormRooms: () => ({ data: [{ id: 'g03', name: 'G03' }] }),
}));
vi.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: [{ id: 'a1', name: 'TKHIEP', bank_name: null, is_virtual: false }] }),
}));
vi.mock('@/hooks/useContracts', () => ({ useContractsLegacy: () => ({ data: [] }) }));
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
vi.mock('../IncomeExpenseItemSelector', () => ({ default: () => null }));
vi.mock('../AttachmentUpload', () => ({ default: () => null }));

import IncomeExpenseForm from '../IncomeExpenseForm';
import { DEPOSIT_ROOM_REQUIRED_MESSAGE } from '@/lib/depositRoomRule';

if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverGia { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverGia;
}

const moFormTao = (typeId: string, typeName: string) =>
  render(
    <IncomeExpenseForm
      open
      onOpenChange={() => {}}
      voucher={null}
      defaultType="INCOME"
      defaultPrefill={{
        building_id: 'b1',
        name: 'khách cọc G03-1392qt',
        items: [{ income_expense_type_id: typeId, type_name: typeName, quantity: 1, unit_price: 1_000_000 }],
      }}
    />,
  );

const nutLuu = () => screen.getByTestId('ie-form-save') as HTMLButtonElement;
const oPhong = () => screen.getByRole('combobox', { name: /^Phòng/ });

beforeEach(() => {
  h.create.mockReset().mockResolvedValue({ id: 'v-moi' });
  h.toastError.mockReset();
  h.mobile = false;
});
afterEach(cleanup);

describe('Phiếu Tiền cọc bắt buộc chọn phòng', () => {
  it('chưa chọn phòng ⇒ không tạo phiếu, báo lỗi, ô Phòng đỏ và được focus', async () => {
    moFormTao('tien-coc', 'Tiền Cọc');
    expect(screen.getByText('Phòng *')).toBeTruthy();
    fireEvent.click(nutLuu());
    await waitFor(() => expect(oPhong().getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText(DEPOSIT_ROOM_REQUIRED_MESSAGE)).toBeTruthy();
    expect(h.toastError).toHaveBeenCalledWith(DEPOSIT_ROOM_REQUIRED_MESSAGE);
    // Sổ quỹ cũng đang trống: lỗi phòng hiện CÙNG LƯỢT, và con trỏ về ô Phòng (đứng trước Sổ quỹ).
    expect(screen.getByText('Chọn sổ quỹ ghi nhận phiếu.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(oPhong()));
    expect(h.create).not.toHaveBeenCalled();
  });

  it('bỏ dòng Tiền Cọc sau khi bị chặn ⇒ lỗi ở ô Phòng tự tắt', async () => {
    moFormTao('tien-coc', 'Tiền Cọc');
    fireEvent.click(nutLuu());
    await waitFor(() => expect(oPhong().getAttribute('aria-invalid')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'Xoá hạng mục 1' }));
    await waitFor(() => expect(oPhong().getAttribute('aria-invalid')).toBe('false'));
    expect(screen.queryByText(DEPOSIT_ROOM_REQUIRED_MESSAGE)).toBeNull();
    expect(screen.queryByText('Phòng *')).toBeNull();
  });

  it('hạng mục không phải cọc ⇒ không bắt chọn phòng', async () => {
    moFormTao('tien-phong', 'Tiền phòng');
    expect(screen.queryByText('Phòng *')).toBeNull();
    fireEvent.click(nutLuu());
    // Chỉ còn lỗi sổ quỹ (form không tự chọn sổ); ô Phòng không bị bắt.
    await waitFor(() => expect(screen.getByText('Chọn sổ quỹ ghi nhận phiếu.')).toBeTruthy());
    expect(oPhong().getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByText(DEPOSIT_ROOM_REQUIRED_MESSAGE)).toBeNull();
    expect(h.toastError).not.toHaveBeenCalled();
  });
});

describe('Bố cục dòng hạng mục trên mobile', () => {
  // 07/10/2026: ba cột 120px cố định (~400px) làm cả hộp thoại tràn ngang trên điện thoại
  // (ô Sổ quỹ, nút Lưu bị cắt; đưa con trỏ về một ô là trang cuộn ngang). Đo bằng trình duyệt:
  // sau sửa scrollWidth = clientWidth ở 390/360/320px.
  it('mobile: không cột cố định, mỗi ô có nhãn riêng; desktop giữ bảng cũ', () => {
    h.mobile = true;
    moFormTao('tien-coc', 'Tiền Cọc');
    const dong = screen.getByRole('button', { name: 'Xoá hạng mục 1' }).parentElement!;
    expect(dong.className).not.toMatch(/\d+px/);
    for (const nhan of ['Số tiền', 'Từ tháng', 'Đến tháng']) expect(within(dong).getByText(nhan)).toBeTruthy();
    cleanup();
    h.mobile = false;
    moFormTao('tien-coc', 'Tiền Cọc');
    const dongDesktop = screen.getByRole('button', { name: 'Xoá hạng mục 1' }).parentElement!;
    expect(dongDesktop.className).toContain('grid-cols-[1fr_120px_120px_120px_36px]');
  });
});
