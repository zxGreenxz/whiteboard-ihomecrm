/**
 * Hook to run scheduled notification checks
 *
 * Chạy các check nhắc việc (HĐ hết hạn, nhắc thanh toán, hoá đơn quá hạn,
 * thiếu cọc) TỐI ĐA 1 LẦN/NGÀY/user (gate qua localStorage) — bản cũ chạy
 * trên MỌI lần mount Dashboard + mỗi 6h → N user × N lần F5 = burst quét
 * contracts/invoices lặp vô ích trên đúng trang nóng nhất. Dedup theo ngày
 * đã có sẵn trong từng check nên chạy 1 lần/ngày là đủ ngữ nghĩa.
 */

import { useEffect } from 'react';
import { useAuth } from './useAuth';
import { runScheduledNotifications } from '@/lib/notificationScheduler';

const RUN_GAP_MS = 20 * 60 * 60 * 1000; // ~1 lần/ngày (20h để lệch giờ mở app)

function lastRunKey(userId: string) {
  return `schedNotif:lastRun:${userId}`;
}

function shouldRun(userId: string): boolean {
  try {
    const t = Number(localStorage.getItem(lastRunKey(userId)) || 0);
    return Date.now() - t > RUN_GAP_MS;
  } catch {
    return true;
  }
}

function markRun(userId: string) {
  try {
    localStorage.setItem(lastRunKey(userId), String(Date.now()));
  } catch {
    /* ignore */
  }
}

export function useScheduledNotifications() {
  const { data: user } = useAuth();

  useEffect(() => {
    if (!user?.id) return;
    const uid = user.id;

    const tick = () => {
      if (!shouldRun(uid)) return;
      // Đánh dấu TRƯỚC khi chạy để nhiều tab mở cùng lúc không giẫm nhau.
      markRun(uid);
      runScheduledNotifications(uid);
    };

    tick();
    // Giữ interval 6h làm lưới an toàn cho tab treo qua ngày; gate ở trên
    // đảm bảo thực chạy tối đa ~1 lần/ngày.
    const interval = setInterval(tick, 6 * 60 * 60 * 1000);

    return () => clearInterval(interval);
  }, [user?.id]);
}
