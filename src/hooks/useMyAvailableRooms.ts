import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { roomSaleQueryInterval } from '@/lib/roomSaleFacts';
import { parseTimedRoomSaleRead } from '@/lib/publicSalePolicyExpiry';
import { useTimedRoomSaleResult } from '@/hooks/useTimedRoomSaleResult';

/**
 * Đọc phòng trống của owner hiện tại cho user ĐÃ ĐĂNG NHẬP (in-app, không cần token).
 * Gọi RPC get_my_available_rooms() — suy owner từ ngữ cảnh caller (owner/super →
 * chính mình; staff → staff_assignments.user_id) rồi trả CÙNG payload với
 * get_public_available_rooms ({areas, buildings, rooms, contact}). Map qua
 * mapPayloadToBuildings để tái dùng nguyên UI trang "Phòng trống".
 *
 * `enabled: false` khi màn không hiện danh sách này (điện thoại ở chế độ Cập nhật/Quản lý):
 * không đọc, không đặt nhịp, focus/reconnect cũng không đọc. Bật lại thì đọc ngay nếu dữ liệu
 * đã cũ hơn staleTime.
 */
export function useMyAvailableRooms({ enabled = true }: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: ["my-available-rooms"],
    enabled,
    staleTime: 5_000,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    refetchIntervalInBackground: false,
    retry: false,
    refetchInterval: (query) => roomSaleQueryInterval('internal', query),
    queryFn: async () => {
      const started = performance.now();
      const { data, error } = await supabase.rpc("get_my_available_rooms");
      if (error) throw error;
      return parseTimedRoomSaleRead(data, true, started, performance.now());
    },
  });
  return useTimedRoomSaleResult(query);
}
