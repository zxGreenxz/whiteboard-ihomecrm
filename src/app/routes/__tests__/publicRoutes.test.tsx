import { describe, expect, it } from "vitest";
import { createRoutesFromChildren } from "react-router-dom";
import { publicRoutes } from "../publicRoutes";
import { PUBLIC_ROUTES } from "../../../../scripts/check-route-guards.mjs";

/**
 * I3.4 — /register bị BỎ HẲN (chủ quyết 15/09/2026).
 *
 * Vì sao cần test chứ không chỉ xoá code: `handle_new_user` dựng `profiles`
 * KHÔNG kèm organization_id, nên mọi tài khoản tự đăng ký là một hồ sơ mồ côi
 * — không thuộc công ty nào, không lọt chính sách biên giới, và không ai gỡ
 * được bằng giao diện. Đường tạo tài khoản duy nhất còn lại là edge function
 * `admin-create-user` (có org + vai).
 *
 * Route công khai là bề mặt tấn công; một lần "thêm lại cho tiện" là mở lại
 * đúng cái cửa đó. Test này neo quyết định lại.
 */

const duongDan = (children: typeof publicRoutes) =>
  createRoutesFromChildren(children).map((r) => r.path);

describe("publicRoutes — /register đã bị bỏ", () => {
  it("bảng route công khai không còn /register", () => {
    expect(duongDan(publicRoutes)).not.toContain("/register");
  });

  it("gate check-route-guards không còn liệt /register là route công khai hợp lệ", () => {
    expect([...PUBLIC_ROUTES.keys()]).not.toContain("/register");
  });

  it("các route công khai còn lại vẫn dựng được và có element", () => {
    const routes = createRoutesFromChildren(publicRoutes);
    expect(routes.length).toBeGreaterThanOrEqual(9);
    for (const r of routes) {
      expect(r.path, "route thiếu path").toBeTruthy();
      expect(r.element, `route ${r.path} không có element`).toBeTruthy();
    }
  });
});

describe("useAuth — không còn đường signUp trong ứng dụng", () => {
  it("module useAuth không xuất useRegister", async () => {
    const mod = await import("../../../hooks/useAuth");
    expect(Object.keys(mod)).not.toContain("useRegister");
  });
});
