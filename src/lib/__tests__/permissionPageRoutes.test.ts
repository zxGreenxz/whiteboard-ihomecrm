import { describe, expect, it } from "vitest";

import { ALL_PAGES } from "../permissionPages";

/**
 * `PermissionPage.route` phải trỏ tới một route CÓ THẬT và KHÔNG PHẢI redirect.
 *
 * VÌ SAO CÓ RĂNG — trường này không chỉ để hiển thị
 *   `src/copilot/banDoHeThong.ts` khớp `location.pathname` với `page.route` để
 *   biết người dùng đang đứng ở trang nào (`pathname.startsWith(page.route)`).
 *   Trỏ vào một route đã thành `<Navigate>` thì pathname thật KHÔNG BAO GIỜ bằng
 *   nó — người dùng ở `/settings/members` mà Copilot vẫn không nhận ra đó là
 *   trang "Phân quyền nhân viên". Hỏng im lặng, không lỗi nào nổ ra.
 *
 *   Đo 12/08/2026 lúc dựng test này: HAI trang đang trỏ redirect —
 *   `users` → `/settings/staff` và `shareholder_profit` →
 *   `/finance/shareholder-profit`. Cả hai là di chứng của việc gộp trang mà quên
 *   cập nhật picker.
 *
 * ĐỌC ROUTE THẬT, KHÔNG CHÉP TAY
 *   Danh sách route lấy từ `collectAllRoutes()` của chính gate route-guards, nên
 *   test kiểm mã thật chứ không kiểm một bản sao sẽ trôi.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { collectAllRoutes } = await import("../../../scripts/check-route-guards.mjs");

const ROUTES = collectAllRoutes();

/** Bỏ đuôi `/*` của route wildcard để so khớp chuỗi thuần dùng được. */
const chuanHoa = (p: string) => p.replace(/\/\*$/, "");

describe("PermissionPage.route trỏ tới route sống", () => {
  it("chống-xanh-rỗng: đọc được cả hai nguồn và chúng không rỗng", () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(100);
    expect(ALL_PAGES.length).toBeGreaterThanOrEqual(20);
    // Phải có ÍT NHẤT một redirect trong router, không thì phép kiểm dưới đây
    // không có gì để bắt và sẽ xanh vì lý do sai.
    expect(ROUTES.some((r) => r.redirect)).toBe(true);
  });

  it("mọi route khai trong picker đều TỒN TẠI trong router", () => {
    const co = new Set(ROUTES.map((r) => chuanHoa(r.path)));
    const la = ALL_PAGES.filter((p) => !co.has(chuanHoa(p.route))).map((p) => `${p.key} → ${p.route}`);
    expect(la, `trang trỏ route không có trong router: ${la.join(", ")}`).toEqual([]);
  });

  it("KHÔNG trang nào trỏ vào route redirect", () => {
    const redirect = new Set(ROUTES.filter((r) => r.redirect).map((r) => chuanHoa(r.path)));
    const la = ALL_PAGES.filter((p) => redirect.has(chuanHoa(p.route))).map((p) => `${p.key} → ${p.route}`);
    expect(
      la,
      `trang trỏ vào redirect nên Copilot không khớp được pathname: ${la.join(", ")}`,
    ).toEqual([]);
  });
});
