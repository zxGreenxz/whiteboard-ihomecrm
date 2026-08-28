// Sổ cho scripts/tao-ten-migration.mjs — cấp timestamp migration chống đụng
// giữa các phiên song song (28/08/2026).
//
// Cả HAI cặp miễn trừ trùng-version trong migration-policy.json đều sinh từ
// "hai luồng làm việc song song đụng cùng mốc giờ" — vì người ta chọn tay mốc
// TRÒN kiểu ...120000. Script này lấy UTC đến GIÂY THẬT và kiểm trùng với mọi
// nguồn (index, đĩa, các worktree khác) trước khi in tên.
import { describe, expect, it } from "vitest";

import { sinhTen } from "../tao-ten-migration.mjs";

describe("sinhTen", () => {
  const luc = new Date(Date.UTC(2026, 7, 28, 10, 2, 3));

  it("lấy UTC đến GIÂY THẬT — không làm tròn phút", () => {
    expect(sinhTen("them_bang_x", luc, () => false)).toBe("20260828100203_them_bang_x.sql");
  });

  it("version bị trùng ⇒ +1 giây tới khi thoát", () => {
    const daCo = new Set(["20260828100203", "20260828100204"]);
    expect(sinhTen("them_bang_x", luc, (v) => daCo.has(v))).toBe("20260828100205_them_bang_x.sql");
  });

  it("+1 giây tràn qua phút/giờ vẫn đúng lịch", () => {
    const cuoiPhut = new Date(Date.UTC(2026, 7, 28, 10, 59, 59));
    expect(sinhTen("x_y", cuoiPhut, (v) => v === "20260828105959")).toBe("20260828110000_x_y.sql");
  });

  it("slug phải là snake_case ascii — chữ hoa/dấu/khoảng trắng bị từ chối với lời nhắc", () => {
    for (const xau of ["Them Bang", "them-bang", "thêm_bảng", ""]) {
      expect(() => sinhTen(xau, luc, () => false)).toThrow(/snake_case/);
    }
  });
});
