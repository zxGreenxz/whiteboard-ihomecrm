import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isRoomCodeQuery } from "@/lib/roomCodeSearch";

/**
 * Tra cứu room_id của các phòng có TÊN trùng KHỚP mã phòng người dùng gõ
 * (so khớp chính xác, không phân biệt hoa thường — tên phòng lặp giữa các toà
 * nên trả về nhiều id). Chỉ chạy khi chuỗi trông giống mã phòng (isRoomCodeQuery)
 * để khỏi query thừa khi gõ tên/số tiền. Có thể giới hạn theo toà đang lọc.
 *
 * RLS trên bảng rooms tự cắt theo phạm vi toà của user → kết quả khớp đúng những
 * phòng user được phép thấy (đồng bộ với phạm vi phiếu/hoá đơn).
 */
export function useRoomIdsByCode(
  rawCode: string | null | undefined,
  buildingIds?: string[] | null,
) {
  const code = (rawCode ?? "").trim();
  const enabled = isRoomCodeQuery(code);
  // Khoá ổn định theo nội dung (không phụ thuộc identity mảng).
  const buildingKey = buildingIds && buildingIds.length
    ? [...buildingIds].sort().join(",")
    : null;

  return useQuery({
    queryKey: ["room-ids-by-code", code.toLowerCase(), buildingKey],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<string[]> => {
      // ilike KHÔNG có ký tự đại diện = so khớp chính xác (case-insensitive).
      let q = (supabase
        .from("rooms" as any)
        .select("id") as any)
        .is("deleted_at", null)
        .ilike("name", code);
      if (buildingIds && buildingIds.length) {
        q = q.in("building_id", buildingIds);
      }
      const { data, error } = await q;
      if (error) {
        console.error("useRoomIdsByCode error:", error);
        return [];
      }
      return ((data ?? []) as any[]).map((r) => r.id as string);
    },
  });
}
