// Hai công thức của "Báo chi nhanh" nằm trong database, dùng chung với Hermes (quy tắc 17/10; Đợt 2 Thu chi Mốc 6,
// docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 4.2–4.3 và 22):
//   public.ie_category_suggest_v1(org, items, type, include_restricted) — gợi ý hạng mục (mã phí → luật chủ đặt / cụm "hay nói" →
//     cụm phí cố định → trùng chữ tên), thay suggestCategory/ruleMatch TypeScript đã xoá;
//   public.ie_default_cashbook_v1(org, building, last_used) — sổ mặc định của thẻ, thay pickDefaultAccount.
// File này chỉ là phần thuần của phía web: ghép thẻ hai lượt quanh một lần gọi RPC cho cả lô, và kiểm khuôn kết quả RPC
// (sai khuôn ⇒ coi như không gợi ý — đoán sai tệ hơn không đoán).

import type { CategoryRef, CategorySuggestion } from "./categorySuggest";

export type SuggestType = "income" | "expense";

export interface SuggestRequest {
  type: SuggestType;
  text: string;
  feeCategory: string | null;
}

/** Gợi ý hạng mục cho một câu — compose gọi đồng bộ; kết quả lấy từ lần gọi RPC của lượt trước. */
export type SuggestCategory = (type: SuggestType, text: string, feeCategory: string | null) => CategorySuggestion | null;

export type SuggestionMap = ReadonlyMap<string, CategorySuggestion | null>;

/** Hàm SQL nhận tối đa 100 câu mỗi lần gọi. */
export const SUGGEST_BATCH = 100;

const REASONS: ReadonlySet<string> = new Set(["fee_phrase", "provider_code", "rule", "rule_weak", "name_overlap"]);

export const suggestKey = (r: SuggestRequest): string => JSON.stringify([r.type, r.text, r.feeCategory]);

export const noSuggestion: SuggestCategory = () => null;

/**
 * Ghép thẻ hai lượt: lượt 1 chạy `run` để GOM các câu cần gợi ý (trả null cho mọi câu), gọi `load` một lần cho cả lô,
 * lượt 2 chạy lại `run` với kết quả. `run` phải thuần (compose): câu cần gợi ý không phụ thuộc kết quả gợi ý của câu khác.
 */
export async function composeWithSuggestions<T>(
  run: (suggest: SuggestCategory) => T,
  load: (requests: SuggestRequest[]) => Promise<SuggestionMap>,
): Promise<T> {
  const requests = new Map<string, SuggestRequest>();
  const first = run((type, text, feeCategory) => {
    const request = { type, text, feeCategory };
    requests.set(suggestKey(request), request);
    return null;
  });
  if (requests.size === 0) return first;
  const found = await load([...requests.values()]);
  return run((type, text, feeCategory) => found.get(suggestKey({ type, text, feeCategory })) ?? null);
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Kết quả ie_category_suggest_v1: mảng cùng độ dài với câu gửi đi, mỗi phần tử null hoặc {typeId, ruleKey, reason}.
 * Chỉ nhận hạng mục nằm trong danh sách dùng được của thẻ (`allowed`) và lý do đã biết; sai khuôn cả mảng ⇒ null.
 */
export function parseSuggestions(raw: unknown, count: number, allowed: ReadonlySet<string>): Array<CategorySuggestion | null> | null {
  if (!Array.isArray(raw) || raw.length !== count) return null;
  return raw.map((item: unknown) => {
    if (item === null || typeof item !== "object") return null;
    const { typeId, reason } = item as { typeId?: unknown; reason?: unknown };
    if (typeof typeId !== "string" || !allowed.has(typeId) || typeof reason !== "string" || !REASONS.has(reason)) return null;
    return { id: typeId, reason: reason as CategorySuggestion["reason"] };
  });
}

/** Hạng mục dùng được theo chiều thu/chi — đúng tập hàm SQL lọc (usableExpenseCategories). */
export function allowedCategoryIds(categories: readonly CategoryRef[], type: SuggestType): Set<string> {
  return new Set(categories.filter((c) => c.type === type).map((c) => c.id));
}

/** Kết quả ie_default_cashbook_v1: uuid sổ hoặc null; chỉ nhận sổ trong danh sách sổ đang giữ của công ty. */
export function parseCashbookId(raw: unknown, usable: ReadonlySet<string>): string | null {
  return typeof raw === "string" && usable.has(raw) ? raw : null;
}

/** Khoá bảng sổ mặc định theo toà; thẻ chưa có toà dùng khoá rỗng. */
export const cashbookKey = (buildingId: string | null): string => buildingId ?? "";
