// @vitest-environment jsdom
// Phòng giữ cho khách nhận sang nhượng (trả phòng trước hạn "Nhờ sale / Tự tìm khách sang phòng") trên trang
// Phòng trống: parse khoá exit_hold của reader trong app, link công khai bỏ qua, thẻ chi tiết và hai nút xử lý.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { PermissionsMap } from '@/hooks/useMyPermissions';
import { mapPayloadToBuildings, parseRoomSalePayload, type RpcPayload } from '../supabaseData';
import { buildRoomListTable } from '../roomListTable';
import { DetailSheet } from '../PhongTrongSheet';
import { exitHoldUntilLabel, parseRoomExitHold } from '../exitHold';
import type { Building, Room } from '../sampleData';
import { ExitHoldDialog } from '@/components/sale-phong/ExitHoldDialog';

const h = vi.hoisted(() => ({ reopen: vi.fn(), extend: vi.fn(), perms: {} as PermissionsMap }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: path } }) }) } } }));
vi.mock('@/hooks/contracts/useContractExitEarlyTerms', () => ({
  useReopenContractExitHold: () => ({ mutateAsync: h.reopen, isPending: false }),
  useExtendContractExitHold: () => ({ mutateAsync: h.extend, isPending: false }),
}));
vi.mock('../usePhongTrong', () => ({ usePhongTrong: () => ({ data: [], isLoading: false, isError: false }) }));
vi.mock('@/hooks/useAuth', () => ({ useSession: () => ({ data: { user: { id: 'sale' } } }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: h.perms }) }));
vi.mock('../QuickDepositModal', () => ({ QuickDepositModal: ({ room }: { room: Room | null }) => room ? <div data-testid="quick-deposit">{room.id}</div> : null }));
vi.mock('../LockRoomModal', () => ({ LockRoomModal: () => null }));
vi.mock('../useTracking', () => ({
  useTracking: () => ({ track: vi.fn(), trackError: vi.fn() }), useTrack: () => ({ track: vi.fn(), trackError: vi.fn() }),
  TrackingProvider: ({ children }: { children: React.ReactNode }) => children,
  useRoomImpression: () => () => undefined,
}));
import PhongTrongPage from '../PhongTrongPage';

const CASE = '11111111-1111-4111-8111-111111111111';
const CASE_EXPIRED = '22222222-2222-4222-8222-222222222222';
const exitHold = {
  exit_case_id: CASE, version: 2, early_reason: 'SELF_FOUND', sale_name: null, old_customer_name: 'Trần Thị Cũ',
  old_contract_number: 'HD-77', actual_move_out_on: '2026-11-24', recorded_by_name: 'Quản lý A', recorded_by_me: true,
  hold_until: '2026-11-27T03:05:00.123456+00:00', active: true, can_manage: true,
};
const base = { building_id: 'b', code: null, area: 20, rent_price: 4_000_000, max_occupants: 2, amenities: [], images: [], description: null,
  avail_date: null, sale_today: '2026-11-24', expected_ready_on: null };
const payloadWith = (held: unknown, expired: unknown = { ...exitHold, exit_case_id: CASE_EXPIRED, active: false }): RpcPayload => ({
  buildings: [{ id: 'b', name: 'Toà A', code: 'A', district: null, ward: null, address: null, total_floors: 4 }],
  rooms: [
    { ...base, id: 'free', floor: 1, name: '101', status_public: 'free', sale_state: 'READY' },
    { ...base, id: 'expired', floor: 2, name: '201', status_public: 'free', sale_state: 'READY', exit_hold: expired },
    { ...base, id: 'held', floor: 3, name: '301', status_public: 'rented', sale_state: 'RENTED', sale_lock: null, exit_hold: held },
    { ...base, id: 'rented', floor: 4, name: '401', status_public: 'rented', sale_state: 'RENTED', exit_hold: null },
  ],
});
const payload = payloadWith(exitHold);
const roomOf = (b: Building, id: string) => b.rooms.find(r => r.id === id)!;

afterEach(cleanup);
beforeEach(() => {
  h.reopen.mockReset().mockResolvedValue({}); h.extend.mockReset().mockResolvedValue({}); h.perms = {};
  sessionStorage.clear(); localStorage.clear();
});

