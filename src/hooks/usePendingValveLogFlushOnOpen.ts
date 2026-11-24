import { useEffect } from 'react';

/** Chờ một chút sau khi mở ứng dụng để lượt đẩy không tranh mạng với các lượt nạp đầu trang. */
export const PENDING_VALVE_LOG_OPEN_DELAY_MS = 2_000;

/**
 * Khoá hàng đợi nhật ký tự gỡ, ĐÚNG như `pendingValveLogKey` của `src/lib/pendingValveLogQueue.ts` (test so khớp).
 * Cố ý không import tệp đó: hook này nằm trong gói nạp lúc mở ứng dụng, import tĩnh thêm một nơi sẽ tách tệp kia
 * thành gói riêng chen vào danh sách nạp trước của mọi trang và làm gói entry phình.
 */
export const pendingValveLogKeyForOpen = (userId: string): string => 'ihome:pending-valve-log:v1:' + encodeURIComponent(userId);

function queueWaiting(userId: string): boolean {
  try {
    const raw = globalThis.localStorage.getItem(pendingValveLogKeyForOpen(userId));
    return raw !== null && raw !== '[]';
  } catch {
    return false;
  }
}

/**
 * Mở ứng dụng (đã đăng nhập) mà hàng đợi nhật ký tự gỡ khoá của người này còn dòng — lần đẩy ngay sau khi gỡ đã hỏng
 * vì mất mạng, hay tab bị đóng trước khi đẩy xong — thì đẩy phần còn lại lên máy chủ ở nền. Hàng đợi rỗng thì không
 * nạp gì thêm: module đẩy chỉ được tải khi có việc. Không bao giờ ném.
 */
export function usePendingValveLogFlushOnOpen(userId: string | null): void {
  useEffect(() => {
    if (!userId || !queueWaiting(userId)) return;
    const timer = setTimeout(() => {
      void import('@/lib/pendingValveLogSync')
        .then((sync) => sync.flushPendingValveLog(userId))
        .catch(() => { /* nạp hụt hay đẩy hỏng: dòng còn trong hàng đợi, thử lại lần sau */ });
    }, PENDING_VALVE_LOG_OPEN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [userId]);
}
