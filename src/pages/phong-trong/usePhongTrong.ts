import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { mapPayloadToBuildings, parseRoomSalePayload, PublicRoomLinkError } from "./supabaseData";
import { roomSalePollingInterval } from '@/lib/roomSaleFacts';

/**
 * Đọc phòng trống công khai theo token chia sẻ (anon).
 * Giữ token/RPC hiện hành, kiểm payload rồi map public allowlist.
 * Poll 5s khi trang hiện, focus/reconnect đọc lại; lỗi mạng backoff tối đa 60s.
 * In-app dùng useMyAvailableRooms, không chạy truy vấn token song song.
 */
export function usePhongTrong(token?: string) {
  return useQuery({
    queryKey: ["phong-trong", token],
    enabled: !!token,
    staleTime: 5_000,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    refetchIntervalInBackground: false,
    retry: false,
    refetchInterval: (query) => query.state.error instanceof PublicRoomLinkError ? false : roomSalePollingInterval(query.state.error ? query.state.errorUpdateCount : 0),
    queryFn: async () => {
      if (!token) throw new PublicRoomLinkError();
      const { data, error } = await supabase.rpc("get_public_available_rooms", { p_token: token });
      if (error) throw error;
      // RPC trả NULL khi token không tồn tại/đã thu hồi; payload rỗng hợp lệ
      // vẫn có buildings/rooms. Không biến hai kết quả này thành cùng một []
      // rồi để UI thế bằng danh sách mẫu.
      if (data === null) throw new PublicRoomLinkError();
      return mapPayloadToBuildings(parseRoomSalePayload(data));
    },
  });
}
