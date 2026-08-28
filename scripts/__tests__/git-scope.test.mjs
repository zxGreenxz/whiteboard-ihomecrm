// Sổ cho scripts/lib/git-scope.mjs — helper phạm vi git cho gate chạy trên
// working tree CHUNG nhiều phiên.
//
// Vấn đề nó giải (đo 28/08/2026): ~25 gate quét đĩa hoặc `git ls-files --others`
// nên thấy cả file WIP untracked của PHIÊN KHÁC — phiên A tạo file dở là gate
// của phiên B đỏ oan. Nguyên tắc mới: phạm vi sự thật của gate local là
// INDEX ∪ tracked; vi phạm trên file untracked hạ xuống CẢNH BÁO ở local nhưng
// giữ CỨNG trên CI (cây CI luôn sạch nên untracked ở đó là bất thường thật).
import { afterEach, describe, expect, it } from "vitest";

import { docTuIndex, laCI, lietKeTracked, lietKeUntracked, phanCap } from "../lib/git-scope.mjs";

describe("phanCap", () => {
  const viPhams = [
    { file: "src/a.ts", loi: "x" },
    { file: "src/b.ts", loi: "y" },
  ];

  it("local: vi phạm trên file untracked xuống MỀM, còn lại CỨNG", () => {
    const { cung, mem } = phanCap(viPhams, new Set(["src/b.ts"]), false);
    expect(cung.map((v) => v.file)).toEqual(["src/a.ts"]);
    expect(mem.map((v) => v.file)).toEqual(["src/b.ts"]);
  });

  it("CI: mọi vi phạm đều CỨNG, kể cả trên file untracked", () => {
    // Trên CI cây luôn sạch — còn untracked nghĩa là chính pipeline sinh rác,
    // phải đỏ chứ không được nuốt thành cảnh báo.
    const { cung, mem } = phanCap(viPhams, new Set(["src/b.ts"]), true);
    expect(cung).toHaveLength(2);
    expect(mem).toHaveLength(0);
  });

  it("vi phạm không mang trường `file` thì truyền hàm lấy khoá riêng", () => {
    const { mem } = phanCap([{ duong: "x.sql" }], new Set(["x.sql"]), false, (v) => v.duong);
    expect(mem).toHaveLength(1);
  });

  it("tập untracked rỗng ⇒ mọi thứ CỨNG như gate cũ", () => {
    const { cung, mem } = phanCap(viPhams, new Set(), false);
    expect(cung).toHaveLength(2);
    expect(mem).toHaveLength(0);
  });
});

describe("liệt kê từ git (chạy trên chính repo, chỉ đọc)", () => {
  it("lietKeTracked thấy file đã commit và trả đường dẫn dấu /", () => {
    const ds = lietKeTracked(["package.json", "scripts/check-doc-counts.mjs"]);
    expect(ds).toContain("package.json");
    expect(ds).toContain("scripts/check-doc-counts.mjs");
    expect(ds.every((p) => !p.includes("\\"))).toBe(true);
  });

  it("lietKeUntracked KHÔNG trả file đã tracked", () => {
    expect(lietKeUntracked(["package.json"])).not.toContain("package.json");
  });

  it("docTuIndex đọc nội dung package.json đúng bản trong index", () => {
    expect(docTuIndex("package.json")).toContain('"scripts"');
  });

  it("docTuIndex trả null cho đường dẫn không có trong index", () => {
    expect(docTuIndex("khong/ton/tai.xyz")).toBeNull();
  });
});

describe("laCI", () => {
  const cu = process.env.CI;
  afterEach(() => {
    if (cu === undefined) delete process.env.CI;
    else process.env.CI = cu;
  });

  it("bật khi CI=true (GitHub Actions luôn set)", () => {
    process.env.CI = "true";
    expect(laCI()).toBe(true);
  });

  it("tắt khi không có biến CI", () => {
    delete process.env.CI;
    expect(laCI()).toBe(false);
  });
});
