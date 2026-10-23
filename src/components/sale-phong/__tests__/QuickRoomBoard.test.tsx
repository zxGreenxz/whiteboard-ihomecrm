// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Room } from '@/pages/phong-trong/sampleData';
import { SaleRoomOperationError, type SaleRoomInventoryRow } from '@/lib/saleRoomOperations';
import QuickRoomBoard from '../QuickRoomBoard';

const state = vi.hoisted(() => ({
  org: 'org-a', actor: 'actor-a',
  query: { data: undefined as { rooms: SaleRoomInventoryRow[]; serverNow: string } | undefined, isError: false, isLoading: false, isFetching: false, dataUpdatedAt: Date.now(), refetch: vi.fn() },
  save: vi.fn(), pending: false,
}));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: state.org }) }));
vi.mock('@/hooks/useAuth', () => ({ useSession: () => ({ data: { user: { id: state.actor } } }) }));
vi.mock('@/hooks/useSaleRoomInventory', () => ({
  useSaleRoomInventory: () => state.query, usePatchSaleRoom: () => ({ mutateAsync: state.save, isPending: state.pending }),
}));
vi.mock('../SaleImageManager', () => ({ default: ({ value, onChange, disabled, onUploadingChange }: {
  value: string[]; onChange: (images: string[]) => void; disabled: boolean; onUploadingChange: (busy: boolean) => void;
}) => <div aria-label="Ảnh phòng">
  <button type="button" disabled={disabled} onClick={() => onUploadingChange(true)}>Bắt đầu tải ảnh thử</button>
  <button type="button" onClick={() => { onChange([...value, 'room-sale-images/actor/new.jpg']); onUploadingChange(false); }}>Hoàn tất ảnh thử</button>
  <span>{value.length} ảnh trong nháp</span>
</div> }));
vi.mock('../PassListingsTab', () => ({ default: ({ focusRoomId, onFocusedClose, blockedReason }: { focusRoomId: string; onFocusedClose: () => void; blockedReason?: string }) =>
  <div role="dialog" aria-label={`Pass ${focusRoomId}`}><p>{blockedReason}</p><button disabled={!!blockedReason}>Lưu pass thử</button><button onClick={onFocusedClose}>Đóng pass thử</button></div> }));
vi.mock('@/pages/phong-trong/LockRoomModal', () => ({ LockRoomModal: ({ action, onDone, blockedReason }: {
  action: { room: Room; mode: string }; onDone: (message: string) => void; blockedReason?: string;
}) => <div role="dialog" aria-label={`${action.mode} ${action.room.id}`}><p>{blockedReason}</p><button disabled={!!blockedReason} onClick={() => onDone('Đã cập nhật lock')}>Xác nhận lock thử</button></div> }));
vi.mock('@/pages/phong-trong/QuickDepositModal', () => ({ QuickDepositModal: ({ room, blockedReason }: { room: Room; blockedReason?: string }) =>
  <div role="dialog" aria-label={`Cọc ${room.id}`}><p>{blockedReason}</p><button disabled={!!blockedReason}>Lưu cọc thử</button></div> }));
vi.mock('@/components/rooms/RoomTurnoverPanel', () => ({ RoomTurnoverPanel: ({ roomId, canEdit, onSaved }: {
  roomId: string; canEdit: boolean; onSaved: () => void;
}) => <section aria-label={`Dọn sửa ${roomId}`}><button disabled={!canEdit} onClick={onSaved}>Lưu dọn sửa thử</button></section> }));

