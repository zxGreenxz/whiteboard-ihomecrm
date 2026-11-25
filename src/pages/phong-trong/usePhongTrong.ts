import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PublicRoomLinkError } from "./supabaseData";
import { roomSaleQueryInterval } from '@/lib/roomSaleFacts';
import { parseTimedRoomSaleRead } from '@/lib/publicSalePolicyExpiry';
import { useTimedRoomSaleResult } from '@/hooks/useTimedRoomSaleResult';

/**
 * Đọc phòng trống công khai theo token chia sẻ (anon).
 * Giữ token/RPC hiện hành, kiểm payload rồi map public allowlist.
 * Poll 60s khi trang hiện (đợt 4 «Tải nhẹ», trước là 5s), focus/reconnect đọc lại ngay;
 * lỗi LIÊN TIẾP giãn gấp đôi (về nhịp gốc sau một lần đọc thành công), tối đa 5 phút.
 * In-app dùng useMyAvailableRooms, không chạy truy vấn token song song.
 */
export function usePhongTrong(token?: string) {
  const query = useQuery({
    queryKey: ["phong-trong", token],
    enabled: !!token,
    staleTime: 5_000,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    refetchIntervalInBackground: false,
    retry: false,
    refetchInterval: (query) => query.state.error instanceof PublicRoomLinkError ? false : roomSaleQueryInterval('public', query),
    queryFn: async () => {
      if (!token) throw new PublicRoomLinkError();
      const started = performance.now();
      // hermes-parity:begin sale-listing — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
      const { data, error } = await supabase.rpc("get_public_available_rooms", { p_token: token });
      // hermes-parity:end sale-listing
      if (error) throw error;
      // RPC trả NULL khi token không tồn tại/đã thu hồi; payload rỗng hợp lệ
      // vẫn có buildings/rooms. Không biến hai kết quả này thành cùng một []
      // rồi để UI thế bằng danh sách mẫu.
      if (data === null) throw new PublicRoomLinkError();
      return parseTimedRoomSaleRead(data, false, started, performance.now());
    },
  });
  return useTimedRoomSaleResult(query);
}
