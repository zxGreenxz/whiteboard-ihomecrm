import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { LifecyclePayload } from '@/lib/roomLifecycle';

/**
 * Chu trình phòng (Plan 2 Task 6A) — đọc `get_room_cash_lifecycle_v1`.
 *
 * RPC fail-closed theo toà (42501 khi không có quyền xem) — lỗi đó phải hiện
 * theo ngữ cảnh cho người dùng và giữ nguyên mã tại boundary, không nuốt thành "phòng chưa có dữ liệu".
 */
export function useRoomCashLifecycle(roomId: string | null) {
  return useQuery({
    meta:{feedback:"inline"},
    queryKey: ['room-cash-lifecycle', roomId],
    enabled: !!roomId,
    queryFn: async (): Promise<LifecyclePayload> => {
      const { data, error } = await supabase.rpc('get_room_cash_lifecycle_v1', {
        p_room_id: roomId!,
      });
      if (error) throw error;
      const value=data as unknown as Partial<LifecyclePayload>|null;
      if(!value?.room || value.room.id!==roomId || !Array.isArray(value.contracts) || !Array.isArray(value.segments) || !Array.isArray(value.events) || !Array.isArray(value.vacancies)) throw new TypeError("Unconfirmed room lifecycle source");
      return value as LifecyclePayload;
    },
  });
}