function room(id = 'room-a', buildingId = 'building-a', status: Room['status'] = 'free'): SaleRoomInventoryRow {
  return {
    room: { id, no: 101, code: '101', buildingId, buildingName: buildingId === 'building-a' ? 'Tòa Ánh Dương' : 'Tòa Bình Minh',
      buildingArea: '', buildingAddr: '', floor: 1, type: 'Studio', price: 3, area: 25, status, amenities: ['Máy lạnh'],
      availDate: '', imgCount: 0, phClass: '', images: [], x: 0, y: 0, w: 1, h: 1 },
    buildingId, buildingName: buildingId === 'building-a' ? 'Tòa Ánh Dương' : 'Tòa Bình Minh',
    name: '101', code: '101', revision: 'a'.repeat(32), updatedAt: '2026-10-21T05:00:00Z', updatedByName: null,
    rentPrice: 3000000, area: 25, roomType: 'Studio', amenities: ['Máy lạnh'],
    saleNote: 'Chính sách gửi khách', saleBonusNote: 'Thưởng nội bộ', description: 'Phòng có ban công', images: [],
    capabilities: { edit: true, images: true, pass: true, lock: true, releaseLock: false, deposit: true },
  };
}
const openFirst = () => fireEvent.click(screen.getByRole('button', { name: 'Mở Tòa Ánh Dương · 101' }));
const price = () => screen.getByLabelText('Giá niêm yết (đ/tháng)');
const changePrice = (value: string) => fireEvent.change(price(), { target: { value } });
beforeEach(() => {
  sessionStorage.clear(); state.org = 'org-a'; state.actor = 'actor-a'; state.pending = false;
  Object.assign(state.query, { data: { rooms: [room(), room('room-b', 'building-b', 'rented')], serverNow: '2026-10-21T05:01:00Z' }, isError: false, isLoading: false, isFetching: false });
  state.query.refetch.mockReset().mockResolvedValue({}); state.save.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

it.each([false, true])('U01 — Chủ trọ: cho tôi tìm không dấu đúng tòa và cả phòng đã thuê trên máy tính/điện thoại, mobile=%s', mobile => {
  render(<QuickRoomBoard mobile={mobile} />);
  expect(screen.getByText('Tòa Bình Minh · 101')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Tìm tòa hoặc phòng'), { target: { value: 'anh duong' } });
  expect(screen.queryByText('Tòa Bình Minh · 101')).toBeNull();
  expect(screen.getByText('Tòa Ánh Dương · 101')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Tìm tòa hoặc phòng'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Tình trạng'), { target: { value: 'rented' } });
  expect(screen.queryByText('Tòa Ánh Dương · 101')).toBeNull();
  expect(screen.getByText('Tòa Bình Minh · 101')).toBeTruthy();
});

it('U02 — Quản lý: chỉ lưu giá/chính sách vừa sửa, giữ các trường khác và báo đúng phòng đã lưu', async () => {
  render(<QuickRoomBoard />); openFirst(); changePrice('3250000');
  fireEvent.change(screen.getByLabelText('Khuyến mãi / chính sách gửi khách'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
  expect(state.save.mock.calls[0][0]).toEqual({
    roomId: 'room-a', expectedRevision: 'a'.repeat(32), requestId: expect.any(String), patch: { rent_price: 3250000, sale_note: null },
  });
  await screen.findByText('Đã lưu Tòa Ánh Dương · 101.');
  expect(screen.queryByLabelText('Giá niêm yết (đ/tháng)')).toBeNull();
  expect(state.query.refetch).toHaveBeenCalled();
  expect(JSON.parse(sessionStorage.getItem('sale-room-drafts:v1:actor-a:org-a')!)).toEqual({});
});

it('U03 — Quản lý: người khác vừa sửa phòng thì giữ nháp của tôi, đối chiếu giá mới trước khi ghi', () => {
  const view = render(<QuickRoomBoard />); openFirst(); changePrice('3500000');
  state.query.data = { ...state.query.data!, rooms: [{ ...room(), revision: 'b'.repeat(32), rentPrice: 4000000 }] };
  view.rerender(<QuickRoomBoard />);
  expect(price()).toHaveProperty('value', '3500000');
  expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toHaveProperty('disabled', true);
  expect(screen.getByText(/Thông tin máy chủ đã thay đổi/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Dùng bản mới, bỏ bản nháp' }));
  expect(price()).toHaveProperty('value', '4000000');
  expect(state.save).not.toHaveBeenCalled();
});

it('U04 — Chủ công ty: mất phản hồi lưu phải đối chiếu đúng yêu cầu cũ, kể cả sau khi quyền thay đổi', async () => {
  state.save.mockRejectedValueOnce(new SaleRoomOperationError('Chưa xác nhận được lần lưu.', 'unknown'));
  const view = render(<QuickRoomBoard />); openFirst(); changePrice('3600000');
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  await screen.findByRole('button', { name: 'Đối chiếu lần lưu' });
  const first = state.save.mock.calls[0][0];
  expect(price().closest('fieldset')).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: 'Dùng bản mới, bỏ bản nháp' })).toBeNull();
  view.unmount();
  const changed = { ...room(), revision: 'b'.repeat(32), capabilities: { ...room().capabilities, edit: false } };
  state.query.data = { ...state.query.data!, rooms: [changed] };
  render(<QuickRoomBoard />); openFirst();
  fireEvent.click(screen.getByRole('button', { name: 'Đối chiếu lần lưu' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(2));
  expect(state.save.mock.calls[1][0]).toEqual(first);
  await screen.findByText('Đã lưu Tòa Ánh Dương · 101.');
});

it('U05 — Quản lý: nhập giá sai phải chỉ đúng ô, giữ nháp qua đóng/mở và không lộ sang nhân viên khác', () => {
  const view = render(<QuickRoomBoard />); openFirst(); changePrice('abc');
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  expect(screen.getByText(/Nhập giá nguyên không âm/)).toBeTruthy();
  expect(document.activeElement).toBe(price());
  fireEvent.click(screen.getByRole('button', { name: 'Đóng, giữ bản nháp' }));
  openFirst(); expect(price()).toHaveProperty('value', 'abc');
  view.unmount(); const again = render(<QuickRoomBoard />); openFirst();
  expect(price()).toHaveProperty('value', 'abc'); again.unmount();
  state.actor = 'actor-b'; render(<QuickRoomBoard />); openFirst();
  expect(price()).toHaveProperty('value', '3000000'); expect(state.save).not.toHaveBeenCalled();
});

it.each(['42501', 'PT409'])('U29 — đối chiếu sau mất phản hồi bị %s vẫn giữ yêu cầu chưa xác nhận', async code => {
  state.save.mockRejectedValueOnce(new SaleRoomOperationError('Mất phản hồi', 'unknown'))
    .mockRejectedValueOnce(new SaleRoomOperationError('Không đối chiếu được', code === 'PT409' ? 'conflict' : 'rejected', code));
  render(<QuickRoomBoard />); openFirst(); changePrice('3650000');
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  await screen.findByRole('button', { name: 'Đối chiếu lần lưu' });
  const first = state.save.mock.calls[0][0];
  fireEvent.click(screen.getByRole('button', { name: 'Đối chiếu lần lưu' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Đối chiếu lần lưu' })).toBeTruthy());
  expect(state.save.mock.calls[1][0]).toEqual(first);
  expect(price().closest('fieldset')).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: 'Dùng bản mới, bỏ bản nháp' })).toBeNull();
  const stored = JSON.parse(sessionStorage.getItem('sale-room-drafts:v1:actor-a:org-a')!);
  expect(stored['room-a'].request).toMatchObject({ id: first.requestId, unknown: true });
});

it('U06 — Chủ công ty: nhân viên chỉ sửa ảnh không được sửa giá, xem thưởng nội bộ hoặc tạo cọc/lock/pass', () => {
  const row = room(); row.capabilities = { edit: false, images: true, pass: false, lock: false, releaseLock: false, deposit: false };
  state.query.data!.rooms = [row]; render(<QuickRoomBoard />);
  expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Cọc' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Báo pass' })).toBeNull();
  openFirst(); expect(price().closest('fieldset')).toHaveProperty('disabled', true);
  expect(screen.queryByText('Thưởng nội bộ')).toBeNull();
  expect(screen.queryByLabelText('Thưởng sale · chỉ nội bộ')).toBeNull();
  expect(screen.getByRole('button', { name: 'Bắt đầu tải ảnh thử' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Dọn sửa room-a' })).toBeNull();
});

it('U07 — Sale Admin: đang tải ảnh thì không được lưu thiếu ảnh hay chuyển phòng làm mất ảnh', async () => {
  render(<QuickRoomBoard />); openFirst(); changePrice('3700000');
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu tải ảnh thử' }));
  expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Đóng, giữ bản nháp' })).toHaveProperty('disabled', true);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(price()).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Hoàn tất ảnh thử' }));
  expect(screen.getByText('1 ảnh trong nháp')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ patch: { rent_price: 3700000, images: ['room-sale-images/actor/new.jpg'] } })));
});

