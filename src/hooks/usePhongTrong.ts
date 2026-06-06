import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { RpcPayload } from "@/pages/phong-trong/sampleData";

/**
 * Trang công khai "Phòng trống" (/r/:token).
 * Gọi RPC public `get_public_available_rooms(p_token)` (SECURITY DEFINER, cấp cho anon).
 * RPC trả NULL khi token sai / đã thu hồi → data === null → UI báo "Liên kết không hợp lệ".
 * Tự refetch mỗi 5 phút và khi focus lại tab để bảng phòng luôn "live".
 */
export function usePhongTrong(token: string | undefined) {
  return useQuery({
    queryKey: ["phong-trong", token],
    enabled: !!token,
    refetchInterval: 5 * 60 * 1000, // 5 phút
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<RpcPayload | null> => {
      // RPC mới chưa có trong Database types tự sinh → cast qua `unknown` (không
      // dùng `any` để khỏi vướng lint). PHẢI gọi .rpc như METHOD trên client
      // (đừng tách ra biến rồi gọi rời) để giữ `this` → supabase-js mới gửi
      // header Content-Profile: public; nếu mất `this` sẽ rơi về schema mặc định
      // của PostgREST (api) và 404.
      const client = supabase as unknown as {
        rpc: (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { message: string } | null }>;
      };
      const { data, error } = await client.rpc("get_public_available_rooms", { p_token: token });
      if (error) throw error;
      return (data as RpcPayload | null) ?? null;
    },
  });
}
