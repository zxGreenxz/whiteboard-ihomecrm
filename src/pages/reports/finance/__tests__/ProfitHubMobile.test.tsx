import { createElement, type ReactNode } from "react";
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
  persistedTab: "report",
  setTab: vi.fn(),
  reportRender: vi.fn(),
  overviewRender: vi.fn(),
  shareholderRender: vi.fn(),
  advanceRender: vi.fn(),
  managerRender: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/hooks/usePersistedState", () => ({
  usePersistedState: () => [harness.persistedTab, harness.setTab],
}));

vi.mock("@/components/shareholders/profitMobileShared", () => ({
  MobileHeader: ({ right }: { right?: ReactNode }) => createElement("header", null, right),
}));

vi.mock("@/pages/reports/finance/ProfitDistributionMobile", () => ({
  default: () => {
    harness.reportRender();
    return createElement("div", { "data-probe": "report" });
  },
}));

vi.mock("@/components/shareholders/ProfitOverviewMobile", () => ({
  default: () => {
    harness.overviewRender();
    return createElement("div", { "data-probe": "overview" });
  },
}));

vi.mock("@/components/shareholders/ShareholderSelfMobile", () => ({
  default: ({ me, canViewPercent, canViewBuildingTotals, canAdvanceOwn }: {
    me: Shareholder; canViewPercent: boolean; canViewBuildingTotals: boolean; canAdvanceOwn: boolean;
  }) => {
    harness.shareholderRender(me, { canViewPercent, canViewBuildingTotals, canAdvanceOwn });
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

import ProfitHubMobile from "../ProfitHubMobile";

function renderMobile(props: {
  canReport: boolean;
  isManager: boolean;
  me: Shareholder | null;
  myManager: ProfitManager | null;
  canViewBuildingTotals?: boolean;
  canViewPercent?: boolean;
  canAdvanceOwn?: boolean;
  requestedTab?: string | null;
}) {
  return renderToStaticMarkup(createElement(ProfitHubMobile, {
    canViewBuildingTotals: false,
    canViewPercent: false,
    canAdvanceOwn: false,
    ...props,
  }));
}

describe("ProfitHubMobile legacy tab behavior", () => {
  beforeEach(() => {
    harness.persistedTab = "report";
    harness.setTab.mockReset();
    harness.reportRender.mockReset();
    harness.overviewRender.mockReset();
    harness.shareholderRender.mockReset();
    harness.advanceRender.mockReset();
    harness.managerRender.mockReset();
  });

  it("keeps the report tab for users with report AND building-totals permission", () => {
    const html = renderMobile({
      canReport: true,
      isManager: false,
      me: shareholder,
      myManager: null,
      canViewBuildingTotals: true,
    });

    expect(html).toContain('data-probe="report"');
    expect(html).toContain("BC Thu Chi");
    expect(harness.reportRender).toHaveBeenCalledOnce();
  });

  it("Đợt 2: shareholder with report permission but no building-totals permission has no BC tab, only own view", () => {
    // Tab nhớ là "report" (lần trước còn tab BC) ⇒ rơi về "Của tôi", không mở BC.
    const html = renderMobile({ canReport: true, isManager: false, me: shareholder, myManager: null });

    expect(html).not.toContain("BC Thu Chi");
    expect(html).toContain('data-probe="shareholder-self"');
    expect(harness.reportRender).not.toHaveBeenCalled();
  });

  it("keeps the shareholder own-share tab based on report permission and passes the view flags", () => {
    harness.persistedTab = "my";

    const html = renderMobile({
      canReport: true,
      isManager: false,
      me: shareholder,
      myManager: null,
      canViewPercent: true,
    });

    expect(html).toContain('data-probe="shareholder-self"');
    expect(html).toContain("Năm "); // pill năm có ở "Của tôi" (đối chứng cho tab Tạm ứng bên dưới)
    expect(harness.shareholderRender).toHaveBeenCalledWith(shareholder, {
      canViewPercent: true,
      canViewBuildingTotals: false,
      canAdvanceOwn: false,
    });
  });

  it("Đợt 2: advance-only user (no report permission) gets only the Tạm ứng tab, never the own-share view", () => {
    harness.persistedTab = "my";
    const html = renderMobile({ canReport: false, isManager: false, me: shareholder, myManager: null, canAdvanceOwn: true });

    expect(html).toContain('data-probe="advance"');
    expect(harness.advanceRender).toHaveBeenCalledWith({ me: shareholder, phone: true });
    expect(harness.shareholderRender).not.toHaveBeenCalled();
    expect(html).not.toContain("Năm ");
  });

  it("Đợt 2: an owner (manager) with advance permission does not get the Tạm ứng tab", () => {
    const html = renderMobile({ canReport: true, isManager: true, me: shareholder, myManager: null, canAdvanceOwn: true, canViewBuildingTotals: true });
    expect(html).not.toContain("Tạm ứng");
    expect(harness.advanceRender).not.toHaveBeenCalled();
  });

  it("Đợt 2: ?tab=my-advance opens the Tạm ứng tab over the remembered tab", () => {
    harness.persistedTab = "salary";
    const html = renderMobile({ canReport: false, isManager: false, me: shareholder, myManager: manager, canAdvanceOwn: true, requestedTab: "my-advance" });

    expect(html).toContain("Lương");
    expect(html).toContain('data-probe="advance"');
    expect(harness.managerRender).not.toHaveBeenCalled();
  });

  it("keeps the manager-only salary fallback", () => {
    const html = renderMobile({
      canReport: false,
      isManager: false,
      me: null,
      myManager: manager,
    });

    expect(html).toContain('data-probe="manager-self"');
    expect(harness.managerRender).toHaveBeenCalledWith(manager);
    expect(harness.reportRender).not.toHaveBeenCalled();
  });

  it("Q9: an executive manager who also has report tabs still gets an always-visible salary tab", () => {
    const html = renderMobile({ canReport: true, isManager: true, me: null, myManager: manager });
    expect(html).toContain("Lương");
    harness.persistedTab = "salary";
    harness.managerRender.mockReset();
    const salary = renderMobile({ canReport: true, isManager: true, me: null, myManager: manager });
    expect(salary).toContain('data-probe="manager-self"');
    expect(harness.managerRender).toHaveBeenCalledWith(manager);
  });

  it("keeps the legacy denial message when no tab or self view is available", () => {
    const html = renderMobile({
      canReport: false,
      isManager: false,
      me: null,
      myManager: null,
    });

    expect(html).toContain("B\u1ea1n kh\u00f4ng c\u00f3 quy\u1ec1n xem b\u00e1o c\u00e1o n\u00e0y");
  });
});