it('U08 — Quản lý: mất kết nối đọc thì vẫn xem dữ liệu cũ có cảnh báo, khóa ghi và cho tải lại', () => {
  const view = render(<QuickRoomBoard />); openFirst(); changePrice('3800000');
  state.query.isError = true; view.rerender(<QuickRoomBoard />);
  expect(price()).toHaveProperty('value', '3800000');
  expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Đóng, giữ bản nháp' }));
  expect(screen.getByText('Tòa Bình Minh · 101')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
  expect(state.query.refetch).toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
});

it('U09 — Sale Admin: bấm pass/lock/cọc trên dòng nào phải mở đúng phòng đó, không nhầm phòng trùng tên', () => {
  const view = render(<QuickRoomBoard />);
  const first = screen.getByText('Tòa Ánh Dương · 101').closest('tr')!;
  fireEvent.click(within(first).getByRole('button', { name: 'Báo pass' }));
  expect(screen.getByRole('dialog', { name: 'Pass room-a' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Đóng pass thử' }));
  fireEvent.click(within(first).getByRole('button', { name: 'Lock' }));
  expect(screen.getByRole('dialog', { name: 'lock room-a' })).toBeTruthy();
  view.unmount(); render(<QuickRoomBoard />);
  fireEvent.click(screen.getByRole('button', { name: 'Cọc' }));
  expect(screen.getByRole('dialog', { name: 'Cọc room-a' })).toBeTruthy();
  cleanup(); render(<QuickRoomBoard />); openFirst();
  fireEvent.click(screen.getByRole('button', { name: 'Lưu dọn sửa thử' }));
  expect(state.query.refetch).toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Mở hồ sơ phòng và hợp đồng để báo trả' })).toHaveProperty('href', expect.stringContaining('/rooms/room-a'));
  expect(state.save).not.toHaveBeenCalled();
});

it('U10 — Chủ trọ: lọc phòng đang dọn sửa riêng, không gộp thành phòng trống sẵn', () => {
  const preparing = room('room-c', 'building-b');
  preparing.name = '102'; preparing.room.saleFact = { kind: 'preparing', label: 'Đang chuẩn bị · chưa có ngày dự kiến', availableOn: null };
  state.query.data!.rooms = [room(), preparing];
  render(<QuickRoomBoard />);
  fireEvent.change(screen.getByLabelText('Tình trạng'), { target: { value: 'free' } });
  expect(screen.getByText('Tòa Ánh Dương · 101')).toBeTruthy();
  expect(screen.queryByText('Tòa Bình Minh · 102 (101)')).toBeNull();
  fireEvent.change(screen.getByLabelText('Tình trạng'), { target: { value: 'preparing' } });
  expect(screen.queryByText('Tòa Ánh Dương · 101')).toBeNull();
  expect(screen.getByText('Đang chuẩn bị · chưa có ngày dự kiến')).toBeTruthy();
});

it('U11 — Sale Admin: liệt kê phòng thiếu ảnh để tôi bổ sung, kể cả phòng đang có khách', () => {
  const withPhoto = room(); withPhoto.images = ['room-sale-images/actor/front.jpg'];
  state.query.data!.rooms = [withPhoto, room('room-b', 'building-b', 'rented')];
  render(<QuickRoomBoard />);
  fireEvent.change(screen.getByLabelText('Tình trạng'), { target: { value: 'missing-images' } });
  expect(screen.queryByText('Tòa Ánh Dương · 101')).toBeNull();
  expect(screen.getByText('Tòa Bình Minh · 101')).toBeTruthy();
  expect(screen.getByText('1/2 phòng')).toBeTruthy();
});

it('U12 — Quản lý: lọc các bản nháp của tôi để hoàn tất sau, không trộn với phòng chưa sửa', () => {
  render(<QuickRoomBoard />); openFirst(); changePrice('3900000');
  fireEvent.click(screen.getByRole('button', { name: 'Đóng, giữ bản nháp' }));
  fireEvent.change(screen.getByLabelText('Tình trạng'), { target: { value: 'draft' } });
  expect(screen.getByText('Tòa Ánh Dương · 101')).toBeTruthy();
  expect(screen.queryByText('Tòa Bình Minh · 101')).toBeNull();
  expect(screen.getByText('1/2 phòng · 1 bản nháp của bạn')).toBeTruthy();
  openFirst(); expect(price()).toHaveProperty('value', '3900000');
});

it('U13 — Chủ công ty: chuyển tổ chức không được đem nháp hoặc lần lưu của công ty trước sang công ty mới', () => {
  const view = render(<QuickRoomBoard />); openFirst(); changePrice('4100000');
  state.org = 'org-b'; view.rerender(<QuickRoomBoard />);
  expect(screen.queryByLabelText('Giá niêm yết (đ/tháng)')).toBeNull();
  openFirst(); expect(price()).toHaveProperty('value', '3000000');
  state.org = 'org-a'; view.rerender(<QuickRoomBoard />);
  openFirst(); expect(price()).toHaveProperty('value', '4100000');
  expect(state.save).not.toHaveBeenCalled();
});

it('U14 — Quản lý: máy chủ từ chối vì dữ liệu đã đổi thì không được bấm lưu lặp dù lần tải lại chưa về', async () => {
  state.save.mockRejectedValueOnce(new SaleRoomOperationError('Dữ liệu đã đổi', 'conflict', 'PT409'));
  render(<QuickRoomBoard />); openFirst(); changePrice('4200000');
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  await screen.findByText(/Phòng đã được người khác cập nhật/);
  expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toHaveProperty('disabled', true);
  expect(price()).toHaveProperty('value', '4200000');
  expect(screen.queryByRole('button', { name: 'Đối chiếu lần lưu' })).toBeNull();
  expect(state.save).toHaveBeenCalledTimes(1);
});

it('U15 — Sale Admin: trường hợp bị từ chối rõ ràng phải giữ nội dung cho tôi sửa và gửi yêu cầu mới', async () => {
  state.save.mockRejectedValueOnce(new SaleRoomOperationError('Nội dung cập nhật không hợp lệ.', 'rejected', '22023'));
  render(<QuickRoomBoard />); openFirst(); changePrice('4300000');
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  await screen.findByText('Nội dung cập nhật không hợp lệ.');
  expect(screen.queryByRole('button', { name: 'Đối chiếu lần lưu' })).toBeNull();
  expect(price()).toHaveProperty('value', '4300000');
  const first = state.save.mock.calls[0][0];
  changePrice('4400000'); fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(2));
  expect(state.save.mock.calls[1][0].patch).toEqual({ rent_price: 4400000 });
  expect(state.save.mock.calls[1][0].requestId).not.toBe(first.requestId);
});

it('U16 — Chủ trọ: hiện rõ giờ hết lock và chỉ cho người đủ quyền gỡ đúng lock của phòng', () => {
  const locked = room('room-a', 'building-a', 'locked');
  locked.room.saleLock = { id: 'lock-a', hours: 6, note: null, lockedAt: '2026-10-21T05:00:00Z', expiresAt: '2026-10-21T11:00:00Z', lockedByName: 'Quản lý', lockedByMe: true };
  locked.capabilities.releaseLock = true; state.query.data!.rooms = [locked];
  render(<QuickRoomBoard />);
  expect(within(screen.getByRole('table')).getByText('Đang lock')).toBeTruthy();
  expect(screen.getByText(/^Đến /)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Gỡ lock' }));
  expect(screen.getByRole('dialog', { name: 'release room-a' })).toBeTruthy();
});

it('U17 — Chủ công ty: phòng đã thuê không mở tạo cọc nhanh, phòng lock còn đúng quyền vẫn đi qua quy trình cọc', () => {
  state.query.data!.rooms = [room('room-a', 'building-a', 'locked'), room('room-b', 'building-b', 'rented')];
  render(<QuickRoomBoard />);
  const rented = screen.getByText('Tòa Bình Minh · 101').closest('tr')!;
  expect(within(rented).queryByRole('button', { name: 'Cọc' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cọc' }));
  expect(screen.getByRole('dialog', { name: 'Cọc room-a' })).toBeTruthy();
  expect(state.save).not.toHaveBeenCalled();
});

it('U18 — Quản lý: cập nhật dọn sửa phải dùng quy trình có lịch sử và tải lại trạng thái, không tự sửa status', () => {
  render(<QuickRoomBoard />); openFirst();
  expect(screen.getByRole('region', { name: 'Dọn sửa room-a' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Lưu dọn sửa thử' }));
  expect(state.query.refetch).toHaveBeenCalledTimes(1);
  expect(state.save).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Tình trạng phòng')).toBeNull();
});

it('U19 — Quản lý: báo trả phải mở hồ sơ đúng phòng và hợp đồng, không đoán hợp đồng từ số phòng', () => {
  render(<QuickRoomBoard />);
  fireEvent.click(screen.getByRole('button', { name: 'Mở Tòa Bình Minh · 101' }));
  const link = screen.getByRole('link', { name: 'Mở hồ sơ phòng và hợp đồng để báo trả' });
  expect(link.getAttribute('href')).toBe('/rooms/room-b');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(screen.getByText(/ngày hết hạn hợp đồng không tự xác nhận phòng trống/)).toBeTruthy();
  expect(state.save).not.toHaveBeenCalled();
});

it('U20 — Chủ trọ: danh sách thực sự rỗng phải nói chưa có phòng, còn đang tải không được báo rỗng', () => {
  state.query.data = undefined; state.query.isLoading = true;
  const view = render(<QuickRoomBoard />);
  expect(screen.queryByText('Chưa có phòng trong phạm vi được giao.')).toBeNull();
  state.query.isLoading = false; state.query.data = { rooms: [], serverNow: '2026-10-21T05:00:00Z' };
  view.rerender(<QuickRoomBoard />);
  expect(screen.getByText('Chưa có phòng trong phạm vi được giao.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Lưu thay đổi' })).toBeNull();
});

it('U21 — Chủ công ty: phòng bị thu hồi phạm vi giữa lúc sửa không được ghi sang phòng khác', () => {
  const view = render(<QuickRoomBoard />); openFirst(); changePrice('4500000');
  state.query.data!.rooms = [room('room-b', 'building-b')]; view.rerender(<QuickRoomBoard />);
  expect(screen.getByText('Phòng không còn trong danh sách')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Lưu thay đổi' })).toBeNull();
  expect(JSON.parse(sessionStorage.getItem('sale-room-drafts:v1:actor-a:org-a')!)['room-a'].price).toBe('4500000');
  expect(state.save).not.toHaveBeenCalled();
});

it('U22 — Chủ trọ: phòng khách pass hiển thị giá pass riêng và không làm lẫn với giá niêm yết khi sửa', () => {
  const pass = room('room-a', 'building-a', 'pass'); pass.room.price = 2.5;
  state.query.data!.rooms = [pass]; render(<QuickRoomBoard />);
  expect(screen.getByText('Giá pass: 2.500.000 đ')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sửa pass' })).toBeTruthy();
  openFirst(); expect(price()).toHaveProperty('value', '3000000');
  expect(screen.getByText('Giá pass riêng được sửa ở Báo pass.')).toBeTruthy();
});

it('U23 — Sale: tôi chỉ xem các tòa được giao, không tìm ra tòa ngoài phạm vi hay được mở sửa nội bộ', () => {
  const scoped = room();
  scoped.capabilities = { edit: false, images: false, pass: false, lock: false, releaseLock: false, deposit: false };
  state.query.data!.rooms = [scoped]; render(<QuickRoomBoard mobile />);
  expect(screen.getByLabelText('Tòa nhà').textContent).not.toContain('Bình Minh');
  fireEvent.change(screen.getByLabelText('Tìm tòa hoặc phòng'), { target: { value: 'Binh Minh 101' } });
  expect(screen.getByText(/Không có phòng khớp bộ lọc/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Tìm tòa hoặc phòng'), { target: { value: '' } });
  openFirst();
  expect(price().closest('fieldset')).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: 'Lưu thay đổi' })).toBeNull();
  expect(screen.queryByLabelText('Thưởng sale · chỉ nội bộ')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Bắt đầu tải ảnh thử' })).toBeNull();
});

it('U24 — Sale: được lock phòng không có nghĩa được thu cọc, sửa pass hoặc gỡ lock của người khác', () => {
  const free = room(); free.capabilities = { edit: false, images: false, pass: false, lock: true, releaseLock: false, deposit: false };
  const locked = room('room-b', 'building-b', 'locked'); locked.capabilities = { ...free.capabilities };
  locked.room.saleLock = { id: 'other-lock', hours: 6, lockedAt: '2026-10-21T05:00:00Z', expiresAt: '2026-10-21T11:00:00Z', lockedByName: 'Sale khác', lockedByMe: false, note: null };
  state.query.data!.rooms = [free, locked]; render(<QuickRoomBoard />);
  expect(screen.queryByRole('button', { name: 'Cọc' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Báo pass' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Gỡ lock' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
  expect(screen.getByRole('dialog', { name: 'lock room-a' })).toBeTruthy();
});

it('U25 — Sale Admin: chỉ được cấp sửa ảnh thì vẫn lưu ảnh đúng phòng, không gửi kèm giá hay thưởng sale', async () => {
  const photoOnly = room(); photoOnly.capabilities = { edit: false, images: true, pass: false, lock: false, releaseLock: false, deposit: false };
  state.query.data!.rooms = [photoOnly]; render(<QuickRoomBoard />); openFirst();
  fireEvent.click(screen.getByRole('button', { name: 'Hoàn tất ảnh thử' }));
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
  expect(state.save.mock.calls[0][0]).toEqual({ roomId: 'room-a', expectedRevision: 'a'.repeat(32), requestId: expect.any(String), patch: { images: ['room-sale-images/actor/new.jpg'] } });
  await screen.findByText('Đã lưu Tòa Ánh Dương · 101.');
});

it('U26 — Sale Admin: cập nhật ảnh phòng cũ thiếu giá không được tự điền giá 0 hoặc chuẩn hóa ghi chú ngoài ý muốn', async () => {
  const legacy = room(); legacy.rentPrice = null; legacy.saleNote = ' Chính sách cũ '; legacy.amenities = [' Giường ', ' Giường '];
  state.query.data!.rooms = [legacy]; render(<QuickRoomBoard />); openFirst();
  fireEvent.click(screen.getByRole('button', { name: 'Hoàn tất ảnh thử' }));
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
  expect(state.save.mock.calls[0][0].patch).toEqual({ images: ['room-sale-images/actor/new.jpg'] });
});

it.each([
  ['Lock', 'Xác nhận lock thử', 'lock'],
  ['Cọc', 'Lưu cọc thử', 'deposit'],
  ['Báo pass', 'Lưu pass thử', 'pass'],
] as const)('U27 — Chủ công ty: form %s đang mở phải khóa ghi ngay khi dữ liệu lỗi hoặc bị thu quyền', (open, submit, capability) => {
  const view = render(<QuickRoomBoard />);
  const row = screen.getByText('Tòa Ánh Dương · 101').closest('tr')!;
  fireEvent.click(within(row).getByRole('button', { name: open }));
  state.query.isError = true; view.rerender(<QuickRoomBoard />);
  expect(screen.getByRole('button', { name: submit })).toHaveProperty('disabled', true);
  state.query.isError = false;
  state.query.data = { ...state.query.data!, rooms: [{ ...room(), capabilities: { ...room().capabilities, [capability]: false } }] };
  view.rerender(<QuickRoomBoard />);
  expect(screen.getByRole('button', { name: submit })).toHaveProperty('disabled', true);
  state.query.data!.rooms = []; view.rerender(<QuickRoomBoard />);
  expect(screen.getByRole('button', { name: submit })).toHaveProperty('disabled', true);
  expect(state.save).not.toHaveBeenCalled();
});

it('U28 — Quản lý: giữ giao diện cha ở nguyên tab khi đang sửa/tải ảnh rồi mở lại chuyển tab sau khi đóng', () => {
  const changed = vi.fn(); render(<QuickRoomBoard onBusyChange={changed} />);
  expect(changed).toHaveBeenLastCalledWith(false);
  openFirst(); expect(changed).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu tải ảnh thử' }));
  expect(changed).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Hoàn tất ảnh thử' }));
  fireEvent.click(screen.getByRole('button', { name: 'Đóng, giữ bản nháp' }));
  expect(changed).toHaveBeenLastCalledWith(false);
});
