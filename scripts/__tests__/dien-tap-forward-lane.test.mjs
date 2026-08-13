// Sổ cho scripts/dien-tap-forward-lane.mjs.
//
// Luật đắt nhất ở đây là ĐỐI CHIẾU HAI CHIỀU với sổ kỳ vọng: một file
// dung-vi-du-lieu mà chạy SẠCH trên database rỗng cũng đỏ y như một file lỗi
// không khai — chiều thứ hai là thứ bắt được "môi trường diễn tập dễ hơn thực
// tế" (ai đó seed dữ liệu, hay shim cấp thừa quyền), và là chiều dễ bị cắt
// nhất khi ai đó "đơn giản hoá" phép so về "có lỗi / không có lỗi".
import { describe, expect, it } from "vitest";

import { TOI_THIEU_FILE, chonFileForwardLane, doiChieuKyVong } from "../dien-tap-forward-lane.mjs";

const CUTOFF = "20260805120000";

describe("chonFileForwardLane", () => {
  it("chỉ lấy .sql có version 14 chữ số SAU cutoff, theo thứ tự apply", () => {
    const ra = chonFileForwardLane(
      [
        "20260805120000_dung_moc.sql", // bằng cutoff — legacy, KHÔNG lấy
        "20260806090000_a.sql",
        "20260101010101_legacy.sql",
        "20260808010000_gd3.sql.tables.json", // file kèm, không phải migration
        "016_legacy_khong_timestamp.sql",
        "20260813040000_z.sql",
      ],
      CUTOFF,
    );
    expect(ra).toEqual(["20260806090000_a.sql", "20260813040000_z.sql"]);
  });

  it("sàn chống rỗng phải đủ thấp hơn lane thật (39 file lúc viết) nhưng > 0", () => {
    expect(TOI_THIEU_FILE).toBeGreaterThan(0);
    expect(TOI_THIEU_FILE).toBeLessThanOrEqual(39);
  });
});

describe("doiChieuKyVong", () => {
  const kyVong = {
    "b.sql": { kyVong: "dung-vi-du-lieu", thongDiep: "Không có người dùng thường" },
    "c.sql": { kyVong: "cascade", tu: "b.sql", thongDiep: "does not exist" },
  };

  it("file không entry chạy sạch → đạt; có entry dừng đúng thông điệp → đạt", () => {
    const { dat, dong } = doiChieuKyVong(
      [
        { ten: "a.sql", ok: true, stderr: "" },
        { ten: "b.sql", ok: false, stderr: "ERROR:  Không có người dùng thường nào để nghiệm thu. DỪNG." },
        { ten: "c.sql", ok: false, stderr: 'ERROR:  relation "x" does not exist' },
      ],
      kyVong,
    );
    expect(dat).toBe(true);
    expect(dong.map((d) => d.trangThai)).toEqual(["chay-sach", "dung-dung-ky-vong", "dung-dung-ky-vong"]);
  });

  it("LỖI mà không có entry → LECH (lỗi schema thật hoặc khẳng định mới chưa phân loại)", () => {
    const { dat, dong } = doiChieuKyVong([{ ten: "a.sql", ok: false, stderr: "ERROR: boom" }], {});
    expect(dat).toBe(false);
    expect(dong[0].trangThai).toBe("LECH");
    expect(dong[0].chiTiet).toContain("không có trong sổ kỳ vọng");
  });

  it("CHIỀU NGƯỢC: entry nói phải DỪNG mà chạy sạch → LECH", () => {
    // Đây chính là ca "môi trường dễ hơn thực tế": 20260808080000 xoá dữ liệu
    // mà chạy êm trên database rỗng nghĩa là chốt đo của nó đã chết.
    const { dat, dong } = doiChieuKyVong([{ ten: "b.sql", ok: true, stderr: "" }], kyVong);
    expect(dat).toBe(false);
    const b = dong.find((d) => d.ten === "b.sql");
    expect(b.trangThai).toBe("LECH");
    expect(b.chiTiet).toContain("dễ hơn thực tế");
  });

  it("dừng nhưng SAI thông điệp → LECH — entry cũ không được che lỗi mới", () => {
    // b.sql vốn dừng vì thiếu người dùng; nay chết vì một lỗi schema khác.
    // So kiểu "có lỗi là được" sẽ nuốt mất lỗi mới — phải khớp thông điệp.
    const { dat, dong } = doiChieuKyVong(
      [{ ten: "b.sql", ok: false, stderr: 'ERROR:  column "x" does not exist' }],
      kyVong,
    );
    expect(dat).toBe(false);
    expect(dong[0].chiTiet).toContain("SAI thông điệp");
  });

  it("entry mồ côi (không khớp file nào trên đĩa) → LECH", () => {
    const { dat, dong } = doiChieuKyVong([{ ten: "a.sql", ok: true, stderr: "" }], kyVong);
    expect(dat).toBe(false);
    const moCoi = dong.filter((d) => d.trangThai === "LECH").map((d) => d.ten).sort();
    expect(moCoi).toEqual(["b.sql", "c.sql"]);
  });

  it("stderr nhiều dòng: chỉ cần CHỨA thông điệp, số dòng psql không làm hỏng phép so", () => {
    const { dat } = doiChieuKyVong(
      [{
        ten: "b.sql",
        ok: false,
        stderr: "psql:<stdin>:113: ERROR:  Không có người dùng thường nào để nghiệm thu. DỪNG.\nCONTEXT: PL/pgSQL",
      }],
      // Chỉ entry b.sql — đưa cả sổ mẫu vào đây thì c.sql thành mồ côi và ca
      // này đo nhầm sang chiều khác (bản đầu của test dính đúng lỗi đó).
      { "b.sql": kyVong["b.sql"] },
    );
    expect(dat).toBe(true);
  });
});
