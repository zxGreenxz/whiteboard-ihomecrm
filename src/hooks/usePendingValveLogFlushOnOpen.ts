import { useEffect } from 'react';
import { flushPendingValveLogSoon, pendingValveLogWaiting } from '@/lib/pendingValveLogQueue';

/** Chờ một chút sau khi mở ứng dụng để lượt đẩy không tranh mạng với các lượt nạp đầu trang. */
export const PENDING_VALVE_LOG_OPEN_DELAY_MS = 2_000;

/**
 * Mở ứng dụng (đã đăng nhập) mà hàng đợi nhật ký tự gỡ khoá của người này còn dòng — lần đẩy ngay sau khi gỡ đã hỏng
 * vì mất mạng, hay tab bị đóng trước khi đẩy xong — thì đẩy phần còn lại lên máy chủ ở nền. Hàng đợi rỗng thì không
 * nạp gì thêm: module đẩy chỉ được tải khi có việc.
 */
export function usePendingValveLogFlushOnOpen(userId: string | null): void {
  useEffect(() => {
    if (!userId || !pendingValveLogWaiting(userId)) return;
    void flushPendingValveLogSoon(userId, { delayMs: PENDING_VALVE_LOG_OPEN_DELAY_MS });
  }, [userId]);
}
