import { describe, expect, it } from "vitest";
import { createRoutesFromChildren } from "react-router-dom";
import { settingsRoutes } from "../settingsRoutes";
import { financeReportRoutes } from "../financeReportRoutes";
import { realEstateReportRoutes } from "../realEstateReportRoutes";
import { quickTrackRoutes } from "../quickTrackRoutes";
import { catalogRoutes } from "../catalogRoutes";
import { customerRoutes } from "../customerRoutes";
import { financeWorkRoutes } from "../financeWorkRoutes";
import { salaryProfitRoutes } from "../salaryProfitRoutes";
import { adminAccountRoutes } from "../adminAccountRoutes";

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
 * có đệ quy vào Fragment — ở đây khẳng định điều đó đúng với NỘI DUNG THẬT.
 */

// Số tối thiểu ở đây là số route RUNTIME, có thể NHỎ HƠN số gate đếm tĩnh.
// Lý do: một số route bọc trong cờ tính năng —
//   {NETWORK_CENTER_RUNTIME_ENABLED ? <Route … /> : null}
// Gate check-route-guards đọc AST nên vẫn THẤY và vẫn kiểm guard của chúng (đúng:
// route tắt cờ hôm nay có thể bật ngày mai, guard phải đúng sẵn). Còn ở đây cờ mặc
// định TẮT nên react-router chỉ dựng phần đang bật. Hai con số lệch nhau là ĐÚNG,
// không phải lỗi — ghi lại để lần sau không ai "sửa" cho khớp.
const CUM = [
  ["quickTrackRoutes", quickTrackRoutes, 4],
  ["catalogRoutes", catalogRoutes, 14],
  ["customerRoutes", customerRoutes, 14],
  ["financeWorkRoutes", financeWorkRoutes, 16],
  ["financeReportRoutes", financeReportRoutes, 20],
  ["realEstateReportRoutes", realEstateReportRoutes, 10],
  ["salaryProfitRoutes", salaryProfitRoutes, 5],
  ["settingsRoutes", settingsRoutes, 25],
  ["adminAccountRoutes", adminAccountRoutes, 10],
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

describe("không cụm nào khai trùng đường dẫn với cụm khác", () => {
  it("mỗi path chỉ thuộc đúng một cụm", () => {
    const thay = new Map<string, string>();
    const trung: string[] = [];
    for (const [ten, cum] of CUM) {
      for (const r of createRoutesFromChildren(cum)) {
        const p = r.path ?? "(index)";
        if (thay.has(p)) trung.push(`${p}: ${thay.get(p)} vs ${ten}`);
        else thay.set(p, ten);
      }
    }
    // Trùng path giữa hai cụm nghĩa là một cụm sẽ không bao giờ được dùng tới cho
    // đường dẫn đó — và không có gì báo, vì react-router chỉ lặng lẽ chọn một.
    expect(trung).toEqual([]);
  });
});

describe("các đường dẫn then chốt vẫn còn", () => {
  const tatCa = new Set(
    CUM.flatMap(([, cum]) => createRoutesFromChildren(cum).map((r) => r.path)),
  );

  it.each([
    "/settings/general",
    "/settings/categories/bank-accounts",
    "/customers/:id",
    "/tenants/:id",
    "/invoices",
    "/reports/finance/analysis",
    "/reports/finance/profit-distribution",
  ])("%s", (p) => {
    expect(tatCa).toContain(p);
  });
});
