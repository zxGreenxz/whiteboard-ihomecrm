// Sổ cho scripts/lib/bo-chu-thich.mjs.
//
// File đó ra đời sau BỐN lần cùng một lỗi trong bốn gate khác nhau: gate quét văn
// bản thô không phân biệt được MÃ với VĂN KỂ LẠI VỀ MÃ. Ba lần là báo thừa (phiền
// nhưng thấy được); lần đầu — check-copilot-docs-manifest — là báo THIẾU: gate
// xanh trong khi không kiểm gì, vì ba dòng comment tình cờ chứa chuỗi nó tìm.
//
// Bộ ca dưới đây canh cả hai chiều: bỏ đủ để hết báo thừa, và KHÔNG bỏ quá tay
// tới mức nuốt mất mã thật.
import { describe, expect, it } from "vitest";

import { boChuThichJs, boChuThichShell, boChuThichSql } from "../lib/bo-chu-thich.mjs";

describe("boChuThichShell — YAML và shell dùng chung `#`", () => {
  it("bỏ dòng comment, giữ dòng lệnh", () => {
    expect(boChuThichShell("# node scripts/a.mjs\nnode scripts/b.mjs")).toBe("node scripts/b.mjs");
  });

  it("bỏ cả comment có thụt lề — trong `run:` chúng luôn thụt", () => {
    expect(boChuThichShell("    # ::warning::x\n    echo ok")).toBe("    echo ok");
  });

  it("KHÔNG bỏ `#` giữa dòng — đó là dữ liệu, không phải chú thích", () => {
    // Cắt ở đây sẽ nuốt mất phần lệnh thật đứng trước.
    expect(boChuThichShell('echo "mau #ff0000"')).toBe('echo "mau #ff0000"');
  });

  it("dòng chỉ có chú thích ⇒ chuỗi rỗng (check-known-gaps dựa vào tính chất này)", () => {
    expect(boChuThichShell("  # gì đó")).toBe("");
  });

  it("chuỗi rỗng vào ⇒ rỗng ra, không ném", () => {
    expect(boChuThichShell("")).toBe("");
  });
});

describe("boChuThichJs", () => {
  it("bỏ `//` đầu dòng", () => {
    expect(boChuThichJs('// const a = "x";\nconst b = "y";')).toBe('const b = "y";');
  });

  it("bỏ khối /* … */ kể cả nhiều dòng", () => {
    expect(boChuThichJs("/* a\n   b */\nconst c = 1;").trim()).toBe("const c = 1;");
  });

  it("bỏ dòng tiếp của JSDoc (bắt đầu bằng `*`)", () => {
    expect(boChuThichJs(" * mô tả\nconst a = 1;")).toBe("const a = 1;");
  });

  it("KHÔNG bỏ `//` giữa dòng — url và toán tử vẫn còn", () => {
    expect(boChuThichJs('const u = "https://x.dev";')).toBe('const u = "https://x.dev";');
  });
});

describe("boChuThichSql", () => {
  it("bỏ `--` đầu dòng", () => {
    expect(boChuThichSql("-- CREATE TABLE cu;\nCREATE TABLE moi;")).toBe("CREATE TABLE moi;");
  });

  it("bỏ khối /* … */", () => {
    expect(boChuThichSql("/* ghi chú */\nSELECT 1;").trim()).toBe("SELECT 1;");
  });

  it("KHÔNG bỏ `--` giữa dòng", () => {
    expect(boChuThichSql("SELECT 1; -- đuôi")).toBe("SELECT 1; -- đuôi");
  });
});

describe("giới hạn đã khai — đừng dùng file này để biến đổi mã", () => {
  it("KHÔNG hiểu chuỗi ký tự: `// ` bên trong chuỗi vẫn bị cắt nếu ở đầu dòng", () => {
    // Ghim đúng giới hạn mà header của lib đã nói ra, để không ai tưởng nó là
    // trình phân tích cú pháp rồi dùng nó ghi lại file.
    expect(boChuThichJs('const s =\n// "không phải comment"\n1;')).toBe("const s =\n1;");
  });
});
