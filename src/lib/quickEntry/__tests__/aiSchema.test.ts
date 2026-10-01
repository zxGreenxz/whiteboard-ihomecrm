import { describe, it, expect } from "vitest";
import { extractJson, parseAiResult } from "../aiSchema";

const valid = {
  items: [{ desc: "bóng đèn LED", amount_vnd: 120_000, category: "c2", confidence: 0.9 }],
  total_vnd: 120_000,
  date: "2026-09-30",
  vendor: "Điện nước Minh Phát",
  building_mention: "102LVT",
  room_mention: "301",
  customer_code: null,
  period_start: null,
  period_end: null,
};

describe("extractJson", () => {
  it("JSON trần", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("bọc trong ```json … ``` và có chữ thừa hai đầu", () => {
    expect(extractJson('Đây là kết quả:\n```json\n{"a": {"b": 2}}\n```\nXong.')).toEqual({ a: { b: 2 } });
  });

  it("ngoặc nhọn nằm trong chuỗi không làm lệch ranh giới", () => {
    expect(extractJson('{"desc":"áo {size} L","n":1} thừa}')).toEqual({ desc: "áo {size} L", n: 1 });
  });

  it("ngoặc LẺ trong chuỗi (kể cả có dấu nháy thoát) không cắt sớm object", () => {
    expect(extractJson('{"desc":"ngoặc } lẻ \\" {","n":1}')).toEqual({ desc: 'ngoặc } lẻ " {', n: 1 });
  });

  it("không có JSON hoặc JSON hỏng ⇒ null", () => {
    expect(extractJson("Không đọc được ảnh")).toBeNull();
    expect(extractJson('{"a": 1,')).toBeNull();
  });
});

describe("parseAiResult", () => {
  it("kết quả đúng khuôn ⇒ ok", () => {
    const r = parseAiResult(JSON.stringify(valid), 5);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.items[0].amount_vnd).toBe(120_000);
  });

  it("thiếu khoá tuỳ chọn ⇒ mặc định null (mô hình hay bỏ trường rỗng)", () => {
    const r = parseAiResult(JSON.stringify({ items: [{ desc: "phở", amount_vnd: 50_000 }] }), 5);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.vendor).toBeNull();
      expect(r.value.items[0].category).toBeNull();
    }
  });

  it.each([
    ["khoá lạ ở gốc", { ...valid, tool_call: "x" }],
    ["khoá lạ trong dòng", { ...valid, items: [{ ...valid.items[0], hack: 1 }] }],
    ["chỉ số hạng mục ngoài danh sách", { ...valid, items: [{ ...valid.items[0], category: "c6" }] }],
    ["chỉ số hạng mục sai dạng", { ...valid, items: [{ ...valid.items[0], category: "Tiền điện" }] }],
    ["số tiền lẻ", { ...valid, items: [{ ...valid.items[0], amount_vnd: 1500.5 }] }],
    ["số tiền âm", { ...valid, total_vnd: -1 }],
    ["ngày sai dạng", { ...valid, date: "30/09/2026" }],
    ["quá 20 dòng", { ...valid, items: Array.from({ length: 21 }, () => valid.items[0]) }],
  ])("%s ⇒ invalid", (_name, payload) => {
    expect(parseAiResult(JSON.stringify(payload), 5)).toEqual({ ok: false, reason: "invalid" });
  });

  it("không có JSON ⇒ no_json", () => {
    expect(parseAiResult("xin lỗi, tôi không đọc được", 5)).toEqual({ ok: false, reason: "no_json" });
  });
});
