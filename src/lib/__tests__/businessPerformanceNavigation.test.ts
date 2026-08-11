import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionsMap } from "@/hooks/useMyPermissions";
import Sidebar from "@/components/layout/Sidebar";
import FinanceReportsPage from "@/pages/reports/FinanceReportsPage";

const permissionState = vi.hoisted(() => ({
  current: undefined as PermissionsMap | undefined,
}));

const organizationState = vi.hoisted(() => ({
  current: {
    data: undefined as Array<{ id: string }> | undefined,
    isSuccess: false,
    isLoading: true,
    isError: false,
  },
}));

vi.mock("@/hooks/useMyPermissions", () => ({
  useMyPermissions: () => ({
    data: permissionState.current,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/reports/useBusinessPerformance", () => ({
  useBusinessPerformanceOrganizations: () => organizationState.current,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ data: { id: "user-a", email: "user@example.com" } }),
  // Sidebar dựng luôn khối tài khoản + nút đăng xuất ở chân (desktop đã bỏ header).
  useLogout: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/useProfile", () => ({
  useProfile: () => ({ data: { full_name: "Test User" } }),
}));

vi.mock("@/components/layout/MainLayout", () => ({
  default: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
}));

const readSource = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const app = readSource("src/App.tsx");
const sidebar = readSource("src/components/layout/Sidebar.tsx");
const financeReports = readSource("src/pages/reports/FinanceReportsPage.tsx");
const businessPerformance = readSource(
  "src/pages/reports/finance/BusinessPerformanceReportPage.tsx",
);
const financialAnalysis = readSource(
  "src/pages/reports/finance/FinancialAnalysisReport.tsx",
);
const profitHub = readSource(
  "src/pages/reports/finance/ProfitHubPage.tsx",
);
const breadcrumbs = readSource("src/components/layout/Breadcrumbs.tsx");

type OrganizationStatus = "success" | "empty" | "loading" | "error";

const setOrganizationStatus = (status: OrganizationStatus) => {
  organizationState.current = {
    data:
      status === "success"
        ? [{ id: "dddd0000-0000-0000-0000-000000000001" }]
        : status === "empty"
          ? []
          : undefined,
    isSuccess: status === "success" || status === "empty",
    isLoading: status === "loading",
    isError: status === "error",
  };
};

const renderAt = (location: string, child: ReactNode) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(StaticRouter, { location }, child),
    ),
  );
};

const renderFinanceReports = (
  permissions: PermissionsMap,
  organizationStatus: OrganizationStatus,
) => {
  permissionState.current = permissions;
  setOrganizationStatus(organizationStatus);
  return renderAt(
    "/reports/finance",
    createElement(FinanceReportsPage),
  );
};

const renderSidebar = (
  permissions: PermissionsMap,
  organizationStatus: OrganizationStatus,
) => {
  permissionState.current = permissions;
  setOrganizationStatus(organizationStatus);
  return renderAt(
    "/reports/finance/business-performance",
    createElement(Sidebar),
  );
};

const renderAllNavigation = (
  permissions: PermissionsMap,
  organizationStatus: OrganizationStatus,
) => [
  renderSidebar(permissions, organizationStatus),
  renderFinanceReports(permissions, organizationStatus),
];

