import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { LifecyclePayload } from '@/lib/roomLifecycle';

/**
 * Chu trình phòng (Plan 2 Task 6A) — đọc `get_room_cash_lifecycle_v1`.
 *
 * RPC fail-closed theo toà (42501 khi không có quyền xem) — lỗi đó phải hiện
 * nguyên văn cho người dùng, không nuốt thành "phòng chưa có dữ liệu".
 */
export function useRoomCashLifecycle(roomId: string | null) {
  return useQuery({
    queryKey: ['room-cash-lifecycle', roomId],
    enabled: !!roomId,
    queryFn: async (): Promise<LifecyclePayload> => {
      const { data, error } = await supabase.rpc('get_room_cash_lifecycle_v1', {
        p_room_id: roomId!,
      });
      if (error) throw new Error(error.message);
      return data as unknown as LifecyclePayload;
    },
  });
}
