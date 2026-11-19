import { describe, expect, it, vi } from "vitest";
import {
  SUGGEST_BATCH,
  allowedCategoryIds,
  cashbookKey,
  chunks,
  composeWithSuggestions,
  parseCashbookId,
  parseSuggestions,
  suggestKey,
  type SuggestRequest,
} from "../sharedRules";
import type { CategoryRef } from "../categorySuggest";

describe("composeWithSuggestions — ghép thẻ hai lượt quanh MỘT lần gọi hàm SQL", () => {
  it("lượt 1 gom câu (trùng câu chỉ gửi một lần), gọi load một lần, lượt 2 dùng kết quả", async () => {
    const load = vi.fn(async (requests: SuggestRequest[]) =>
      new Map(requests.map((r) => [suggestKey(r), r.text === "sơn tường" ? { id: "t-son", reason: "rule" as const } : null])));
    const out = await composeWithSuggestions(
      (suggest) => [suggest("expense", "sơn tường", null), suggest("expense", "sơn tường", null), suggest("income", "thu tiền phòng", null)],
      load,
    );
    expect(out).toEqual([{ id: "t-son", reason: "rule" }, { id: "t-son", reason: "rule" }, null]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toEqual([
      { type: "expense", text: "sơn tường", feeCategory: null },
      { type: "income", text: "thu tiền phòng", feeCategory: null },
    ]);
  });

  it("mã phí là một phần của câu hỏi; không câu nào cần gợi ý ⇒ không gọi load", async () => {
    const load = vi.fn(async () => new Map());
    expect(await composeWithSuggestions(() => "không gợi ý", load)).toBe("không gợi ý");
    expect(load).not.toHaveBeenCalled();
    expect(suggestKey({ type: "expense", text: "điện", feeCategory: "dien" })).not.toBe(suggestKey({ type: "expense", text: "điện", feeCategory: null }));
  });

  it("load không có câu ⇒ null (không đoán)", async () => {
    expect(await composeWithSuggestions((s) => s("expense", "x", null), async () => new Map())).toBeNull();
  });
});

describe("parseSuggestions — kiểm khuôn kết quả ie_category_suggest_v1", () => {
  const allowed = new Set(["a", "b"]);
  it("nhận {typeId, ruleKey, reason} trong danh sách dùng được, đúng lý do", () => {
    expect(parseSuggestions([{ typeId: "a", ruleKey: "k", reason: "rule_weak" }, null], 2, allowed)).toEqual([{ id: "a", reason: "rule_weak" }, null]);
  });
  it("hạng mục ngoài danh sách / lý do lạ / phần tử sai khuôn ⇒ null từng câu", () => {
    expect(parseSuggestions([{ typeId: "z", reason: "rule" }, { typeId: "a", reason: "ai" }, "a", { reason: "rule" }], 4, allowed))
      .toEqual([null, null, null, null]);
  });
  it("không phải mảng hoặc sai độ dài ⇒ null cả lô", () => {
    expect(parseSuggestions(null, 1, allowed)).toBeNull();
    expect(parseSuggestions({ typeId: "a" }, 1, allowed)).toBeNull();
    expect(parseSuggestions([null], 2, allowed)).toBeNull();
  });
  it("danh sách dùng được tách theo chiều thu/chi", () => {
    const rows: CategoryRef[] = [
      { id: "c", name: "Chi", category: null, type: "expense" },
      { id: "t", name: "Thu", category: null, type: "income" },
    ];
    expect([...allowedCategoryIds(rows, "expense")]).toEqual(["c"]);
    expect([...allowedCategoryIds(rows, "income")]).toEqual(["t"]);
  });
});

describe("sổ mặc định và chia lô", () => {
  it("ie_default_cashbook_v1: chỉ nhận sổ đang giữ của công ty; khoá theo toà, thẻ chưa có toà ⇒ khoá rỗng", () => {
    const usable = new Set(["s1"]);
    expect(parseCashbookId("s1", usable)).toBe("s1");
    expect(parseCashbookId("s9", usable)).toBeNull();
    expect(parseCashbookId(null, usable)).toBeNull();
    expect([cashbookKey(null), cashbookKey("b1")]).toEqual(["", "b1"]);
  });
  it("chia lô ≤ 100 câu (giới hạn của hàm SQL)", () => {
    expect(SUGGEST_BATCH).toBe(100);
    expect(chunks(Array.from({ length: 205 }, (_, i) => i), SUGGEST_BATCH).map((c) => c.length)).toEqual([100, 100, 5]);
    expect(chunks([], SUGGEST_BATCH)).toEqual([]);
  });
});
