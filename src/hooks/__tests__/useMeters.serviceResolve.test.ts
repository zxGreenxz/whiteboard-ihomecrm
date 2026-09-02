import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// C-07 (audit 02/09/2026): nút "Thêm công tơ điện" từng chết vì resolveServiceId
// khớp TÊN chính xác "Điện" bằng .single() — dịch vụ đó bị xoá mềm 10/05/2026.
// Ghim luật mới: nhận diện theo fee_type trước, code rồi mới đến name; dò bằng
// maybeSingle() trong dịch vụ đang hoạt động, ưu tiên is_default.

const source = readFileSync(new URL("../useMeters.ts", import.meta.url), "utf8");
// Chỉ lấy thân resolveServiceId — phần sau file còn hook khác dùng .single() hợp lệ.
const fnStart = source.indexOf("async function resolveServiceId");
const fn = source.slice(fnStart, source.indexOf("\n// ===", fnStart));

describe("resolveServiceId nhận diện dịch vụ theo loại, không theo tên", () => {
  it("ánh xạ ELECTRICITY/WATER sang fee_type TIEN_DIEN/TIEN_NUOC", () => {
    expect(source).toMatch(/ELECTRICITY:\s*\{[^}]*feeType:\s*"TIEN_DIEN"/);
    expect(source).toMatch(/WATER:\s*\{[^}]*feeType:\s*"TIEN_NUOC"/);
  });

  it("thử fee_type → code → name theo đúng thứ tự, chỉ trong dịch vụ đang hoạt động", () => {
    const feePos = fn.indexOf('.eq("fee_type", feeType)');
    const codePos = fn.indexOf('.in("code", match.codes)');
    const namePos = fn.indexOf('.in("name", match.names)');
    expect(feePos).toBeGreaterThan(-1);
    expect(codePos).toBeGreaterThan(feePos);
    expect(namePos).toBeGreaterThan(codePos);
    expect(fn).toMatch(/\.is\("deleted_at", null\)/);
    expect(fn).toMatch(/\.order\("is_default", \{ ascending: false \}\)/);
  });

  it("không còn .single() (0 dòng không phải lỗi ở bước dò) và toast chỉ đúng chỗ tạo dịch vụ", () => {
    expect(fn).not.toMatch(/\.single\(\)/);
    expect(fn).toMatch(/\.maybeSingle\(\)/);
    expect(fn).toMatch(/Cài đặt ▸ Dịch vụ/);
  });
});