describe('khoá exit_hold của reader trong app', () => {
  it('giữ phòng "rented" (không trạng thái mới), đổi nhãn, hiện trên sơ đồ nhân viên nhưng không tính trống hay xuất ảnh', () => {
    const [b] = mapPayloadToBuildings(parseRoomSalePayload(payload), { includeInternal: true });
    const held = roomOf(b, 'held');
    expect(held).toMatchObject({ status: 'rented', saleLock: null,
      saleFact: { kind: 'rented', label: 'Chờ khách Sang/Nhượng phòng', availableOn: null },
      exitHold: { exitCaseId: CASE, version: 2, earlyReason: 'SELF_FOUND', saleName: null, oldCustomerName: 'Trần Thị Cũ',
        oldContractNumber: 'HD-77', recordedByName: 'Quản lý A', recordedByMe: true, active: true, canManage: true } });
    expect(roomOf(b, 'expired')).toMatchObject({ status: 'free', saleFact: { label: 'Trống sẵn' }, exitHold: { exitCaseId: CASE_EXPIRED, active: false } });
    expect(roomOf(b, 'rented')).toMatchObject({ exitHold: null, saleFact: { label: 'Đã thuê / giữ chỗ' } });
    expect(b.floors.map(f => f.floor)).toEqual([3, 2, 1]);
    expect(b.freeCount).toBe(2);
    expect(buildRoomListTable([b]).totalRooms).toBe(2);
  });

  it('link công khai bỏ qua exit_hold kể cả khi payload lỡ có', () => {
    const [b] = mapPayloadToBuildings(parseRoomSalePayload(payload));
    expect(b.rooms.every(r => r.exitHold === null)).toBe(true);
    expect(roomOf(b, 'held')).toMatchObject({ status: 'rented', saleFact: { label: 'Đã thuê / giữ chỗ' } });
    expect(b.floors.map(f => f.floor)).toEqual([2, 1]);
  });

  it.each([
    ['sai mã hồ sơ', { ...exitHold, exit_case_id: 'khong-phai-uuid' }],
    ['phiên bản không phải số', { ...exitHold, version: '2' }],
    ['trường hợp lạ', { ...exitHold, early_reason: 'LANDLORD_AGREEMENT' }],
    ['thiếu hạn giữ', { ...exitHold, hold_until: undefined }],
    ['không phải object', 'giu-phong'],
  ])('exit_hold lệch dạng (%s) coi như không có, không làm vỡ danh sách', (_label, broken) => {
    const parsed = parseRoomSalePayload(payloadWith(broken));
    const [b] = mapPayloadToBuildings(parsed, { includeInternal: true });
    expect(b.rooms).toHaveLength(4);
    expect(roomOf(b, 'held')).toMatchObject({ status: 'rented', exitHold: null, saleFact: { label: 'Đã thuê / giữ chỗ' } });
    expect(roomOf(b, 'expired').exitHold).toMatchObject({ exitCaseId: CASE_EXPIRED });
    expect(parseRoomExitHold(broken)).toBeNull();
  });

  it('hạn giữ hiển thị theo giờ Việt Nam', () => {
    expect(exitHoldUntilLabel('2026-11-27T03:05:00.123456+00:00')).toBe('10:05 27/11');
    expect(exitHoldUntilLabel('2026-11-27T23:30:00+07:00')).toBe('23:30 27/11');
    expect(exitHoldUntilLabel('không-phải-ngày')).toBe('chưa rõ hạn');
  });
});

