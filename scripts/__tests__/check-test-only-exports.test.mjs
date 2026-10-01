// Sổ cho scripts/check-test-only-exports.mjs.
//
// Đo 01/10/2026: cửa này mất 51 s ngay cả khi máy đã ấm, chậm nhất trong cả
// gate:truoc-push sau khi ba cửa nặng có cache. Lý do: với MỖI tên hàm export nó
// đọc lại từ đĩa mọi file sản xuất (~1.300 file). Bản sửa đọc mỗi file một lần.
// Ca "đọc đúng một lần" dưới đây khoá điều đó; hai ca đầu khoá kết luận không đổi.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { timExportChiTestDung } from "../check-test-only-exports.mjs";

const goc = fileURLToPath(new URL("../../", import.meta.url));
const p = (rel) => join(goc, rel);

const KHO = {
  [p("src/lib/giaHelpers.ts")]: "export function dungThat() {}\nexport const chiTestDung = () => 1;\n",
  [p("src/hooks/useGia.ts")]: "import { dungThat } from '../lib/giaHelpers';\ndungThat();\n",
  [p("src/lib/__tests__/giaHelpers.test.ts")]: "import { dungThat, chiTestDung } from '../giaHelpers';\n",
};

describe("timExportChiTestDung", () => {
  it("báo export mà chỉ file test dùng", () => {
    const ket = timExportChiTestDung(Object.keys(KHO), (f) => KHO[f]);
    expect(ket).toEqual([{ file: "src/lib/giaHelpers.ts", chet: ["chiTestDung"], tong: 2 }]);
  });

  it("export được code sản xuất dùng thì không báo", () => {
    const kho = { ...KHO, [p("src/hooks/useGia.ts")]: "dungThat(); chiTestDung();\n" };
    expect(timExportChiTestDung(Object.keys(kho), (f) => kho[f])).toEqual([]);
  });

  it("mỗi file sản xuất chỉ được đọc đúng một lần, dù có nhiều tên cần dò", () => {
    const dem = new Map();
    const doc = (f) => {
      dem.set(f, (dem.get(f) ?? 0) + 1);
      return KHO[f];
    };
    timExportChiTestDung(Object.keys(KHO), doc);
    for (const [f, n] of dem) expect(n, f).toBe(1);
  });
});
