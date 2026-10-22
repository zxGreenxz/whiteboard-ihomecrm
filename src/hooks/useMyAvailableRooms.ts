import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { roomSalePollingInterval } from '@/lib/roomSaleFacts';
import { parseTimedRoomSaleRead } from '@/lib/publicSalePolicyExpiry';
import { useTimedRoomSaleResult } from '@/hooks/useTimedRoomSaleResult';

/**
 * Đọc phòng trống của owner hiện tại cho user ĐÃ ĐĂNG NHẬP (in-app, không cần token).
 * Gọi RPC get_my_available_rooms() — suy owner từ ngữ cảnh caller (owner/super →
 * chính mình; staff → staff_assignments.user_id) rồi trả CÙNG payload với
 * get_public_available_rooms ({areas, buildings, rooms, contact}). Map qua
 * mapPayloadToBuildings để tái dùng nguyên UI trang "Phòng trống".
 */
export function useMyAvailableRooms() {
  const query = useQuery({
    queryKey: ["my-available-rooms"],
    staleTime: 5_000,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    refetchIntervalInBackground: false,
    retry: false,
    refetchInterval: (query) => roomSalePollingInterval(query.state.error ? query.state.errorUpdateCount : 0),
    queryFn: async () => {
      const started = performance.now();
      const { data, error } = await supabase.rpc("get_my_available_rooms");
      if (error) throw error;
      return parseTimedRoomSaleRead(data, true, started, performance.now());
    },
  });
  return useTimedRoomSaleResult(query);
}
