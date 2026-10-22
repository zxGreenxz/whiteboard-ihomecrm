// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SaleRoomBatchPanel from '../SaleRoomBatchPanel';
import { SaleRoomOperationError, type SaleRoomInventoryRow } from '@/lib/saleRoomOperations';

const mocks = vi.hoisted(() => ({ patch: vi.fn(), save: vi.fn(), cancel: vi.fn(), refresh: vi.fn() }));
vi.mock('@/hooks/useSaleRoomInventory', () => ({ usePatchSaleRoom: () => ({ mutateAsync: mocks.patch }) }));
vi.mock('@/hooks/useSaleRoomPolicy', () => ({ useSaleRoomPolicy: () => ({ save: { mutateAsync: mocks.save }, cancel: { mutateAsync: mocks.cancel }, refresh: mocks.refresh }) }));
const org = '10000000-0000-4000-8000-000000000001';
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function row(n: number, edit = true): SaleRoomInventoryRow {
  const buildingId = id(99);
  return { room: { id: id(n), no: n, code: `${n}`, buildingId, buildingName: 'Tòa A', buildingArea: '', buildingAddr: '', floor: 1,
    type: 'Studio', price: 3, area: 25, status: 'free', amenities: [], availDate: '', imgCount: 0, phClass: '', images: [], x: 0, y: 0, w: 1, h: 1 },
    buildingId, buildingName: 'Tòa A', name: `${n}`, code: `${n}`, revision: 'a'.repeat(32), updatedAt: '', updatedByName: null,
    rentPrice: 3000000, area: 25, roomType: 'Studio', amenities: [], saleNote: 'Thường', saleBonusNote: null, description: null, images: [],
    capabilities: { edit, images: edit, pass: edit, lock: edit, releaseLock: false, deposit: false } };
}
const props = (rows = [row(1), row(2)]) => ({ rows, initialRoomIds: rows.map(r => r.room.id), actorId: id(98), organizationId: org,
  blocked: false, onBusyChange: vi.fn(), onClose: vi.fn(), onSaved: vi.fn() });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const selectAll = () => click('Chọn tất cả phòng được sửa trong kết quả');
const setPrice = (value = '3500000') => {
  fireEvent.click(screen.getByLabelText('Sửa giá niêm yết (đ/tháng)'));
  fireEvent.change(screen.getByLabelText('Giá niêm yết (đ/tháng)'), { target: { value } });
};
const prepare = () => click('Xem lại nội dung cập nhật');
const execute = () => click('Lưu trực tiếp các phòng đã chọn');
const fillPolicy = (start = '2030-10-21T09:00', end = '2030-10-22T09:00') => {
  fireEvent.change(screen.getByLabelText('Thao tác'), { target: { value: 'policy' } });
  fireEvent.change(screen.getByLabelText('Tên chương trình'), { target: { value: 'Ưu đãi tháng 10' } });
  fireEvent.change(screen.getByLabelText('Nội dung chính sách gửi khách'), { target: { value: 'Giảm 200.000đ tháng đầu' } });
  fireEvent.change(screen.getByLabelText('Bắt đầu · giờ Việt Nam'), { target: { value: start } });
  fireEvent.change(screen.getByLabelText('Kết thúc · giờ Việt Nam'), { target: { value: end } });
};
beforeEach(() => { sessionStorage.clear(); Object.values(mocks).forEach(mock => mock.mockReset().mockResolvedValue({})); });
afterEach(cleanup);

