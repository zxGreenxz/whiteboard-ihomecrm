// Tên thường gọi của toà (bảng building_common_names) — "Lê Văn Thọ", "một lẻ hai Lê Văn Thọ".
// RLS chỉ trả tên của toà người dùng xem được (can_access_building); lọc thêm đúng công ty đang chọn.
// Dùng cho bộ dò toà đọc bằng lời của Báo chi nhanh (src/lib/quickEntry/spokenBuilding.ts).

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";

/** building_id ⇒ các tên thường gọi (theo thứ tự thêm). */
export type BuildingCommonNames = ReadonlyMap<string, readonly string[]>;

/** Kiểm dạng kết quả tại biên: không phải danh sách {building_id, name} chuỗi ⇒ lỗi, không coi như rỗng. */
export function groupCommonNames(rows: unknown): BuildingCommonNames {
  if (!Array.isArray(rows)) throw new Error("Danh sách tên thường gọi của toà không hợp lệ.");
  const out = new Map<string, string[]>();
  for (const r of rows as Array<{ building_id?: unknown; name?: unknown }>) {
    if (typeof r?.building_id !== "string" || typeof r?.name !== "string") {
      throw new Error("Danh sách tên thường gọi của toà không hợp lệ.");
    }
    const list = out.get(r.building_id);
    if (list) list.push(r.name);
    else out.set(r.building_id, [r.name]);
  }
  return out;
}

export function useBuildingCommonNames(opts: { enabled: boolean }) {
  const { selectedOrganizationId: orgId } = useOrganization();
  return useQuery({
    queryKey: ["building-common-names", orgId],
    enabled: opts.enabled && !!orgId,
    // Tên thường gọi gần như không đổi trong phiên.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<BuildingCommonNames> => {
      const { data, error } = await supabase
        .from("building_common_names")
        .select("building_id, name")
        .eq("organization_id", orgId ?? "")
        .order("created_at");
      if (error) throw error;
      return groupCommonNames(data);
    },
  });
}
