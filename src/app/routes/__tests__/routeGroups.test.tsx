import { describe, expect, it } from "vitest";
import { createRoutesFromChildren } from "react-router-dom";
import { settingsRoutes } from "../settingsRoutes";
import { financeReportRoutes } from "../financeReportRoutes";
import { realEstateReportRoutes } from "../realEstateReportRoutes";

/**
 * Chứng minh ở RUNTIME rằng các cụm route tách khỏi App.tsx vẫn được react-router
 * dựng thành bảng route đúng.
 *
 * Vì sao cần, chứ không chỉ dựa vào typecheck + gate AST:
 *   - Typecheck chỉ nói JSX hợp lệ, không nói react-router hiểu được cấu trúc.
 *   - Gate check-route-guards đọc VĂN BẢN nguồn: nó xác nhận route vẫn được khai
 *     ở đâu đó, nhưng không xác nhận RUNTIME nhìn thấy chúng.
 *
 * Cụm được xuất dưới dạng Fragment. `createRoutesFromChildren` của react-router 6
 * có đệ quy vào Fragment — ở đây khẳng định điều đó đúng với NỘI DUNG THẬT, không
 * phải với một ví dụ dựng sẵn.
 */

const CUM = [
  ["settingsRoutes", settingsRoutes, 25],
  ["financeReportRoutes", financeReportRoutes, 20],
  ["realEstateReportRoutes", realEstateReportRoutes, 10],
] as const;

describe("mọi cụm route tách ra đều dựng được bảng route", () => {
  it.each(CUM)("%s", (_ten, cum, toiThieu) => {
    const routes = createRoutesFromChildren(cum);
    expect(routes.length).toBeGreaterThanOrEqual(toiThieu);
    for (const r of routes) {
      expect(r.path, "route thiếu path").toBeTruthy();
      // Route không có element sẽ render trang trắng — hỏng im lặng, không lỗi.
      expect(r.element, `route ${r.path} không có element`).toBeTruthy();
    }
  });
});

describe("settingsRoutes giữ nguyên các đường dẫn then chốt", () => {
  const paths = createRoutesFromChildren(settingsRoutes).map((r) => r.path);

  it.each([
    "/settings/general",
    "/settings/categories",
    "/settings/categories/bank-accounts",
    "/settings/ai-copilot",
  ])("%s", (p) => {
    expect(paths).toContain(p);
  });
});