describe("business performance navigation", () => {
  beforeEach(() => {
    permissionState.current = undefined;
    setOrganizationStatus("loading");
  });

  // Hai ca dưới đây khẳng định CẤU TRÚC route, nên đọc AST thay vì so nguyên văn
  // một dòng JSX. Bản cũ khoá cả dấu cách và thứ tự thuộc tính: đổi chỗ xuống
  // dòng là đỏ, dù hành vi không đổi — và chính nó chặn việc tách App.tsx.
  it("registers business performance as a standalone authenticated route", async () => {
    const { collectAllRoutes } = await import("../../../scripts/check-route-guards.mjs");
    const routes = collectAllRoutes();
    const route = routes.find(
      (r: { path: string }) => r.path === "/reports/finance/business-performance",
    );

    expect(route, "route business-performance phải tồn tại").toBeDefined();
    // Chỉ cần đăng nhập, KHÔNG gắn thêm RequirePermission: quyền xem do chính
    // trang quyết theo tổ chức, nên thêm cổng quyền ở đây sẽ chặn nhầm.
    expect(route!.guards).toEqual(["ProtectedRoute"]);
    // Khai báo lazy đã tách sang src/app/lazyPages.ts (Đợt 4).
    expect(readSource("src/app/lazyPages.ts")).toMatch(
      /BusinessPerformanceReportPage\s*=\s*lazy\(/,
    );
  });

  it("keeps the legacy profit route independent from business performance organization access", async () => {
    const { collectAllRoutes } = await import("../../../scripts/check-route-guards.mjs");
    const routes = collectAllRoutes();
    const route = routes.find(
      (r: { path: string }) => r.path === "/reports/finance/profit-distribution",
    );

    expect(route, "route profit-distribution phải tồn tại").toBeDefined();
    expect(route!.guards).toEqual(["ProtectedRoute"]);
    // ProfitDistributionRouteGuard từng tồn tại và đã bị gỡ; nó gắn quyền xem lợi
    // nhuận vào trạng thái TỔ CHỨC, làm route cũ phụ thuộc thứ nó không nên biết.
    //
    // SOI ĐÚNG FILE — sửa 08/08/2026. Bản trước khẳng định trên `app`
    // (`src/App.tsx`), nhưng cây route đã dời sang `src/app/routes/` ở P1.2 nên
    // App.tsx chỉ còn 71 dòng vỏ. Khẳng định vẫn XANH, nhưng xanh vì soi nhầm
    // file: ai đó thêm lại guard vào src/app/routes/* thì test này không thấy.
    // Một khẳng định rỗng nghĩa tệ hơn không có — nó chiếm chỗ và trông như đang canh.
    const nguonRoute = [
      "src/App.tsx",
      "src/app/lazyPages.ts",
      ...readdirSync(resolve(process.cwd(), "src/app/routes"))
        .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
        .map((f) => `src/app/routes/${f}`),
    ];
    // Chống-xanh-rỗng: gom được quá ít file nghĩa là đường dẫn sai, và khi đó
    // "không tìm thấy chuỗi" không chứng minh gì.
    expect(nguonRoute.length).toBeGreaterThanOrEqual(8);
    for (const f of nguonRoute) {
      expect(readSource(f), `${f} không được nhắc ProfitDistributionRouteGuard`).not.toContain(
        "ProfitDistributionRouteGuard",
      );
    }
  });

  it("does not embed business performance into the profit hub", () => {
    expect(profitHub).not.toContain("BusinessPerformanceReportPage");
    expect(profitHub).not.toContain("finance-performance");
  });

  it("keeps legacy financial analysis isolated from business performance", () => {
    expect(financialAnalysis).not.toContain("BusinessPerformanceReportPage");
    expect(financialAnalysis).not.toContain("finance-performance");
    expect(financialAnalysis).not.toContain(
      "/reports/finance/business-performance",
    );
  });

  it("promotes the finance center while preserving legacy finance destinations", async () => {
    const { collectAllRoutes } = await import("../../../scripts/check-route-guards.mjs");
    const all = collectAllRoutes();
    const routeGuards = new Map(all.map((r: { path: string; guards: string[] }) => [r.path, r.guards]));
    const routeRedirect = new Map(all.map((r: { path: string; redirect: boolean }) => [r.path, r.redirect]));
    expect(sidebar).toContain(
      "{ title: 'Trung t\u00e2m t\u00e0i ch\u00ednh', href: '/reports/finance/business-performance', icon: BarChart3, requiresBusinessPerformanceOrganization: true }",
    );
    expect(sidebar).toContain(
      "{ title: 'Ph\u00e2n t\u00edch t\u00e0i ch\u00ednh', href: '/reports/finance/analysis', icon: BarChart3, module: 'reports_finance', action: 'analysis' }",
    );
    expect(sidebar).toContain("href: '/reports/finance/profit-distribution'");

    expect(financeReports).toContain('title: "Trung t\u00e2m T\u00e0i ch\u00ednh & Hi\u1ec7u qu\u1ea3"');
    expect(financeReports).toContain('path: "/reports/finance/business-performance"');
    expect(financeReports).toContain('title: "Ph\u00e2n t\u00edch t\u00e0i ch\u00ednh"');
    expect(financeReports).toContain('path: "/reports/finance/analysis"');
    expect(financeReports).toContain('path: "/reports/finance/profit-distribution"');
    expect(financeReports).not.toContain("useMyPermissions");

    expect(breadcrumbs).toContain(
      "'/reports/finance/business-performance': 'Trung t\u00e2m T\u00e0i ch\u00ednh & Hi\u1ec7u qu\u1ea3'",
    );
    expect(breadcrumbs).toContain(
      "'/reports/finance/analysis': 'Ph\u00e2n t\u00edch t\u00e0i ch\u00ednh'",
    );

    // Ba khẳng định route dưới đây từng so NGUYÊN VĂN một dòng JSX trong App.tsx.
    // Chúng đỏ ngay khi nhóm route tài chính được tách sang src/app/routes/ — dù
    // hành vi không đổi một chút nào. Nay đọc DỮ LIỆU route gom từ mọi file, nên
    // bám theo route chứ không bám theo file.
    expect(routeGuards.get("/reports/finance/analysis")).toEqual([
      "ProtectedRoute",
      "RequirePermission",
    ]);
    expect(routeGuards.get("/reports/finance/profit-distribution")).toEqual(["ProtectedRoute"]);
    // Route cũ giữ lại làm redirect: link đã phát ra ngoài không được chết.
    expect(routeRedirect.get("/report/finance/analysis")).toBe(true);
  });

  it("keeps profit navigation independent from organization access checks", () => {
    expect(sidebar).not.toContain("useProfitDistributionAccess");
    expect(sidebar).not.toContain("isProfitDistributionRoute");
    expect(financeReports).not.toContain("useProfitDistributionAccess");
    expect(financeReports).not.toContain("requiresProfitDistributionAccess");
  });

  it("keeps legacy analysis in the catalog while Sidebar remains permission-gated", () => {
    const permissions = {
      reports_finance: {
        view: true,
        analysis: false,
        profit_distribution: true,
      },
    };
    const gatedSidebar = renderSidebar(permissions, "success");

    expect(gatedSidebar).toContain('href="/reports/finance/business-performance"');
    expect(gatedSidebar).not.toContain('href="/reports/finance/analysis"');
    expect(gatedSidebar).toContain('href="/reports/finance/profit-distribution"');

    const catalog = renderFinanceReports(permissions, "success");

    expect(catalog).toContain('href="/reports/finance/business-performance"');
    expect(catalog).toContain('href="/reports/finance/analysis"');
    expect(catalog).toContain('href="/reports/finance/profit-distribution"');
  });

  it.each(["empty", "loading", "error"] as const)(
    "hides only business performance when the organization roster is %s",
    (organizationStatus) => {
      const htmlBySurface = renderAllNavigation(
        {
          reports_finance: {
            view: true,
            analysis: true,
            profit_distribution: true,
          },
        },
        organizationStatus,
      );

      for (const html of htmlBySurface) {
        expect(html).not.toContain('href="/reports/finance/business-performance"');
        expect(html).toContain('href="/reports/finance/analysis"');
        expect(html).toContain('href="/reports/finance/profit-distribution"');
      }
    },
  );

  it("keeps profit navigation on its legacy permission behavior", () => {
    const deniedSidebar = renderSidebar(
      { reports_finance: { view: true, profit_distribution: false } },
      "success",
    );
    const allowedSidebar = renderSidebar(
      { reports_finance: { view: true, profit_distribution: true } },
      "error",
    );

    expect(deniedSidebar).not.toContain('href="/reports/finance/profit-distribution"');
    expect(allowedSidebar).toContain('href="/reports/finance/profit-distribution"');
  });

  it.each([
    { analysis: false, organizationStatus: "success" as const, expectedCount: 10 },
    { analysis: true, organizationStatus: "success" as const, expectedCount: 10 },
    { analysis: true, organizationStatus: "empty" as const, expectedCount: 9 },
  ])(
    "describes $expectedCount visible reports for analysis=$analysis and roster=$organizationStatus",
    ({ analysis, organizationStatus, expectedCount }) => {
      const html = renderFinanceReports({
        reports_finance: { view: true, analysis },
      }, organizationStatus);

      expect(html).toContain(
        `${expectedCount} lo\u1ea1i b\u00e1o c\u00e1o ph\u00e2n t\u00edch t\u00e0i ch\u00ednh v\u00e0 d\u00f2ng ti\u1ec1n`,
      );
    },
  );

  it("links all permitted finance destinations to their canonical routes", () => {
    const html = renderFinanceReports({
      reports_finance: { view: true, analysis: true },
    }, "success");

    expect(html).toContain(
      'href="/reports/finance/business-performance"',
    );
    expect(html).toContain('href="/reports/finance/analysis"');
    expect(html).toContain('href="/reports/finance/profit-distribution"');
  });
});
