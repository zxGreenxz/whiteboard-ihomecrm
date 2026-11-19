import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { LifecyclePayload } from '@/lib/roomLifecycle';

/**
 * Chu trình phòng (Plan 2 Task 6A) — đọc `get_room_cash_lifecycle_v1`.
 *
 * RPC fail-closed theo toà (42501 khi không có quyền xem) — lỗi đó phải hiện
 * theo ngữ cảnh cho người dùng và giữ nguyên mã tại boundary, không nuốt thành "phòng chưa có dữ liệu".
 *
 * MỘT bộ query options cho mọi nơi đọc RPC này (panel Chu trình phòng, ngăn kéo
 * Báo cáo LN, lane Thu tiền qua `qc.fetchQuery`): chung khoá ⇒ chung cache, một
 * lần gọi; chung meta inline ⇒ 42501 của người thiếu khoá theo toà không bật
 * toast toàn cục. Realtime làm mới khoá này (realtime/index.ts).
 */
export const roomCashLifecycleQuery = (roomId: string) => ({
  meta: { feedback: 'inline' as const },
  queryKey: ['room-cash-lifecycle', roomId] as const,
  // Lane gọi lại trong vài giây sau ngăn kéo/panel thì dùng lại bản vừa đọc;
  // realtime đã đánh dấu cũ trước khi lane chạy lại.
  staleTime: 30_000,
  // Thiếu khoá theo toà (42501) và payload sai hình là kết luận, không phải lỗi thoáng qua:
  // không thử lại (mặc định retry 1 của app ⇒ hai RPC mỗi lần mở/làm mới và chờ thêm ~1 s
  // mới rơi về dự phòng). Lỗi khác — kể cả JWT hết hạn (PGRST301) — giữ một lần thử lại.
  retry: (failureCount: number, error: unknown) =>
    failureCount < 1 && !(error instanceof TypeError) && (error as { code?: unknown } | null)?.code !== '42501',
  queryFn: async (): Promise<LifecyclePayload> => {
    const { data, error } = await supabase.rpc('get_room_cash_lifecycle_v1', {
      p_room_id: roomId,
    });
    if (error) throw error;
    const value=data as unknown as Partial<LifecyclePayload>|null;
    if(!value?.room || value.room.id!==roomId || !Array.isArray(value.contracts) || !Array.isArray(value.segments) || !Array.isArray(value.events) || !Array.isArray(value.vacancies)) throw new TypeError("Unconfirmed room lifecycle source");
    return value as LifecyclePayload;
  },
});

export function useRoomCashLifecycle(roomId: string | null) {
  return useQuery({
    ...roomCashLifecycleQuery(roomId ?? ''),
    // Khoá giữ nguyên hình cũ khi chưa có phòng (query tắt, không gọi RPC).
    queryKey: ['room-cash-lifecycle', roomId],
    enabled: !!roomId,
  });
}
