// Sổ cho ratchet any-cast RPC — trọng tâm là ranh giới PHIÊN SONG SONG.
//
// Trước 28/08/2026 scanRepo dùng `git ls-files --cached --others` nên đếm cả
// cast trong file UNTRACKED của phiên khác trên working tree chung: phiên A tạo
// file dở có cast là ratchet của phiên B đỏ oan, và con số baseline trở nên
// không tái lập được từ commit. Nay: con số ratchet CHỈ tính file trong index;
// cast trong file untracked tách ra nhóm cảnh báo riêng.
import { describe, expect, it } from "vitest";

import { countCasts, compare, demCastTheoFile } from "../check-rpc-cast-ratchet.mjs";

describe("demCastTheoFile — bộ đếm nhận reader tiêm được", () => {
  const noiDung = {
    "src/a.ts": "const x = (supabase as any).rpc('f');",
    "src/b.ts": "const y = 1;",
    "src/wip-phien-khac.ts": "(supabase.rpc as any)('g'); (supabase as any).from('t');",
  };
  const doc = (rel) => noiDung[rel] ?? null;

  it("đếm đúng theo file, bỏ file không có cast", () => {
    const { perFile, total } = demCastTheoFile(Object.keys(noiDung), doc);
    expect(perFile).toEqual({ "src/a.ts": 1, "src/wip-phien-khac.ts": 2 });
    expect(total).toBe(3);
  });

  it("file đọc không được (đã xoá trên đĩa) thì bỏ qua, không ném", () => {
    const { total } = demCastTheoFile(["src/khong-con.ts"], () => null);
    expect(total).toBe(0);
  });

  it("con số ratchet tái lập được: cùng danh sách file cho cùng kết quả, KHÔNG phụ thuộc file ngoài danh sách", () => {
    // Đây là hợp đồng cốt lõi với phiên song song: truyền danh sách CACHED thì
    // file untracked của phiên khác không thể ảnh hưởng con số.
    const chiCached = demCastTheoFile(["src/a.ts", "src/b.ts"], doc);
    expect(chiCached.perFile).toEqual({ "src/a.ts": 1 });
    expect(chiCached.total).toBe(1);
  });
});

describe("countCasts + compare — hành vi cũ giữ nguyên", () => {
  it("bắt cả ba dạng cast", () => {
    expect(countCasts("(supabase as any).rpc('a')")).toBe(1);
    expect(countCasts("(supabase.from as any)('b')")).toBe(1);
    expect(countCasts("(supabase as unknown as {x}).rpc('c')")).toBe(1);
  });

  it("file mới có cast ⇒ vi phạm; file giảm ⇒ improved", () => {
    const baseline = { perFile: { "src/cu.ts": 2 } };
    const { problems, improved } = compare(baseline, { perFile: { "src/moi.ts": 1, "src/cu.ts": 1 }, total: 2 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("src/moi.ts");
    expect(improved).toBe(1);
  });
});