describe('thẻ chi tiết phòng đang giữ', () => {
  const [b] = mapPayloadToBuildings(payload, { includeInternal: true });
  const sheet = (room: Room, extra: Partial<Parameters<typeof DetailSheet>[0]> = {}) => render(
    <DetailSheet room={room} show onClose={vi.fn()} onToast={vi.fn()} saved={[]} toggleSave={vi.fn()} onGo={vi.fn()} buildings={[b]} {...extra} />);

  it('còn hạn: nhãn, khách cũ, trường hợp, người ghi, hạn giữ; vẫn tạo cọc, không Lock tạm; hai nút gọi đúng phòng', () => {
    const held = roomOf(b, 'held');
    const onReopenHold = vi.fn(), onExtendHold = vi.fn(), onQuickDeposit = vi.fn();
    sheet(held, { onReopenHold, onExtendHold, onQuickDeposit, onLock: vi.fn() });
    const note = screen.getByRole('note', { name: 'Giữ phòng cho khách sang nhượng' });
    expect(note.textContent).toBe('Chờ khách Sang/Nhượng phòngKhách cũ: Trần Thị Cũ (HD-77)Tự tìm khách sang phòng'
      + 'Người ghi: bạn · giữ đến 10:05 27/11');
    expect(screen.getAllByText('Chờ khách Sang/Nhượng phòng').length).toBeGreaterThan(1);
    expect(screen.queryByRole('button', { name: 'Lock tạm' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tạo cọc giữ phòng' }));
    expect(onQuickDeposit).toHaveBeenCalledWith(held);
    fireEvent.click(screen.getByRole('button', { name: 'Mở bán lại' }));
    expect(onReopenHold).toHaveBeenCalledWith(held);
    fireEvent.click(screen.getByRole('button', { name: 'Giữ tiếp' }));
    expect(onExtendHold).toHaveBeenCalledWith(held);
  });

  it('hết hạn: phòng chào như trống, có dòng "Hết hạn giữ…" và chỉ còn Giữ tiếp', () => {
    sheet(roomOf(b, 'expired'), { onReopenHold: vi.fn(), onExtendHold: vi.fn() });
    expect(screen.getByRole('note').textContent).toMatch(/^Hết hạn giữ cho khách sang nhượng \(HĐ cũ HD-77 · Trần Thị Cũ\)Hết hạn lúc 10:05 27\/11/);
    expect(screen.queryByRole('button', { name: 'Mở bán lại' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Giữ tiếp' })).toBeTruthy();
  });

  it('không có quyền thanh lý ở toà (can_manage=false) thì không có nút xử lý', () => {
    const [noManage] = mapPayloadToBuildings(payloadWith({ ...exitHold, can_manage: false }), { includeInternal: true });
    sheet(roomOf(noManage, 'held'), { onReopenHold: vi.fn(), onExtendHold: vi.fn() });
    expect(screen.getByRole('note')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mở bán lại' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Giữ tiếp' })).toBeNull();
  });
});

describe('hộp thoại Mở bán lại / Giữ tiếp', () => {
  const [b] = mapPayloadToBuildings(payload, { includeInternal: true });
  const hold = roomOf(b, 'held').exitHold!;

  it('bấm lại sau lỗi cùng ý định dùng lại mã yêu cầu; đổi lý do là ý định mới', async () => {
    h.reopen.mockRejectedValueOnce({ code: '08006' }).mockRejectedValueOnce({ code: '08006' });
    const onClose = vi.fn();
    render(<ExitHoldDialog action={{ mode: 'reopen', roomId: 'held', roomLabel: 'Toà A · Phòng 301', hold }} onClose={onClose} />);
    const dialog = screen.getByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Mở bán lại' });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.reopen).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(confirm).toHaveProperty('disabled', false));
    fireEvent.click(confirm);
    await waitFor(() => expect(h.reopen).toHaveBeenCalledTimes(2));
    expect(h.reopen.mock.calls[1][0]).toEqual(h.reopen.mock.calls[0][0]);
    expect(h.reopen.mock.calls[0][0]).toEqual({ caseId: CASE, expectedVersion: 2, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), reason: null });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Lý do (tuỳ chọn)'), { target: { value: 'Khách nhận huỷ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.reopen).toHaveBeenCalledTimes(3));
    expect(h.reopen.mock.calls[2][0].requestId).not.toBe(h.reopen.mock.calls[0][0].requestId);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Giữ tiếp mặc định 3 ngày, cho chọn 1–7 ngày; bị khoá thì không gửi', () => {
    render(<ExitHoldDialog action={{ mode: 'extend', roomId: 'held', roomLabel: 'Toà A · Phòng 301', hold }}
      blockedReason="Hồ sơ giữ phòng đã thay đổi" onClose={vi.fn()} />);
    const days = screen.getByLabelText('Giữ thêm') as HTMLSelectElement;
    expect(days.value).toBe('3');
    expect(Array.from(days.options).map(o => o.value)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(screen.getByRole('button', { name: 'Giữ tiếp 3 ngày' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert').textContent).toBe('Hồ sơ giữ phòng đã thay đổi');
    expect(h.extend).not.toHaveBeenCalled();
  });
});

describe('trang Phòng trống trong app', () => {
  const view = (buildings: Building[]) => render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <PhongTrongPage embedded buildings={buildings} /></MemoryRouter>);

  it('nhân viên thấy phòng đang giữ, mở thẻ rồi Mở bán lại gửi đúng hồ sơ và phiên bản', async () => {
    sessionStorage.setItem('flt:phong-trong:propId', JSON.stringify('b'));
    sessionStorage.setItem('flt:phong-trong:view', JSON.stringify('list'));
    const buildings = mapPayloadToBuildings(payload, { includeInternal: true });
    view(buildings);
    expect(screen.queryByText('401')).toBeNull();
    fireEvent.click(screen.getByText('301'));
    fireEvent.click(await screen.findByRole('button', { name: 'Mở bán lại' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Toà A · Phòng 301');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mở bán lại' }));
    await waitFor(() => expect(h.reopen).toHaveBeenCalledTimes(1));
    expect(h.reopen.mock.calls[0][0]).toMatchObject({ caseId: CASE, expectedVersion: 2, reason: null });
  });

  it('link công khai (không exit_hold) vẫn ẩn phòng đang giữ như phòng đã thuê', () => {
    sessionStorage.setItem('flt:phong-trong:propId', JSON.stringify('b'));
    sessionStorage.setItem('flt:phong-trong:view', JSON.stringify('list'));
    view(mapPayloadToBuildings(payload));
    expect(screen.getByText('101')).toBeTruthy();
    expect(screen.queryByText('301')).toBeNull();
    expect(screen.queryByText(/Chờ khách Sang\/Nhượng phòng/)).toBeNull();
  });
});
