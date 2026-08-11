// Sổ cho scripts/check-route-permission-drift.mjs và helper boChuThichJsx.
//
// Route guard là nơi thứ tư đọc `capability.permission`, và là nơi duy nhất còn
// khai tay. Lệch ở đây tệ hơn ba nơi kia: sidebar lệch thì người dùng thấy một
// mục không bấm được (phiền, nhìn ra ngay), còn route guard lệch thì trang MỞ
// ĐƯỢC bằng cách gõ thẳng URL và không có triệu chứng nào cho tới khi ai đó thử.
import { describe, expect, it } from "vitest";

import { boChuThichJs, boChuThichJsx } from "../lib/bo-chu-thich.mjs";
import { docRegistry, quyenCuaGuard, quyenCuaRoute } from "../check-route-permission-drift.mjs";

describe("boChuThichJsx — vì sao cần bản riêng cho JSX", () => {
  it("chuỗi `path=\"/x/*\"` KHÔNG bị nuốt, dù có `*/` xuất hiện sau đó", () => {
    // Đây là ca đã làm gate báo sai 11/08/2026. `/*` bên trong chuỗi đường dẫn bị
    // bộ bỏ khối TRẦN coi là dấu mở comment, rồi nuốt tới `*​/` gần nhất — mà `*​/`
    // đó thường nằm ở một file khác sau khi nối. Kết quả: dòng route đang tìm biến
    // mất, và gate kết luận "không tìm thấy route" — SAI, không phải thiếu.
    const nguon = '<Route path="/x/*" />\nconst a = 1; /* chú thích ở file sau */';
    expect(boChuThichJs(nguon).includes('path="/x/*"')).toBe(false); // bản trần: mất
    expect(boChuThichJsx(nguon).includes('path="/x/*"')).toBe(true); // bản JSX: còn
  });

  it("chú thích JSX `{/* … */}` vẫn bị bỏ — route bị comment không được tính", () => {
    expect(boChuThichJsx('{/* <Route path="/cu" /> */}').includes("/cu")).toBe(false);
  });

  it("`//` đầu dòng vẫn bị bỏ", () => {
    expect(boChuThichJsx('// <Route path="/cu" />\n<Route path="/moi" />')).not.toContain("/cu");
  });
});

describe("quyenCuaRoute — bốn trạng thái, không gộp", () => {
  const routeTrucTiep = '<Route path="/x/*" element={<RequirePermission module="m" action="a"><P/></RequirePermission>} />';

  it("guard RequirePermission ⇒ đọc thẳng module/action", () => {
    expect(quyenCuaRoute(routeTrucTiep, "/x")).toEqual({ loai: "truc-tiep", module: "m", action: "a" });
  });

  it("khớp cả dạng `/x` lẫn `/x/*` — registry khai không có sao", () => {
    expect(quyenCuaRoute('<Route path="/y" element={<RequirePermission module="m" action="a"/>} />', "/y").loai)
      .toBe("truc-tiep");
  });

  it("guard riêng ⇒ trả TÊN guard, không đoán quyền", () => {
    const r = quyenCuaRoute('<Route path="/z" element={<OpenClawRouteGuard><P/></OpenClawRouteGuard>} />', "/z");
    expect(r).toEqual({ loai: "guard-rieng", ten: "OpenClawRouteGuard" });
  });

  it("route KHÔNG có guard nào ⇒ trạng thái riêng (đây là vi phạm, không phải 'không đọc được')", () => {
    expect(quyenCuaRoute('<Route path="/w" element={<P/>} />', "/w").loai).toBe("khong-thay-guard");
  });

  it("không tìm thấy route ⇒ trạng thái riêng (đây là KHÔNG ĐO ĐƯỢC, exit 3)", () => {
    // Hai thứ này phải tách: "route không có guard" là lỗi của mã, còn "không tìm
    // thấy route" là lỗi của phép đo. Gộp lại thì một bộ bóc hỏng sẽ trông như
    // một loạt route mất guard.
    expect(quyenCuaRoute(routeTrucTiep, "/khong-co").loai).toBe("khong-thay-route");
  });
});

describe("docRegistry và quyenCuaGuard", () => {
  it("bóc được id/route/permission từ dạng khai của registry", () => {
    const nguon = `export const CAPABILITIES = [
  {
    id: "abc",
    primaryRoute: "/abc",
    permission: { module: "m", action: "view" },
  },
];`;
    expect(docRegistry(nguon)).toEqual([{ id: "abc", primaryRoute: "/abc", module: "m", action: "view" }]);
  });

  it("guard riêng khai VIEW_PERMISSION ⇒ tách được module.action", () => {
    expect(quyenCuaGuard('const OPENCLAW_VIEW_PERMISSION = "openclaw_zalo.view";'))
      .toEqual({ module: "openclaw_zalo", action: "view" });
  });

  it("guard không khai theo khuôn đó ⇒ null, KHÔNG đoán bừa", () => {
    // null dẫn tới exit 3 ở phía gọi: "chưa hiểu cách guard này khai" khác hẳn
    // "quyền khớp".
    expect(quyenCuaGuard("const x = 1;")).toBeNull();
  });
});
