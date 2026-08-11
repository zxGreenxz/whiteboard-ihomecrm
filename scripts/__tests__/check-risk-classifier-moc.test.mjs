// Sổ cho phần CHỌN MỐC của scripts/check-risk-classifier.mjs.
//
// Điểm mù đã đo 11/08/2026: bản đầu luôn lấy `merge-base(origin/main, HEAD)`.
// Trên một PR thì đúng. Nhưng trên PUSH VÀO MAIN, origin/main CHÍNH LÀ HEAD nên
// merge-base = HEAD và diff luôn rỗng — gate chạy trong ci-gates mỗi lần push,
// in "0 file đổi", và chưa từng phân loại một thay đổi nào trên main.
//
// Không phải gate thiếu. Gate có, chạy, xanh, và báo sai. Bộ ca dưới đây tồn tại
// để nhánh dự phòng không lặng lẽ biến mất.
import { describe, expect, it } from "vitest";

import { chonMoc } from "../check-risk-classifier.mjs";

/** Dựng một `diff` giả: bản đồ range → danh sách file, kèm merge-base và head. */
const dungDiff = ({ ranges = {}, mergeBase = null, head = "HEAD_SHA" }) => {
  const fn = (range) => ranges[range] ?? [];
  fn.mergeBase = () => mergeBase;
  fn.head = () => head;
  return fn;
};

describe("chonMoc", () => {
  const coTatCa = () => true;

  it("--base được ưu tiên tuyệt đối", () => {
    const kq = chonMoc(["--base", "abc123"], coTatCa, dungDiff({ ranges: { "abc123..HEAD": ["a.ts"] } }));
    expect(kq.nhan).toContain("abc123");
    expect(kq.files).toEqual(["a.ts"]);
  });

  it("--base trỏ ref không tồn tại ⇒ null, KHÔNG âm thầm rơi về mốc khác", () => {
    // Rơi về mốc khác sẽ trả một kết quả trông hợp lệ cho một câu hỏi khác hẳn.
    expect(chonMoc(["--base", "khong-co"], () => false, dungDiff({}))).toBeNull();
  });

  it("HEAD ĐÃ tách khỏi origin/main ⇒ dùng merge-base (đường của PR)", () => {
    const kq = chonMoc([], coTatCa, dungDiff({ mergeBase: "BASE_SHA", ranges: { "BASE_SHA..HEAD": ["x.ts", "y.sql"] } }));
    expect(kq.nhan).toContain("merge-base");
    expect(kq.files).toEqual(["x.ts", "y.sql"]);
  });

  it("merge-base BẰNG HEAD ⇒ KHÔNG dùng nó, rơi về HEAD~1 (đường của push vào main)", () => {
    // Đây là ca đã hỏng suốt: merge-base = HEAD ⇒ diff rỗng ⇒ "0 file đổi".
    const kq = chonMoc([], coTatCa, dungDiff({ mergeBase: "HEAD_SHA", head: "HEAD_SHA", ranges: { "HEAD~1..HEAD": ["m.sql"] } }));
    expect(kq.nhan).toContain("HEAD~1");
    expect(kq.files).toEqual(["m.sql"]);
  });

  it("không có origin/main lẫn main ⇒ vẫn dùng được HEAD~1", () => {
    const coRef = (r) => r === "HEAD~1";
    const kq = chonMoc([], coRef, dungDiff({ ranges: { "HEAD~1..HEAD": ["z.ts"] } }));
    expect(kq.nhan).toContain("HEAD~1");
  });

  it("commit đầu tiên của repo (không có HEAD~1) ⇒ null ⇒ gọi phía trên thoát 3", () => {
    // Trả mảng rỗng ở đây sẽ đọc thành "không có gì rủi ro". Phải là null.
    expect(chonMoc([], () => false, dungDiff({}))).toBeNull();
  });

  it("mọi nhánh đều KÈM nhãn mốc — báo cáo không nói rõ đã so với cái gì thì vô dụng", () => {
    for (const kq of [
      chonMoc(["--base", "r"], coTatCa, dungDiff({ ranges: { "r..HEAD": [] } })),
      chonMoc([], coTatCa, dungDiff({ mergeBase: "B", ranges: {} })),
      chonMoc([], (r) => r === "HEAD~1", dungDiff({ ranges: {} })),
    ]) {
      expect(kq?.nhan, "thiếu nhãn mốc").toBeTruthy();
    }
  });
});
