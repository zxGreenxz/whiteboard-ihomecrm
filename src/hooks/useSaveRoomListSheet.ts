import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { requireAccountWriteReceipt } from "@/lib/accountSettingsWriteReceipt";
import type { SheetChanges } from "@/components/sale-phong/roomListSheetDraft";

/** Khoá ô trong bản nháp: `phone:<buildingId>` / `policy:<roomId>`. */
export const sheetKey = { phone: (id: string) => `phone:${id}`, policy: (id: string) => `policy:${id}` };

/** Lỗi giữa chừng: biết ô nào ĐÃ ghi để bỏ khỏi bản nháp, giữ ô chưa ghi để lưu lại. */
export class RoomListSheetSaveError extends Error {
  constructor(readonly savedKeys: string[], readonly total: number, readonly failure: unknown) {
    super(`Mới lưu ${savedKeys.length}/${total} ô của bảng phòng trống.`);
    this.name = "RoomListSheetSaveError";
  }
}

/**
 * Ghi các ô của bảng phòng trống: SĐT riêng tòa (buildings.public_contact_phone)
 * và chính sách sale riêng phòng (rooms.sale_note — ô "Khuyến mãi" của trang
 * công khai). Ghi từng dòng, đối chiếu biên nhận; trả về các khoá đã xác nhận.
 */
export function useSaveRoomListSheet() {
  const qc = useQueryClient();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (changes: SheetChanges): Promise<string[]> => {
      const saved: string[] = [];
      const total = changes.buildings.length + changes.rooms.length;
      try {
        for (const b of changes.buildings) {
          const { data, error } = await supabase.from("buildings")
            .update({ public_contact_phone: b.phone }).eq("id", b.id).select("id,public_contact_phone").single();
          if (error) throw error;
          requireAccountWriteReceipt(data, { id: b.id, public_contact_phone: b.phone });
          saved.push(sheetKey.phone(b.id));
        }
        for (const r of changes.rooms) {
          const { data, error } = await supabase.from("rooms")
            .update({ sale_note: r.saleNote }).eq("id", r.id).select("id,sale_note").single();
          if (error) throw error;
          requireAccountWriteReceipt(data, { id: r.id, sale_note: r.saleNote });
          saved.push(sheetKey.policy(r.id));
        }
      } catch (error) {
        throw new RoomListSheetSaveError(saved, total, error);
      }
      return saved;
    },
    onSettled: () => {
      for (const key of ["my-available-rooms", "buildings", "rooms"]) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}
