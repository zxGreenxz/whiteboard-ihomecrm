import { describe, expect, it } from "vitest";

import { phanTichAcl } from "../check-definer-acl.mjs";

// VÌ SAO CÓ FILE NÀY — án lệ 07/08/2026, đo được trên production.
//
// `get_public_latest_invoice_by_contract(uuid)` là SECURITY DEFINER không kiểm
// quyền, trả về họ tên + SĐT khách thuê và toàn bộ hoá đơn. Ngày 30/05 nó ĐÃ
// được thu hồi đúng cách — migration 20260530000003 revoke khỏi cả PUBLIC, anon
// và authenticated, kèm chú thích giải thích rõ vì sao phải có PUBLIC.
//
// Hai ngày sau, migration 20260601000000_remove_tax_fields.sql — một refactor gỡ
// cột thuế, chẳng liên quan gì tới bảo mật — tạo lại hàm rồi chép kèm một dòng
// `GRANT EXECUTE ... TO anon, authenticated`. Lỗ mở lại và nằm im HƠN HAI THÁNG.
//
// Gate ACL đã tồn tại từ trước và VẪN KHÔNG BẮT ĐƯỢC, vì nó chỉ hỏi "có hàm nào
// anon gọi được mà NGOÀI allowlist không". Hàm này nằm SẴN trong allowlist — nên
// việc cấp lại quyền trông y hệt trạng thái bình thường. Ratchet đã ban phước cho
// đúng cái lỗ nó sinh ra để canh.
//
// Sửa: thêm DANH SÁCH CẤM. Allowlist trả lời "được phép hay chưa xét"; danh sách
// cấm trả lời "đã có người cố ý đóng, không ai được mở lại". Hai câu hỏi khác nhau
// và allowlist không bao giờ trả lời được câu thứ hai.
describe("gate ACL — danh sách cấm chặn việc mở lại cửa đã đóng", () => {
  const CAM = ["get_public_latest_invoice_by_contract(uuid)", "building_of_contract(uuid)"];

  it("báo lỗi khi một hàm trong danh sách cấm được cấp lại cho anon", () => {
    const kq = phanTichAcl({
      live: ["get_public_latest_invoice_by_code(text)", "get_public_latest_invoice_by_contract(uuid)"],
      baseline: ["get_public_latest_invoice_by_code(text)", "get_public_latest_invoice_by_contract(uuid)"],
      denylist: CAM,
    });

    expect(kq.viPhamCam).toEqual(["get_public_latest_invoice_by_contract(uuid)"]);
    expect(kq.dat).toBe(false);
  });

  it("nằm trong allowlist KHÔNG cứu được hàm bị cấm — đây chính là lỗ hổng cũ", () => {
    const kq = phanTichAcl({
      live: ["building_of_contract(uuid)"],
      baseline: ["building_of_contract(uuid)"], // được allowlist tha
      denylist: CAM,
    });

    expect(kq.dat).toBe(false);
    expect(kq.viPhamCam).toContain("building_of_contract(uuid)");
  });

  it("qua khi không hàm cấm nào anon gọi được", () => {
    const kq = phanTichAcl({
      live: ["get_public_latest_invoice_by_code(text)"],
      baseline: ["get_public_latest_invoice_by_code(text)"],
      denylist: CAM,
    });

    expect(kq.dat).toBe(true);
    expect(kq.viPhamCam).toEqual([]);
  });

  it("vẫn giữ nguyên luật cũ: hàm anon-executable MỚI ngoài allowlist là lỗi", () => {
    const kq = phanTichAcl({
      live: ["ham_moi_toanh(uuid)"],
      baseline: [],
      denylist: CAM,
    });

    expect(kq.dat).toBe(false);
    expect(kq.themMoi).toEqual(["ham_moi_toanh(uuid)"]);
  });

  it("hàm rời khỏi allowlist chỉ là thông tin, không phải lỗi (siết chặt là tốt)", () => {
    const kq = phanTichAcl({
      live: [],
      baseline: ["ham_cu(uuid)"],
      denylist: CAM,
    });

    expect(kq.dat).toBe(true);
    expect(kq.daBo).toEqual(["ham_cu(uuid)"]);
  });

  it("hàm bị cấm KHÔNG được phép nằm trong allowlist — hai danh sách mâu thuẫn là lỗi cấu hình", () => {
    // Nếu ai đó chạy --update trong lúc lỗ đang mở, allowlist sẽ nuốt lại hàm cấm.
    // Gate phải hét lên thay vì lặng lẽ chấp nhận.
    const kq = phanTichAcl({
      live: [],
      baseline: ["get_public_latest_invoice_by_contract(uuid)"],
      denylist: CAM,
    });

    expect(kq.dat).toBe(false);
    expect(kq.mauThuan).toContain("get_public_latest_invoice_by_contract(uuid)");
  });
});
