import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** Chờ sau khi mở ứng dụng để lượt quét không tranh mạng với các lượt nạp đầu trang. */
export const PENDING_SWEEP_OPEN_DELAY_MS = 5_000;
/** Số lần hẹn xét lại tối đa mỗi phiên (cho dấu chưa lắng đủ 2 phút lúc quét): không thử lại dồn dập. */
export const PENDING_SWEEP_MAX_RECHECKS = 3;

/**
 * Quét nền dấu «chờ đối chiếu» khi mở app (đợt 11, `src/lib/pendingSweep.ts`): sau khi đã có người dùng và công ty đang
 * chọn, chờ một chút rồi nạp ĐỘNG bộ quét và chạy một lượt CHỈ ĐỌC; dấu chưa lắng thì hẹn xét lại một lần khi đủ 2 phút
 * (nếu app còn mở). Gắn trong `serviceWorkerBridge.tsx` (gói nạp lười, cần cả người dùng lẫn công ty) để gói entry không
 * mang thêm byte nào. Không bao giờ ném; nạp hụt thì lần mở app sau quét lại.
 */
export function usePendingSweepOnOpen(userId: string | null, organizationId: string | null): void {
  const queryClient = useQueryClient();
  // Dấu đã quét trong phiên (theo người dùng): đổi công ty quét thêm dấu của công ty mới, không quét lại dấu cũ.
  const session = useRef<{ userId: string | null; seen: Set<string>; rechecks: number }>({ userId: null, seen: new Set(), rechecks: 0 });
  useEffect(() => {
    if (!userId || !organizationId) return;
    if (session.current.userId !== userId) session.current = { userId, seen: new Set(), rechecks: 0 };
    const state = session.current;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      void import('@/lib/pendingSweep')
        .then(async (sweep) => {
          if (!alive) return;
          const report = await sweep.runPendingSweepOnOpen({ userId, organizationId, queryClient, seen: state.seen, isActive: () => alive });
          if (!alive || report?.recheckAt == null || state.rechecks >= PENDING_SWEEP_MAX_RECHECKS) return;
          state.rechecks += 1;
          timer = setTimeout(run, Math.max(1_000, report.recheckAt - Date.now() + 1_000));
        })
        .catch(() => { /* nạp hụt (mất mạng, chunk cũ): dấu để nguyên, lần mở app sau quét lại */ });
    };
    timer = setTimeout(run, PENDING_SWEEP_OPEN_DELAY_MS);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [userId, organizationId, queryClient]);
}
