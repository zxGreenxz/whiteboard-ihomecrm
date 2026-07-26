import { createElement } from "react";
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
  managerRender: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/hooks/usePersistedState", () => ({
  usePersistedState: () => [harness.persistedTab, harness.setTab],
}));

vi.mock("@/components/shareholders/profitMobileShared", () => ({
  MobileHeader: () => createElement("header"),
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

import ProfitHubMobile from "../ProfitHubMobile";

function renderMobile(props: {
  canReport: boolean;
  isManager: boolean;
  me: Shareholder | null;
  myManager: ProfitManager | null;
}) {
  return renderToStaticMarkup(createElement(ProfitHubMobile, props));
}

describe("ProfitHubMobile legacy tab behavior", () => {
  beforeEach(() => {
    harness.persistedTab = "report";
    harness.setTab.mockReset();
    harness.reportRender.mockReset();
    harness.overviewRender.mockReset();
    harness.shareholderRender.mockReset();
    harness.managerRender.mockReset();
  });

  it("keeps the report tab for report-authorized users", () => {
    const html = renderMobile({
      canReport: true,
      isManager: false,
      me: shareholder,
      myManager: null,
    });

    expect(html).toContain('data-probe="report"');
    expect(harness.reportRender).toHaveBeenCalledOnce();
  });

  it("keeps the shareholder own-share tab based on report permission", () => {
    harness.persistedTab = "my";

    const html = renderMobile({
      canReport: true,
      isManager: false,
      me: shareholder,
      myManager: null,
    });

    expect(html).toContain('data-probe="shareholder-self"');
    expect(harness.shareholderRender).toHaveBeenCalledWith(shareholder);
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
