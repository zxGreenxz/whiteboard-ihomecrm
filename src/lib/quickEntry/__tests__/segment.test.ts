import { describe, it, expect } from "vitest";
import { segmentMessage } from "../segment";
import { normalizeForParse } from "../amount";

// [đoạn chữ, số tiền] — mong đợi viết tay.
const parts = (text: string) => segmentMessage(text).map((s) => [s.text, s.amount?.value ?? null]);

describe("segmentMessage — tách theo dấu ngăn", () => {
  it.each([
    ["bóng đèn 60k, ống nước 80k"],
    ["bóng đèn 60k; ống nước 80k"],
    ["bóng đèn 60k\nống nước 80k"],
    ["bóng đèn 60k + ống nước 80k"],
    ["bóng đèn 60k và ống nước 80k"],
  ])("%j → hai khoản", (text) => {
    expect(parts(text)).toEqual([
      ["bóng đèn 60k", 60_000],
      ["ống nước 80k", 80_000],
    ]);
  });

  it("dấu phẩy giữa hai chữ số là số thập phân, không tách", () => {
    expect(parts("1,2tr tiền điện")).toEqual([["1,2tr tiền điện", 1_200_000]]);
  });

  it("đoạn không có số tiền nhập vào đoạn liền trước", () => {
    expect(parts("mua sơn 300k, hôm qua")).toEqual([["mua sơn 300k, hôm qua", 300_000]]);
  });

  it("đoạn đầu không có số tiền nhập vào đoạn có tiền liền sau", () => {
    expect(parts("điện và nước 500k")).toEqual([["điện và nước 500k", 500_000]]);
  });

  it("cả câu không có số tiền ⇒ một khoản chưa có tiền", () => {
    expect(parts("ăn trưa với khách")).toEqual([["ăn trưa với khách", null]]);
  });

  it("chuỗi rỗng ⇒ không khoản nào", () => {
    expect(segmentMessage("   ")).toEqual([]);
  });
});

describe("segmentMessage — câu nói liền không dấu ngăn", () => {
  it("mô tả trước tiền sau ⇒ cắt SAU mỗi số tiền", () => {
    expect(parts("bóng đèn 60k ống nước 80k")).toEqual([
      ["bóng đèn 60k", 60_000],
      ["ống nước 80k", 80_000],
    ]);
  });

  it("bản chữ giọng nói: số đọc bằng chữ", () => {
    expect(parts("bóng đèn sáu mươi nghìn ống nước tám mươi nghìn")).toEqual([
      ["bóng đèn sáu mươi nghìn", 60_000],
      ["ống nước tám mươi nghìn", 80_000],
    ]);
  });

  it("tiền trước mô tả sau ⇒ cắt TRƯỚC mỗi số tiền tiếp theo", () => {
    expect(parts("60k bóng đèn 80k ống nước")).toEqual([
      ["60k bóng đèn", 60_000],
      ["80k ống nước", 80_000],
    ]);
  });

  it("có chữ 'tổng' ⇒ một khoản, lấy số tổng, không báo mơ hồ", () => {
    const segs = segmentMessage("mua 2 bóng mỗi cái 60k tổng 120k");
    expect(segs.map((s) => [s.text, s.amount?.value])).toEqual([["mua 2 bóng mỗi cái 60k tổng 120k", 120_000]]);
    expect(segs[0].amount?.ambiguous).toBe(false);
  });

  it("đoạn MỞ ĐẦU bằng 'tổng' sau dấu ngăn là dòng tổng để đối chiếu, không phải một khoản", () => {
    const segs = segmentMessage("sơn 300k, keo 20k, tổng 320k");
    expect(segs.map((s) => [s.amount?.value, s.isTotal])).toEqual([
      [300_000, false],
      [20_000, false],
      [320_000, true],
    ]);
    expect(segmentMessage("bóng đèn 60k\ntổng cộng: 60k").map((s) => s.isTotal)).toEqual([false, true]);
    expect(segmentMessage("tất cả 90k; cảm ơn").map((s) => s.isTotal)).toEqual([true]);
  });

  it("số trần không dùng để cắt khoản (dễ là số lượng)", () => {
    expect(parts("mua 2 đèn 120")).toEqual([["mua 2 đèn 120", 120_000]]);
  });

  it("dấu chấm cuối câu không dính vào mô tả", () => {
    expect(parts("mua sơn 300k.")).toEqual([["mua sơn 300k", 300_000]]);
  });

  it("giọng nói nối bằng 'và'", () => {
    expect(parts("một trăm hai mươi nghìn tiền điện và năm mươi nghìn tiền nước")).toEqual([
      ["một trăm hai mươi nghìn tiền điện", 120_000],
      ["năm mươi nghìn tiền nước", 50_000],
    ]);
  });
});

describe("segmentMessage — vị trí", () => {
  it("textStart/textEnd chỉ đúng đoạn trên chuỗi đã chuẩn hoá", () => {
    const text = "Bóng Đèn 60K, ống nước 80k";
    const norm = normalizeForParse(text);
    expect(segmentMessage(text).map((s) => norm.slice(s.textStart, s.textEnd))).toEqual([
      "bóng đèn 60k",
      "ống nước 80k",
    ]);
  });

  it("vị trí số tiền của từng khoản tính trên CẢ tin nhắn (để tô sáng)", () => {
    const text = "Bóng Đèn 60K, ống nước 80k";
    const norm = normalizeForParse(text);
    const spans = segmentMessage(text).map((s) => s.amount && norm.slice(s.amount.candidate.start, s.amount.candidate.end));
    expect(spans).toEqual(["60k", "80k"]);
  });
});
