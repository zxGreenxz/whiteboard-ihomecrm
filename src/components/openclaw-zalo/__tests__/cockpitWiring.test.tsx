import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RENDERS the cockpit and looks for what Task 23 built.
 *
 * The first version of this file grepped the source for `<OpenClawInboxSection` and
 * `setConnectionOpen(true)`. A reviewer showed those regexes were satisfied by any
 * occurrence anywhere in the file - including inside a branch nothing reaches - and
 * broke on innocuous reformatting. Rendering costs the same and proves the thing
 * that actually matters: the component appears in the output for a given state.
 *
 * Task 22 shipped a `Breadcrumbs.tsx` that nothing rendered, which is the failure
 * mode this file exists to catch.
 */
const harness = vi.hoisted(() => ({
  connectionState: "CONNECTED" as
    | "CONNECTED" | "DISCONNECTED" | "RECONNECT_REQUIRED",
  permissions: new Set<string>(["view", "send", "manage_connections", "manage_handoff"]),
}));

const ORG = "dddd0000-0000-4000-8000-000000000001";

vi.mock("../OpenClawRouteGuard", () => ({
  useOpenClawRouteContext: () => ({
    organizations: [{ organizationId: ORG, name: "Tổ chức DEMO" }],
    organization: { organizationId: ORG, name: "Tổ chức DEMO" },
    selectedOrganizationId: ORG,
    selectOrganization: vi.fn(),
    bootstrap: {
      version: 1 as const,
      organizationId: ORG,
      actorId: "22222222-2222-4222-8222-222222222222",
      account: {
        accountId: "dddd1000-0000-4000-8000-00000000000a",
        displayName: "Zalo bán hàng",
        connectionState: harness.connectionState,
        sessionRiskState: "HEALTHY" as const,
        configuredMode: "MANUAL_SEND" as const,
        effectiveMode: "MANUAL_SEND" as const,
        connectionGeneration: 3,
        sessionGeneration: 4,
        disclosureVersion: 2,
        disclosureAcknowledgedVersion: 2,
        currentCellId: "dddd2000-0000-4000-8000-000000000010",
      },
      control: {
        globalStop: false,
        featureEnabled: true,
        limitedAutoReplyEnabled: false,
        proactiveEnabled: false,
        salesGroupsEnabled: false,
        controlVersion: 9,
      },
    },
    permissions: { organizationId: ORG, actions: {} },
    can: (action: string) => harness.permissions.has(action),
  }),
}));

const idleQuery = { data: undefined, isLoading: false, error: null, refetch: vi.fn() };

vi.mock("@/hooks/openclaw-zalo/useOpenClawInbox", () => ({
  useOpenClawInbox: () => ({ ...idleQuery, data: { version: 1, items: [], limit: 50 } }),
  useOpenClawMessages: () => ({ ...idleQuery, data: { version: 1, items: [], limit: 50 } }),
}));

vi.mock("@/hooks/openclaw-zalo/useOpenClawResources", () => ({
  useOpenClawAiDrafts: () => ({ ...idleQuery, data: { version: 1, items: [], limit: 20 } }),
  useOpenClawQrPoll: () => ({ ...idleQuery, data: { version: 1, challenge: null } }),
}));

const idleMutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

vi.mock("@/hooks/openclaw-zalo/useOpenClawMutations", () => ({
  useOpenClawHandoffMutations: () => ({
    takeoverConversation: idleMutation,
    releaseTakeover: idleMutation,
    assignConversation: idleMutation,
    markConversationRead: idleMutation,
  }),
  useOpenClawBeginQrLogin: () => idleMutation,
  useOpenClawAcknowledgeDisclosure: () => idleMutation,
}));

const { default: OpenClawCockpit } = await import("../OpenClawCockpit");
const { default: OpenClawSectionBody } = await import("../OpenClawSectionBody");

const render = () => renderToStaticMarkup(createElement(OpenClawCockpit, { mobile: false }));

const renderSection = (activeSection: "overview" | "inbox") =>
  renderToStaticMarkup(createElement(OpenClawSectionBody, {
    activeSection,
    connectionState: "CONNECTED" as const,
    canManageConnections: true,
    onReconnect: vi.fn(),
    children: createElement("p", null, "placeholder"),
  }));

beforeEach(() => {
  harness.connectionState = "CONNECTED";
  harness.permissions = new Set(["view", "send", "manage_connections", "manage_handoff"]);
});

describe("cockpit wiring", () => {
  it("starts on the overview, not the inbox", () => {
    // Pins the default so the next assertion is meaningful rather than accidental.
    const html = render();
    expect(html).not.toContain('data-openclaw-inbox=');
    expect(html).toContain("Tổng quan vận hành");
  });

  it("mounts the inbox for the inbox section, and only for it", () => {
    // Rendered, not grepped: this fails if the branch is removed, if it points at a
    // different component, or if the inbox renders for every section.
    const inbox = renderSection("inbox");
    expect(inbox).toContain('data-openclaw-inbox=');
    expect(inbox).not.toContain("placeholder");

    const overview = renderSection("overview");
    expect(overview).toContain("placeholder");
    expect(overview).not.toContain('data-openclaw-inbox=');
  });

  it("offers the reconnect trigger only to a member who may manage connections", () => {
    harness.connectionState = "RECONNECT_REQUIRED";
    expect(render()).toContain("Kết nối lại");
    harness.permissions = new Set(["view"]);
    const readOnly = render();
    expect(readOnly).not.toContain("Kết nối lại");
    // Still a usable screen for that member, not an error page.
    expect(readOnly).toContain("Phiên cần được xác minh");
  });

  it("does not render the connection dialog until it is opened", () => {
    // The dialog returns null while closed, so its absence here is the closed state
    // rather than the component being missing - the open path is covered by
    // connection.test.tsx, which renders the dialog directly with open: true.
    expect(render()).not.toContain('data-openclaw-dialog="connection"');
  });
});
