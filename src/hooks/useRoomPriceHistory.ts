import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type RoomPriceHistoryRow =
  Database["public"]["Tables"]["room_price_history"]["Row"];

export type RoomPriceHistorySource = RoomPriceHistoryRow["source"];

export interface RoomPriceHistoryEntry extends RoomPriceHistoryRow {
  contract_number: string | null;
  changed_by_name: string | null;
}

/** Nhãn tiếng Việt cho từng nguồn thay đổi (khớp CHECK constraint ở DB). */
export const ROOM_PRICE_SOURCE_LABELS: Record<string, string> = {
  ROOM_EDIT: "Sửa phòng",
  CONTRACT_CREATE: "Ký hợp đồng",
  CONTRACT_EDIT: "Sửa hợp đồng",
};

/**
 * Lịch sử giá thuê / tiền cọc của MỘT phòng — bảng append-only do trigger DB
 * ghi (xem migration 20260728180000_room_price_history).
 *
 * Đọc kèm số HĐ và tên người thao tác để bảng lịch sử tự đọc được, không phải
 * bấm sang màn khác. RLS đã giới hạn theo phạm vi toà nhà nên không lọc thêm.
 */
export const useRoomPriceHistory = (
  roomId: string | undefined,
  options?: { enabled?: boolean; limit?: number },
) => {
  const limit = options?.limit ?? 20;
  return useQuery({
    enabled: (options?.enabled ?? true) && !!roomId,
    queryKey: ["room-price-history", roomId, limit],
    queryFn: async (): Promise<RoomPriceHistoryEntry[]> => {
      const { data, error } = await supabase
        .from("room_price_history")
        .select("*, contract:contracts(contract_number)")
        .eq("room_id", roomId!)
        .order("changed_at", { ascending: false })
        .limit(limit);

      if (error) {
        console.error("useRoomPriceHistory error:", error);
        throw error;
      }

      const rows = (data ?? []) as Array<
        RoomPriceHistoryRow & { contract?: { contract_number: string | null } | null }
      >;

      // Tên người thao tác nằm ở profiles — join riêng vì room_price_history
      // không có FK sang profiles (changed_by chỉ là auth uid).
      const actorIds = [...new Set(rows.map((r) => r.changed_by).filter(Boolean))];
      const names = new Map<string, string>();
      if (actorIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", actorIds as string[]);
        for (const p of profiles ?? []) {
          if (p.full_name) names.set(p.id, p.full_name);
        }
      }

      return rows.map(({ contract, ...row }) => ({
        ...row,
        contract_number: contract?.contract_number ?? null,
        changed_by_name: row.changed_by ? names.get(row.changed_by) ?? null : null,
      }));
    },
  });
};
