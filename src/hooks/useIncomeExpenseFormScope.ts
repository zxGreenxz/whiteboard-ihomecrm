import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { compareBuildingThenRoom } from "@/lib/roomSort";

// =============================================================
// Nguồn dữ liệu TOÀ / PHÒNG riêng cho form Thu chi.
//
// Khác với useBuildings/useRooms (đọc thẳng bảng → RLS chỉ trả toà quản lý),
// hai hook này gọi RPC SECURITY DEFINER ie_form_buildings()/ie_form_rooms():
//   - Mặc định: chỉ toà/phòng caller quản lý (giống RLS hiện tại).
//   - Nếu caller có quyền income_expenses.all_buildings → trả thêm MỌI toà/phòng
//     của chủ, CHỈ trong phạm vi form thu chi (không nới các module khác).
// Cờ `managed` cho biết toà thuộc quyền quản lý → FE xếp lên đầu.
// =============================================================

export interface IeFormBuilding {
  id: string;
  name: string;
  code: string | null;
  is_virtual: boolean;
  user_id: string;
  /** true = toà caller quản lý (xếp lên đầu); false = toà mở rộng qua quyền all_buildings. */
  managed: boolean;
}

export interface IeFormRoom {
  id: string;
  name: string;
  code: string | null;
  building_id: string;
  floor: number;
}

/** Toà cho dropdown form thu chi, đã sắp managed lên đầu rồi theo tên (vi). */
export const useIncomeExpenseFormBuildings = () =>
  useQuery({
    queryKey: ["ie-form-buildings"],
    queryFn: async () => {
      // RPC chưa có trong types generated → cast any.
      const { data, error } = await supabase.rpc("ie_form_buildings");
      if (error) {
        console.error("ie_form_buildings error:", error);
        return [] as IeFormBuilding[];
      }
      const rows = (data ?? []) as IeFormBuilding[];
      return [...rows].sort((a, b) => {
        if (a.managed !== b.managed) return a.managed ? -1 : 1;
        return a.name.localeCompare(b.name, "vi");
      });
    },
  });

/**
 * Phòng cho dropdown form thu chi.
 * @param buildingId  lọc theo 1 toà; bỏ trống + allWhenEmpty=true → mọi phòng (ô nhập nhanh).
 */
export const useIncomeExpenseFormRooms = (
  buildingId?: string,
  opts?: { allWhenEmpty?: boolean },
) => {
  // Chuẩn hoá: "" (falsy) → undefined để queryKey/enabled/RPC arg luôn nhất quán.
  const bid = buildingId || undefined;
  return useQuery({
    queryKey: ["ie-form-rooms", bid ?? (opts?.allWhenEmpty ? "__all__" : null)],
    enabled: !!bid || !!opts?.allWhenEmpty,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("ie_form_rooms", {
        _building_id: bid ?? null,
      });
      if (error) {
        console.error("ie_form_rooms error:", error);
        return [] as IeFormRoom[];
      }
      const rows = (data ?? []) as IeFormRoom[];
      // Cùng kiểu sắp xếp với useRooms (MB* → G* → L* → 1,2,3…). Trong 1 toà tên
      // toà không đổi nên thực chất so theo tên phòng.
      return [...rows].sort((a, b) =>
        compareBuildingThenRoom("", a.name ?? "", "", b.name ?? ""),
      );
    },
  });
};
