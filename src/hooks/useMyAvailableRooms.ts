import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  mapPayloadToBuildings,
  type RpcPayload,
} from "@/pages/phong-trong/supabaseData";

/**
 * Đọc phòng trống của owner hiện tại cho user ĐÃ ĐĂNG NHẬP (in-app, không cần token).
 * Gọi RPC get_my_available_rooms() — suy owner từ ngữ cảnh caller (owner/super →
 * chính mình; staff → staff_assignments.user_id) rồi trả CÙNG payload với
 * get_public_available_rooms ({areas, buildings, rooms, contact}). Map qua
 * mapPayloadToBuildings để tái dùng nguyên UI trang "Phòng trống".
 */
export function useMyAvailableRooms() {
  return useQuery({
    queryKey: ["my-available-rooms"],
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase as unknown as {
        rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      }).rpc("get_my_available_rooms");
      if (error) throw error;
      return mapPayloadToBuildings((data as RpcPayload | null) ?? null);
    },
  });
}
