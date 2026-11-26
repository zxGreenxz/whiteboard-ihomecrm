// @vitest-environment jsdom
// Đợt 8 (cách A): đổi cờ KQKD phiếu doanh thu bỏ cọc đi qua set_forfeit_voucher_kqkd_v1 — máy chủ khoá phiếu rồi so cờ, đã
// đúng thì trả {changed:false}, nên gửi lại an toàn. Sau một kết quả CHƯA RÕ, form ở chế độ đổi KQKD KHÔNG khoá nút Lưu như
// form sửa phiếu thường: báo rõ, giữ lý do đang nhập, bấm lại gửi lại đúng cờ đó. Form sửa phiếu thường vẫn khoá (đợt 5).
vi.mock('@/hooks/useDepositIncomeHold', () => ({ useDepositIncomeHold: () => ({ data: null, isError: false, isLoading: false, refetch: vi.fn() }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'o1' }) }));
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IncomeExpenseWithRelations } from '@/hooks/useIncomeExpenses';
import { FinancialWorkflowError } from '@/lib/financialWorkflowError';

const h = vi.hoisted(() => ({ kqkd: vi.fn(), revise: vi.fn(), detail: null as unknown }));
vi.mock('@/hooks/income-expenses/detailRead', () => ({ useIncomeExpenseDetail: () => ({ data: h.detail, isFetching: false, isError: false, isSuccess: true, isFetchedAfterMount: true, refetch: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } } }));
vi.mock('@/hooks/useIncomeExpenses', () => ({ useCreateIncomeExpense: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/income-expenses/revisions', () => ({ useReviseIncomeExpense: () => ({ mutateAsync: h.revise, isPending: false }) }));
vi.mock('@/hooks/income-expenses/forfeitKqkd', async original => ({ ...await original<typeof import('@/hooks/income-expenses/forfeitKqkd')>(), useSetForfeitVoucherKqkd: () => ({ mutateAsync: h.kqkd, isPending: false }) }));
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({ useMyCashbookAccessV2: () => ({ data: undefined }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'u1' } }) }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsAdmin: () => ({ data: false }) }));
vi.mock('@/hooks/useIsCompanyOwner', () => ({ useIsCompanyOwner: () => ({ data: true }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useIncomeExpenseFormScope', () => ({ useIncomeExpenseFormBuildings: () => ({ data: [{ id: 'b1', name: 'Toà A', managed: true }] }), useIncomeExpenseFormRooms: () => ({ data: [] }) }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [{ id: 'a1', name: 'Sổ nội bộ', bank_name: null, is_virtual: true }] }) }));
vi.mock('@/hooks/useContracts', () => ({ useContractsLegacy: () => ({ data: [], isError: false, refetch: vi.fn() }) }));
vi.mock('@/hooks/useIncomeExpenseTypes', () => ({ useIncomeExpenseTypes: () => ({ data: [] }) }));
vi.mock('@/hooks/useVoucherSlotWarning', () => ({ useVoucherSlotWarning: () => ({ data: [], status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: vi.fn() }) }));
vi.mock('@/hooks/useProfitPostLock', () => ({ useProfitLockedMonthsForForm: () => ({ data: undefined }) }));
vi.mock('../IncomeExpenseItemSelector', () => ({ default: () => null }));
vi.mock('../AttachmentUpload', () => ({ default: () => null }));

import IncomeExpenseForm from '../IncomeExpenseForm';

if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

const phieu = (over: Partial<IncomeExpenseWithRelations> = {}): IncomeExpenseWithRelations => ({
  detail_read: { complete: true, expected_item_count: 1 },
  id: 'v1', code: 'PT2610001', type: 'INCOME', name: 'Doanh thu bỏ cọc P101', building_id: 'b1',
  building_name: 'Toà A', room_id: null, tenant_id: null, contract_id: null, payer_name: null,
  receive_bank_account: null, receive_bank_name: null, account_id: 'a1', voucher_date: '2026-10-20',
  business_result_accounting: null, repeat_cycle: 'NONE', repeat_infinity: false, repeat_count: 0,
  attachments: [], approval_status: 'APPROVED', posting_status: 'POSTED', approval_version: 3,
  system_source: 'termination.forfeit_revenue', invoice_id: null, shareholder_id: null, total_amount: 500000,
  items: [{
    id: 'i1', income_expense_id: 'v1', income_expense_type_id: 't1', type_name: 'Doanh thu bỏ cọc',
    category: null, is_deposit: false, description: null, quantity: 1, unit_price: 500000,
    amount: 500000, start_date: null, end_date: null,
  }],
  ...over,
}) as unknown as IncomeExpenseWithRelations;

const nutLuu = () => screen.getByTestId('ie-form-save') as HTMLButtonElement;

beforeEach(() => { h.kqkd.mockReset(); h.revise.mockReset(); });
afterEach(cleanup);

it('đổi KQKD chưa rõ kết quả: báo rõ, giữ lý do, nút Lưu không khoá; bấm lại gửi lại đúng cờ đó', async () => {
  // Lỗi «chưa rõ» do bộ chống ghi trùng ném khi mất phản hồi (dấu giữ lại, lần bấm sau gửi lại ngay).
  h.kqkd.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận được kết quả đổi cách hạch toán phiếu. Tải lại trạng thái và đối chiếu giao dịch trước khi thực hiện tiếp.', 'unknown', []))
    .mockResolvedValueOnce({ id: 'v1', changed: false, business_result_accounting: false, kqkd_amount: 0, resent: true });
  const v = phieu();
  h.detail = v;
  const dong = vi.fn();
  render(<IncomeExpenseForm open onOpenChange={dong} voucher={v} />);
  fireEvent.click(screen.getByTestId('kqkd-switch'));
  fireEvent.change(screen.getByTestId('forfeit-kqkd-reason'), { target: { value: 'Khách bỏ cọc không tính lợi nhuận' } });
  fireEvent.click(nutLuu());
  await waitFor(() => expect(h.kqkd).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getAllByRole('alert').map(node => node.textContent).join(' ')).toContain('Chưa xác nhận'));
  expect((screen.getByTestId('forfeit-kqkd-reason') as HTMLTextAreaElement).value).toBe('Khách bỏ cọc không tính lợi nhuận');
  expect(nutLuu().disabled).toBe(false);
  fireEvent.click(nutLuu());
  await waitFor(() => expect(h.kqkd).toHaveBeenCalledTimes(2));
  expect(h.kqkd.mock.calls[1]?.[0]).toEqual(h.kqkd.mock.calls[0]?.[0]);
  expect(h.kqkd.mock.calls[0]?.[0]).toMatchObject({ voucherId: 'v1', kqkd: false, reason: 'Khách bỏ cọc không tính lợi nhuận' });
  await waitFor(() => expect(dong).toHaveBeenCalledWith(false));
  expect(h.revise).not.toHaveBeenCalled();
});
