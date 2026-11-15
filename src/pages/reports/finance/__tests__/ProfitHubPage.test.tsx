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
  search: "",
  phone: false,
  permissionHook: vi.fn(),
  shareholderHook: vi.fn(),
  managerHook: vi.fn(),
  profitCloseHook: vi.fn(),
  reportRender: vi.fn(),
  overviewRender: vi.fn(),
  shareholderRender: vi.fn(),
  advanceRender: vi.fn(),
  managerRender: vi.fn(),
  mobileRender: vi.fn(),
}));

vi.mock("@/hooks/use-mobile", () => ({
  usePhoneViewport: () => harness.phone,
}));

// `?tab=` của trang: chỉ cần useSearchParams (render tĩnh, không dựng Router).
vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(harness.search), vi.fn()],
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
    value,
    children,
  }: {
    tabs?: { value: string; label: string }[];
    value?: string;
    children?: ReactNode;
  }) =>
    createElement(
      Fragment,
      null,
      createElement("i", { "data-active": value ?? "" }),
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
  default: ({ me, ...access }: { me: Shareholder }) => {
    harness.shareholderRender(me, access);
    return createElement("div", { "data-probe": "shareholder-self" });
  },
}));

vi.mock("@/components/shareholders/ShareholderAdvanceTab", () => ({
  default: (props: { me: Shareholder; phone?: boolean }) => {
    harness.advanceRender(props);
    return createElement("div", { "data-probe": "advance" });
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

function renderPage(url = "/reports/finance/profit-distribution") {
  harness.search = url.includes("?") ? url.slice(url.indexOf("?")) : "";
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
    harness.advanceRender.mockReset();
    harness.managerRender.mockReset();
    harness.mobileRender.mockReset();
  });

  it("failed identity source shows recoverable error, not access denied or zero profit", () => {
    harness.shareholderHook.mockReturnValue({data:undefined,isLoading:false,isError:true,error:{message:'private_table'},refetch:vi.fn()});
    const html=renderPage();
    expect(html).toContain('Chưa tải được quyền xem và hồ sơ lợi nhuận');
    expect(html).not.toContain('Bạn không có quyền');
    expect(html).not.toContain('private_table');
    expect(harness.overviewRender).not.toHaveBeenCalled();
  });

  it("Đợt 2: report-authorized shareholder WITHOUT view_building_totals keeps the own-share tab but loses the BC tab", () => {
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

    expect(html).not.toContain('data-tab="report"');
    expect(html).not.toContain('data-probe="report"');
    expect(html).toContain('data-tab="my-overview"');
    expect(html).toContain('data-probe="shareholder-self"');
    expect(html).not.toContain('data-tab="my-advance"');
    expect(harness.shareholderRender).toHaveBeenCalledWith(shareholder, {
      canViewPercent: false,
      canViewBuildingTotals: false,
      canAdvanceOwn: false,
    });
    expect(harness.overviewRender).not.toHaveBeenCalled();
  });

  it("Đợt 2: the same shareholder granted view_building_totals gets the BC tab back; view flags reach the own view", () => {
    harness.permissionHook.mockReturnValue({
      data: {
        reports_finance: { profit_distribution: true },
        shareholder_profit: { view_building_totals: true, view_percent: true, advance_own_cashbook: true },
      },
      isLoading: false,
    });
    harness.shareholderHook.mockReturnValue({ data: shareholder, isLoading: false });

    const html = renderPage();

    expect(html).toContain('data-tab="report"');
    expect(html).toContain('data-tab="my-overview"');
    // Có tab tự xem ⇒ nút tạm ứng nằm trong đó, không thêm tab "Tạm ứng LN".
    expect(html).not.toContain('data-tab="my-advance"');
    expect(harness.shareholderRender).toHaveBeenCalledWith(shareholder, {
      canViewPercent: true,
      canViewBuildingTotals: true,
      canAdvanceOwn: true,
    });
  });

  it("Đợt 2: advance-only shareholder (no report page) sees ONLY the Tạm ứng LN tab and is not a manager", () => {
    harness.permissionHook.mockReturnValue({
      data: { shareholder_profit: { advance_own_cashbook: { org_wide: true, building_ids: [] } } },
      isLoading: false,
    });
    harness.shareholderHook.mockReturnValue({ data: shareholder, isLoading: false });

    const html = renderPage();

    expect(html.match(/data-tab="/g)).toHaveLength(1);
    expect(html).toContain('data-tab="my-advance"');
    expect(html).toContain("Tạm ứng LN");
    expect(harness.advanceRender).toHaveBeenCalledWith({ me: shareholder });
    expect(harness.shareholderRender).not.toHaveBeenCalled();
    expect(harness.overviewRender).not.toHaveBeenCalled();
    expect(harness.reportRender).not.toHaveBeenCalled();
  });

  it("Đợt 2: without any profit permission the page stays closed (advance permission alone needs a shareholder row)", () => {
    harness.permissionHook.mockReturnValue({
      data: { shareholder_profit: { advance_own_cashbook: true } },
      isLoading: false,
    });
    const html = renderPage();
    expect(html).toContain("Bạn không có quyền xem báo cáo này");
    expect(harness.advanceRender).not.toHaveBeenCalled();
  });

  it("Đợt 2: an owner gets every tab and no self tabs", () => {
    harness.permissionHook.mockReturnValue({ data: { __superadmin: true }, isLoading: false });
    harness.shareholderHook.mockReturnValue({ data: shareholder, isLoading: false });
    harness.profitCloseHook.mockReturnValue({
      data: [{ organization_id: "org-a", organization_name: "Org A", organization_slug: "org-a", can_lock: true, can_unlock: true }],
      isLoading: false,
    });

    const html = renderPage();

    for (const tab of ["report", "overview", "lock", "config"]) expect(html).toContain(`data-tab="${tab}"`);
    expect(html).not.toContain('data-tab="my-overview"');
    expect(html).not.toContain('data-tab="my-advance"');
  });

  it("Đợt 2: ?tab=my-advance opens that tab; an unknown ?tab falls back to the first tab", () => {
    harness.permissionHook.mockReturnValue({
      data: { shareholder_profit: { advance_own_cashbook: true } },
      isLoading: false,
    });
    harness.shareholderHook.mockReturnValue({ data: shareholder, isLoading: false });
    harness.managerHook.mockReturnValue({ data: manager, isLoading: false });

    expect(renderPage("/reports/finance/profit-distribution?tab=my-advance")).toContain('data-active="my-advance"');
    expect(renderPage("/reports/finance/profit-distribution?tab=my-salary")).toContain('data-active="my-salary"');
    expect(renderPage("/reports/finance/profit-distribution?tab=report")).toContain('data-active="my-advance"');
  });

  it("keeps the manager-only salary fallback when no report tabs are allowed", () => {
    harness.managerHook.mockReturnValue({ data: manager, isLoading: false });

    const html = renderPage();

    expect(html).toContain('data-probe="manager-self"');
    expect(harness.reportRender).not.toHaveBeenCalled();
    expect(harness.overviewRender).not.toHaveBeenCalled();
  });

  it("Q9: lock, shareholder config and own-salary tabs show by permission without the 3-click reveal", () => {
    harness.permissionHook.mockReturnValue({
      data: { shareholder_profit: { view: true, manage_shareholders: true } },
      isLoading: false,
    });
    harness.profitCloseHook.mockReturnValue({
      data: [{ organization_id: "org-a", organization_name: "Org A", organization_slug: "org-a", can_lock: true, can_unlock: false }],
      isLoading: false,
    });
    harness.managerHook.mockReturnValue({ data: manager, isLoading: false });

    const html = renderPage();

    expect(html).toContain('data-tab="overview"');
    expect(html).toContain('data-tab="lock"');
    expect(html).toContain('data-tab="config"');
    expect(html).toContain('data-tab="my-salary"');
    expect(html).toContain('data-probe="manager-self"');
  });

  it("Q9: without lock/manage permissions those tabs stay absent (permission, not a hidden toggle)", () => {
    harness.permissionHook.mockReturnValue({ data: { shareholder_profit: { view: true, distribute: true } }, isLoading: false });
    const html = renderPage();
    expect(html).toContain('data-tab="overview"');
    expect(html).not.toContain('data-tab="lock"');
    expect(html).not.toContain('data-tab="config"');
    expect(html).not.toContain('data-tab="my-salary"');
  });

  it("passes the permission results (incl. the three Đợt 2 view flags and ?tab) to the mobile hub", () => {
    harness.phone = true;
    harness.permissionHook.mockReturnValue({
      data: { reports_finance: { profit_distribution: true }, shareholder_profit: { view_percent: true } },
      isLoading: false,
    });
    harness.shareholderHook.mockReturnValue({
      data: shareholder,
      isLoading: false,
    });
    harness.managerHook.mockReturnValue({ data: manager, isLoading: false });

    renderPage("/reports/finance/profit-distribution?tab=my-advance");

    expect(harness.mobileRender).toHaveBeenCalledWith({
      canReport: true,
      isManager: false,
      me: shareholder,
      myManager: manager,
      canViewBuildingTotals: false,
      canViewPercent: true,
      canAdvanceOwn: false,
      requestedTab: "my-advance",
    });
  });
});
