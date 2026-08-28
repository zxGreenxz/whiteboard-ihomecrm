// Sổ cho phần CHỌN MỐC của check-forward-migration-idempotent (28/08/2026).
//
// Vì sao scoped: gate này dán mỗi migration HAI LẦN lên production (dry-run).
// Trước đây nó đo TOÀN BỘ file sau cutoff chưa có chứng nhận — migration của
// phiên A bị đem đo trong lượt CI do phiên B kích hoạt, và một file dở của A
// làm push của B đỏ. Với --tu-moc, chỉ file THÊM MỚI trong diff của push đó bị
// đo; file cũ đã có sổ chứng nhận sha256 + luật immutable che.
//
// Khuôn theo check-risk-classifier-moc.test.mjs: nhánh fallback phải TƯỜNG
// MINH — mốc hỏng mà lặng lẽ đo thiếu là gate mất tác dụng không ai hay; chiều
// an toàn là rơi về quét toàn bộ.
import { describe, expect, it } from "vitest";

import { giaiMoc, locTheoMoc } from "../check-forward-migration-idempotent.mjs";

describe("giaiMoc", () => {
  const coRef = (r) => r === "abc123";

  it("mốc hợp lệ ⇒ scoped", () => {
    expect(giaiMoc("abc123", coRef)).toEqual({ kieu: "scoped", moc: "abc123" });
  });

  it("không truyền mốc / rỗng ⇒ full, có lý do", () => {
    expect(giaiMoc(null, coRef).kieu).toBe("full");
    expect(giaiMoc("", coRef).kieu).toBe("full");
  });

  it("0000000000 (push đầu nhánh) ⇒ full — không có gì để diff", () => {
    const kq = giaiMoc("0000000000000000000000000000000000000000", coRef);
    expect(kq.kieu).toBe("full");
    expect(kq.lyDo).toBeTruthy();
  });

  it("mốc không tồn tại (force-push làm commit bị GC) ⇒ full, KHÔNG âm thầm đo thiếu", () => {
    const kq = giaiMoc("mat-tich", coRef);
    expect(kq.kieu).toBe("full");
    expect(kq.lyDo).toBeTruthy();
  });
});

describe("locTheoMoc", () => {
  const sauCutoff = ["20260828120000_a.sql", "20260828140000_b.sql", "20260828160000_c.sql"];

  it("chỉ giữ file sau cutoff CÓ MẶT trong diff (so theo tên file)", () => {
    const diff = ["supabase/migrations/20260828140000_b.sql"];
    expect(locTheoMoc(sauCutoff, diff)).toEqual(["20260828140000_b.sql"]);
  });

  it("diff không đụng migration ⇒ danh sách rỗng (exit 0 phía trên, có thông điệp)", () => {
    expect(locTheoMoc(sauCutoff, [])).toEqual([]);
  });

  it("đường dẫn diff dùng backslash Windows vẫn khớp", () => {
    const diff = ["supabase\\migrations\\20260828160000_c.sql"];
    expect(locTheoMoc(sauCutoff, diff)).toEqual(["20260828160000_c.sql"]);
  });
});
