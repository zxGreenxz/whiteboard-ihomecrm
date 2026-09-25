// @vitest-environment jsdom
//
// Form SỬA phiếu Chờ duyệt (đợt 1 sửa phiếu, 25/09/2026): lưu đi qua
// revise_pending_income_expense_v1. Chốt bốn điều người dùng thấy được:
//   1. chỉ gửi ô đã đổi (mở form rồi Lưu không sinh "lần sửa" ma);
//   2. hạng mục chưa ghi kỳ giữ kỳ trống, không bị gán tháng hiện tại;
//   3. đổi số tiền ⇒ phải ghi lý do ≥ 8 ký tự mới bấm Lưu được;
//   4. phiếu hệ thống (hoa hồng) khoá khung, lệch phiên bản ⇒ khoá Lưu + báo.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomeExpenseWithRelations } from '@/hooks/useIncomeExpenses';

const h = vi.hoisted(() => ({ revise: vi.fn(), create: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } },
}));
vi.mock('@/hooks/useIncomeExpenses', () => ({
  useCreateIncomeExpense: () => ({ mutateAsync: h.create, isPending: false }),
}));
vi.mock('@/hooks/income-expenses/revisions', () => ({
  useReviseIncomeExpense: () => ({ mutateAsync: h.revise, isPending: false }),
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
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useIncomeExpenseFormScope', () => ({
  useIncomeExpenseFormBuildings: () => ({ data: [{ id: 'b1', name: 'Toà A', managed: true }] }),
  useIncomeExpenseFormRooms: () => ({ data: [] }),
}));
vi.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: [{ id: 'a1', name: 'Sổ Hiệp', bank_name: null, is_virtual: false }] }),
}));
vi.mock('@/hooks/useContracts', () => ({ useContractsLegacy: () => ({ data: [] }) }));
vi.mock('@/hooks/useIncomeExpenseTypes', () => ({ useIncomeExpenseTypes: () => ({ data: [] }) }));
vi.mock('@/hooks/useVoucherSlotWarning', () => ({ useVoucherSlotWarning: () => ({ data: [] }) }));
vi.mock('../IncomeExpenseItemSelector', () => ({ default: () => null }));
vi.mock('../AttachmentUpload', () => ({ default: () => null }));

import IncomeExpenseForm from '../IncomeExpenseForm';

// jsdom không có ResizeObserver; Radix Switch/Checkbox đo kích thước bằng nó.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverGia {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverGia;
}

const phieu =(over: Partial<IncomeExpenseWithRelations> = {}): IncomeExpenseWithRelations =>
  ({
    id: 'v1', code: 'PC2609001', type: 'EXPENSE', name: 'Chi sửa ống nước', building_id: 'b1',
    building_name: 'Toà A', room_id: null, tenant_id: null, contract_id: null, payer_name: null,
    receive_bank_account: null, receive_bank_name: null, account_id: 'a1', voucher_date: '2026-09-20',
    business_result_accounting: null, repeat_cycle: 'NONE', repeat_infinity: false, repeat_count: 0,
    attachments: [], approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', approval_version: 5,
    system_source: null, invoice_id: null, shareholder_id: null, total_amount: 500000,
    items: [{
      id: 'i1', income_expense_id: 'v1', income_expense_type_id: 't1', type_name: 'Sửa chữa',
      category: null, is_deposit: false, description: null, quantity: 1, unit_price: 500000,
      amount: 500000, start_date: null, end_date: null,
    }],
    ...over,
  }) as unknown as IncomeExpenseWithRelations;

const moForm = (v: IncomeExpenseWithRelations) =>
  render(<IncomeExpenseForm open onOpenChange={() => {}} voucher={v} />);

const nutLuu = () => screen.getByTestId('ie-form-save') as HTMLButtonElement;

beforeEach(() => {
  h.revise.mockReset().mockResolvedValue({ id: 'v1', changed: true, approval_version: 6, changed_fields: [] });
});
afterEach(cleanup);

