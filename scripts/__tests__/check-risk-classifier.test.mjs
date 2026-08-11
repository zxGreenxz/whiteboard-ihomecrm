// Sổ đột biến cho scripts/check-risk-classifier.mjs.
//
// Bộ ca "5 loại thay đổi" ở describe cuối chính là mục Đợt 2 (Verification) trong
// plan: khẳng định bộ phân loại chọn ĐÚNG tier và ĐÚNG tập gate cho từng loại.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { globSangRegex, khopGlob, phanLoai, xepTier } from "../check-risk-classifier.mjs";

const { tiers, notes } = JSON.parse(readFileSync(new URL("../../tooling/risk-map.json", import.meta.url), "utf8"));

describe("globSangRegex — `**` phải xử trước `*`", () => {
  it("`**` khớp qua nhiều cấp thư mục", () => {
    expect(khopGlob("src/hooks/income-expenses/a/b/c.ts", "src/hooks/income-expenses/**")).toBe(true);
  });

  it("`**/` khớp cả khi KHÔNG có cấp nào ở giữa", () => {
    expect(khopGlob("a/b.ts", "a/**/b.ts")).toBe(true);
    expect(khopGlob("a/x/y/b.ts", "a/**/b.ts")).toBe(true);
  });

  it("`*` KHÔNG nuốt dấu gạch chéo — đây là chỗ dễ sai nhất", () => {
    expect(khopGlob("src/hooks/a/b.ts", "src/hooks/*.ts")).toBe(false);
    expect(khopGlob("src/hooks/a.ts", "src/hooks/*.ts")).toBe(true);
  });

  it("khớp mẫu có tiền tố như useCashBook*.ts", () => {
    expect(khopGlob("src/hooks/useCashBookEntries.ts", "src/hooks/useCashBook*.ts")).toBe(true);
    expect(khopGlob("src/hooks/useOther.ts", "src/hooks/useCashBook*.ts")).toBe(false);
  });

  it("dấu chấm là ký tự thường, không phải bất kỳ", () => {
    expect(globSangRegex("a.ts").test("axts")).toBe(false);
  });
});

describe("xepTier — lấy tier NGHIÊM NHẤT khớp được", () => {
  it("thứ tự khai trong risk-map.json là thứ tự nghiêm ngặt", () => {
    // Nếu ai đó xếp lại thứ tự trong file, phép "dừng ở tier đầu tiên khớp" đổi
    // nghĩa hoàn toàn. Ca này chốt kỳ vọng đó thành khẳng định.
    expect(Object.keys(tiers)[0]).toBe("money");
    expect(Object.keys(tiers).at(-1)).toBe("docs");
  });

  it("file không khớp tier nào trả null, không ném", () => {
    expect(xepTier("mot/duong/khong-ai-khai.txt", tiers)).toBeNull();
  });

  it("notes của risk-map nói rõ luật nghiêm-nhất — nếu câu đó mất thì luật này mồ côi", () => {
    expect(notes.join(" ")).toContain("NGHIÊM NHẤT");
  });
});

describe("BỘ CA 5 LOẠI THAY ĐỔI (Đợt 2 — Verification)", () => {
  const ca = (files) => phanLoai(files, tiers);

  it("(1) đụng TIỀN ⇒ tier money, cần soi chéo, có gate reconcile-money", () => {
    const r = ca(["src/hooks/useInvoices.ts"]);
    expect(r.nghiemNhat).toBe("money");
    expect(r.crossReview).toBe(true);
    expect(r.gates.join(" ")).toContain("reconcile-money");
  });

  it("(2) đụng PHÂN QUYỀN ⇒ tier authorization, gate có cross-tenant", () => {
    const r = ca(["src/lib/permissions.ts"]);
    expect(r.nghiemNhat).toBe("authorization");
    expect(r.crossReview).toBe(true);
    expect(r.gates.join(" ")).toContain("cross-tenant");
  });

  it("(3) đụng MIGRATION ⇒ tier migration, gate có catalog:check", () => {
    const r = ca(["supabase/migrations/001_extensions_and_enums.sql"]);
    expect(r.nghiemNhat).toBe("migration");
    expect(r.crossReview).toBe(true);
    expect(r.gates.join(" ")).toContain("catalog:check");
  });

  it("(4) chỉ đụng TÀI LIỆU ⇒ tier docs, KHÔNG cần soi chéo", () => {
    const r = ca(["docs/README.md"]);
    expect(r.nghiemNhat).toBe("docs");
    expect(r.crossReview).toBe(false);
  });

  it("(5) TRỘN tiền + tài liệu ⇒ nghiêm nhất là money, gate là HỢP của cả hai", () => {
    const r = ca(["src/hooks/useInvoices.ts", "docs/README.md"]);
    expect(r.nghiemNhat).toBe("money");
    expect(r.crossReview).toBe(true);
    // Hợp, không phải chỉ gate của tier nghiêm nhất: đổi tài liệu vẫn phải qua
    // gate tài liệu, kể cả khi cùng commit có đổi tiền.
    expect(r.gates.length).toBeGreaterThan(ca(["src/hooks/useInvoices.ts"]).gates.length);
  });

  it("file lạ vào `khongTier` chứ KHÔNG bị gán bừa vào docs", () => {
    const r = ca(["mot/duong/la.txt"]);
    expect(r.khongTier).toEqual(["mot/duong/la.txt"]);
    expect(r.nghiemNhat).toBeNull();
  });
});

describe("chống-xanh-rỗng", () => {
  it("risk-map có đủ 8 tier — thiếu thì mọi phép phân loại trên là vô nghĩa", () => {
    expect(Object.keys(tiers).length).toBe(8);
  });

  it("mọi tier đều khai gates và paths không rỗng", () => {
    for (const [ten, t] of Object.entries(tiers)) {
      expect(t.gates?.length, `${ten} phải có gate`).toBeGreaterThan(0);
      expect(t.paths?.length, `${ten} phải có path`).toBeGreaterThan(0);
      expect(typeof t.why, `${ten} phải giải thích vì sao`).toBe("string");
    }
  });
});
