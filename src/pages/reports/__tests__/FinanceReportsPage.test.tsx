import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FinanceReportsPage from "@/pages/reports/FinanceReportsPage";

const mocks = vi.hoisted(() => {
  const permissionState = {
    data: undefined as unknown,
    isError: false,
  };
  const businessPerformanceState = {
    data: [] as Array<{ id: string }>,
    isSuccess: true,
    isLoading: false,
    isError: false,
  };

  return {
    permissionState,
    businessPerformanceState,
    useMyPermissions: vi.fn(() => permissionState),
    useBusinessPerformanceOrganizations: vi.fn(
      () => businessPerformanceState,
    ),
  };
});

vi.mock("@/hooks/useMyPermissions", () => ({
  useMyPermissions: mocks.useMyPermissions,
}));

vi.mock("@/hooks/reports/useBusinessPerformance", () => ({
  useBusinessPerformanceOrganizations:
    mocks.useBusinessPerformanceOrganizations,
}));

vi.mock("@/components/layout/MainLayout", () => ({
  default: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
}));

const legacyReportPaths = [
  "/reports/finance/analysis",
  "/reports/finance/ban-giao",
  "/reports/finance/thu-ban-giao",
  "/reports/finance/daily-cashbook",
  "/reports/finance/cash-flow",
  "/reports/finance/profit-distribution",
  "/reports/finance/payment-schedule",
  "/reports/finance/overpayment",
  "/reports/finance/deposits",
];

const renderPage = () =>
  renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location: "/reports/finance" },
      createElement(FinanceReportsPage),
    ),
  );

const expectLegacyCatalog = (markup: string) => {
  for (const path of legacyReportPaths) {
    expect(markup).toContain(`href="${path}"`);
  }
};

const expectBusinessPerformanceHidden = (markup: string) => {
  expect(markup).not.toContain(
    'href="/reports/finance/business-performance"',
  );
  expect(markup).toContain(">9 lo");
};

describe("FinanceReportsPage catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissionState.data = undefined;
    mocks.permissionState.isError = false;
    mocks.businessPerformanceState.data = [];
    mocks.businessPerformanceState.isSuccess = true;
    mocks.businessPerformanceState.isLoading = false;
    mocks.businessPerformanceState.isError = false;
  });

  it("keeps all legacy cards when finance actions are explicitly denied", () => {
    mocks.permissionState.data = {
      reports_finance: {
        view: true,
        analysis: false,
        profit_distribution: false,
      },
    };

    const markup = renderPage();

    expectLegacyCatalog(markup);
    expectBusinessPerformanceHidden(markup);
    expect(mocks.useMyPermissions).not.toHaveBeenCalled();
  });

  it("keeps all legacy cards when loading permissions fails", () => {
    mocks.permissionState.isError = true;

    const markup = renderPage();

    expectLegacyCatalog(markup);
    expectBusinessPerformanceHidden(markup);
    expect(mocks.useMyPermissions).not.toHaveBeenCalled();
  });

  it.each([
    ["loading", { data: [], isSuccess: false, isLoading: true, isError: false }],
    ["error", { data: [], isSuccess: false, isLoading: false, isError: true }],
    ["empty", { data: [], isSuccess: true, isLoading: false, isError: false }],
  ])("hides only Business Performance while organizations are %s", (_, state) => {
    Object.assign(mocks.businessPerformanceState, state);

    const markup = renderPage();

    expectLegacyCatalog(markup);
    expectBusinessPerformanceHidden(markup);
  });

  it("adds Business Performance when at least one organization is authorized", () => {
    mocks.permissionState.data = {
      reports_finance: {
        view: true,
        analysis: false,
        profit_distribution: false,
      },
    };
    mocks.businessPerformanceState.data = [{ id: "authorized-org" }];

    const markup = renderPage();

    expectLegacyCatalog(markup);
    expect(markup).toContain(
      'href="/reports/finance/business-performance"',
    );
    expect(markup).toContain(">10 lo");
    expect(mocks.useMyPermissions).not.toHaveBeenCalled();
  });
});
