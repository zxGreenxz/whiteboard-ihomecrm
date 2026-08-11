// Luật Copilot ingest, phần "dấu review còn hiệu lực" — thi hành ở RUNTIME.
//
// Vì sao răng nằm ở runtime chứ không ở CI: chú thích trong
// scripts/check-copilot-docs-manifest.mjs đã cân nhắc và kết luận đúng — một gate
// đỏ vì ngày tháng sẽ bị bump theo nghi thức rồi phá luôn tín hiệu. Ở runtime thì
// hậu quả khác hẳn: tài liệu quá hạn thôi được nạp, và người dùng thấy Copilot
// mất kiến thức đó. Phản hồi ấy khó lờ hơn một dòng cảnh báo trong log CI.
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

  it("manifest khai nợ review có tên và có hạn", () => {
    const no = (manifest as { unreviewedDebt?: { files: string[]; expiresAt: string } }).unreviewedDebt;
    expect(no?.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(no?.files.length).toBeGreaterThan(0);
    const chuaReview = manifest.entries.filter((e) => e.copilotIngest && !e.reviewed).map((e) => e.file);
    expect([...(no?.files ?? [])].sort()).toEqual([...chuaReview].sort());
  });
});
