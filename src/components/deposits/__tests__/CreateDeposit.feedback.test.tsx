// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { financialPending } from '@/lib/financialPending';

const h = vi.hoisted(() => ({
  create: vi.fn(), hold: vi.fn(), bonus: vi.fn(), close: vi.fn(), success: vi.fn(), error: vi.fn(),
  roomsError: false, roomsRetry: vi.fn(),
}));
const roomId = '00000000-0000-4000-8000-000000000001';
const customerId = '00000000-0000-4000-8000-000000000002';
const reservationId = '00000000-0000-4000-8000-000000000003';
const voucherId = '00000000-0000-4000-8000-000000000004';
const bookId = '00000000-0000-4000-8000-000000000005';
const bonusId = '00000000-0000-4000-8000-000000000006';
const organizationId = '00000000-0000-4000-8000-000000000007';
const userId = '00000000-0000-4000-8000-000000000008';
const query = (data: unknown, failed = false, refetch = vi.fn()) => ({
  data: failed ? undefined : data, status: failed ? 'error' : 'success', fetchStatus: 'idle',
  isError: failed, isLoading: false, error: failed ? new Error('Failed to fetch') : null, refetch,
});
vi.mock('@/hooks/useRoomReservations', () => ({ useCreateRoomReservation: () => ({ mutateAsync: h.create, isPending: false }) }));
vi.mock('@/hooks/useReservationHoldDeadlines', () => ({ useSetReservationHoldTerms: () => ({ mutateAsync: h.hold, isPending: false }) }));
vi.mock('@/hooks/useSaleBonus', () => ({ useCreateSaleBonusFromDeposit: () => ({ mutateAsync: h.bonus, isPending: false }) }));
vi.mock('@/hooks/useRooms', () => ({ useRooms: () => query([{ id: roomId, name: '101', building_id: 'building1', rent_price: 1000000, building: { id: 'building1', name: 'Tòa Demo' } }], h.roomsError, h.roomsRetry) }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => query([{ id: bookId, name: 'Sổ Demo', user_id: userId }]) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: organizationId }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: userId }) }));
vi.mock('sonner', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('@/components/contracts/CustomerSelectionDialog', () => ({
  CustomerSelectionDialog: ({ open, onSelect }: { open: boolean; onSelect: (c: unknown[]) => void }) =>
    open ? <button type="button" onClick={() => onSelect([{ id: customerId, full_name: 'Khách Demo', phone: '0900000000' }])}>Chọn khách Demo</button> : null,
}));
vi.mock('@/components/income-expenses/AttachmentUpload', () => ({ default: () => null }));
// Native selection stands in for Radix's layout-dependent popup in jsdom.
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (s: string) => void; children: React.ReactNode }) =>
    <select value={value} onChange={event => onValueChange(event.target.value)}><option value="">Chọn</option>{children}</select>,
  SelectTrigger: () => null, SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
}));
import { CreateDepositDialog } from '../CreateDepositDialog';

