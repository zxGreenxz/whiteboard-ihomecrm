import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ phone: false }));
const routeHarness = vi.hoisted(() => ({
  authorization: {
    data: {
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      permissions: {} as Record<string, boolean>,
    },
    error: null as unknown,
    isLoading: false,
    refetch: vi.fn(),
  },
  bootstrap: {
    data: {
      version: 1 as const,
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      account: null,
      control: null,
      actorId: "22222222-2222-4222-8222-222222222222",
    },
    error: null as unknown,
    isLoading: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@/hooks/use-mobile", () => ({
  usePhoneViewport: () => harness.phone,
}));

vi.mock("react-router-dom", async importOriginal => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  Navigate: ({ to }: { to: string }) => createElement("div", { "data-redirect": to }),
}));

vi.mock("@tanstack/react-query", async importOriginal => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => routeHarness.authorization,
}));

vi.mock("@/hooks/openclaw-zalo/useOpenClawOrganization", () => ({
  useOpenClawOrganization: () => ({
    organizations: [{
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      name: "Tổ chức DEMO",
    }],
    selectedOrganizationId: "dddd0000-0000-4000-8000-000000000001",
    selectedOrganization: {
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      name: "Tổ chức DEMO",
    },
    needsSelection: false,
    selectOrganization: vi.fn(),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/openclaw-zalo/useOpenClawBootstrap", () => ({
  useOpenClawBootstrap: () => routeHarness.bootstrap,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn() },
}));

vi.mock("../OpenClawZaloDesktopPage", () => ({
  default: () => createElement("div", { "data-shell": "desktop" }),
}));

vi.mock("../OpenClawZaloMobilePage", () => ({
  default: () => createElement("div", { "data-shell": "mobile" }),
}));

import OpenClawBoundaryState, {
  type OpenClawBoundaryKind,
} from "@/components/openclaw-zalo/OpenClawBoundaryState";
import OpenClawCommandBar from "@/components/openclaw-zalo/OpenClawCommandBar";
import OpenClawSectionNav from "@/components/openclaw-zalo/OpenClawSectionNav";
import OpenClawRouteGuard from "@/components/openclaw-zalo/OpenClawRouteGuard";
import OpenClawZaloPage from "../OpenClawZaloPage";

const render = (component: ReactElement) => renderToStaticMarkup(component);
const decodeText = (html: string) => html.split("&amp;").join("&");

describe("OpenClawZaloPage", () => {
  beforeEach(() => {
    harness.phone = false;
    routeHarness.authorization.data.permissions = {};
    routeHarness.authorization.error = null;
    routeHarness.authorization.isLoading = false;
    routeHarness.bootstrap.error = null;
    routeHarness.bootstrap.isLoading = false;
  });

  it("redirects before rendering protected content when organization view is absent", () => {
    const html = render(createElement(OpenClawRouteGuard, null,
      createElement("div", { "data-sensitive-content": true }, "Sensitive cockpit"),
    ));

    expect(html).toContain('data-redirect="/"');
    expect(html).not.toContain("Sensitive cockpit");
    expect(html).not.toContain("data-sensitive-content");
  });

  it("renders protected content only after organization-scoped view is confirmed", () => {
    routeHarness.authorization.data.permissions = { "openclaw_zalo.view": true };
    const html = render(createElement(OpenClawRouteGuard, null,
      createElement("div", { "data-authorized-content": true }, "Authorized cockpit"),
    ));

    expect(html).toContain("Authorized cockpit");
    expect(html).toContain("data-authorized-content");
  });

  it("selects the desktop shell synchronously", () => {
    expect(render(createElement(OpenClawZaloPage))).toContain('data-shell="desktop"');
  });

  it("selects the standalone mobile shell without rendering desktop first", () => {
    harness.phone = true;
    const html = render(createElement(OpenClawZaloPage));

    expect(html).toContain('data-shell="mobile"');
    expect(html).not.toContain('data-shell="desktop"');
  });

  it("exposes the six desktop areas in the approved order", () => {
    const html = decodeText(render(createElement(OpenClawSectionNav, {
      activeSection: "overview",
      mobile: false,
      onSectionChange: vi.fn(),
    })));

    const labels = [
      "Tổng quan",
      "Hộp thư",
      "Tự động hóa",
      "Tri thức",
      "Lịch & Nhóm sale",
      "Vận hành",
    ];
    let previous = -1;
    for (const label of labels) {
      const position = html.indexOf(label);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
  });

  it("keeps mobile navigation to Overview, Inbox, Automation, and More", () => {
    const html = decodeText(render(createElement(OpenClawSectionNav, {
      activeSection: "overview",
      mobile: true,
      onSectionChange: vi.fn(),
    })));

    expect(html).toContain("Tổng quan");
    expect(html).toContain("Hộp thư");
    expect(html).toContain("Tự động");
    expect(html).toContain("Thêm");
    expect(html).toContain("Tri thức");
    expect(html).toContain("Lịch & Nhóm sale");
    expect(html).toContain("Vận hành");
  });

  it("renders every explicit boundary without turning errors into empty content", () => {
    const states: OpenClawBoundaryKind[] = [
      "loading",
      "no-account",
      "no-permission",
      "disconnected",
      "stale-cell",
      "partial-outage",
      "empty-inbox",
      "fatal-error",
    ];

    for (const state of states) {
      const html = render(createElement(OpenClawBoundaryState, { state }));
      expect(html).toContain(`data-boundary-state="${state}"`);
      if (state === "fatal-error" || state === "partial-outage") {
        expect(html).not.toContain("Hộp thư đang trống");
      }
    }
  });

  it("shows GLOBAL_STOP to viewers and only enables its action for operations managers", () => {
    const baseProps = {
      organizationName: "Công ty Demo",
      accountName: "Zalo vận hành",
      connectionHealth: "HEALTHY" as const,
      configuredMode: "MANUAL_SEND" as const,
      effectiveMode: "MANUAL_SEND" as const,
      paused: false,
      globalStop: true,
      onGlobalStop: vi.fn(),
    };
    const viewer = render(createElement(OpenClawCommandBar, {
      ...baseProps,
      canManageOperations: false,
    }));
    const manager = render(createElement(OpenClawCommandBar, {
      ...baseProps,
      canManageOperations: true,
    }));

    expect(viewer).toContain("GLOBAL_STOP");
    // The control only navigates, so it must not promise to stop anything.
    expect(viewer).not.toContain("DỪNG TOÀN BỘ GỬI");
    expect(manager).not.toContain("DỪNG TOÀN BỘ GỬI");
    // Residual risk disclosure is mandatory and must stay visible, not collapsed.
    for (const markup of [viewer, manager]) {
      expect(markup).toContain('data-openclaw-residual-risk="true"');
      expect(markup).toContain("không chính thức");
      expect(markup).toMatch(/quét lại QR/u);
      // Match ANY tag carrying the marker: pinning <p> made the assertion vacuous
      // the moment the element changed, because the failed match fell back to "".
      const strip = markup.match(/<[a-z]+[^>]*data-openclaw-residual-risk="true"[^>]*>/u)?.[0];
      expect(strip, "residual-risk element is not rendered at all").toBeTruthy();
      // Attribute-precise: a bare /hidden/ also matches className="overflow-hidden"
      // or "md:hidden", which are not hiding anything.
      expect(strip).not.toMatch(/\shidden(?=[\s>=])|aria-hidden="true"|display:\s*none/u);
      // NOTE: this only sees the element's own attributes. A hidden ANCESTOR, a
      // class-driven display:none, sr-only, h-0 or opacity-0 are invisible to
      // renderToStaticMarkup and are not covered here.
    }
    const viewerButton = viewer.match(/<button[^>]*aria-label="Mở kiểm soát GLOBAL_STOP"[^>]*>/)?.[0];
    const managerButton = manager.match(/<button[^>]*aria-label="Mở kiểm soát GLOBAL_STOP"[^>]*>/)?.[0];
    expect(viewerButton).toContain(' disabled=""');
    expect(manager).toContain("GLOBAL_STOP");
    expect(managerButton).not.toContain(' disabled=""');
  });
});
