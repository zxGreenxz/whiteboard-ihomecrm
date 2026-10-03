// Ô danh mục chi chuẩn trong form Thêm/Sửa hạng mục (chỉ superadmin / chủ công ty thấy).
//
// Luật gửi: CHỈ gửi cột danh mục khi người dùng thật sự đổi nó. Môi trường chưa áp migration
// 20261003151606_danh_muc_chi_cau_truc không có các cột này — gửi cột lạ là hỏng cả lần lưu,
// kể cả khi người dùng chỉ sửa tên.
import type { IeTypeCatalogFields } from "@/lib/ieTypeCatalog";
import type { IncomeExpenseTypeCatalogUpdates } from "@/hooks/useIncomeExpenseTypes";
import { normalizeLoose } from "@/lib/textMatch";

/** Giá trị form của các ô danh mục (chuỗi thô như người dùng gõ). */
export interface IeTypeCatalogFormValues {
  keywords_text?: string;
  sort_order_text?: string;
  quick_entry_hidden?: boolean;
  archived?: boolean;
  merged_into_id?: string | null;
}

type CatalogSource = Pick<
  IeTypeCatalogFields,
  "keywords" | "sort_order" | "quick_entry_hidden" | "archived_at" | "merged_into_id"
>;

/** "a, b,, c" ⇒ ["a","b","c"]: tách dấu phẩy/xuống dòng, bỏ ô rỗng, bỏ trùng (không dấu). */
export function parseKeywordsText(text: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (text ?? "").split(/[,\n]/)) {
    const k = part.trim().replace(/\s+/g, " ");
    const key = normalizeLoose(k);
    if (!k || seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

export function keywordsToText(keywords: readonly string[] | null | undefined): string {
  return (keywords ?? []).join(", ");
}

/** Ô thứ tự: rỗng ⇒ null (xếp cuối theo tên); số nguyên ⇒ số; khác ⇒ NaN (form chặn trước). */
export function parseSortOrderText(text: string | null | undefined): number | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  return /^-?\d{1,9}$/.test(s) ? Number(s) : Number.NaN;
}

export function catalogFormDefaults(t?: CatalogSource | null): Required<IeTypeCatalogFormValues> {
  return {
    keywords_text: keywordsToText(t?.keywords),
    sort_order_text: t?.sort_order != null ? String(t.sort_order) : "",
    quick_entry_hidden: t?.quick_entry_hidden === true,
    archived: !!t?.archived_at,
    merged_into_id: t?.merged_into_id ?? null,
  };
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Cột danh mục cần gửi. `original` null = tạo mới (chỉ gửi ô đã điền, không lưu trữ/gộp);
 * có `original` = sửa (chỉ gửi ô khác giá trị đang lưu). `nowIso` là mốc lưu trữ khi bật.
 */
export function catalogUpdatesFromForm(
  values: IeTypeCatalogFormValues,
  original: CatalogSource | null,
  nowIso: string,
): IncomeExpenseTypeCatalogUpdates {
  const keywords = parseKeywordsText(values.keywords_text);
  const parsedSort = parseSortOrderText(values.sort_order_text);
  const sortOrder = parsedSort != null && Number.isFinite(parsedSort) ? parsedSort : null;
  const quickHidden = values.quick_entry_hidden === true;
  const out: IncomeExpenseTypeCatalogUpdates = {};

  if (!original) {
    if (keywords.length) out.keywords = keywords;
    if (sortOrder != null) out.sort_order = sortOrder;
    if (quickHidden) out.quick_entry_hidden = true;
    return out;
  }

  if (!sameList(keywords, original.keywords ?? [])) out.keywords = keywords;
  if (sortOrder !== (original.sort_order ?? null)) out.sort_order = sortOrder;
  if (quickHidden !== (original.quick_entry_hidden === true)) out.quick_entry_hidden = quickHidden;
  const archived = values.archived === true;
  if (archived !== !!original.archived_at) out.archived_at = archived ? nowIso : null;
  const mergedInto = values.merged_into_id || null;
  if (mergedInto !== (original.merged_into_id ?? null)) out.merged_into_id = mergedInto;
  return out;
}

/**
 * Đích "Gộp vào": cùng chiều thu/chi, đang dùng, chưa tự gộp vào mục khác, khác mục đang sửa
 * (gộp đúng một bậc — mirror ie_type_report_root_v1).
 */
export function mergeTargetCandidates<
  T extends Pick<IeTypeCatalogFields, "id" | "archived_at" | "merged_into_id"> & { type: string },
>(rows: readonly T[], current: { id: string; type: string }): T[] {
  return rows.filter(
    (t) => t.type === current.type && t.id !== current.id && !t.archived_at && !t.merged_into_id,
  );
}

/** Số hạng mục đang gộp VÀO mục này — có thì mục này không gộp tiếp được (một bậc). */
export function mergedSourceCount(
  rows: readonly Pick<IeTypeCatalogFields, "id" | "merged_into_id">[],
  id: string,
): number {
  return rows.filter((t) => t.merged_into_id === id && t.id !== id).length;
}
