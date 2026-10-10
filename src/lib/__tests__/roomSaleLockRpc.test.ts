import { describe, expect, it, vi } from 'vitest';
import {
  buildLockRoomArgs, listRoomSaleLocks, lockRoomForSale, releaseRoomSaleLock, saleLockErrorMessage, saleLockRemaining,
} from '../roomSaleLockRpc';

const org = '00000000-0000-4000-8000-000000000001';
const room = '00000000-0000-4000-8000-000000000002';
const lockId = '00000000-0000-4000-8000-000000000003';
const user = '00000000-0000-4000-8000-000000000004';
const lockRow = {
  id: lockId, organization_id: org, building_id: org, building_name: 'Toà A', room_id: room, room_name: '101', room_code: null,
  hours: 24, note: null, locked_by: user, locked_by_name: 'Sale A', locked_at: '2026-10-10T01:00:00Z', expires_at: '2026-10-11T01:00:00Z',
  released_at: null, release_reason: null, reservation_id: null, active: true,
};

describe('lock tạm phòng', () => {
  it('only 6/12/24 hours and a short note reach the server', () => {
    expect(buildLockRoomArgs(org, { roomId: room, hours: 12, note: '  khách hẹn mai  ' }))
      .toEqual({ p_organization_id: org, p_room_id: room, p_hours: 12, p_note: 'khách hẹn mai' });
    expect(buildLockRoomArgs(org, { roomId: room, hours: 6, note: '   ' }).p_note).toBeNull();
    expect(() => buildLockRoomArgs(org, { roomId: room, hours: 3 as 6 })).toThrow();
    expect(() => buildLockRoomArgs(org, { roomId: room, hours: 24, note: 'x'.repeat(301) })).toThrow();
  });
  it('calls the literal RPCs, validates replies and never swallows errors', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: lockRow, error: null })
      .mockResolvedValueOnce({ data: { ...lockRow, active: false, released_at: '2026-10-10T02:00:00Z', release_reason: 'MANUAL' }, error: null })
      .mockResolvedValueOnce({ data: { server_now: '2026-10-10T02:00:00Z', locks: [lockRow] }, error: null })
      .mockResolvedValueOnce({ data: { unexpected: true }, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Không có quyền lock tạm phòng ở tòa này' } });
    expect(await lockRoomForSale(rpc, org, { roomId: room, hours: 24 })).toMatchObject({ id: lockId, active: true });
    expect(rpc.mock.calls[0]).toEqual(['lock_room_for_sale_v1', { p_organization_id: org, p_room_id: room, p_hours: 24, p_note: null }]);
    expect(await releaseRoomSaleLock(rpc, org, lockId)).toMatchObject({ release_reason: 'MANUAL' });
    expect(rpc.mock.calls[1]).toEqual(['release_room_sale_lock_v1', { p_organization_id: org, p_lock_id: lockId }]);
    expect((await listRoomSaleLocks(rpc, org)).locks).toHaveLength(1);
    await expect(lockRoomForSale(rpc, org, { roomId: room, hours: 6 })).rejects.toThrow('Chưa xác nhận được lock tạm');
    await expect(lockRoomForSale(rpc, org, { roomId: room, hours: 6 })).rejects.toMatchObject({ code: '42501' });
  });
  it('shows verified server reasons and remaining time rounded up', () => {
    expect(saleLockErrorMessage({ code: '55000', message: 'Phòng đang được lock tạm. Tải lại danh sách.' })).toContain('đang được lock tạm');
    const now = Date.parse('2026-10-10T01:00:00Z');
    expect(saleLockRemaining('2026-10-10T18:30:00Z', now)).toBe('còn 18 giờ');
    expect(saleLockRemaining('2026-10-10T01:40:00Z', now)).toBe('còn 40 phút');
    expect(saleLockRemaining('2026-10-10T00:59:00Z', now)).toBe('hết hạn');
  });
});
