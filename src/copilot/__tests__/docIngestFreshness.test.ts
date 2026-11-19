// Kiểm offline bộ lọc ngày review và danh sách tài liệu của registry Copilot lưu trữ.
import manifest from "@/../docs/he-thong/manifest.json";
import { describe, expect, it } from "vitest";

import { dauReviewConHieuLuc, listDocTopics } from "../tools/registry";

const NGAY = 86_400_000;
const MOC = new Date("2026-08-11T00:00:00Z").getTime();

describe("dauReviewConHieuLuc", () => {
  it("trong hạn ⇒ còn hiệu lực", () => {
    expect(dauReviewConHieuLuc("2026-07-20", 180, MOC)).toBe(true);
  });

  it("quá hạn ⇒ hết hiệu lực", () => {
    expect(dauReviewConHieuLuc("2025-01-01", 180, MOC)).toBe(false);
  });

  it("đúng ranh giới (bằng staleAfterDays) vẫn còn hiệu lực", () => {
    const reviewed = new Date(MOC - 180 * NGAY).toISOString().slice(0, 10);
    expect(dauReviewConHieuLuc(reviewed, 180, MOC)).toBe(true);
  });

  it("quá ranh giới một ngày ⇒ hết", () => {
    const reviewed = new Date(MOC - 181 * NGAY).toISOString().slice(0, 10);
    expect(dauReviewConHieuLuc(reviewed, 180, MOC)).toBe(false);
  });

  it("KHÔNG khai reviewed ⇒ còn dùng được (nợ có tên, không cắt ngầm)", () => {
    // 12/25 tài liệu chưa từng review. Loại chúng ở đây sẽ cắt hơn nửa kiến thức
    // Copilot trong im lặng — món nợ đó nằm ở manifest.unreviewedDebt và có gate
    // canh cho nó chỉ teo đi.
    expect(dauReviewConHieuLuc(undefined, 180, MOC)).toBe(true);
    expect(dauReviewConHieuLuc(null, 180, MOC)).toBe(true);
  });

  it("ngày HỎNG ⇒ còn dùng được, không im lặng bỏ tài liệu", () => {
    // Lỗi dữ liệu phải nổi lên ở gate manifest, không biến thành một tài liệu
    // biến mất mà không ai biết vì sao.
    expect(dauReviewConHieuLuc("khong-phai-ngay", 180, MOC)).toBe(true);
  });

  it("manifest không khai staleAfterDays ⇒ không lọc gì", () => {
    expect(dauReviewConHieuLuc("2000-01-01", undefined, MOC)).toBe(true);
  });
});

describe("listDocTopics lọc theo hạn review", () => {
  it("hôm nay KHÔNG tài liệu nào bị loại — bật luật không đổi hành vi", () => {
    const bayGio = listDocTopics(undefined, MOC).length;
    const khongLoc = listDocTopics(undefined, 0).length;
    expect(bayGio).toBe(khongLoc);
    expect(bayGio).toBeGreaterThan(0);
  });

  it("đẩy đồng hồ đi 10 năm ⇒ mọi tài liệu CÓ dấu review đều bị loại", () => {
    const xa = MOC + 3650 * NGAY;
    const con = listDocTopics(undefined, xa).map((t) => `${t.key}.md`);
    const coDau = new Set(
      manifest.entries.filter((e) => e.copilotIngest && e.reviewed).map((e) => e.file),
    );
    // Sàn chống-xanh-rỗng: ca này vô nghĩa nếu manifest không còn dấu review nào.
    expect(coDau.size).toBeGreaterThanOrEqual(10);
    for (const f of con) expect(coDau.has(f), `${f} lẽ ra phải bị loại`).toBe(false);
  });

  it("manifest kê đúng các tài liệu lưu trữ còn thiếu ngày review", () => {
    const chuaReview = manifest.entries.filter((e) => e.copilotIngest && !e.reviewed).map((e) => e.file);
    expect([...manifest.unreviewedDebt.files].sort()).toEqual(chuaReview.sort());
  });
});
