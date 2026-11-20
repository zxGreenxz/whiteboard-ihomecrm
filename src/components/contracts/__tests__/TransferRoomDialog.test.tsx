// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import { TransferRoomDialog } from '../TransferRoomDialog';

const h = vi.hoisted(() => ({
  rooms: vi.fn(), mutate: vi.fn(), refetch: vi.fn(), close: vi.fn(), pending: false,
}));
vi.mock('@/hooks/useContractOperations', () => ({
  useTransferRoom: () => ({ mutate: h.mutate, isPending: h.pending }),
}));
vi.mock('@/hooks/useRooms', () => ({ useRooms: h.rooms }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const contract = {
  id: id(1), updated_at: '2026-10-02T03:00:00Z', status: 'ACTIVE',
  room_id: id(2), room: { id: id(2), building_id: id(3), name: 'Phòng nguồn', building: { id: id(3), name: 'Tòa A' } },
  expected_move_out_date: '2026-10-29', rent_price: 100,
} as ContractWithRelations;
const rooms = [
  { id: id(4), building_id: id(3), name: 'Phòng đích', status: 'AVAILABLE' },
  { id: id(2), building_id: id(3), name: 'Phòng nguồn', status: 'AVAILABLE' },
  { id: id(5), building_id: id(9), name: 'Phòng khác tòa', status: 'AVAILABLE' },
  { id: id(6), building_id: id(3), name: 'Phòng bảo trì', status: 'MAINTENANCE' },
];
const loadRooms = (data = rooms, state = {}) => h.rooms.mockReturnValue({
  data, isError: false, isLoading: false, refetch: h.refetch, ...state,
});
const dialog = (c = contract, open = true) => <TransferRoomDialog contract={c} open={open} onOpenChange={h.close} />;
const submit = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Chuyển phòng' });
const chooseRoom = () => fireEvent.change(screen.getByRole('combobox', { name: /Phòng mới/ }), { target: { value: id(4) } });
const reason = 'Khách cần thêm diện tích';
const enterReason = () => fireEvent.change(screen.getByLabelText(/Lý do chuyển phòng/), { target: { value: reason } });

beforeEach(() => { vi.clearAllMocks(); h.pending = false; loadRooms(); });
afterEach(cleanup);

it('chỉ đọc khi mở, chỉ cho chọn phòng trống khác trong tòa của hợp đồng', () => {
  const ui = render(dialog(contract, false));
  expect(h.rooms).not.toHaveBeenCalled();
  ui.rerender(dialog());
  expect(h.rooms).toHaveBeenCalledWith(id(3), { enabled: true });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Chọn phòng', 'Phòng đích']);
  expect(screen.getByText(/thanh lý hợp đồng hiện tại rồi lập hợp đồng mới/i)).toBeTruthy();
  expect(screen.getByText(/Báo dọn ngày 29\/10\/2026/)).toBeTruthy();
  expect(submit().disabled).toBe(true);
});

it.each([
  ['giữ nguyên giá khi xóa số đã nhập', '', undefined],
  ['đổi giá khi nhập số dương', '250', 250],
  ['đặt giá 0 khi nhập rõ số 0', '0', 0],
] as const)('%s và chỉ đóng sau khi nhận kết quả thành công', async (_, raw, expected) => {
  render(dialog());
  chooseRoom();
  enterReason();
  const rent = screen.getByLabelText('Giá thuê mới');
  fireEvent.change(rent, { target: { value: '123' } });
  fireEvent.change(rent, { target: { value: raw } });
  fireEvent.change(screen.getByLabelText(/Ngày chuyển/), { target: { value: '15102026' } });
  fireEvent.click(submit());
  await waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(1));
  expect(h.mutate.mock.calls[0][0]).toMatchObject({
    contractId: contract.id, expectedUpdatedAt: contract.updated_at, newRoomId: id(4),
    newRentPrice: expected, transferDate: '2026-10-15', notes: reason, noticeReason: reason,
  });
  expect(h.close).not.toHaveBeenCalled();
  h.mutate.mock.calls[0][1].onSuccess();
  expect(h.close).toHaveBeenCalledWith(false);
});

it('chặn ngày trống, ngày sai và lý do quá ngắn', async () => {
  render(dialog());
  chooseRoom();
  const date = screen.getByLabelText(/Ngày chuyển/);
  fireEvent.change(date, { target: { value: '' } });
  fireEvent.click(submit());
  await screen.findByText('Ngày chuyển không được để trống');
  fireEvent.change(date, { target: { value: '31022026' } });
  fireEvent.click(submit());
  expect(screen.getByText(/Nhập ngày hợp lệ/)).toBeTruthy();
  fireEvent.change(date, { target: { value: '20102026' } });
  fireEvent.change(screen.getByLabelText(/Lý do chuyển phòng/), { target: { value: 'ngắn' } });
  fireEvent.click(submit());
  await screen.findByText(/Nhập lý do cụ thể/);
  expect(h.mutate).not.toHaveBeenCalled();
});

it('giữ thông tin đang nhập khi cùng phiên bản và chặn ghi nếu phiên bản đã đổi', () => {
  const ui = render(dialog());
  chooseRoom();
  enterReason();
  ui.rerender(dialog({ ...contract }));
  expect(screen.getByDisplayValue(reason)).toBeTruthy();
  expect(submit().disabled).toBe(false);
  const changed = { ...contract, updated_at: '2026-10-03T04:05:06Z' };
  ui.rerender(dialog(changed));
  expect(screen.getByDisplayValue(reason)).toBeTruthy();
  expect(screen.getByText(/Hợp đồng đã thay đổi/)).toBeTruthy();
  expect(submit().disabled).toBe(true);
  ui.rerender(dialog(changed, false));
  ui.rerender(dialog(changed));
  expect(screen.queryByDisplayValue(reason)).toBeNull();
  chooseRoom();
  expect(submit().disabled).toBe(false);
});

it('phân biệt đang tải, lỗi có nút thử lại, hết phòng và toà nguồn bị thiếu', () => {
  loadRooms([], { isLoading: true });
  const ui = render(dialog());
  expect(screen.getByRole('status').textContent).toMatch(/Đang tải danh sách phòng/);
  loadRooms(rooms, { isError: true });
  ui.rerender(dialog());
  expect(screen.getByRole('alert').textContent).toMatch(/Không tải được danh sách phòng/);
  expect(submit().disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
  expect(h.refetch).toHaveBeenCalledTimes(1);
  loadRooms([]);
  ui.rerender(dialog());
  expect(screen.getByText(/hiện không có phòng trống/)).toBeTruthy();
  ui.rerender(dialog({ ...contract, room: null }));
  expect(h.rooms).toHaveBeenLastCalledWith(undefined, { enabled: false });
  expect(screen.getByRole('alert').textContent).toMatch(/Chưa xác định được tòa nhà/);
});

it('chặn gửi nếu phòng đã chọn hết trống hoặc yêu cầu đang xử lý', () => {
  const ui = render(dialog());
  chooseRoom();
  enterReason();
  loadRooms([]);
  ui.rerender(dialog());
  expect(screen.getByRole('alert').textContent).toMatch(/Phòng đã chọn không còn trống/);
  expect(submit().disabled).toBe(true);
  loadRooms();
  h.pending = true;
  ui.rerender(dialog());
  expect(submit().disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Hủy' }).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  expect(h.mutate).not.toHaveBeenCalled();
});

it('loại phòng máy chủ báo vừa có hợp đồng dù danh sách vẫn còn phòng đó và giữ bản nhập', async () => {
  const nextRoom = { ...rooms[0], id: id(7), name: 'Phòng còn trống' };
  loadRooms([...rooms, nextRoom]);
  render(dialog());
  chooseRoom();
  enterReason();
  fireEvent.change(screen.getByLabelText('Giá thuê mới'), { target: { value: '250' } });
  fireEvent.change(screen.getByLabelText(/Ngày chuyển/), { target: { value: '15102026' } });
  fireEvent.click(submit());
  await waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(1));
  act(() => h.mutate.mock.calls[0][1].onError({ code: 'P0001', message: 'Phòng mới đã có hợp đồng đang hiệu lực' }));
  expect(screen.queryByRole('option', { name: 'Phòng đích' })).toBeNull();
  expect(screen.getByRole('alert').textContent).toMatch(/không còn trống/);
  expect(submit().disabled).toBe(true);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: nextRoom.id } });
  fireEvent.click(submit());
  await waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(2));
  expect(h.mutate.mock.calls[1][0]).toMatchObject({ newRoomId: nextRoom.id, newRentPrice: 250, transferDate: '2026-10-15', notes: reason });
});
