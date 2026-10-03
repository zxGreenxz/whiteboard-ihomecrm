// Hạng mục CHI cho trang "Báo chi nhanh": lọc danh sách dùng được, tìm cho ô chọn, và đoán
// thận trọng từ mô tả. Đoán sai thì tệ hơn không đoán — không chắc thì trả null để AI hoặc
// người dùng chọn.
//
// Lọc trước khi gửi bất cứ đâu (ô chọn, AI): đúng công ty đang chọn (RLS bảng hạng mục lộ
// hạng mục của org khác), bỏ `system_only` (máy chủ chặn lập tay), bỏ hạng mục hạn chế khi thiếu
// `restricted_create`, và theo danh mục chi chuẩn 03/10/2026: bỏ mục đã lưu trữ (`archived_at`),
// mục ẩn khỏi ô chọn tay (`manual_hidden`) và mục ẩn riêng khỏi Báo chi nhanh (`quick_entry_hidden`).
// Thứ tự = thứ tự danh mục (`sort_order`) — cũng là thứ tự mã cN gửi AI.

import { normalizeLoose } from "../textMatch";
import { FIXED_EXPENSE_CATEGORIES, nrm } from "../fixedExpenseCategories";
import { sortIeTypesForPicker } from "../ieTypeCatalog";
import { blockedFor, ruleMatch } from "./categoryRules";

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
  /** Mã ổn định cho luật chọn hạng mục (categoryRules.ts). */
  rule_key?: string | null;
  archived_at?: string | null;
  manual_hidden?: boolean | null;
  quick_entry_hidden?: boolean | null;
  sort_order?: number | null;
}

/** Hạng mục dòng tiền (không phải chi phí thường): đoán yếu vào đây thì không điền sẵn. */
const MONEY_FLOW = new Set(["noi_bo", "bo_sung_hoan_coc", "tra_tien_thua_khach", "chia_loi_nhuan"]);

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
  opts: { organizationId: string; canUseRestricted: boolean },
): CategoryRef[] {
  return sortIeTypesForPicker(
    rows.filter(
      (r) =>
        r.type === "expense" &&
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

/**
 * Cụm từ chắc chắn là KHOẢN PHÍ cố định (so không dấu). Cố ý hẹp: "sửa điện" là sửa chữa,
 * không phải tiền điện; chỉ "tiền điện", "hoá đơn điện", "điện tháng/kỳ" mới là phí điện.
 */
const FEE_PHRASES: Array<[string, RegExp]> = [
  ["tien_nha", /\b(?:tien nha|thue nha|tien thue nha)\b/],
  // "tiền điện lạnh" (thợ điện lạnh) KHÔNG phải tiền điện.
  ["dien", /\b(?:tien dien(?! lanh)|hoa don dien|dien thang|dien ky|evn)\b/],
  ["nuoc", /\b(?:tien nuoc|hoa don nuoc|nuoc thang|nuoc ky|cap nuoc)\b/],
  ["internet", /\b(?:internet|wifi|cuoc mang|tien mang)\b/],
  ["quan_ly", /\b(?:phi quan ly|tien quan ly)\b/],
  ["ve_sinh", /\b(?:tien ve sinh|ve sinh toa nha)\b/],
  ["cong_an", /\b(?:tien cong an)\b/],
  ["rac", /\b(?:tien rac|phi rac|thu gom rac)\b/],
  ["thang_may", /\b(?:thang may)\b/],
];

/** Từ quá chung, không giúp phân biệt hạng mục. */
const STOPWORDS = new Set([
  "tien", "mua", "cho", "phong", "toa", "nha", "va", "cai", "cua", "o", "bi", "lai", "moi", "cac", "nhung",
  "the", "nay", "do", "kia", "hom", "qua", "ngay", "thang", "nam", "k", "tr", "trieu", "nghin", "ngan", "dong",
]);

const wordsOf = (s: string): string[] =>
  normalizeLoose(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

/** Hạng mục mang khoá phí: ưu tiên cột fee_category, rồi luật khớp của báo cáo lợi nhuận. */
function categoryForFee(rows: CategoryRef[], feeKey: string): CategoryRef | null {
  const tagged = rows.filter((r) => r.fee_category === feeKey);
  if (tagged.length === 1) return tagged[0];
  if (tagged.length > 1) return null;
  const rule = FIXED_EXPENSE_CATEGORIES.find((f) => f.key === feeKey);
  if (!rule) return null;
  const matched = rows.filter((r) => rule.match(nrm(r.category), nrm(r.name)));
  return matched.length === 1 ? matched[0] : null;
}

export function suggestCategory(
  rows: CategoryRef[],
  description: string,
  opts: { feeCategory?: string | null } = {},
): CategorySuggestion | null {
  if (opts.feeCategory) {
    const hit = categoryForFee(rows, opts.feeCategory);
    if (hit) return { id: hit.id, reason: "provider_code" };
  }

  // Luật chủ đặt + cụm "hay nói" (categoryRules.ts) — xét trước cụm phí để "chuyển tiền nhà dùm"
  // vào Chuyển tiền nội bộ chứ không vào Tiền nhà.
  const ruled = ruleMatch(rows, description);
  if (ruled) return { id: ruled.ref.id, reason: ruled.strong ? "rule" : "rule_weak" };

  const loose = normalizeLoose(description);
  for (const [feeKey, re] of FEE_PHRASES) {
    if (!re.test(loose)) continue;
    // "trả cọc thuê nhà mới" là tiền cọc thu hồi được, không phải tiền nhà tháng; cùng loại trừ với lớp
    // luật ("in giấy hợp đồng thuê nhà", "mua keo nút thang máy" không phải phí cố định).
    if (feeKey === "tien_nha" && /\bcoc\b/.test(loose)) continue;
    if (blockedFor(feeKey, description)) continue;
    const hit = categoryForFee(rows, feeKey);
    if (hit) return { id: hit.id, reason: "fee_phrase" };
  }

  const words = new Set(wordsOf(description));
  if (words.size === 0) return null;
  let best: CategoryRef | null = null;
  let bestScore = 0;
  let tie = false;
  for (const r of rows) {
    const score = wordsOf(r.name).filter((w) => words.has(w)).length;
    if (score > bestScore) {
      best = r;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }
  if (!best || tie) return null;
  // Trùng chữ vào hạng mục DÒNG TIỀN ("bổ sung tiền mua đồ" ⇒ Bổ sung hoàn cọc, "tiền nội bộ" ⇒ nội bộ) xử
  // như gợi ý yếu của luật: không điền sẵn — lưu nhầm là khoản chi biến khỏi KQKD / lọt khu rà soát hoàn khách.
  return { id: best.id, reason: best.rule_key && MONEY_FLOW.has(best.rule_key) ? "rule_weak" : "name_overlap" };
}
