import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Dọn 35 dòng của CÔNG TY THẬT đang trỏ sang dữ liệu Test/Demo.
//
// Đây là mặt GHI của lỗ rò đã vá ở GĐ0–GĐ5, đọng lại thành dữ liệu hỏng: khi RLS
// còn cho thấy dữ liệu công ty khác, người ta chọn nhầm và hệ thống ghi nhận.
// Vá phía đọc không tự dọn phần đã ghi.
//
// Đo trên production trước khi viết file này:
//   • 28 dòng building_services — 7 toà nhà THẬT (102LVT, 15KV, 403PVB, 405PVB,
//     44TL, 481NVK, 512TT) bị gắn thêm 4 dịch vụ "DEMO Điện/Nước/Rác/Giữ Xe".
//     Các toà này ĐÃ có hệ dịch vụ thật riêng (Điện - AG, Điện 3K1, Nước… mỗi
//     cái 18–20 toà dùng), và 0 hợp đồng nào chảy qua dịch vụ DEMO. Cấu hình
//     thừa gắn chồng, không phải cấu hình đang chạy.
//   • 7 dòng jobs trỏ tới job_type "sửa" của org khác, mà công ty thật có sẵn
//     loại trùng tên → trỏ lại, không xoá.
//
// Hai cách xử lý khác nhau vì hai bản chất khác nhau: cái vô dụng thì bỏ, cái có
// bản tương đương thì nối lại. Gộp làm một sẽ hoặc xoá mất việc thật, hoặc giữ
// lại rác.
const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260808050000_gd7_don_tham_chieu_cheo.sql"),
  "utf8",
);

describe("Dọn tham chiếu chéo tổ chức", () => {
  it("chạy trong đúng một transaction", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  });

  it("preflight chặn chạy nếu có hợp đồng ĐANG dùng dịch vụ DEMO", () => {
    // Mệnh đề an toàn quan trọng nhất: 28 dòng kia chỉ vô hại CHỪNG NÀO không
    // hợp đồng nào chảy qua chúng. Nếu số đó đổi từ 0 thành khác 0 giữa lúc đo
    // và lúc chạy, xoá là cắt dịch vụ đang tính tiền.
    expect(sql).toMatch(/DO \$preflight\$/);
    expect(sql).toMatch(/contract_services/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it("preflight đòi loại việc thay thế phải tồn tại và DUY NHẤT", () => {
    // Có hai bản trùng tên trong org thật thì "trỏ lại" thành trỏ bừa.
    expect(sql).toMatch(/count\(\*\)\s*<>\s*1|<> 1 THEN/);
    expect(sql).toMatch(/job_types/);
  });

  it("XOÁ dòng building_services vô dụng, KHÔNG trỏ lại", () => {
    expect(sql).toMatch(/DELETE FROM public\.building_services/);
    expect(sql).not.toMatch(/UPDATE public\.building_services/);
  });

  it("TRỎ LẠI jobs, KHÔNG xoá", () => {
    expect(sql).toMatch(/UPDATE public\.jobs/);
    expect(sql).not.toMatch(/DELETE FROM public\.jobs/);
  });

  it("chỉ đụng dòng của công ty thật trỏ sang org khác — không quét rộng hơn", () => {
    expect(sql).toMatch(/aaaa0000-0000-4000-8000-000000000001/);
    expect(sql).toMatch(/s\.organization_id <> |t\.organization_id <> /);
  });

  it("verify khẳng định hai đường tham chiếu chéo về 0", () => {
    const verify = sql.slice(sql.indexOf("DO $verify$"));
    expect(verify).toMatch(/building_services/);
    expect(verify).toMatch(/jobs/);
    expect(verify).toMatch(/RAISE EXCEPTION/);
  });

  it("báo ra số dòng đã đụng, không im lặng", () => {
    expect(sql).toMatch(/RAISE NOTICE/);
    expect(sql).toMatch(/GET DIAGNOSTICS/);
  });

  it("ghi rõ đường rollback", () => {
    expect(sql).toMatch(/ROLLBACK:/);
  });
});