describe('Form sửa phiếu Chờ duyệt', () => {
  it('chỉ đổi tên ⇒ gửi đúng khoá name, không gửi hạng mục, kèm phiên bản lúc mở', async () => {
    moForm(phieu());
    fireEvent.change(screen.getByDisplayValue('Chi sửa ống nước'), { target: { value: 'Chi thay vòi nước' } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.revise).toHaveBeenCalledOnce());
    expect(h.revise).toHaveBeenCalledWith({
      voucherId: 'v1', expectedApprovalVersion: 5, patch: { name: 'Chi thay vòi nước' }, items: null, reason: null,
    });
  });

  it('mở rồi Lưu không đổi gì ⇒ không gọi máy chủ', async () => {
    const dong = vi.fn();
    render(<IncomeExpenseForm open onOpenChange={dong} voucher={phieu()} />);
    fireEvent.click(nutLuu());
    await waitFor(() => expect(dong).toHaveBeenCalledWith(false));
    expect(h.revise).not.toHaveBeenCalled();
  });

  it('hạng mục chưa ghi kỳ: báo rõ và lưu vẫn giữ kỳ trống', async () => {
    moForm(phieu());
    expect(screen.getByText(/Phiếu gốc chưa ghi kỳ/)).toBeTruthy();
    const tien = screen.getByPlaceholderText('Số tiền');
    fireEvent.focus(tien);
    fireEvent.change(tien, { target: { value: '600000' } });
    fireEvent.change(screen.getByTestId('revision-reason'), { target: { value: 'Thợ báo giá lại' } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.revise).toHaveBeenCalledOnce());
    const goi = h.revise.mock.calls[0][0];
    expect(goi.items).toEqual([{
      income_expense_type_id: 't1', description: null, quantity: 1, unit_price: 600000, start_date: null, end_date: null,
    }]);
    expect(goi.reason).toBe('Thợ báo giá lại');
  });

  it('đổi số tiền ⇒ hiện ô lý do, Lưu khoá tới khi đủ 8 ký tự', async () => {
    moForm(phieu());
    expect(screen.queryByTestId('revision-reason')).toBeNull();
    const tien = screen.getByPlaceholderText('Số tiền');
    fireEvent.focus(tien);
    fireEvent.change(tien, { target: { value: '700000' } });
    const lyDo = screen.getByTestId('revision-reason');
    expect(nutLuu().disabled).toBe(true);
    fireEvent.change(lyDo, { target: { value: 'ngắn' } });
    expect(nutLuu().disabled).toBe(true);
    fireEvent.change(lyDo, { target: { value: 'Sai đơn giá lúc lập' } });
    expect(nutLuu().disabled).toBe(false);
  });

  it('phiếu hoa hồng chưa có sổ: khoá khung, không cho thêm hạng mục, sổ để trống vẫn lưu được', async () => {
    moForm(phieu({ system_source: 'contract.commission', account_id: null }));
    expect(screen.getByText(/Phiếu do hệ thống lập \(hoa hồng/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Thêm hạng mục/ })).toBeNull();
    expect(screen.getByText('Sổ quỹ (chọn lúc duyệt)')).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('Chi sửa ống nước'), { target: { value: 'Hoa hồng P101' } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(h.revise).toHaveBeenCalledOnce());
    expect(h.revise.mock.calls[0][0].patch).toEqual({ name: 'Hoa hồng P101' });
  });

  it('phiếu vừa bị người khác sửa (PT409) ⇒ báo mở lại và khoá Lưu', async () => {
    h.revise.mockRejectedValueOnce({ code: 'PT409', message: 'Phiếu vừa được người khác sửa' });
    moForm(phieu());
    fireEvent.change(screen.getByDisplayValue('Chi sửa ống nước'), { target: { value: 'Chi thay vòi nước' } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/vừa được người khác sửa hoặc duyệt/));
    expect(nutLuu().disabled).toBe(true);
  });

  it('phiếu đã duyệt ⇒ chỉ xem, không có nút Lưu', () => {
    moForm(phieu({ approval_status: 'APPROVED', posting_status: 'POSTED' }));
    expect(screen.getByText('CHI TIẾT PHIẾU')).toBeTruthy();
    expect(screen.queryByTestId('ie-form-save')).toBeNull();
  });
});
