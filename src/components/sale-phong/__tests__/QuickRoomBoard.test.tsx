// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Room, RoomDepositHoldInfo, RoomExitHoldInfo } from '@/pages/phong-trong/sampleData';
import { roomSaleFacts } from '@/lib/roomSaleFacts';
import { SaleRoomOperationError, type SaleRoomInventoryRow } from '@/lib/saleRoomOperations';
import QuickRoomBoard from '../QuickRoomBoard';

const state = vi.hoisted(() => ({
  org: 'org-a', actor: 'actor-a',
  query: { data: undefined as { rooms: SaleRoomInventoryRow[]; serverNow: string } | undefined, isError: false, isLoading: false, isFetching: false, dataUpdatedAt: Date.now(), refetch: vi.fn() },
  save: vi.fn(), pending: false, reopen: vi.fn(), extend: vi.fn(),
}));
vi.mock('@/hooks/contracts/useContractExitEarlyTerms', () => ({
  useReopenContractExitHold: () => ({ mutateAsync: state.reopen, isPending: false }),
  useExtendContractExitHold: () => ({ mutateAsync: state.extend, isPending: false }),
}));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: state.org }) }));
vi.mock('@/hooks/useAuth', () => ({ useSession: () => ({ data: { user: { id: state.actor } } }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: { contracts: {
  view: true, edit: { org_wide: false, building_ids: ['building-b'] }, terminate: { org_wide: false, building_ids: ['building-b'] },
} } }) }));
vi.mock('@/hooks/useContractMoveOutNotice', () => ({
  useSaleRoomNoticeContracts: (org: string, actor: string, roomId: string) => ({
    data: [{ id: [org, actor, roomId].join('/') }], isError: false,
  }),
}));
vi.mock('@/components/contracts/MoveOutNoticeDialog', () => ({ MoveOutNoticeDialog: ({ contract, roomLabel }: { contract: { id: string }; roomLabel: string }) =>
  <div role="dialog" aria-label={roomLabel}>{contract.id}</div> }));
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
vi.mock('../SaleRoomBatchPanel', () => ({ default: ({ initialRoomIds }: { initialRoomIds: string[] }) =>
  <div role="dialog" aria-label="Lô thử">{initialRoomIds.join(',')}</div> }));
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
const openFirst = () => fireEvent.click(screen.getByRole('button', { name: 'Chi tiết Tòa Ánh Dương · 101' }));
/** Điện thoại gộp tòa + tình trạng vào nút Bộ lọc (thu gọn sẵn); máy tính hiện thẳng. */
const openFilters = (mobile: boolean) => { if (mobile) fireEvent.click(screen.getByRole('button', { name: /^Bộ lọc:/ })); };
const showAllStatuses = (mobile: boolean) => { openFilters(mobile); fireEvent.change(screen.getByLabelText('Tình trạng'), { target: { value: 'all' } }); };
const price = () => screen.getByLabelText('Giá niêm yết (đ/tháng)');
const changePrice = (value: string) => fireEvent.change(price(), { target: { value } });
beforeEach(() => {
  sessionStorage.clear(); state.org = 'org-a'; state.actor = 'actor-a'; state.pending = false;
  Object.assign(state.query, { data: { rooms: [room(), room('room-b', 'building-b', 'rented')], serverNow: '2026-10-21T05:01:00Z' }, isError: false, isLoading: false, isFetching: false });
  state.query.refetch.mockReset().mockResolvedValue({}); state.save.mockReset().mockResolvedValue({});
  state.reopen.mockReset().mockResolvedValue({}); state.extend.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

it.each([false, true])('mở báo sắp trống đúng phòng và quyền theo tòa, mobile=%s', mobile => {
  state.query.data!.rooms = [room('unassigned', 'building-a', 'rented'), room('vacant', 'building-b'), room('soon', 'building-b', 'soon'), room('occupied', 'building-b', 'rented')];
  render(<QuickRoomBoard mobile={mobile} />); showAllStatuses(mobile);
  expect(screen.getAllByRole('button', { name: 'Báo sắp trống' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Cập nhật ngày sắp trống' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Báo sắp trống' }));
  expect(screen.getByRole('dialog', { name: 'Tòa Bình Minh · 101' }).textContent).toBe('org-a/actor-a/occupied');
  expect(state.save).not.toHaveBeenCalled();
});

it.each([false, true])('U01 — Chủ trọ: cho tôi tìm không dấu đúng tòa và cả phòng đã thuê trên máy tính/điện thoại, mobile=%s', mobile => {
  render(<QuickRoomBoard mobile={mobile} />); showAllStatuses(mobile);
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
  state.query.data!.rooms = [room('room-a', 'building-a', 'soon'), room('room-b', 'building-b', 'rented')];
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
  fireEvent.click(screen.getByRole('button', { name: 'Chi tiết Tòa Bình Minh · 101' }));
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
  state.query.data!.rooms = [scoped]; render(<QuickRoomBoard mobile />); openFilters(true);
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
  const soon = () => room('room-a', 'building-a', 'soon');
  state.query.data!.rooms = [soon(), room('room-b', 'building-b', 'rented')];
  const view = render(<QuickRoomBoard />);
  const row = screen.getByText('Tòa Ánh Dương · 101').closest('tr')!;
  fireEvent.click(within(row).getByRole('button', { name: open }));
  state.query.isError = true; view.rerender(<QuickRoomBoard />);
  expect(screen.getByRole('button', { name: submit })).toHaveProperty('disabled', true);
  state.query.isError = false;
  state.query.data = { ...state.query.data!, rooms: [{ ...soon(), capabilities: { ...soon().capabilities, [capability]: false } }] };
  view.rerender(<QuickRoomBoard />);
  expect(screen.getByRole('button', { name: submit })).toHaveProperty('disabled', true);
  state.query.data!.rooms = []; view.rerender(<QuickRoomBoard />);
  expect(screen.getByRole('button', { name: submit })).toHaveProperty('disabled', true);
  expect(state.save).not.toHaveBeenCalled();
});

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const hold = (overrides: Partial<RoomExitHoldInfo> = {}): RoomExitHoldInfo => ({
  exitCaseId: CASE_ID, version: 4, earlyReason: 'SALE_ASSISTED', saleName: 'Minh', oldCustomerName: 'Nguyễn Văn Cũ',
  oldContractNumber: 'HD-0451', actualMoveOutOn: '2026-11-24', recordedByName: 'Quản lý Lan', recordedByMe: false,
  holdUntil: '2026-11-27T03:05:00Z', active: true, canManage: true, ...overrides,
});
const heldRow = (overrides: Partial<RoomExitHoldInfo> = {}, status: Room['status'] = 'rented', id = 'room-h', buildingId = 'building-b') => {
  const row = room(id, buildingId, status); row.room.exitHold = hold(overrides); return row;
};

it.each([false, true])('U30 — Quản lý: phòng giữ cho khách sang nhượng hiện đủ thông tin, vẫn cọc được, không lock/báo trả, mobile=%s', mobile => {
  state.query.data!.rooms = [heldRow()];
  render(<QuickRoomBoard mobile={mobile} />);
  expect(screen.getByText('Chờ khách Sang/Nhượng phòng')).toBeTruthy();
  expect(screen.queryByText('Đã thuê / giữ chỗ', { ignore: 'option' })).toBeNull();
  expect(screen.getByText('Khách cũ: Nguyễn Văn Cũ (HD-0451)')).toBeTruthy();
  expect(screen.getByText('Nhờ sale tìm khách sang phòng · sale Minh')).toBeTruthy();
  expect(screen.getByText('Người ghi: Quản lý Lan · giữ đến 10:05 27/11')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Báo sắp trống' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Mở bán lại' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Giữ tiếp' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cọc' }));
  // Người khác vẫn cọc được phòng đang giữ: hộp cọc không bị khoá vì tình trạng "rented" do giữ.
  const deposit = screen.getByRole('dialog', { name: 'Cọc room-h' });
  expect(within(deposit).getByRole('button', { name: 'Lưu cọc thử' })).toHaveProperty('disabled', false);
});

