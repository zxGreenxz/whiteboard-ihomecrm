import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// GĐ0 của kế hoạch tách dữ liệu đa công ty — bịt bề mặt gọi được KHÔNG CẦN ĐĂNG NHẬP.
//
// Án lệ 07/08/2026: get_public_latest_invoice_by_contract(uuid) là SECURITY DEFINER,
// thân hàm không có một dòng kiểm quyền nào, mà lại được GRANT cho role `anon`. Đã gọi
// thật bằng anon key trong bundle trình duyệt, không đăng nhập: HTTP 200, trả về họ tên
// và số điện thoại khách thuê, tên toà, số phòng, toàn bộ dòng hoá đơn của công ty THẬT.
// Ba hàm building_of_invoice/contract/payment cũng mở cho anon và làm máy dò xác nhận
// một UUID có tồn tại hay không.
//
// HAI VAI PHẢI ĐƯỢC ĐỐI XỬ KHÁC NHAU — đây là chỗ bản kế hoạch đầu tiên sai và suýt gây
// sự cố. Đã đo thật trong transaction rollback:
//   • Thu hồi building_of_* khỏi `authenticated` làm VỠ NGAY 4/5 bảng được thử
//     (contract_tenants, deposits, contract_services, contract_terminations đều ném
//     42501 "permission denied for function building_of_contract"), vì biểu thức RLS
//     policy chạy bằng quyền của CHÍNH người truy vấn, mà 40+ policy đang gọi ba hàm này.
//   • Thu hồi khỏi `anon` + PUBLIC thì không ảnh hưởng gì: nathan đọc y nguyên
//     (0/2690/0/213/31 trước và sau), anon vẫn dùng được get_public_latest_invoice_by_code
//     (đường chia sẻ công khai đúng, có bí mật public_code), còn anon bị chặn cả
//     by_contract lẫn building_of_*.
const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260807183000_gd0_bit_be_mat_an_danh.sql"),
  "utf8",
);

/**
 * Bỏ mọi dòng chú thích trước khi soi lệnh.
 *
 * Không có bước này thì một mệnh đề kiểu /REVOKE[^;]*by_code/ sẽ khớp NHẦM: chữ
 * "REVOKE" nằm trong văn xuôi giải thích, rồi `[^;]*` vắt qua vài dòng chú thích
 * không có dấu chấm phẩy tới tận chữ `by_code` ở một câu giải thích khác. Test
 * khi đó báo đỏ một migration hoàn toàn đúng — đúng loại bẫy khiến người ta mất
 * niềm tin vào test rồi tắt nó đi.
 */
const chiLenh = sql
  .split("\n")
  .filter((d) => !/^\s*--/.test(d))
  .join("\n");

const khoiVerify = sql.slice(sql.indexOf("DO $verify$"), sql.indexOf("COMMIT;"));

describe("GĐ0 — bịt bề mặt ẩn danh", () => {
  it("chạy trong đúng một transaction", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  });

  it("thu hồi by_contract khỏi cả anon, authenticated lẫn PUBLIC", () => {
    // PUBLIC là chỗ review chỉ ra đúng: revoke thiếu PUBLIC thì quyền vẫn còn.
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.get_public_latest_invoice_by_contract\(uuid\)\s*\n?\s*FROM anon, authenticated, PUBLIC;/,
    );
  });

  it("thu hồi building_of_* khỏi anon và PUBLIC — nhưng KHÔNG khỏi authenticated", () => {
    for (const fn of ["building_of_invoice", "building_of_contract", "building_of_payment"]) {
      expect(sql).toMatch(
        new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn}\\(uuid\\)\\s*\\n?\\s*FROM anon, PUBLIC;`),
      );
    }
    // Chốt chống hồi quy: không được có câu nào thu hồi building_of_* khỏi authenticated.
    expect(sql).not.toMatch(/REVOKE[^;]*building_of_[a-z]+\(uuid\)[^;]*authenticated/);
  });

  it("KHÔNG đụng tới get_public_latest_invoice_by_code — đó là đường công khai hợp lệ", () => {
    expect(chiLenh).not.toMatch(/REVOKE[^;]*get_public_latest_invoice_by_code/);
  });

  it("preflight chặn chạy nhầm khi đường công khai không còn nguyên vẹn", () => {
    expect(sql).toMatch(/DO \$preflight\$/);
    expect(sql).toContain("get_public_latest_invoice_by_code");
    expect(sql).toMatch(/prosecdef/);
  });

  it("verify khẳng định anon hết quyền trên cả bốn hàm", () => {
    expect(sql).toMatch(/DO \$verify\$/);
    expect(sql).toMatch(/has_function_privilege\(\s*'anon'/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it("verify khẳng định authenticated CÒN quyền trên building_of_* (kẻo vỡ RLS)", () => {
    // Không ràng buộc thứ tự chữ trong mệnh đề — chỉ đòi khối verify thật sự có
    // kiểm quyền của authenticated trên nhóm building_of_*, và nêu lý do để người
    // sau không tưởng đây là dòng thừa rồi xoá đi.
    expect(khoiVerify).toMatch(/NOT has_function_privilege\(\s*'authenticated'/);
    expect(khoiVerify).toContain("building_of_invoice");
    expect(khoiVerify).toMatch(/MẤT quyền[\s\S]*policy/i);
  });

  it("verify khẳng định anon VẪN gọi được by_code", () => {
    expect(khoiVerify).toContain("get_public_latest_invoice_by_code");
    expect(khoiVerify).toMatch(/has_function_privilege\(\s*'anon'/);
    expect(khoiVerify).toMatch(/giết trang tra hoá đơn công khai/);
  });

  it("ghi rõ đường rollback", () => {
    expect(sql).toMatch(/ROLLBACK:/);
    expect(sql).toMatch(/GRANT EXECUTE/);
  });
});
