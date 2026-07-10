// Data layer export Excel (Phase 9D) — phân trang QUA TOÀN BỘ dữ liệu bằng
// fetchAllRows (diệt bug cap-1000: bản cũ 1 query không .range → PostgREST cắt
// 1000 dòng đầu, file thiếu ÂM THẦM). Hard cap 50k dòng: chạm trần thì THROW
// (fetchAllRows fail-closed) → UI báo lỗi rõ, KHÔNG tạo file thiếu.
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import {
  EXPORT_DATASETS,
  type ExportEntity,
} from "@/lib/exportDatasetRegistry";

/** Trần export — vượt là throw (file quá lớn phải lọc bớt, không cắt im lặng). */
export const EXPORT_HARD_CAP = 50_000;

export interface ExportFilters {
  status?: string;
  building_id?: string;
  from_date?: string;
  to_date?: string;
  [k: string]: unknown;
}

export interface RunExportArgs {
  entity: ExportEntity;
  includeRelations: boolean;
  filters?: ExportFilters;
}

/**
 * Chạy export 1 entity: fetch phân trang đủ dữ liệu (RLS vẫn áp) → transform
 * theo registry → ghi file xlsx. Trả về số dòng đã xuất. Ném Error khi:
 * chưa đăng nhập / query lỗi / chạm hard cap.
 */
export async function runExportDataset({
  entity,
  includeRelations,
  filters = {},
}: RunExportArgs): Promise<number> {
  const user = await getSessionUser();
  if (!user) throw new Error("Not authenticated");

  const spec = EXPORT_DATASETS[entity];
  const select =
    includeRelations && spec.relationsSelect ? spec.relationsSelect : spec.baseSelect;

  const rows = await fetchAllRows<Record<string, unknown>>(
    (from, to) => {
      let q = supabase.from(spec.table as never).select(select) as unknown as {
        is: (c: string, v: null) => typeof q;
        eq: (c: string, v: unknown) => typeof q;
        gte: (c: string, v: unknown) => typeof q;
        lte: (c: string, v: unknown) => typeof q;
        order: (c: string, o?: { ascending: boolean }) => typeof q;
        range: (f: number, t: number) => PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
      };
      if (spec.softDelete) q = q.is("deleted_at", null);
      // Bộ lọc giữ y hành vi cũ (áp generic theo key có mặt).
      if (filters.status) q = q.eq("status", filters.status);
      if (filters.building_id) q = q.eq("building_id", filters.building_id);
      if (filters.from_date) q = q.gte("created_at", filters.from_date);
      if (filters.to_date) q = q.lte("created_at", filters.to_date);
      return q
        .order(spec.orderBy, { ascending: true })
        .order("id", { ascending: true }) // tiebreaker chống sót/trùng dòng ranh giới trang
        .range(from, to);
    },
    { hardCap: EXPORT_HARD_CAP, label: `export:${entity}` },
  );
  // fetchAllRows fail-closed: null = query lỗi → PHẢI throw, không coi là rỗng.
  if (rows === null) throw new Error("Tải dữ liệu export thất bại — thử lại sau.");

  const data = spec.transform ? spec.transform(rows) : rows;
  await spec.run(data as never[]);
  return data.length;
}
