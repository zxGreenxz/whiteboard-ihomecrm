// Sổ cho scripts/kiem-bao-mat-sau-khoi-phuc.mjs.
//
// Bộ kiểm này trả lời "bản DỰNG LẠI từ baseline + forward lane có sạch không"
// — SQL chép nguyên văn từ các gate production, còn LUẬT PHÂN TÍCH nằm ở
// phanTichBaoMat thuần tuý để kiểm được từng nhánh mà không cần database.
// Đột biến trên database thật đã chạy 13/08/2026: tắt invoker một view, GRANT
// anon một hàm denylist, tắt RLS một bảng → đỏ đúng ba phép, hoàn nguyên →
// xanh lại. Test dưới đây ghim từng luật để refactor sau không rụng nhánh nào.
import { describe, expect, it } from "vitest";

import {
  SAN_BANG_PUBLIC,
  SAN_SECURITY_DEFINER,
  phanTichBaoMat,
} from "../kiem-bao-mat-sau-khoi-phuc.mjs";

const SACH = {
  bangThieuRls: [],
  views: [{ view_name: "v1", relkind: "v", security_invoker: "true" }],
  definerThieuSearchPath: [],
  stableLocks: [],
  anonDefiner: ["get_public_latest_invoice_by_code(text)"],
  denylist: ["building_of_invoice(uuid)"],
};

describe("phanTichBaoMat", () => {
  it("mọi phép sạch → đạt", () => {
    expect(phanTichBaoMat(SACH)).toEqual({ dat: true, viPham: [] });
  });

  it("bảng thiếu RLS → hỏng", () => {
    const r = phanTichBaoMat({ ...SACH, bangThieuRls: ["account_shared_users"] });
    expect(r.dat).toBe(false);
    expect(r.viPham[0].phep).toContain("thiếu RLS");
  });

  it("view mất security_invoker → hỏng; so KHÔNG phân biệt hoa thường", () => {
    // reloptions có thể trả 'TRUE'/'true' tuỳ đường ghi — phép so phải chuẩn hoá,
    // nếu không một lần ALTER hợp lệ cũng bị chấm hở.
    const ok = phanTichBaoMat({ ...SACH, views: [{ view_name: "v1", relkind: "v", security_invoker: "TRUE" }] });
    expect(ok.dat).toBe(true);
    const hong = phanTichBaoMat({ ...SACH, views: [{ view_name: "v1", relkind: "v", security_invoker: "false" }] });
    expect(hong.dat).toBe(false);
    expect(hong.viPham[0].phep).toContain("security_invoker");
  });

  it("MATERIALIZED VIEW là vi phạm RIÊNG — không thể bật invoker, không được gộp vào view thường", () => {
    const r = phanTichBaoMat({ ...SACH, views: [...SACH.views, { view_name: "mv", relkind: "m", security_invoker: "false" }] });
    expect(r.dat).toBe(false);
    expect(r.viPham[0].phep).toContain("MATERIALIZED");
    expect(r.viPham[0].danhSach).toEqual(["mv"]);
  });

  it("SECURITY DEFINER thiếu search_path → hỏng", () => {
    const r = phanTichBaoMat({ ...SACH, definerThieuSearchPath: ["public.f()"] });
    expect(r.dat).toBe(false);
    expect(r.viPham[0].phep).toContain("search_path");
  });

  it("hàm STABLE chạm khoá dòng → hỏng, ghi rõ khoá đến từ đâu", () => {
    const r = phanTichBaoMat({
      ...SACH,
      stableLocks: [{ fn_name: "profit_close_state_v2", volatility: "STABLE", lock_from: "lock_org_for_decision_v1" }],
    });
    expect(r.dat).toBe(false);
    expect(r.viPham[0].danhSach[0]).toContain("lock_org_for_decision_v1");
  });

  it("hàm denylist mà anon gọi được → hỏng; hàm NGOÀI denylist anon gọi được thì KHÔNG", () => {
    // Trên bản khôi phục, default privileges của shim làm MỌI hàm anon-executable
    // — đó là artefact môi trường đo, không phải lỗ hổng. Chỉ denylist mới là
    // luật ở đây; chấm cả allowlist là biến gate thành báo động giả thường trực.
    const khongSao = phanTichBaoMat({ ...SACH, anonDefiner: ["ham_thuong(uuid)", "ham_khac()"] });
    expect(khongSao.dat).toBe(true);
    const hong = phanTichBaoMat({ ...SACH, anonDefiner: ["building_of_invoice(uuid)"] });
    expect(hong.dat).toBe(false);
    expect(hong.viPham[0].phep).toContain("DENYLIST");
  });

  it("nhiều phép hỏng cùng lúc → liệt kê ĐỦ, không dừng ở phép đầu", () => {
    const r = phanTichBaoMat({
      ...SACH,
      bangThieuRls: ["t"],
      definerThieuSearchPath: ["public.f()"],
      anonDefiner: ["building_of_invoice(uuid)"],
    });
    expect(r.dat).toBe(false);
    expect(r.viPham).toHaveLength(3);
  });
});

describe("sàn chống rỗng", () => {
  it("sàn phải nằm DƯỚI số đo production nhưng đủ cao để loại database trắng", () => {
    // Production: 316 bảng logic public, ~1000 SECURITY DEFINER (Contract §5).
    expect(SAN_BANG_PUBLIC).toBeGreaterThanOrEqual(100);
    expect(SAN_BANG_PUBLIC).toBeLessThanOrEqual(316);
    expect(SAN_SECURITY_DEFINER).toBeGreaterThanOrEqual(100);
    expect(SAN_SECURITY_DEFINER).toBeLessThanOrEqual(1000);
  });
});
