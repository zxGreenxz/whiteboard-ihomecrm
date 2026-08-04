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
    | "CONNECTED" | "DISCONNECTED" | "RECONNECT_REQUIRED" | "QR_PENDING",
  // Includes the managing permissions, because every knowledge and automation RPC
  // demands one: without them the sections render their permission notice and the
  // mount assertions below would pass on the degenerate branch.
  permissions: new Set<string>([
    "view", "send", "manage_connections", "manage_handoff",
    "manage_knowledge", "manage_automation",
  ]),
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

vi.mock("@tanstack/react-query", async importOriginal => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  // The cockpit invalidates the OpenClaw query root once a scan lands; SSR has no
  // provider, so give it a client that records rather than one that throws.
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const idleQuery = { data: undefined, isLoading: false, error: null, refetch: vi.fn() };
const idleActionMutation = { mutate: vi.fn(), isPending: false };

vi.mock("@/hooks/openclaw-zalo/useOpenClawInbox", () => ({
  useOpenClawInbox: () => ({ ...idleQuery, data: { version: 1, items: [], limit: 50 } }),
  useOpenClawMessages: () => ({ ...idleQuery, data: { version: 1, items: [], limit: 50 } }),
}));

const emptyList = { version: 1, items: [], limit: 50 };

vi.mock("@/hooks/openclaw-zalo/useOpenClawResources", () => ({
  useOpenClawAiDrafts: () => ({ ...idleQuery, data: { version: 1, items: [], limit: 20 } }),
  useOpenClawTakeovers: () => ({ ...idleQuery, data: emptyList }),
  useOpenClawKnowledgeList: () => ({
    ...idleQuery,
    data: { version: 1, items: [{
      sourceId: "s1", title: "FAQ", sourceKind: "FAQ", sensitivity: "CUSTOMER_SAFE",
      lifecycleState: "DRAFT", currentVersion: 1,
    }], limit: 50 },
  }),
  useOpenClawKnowledge: () => ({ ...idleQuery, data: undefined }),
  useOpenClawKnowledgePreview: () => ({ ...idleQuery, data: undefined }),
  // NON-EMPTY on purpose: with an empty list the automation section short-circuits
  // to its "no automations" paragraph, and a prefix assertion on
  // `data-openclaw-automation=` would pass without the wizard ever rendering.
  useOpenClawAutomationList: () => ({
    ...idleQuery,
    data: { version: 1, items: [{ automationId: "a1", name: "Trả lời khách mới" }], limit: 50 },
  }),
  useOpenClawAutomation: () => ({
    ...idleQuery,
    data: { version: 1, automation: { automationId: "a1", name: "Trả lời khách mới", mode: "DRAFT_ONLY" } },
  }),
  useOpenClawSalesGroups: () => ({ ...idleQuery, data: emptyList }),
  useOpenClawSchedules: () => ({ ...idleQuery, data: emptyList }),
  useOpenClawDeadLetterReplayMutation: () => idleActionMutation,
  useOpenClawLegalHoldMutations: () => ({
    create: idleActionMutation,
    release: idleActionMutation,
  }),
  useOpenClawKnowledgeMutations: () => ({
    createDraft: idleActionMutation,
    updateDraft: idleActionMutation,
    validate: idleActionMutation,
    publish: idleActionMutation,
    archive: idleActionMutation,
  }),
}));

const idleMutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

vi.mock("@/hooks/openclaw-zalo/useOpenClawOverview", () => ({
  useOpenClawOverview: () => ({ ...idleQuery, data: undefined }),
}));

vi.mock("@/hooks/openclaw-zalo/useOpenClawOperations", () => ({
  useOpenClawHealthEvents: () => ({ ...idleQuery, data: emptyList }),
  // Returns a bare array, unlike the dead-letter hook's page envelope.
  useOpenClawUnknown: () => ({ ...idleQuery, data: [] }),
  // Null while no UNKNOWN dialog is open; the section reads it unconditionally.
  useOpenClawUnknownAuthority: () => ({ ...idleQuery, data: null }),
  useOpenClawDeadLetters: () => ({ ...idleQuery, data: emptyList }),
  useOpenClawLegalHolds: () => ({ ...idleQuery, data: emptyList }),
}));

vi.mock("@/hooks/openclaw-zalo/useOpenClawMutations", () => ({
  useOpenClawResolveUnknown: () => idleMutation,
  useOpenClawHandoffMutations: () => ({
    takeoverConversation: idleMutation,
    releaseTakeover: idleMutation,
    assignConversation: idleMutation,
    markConversationRead: idleMutation,
  }),
  useOpenClawCreateSendIntent: () => idleMutation,
  useOpenClawAcknowledgeDisclosure: () => idleMutation,
  useOpenClawSetControlState: () => idleMutation,
}));

vi.mock("@/lib/openclaw-zalo/qrClient", () => ({
  beginQrLogin: vi.fn(),
  pollQrLogin: vi.fn(),
  consumeQrChallenge: vi.fn(),
}));

const { default: OpenClawCockpit } = await import("../OpenClawCockpit");
const { default: OpenClawSectionBody } = await import("../OpenClawSectionBody");

const render = () => renderToStaticMarkup(createElement(OpenClawCockpit, { mobile: false }));

const renderSection = (
  activeSection: "overview" | "inbox" | "knowledge" | "automation" | "schedules" | "operations",
) =>
  renderToStaticMarkup(createElement(OpenClawSectionBody, {
    activeSection,
    connectionState: "CONNECTED" as const,
    canManageConnections: true,
    onReconnect: vi.fn(),
    children: createElement("p", null, "placeholder"),
  }));

beforeEach(() => {
  harness.connectionState = "CONNECTED";
  harness.permissions = new Set([
    "view", "send", "manage_connections", "manage_handoff",
    "manage_knowledge", "manage_automation",
  ]);
});

describe("cockpit wiring", () => {
  it("starts on the overview, not the inbox", () => {
    // Pins the default so the next assertion is meaningful rather than accidental.
    const html = render();
    expect(html).not.toContain('data-openclaw-inbox=');
    expect(html).toContain('data-openclaw-overview="root"');
  });

  it("mounts the inbox for the inbox section, and only for it", () => {
    // Rendered, not grepped: this fails if the branch is removed, if it points at a
    // different component, or if the inbox renders for every section.
    const inbox = renderSection("inbox");
    expect(inbox).toContain('data-openclaw-inbox=');
    expect(inbox).not.toContain("placeholder");

    // The overview is now a real screen too, so the placeholder children are only
    // reachable from a section with no component of its own.
    const overview = renderSection("overview");
    expect(overview).toContain('data-openclaw-overview="root"');
    expect(overview).not.toContain('data-openclaw-inbox=');

    // Operations is a real screen now too; the placeholder children are unreachable.
    const operations = renderSection("operations");
    expect(operations).toContain('data-openclaw-operations="root"');
  });

  it("mounts each Task 24 section behind its own id, and only there", () => {
    // Same guarantee as the inbox: rendered rather than grepped, so removing a branch
    // or pointing it at the wrong component fails here.
    // Markers that only the REAL screen emits. Prefix matches like
    // `data-openclaw-knowledge=` were satisfied by the permission notice and the
    // "no automations" paragraph, so two of the three assertions proved nothing.
    const cases = [
      ["knowledge", 'data-openclaw-knowledge="sources"'],
      ["automation", 'data-openclaw-automation="wizard"'],
      ["schedules", 'data-openclaw-schedules="groups"'],
    ] as const;
    for (const [section, marker] of cases) {
      const html = renderSection(section);
      expect(html, section).toContain(marker);
      expect(html, section).not.toContain("placeholder");
    }
    // And the overview shows its own screen rather than any of them.
    const overview = renderSection("overview");
    expect(overview).toContain('data-openclaw-overview="root"');
    for (const [, marker] of cases) expect(overview).not.toContain(marker);
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

  it("keeps the reconnect route open while a QR is pending", () => {
    // openclaw_begin_qr_login_v1 moves the account to QR_PENDING the moment a code
    // is requested. That state was absent from the disconnected branch, so the only
    // control that opens the dialog disappeared as soon as the operator used it.
    harness.connectionState = "QR_PENDING";
    const html = render();
    expect(html).toContain("Mở lại mã QR");
    expect(html).toContain("Đang chờ quét mã QR");
  });

  it("does not claim to prove the nav wiring it cannot exercise", () => {
    // Stated rather than faked: `activeSection` is internal state and this repo has
    // no DOM to click the nav with, so the nav -> state -> body edge is covered by
    // the e2e fleet (Task 26), not here. What IS proven above is that the body
    // renders the inbox for "inbox" and the placeholder for anything else.
    const html = render();
    expect(html).toContain("Hộp thư");
  });

  it("does not render the connection dialog until it is opened", () => {
    // The dialog returns null while closed, so its absence here is the closed state
    // rather than the component being missing - the open path is covered by
    // connection.test.tsx, which renders the dialog directly with open: true.
    expect(render()).not.toContain('data-openclaw-dialog="connection"');
  });
});
