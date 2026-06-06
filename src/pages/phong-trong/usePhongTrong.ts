import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { mapPayloadToBuildings, type RpcPayload } from "./supabaseData";

/**
 * Đọc phòng trống công khai theo token chia sẻ (anon).
 * Tái dùng RPC public get_public_available_rooms đã có
 * (supabase/migrations/20260606120000_public_room_share_phong_trong.sql) rồi map
 * sang type Building/Room qua mapPayloadToBuildings — KHÔNG tạo RPC/migration mới.
 * refetch định kỳ để sale luôn thấy "thời điểm hiện tại".
 *
 * Nếu trang chạy SAU đăng nhập (không token): thay queryFn bằng truy vấn bảng trực tiếp
 * rồi tự dựng RpcPayload { buildings, rooms } và gọi mapPayloadToBuildings().
 */
export function usePhongTrong(token?: string) {
  return useQuery({
    queryKey: ["phong-trong", token],
    enabled: !!token,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      }).rpc("get_public_available_rooms", { p_token: token });
      if (error) throw error;
      return mapPayloadToBuildings((data as RpcPayload | null) ?? null);
    },
  });
}
