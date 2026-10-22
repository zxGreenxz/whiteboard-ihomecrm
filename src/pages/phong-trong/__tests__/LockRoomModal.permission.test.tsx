// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LockRoomModal } from '../LockRoomModal';
import type { Room } from '../sampleData';
const calls = vi.hoisted(() => ({ lock: vi.fn(), release: vi.fn() }));
vi.mock('@/hooks/useRoomSaleLocks', () => ({
  useLockRoomForSale: () => ({ mutateAsync: calls.lock, isPending: false }),
  useReleaseRoomSaleLock: () => ({ mutateAsync: calls.release, isPending: false }),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const room = { id: 'room-a', code: '101', no: 101, buildingName: 'Tòa A', price: 3, status: 'free' } as Room;

it('a scope change blocks an open lock without erasing its chosen duration and note', () => {
  const close = vi.fn(), done = vi.fn(), action = { room, mode: 'lock' as const };
  const view = render(<LockRoomModal action={action} onClose={close} onDone={done} />);
  fireEvent.click(screen.getByRole('radio', { name: '6 giờ' }));
  fireEvent.change(screen.getByPlaceholderText('VD: khách anh Tuấn hẹn chiều mai cọc'), { target: { value: 'Giữ cho khách Lan' } });
  view.rerender(<LockRoomModal action={action} onClose={close} onDone={done} blockedReason="Không còn quyền lock phòng này." />);
  const submit = screen.getByRole('button', { name: 'Lock 6 giờ' });
  expect(submit).toHaveProperty('disabled', true); fireEvent.click(submit);
  expect(calls.lock).not.toHaveBeenCalled();
  expect(screen.getByDisplayValue('Giữ cho khách Lan')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Không còn quyền');
});

it('a replaced lock cannot be released from the previously open confirmation', () => {
  const locked = { ...room, saleLock: { id: 'lock-a', hours: 6, note: null, lockedAt: '2026-10-21T00:00:00Z', expiresAt: '2026-10-21T06:00:00Z', lockedByName: 'Sale A', lockedByMe: true } };
  render(<LockRoomModal action={{ room: locked, mode: 'release' }} onClose={vi.fn()} onDone={vi.fn()} blockedReason="Lock của phòng đã thay đổi." />);
  fireEvent.click(screen.getByRole('button', { name: 'Gỡ lock' }));
  expect(screen.getByRole('button', { name: 'Gỡ lock' })).toHaveProperty('disabled', true);
  expect(calls.release).not.toHaveBeenCalled();
});
