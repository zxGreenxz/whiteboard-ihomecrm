// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { financialPending } from '@/lib/financialPending';

const h = vi.hoisted(() => ({
  create: vi.fn(), hold: vi.fn(), bonus: vi.fn(), close: vi.fn(), success: vi.fn(), error: vi.fn(),
  roomsError: false, roomsRetry: vi.fn(),
  exitRows: [] as unknown[], exitCalls: [] as [unknown, boolean | undefined][],
}));
// Không gọi máy chủ: băng báo phòng chờ khách sang nhượng đọc qua hook này.
vi.mock('@/hooks/contracts/useContractExitEarlyTerms', () => ({ useContractExitEarlyTerms: (filter: unknown, enabled?: boolean) => {
  h.exitCalls.push([filter, enabled]); return { data: h.exitRows, isError: false, error: null, refetch: vi.fn() };
} }));
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
vi.mock('@/hooks/useDepositIncomeHold',()=>({useDepositIncomeHold:()=>({data:null,isError:false,isLoading:false,status:'success',refetch:vi.fn()})}));
vi.mock('@/hooks/useRoomReservations', () => ({ useCreateRoomReservation: () => ({ mutateAsync: h.create, isPending: false }) }));
vi.mock('@/hooks/useReservationHoldDeadlines', () => ({ useSetReservationHoldTerms: () => ({ mutateAsync: h.hold, isPending: false }) }));
vi.mock('@/hooks/useSaleBonus', () => ({ useCreateSaleBonusFromDeposit: () => ({ mutateAsync: h.bonus, isPending: false }) }));
const room2Id = '00000000-0000-4000-8000-000000000009';
vi.mock('@/hooks/useRooms', () => ({ useRooms: () => query([{ id: roomId, name: '101', building_id: 'building1', rent_price: 1000000, building: { id: 'building1', name: 'Tòa Demo' } }, { id: room2Id, name: '102', building_id: 'building1', rent_price: 1000000, building: { id: 'building1', name: 'Tòa Demo' } }], h.roomsError, h.roomsRetry) }));
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
import { exitTermsRow } from '@/components/contracts/__tests__/exitEarlyTermsFixture';

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
async function prepare(bonus = false, amount = '500000', hint?: string, bonusReason = 'Thưởng theo thỏa thuận cho giao dịch cọc') {
  view();
  fireEvent.change(screen.getByRole('textbox', {name:'Người gửi'}), {target:{value:hint ?? 'Khách Demo'}});
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: roomId } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Số tiền cọc *' }), { target: { value: amount } });
  const date = screen.getByRole('textbox', { name: 'Giữ chỗ đến' });
  fireEvent.change(date, { target: { value: '02102026' } }); fireEvent.blur(date);
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: bookId } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Ghi chú' }), { target: { value: 'Giữ lại nội dung cọc' } });
  if (bonus) {
    fireEvent.change(document.querySelector('input[name="sale_bonus_amount"]')!, { target: { value: '200000' } });
    fireEvent.change(screen.getByRole('textbox',{name:/Lý do \/ căn cứ số tiền thưởng Sale/}),{target:{value:bonusReason}});
  }
  // User identity is read asynchronously and required by the durable scope.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' })).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' }));
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
  vi.clearAllMocks(); localStorage.clear(); h.roomsError = false; h.exitRows = []; h.exitCalls = [];
  h.create.mockResolvedValue(result(false)); h.hold.mockResolvedValue({}); h.bonus.mockResolvedValue({ voucherId: bonusId, code: 'PC-01', amount: 200000 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('kỳ hạn nằm trong một lần tạo giữ chỗ, không gọi writer legacy để ghi đè lần hai', async () => {
  h.hold.mockRejectedValue({ code: '42501', message: 'denied' }); await prepare(true);
  await waitFor(() => expect(h.close).toHaveBeenCalledWith(false));
  expect(h.hold).not.toHaveBeenCalled();
  expect(h.create).toHaveBeenCalledWith(expect.objectContaining({holdUntil:'2026-10-02',depositTarget:1000000}));
  expect(h.bonus).toHaveBeenCalledWith(expect.objectContaining({commissionReason:'Thưởng theo thỏa thuận cho giao dịch cọc'}));
  expect(financialPending.read({ namespace: 'deposit-create', userId, organizationId, businessKey: roomId })).toBeNull();
  expect(h.create).toHaveBeenCalledOnce();
});
it('thưởng Sale thiếu lý do chặn trước khi tạo cọc hoặc phiếu thưởng',async()=>{
  await prepare(true,'500000',undefined,'   ');
  expect(await screen.findByText(/Nhập lý do cụ thể/)).toBeTruthy();
  expect(h.create).not.toHaveBeenCalled();expect(h.bonus).not.toHaveBeenCalled();
});
it('thưởng timeout: cọc đã xong thì xong (gỡ dấu), thưởng lỗi báo riêng kèm mã phiếu cọc; hộp khoá nút để không tạo cọc lại', async () => {
  h.bonus.mockRejectedValue(new TypeError('Failed to fetch')); await prepare(true); await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toMatch(/thưởng Sale chưa hoàn tất/);
  expect(screen.getByRole('link', { name: 'Mở phiếu ' + voucherId })).toBeTruthy();
  expect(financialPending.read({ namespace: 'deposit-create', userId, organizationId, businessKey: roomId })).toBeNull();
  expect(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' })).toHaveProperty('disabled', true);
  expect(h.create).toHaveBeenCalledOnce(); expect(h.bonus).toHaveBeenCalledOnce(); expect(h.close).not.toHaveBeenCalled();
});

// Đợt 3: tạo cọc gửi lại cùng mã (cách B). create_room_reservation_v1 (production 24/11/2026) khoá dòng phòng
// rồi mới tra khoá (created_by, idempotency_key): cùng khoá cùng nội dung trả kết quả cũ, khác nội dung trả
// 23505; mỗi phòng một giữ chỗ đang sống. Máy chủ giả dưới đây làm đúng các luật đó.
describe('tạo cọc sau rớt mạng (gửi lại cùng mã)', () => {
  const scope = { namespace: 'deposit-create', userId, organizationId, businessKey: roomId };
  let stored: Map<string, { payload: string; response: unknown }>;
  let next: 'ok' | 'drop' | 'lost';
  const submitAgain = () => fireEvent.click(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' }));
  const keys = () => h.create.mock.calls.map(c => (c[0] as { idempotencyKey: string }).idempotencyKey);
  beforeEach(() => {
    stored = new Map(); next = 'ok';
    h.create.mockImplementation(async (input: { idempotencyKey: string }) => {
      const mode = next; next = 'ok';
      if (mode === 'drop') throw new TypeError('Failed to fetch');
      const { idempotencyKey, ...payload } = input; const text = JSON.stringify(payload);
      const prior = stored.get(idempotencyKey);
      if (prior && prior.payload !== text) throw { code: '23505', message: 'Khóa giữ chỗ đã dùng cho nội dung khác' };
      if (!prior && stored.size) throw { code: '55000', message: 'Phòng đã có khách giữ chỗ tiếp theo' };
      if (!prior) stored.set(idempotencyKey, { payload: text, response: result(false) });
      if (mode === 'lost') throw new TypeError('Failed to fetch');
      return stored.get(idempotencyKey)!.response;
    });
  });
  it('lệnh không tới máy chủ: nút vẫn bấm được, bấm lại gửi cùng mã, một giữ chỗ', async () => {
    next = 'drop'; await prepare(); await screen.findByRole('alert');
    expect(financialPending.read(scope)).not.toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' })).toHaveProperty('disabled', false));
    submitAgain();
    await waitFor(() => expect(h.close).toHaveBeenCalledWith(false));
    expect(keys()).toHaveLength(2); expect(keys()[1]).toBe(keys()[0]); expect(stored.size).toBe(1);
    expect(financialPending.read(scope)).toBeNull();
  });
  it('tới nhưng mất phản hồi: bấm lại nhận lại đúng giữ chỗ cũ, không tạo thêm', async () => {
    next = 'lost'; await prepare(); await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' })).toHaveProperty('disabled', false));
    submitAgain();
    await waitFor(() => expect(h.close).toHaveBeenCalledWith(false));
    expect(keys()[1]).toBe(keys()[0]); expect(stored.size).toBe(1);
  });
  it('tới nhưng mất phản hồi, sửa số tiền rồi lưu: báo đã tạo ở lần gửi trước, không tạo thêm, gỡ dấu', async () => {
    next = 'lost'; await prepare(); await screen.findByRole('alert');
    fireEvent.change(screen.getByRole('textbox', { name: 'Số tiền cọc *' }), { target: { value: '600000' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' })).toHaveProperty('disabled', false));
    submitAgain();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/đã được tạo ở lần gửi trước.*Mở Quản lý cọc/));
    expect(stored.size).toBe(1); expect(h.close).not.toHaveBeenCalled(); expect(financialPending.read(scope)).toBeNull();
  });
  it('review lượt 1: chưa rõ kết quả rồi đổi sang phòng khác ⇒ chặn, không tạo giữ chỗ cho phòng mới', async () => {
    next = 'lost'; await prepare(); await screen.findByRole('alert');
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: room2Id } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' })).toHaveProperty('disabled', false));
    submitAgain();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/phòng đã đổi/));
    expect(h.create).toHaveBeenCalledOnce(); expect(stored.size).toBe(1);
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: roomId } });
    submitAgain();
    await waitFor(() => expect(h.close).toHaveBeenCalledWith(false));
    expect(keys()[1]).toBe(keys()[0]); expect(stored.size).toBe(1);
  });
  it('review lượt 2: hộp luôn nằm trên trang, đóng rồi mở lại (prop open) thì hết chặn đổi phòng', async () => {
    next = 'drop';
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (open: boolean) => <QueryClientProvider client={client}><CreateDepositDialog open={open} onOpenChange={h.close} /></QueryClientProvider>;
    const r = render(ui(true));
    fireEvent.change(screen.getByRole('textbox', { name: 'Người gửi' }), { target: { value: 'anh Tuấn' } });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: roomId } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Số tiền cọc *' }), { target: { value: '500000' } });
    const date = screen.getByRole('textbox', { name: 'Giữ chỗ đến' }); fireEvent.change(date, { target: { value: '02102026' } }); fireEvent.blur(date);
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: bookId } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' })).toHaveProperty('disabled', false));
    submitAgain(); await screen.findByRole('alert');
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: room2Id } });
    submitAgain();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/phòng đã đổi/));
    r.rerender(ui(false)); r.rerender(ui(true));
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: room2Id } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' })).toHaveProperty('disabled', false));
    submitAgain();
    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(2));
    expect((h.create.mock.calls[1][0] as { roomId: string }).roomId).toBe(room2Id);
  });
  it('dấu cũ gieo sẵn (không tên thao tác): gửi ngay đúng mã của dấu cũ', async () => {
    const old = { ...scope, attemptId: '00000000-0000-4000-8000-0000000000aa', requestKey: 'room-reservation-00000000-0000-4000-8000-0000000000bb', completedIds: [], startedAt: '2026-11-20T01:00:00.000Z' };
    localStorage.setItem('ihome:financial-pending:v1:' + ['deposit-create', userId, organizationId, roomId].map(encodeURIComponent).join(':'), JSON.stringify(old));
    await prepare();
    await waitFor(() => expect(h.close).toHaveBeenCalledWith(false));
    expect(keys()).toEqual([old.requestKey]); expect(financialPending.read(scope)).toBeNull();
  });
});
it.each([false, true])('thông báo nhận cọc dùng received=%s từ máy chủ', async received => {
  h.create.mockResolvedValue(result(received)); await prepare();
  await waitFor(() => expect(h.close).toHaveBeenCalledWith(false));
  expect(h.success).toHaveBeenCalledWith(expect.stringContaining(received ? 'xác nhận khoản cọc đã thu' : 'Chưa xác nhận tiền vào quỹ'));
  expect(financialPending.read({ namespace: 'deposit-create', userId, organizationId, businessKey: roomId })).toBeNull();
});
it('lỗi nguồn phòng có retry và khóa gửi cọc', async () => {
  h.roomsError = true; view();
  expect(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
  await waitFor(() => expect(h.roomsRetry).toHaveBeenCalledOnce()); expect(h.create).not.toHaveBeenCalled();
});





it.each(['-10','abc2','1.5'])('tiền cọc invalid %s giữ raw/đỏ/focus, không gửi writer',async amount=>{
 await prepare(false,amount);fireEvent.submit(document.querySelector('form')!);const field=screen.getByRole('textbox',{name:'Số tiền cọc *'});expect(field).toHaveProperty('value',amount);expect(field.getAttribute('aria-invalid')).toBe('true');await waitFor(()=>expect(document.activeElement).toBe(field));expect(h.create).not.toHaveBeenCalled();expect(h.close).not.toHaveBeenCalled();
});
it('tên khách gợi nhớ gửi customerHint, không gửi customerId và không yêu cầu gắn khách', async () => {
  h.create.mockResolvedValue({ ...result(false), customer_id: null, customer_phone: null, customer_name: 'anh Tuấn', customer_hint: 'anh Tuấn' });
  await prepare(false, '500000', '  anh Tuấn  ');
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  const input = h.create.mock.calls[0][0];
  expect(input).toMatchObject({ roomId, customerHint: 'anh Tuấn', receipt: { amount: 500000, accountId: bookId } });
  expect(input).not.toHaveProperty('customerId');
  await waitFor(() => expect(h.success).toHaveBeenCalledWith(expect.not.stringContaining('gắn khách thật')));
});
it('phòng đang chờ khách sang nhượng: báo khách cọc là khách nhận, vẫn cho cọc', async () => {
  h.exitRows = [exitTermsRow({ room_id: roomId })];
  view();
  expect(screen.queryByRole('status', { name: 'Phòng đang chờ khách sang nhượng' })).toBeNull();
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: roomId } });
  const banner = await screen.findByRole('status', { name: 'Phòng đang chờ khách sang nhượng' });
  expect(banner.textContent).toContain('Phòng đang chờ khách sang nhượng từ 01/12/2026');
  expect(banner.textContent).toContain('Khách cọc phòng này là khách nhận; hợp đồng tạo sau sẽ tự nối với hồ sơ cũ.');
  expect(h.exitCalls.at(-1)).toEqual([{ roomId }, true]);
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: bookId } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' })).toHaveProperty('disabled', false));
});
it('thiếu khách hoặc số tiền 0 thì chặn tại form, không gọi writer', async () => {
  view();
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: roomId } });
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: bookId } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Tạo cọc & giữ chỗ' })).toHaveProperty('disabled', false));
  fireEvent.submit(document.querySelector('form')!);
  await screen.findByText('Nhập tên người gửi');
  expect(await screen.findByText(/Nhập số tiền cọc lớn hơn 0/)).toBeTruthy();
  expect(h.create).not.toHaveBeenCalled();
});
