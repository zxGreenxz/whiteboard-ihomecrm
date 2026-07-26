import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfitManager } from "@/hooks/useProfitManagers";
import type { Shareholder } from "@/hooks/useShareholders";

const shareholder: Shareholder = {
  id: "shareholder-a",
  user_id: "user-a",
  auth_user_id: "auth-a",
  name: "Shareholder A",
  note: null,
  is_active: true,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  deleted_at: null,
};

const manager: ProfitManager = {
  id: "manager-a",
  user_id: "user-a",
  auth_user_id: "auth-a",
  name: "Manager A",
  note: null,
  is_active: true,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  deleted_at: null,
};

const harness = vi.hoisted(() => ({
  phone: false,
  permissionHook: vi.fn(),
  shareholderHook: vi.fn(),
  managerHook: vi.fn(),
  profitCloseHook: vi.fn(),
  reportRender: vi.fn(),
  overviewRender: vi.fn(),
  shareholderRender: vi.fn(),
  managerRender: vi.fn(),
  mobileRender: vi.fn(),
}));

vi.mock("@/hooks/use-mobile", () => ({
  usePhoneViewport: () => harness.phone,
}));

vi.mock("@/hooks/useMyPermissions", () => ({
  useMyPermissions: () => harness.permissionHook(),
}));

vi.mock("@/hooks/useShareholders", () => ({
  useMyShareholder: () => harness.shareholderHook(),
}));

vi.mock("@/hooks/useProfitManagers", () => ({
  useMyProfitManager: () => harness.managerHook(),
}));

vi.mock("@/hooks/useShareholderProfit", () => ({
  useProfitCloseOrganizations: () => harness.profitCloseHook(),
}));

vi.mock("@/components/layout/MainLayout", () => ({
  default: ({ children }: { children?: ReactNode }) =>
    createElement("main", null, children),
}));

// Khung hero + tab pill (Radix Tabs) chỉ mount tab ĐANG mở. Test này soi "trang
// dựng ra những tab nào theo quyền" nên mock khung để mọi panel cùng render, kèm
// nhãn tab để khẳng định thứ tự/label.
vi.mock("@/pages/reports/finance/ProfitHubShell", () => ({
  default: ({
    tabs,
    children,
  }: {
    tabs?: { value: string; label: string }[];
    children?: ReactNode;
  }) =>
    createElement(
      Fragment,
      null,
      (tabs ?? []).map((t) =>
        createElement("span", { key: t.value, "data-tab": t.value }, t.label),
      ),
      children,
    ),
  ProfitHubTabPanel: ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children),
  ProfitHubSlot: ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children),
}));

vi.mock("@/pages/reports/finance/ProfitDistributionReport", () => ({
  default: () => {
    harness.reportRender();
    return createElement("div", { "data-probe": "report" });
  },
}));

vi.mock("@/components/shareholders/ProfitOverviewTab", () => ({
  default: () => {
    harness.overviewRender();
    return createElement("div", { "data-probe": "overview" });
  },
}));

vi.mock("@/components/shareholders/ProfitLockTab", () => ({
  default: () => createElement("div"),
}));

vi.mock("@/components/shareholders/ShareConfigTab", () => ({
  default: () => createElement("div"),
}));

vi.mock("@/components/shareholders/ShareholderSelfView", () => ({
  default: ({ me }: { me: Shareholder }) => {
    harness.shareholderRender(me);
    return createElement("div", { "data-probe": "shareholder-self" });
  },
}));

vi.mock("@/components/shareholders/ProfitManagerSelfView", () => ({
  default: ({ me }: { me: ProfitManager }) => {
    harness.managerRender(me);
    return createElement("div", { "data-probe": "manager-self" });
  },
}));

vi.mock("@/pages/reports/finance/ProfitHubMobile", () => ({
  ProfitMobileBoot: () => createElement("div", { "data-probe": "mobile-boot" }),
  default: (props: unknown) => {
    harness.mobileRender(props);
    return createElement("div", { "data-probe": "mobile" });
  },
}));

import ProfitHubPage from "../ProfitHubPage";

function renderPage() {
  return renderToStaticMarkup(createElement(ProfitHubPage));
}

describe("ProfitHubPage legacy permission behavior", () => {
  beforeEach(() => {
    harness.phone = false;
    harness.permissionHook.mockReset().mockReturnValue({
      data: {},
      isLoading: false,
    });
    harness.shareholderHook.mockReset().mockReturnValue({
      data: null,
      isLoading: false,
    });
    harness.managerHook.mockReset().mockReturnValue({
      data: null,
      isLoading: false,
    });
    harness.profitCloseHook.mockReset().mockReturnValue({
      data: [],
      isLoading: false,
    });
    harness.reportRender.mockReset();
    harness.overviewRender.mockReset();
    harness.shareholderRender.mockReset();
    harness.managerRender.mockReset();
    harness.mobileRender.mockReset();
  });

  it("keeps the report-authorized shareholder own-share tab without shareholder_profit.view", () => {
    harness.permissionHook.mockReturnValue({
      data: {
        reports_finance: { profit_distribution: true },
        shareholder_profit: { view: false },
      },
      isLoading: false,
    });
    harness.shareholderHook.mockReturnValue({
      data: shareholder,
      isLoading: false,
    });

    const html = renderPage();

    expect(html).toContain('data-probe="report"');
    expect(html).toContain('data-probe="shareholder-self"');
    expect(harness.shareholderRender).toHaveBeenCalledWith(shareholder);
    expect(harness.overviewRender).not.toHaveBeenCalled();
  });

  it("keeps the manager-only salary fallback when no report tabs are allowed", () => {
    harness.managerHook.mockReturnValue({ data: manager, isLoading: false });

    const html = renderPage();

    expect(html).toContain('data-probe="manager-self"');
    expect(harness.reportRender).not.toHaveBeenCalled();
    expect(harness.overviewRender).not.toHaveBeenCalled();
  });

  it("passes the legacy permission results to the mobile hub", () => {
    harness.phone = true;
    harness.permissionHook.mockReturnValue({
      data: { reports_finance: { profit_distribution: true } },
      isLoading: false,
    });
    harness.shareholderHook.mockReturnValue({
      data: shareholder,
      isLoading: false,
    });
    harness.managerHook.mockReturnValue({ data: manager, isLoading: false });

    renderPage();

    expect(harness.mobileRender).toHaveBeenCalledWith({
      canReport: true,
      isManager: false,
      me: shareholder,
      myManager: manager,
    });
  });
});
