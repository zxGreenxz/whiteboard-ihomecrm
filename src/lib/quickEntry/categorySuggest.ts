// Hạng mục CHI cho trang "Báo chi nhanh": lọc danh sách dùng được và tìm cho ô chọn. Đoán hạng mục
// từ mô tả nằm ở hàm SQL dùng chung với Hermes public.ie_category_suggest_v1 (cùng bộ lọc dưới đây;
// gọi qua sharedRules.ts) — bản TypeScript cũ (categoryRules.ts / suggestCategory) đã xoá ở Mốc 6.
//
// Lọc trước khi gửi bất cứ đâu (ô chọn, AI): đúng công ty đang chọn (RLS bảng hạng mục lộ
// hạng mục của org khác), bỏ `system_only` (máy chủ chặn lập tay), bỏ hạng mục hạn chế khi thiếu
// `restricted_create`, và theo danh mục chi chuẩn 03/10/2026: bỏ mục đã lưu trữ (`archived_at`),
// mục ẩn khỏi ô chọn tay (`manual_hidden`) và mục ẩn riêng khỏi Báo chi nhanh (`quick_entry_hidden`).
// Thứ tự = thứ tự danh mục (`sort_order`) — cũng là thứ tự mã cN gửi AI.

import { normalizeLoose } from "../textMatch";
import { sortIeTypesForPicker } from "../ieTypeCatalog";

export interface CategoryRef {
  id: string;
  name: string;
  category: string | null;
  type: "income" | "expense";
  organization_id?: string | null;
  is_restricted?: boolean | null;
  system_only?: boolean | null;
  /** Khoá phí cố định (tien_nha, dien, nuoc, …) — duy nhất mỗi org từ 26/09/2026. */
  fee_category?: string | null;
  /** "Dùng cho" — giải thích gửi AI để phân biệt các mục gần nhau. */
  description?: string | null;
  /** Cụm từ hay nói — lớp luật + gợi ý AI. */
  keywords?: string[] | null;
  /** Mã ổn định cho luật chọn hạng mục (ie_category_suggest_v1). */
  rule_key?: string | null;
  archived_at?: string | null;
  manual_hidden?: boolean | null;
  quick_entry_hidden?: boolean | null;
  sort_order?: number | null;
  /** Hạng mục cọc ⇒ thẻ phải chọn phòng (depositRoomRule.ts). */
  is_deposit?: boolean | null;
}

/** Kết quả một câu của ie_category_suggest_v1 (đã kiểm khuôn ở sharedRules.parseSuggestions). */
export interface CategorySuggestion {
  id: string;
  /**
   * Đoán yếu — thẻ không khoá ô hạng mục, AI được thay. `name_overlap` (trùng chữ, hạng mục thường) vẫn điền
   * sẵn; `rule_weak` (đoán vào hạng mục dòng tiền) KHÔNG điền sẵn — AI chọn, không thì người dùng chọn.
   */
  reason: "fee_phrase" | "provider_code" | "rule" | "rule_weak" | "name_overlap";
}

export function usableExpenseCategories(
  rows: CategoryRef[],
  opts: { organizationId: string; canUseRestricted: boolean; type?: 'income'|'expense' },
): CategoryRef[] {
  return sortIeTypesForPicker(
    rows.filter(
      (r) =>
        r.type === (opts.type ?? "expense") &&
        r.organization_id === opts.organizationId &&
        !r.system_only &&
        !r.archived_at &&
        !r.manual_hidden &&
        !r.quick_entry_hidden &&
        (opts.canUseRestricted || !r.is_restricted),
    ),
  );
}

/** Ô chọn: tên bắt đầu bằng > tên chứa > nhóm chứa; cùng hạng xếp theo tên tiếng Việt. */
export function searchCategories(rows: CategoryRef[], query: string, limit = 8): CategoryRef[] {
  const q = normalizeLoose(query);
  if (!q) return rows.slice(0, limit);
  return rows
    .map((r) => {
      const name = normalizeLoose(r.name);
      const group = normalizeLoose(r.category ?? "");
      const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : group.includes(q) ? 2 : -1;
      return { r, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.r.name.localeCompare(b.r.name, "vi", { sensitivity: "base" }))
    .slice(0, limit)
    .map((x) => x.r);
}
