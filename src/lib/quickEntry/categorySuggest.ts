// Hạng mục CHI cho trang "Báo chi nhanh": lọc danh sách dùng được, tìm cho ô chọn, và đoán
// thận trọng từ mô tả. Đoán sai thì tệ hơn không đoán — không chắc thì trả null để AI hoặc
// người dùng chọn.
//
// Lọc trước khi gửi bất cứ đâu (ô chọn, AI): đúng công ty đang chọn (RLS bảng hạng mục lộ
// hạng mục của org khác), bỏ `system_only` (writer v1 từ chối 0A000 rồi phiếu rơi im lặng sang
// đường compat luôn Chờ duyệt), bỏ hạng mục hạn chế khi thiếu `restricted_create`.

import { normalizeLoose } from "../textMatch";
import { FIXED_EXPENSE_CATEGORIES, nrm } from "../fixedExpenseCategories";

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
}

export interface CategorySuggestion {
  id: string;
  reason: "fee_phrase" | "provider_code" | "name_overlap";
}

export function usableExpenseCategories(
  rows: CategoryRef[],
  opts: { organizationId: string; canUseRestricted: boolean },
): CategoryRef[] {
  return rows.filter(
    (r) =>
      r.type === "expense" &&
      r.organization_id === opts.organizationId &&
      !r.system_only &&
      (opts.canUseRestricted || !r.is_restricted),
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
  ["dien", /\b(?:tien dien|hoa don dien|dien thang|dien ky|evn)\b/],
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

  const loose = normalizeLoose(description);
  for (const [feeKey, re] of FEE_PHRASES) {
    if (!re.test(loose)) continue;
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
  return best && !tie ? { id: best.id, reason: "name_overlap" } : null;
}
