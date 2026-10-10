// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapPayloadToBuildings, type RpcPayload } from '../supabaseData';
import { buildRoomListTable } from '../roomListTable';
import { DetailSheet } from '../PhongTrongSheet';
import { LockRoomModal } from '../LockRoomModal';
import type { Room } from '../sampleData';

const m = vi.hoisted(() => ({ lock: vi.fn(), release: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: path } }) }) } } }));
vi.mock('@/hooks/useRoomSaleLocks', () => ({
  useLockRoomForSale: () => ({ mutateAsync: m.lock, isPending: false }),
  useReleaseRoomSaleLock: () => ({ mutateAsync: m.release, isPending: false }),
}));
vi.mock('../useTracking', () => ({ useTrack: () => ({ track: vi.fn(), trackError: vi.fn() }) }));

const expiresAt = new Date(Date.now() + 18 * 3600_000 - 60_000).toISOString();
const saleLock = { id: 'lock1', hours: 24, note: 'Khách hẹn mai', locked_at: '2026-10-10T00:00:00Z', expires_at: expiresAt, locked_by_name: 'Sale A', locked_by_me: false };
const base = { building_id: 'b', floor: 2, code: null, area: 20, rent_price: 4_000_000, max_occupants: 2, amenities: [], images: [], description: null,
  avail_date: null, sale_today: '2026-10-10', expected_ready_on: null };
const payload: RpcPayload = {
  buildings: [{ id: 'b', name: 'Toà A', code: 'A', district: null, ward: null, address: null, total_floors: 3 }],
  rooms: [
    { ...base, id: 'free', floor: 1, name: '101', status_public: 'free', sale_state: 'READY' },
    { ...base, id: 'locked', name: '201', status_public: 'rented', sale_state: 'RENTED', sale_lock: saleLock },
  ],
};

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });

describe('phòng lock tạm trong dữ liệu trang phòng trống', () => {
  it('in-app mapping shows a locked room with its lock facts but never offers it for sale', () => {
    const [b] = mapPayloadToBuildings(payload, { includeInternal: true });
    const locked = b.rooms.find((r) => r.id === 'locked')!;
    expect(locked).toMatchObject({ status: 'locked', saleLock: { id: 'lock1', lockedByName: 'Sale A', lockedByMe: false, hours: 24 } });
    expect(locked.saleFact).toBeUndefined();
    expect(b.freeCount).toBe(1);
    expect(b.floors.map((f) => f.floor)).toEqual([2, 1]);
    expect(buildRoomListTable([b]).totalRooms).toBe(1);
  });
  it('public mapping keeps the room as rented with no lock details', () => {
    const [b] = mapPayloadToBuildings(payload);
    expect(b.rooms.find((r) => r.id === 'locked')).toMatchObject({ status: 'rented', saleLock: null });
    expect(b.floors.map((f) => f.floor)).toEqual([1]);
  });
});

describe('nút lock trong thẻ chi tiết phòng', () => {
  const [b] = mapPayloadToBuildings(payload, { includeInternal: true });
  const lockedRoom = b.rooms.find((r) => r.id === 'locked')!;
  const freeRoom = b.rooms.find((r) => r.id === 'free')!;
  const sheet = (room: Room, extra: Partial<Parameters<typeof DetailSheet>[0]> = {}) => render(
    <DetailSheet room={room} show onClose={vi.fn()} onToast={vi.fn()} saved={[]} toggleSave={vi.fn()} onGo={vi.fn()} buildings={[b]} {...extra} />);

  it('a free room offers "Lock tạm" only to staff allowed to lock', () => {
    const onLock = vi.fn();
    sheet(freeRoom, { onLock });
    fireEvent.click(screen.getByRole('button', { name: 'Lock tạm' }));
    expect(onLock).toHaveBeenCalledWith(freeRoom);
    cleanup();
    sheet(freeRoom);
    expect(screen.queryByRole('button', { name: 'Lock tạm' })).toBeNull();
  });
  it('a locked room shows who locked it, offers the deposit voucher and release only when allowed', () => {
    const onReleaseLock = vi.fn();
    sheet(lockedRoom, { onQuickDeposit: vi.fn(), onLock: vi.fn(), onReleaseLock, canReleaseLock: () => true });
    expect(screen.getByRole('status').textContent).toMatch(/Đã chốt tạm · còn 18 giờ.*Lock bởi Sale A · 24 giờ.*Ghi chú: Khách hẹn mai/);
    expect(screen.getByRole('button', { name: 'Tạo phiếu cọc' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lock tạm' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Gỡ lock' }));
    expect(onReleaseLock).toHaveBeenCalledWith(lockedRoom);
    cleanup();
    sheet(lockedRoom, { onReleaseLock, canReleaseLock: () => false });
    expect(screen.queryByRole('button', { name: 'Gỡ lock' })).toBeNull();
  });
});

describe('hộp thoại lock tạm / gỡ lock', () => {
  const [b] = mapPayloadToBuildings(payload, { includeInternal: true });
  const lockedRoom = b.rooms.find((r) => r.id === 'locked')!;
  const freeRoom = b.rooms.find((r) => r.id === 'free')!;

  it('locks for the chosen hours with the note and reports the end time', async () => {
    m.lock.mockResolvedValue({ expires_at: '2026-10-10T12:00:00Z' });
    const onDone = vi.fn(); const onClose = vi.fn();
    render(<LockRoomModal action={{ room: freeRoom, mode: 'lock' }} onClose={onClose} onDone={onDone} />);
    expect(screen.getByRole('radio', { name: '24 giờ' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '12 giờ' }));
    fireEvent.change(screen.getByPlaceholderText(/khách anh Tuấn/), { target: { value: ' khách hẹn tối ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lock 12 giờ' }));
    await waitFor(() => expect(m.lock).toHaveBeenCalledWith({ roomId: 'free', hours: 12, note: 'khách hẹn tối' }));
    expect(onDone.mock.calls[0][0]).toMatch(/^Đã lock phòng 101 đến \d\d:\d\d \d\d\/\d\d$/);
    expect(onClose).toHaveBeenCalled();
  });
  it('keeps the dialog open with the server reason when locking fails', async () => {
    m.lock.mockRejectedValue({ code: '55000', message: 'Phòng đang được lock tạm. Tải lại danh sách.' });
    const onClose = vi.fn();
    render(<LockRoomModal action={{ room: freeRoom, mode: 'lock' }} onClose={onClose} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lock 24 giờ' }));
    expect((await screen.findByRole('alert')).textContent).toContain('đang được lock tạm');
    expect(onClose).not.toHaveBeenCalled();
  });
  it('release asks first, then releases that exact lock', async () => {
    m.release.mockResolvedValue({});
    const onDone = vi.fn();
    render(<LockRoomModal action={{ room: lockedRoom, mode: 'release' }} onClose={vi.fn()} onDone={onDone} />);
    expect(screen.getByText(/Lock bởi Sale A, còn 18 giờ · Khách hẹn mai/)).toBeTruthy();
    expect(m.release).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Gỡ lock' }));
    await waitFor(() => expect(m.release).toHaveBeenCalledWith('lock1'));
    expect(onDone).toHaveBeenCalledWith('Đã gỡ lock phòng 201');
  });
});