it('U31 — Quản lý: Mở bán lại hỏi xác nhận rồi gửi đúng hồ sơ, phiên bản và lý do', async () => {
  state.query.data!.rooms = [heldRow({ recordedByMe: true })];
  render(<QuickRoomBoard />);
  expect(screen.getByText('Người ghi: bạn · giữ đến 10:05 27/11')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Mở bán lại' }));
  const dialog = screen.getByRole('alertdialog');
  expect(dialog.textContent).toContain('rao bán lại ngay');
  expect(dialog.textContent).toContain('KHÔNG tự nối');
  expect(state.reopen).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByLabelText('Lý do (tuỳ chọn)'), { target: { value: ' Khách nhận huỷ ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Mở bán lại' }));
  await waitFor(() => expect(state.reopen).toHaveBeenCalledTimes(1));
  expect(state.reopen.mock.calls[0][0]).toEqual({ caseId: CASE_ID, expectedVersion: 4, requestId: expect.any(String), reason: 'Khách nhận huỷ' });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(state.extend).not.toHaveBeenCalled();
});

it('U32 — Quản lý: hết hạn giữ thì phòng chào như trống, chỉ còn Giữ tiếp với số ngày đã chọn', async () => {
  state.query.data!.rooms = [heldRow({ active: false }, 'free')];
  render(<QuickRoomBoard />);
  const row = screen.getByText('Tòa Bình Minh · 101').closest('tr')!;
  expect(within(row).getByText('Trống sẵn')).toBeTruthy();
  expect(within(row).getByText('Hết hạn giữ cho khách sang nhượng (HĐ cũ HD-0451 · Nguyễn Văn Cũ)')).toBeTruthy();
  expect(within(row).queryByRole('button', { name: 'Mở bán lại' })).toBeNull();
  expect(within(row).getByRole('button', { name: 'Lock' })).toBeTruthy();
  fireEvent.click(within(row).getByRole('button', { name: 'Giữ tiếp' }));
  const dialog = screen.getByRole('alertdialog');
  expect(within(dialog).getByLabelText('Giữ thêm')).toHaveProperty('value', '3');
  fireEvent.change(within(dialog).getByLabelText('Giữ thêm'), { target: { value: '5' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Giữ tiếp 5 ngày' }));
  await waitFor(() => expect(state.extend).toHaveBeenCalledTimes(1));
  expect(state.extend.mock.calls[0][0]).toEqual({ caseId: CASE_ID, expectedVersion: 4, requestId: expect.any(String), days: 5, reason: null });
  expect(state.reopen).not.toHaveBeenCalled();
});

it('U33 — Sale: không có quyền thanh lý ở toà thì thấy phòng đang giữ nhưng không có nút Mở bán lại / Giữ tiếp', () => {
  state.query.data!.rooms = [heldRow({ canManage: false }), heldRow({ canManage: false, active: false }, 'free', 'room-e', 'building-a')];
  render(<QuickRoomBoard />);
  expect(screen.getByText('Chờ khách Sang/Nhượng phòng')).toBeTruthy();
  expect(screen.getByText(/^Hết hạn giữ cho khách sang nhượng/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Mở bán lại' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Giữ tiếp' })).toBeNull();
});

it('U34 — Quản lý: hộp thoại gửi phiên bản đọc mới nhất và khoá gửi khi hồ sơ đã được xử lý ở nơi khác', async () => {
  state.query.data!.rooms = [heldRow()];
  const view = render(<QuickRoomBoard />);
  fireEvent.click(screen.getByRole('button', { name: 'Giữ tiếp' }));
  state.query.data = { ...state.query.data!, rooms: [heldRow({ version: 5 })] };
  view.rerender(<QuickRoomBoard />);
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Giữ tiếp 3 ngày' }));
  await waitFor(() => expect(state.extend).toHaveBeenCalledTimes(1));
  expect(state.extend.mock.calls[0][0]).toMatchObject({ caseId: CASE_ID, expectedVersion: 5, days: 3 });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Mở bán lại' }));
  state.query.data = { ...state.query.data!, rooms: [room('room-h', 'building-b', 'free')] };
  view.rerender(<QuickRoomBoard />);
  const dialog = screen.getByRole('alertdialog');
  expect(within(dialog).getByRole('alert').textContent).toMatch(/Hồ sơ giữ phòng đã thay đổi/);
  expect(within(dialog).getByRole('button', { name: 'Mở bán lại' })).toHaveProperty('disabled', true);
  expect(state.reopen).not.toHaveBeenCalled();
});

it('U35 — Quản lý: lọc riêng các phòng đang/hết hạn giữ cho khách sang nhượng', () => {
  state.query.data!.rooms = [room(), heldRow(), heldRow({ active: false, exitCaseId: '22222222-2222-4222-8222-222222222222' }, 'free', 'room-e', 'building-a')];
  state.query.data!.rooms[2].name = '102';
  render(<QuickRoomBoard />);
  fireEvent.change(screen.getByLabelText('Tình trạng'), { target: { value: 'exit-hold' } });
  expect(screen.getByText('2/3 phòng')).toBeTruthy();
  expect(screen.getByText('Tòa Bình Minh · 101')).toBeTruthy();
  expect(screen.getByText('Tòa Ánh Dương · 102 (101)')).toBeTruthy();
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

const named = (row: SaleRoomInventoryRow, name: string) => { row.name = name; row.code = name; row.room.code = name; return row; };
const rowOf = (label: string, mobile: boolean) => screen.getByText(label).closest(mobile ? 'article' : 'tr') as HTMLElement;

it.each([false, true])('D5-14 — Báo pass / Báo sắp trống chỉ ở phòng đang có khách; phòng trống, đang lock, giữ sang nhượng thì không, mobile=%s', mobile => {
  const locked = named(room('locked', 'building-b', 'locked'), 'L1');
  locked.room.saleLock = { id: 'lock-1', hours: 6, lockedAt: '2026-10-21T05:00:00Z', expiresAt: '2026-10-21T11:00:00Z', lockedByName: 'Sale khác', lockedByMe: false, note: null };
  state.query.data!.rooms = [
    named(room('vacant', 'building-b'), 'T1'), locked, named(room('rented', 'building-b', 'rented'), 'R1'),
    named(room('soon', 'building-b', 'soon'), 'S1'), named(room('pass', 'building-b', 'pass'), 'P1'), named(heldRow(), 'H1'),
  ];
  render(<QuickRoomBoard mobile={mobile} />); showAllStatuses(mobile);
  const buttons = (name: string) => within(rowOf(`Tòa Bình Minh · ${name}`, mobile)).queryAllByRole('button').map(button => button.textContent);
  for (const name of ['T1', 'L1', 'H1']) {
    expect(buttons(name)).not.toContain('Báo pass');
    expect(buttons(name)).not.toContain('Báo sắp trống');
    expect(buttons(name)).not.toContain('Cập nhật ngày sắp trống');
  }
  expect(buttons('R1')).toEqual(expect.arrayContaining(['Báo pass', 'Báo sắp trống']));
  expect(buttons('S1')).toEqual(expect.arrayContaining(['Báo pass', 'Cập nhật ngày sắp trống']));
  expect(buttons('P1')).toEqual(expect.arrayContaining(['Sửa pass', 'Báo sắp trống']));
});

it('D5-15 — ô giá nhận đúng kiểu app hiển thị «4.250.000» và lưu thành số đồng', async () => {
  render(<QuickRoomBoard />); openFirst(); changePrice('4.250.000');
  expect(screen.queryByText(/Nhập giá nguyên/)).toBeNull();
  expect(screen.queryByText(/kiểm tra có (thiếu|thừa) số 0/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
  expect(state.save.mock.calls[0][0].patch).toEqual({ rent_price: 4_250_000 });
});

it.each([
  ['0', /Giá 0 đ sẽ hiện đúng như vậy/, 0],
  ['42.500', /Giá dưới 500.000 đ\/tháng/, 42_500],
  ['100.000.000.000', /Giá trên 100.000.000 đ\/tháng/, 100_000_000_000],
] as const)('D5-15 — giá %s chỉ cảnh báo, không chặn lưu', async (typed, warning, saved) => {
  render(<QuickRoomBoard />); openFirst(); changePrice(typed);
  expect(screen.getByText(warning)).toBeTruthy();
  expect(price().getAttribute('aria-describedby')).toBe('quick-price-warning');
  expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toHaveProperty('disabled', false);
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
  expect(state.save.mock.calls[0][0].patch).toEqual({ rent_price: saved });
});

it('D5-15 — giá sai định dạng vẫn chặn và chỉ đúng ô, không kèm cảnh báo', () => {
  render(<QuickRoomBoard />); openFirst(); changePrice('4.25');
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  expect(screen.getByText(/ví dụ 4.250.000/)).toBeTruthy();
  expect(price().getAttribute('aria-describedby')).toBe('quick-price-error');
  expect(screen.queryByText(/kiểm tra có (thiếu|thừa) số 0/)).toBeNull();
  expect(state.save).not.toHaveBeenCalled();
});

it('D5-16 — tìm theo từng từ: chép nguyên nhãn «Tòa · phòng» hay đảo thứ tự vẫn ra đúng phòng', () => {
  render(<QuickRoomBoard />);
  const search = screen.getByLabelText('Tìm tòa hoặc phòng');
  for (const query of ['Tòa Ánh Dương · 101', '101 anh duong', 'ANH-DUONG (101)']) {
    fireEvent.change(search, { target: { value: query } });
    expect(screen.getByText('Tòa Ánh Dương · 101')).toBeTruthy();
    expect(screen.queryByText('Tòa Bình Minh · 101')).toBeNull();
  }
  fireEvent.change(search, { target: { value: 'anh duong · 102' } });
  expect(screen.getByText(/Không có phòng khớp bộ lọc/)).toBeTruthy();
  fireEvent.change(search, { target: { value: ' · ' } });
  expect(screen.getByText('2/2 phòng')).toBeTruthy();
});

it('D5-17 — điện thoại mở sẵn phòng còn chào được, tòa + tình trạng gộp trong một nút thu gọn; máy tính giữ mọi tình trạng', () => {
  state.query.data!.rooms = [room(), room('room-b', 'building-b', 'rented'), named(room('room-c', 'building-b', 'soon'), '102')];
  render(<QuickRoomBoard mobile />);
  expect(screen.queryByText('Tòa Bình Minh · 101')).toBeNull();
  expect(screen.getByText('Tòa Bình Minh · 102')).toBeTruthy();
  expect(screen.getByText('2/3 phòng')).toBeTruthy();
  const toggle = screen.getByRole('button', { name: /^Bộ lọc:/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.textContent).toContain('Còn chào được · Tất cả tòa');
  expect(screen.queryByLabelText('Tình trạng')).toBeNull();
  expect(screen.getByLabelText('Tìm tòa hoặc phòng')).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  fireEvent.change(screen.getByLabelText('Tòa nhà'), { target: { value: 'building-b' } });
  fireEvent.change(screen.getByLabelText('Tình trạng'), { target: { value: 'all' } });
  expect(screen.getByText('2/3 phòng')).toBeTruthy();
  expect(toggle.textContent).toContain('Mọi tình trạng · Tòa Bình Minh');
  fireEvent.click(toggle);
  expect(screen.queryByLabelText('Tình trạng')).toBeNull();
  cleanup(); render(<QuickRoomBoard />);
  expect(screen.getByText('3/3 phòng')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Bộ lọc:/ })).toBeNull();
  expect(screen.getByLabelText('Tình trạng')).toHaveProperty('value', 'all');
});

it('D5-20 — nút Chi tiết có tên đọc chứa đúng chữ hiển thị; ô tòa xếp theo tên tự nhiên', () => {
  const far = room('r-102', 'b-102'); far.buildingName = '102LVT'; far.room.buildingName = '102LVT';
  const near = room('r-45', 'b-45'); near.buildingName = '45TTT'; near.room.buildingName = '45TTT';
  state.query.data!.rooms = [far, near];
  render(<QuickRoomBoard />);
  const detail = screen.getByRole('button', { name: 'Chi tiết 45TTT · 101' });
  expect(detail.textContent).toBe('Chi tiết');
  expect([...(screen.getByLabelText('Tòa nhà') as HTMLSelectElement).options].map(option => option.textContent))
    .toEqual(['Tất cả tòa được giao', '45TTT', '102LVT']);
});

it('D5-17b — điện thoại: gõ tìm khi bộ lọc còn mặc định thì tìm trên mọi phòng để báo sắp trống phòng đang có khách', () => {
  state.query.data!.rooms = [room(), room('room-b', 'building-b', 'rented')];
  render(<QuickRoomBoard mobile />);
  expect(screen.queryByText('Tòa Bình Minh · 101')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Đang ẩn 1 phòng đã thuê / giữ chỗ — đổi bộ lọc để xem.');
  fireEvent.change(screen.getByLabelText('Tìm tòa hoặc phòng'), { target: { value: 'binh minh 101' } });
  const row = rowOf('Tòa Bình Minh · 101', true);
  expect(within(row).getByRole('button', { name: 'Báo sắp trống' })).toBeTruthy();
  expect(within(row).getByRole('button', { name: 'Báo pass' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Bộ lọc:/ }).textContent).toContain('Mọi tình trạng (đang tìm)');
  expect(screen.getByText(/tìm trên mọi tình trạng/)).toBeTruthy();
  expect(screen.queryByText(/Đang ẩn/)).toBeNull();
  // Người dùng tự chọn một tình trạng khác thì từ khoá chỉ lọc trong tình trạng đó.
  openFilters(true);
  fireEvent.change(screen.getByLabelText('Tình trạng'), { target: { value: 'free' } });
  expect(screen.queryByText('Tòa Bình Minh · 101')).toBeNull();
  fireEvent.change(screen.getByLabelText('Tìm tòa hoặc phòng'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Tình trạng'), { target: { value: 'open' } });
  expect(screen.queryByText('Tòa Bình Minh · 101')).toBeNull();
});

it('D5-17c — bộ lọc mặc định ẩn hết phòng: câu báo rỗng nói rõ số phòng đang ẩn và cho hiện lại', () => {
  state.query.data!.rooms = [room('room-b', 'building-b', 'rented')];
  render(<QuickRoomBoard mobile />);
  const empty = screen.getByText(/Không có phòng khớp bộ lọc/);
  expect(empty.textContent).toContain('Đang ẩn 1 phòng đã thuê / giữ chỗ — đổi bộ lọc để xem.');
  fireEvent.click(within(empty).getByRole('button', { name: 'Hiện cả phòng đã thuê' }));
  expect(screen.getByText('Tòa Bình Minh · 101')).toBeTruthy();
  expect(screen.queryByText(/Đang ẩn/)).toBeNull();
  expect(screen.getByRole('button', { name: /^Bộ lọc:/ }).textContent).toContain('Mọi tình trạng · Tất cả tòa');
});

it('D5-17d — «Cập nhật nhiều phòng» theo đúng phòng đang thấy; phòng bị bộ lọc ẩn thì nói rõ không nằm trong lô', async () => {
  state.query.data!.rooms = [room(), room('room-b', 'building-b', 'rented')];
  const view = render(<QuickRoomBoard mobile />);
  fireEvent.click(screen.getByRole('button', { name: 'Cập nhật nhiều phòng / chính sách' }));
  expect((await screen.findByRole('dialog', { name: 'Lô thử' })).textContent).toBe('room-a');
  expect(screen.getByRole('note').textContent).toMatch(/1 phòng đã thuê \/ giữ chỗ đang ẩn .* không nằm trong lô/);
  view.unmount(); cleanup();
  render(<QuickRoomBoard mobile />);
  fireEvent.change(screen.getByLabelText('Tìm tòa hoặc phòng'), { target: { value: '101' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cập nhật nhiều phòng / chính sách' }));
  expect((await screen.findByRole('dialog', { name: 'Lô thử' })).textContent).toBe('room-a,room-b');
  expect(screen.queryByRole('note')).toBeNull();
});

it('D5-15 — chỉ đổi cách viết giá (4250000 ⇄ 4.250.000) không thành bản nháp, không ghi', () => {
  const view = render(<QuickRoomBoard />); openFirst(); changePrice('3.000.000');
  expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Đóng' })).toBeTruthy();
  changePrice('3.100.000');
  expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toHaveProperty('disabled', false);
  view.unmount();
  expect(state.save).not.toHaveBeenCalled();
});

// Sale phòng đợt 3 (lỗi 21): phòng giữ bằng phiếu cọc chờ hợp đồng ghi «Đã cọc · người nộp · N ngày»; quá 14 ngày tô cảnh
// báo; phòng chỉ có cọc giữ chỗ (chưa ai ở) không có Báo pass / Báo sắp trống.
const depositRow = (hold: Partial<RoomDepositHoldInfo> = {}, id = 'room-c', buildingId = 'building-b') => {
  const row = room(id, buildingId, 'rented');
  row.room.depositHold = { voucherId: '33333333-3333-4333-8333-333333333333', code: 'PT2611443', voucherDate: '2026-11-22',
    payerName: 'Chị Lan', heldDays: 3, voucherCount: 1, roomOccupied: false, ...hold };
  row.room.saleFact = roomSaleFacts({ status: 'rented', depositHold: row.room.depositHold });
  return row;
};

it.each([false, true])('U40 — Sale: phòng đã cọc ghi rõ người nộp, số ngày, mã phiếu; không Báo pass / Báo sắp trống / Cọc, mobile=%s', mobile => {
  state.query.data!.rooms = [depositRow(), room('room-b', 'building-b', 'rented')];
  render(<QuickRoomBoard mobile={mobile} />); showAllStatuses(mobile);
  expect(screen.getByText('Đã cọc · Chị Lan · 3 ngày')).toBeTruthy();
  expect(screen.getByText('Phiếu PT2611443 · lập 22/11/2026')).toBeTruthy();
  // Phòng thuê thường vẫn ghi như cũ và vẫn báo trả / báo pass được.
  expect(screen.getByText('Đã thuê / giữ chỗ', { ignore: 'option' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Báo sắp trống' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Báo pass' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Cọc' })).toBeNull();
  expect(screen.getByTestId('deposit-hold-summary').className).not.toContain('bg-amber-50');
});

it('U41 — Sale: bộ lọc «Đã cọc chờ hợp đồng»; quá 14 ngày tô cảnh báo; nhiều phiếu cọc chờ thì báo số phiếu', () => {
  state.query.data!.rooms = [depositRow({ heldDays: 20, voucherCount: 2 }), room('room-b', 'building-b', 'rented'), room()];
  render(<QuickRoomBoard />);
  fireEvent.change(screen.getByLabelText('Tình trạng'), { target: { value: 'deposit-hold' } });
  expect(screen.getByText('Đã cọc · Chị Lan · 20 ngày')).toBeTruthy();
  expect(screen.queryByText('Tòa Ánh Dương · 101')).toBeNull();
  const summary = screen.getByTestId('deposit-hold-summary');
  expect(summary.className).toContain('bg-amber-50');
  expect(within(summary).getByText('Quá 14 ngày chưa có hợp đồng — kiểm lại phiếu cọc')).toBeTruthy();
  expect(within(summary).getByText('Phòng có 2 phiếu cọc chờ hợp đồng — kiểm trước khi ký hợp đồng mới')).toBeTruthy();
});

it('U42 — Quản lý: phòng còn khách ở mà có phiếu cọc treo (ca 102LVT·104) vẫn báo trả / báo pass được, hiện «Đã cọc»', () => {
  state.query.data!.rooms = [depositRow({ roomOccupied: true, heldDays: 182, code: 'PT2605004', voucherDate: '2026-05-27' })];
  render(<QuickRoomBoard />); showAllStatuses(false);
  expect(screen.getByText('Đã cọc · Chị Lan · 182 ngày')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Báo sắp trống' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Báo pass' })).toBeTruthy();
});
