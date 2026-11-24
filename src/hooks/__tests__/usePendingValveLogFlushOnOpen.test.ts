// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queue = vi.hoisted(() => ({
  waiting: new Set<string>(),
  flush: vi.fn(async (_userId: string, _options?: { delayMs?: number }) => {}),
}));
vi.mock('@/lib/pendingValveLogQueue', () => ({
  pendingValveLogWaiting: (userId: string) => queue.waiting.has(userId),
  flushPendingValveLogSoon: queue.flush,
}));

import { PENDING_VALVE_LOG_OPEN_DELAY_MS, usePendingValveLogFlushOnOpen } from '../usePendingValveLogFlushOnOpen';

describe('mở ứng dụng thì đẩy phần nhật ký tự gỡ còn lại', () => {
  beforeEach(() => { queue.waiting.clear(); queue.flush.mockClear(); });

  it('đã đăng nhập và hàng đợi còn dòng: đẩy ở nền, có độ trễ', () => {
    queue.waiting.add('u1');
    renderHook(() => usePendingValveLogFlushOnOpen('u1'));
    expect(queue.flush).toHaveBeenCalledTimes(1);
    expect(queue.flush).toHaveBeenCalledWith('u1', { delayMs: PENDING_VALVE_LOG_OPEN_DELAY_MS });
  });

  it('chưa đăng nhập hoặc hàng đợi rỗng: không nạp module đẩy', () => {
    queue.waiting.add('u1');
    renderHook(() => usePendingValveLogFlushOnOpen(null));
    renderHook(() => usePendingValveLogFlushOnOpen('u2'));
    expect(queue.flush).not.toHaveBeenCalled();
  });

  it('đổi tài khoản thì xét hàng đợi của người mới; render lại cùng người không đẩy lại', () => {
    queue.waiting.add('u1');
    queue.waiting.add('u2');
    const { rerender } = renderHook(({ user }) => usePendingValveLogFlushOnOpen(user), { initialProps: { user: 'u1' as string | null } });
    rerender({ user: 'u1' });
    rerender({ user: 'u2' });
    expect(queue.flush.mock.calls.map(([user]) => user)).toEqual(['u1', 'u2']);
  });
});
