// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sync = vi.hoisted(() => ({ flush: vi.fn(async (_userId: string) => ({})) }));
vi.mock('@/lib/pendingValveLogSync', () => ({ flushPendingValveLog: sync.flush }));

import { PENDING_VALVE_LOG_OPEN_DELAY_MS, pendingValveLogKeyForOpen, usePendingValveLogFlushOnOpen } from '../usePendingValveLogFlushOnOpen';

const queue = (userId: string, rows: unknown[]) => localStorage.setItem(pendingValveLogKeyForOpen(userId), JSON.stringify(rows));
/** Chạy hết hẹn giờ rồi chờ import động + lời gọi đẩy xong. */
async function passDelay() {
  await vi.advanceTimersByTimeAsync(PENDING_VALVE_LOG_OPEN_DELAY_MS);
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
}

describe('mở ứng dụng thì đẩy phần nhật ký tự gỡ còn lại', () => {
  beforeEach(() => { localStorage.clear(); sync.flush.mockClear(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('đã đăng nhập và hàng đợi còn dòng: đẩy ở nền sau độ trễ', async () => {
    queue('u1', [{ id: 'x' }]);
    renderHook(() => usePendingValveLogFlushOnOpen('u1'));
    await vi.advanceTimersByTimeAsync(PENDING_VALVE_LOG_OPEN_DELAY_MS - 1);
    expect(sync.flush).not.toHaveBeenCalled();
    await passDelay();
    expect(sync.flush).toHaveBeenCalledTimes(1);
    expect(sync.flush).toHaveBeenCalledWith('u1');
  });

  it('chưa đăng nhập, hàng đợi rỗng hay của người khác: không nạp module đẩy', async () => {
    queue('u1', [{ id: 'x' }]);
    queue('u3', []);
    renderHook(() => usePendingValveLogFlushOnOpen(null));
    renderHook(() => usePendingValveLogFlushOnOpen('u2'));
    renderHook(() => usePendingValveLogFlushOnOpen('u3'));
    await passDelay();
    expect(sync.flush).not.toHaveBeenCalled();
  });

  it('đổi tài khoản trước khi hết độ trễ thì chỉ đẩy cho người mới; render lại cùng người không đẩy lại', async () => {
    queue('u1', [{ id: 'x' }]);
    queue('u2', [{ id: 'y' }]);
    const { rerender } = renderHook(({ user }) => usePendingValveLogFlushOnOpen(user), { initialProps: { user: 'u1' as string | null } });
    rerender({ user: 'u1' });
    rerender({ user: 'u2' });
    await passDelay();
    expect(sync.flush.mock.calls.map(([user]) => user)).toEqual(['u2']);
  });

  it('đọc localStorage lỗi (trình duyệt chặn) thì im lặng, không ném', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    try {
      expect(() => renderHook(() => usePendingValveLogFlushOnOpen('u1'))).not.toThrow();
      await passDelay();
      expect(sync.flush).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