function result(received: boolean) {
  return {
    id: reservationId, organization_id: organizationId, building_id: 'building1', room_id: roomId, customer_id: customerId,
    customer_name: 'Khách Demo', customer_phone: '0900000000', building_name: 'Tòa Demo', room_name: '101',
    status: 'HOLD', claim_status: 'LIVE', revision: 1, hold_until: '2026-10-02', intended_move_in_on: null,
    topup_due_on: null, deposit_target: 1000000, notes: null, converted_contract_id: null, overdue: false,
    received_amount: received ? 500000 : 0, source_voucher_ids: [voucherId],
    receipts: [{ source_voucher_id: voucherId, source_item_id: 'item1', amount: 500000, received, approval_status: received ? 'APPROVED' : 'UNAPPROVED', code: 'PT-01', released: false }],
    created_at: '2026-09-30T01:00:00Z', updated_at: '2026-09-30T01:00:00Z', history: [],
  };
}
function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><CreateDepositDialog open onOpenChange={h.close} /></QueryClientProvider>);
}
async function prepare(bonus = false, amount = '500000') {
  view();
  fireEvent.click(screen.getByRole('button', { name: 'Khách hàng *' }));
  fireEvent.click(screen.getByRole('button', { name: 'Chọn khách Demo' }));
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: roomId } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Số tiền cọc *' }), { target: { value: amount } });
  const date = screen.getByRole('textbox', { name: 'Giữ phòng đến' });
  fireEvent.change(date, { target: { value: '02102026' } }); fireEvent.blur(date);
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: bookId } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Ghi chú' }), { target: { value: 'Giữ lại nội dung cọc' } });
  if (bonus) fireEvent.change(document.querySelector('input[name="sale_bonus_amount"]')!, { target: { value: '200000' } });
  // User identity is read asynchronously and required by the durable scope.
  await waitFor(() => expect(screen.getByRole('button', { name: /Tạo cọc & giữ chỗ|Giữ chỗ 0 đồng/ })).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', { name: /Tạo cọc & giữ chỗ|Giữ chỗ 0 đồng/ }));
}
beforeAll(() => {
  window.PointerEvent = MouseEvent as typeof PointerEvent;
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value() {} });
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { value() { return false; } });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value() {} });
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { value() {} });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); h.roomsError = false;
  h.create.mockResolvedValue(result(false)); h.hold.mockResolvedValue({}); h.bonus.mockResolvedValue({ voucherId: bonusId, code: 'PC-01', amount: 200000 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('kỳ hạn lỗi giữ draft và cả phiếu cọc/thưởng đã tạo, khóa tạo lại cọc', async () => {
  h.hold.mockRejectedValue({ code: '42501', message: 'denied' }); await prepare(true);
  await screen.findByRole('alert');
  expect(screen.getByRole('link', { name: 'Mở phiếu ' + voucherId }).getAttribute('href')).toContain(voucherId);
  expect(screen.getByRole('link', { name: 'Mở phiếu ' + bonusId }).getAttribute('href')).toContain(bonusId);
  expect(screen.getByRole('textbox', { name: 'Ghi chú' })).toHaveProperty('value', 'Giữ lại nội dung cọc');
  expect(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' })).toHaveProperty('disabled', true);
  expect(h.close).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled();
  const pending = financialPending.read({ namespace: 'deposit-create', userId, organizationId, businessKey: roomId });
  expect(pending?.completedIds).toEqual([reservationId, voucherId, bonusId]);
  fireEvent.submit(document.querySelector('form')!);
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
});
it('thưởng timeout giữ phiếu cọc và chặn gửi lại sau đóng/mở DOM mới', async () => {
  h.bonus.mockRejectedValue(new TypeError('Failed to fetch')); await prepare(true); await screen.findByRole('alert');
  expect(screen.getByRole('link', { name: 'Mở phiếu ' + voucherId })).toBeTruthy();
  cleanup(); await prepare(true);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(reservationId));
  expect(screen.getByRole('alert').textContent).toContain(voucherId);
  expect(h.create).toHaveBeenCalledOnce(); expect(h.close).not.toHaveBeenCalled();
});
it.each([false, true])('thông báo nhận cọc dùng received=%s từ máy chủ', async received => {
  h.create.mockResolvedValue(result(received)); await prepare();
  await waitFor(() => expect(h.close).toHaveBeenCalledWith(false));
  expect(h.success).toHaveBeenCalledWith(expect.stringContaining(received ? 'xác nhận khoản cọc đã thu' : 'Chưa xác nhận tiền vào quỹ'));
  expect(financialPending.read({ namespace: 'deposit-create', userId, organizationId, businessKey: roomId })).toBeNull();
});
it('lỗi nguồn phòng có retry và khóa gửi cọc', async () => {
  h.roomsError = true; view();
  expect(screen.getByRole('button', { name: 'Giữ chỗ 0 đồng' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
  await waitFor(() => expect(h.roomsRetry).toHaveBeenCalledOnce()); expect(h.create).not.toHaveBeenCalled();
});





it.each(['-10','abc2','1.5'])('tiền cọc invalid %s giữ raw/đỏ/focus, không gửi writer',async amount=>{
 await prepare(false,amount);fireEvent.submit(document.querySelector('form')!);const field=screen.getByRole('textbox',{name:'Số tiền cọc *'});expect(field).toHaveProperty('value',amount);expect(field.getAttribute('aria-invalid')).toBe('true');await waitFor(()=>expect(document.activeElement).toBe(field));expect(h.create).not.toHaveBeenCalled();expect(h.close).not.toHaveBeenCalled();
});