it.each(['Chủ trọ', 'Chủ công ty', 'Quản lý', 'Sale Admin', 'Sale'])('BU01 %s: direct update selected rooms with their own revision', async () => {
  render(<SaleRoomBatchPanel {...props()} />); selectAll(); setPrice(); prepare();
  expect(mocks.patch).not.toHaveBeenCalled();
  expect(screen.queryByText(/Gửi duyệt|Chờ duyệt/)).toBeNull(); execute();
  await screen.findByText('2/2 phòng đã xác nhận lưu.');
  expect(mocks.patch).toHaveBeenCalledTimes(2);
  expect(mocks.patch.mock.calls.map(([input]) => [input.roomId, input.expectedRevision, input.patch])).toEqual([
    [id(1), 'a'.repeat(32), { rent_price: 3500000 }], [id(2), 'a'.repeat(32), { rent_price: 3500000 }],
  ]);
  expect(mocks.patch.mock.calls[0][0].requestId).not.toBe(mocks.patch.mock.calls[1][0].requestId);
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
});
it('BU02: denied room excluded; fresh read failure blocks dispatch', () => {
  const p = props([row(1), row(2, false)]); const view = render(<SaleRoomBatchPanel {...p} />);
  expect(screen.getByLabelText('Chọn Tòa A · 2')).toHaveProperty('disabled', true);
  selectAll(); setPrice(); prepare(); view.rerender(<SaleRoomBatchPanel {...p} blocked />);
  expect(screen.getByRole('button', { name: 'Lưu trực tiếp các phòng đã chọn' })).toHaveProperty('disabled', true);
  expect(mocks.patch).not.toHaveBeenCalled();
});
it('BU03: partial conflict keeps successful and failed room outcomes separate', async () => {
  mocks.patch.mockRejectedValueOnce(new SaleRoomOperationError('Đã thay đổi', 'conflict', '40001'));
  render(<SaleRoomBatchPanel {...props()} />); selectAll(); setPrice(); prepare(); execute();
  await screen.findByText('1/2 phòng đã xác nhận lưu.'); expect(mocks.patch).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Cần đối chiếu dữ liệu mới')).toBeTruthy();
});
it('BU04: lost response stops batch; close/reopen reconciles exact durable request before next room', async () => {
  mocks.patch.mockRejectedValueOnce(new SaleRoomOperationError('Mất mạng', 'unknown'));
  const p = props(); const view = render(<SaleRoomBatchPanel {...p} />); selectAll(); setPrice(); prepare(); execute();
  await screen.findByRole('button', { name: 'Đối chiếu và tiếp tục lô' });
  expect(mocks.patch).toHaveBeenCalledTimes(1); const original = mocks.patch.mock.calls[0][0];
  expect(screen.getByRole('button', { name: 'Lập lô mới từ dữ liệu hiện tại' })).toHaveProperty('disabled', true);
  view.unmount(); render(<SaleRoomBatchPanel {...p} />); click('Đối chiếu và tiếp tục lô');
  await screen.findByText('2/2 phòng đã xác nhận lưu.');
  expect(mocks.patch.mock.calls[1][0]).toEqual(original); expect(mocks.patch.mock.calls[2][0].roomId).toBe(id(2));
});
it('BU05: policy saves directly with Vietnam times and no metadata mutation', async () => {
  render(<SaleRoomBatchPanel {...props([row(1)])} />); selectAll(); fillPolicy(); prepare(); execute();
  await screen.findByText('1/1 phòng đã xác nhận lưu.'); expect(mocks.patch).not.toHaveBeenCalled();
  expect(mocks.save.mock.calls[0][0].policy).toEqual({ title: 'Ưu đãi tháng 10', content: 'Giảm 200.000đ tháng đầu', starts_at: '2030-10-21T02:00:00.000Z', ends_at: '2030-10-22T02:00:00.000Z' });
});
it('BU06: overlapping policy blocked; adjacent next period allowed', () => {
  const r = row(1); r.policy = { id: id(90), version: 1, status: 'SCHEDULED', title: 'Cũ', content: 'Cũ', starts_at: '2030-10-20T02:00:00Z', ends_at: '2030-10-21T02:00:00Z' };
  render(<SaleRoomBatchPanel {...props([r])} />); selectAll(); fillPolicy('2030-10-20T10:00'); prepare();
  expect(screen.getByText(/đã có chính sách trùng thời gian/)).toBeTruthy(); expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Bắt đầu · giờ Việt Nam'), { target: { value: '2030-10-21T09:00' } }); prepare();
  expect(screen.getByRole('button', { name: 'Lưu trực tiếp các phòng đã chọn' })).toBeTruthy();
});
it('BU07: cancellation uses exact policy and version with required reason', async () => {
  const r = row(1); r.policy = { id: id(90), version: 3, status: 'ACTIVE', title: 'Cũ', content: 'Cũ', starts_at: '2026-10-20T02:00:00Z', ends_at: '2030-10-21T02:00:00Z' };
  render(<SaleRoomBatchPanel {...props([r])} />); selectAll(); fireEvent.change(screen.getByLabelText('Thao tác'), { target: { value: 'cancel' } }); prepare();
  expect(screen.getByText('Nhập lý do ngừng chính sách.')).toBeTruthy(); expect(mocks.cancel).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Lý do ngừng chính sách'), { target: { value: 'Đã đủ khách' } }); prepare(); execute();
  await screen.findByText('1/1 phòng đã xác nhận lưu.'); expect(mocks.cancel.mock.calls[0][0]).toMatchObject({ roomId: id(1), policyId: id(90), expectedVersion: 3, reason: 'Đã đủ khách' });
});
it('BU08: unsent form survives close; another actor cannot inherit it', () => {
  const p = props(); const first = render(<SaleRoomBatchPanel {...p} />); selectAll(); setPrice('4200000'); first.unmount();
  const second = render(<SaleRoomBatchPanel {...p} />); expect(screen.getByLabelText('Giá niêm yết (đ/tháng)')).toHaveProperty('value', '4200000');
  expect(screen.getByLabelText('Chọn Tòa A · 1')).toHaveProperty('checked', true); second.unmount();
  render(<SaleRoomBatchPanel {...p} actorId={id(97)} />); expect(screen.queryByLabelText('Giá niêm yết (đ/tháng)')).toBeNull();
});
it('BU09: clearing only explicit note preserves price and other fields', async () => {
  render(<SaleRoomBatchPanel {...props([row(1)])} />); selectAll(); fireEvent.click(screen.getByLabelText('Sửa ghi chú / chính sách thường')); prepare(); execute();
  await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1)); expect(mocks.patch.mock.calls[0][0].patch).toEqual({ sale_note: null });
});
it('BU10: permission revoked before preview prevents preparing stale selection', () => {
  const p = props([row(1)]); const view = render(<SaleRoomBatchPanel {...p} />); selectAll(); setPrice();
  view.rerender(<SaleRoomBatchPanel {...p} rows={[row(1, false)]} />); prepare();
  expect(screen.getByText(/quyền cập nhật đã thay đổi/)).toBeTruthy(); expect(mocks.patch).not.toHaveBeenCalled();
});
it('BU11: invalid price and missing fields never dispatch', () => {
  render(<SaleRoomBatchPanel {...props()} />); selectAll(); prepare(); expect(mocks.patch).not.toHaveBeenCalled();
  setPrice('3.500.000'); prepare(); expect(screen.getByText(/Nhập giá nguyên không âm/)).toBeTruthy(); expect(mocks.patch).not.toHaveBeenCalled();
});
it('BU12: over 50 rooms requires explicit subset', () => {
  render(<SaleRoomBatchPanel {...props(Array.from({ length: 51 }, (_, i) => row(i + 1)))} />);
  expect(screen.getByRole('button', { name: 'Chọn tất cả phòng được sửa trong kết quả' })).toHaveProperty('disabled', true);
  expect(screen.getByText(/Kết quả vượt 50 phòng/)).toBeTruthy();
});
it('BU13: owner can select and cancel a later scheduled policy without cancelling the current one', async () => {
  const r = row(1); r.policy = { id: id(90), version: 1, status: 'ACTIVE', title: 'Hiện tại', content: 'Hiện tại', starts_at: '2026-10-20T02:00:00Z', ends_at: '2030-10-21T02:00:00Z' };
  r.policies = [r.policy, { ...r.policy, id: id(91), title: 'Tháng sau', status: 'SCHEDULED', starts_at: '2030-10-21T02:00:00Z', ends_at: '2030-11-21T02:00:00Z' }];
  render(<SaleRoomBatchPanel {...props([r])} />); selectAll(); fireEvent.change(screen.getByLabelText('Thao tác'), { target: { value: 'cancel' } });
  fireEvent.change(screen.getByLabelText('Chính sách cần ngừng · Tòa A · 1'), { target: { value: id(91) } });
  fireEvent.change(screen.getByLabelText('Lý do ngừng chính sách'), { target: { value: 'Đổi chương trình tháng sau' } }); prepare();
  expect(screen.getByText(/Tòa A · 1 · Tháng sau/)).toBeTruthy(); execute(); await screen.findByText('1/1 phòng đã xác nhận lưu.');
  expect(mocks.cancel.mock.calls[0][0]).toMatchObject({ policyId: id(91), expectedVersion: 1 });
});
it('BU14: unreadable form warns instead of silently claiming restoration', () => {
  sessionStorage.setItem(`sale-room-batch:v1:${id(98)}:${org}:form`, '{bad');
  render(<SaleRoomBatchPanel {...props()} />); expect(screen.getByText(/Không đọc được bản nháp nội dung/)).toBeTruthy();
  expect(mocks.patch).not.toHaveBeenCalled();
});
