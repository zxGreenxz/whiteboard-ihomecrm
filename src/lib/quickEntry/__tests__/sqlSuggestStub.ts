// Đứng thay hàm SQL ie_category_suggest_v1 trong test vitest (không có PostgreSQL): bảng kết quả theo (danh sách hạng mục dùng
// được, chiều thu/chi, câu, mã phí). Bảng fixtures/goi-y-hang-muc-test.json khoá bằng infra/hermes-broker/ie-quick-entry-rules-sql.test.mjs
// (chạy đúng hàm SQL trên PostgreSQL 17 với cùng danh sách hạng mục) ⇒ test compose/feed dùng đúng kết quả của database.
// Câu không có trong bảng ⇒ ném lỗi (thêm câu thì thêm dòng vào bảng và để test SQL kiểm).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CategoryRef, CategorySuggestion } from "../categorySuggest";
import { suggestKey, type SuggestCategory, type SuggestRequest, type SuggestType, type SuggestionMap } from "../sharedRules";

interface StubCase { rowset: number; type: SuggestType; text: string; fee: string | null; out: CategorySuggestion | null }
interface StubTable { rowsets: CategoryRef[][]; cases: StubCase[] }

const TABLE = resolve(__dirname, "fixtures/goi-y-hang-muc-test.json");

let table: StubTable | null = null;
const load = (): StubTable => (table ??= JSON.parse(readFileSync(TABLE, "utf8")) as StubTable);
const rowsKey = (rows: readonly CategoryRef[]): string => JSON.stringify(rows);

export function stubSuggest(categories: readonly CategoryRef[]): SuggestCategory {
  return (type, text, feeCategory) => {
    const rows = categories.filter((c) => c.type === type);
    const t = load();
    const key = rowsKey(rows);
    const hit = t.cases.find((c) => c.type === type && c.text === text && c.fee === feeCategory && rowsKey(t.rowsets[c.rowset]) === key);
    if (!hit) throw new Error(`sqlSuggestStub: chưa có câu trong bảng: ${JSON.stringify({ type, text, fee: feeCategory })}`);
    return hit.out;
  };
}

/** Như refs.suggestCategories của hook: một lần "gọi RPC" cho cả lô câu. */
export function stubLoadSuggestions(categories: readonly CategoryRef[]): (requests: SuggestRequest[]) => Promise<SuggestionMap> {
  const suggest = stubSuggest(categories);
  return async (requests) => new Map(requests.map((r) => [suggestKey(r), suggest(r.type, r.text, r.feeCategory)]));
}
