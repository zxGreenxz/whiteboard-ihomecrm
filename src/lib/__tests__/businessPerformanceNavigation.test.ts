import { readFileSync } from "node:fs";
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

  it("registers business performance as a standalone authenticated route", () => {
    expect(app).toContain(
      'const BusinessPerformanceReportPage = lazy(() => import("./pages/reports/finance/BusinessPerformanceReportPage"));',
    );
    expect(app).toContain(
      '<Route path="/reports/finance/business-performance" element={<ProtectedRoute><BusinessPerformanceReportPage /></ProtectedRoute>} />',
    );
  });

  it("keeps the legacy profit route independent from business performance organization access", () => {
    expect(app).not.toContain("ProfitDistributionRouteGuard");
    expect(app).toContain(
      '<Route path="/reports/finance/profit-distribution" element={<ProtectedRoute><ProfitHubPage /></ProtectedRoute>} />',
    );
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

  it("promotes the finance center while preserving legacy finance destinations", () => {
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

    expect(app).toContain(
      '<Route path="/reports/finance/analysis" element={<ProtectedRoute><RequirePermission module="reports_finance" action="analysis"><FinancialAnalysisReport /></RequirePermission></ProtectedRoute>} />',
    );
    expect(app).toContain(
      '<Route path="/reports/finance/profit-distribution" element={<ProtectedRoute><ProfitHubPage /></ProtectedRoute>} />',
    );
    expect(app).toContain(
      '<Route path="/report/finance/analysis" element={<Navigate to="/reports/finance/analysis" replace />} />',
    );
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
