import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { requireAccountWriteReceipt } from "@/lib/accountSettingsWriteReceipt";
import type { TablesUpdate } from "@/integrations/supabase/types";
import type { RoomChange, RoomField, SheetChanges } from "@/components/sale-phong/roomListSheetDraft";

/** Khoá ô trong bản nháp: `phone:<buildingId>` / `policy:<roomId>` / `<price|type|amenities|status>:<roomId>`. */
export const sheetKey = {
  phone: (id: string) => `phone:${id}`,
  policy: (id: string) => `policy:${id}`,
  field: (field: RoomField, id: string) => `${field}:${id}`,
};

/** Lỗi giữa chừng: biết ô nào ĐÃ ghi để bỏ khỏi bản nháp, giữ ô chưa ghi để lưu lại. */
export class RoomListSheetSaveError extends Error {
  constructor(readonly savedKeys: string[], readonly total: number, readonly failure: unknown) {
    super(`Mới lưu ${savedKeys.length}/${total} ô của bảng phòng trống.`);
    this.name = "RoomListSheetSaveError";
  }
}

type RoomPatch = TablesUpdate<"rooms">;
const ROOM_SELECT = "id,sale_note,rent_price,area,room_type,amenities,sale_status_note,sale_status_note_key";

/** Cột của rooms + khoá ô bản nháp cho từng trường thay đổi. */
const ROOM_COLUMNS: { [K in Exclude<keyof RoomChange, "id">]-?: { column: keyof RoomPatch; key: (id: string) => string } } = {
  saleNote: { column: "sale_note", key: sheetKey.policy },
  rentPrice: { column: "rent_price", key: (id) => sheetKey.field("price", id) },
  area: { column: "area", key: (id) => sheetKey.field("type", id) },
  roomType: { column: "room_type", key: (id) => sheetKey.field("type", id) },
  amenities: { column: "amenities", key: (id) => sheetKey.field("amenities", id) },
  saleStatusNote: { column: "sale_status_note", key: (id) => sheetKey.field("status", id) },
  saleStatusKey: { column: "sale_status_note_key", key: (id) => sheetKey.field("status", id) },
};

/** Số ô của bảng mà lần lưu này đụng tới (một ô Loại phòng có thể ghi cả diện tích lẫn loại). */
export function sheetCellKeys(changes: SheetChanges): string[] {
  const keys = new Set(changes.buildings.map((b) => sheetKey.phone(b.id)));
  for (const r of changes.rooms) {
    for (const [field, spec] of Object.entries(ROOM_COLUMNS)) {
      if (r[field as keyof RoomChange] !== undefined) keys.add(spec.key(r.id));
    }
  }
  return [...keys];
}

/**
 * Ghi các ô của bảng phòng trống: SĐT riêng tòa (buildings.public_contact_phone)
 * và các ô của phòng — chính sách sale (sale_note), giá (rent_price), loại phòng
 * (area + room_type), nội thất (amenities) và tình trạng gõ tay (sale_status_note + khoá
 * tình trạng tự tính lúc gõ, để chữ tự hết hiệu lực khi tình trạng đổi).
 * Mỗi tòa/phòng một lệnh, đối chiếu biên nhận; trả về các khoá ô đã xác nhận.
 */
export function useSaveRoomListSheet() {
  const qc = useQueryClient();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (changes: SheetChanges): Promise<string[]> => {
      const saved: string[] = [];
      const total = sheetCellKeys(changes).length;
      try {
        for (const b of changes.buildings) {
          const { data, error } = await supabase.from("buildings")
            .update({ public_contact_phone: b.phone }).eq("id", b.id).select("id,public_contact_phone").single();
          if (error) throw error;
          requireAccountWriteReceipt(data, { id: b.id, public_contact_phone: b.phone });
          saved.push(sheetKey.phone(b.id));
        }
        for (const r of changes.rooms) {
          const patch: Record<string, unknown> = {};
          const keys = new Set<string>();
          for (const [field, spec] of Object.entries(ROOM_COLUMNS)) {
            const value = r[field as keyof RoomChange];
            if (value === undefined) continue;
            patch[spec.column] = value;
            keys.add(spec.key(r.id));
          }
          if (!keys.size) continue;
          const { data, error } = await supabase.from("rooms")
            .update(patch as RoomPatch).eq("id", r.id).select(ROOM_SELECT).single();
          if (error) throw error;
          requireAccountWriteReceipt(data, { id: r.id, ...patch });
          saved.push(...keys);
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
