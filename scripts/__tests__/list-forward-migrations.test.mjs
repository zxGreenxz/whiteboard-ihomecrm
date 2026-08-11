// Sổ đột biến cho scripts/list-forward-migrations.mjs.
//
// Ca quan trọng nhất là SO_MO_COI (có sổ, không có file). Nó là loại lệch mà một
// vòng lặp "duyệt file trên đĩa rồi tra sổ" KHÔNG BAO GIỜ thấy — vì nó không có
// file để duyệt. Đã xảy ra thật trên main ngày 08/08/2026 với
// 20260807163000_ie_types_org_boundary.sql. Ca này tồn tại để không ai "tối ưu"
// hàm về một vòng lặp duy nhất rồi làm mù đúng chỗ nguy hiểm nhất.
import { describe, expect, it } from "vitest";

import { CO_BANG_CHUNG, ghepBaNguon, NHAN } from "../list-forward-migrations.mjs";

const CUTOFF = "20260805120000";
const e = (ten, state) => ({ path: `supabase/migrations/${ten}`, state });

describe("ghepBaNguon — bốn kết luận", () => {
  it("có file + có sổ có bằng chứng ⇒ DA_APPLY", () => {
    const r = ghepBaNguon({
      fileTrenDia: ["20260806000000_a.sql"],
      entries: [e("20260806000000_a.sql", "ledger-applied")],
      cutoff: CUTOFF,
    });
    expect(r).toHaveLength(1);
    expect(r[0].ketLuan).toBe("DA_APPLY");
  });

  it("catalog-proven cũng tính là có bằng chứng", () => {
    const r = ghepBaNguon({
      fileTrenDia: ["20260806000000_a.sql"],
      entries: [e("20260806000000_a.sql", "catalog-proven")],
      cutoff: CUTOFF,
    });
    expect(r[0].ketLuan).toBe("DA_APPLY");
  });

  it("có file + KHÔNG có sổ ⇒ THIEU_SO", () => {
    const r = ghepBaNguon({ fileTrenDia: ["20260806000000_a.sql"], entries: [], cutoff: CUTOFF });
    expect(r[0].ketLuan).toBe("THIEU_SO");
    expect(r[0].trenDia).toBe(true);
    expect(r[0].trongSo).toBe(false);
  });

  it("CA QUAN TRỌNG NHẤT — có sổ + KHÔNG có file ⇒ SO_MO_COI", () => {
    const r = ghepBaNguon({
      fileTrenDia: [],
      entries: [e("20260807163000_ie_types_org_boundary.sql", "catalog-proven")],
      cutoff: CUTOFF,
    });
    expect(r).toHaveLength(1);
    expect(r[0].ketLuan).toBe("SO_MO_COI");
    expect(r[0].trenDia).toBe(false);
    // KHÔNG được rơi vào DA_APPLY chỉ vì state có bằng chứng: bằng chứng nói
    // production đã đổi, nhưng repo không còn mô tả nó — đó mới là vấn đề.
    expect(r[0].ketLuan).not.toBe("DA_APPLY");
  });

  it("có file + sổ state unknown ⇒ CHUA_CHUNG_MINH, không phải DA_APPLY", () => {
    const r = ghepBaNguon({
      fileTrenDia: ["20260806000000_a.sql"],
      entries: [e("20260806000000_a.sql", "unknown")],
      cutoff: CUTOFF,
    });
    expect(r[0].ketLuan).toBe("CHUA_CHUNG_MINH");
  });

  it("superseded KHÔNG được coi là đã apply", () => {
    expect(CO_BANG_CHUNG.has("superseded")).toBe(false);
    expect(CO_BANG_CHUNG.has("unknown")).toBe(false);
  });
});

describe("ranh giới cutoff", () => {
  it("file TRƯỚC cutoff bị bỏ qua hoàn toàn", () => {
    const r = ghepBaNguon({
      fileTrenDia: ["20260101000000_cu.sql"],
      entries: [e("20260101000000_cu.sql", "unknown")],
      cutoff: CUTOFF,
    });
    expect(r).toHaveLength(0);
  });

  it("file ĐÚNG BẰNG cutoff cũng bị bỏ (luật là LỚN HƠN)", () => {
    const r = ghepBaNguon({ fileTrenDia: [`${CUTOFF}_x.sql`], entries: [], cutoff: CUTOFF });
    expect(r).toHaveLength(0);
  });

  it("version legacy không phải 14 chữ số bị bỏ qua", () => {
    const r = ghepBaNguon({
      fileTrenDia: ["001_extensions.sql", "016_customers_table.sql"],
      entries: [],
      cutoff: CUTOFF,
    });
    expect(r).toHaveLength(0);
  });

  it("entry mồ côi TRƯỚC cutoff cũng bị bỏ — chỉ soi vùng forward-only", () => {
    const r = ghepBaNguon({ fileTrenDia: [], entries: [e("20260101000000_cu.sql", "ledger-applied")], cutoff: CUTOFF });
    expect(r).toHaveLength(0);
  });
});

describe("gộp và sắp xếp", () => {
  it("sắp theo version tăng dần, trộn cả hai chiều lệch", () => {
    const r = ghepBaNguon({
      fileTrenDia: ["20260808000000_c.sql", "20260806000000_a.sql"],
      entries: [e("20260807000000_b.sql", "ledger-applied")],
      cutoff: CUTOFF,
    });
    expect(r.map((x) => x.version)).toEqual(["20260806000000", "20260807000000", "20260808000000"]);
    expect(r.map((x) => x.ketLuan)).toEqual(["THIEU_SO", "SO_MO_COI", "THIEU_SO"]);
  });

  it("không đếm trùng khi file vừa có trên đĩa vừa có trong sổ", () => {
    const r = ghepBaNguon({
      fileTrenDia: ["20260806000000_a.sql"],
      entries: [e("20260806000000_a.sql", "ledger-applied")],
      cutoff: CUTOFF,
    });
    expect(r).toHaveLength(1);
  });

  it("mọi kết luận đều có nhãn tiếng Việt", () => {
    for (const k of ["DA_APPLY", "CHUA_CHUNG_MINH", "THIEU_SO", "SO_MO_COI"]) {
      expect(typeof NHAN[k]).toBe("string");
      expect(NHAN[k].length).toBeGreaterThan(5);
    }
  });
});
