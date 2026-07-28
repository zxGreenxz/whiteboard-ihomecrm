import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";
import { login, trackConsoleErrors, type UserKey } from "./auth";

const ROUTE = "/reports/finance/business-performance";
const LEGACY_ANALYSIS_ROUTE = "/reports/finance/analysis";
const PROFIT_HUB_ROUTE = "/reports/finance/profit-distribution";
const PAGE_TITLE = "Trung tâm Tài chính & Hiệu quả kinh doanh";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEWS = [
  {
    id: "business-overview",
    label: "Tổng quan kinh doanh",
    content: /^Quan sát thực tế$/,
  },
  {
    id: "building-performance",
    label: "Hiệu quả tòa nhà",
    content: /^Doanh thu - Chi phí = Lợi nhuận$/,
  },
  {
    id: "occupancy-vacancy",
    label: "Lấp đầy & Phòng trống",
    content: /^Hiện trạng lấp đầy$/,
  },
  {
    id: "collections-debt",
    label: "Thu tiền & Công nợ",
    content: /^Công nợ phải thu hiện tại$/,
  },
  {
    id: "revenue-cost-structure",
    label: "Cơ cấu Thu & Chi",
    content: /^Chi tiết hạng mục từ RPC có phân quyền$/,
  },
  {
    id: "trends-comparison",
    label: "Xu hướng & So sánh",
    content: /^(?:So sánh kỳ báo cáo|Chưa có dữ liệu xu hướng)$/,
  },
  {
    id: "data-definitions",
    label: "Dữ liệu & Định nghĩa",
    content: /^Phạm vi và cơ sở đang áp dụng$/,
  },
] as const;
type View = (typeof VIEWS)[number];

const DATA_BEARING_VIEW_IDS = new Set<View["id"]>(
  VIEWS.slice(0, -1).map((view) => view.id),
);
const RESTRICTED_VIEWS = [VIEWS[2], VIEWS[6]] as const;
const RESTRICTED_ACCESS_USERS = ["quanly", "ketoan"] as const satisfies readonly UserKey[];
const RESTRICTED_CONTENT_MARKERS = [
  "Quan sát thực tế",
  "Doanh thu - Chi phí = Lợi nhuận",
  "Công nợ phải thu hiện tại",
  "Chi tiết hạng mục từ RPC có phân quyền",
  "So sánh kỳ báo cáo",
  "Chưa có dữ liệu xu hướng",
] as const;
const BUSINESS_PERFORMANCE_DOM_SELECTORS = [
  "#business-performance-active-report",
  '[data-testid="business-performance-view-picker"]',
] as const;
const DEMO_ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const INVALID_ORGANIZATION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const BUSINESS_PERFORMANCE_RPC_NAMES = [
  "business_performance_organizations_v1",
  "business_performance_pnl_v1",
  "business_performance_snapshot_v1",
  "business_performance_occupancy_snapshot_v1",
  "business_performance_upcoming_vacancy_v1",
  "business_performance_occupancy_monthly_v1",
  "business_performance_inventory_history_v1",
  "business_performance_reporting_roles_v1",
  "business_performance_set_reporting_role_v1",
  "business_performance_break_even_v1",
  "business_performance_invoice_cohort_v1",
  "business_performance_cash_received_v1",
  "business_performance_category_breakdown_v1",
] as const;
const BUSINESS_PERFORMANCE_RPC_NAME_SET = new Set<string>(
  BUSINESS_PERFORMANCE_RPC_NAMES,
);
const ORGANIZATIONS_RPC_NAME = "business_performance_organizations_v1";
const METRIC_RPC_NAME_SET = new Set<string>(
  BUSINESS_PERFORMANCE_RPC_NAMES.filter(
    (rpcName) =>
      rpcName !== ORGANIZATIONS_RPC_NAME &&
      rpcName !== "business_performance_set_reporting_role_v1",
  ),
);
const RESTRICTED_ALLOWED_RPC_NAME_SET = new Set<string>([
  ORGANIZATIONS_RPC_NAME,
  "business_performance_occupancy_snapshot_v1",
  "business_performance_upcoming_vacancy_v1",
  "business_performance_occupancy_monthly_v1",
  "business_performance_inventory_history_v1",
]);
const BUSINESS_PERFORMANCE_RPC_PATTERN = /^business_performance_[a-z0-9_]+$/;
const LEGACY_FINANCE_OCCUPANCY_RPC_PATTERN = /^(?:fa_|occupancy_)/;
const RPC_PATH_PATTERN = /^\/rest\/v1\/rpc\/([^/]+)\/?$/;
const SUPABASE_HOST_PATTERN = /(?:^|\.)supabase\.co$/i;
const SUPABASE_API_PATH_PATTERN = /^\/(?:auth|rest)\/v1(?:\/|$)/;

interface RuntimeSignals {
  pageErrors: string[];
  rpcRequests: string[];
  rpcRequestStarts: Array<{
    rpcName: string;
    pageUrl: string;
    payload: unknown;
    buildingOrganizationsAtStart?: ReadonlyMap<string, string>;
    buildingScopeGenerationAtStart?: number;
  }>;
  rpcResponseFailures: string[];
  rpcRequestFailures: string[];
  pendingRpcRequests: Map<Request, string>;
  buildingOrganizations: Map<string, string>;
  buildingScopeFailures: string[];
  pendingBuildingScopeLoads: Set<Promise<void>>;
  buildingScopeGeneration: number;
  buildingScopeRequestGenerations: Map<Request, number>;
  networkResponseFailures: string[];
  networkRequestFailures: string[];
  pendingNetworkRequests: Map<
    Request,
    {
      label: string;
      requestPageUrl: string;
      requestReferer: string | null;
      navigationAbortCandidate: boolean;
    }
  >;
  navigationAbortSourceUrl: string | null;
  postCommitNotificationAbortWindow: boolean;
  trackingPaused: boolean;
}

interface RestrictedContentMountEvidence {
  markers: string[];
}

const RESTRICTED_CONTENT_RECORDER =
  "__recordRestrictedBusinessPerformanceContent";
const restrictedContentMountEvidence = new WeakMap<
  Page,
  RestrictedContentMountEvidence
>();

function fullAccessUser(): UserKey {
  if (process.env.FLEET_PASS_CHUNHA) return "chunha";

  throw new Error(
    "Thiếu FLEET_PASS_CHUNHA. Suite này kiểm tra đủ 7 góc nhìn kinh doanh, " +
      "nên chỉ chạy bằng credential chủ nhà DEMO đã biết có full access.",
  );
}

function financeRpcName(url: string) {
  const rpcName = new URL(url).pathname.match(RPC_PATH_PATTERN)?.[1] ?? null;
  return rpcName &&
    (BUSINESS_PERFORMANCE_RPC_PATTERN.test(rpcName) ||
      LEGACY_FINANCE_OCCUPANCY_RPC_PATTERN.test(rpcName))
    ? rpcName
    : null;
}

function expectDemoOrganizationScope(
  organizationId: string | null,
  context: string,
) {
  if (organizationId !== DEMO_ORGANIZATION_ID) {
    throw new Error(
      `${context} must use DEMO organization ${DEMO_ORGANIZATION_ID}; received ${organizationId ?? "null"}`,
    );
  }
}

function expectExplicitRpcBuildingScope(
  payload: unknown,
  organizationId: string,
  buildingOrganizations: ReadonlyMap<string, string>,
  context: string,
): void {
  const payloadRecord =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  if (payloadRecord?.p_organization_id !== organizationId) {
    throw new Error(
      `${context} p_organization_id must equal selected organization ${organizationId}`,
    );
  }

  const buildingIds = payloadRecord.p_building_ids;

  if (!Array.isArray(buildingIds) || buildingIds.length === 0) {
    throw new Error(
      `${context} p_building_ids must be a non-empty explicit array; omitted, null, and empty all-scope payloads are forbidden`,
    );
  }

  for (const buildingId of buildingIds) {
    if (typeof buildingId !== "string" || !UUID_PATTERN.test(buildingId)) {
      throw new Error(`${context} p_building_ids must contain only UUIDs`);
    }
    if (buildingOrganizations.get(buildingId) !== organizationId) {
      throw new Error(
        `${context} building ${buildingId} does not belong to selected organization ${organizationId}`,
      );
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test.describe("RPC building scope helper", () => {
  const organizationId = DEMO_ORGANIZATION_ID;
  const buildingId = "22222222-2222-4222-8222-222222222222";
  const foreignBuildingId = "33333333-3333-4333-8333-333333333333";
  const buildingOrganizations = new Map([
    [buildingId, organizationId],
    [foreignBuildingId, "44444444-4444-4444-8444-444444444444"],
  ]);
  const organizationsRequest = () =>
    ({
      url: () =>
        `https://example.supabase.co/rest/v1/rpc/${ORGANIZATIONS_RPC_NAME}`,
      method: () => "POST",
    }) as unknown as Request;

  test("captures current, unknown business-performance, and legacy RPCs", () => {
    const rpcNames = [
      "business_performance_organizations_v1",
      "business_performance_pnl_v1",
      "business_performance_snapshot_v1",
      "business_performance_occupancy_snapshot_v1",
      "business_performance_upcoming_vacancy_v1",
      "business_performance_occupancy_monthly_v1",
      "fa_monthly_pnl",
      "fa_monthly_pnl_accrual",
      "fa_snapshot_kpis",
      "fa_occupancy_monthly",
      "occupancy_snapshot_v2",
      "occupancy_upcoming_vacancy_v2",
      "business_performance_pnl_v1_extra",
      "business_performance_unknown_v1",
    ];

    for (const rpcName of rpcNames) {
      expect(
        financeRpcName(`https://example.supabase.co/rest/v1/rpc/${rpcName}`),
      ).toBe(rpcName);
    }
    for (const rpcName of ["get_my_permissions"]) {
      expect(
        financeRpcName(`https://example.supabase.co/rest/v1/rpc/${rpcName}`),
      ).toBeNull();
    }
  });

  test("declares exactly the thirteen current business-performance RPCs", () => {
    expect([...BUSINESS_PERFORMANCE_RPC_NAMES]).toEqual([
      "business_performance_organizations_v1",
      "business_performance_pnl_v1",
      "business_performance_snapshot_v1",
      "business_performance_occupancy_snapshot_v1",
      "business_performance_upcoming_vacancy_v1",
      "business_performance_occupancy_monthly_v1",
      "business_performance_inventory_history_v1",
      "business_performance_reporting_roles_v1",
      "business_performance_set_reporting_role_v1",
      "business_performance_break_even_v1",
      "business_performance_invoice_cohort_v1",
      "business_performance_cash_received_v1",
      "business_performance_category_breakdown_v1",
    ]);
  });

  test("requires the exact DEMO organization before report data assertions", () => {
    expect(() =>
      expectDemoOrganizationScope(
        "dddd0000-0000-4000-8000-000000000001",
        "self-test",
      ),
    ).not.toThrow();
    expect(() =>
      expectDemoOrganizationScope(
        "aaaa0000-0000-4000-8000-000000000001",
        "self-test",
      ),
    ).toThrow(/DEMO organization/);
  });

  test("accepts a non-empty explicit subset of the selected organization", () => {
    expect(() =>
      expectExplicitRpcBuildingScope(
        {
          p_organization_id: organizationId,
          p_building_ids: [buildingId],
        },
        organizationId,
        buildingOrganizations,
        "business_performance_snapshot_v1",
      ),
    ).not.toThrow();
  });

  test("rejects omitted, null, and empty all-scope payloads", () => {
    for (const payload of [
      { p_organization_id: organizationId },
      { p_organization_id: organizationId, p_building_ids: null },
      { p_organization_id: organizationId, p_building_ids: [] },
    ]) {
      expect(() =>
        expectExplicitRpcBuildingScope(
          payload,
          organizationId,
          buildingOrganizations,
          "business_performance_snapshot_v1",
        ),
      ).toThrow(/p_building_ids/);
    }
  });

  test("rejects a building outside the selected organization", () => {
    expect(() =>
      expectExplicitRpcBuildingScope(
        {
          p_organization_id: organizationId,
          p_building_ids: [foreignBuildingId],
        },
        organizationId,
        buildingOrganizations,
        "business_performance_occupancy_snapshot_v1",
      ),
    ).toThrow(/selected organization/);
  });

  test("rejects a missing or mismatched organization payload", () => {
    for (const payload of [
      { p_building_ids: [buildingId] },
      {
        p_organization_id: "44444444-4444-4444-8444-444444444444",
        p_building_ids: [buildingId],
      },
    ]) {
      expect(() =>
        expectExplicitRpcBuildingScope(
          payload,
          organizationId,
          buildingOrganizations,
          "business_performance_snapshot_v1",
        ),
      ).toThrow(/p_organization_id/);
    }
  });

  test("allows organization discovery before canonical metric RPCs", async () => {
    const signals = {
      rpcRequestStarts: [
        {
          rpcName: "business_performance_organizations_v1",
          pageUrl: `https://ptcrm.vercel.app${ROUTE}`,
          payload: null,
        },
        {
          rpcName: "business_performance_snapshot_v1",
          pageUrl: `https://ptcrm.vercel.app${ROUTE}?org=${organizationId}&tab=${VIEWS[0].id}`,
          payload: {
            p_organization_id: organizationId,
            p_building_ids: [buildingId],
          },
        },
      ],
      pendingBuildingScopeLoads: new Set<Promise<void>>(),
      buildingScopeFailures: [],
      buildingOrganizations,
      buildingScopeGeneration: 0,
    } as unknown as RuntimeSignals;

    await expect(
      expectCapturedRpcBuildingScopes(signals, "organization RPC"),
    ).resolves.toBeUndefined();
    expect(() =>
      expectCanonicalScopeAtRpcStart(signals, VIEWS[0]),
    ).not.toThrow();
  });

  test("rejects a default all-buildings RPC subset for every data-bearing view", () => {
    const secondBuildingId = "55555555-5555-4555-8555-555555555555";
    for (const view of VIEWS.filter(({ id }) =>
      DATA_BEARING_VIEW_IDS.has(id),
    )) {
      const signals = {
        rpcRequestStarts: [
          {
            rpcName: "business_performance_snapshot_v1",
            pageUrl: `https://ptcrm.vercel.app${ROUTE}?org=${organizationId}&tab=${view.id}`,
            payload: {
              p_organization_id: organizationId,
              p_building_ids: [buildingId],
            },
          },
        ],
        buildingOrganizations: new Map([
          [buildingId, organizationId],
          [secondBuildingId, organizationId],
        ]),
      } as unknown as RuntimeSignals;

      expect(() =>
        expectCanonicalScopeAtRpcStart(signals, view),
      ).toThrow(/complete authoritative roster/);
    }
  });

  test("rejects metric RPC starts from a different canonical view", () => {
    const signals = {
      rpcRequestStarts: [
        {
          rpcName: "business_performance_snapshot_v1",
          pageUrl: `https://ptcrm.vercel.app${ROUTE}?org=${organizationId}&tab=${VIEWS[0].id}`,
          payload: {
            p_organization_id: organizationId,
            p_building_ids: [buildingId],
          },
        },
      ],
      buildingOrganizations: new Map([[buildingId, organizationId]]),
    } as unknown as RuntimeSignals;

    expect(() =>
      expectCanonicalScopeAtRpcStart(signals, VIEWS[1]),
    ).toThrow(/unexpected metric RPC start/);
  });

  test("rejects mixed-tab metric starts even when the requested view also starts correctly", () => {
    const signals = {
      rpcRequestStarts: [
        {
          rpcName: "business_performance_snapshot_v1",
          pageUrl: `https://ptcrm.vercel.app${ROUTE}?org=${organizationId}&tab=${VIEWS[1].id}`,
          payload: {
            p_organization_id: organizationId,
            p_building_ids: [buildingId],
          },
        },
        {
          rpcName: "business_performance_snapshot_v1",
          pageUrl: `https://ptcrm.vercel.app${ROUTE}?org=${organizationId}&tab=${VIEWS[0].id}`,
          payload: {
            p_organization_id: organizationId,
            p_building_ids: [buildingId],
          },
        },
      ],
      buildingOrganizations: new Map([[buildingId, organizationId]]),
    } as unknown as RuntimeSignals;

    expect(() =>
      expectCanonicalScopeAtRpcStart(signals, VIEWS[0]),
    ).toThrow(/unexpected metric RPC start/);
  });

  test("binds metric scope validation to the roster snapshot at request start", () => {
    const replacementBuildingId = "56565656-5656-4565-8565-565656565656";
    const signals = {
      rpcRequestStarts: [
        {
          rpcName: "business_performance_snapshot_v1",
          pageUrl: `https://ptcrm.vercel.app${ROUTE}?org=${organizationId}&tab=${VIEWS[0].id}`,
          payload: {
            p_organization_id: organizationId,
            p_building_ids: [buildingId],
          },
          buildingOrganizationsAtStart: new Map([[buildingId, organizationId]]),
          buildingScopeGenerationAtStart: 1,
        },
      ],
      buildingOrganizations: new Map([
        [replacementBuildingId, organizationId],
      ]),
    } as unknown as RuntimeSignals;

    expect(() =>
      expectCanonicalScopeAtRpcStart(signals, VIEWS[0]),
    ).not.toThrow();
  });

  test("captures canonical building ownership from the organizations RPC roster", async () => {
    const rosterBuildingId = "55555555-5555-4555-8555-555555555555";
    const signals = {
      buildingOrganizations: new Map<string, string>(),
      buildingScopeFailures: [],
      pendingBuildingScopeLoads: new Set<Promise<void>>(),
      buildingScopeGeneration: 0,
      buildingScopeRequestGenerations: new Map<Request, number>(),
    } as unknown as RuntimeSignals;
    const request = organizationsRequest();
    const response = {
      ok: () => true,
      url: () =>
        `https://example.supabase.co/rest/v1/rpc/${ORGANIZATIONS_RPC_NAME}`,
      request: () => request,
      json: async () => [
        {
          organization_id: organizationId,
          organization_name: "Organization A",
          authorized_buildings: [
            {
              id: rosterBuildingId,
              name: "Building A",
              restricted_allowed: true,
              analysis_provenance: {
                permission_key: "reports_finance.analysis",
              },
            },
          ],
          authorized_physical_building_count: 1,
          authorization_version: 7,
        },
      ],
    } as unknown as Response;

    trackBuildingScopeRequest(request, signals);
    trackBuildingScopeResponse(response, signals);

    await expect
      .poll(() => signals.pendingBuildingScopeLoads.size)
      .toBe(0);
    expect(signals.buildingScopeFailures).toEqual([]);
    expect(signals.buildingOrganizations.get(rosterBuildingId)).toBe(
      organizationId,
    );
  });

  test("does not authorize RPC scope from the broader buildings response", async () => {
    const broaderBuildingId = "66666666-6666-4666-8666-666666666666";
    const signals = {
      rpcRequestStarts: [
        {
          rpcName: "business_performance_snapshot_v1",
          pageUrl: `https://ptcrm.vercel.app${ROUTE}?org=${organizationId}&tab=${VIEWS[0].id}`,
          payload: {
            p_organization_id: organizationId,
            p_building_ids: [broaderBuildingId],
          },
        },
      ],
      buildingOrganizations: new Map<string, string>(),
      buildingScopeFailures: [],
      pendingBuildingScopeLoads: new Set<Promise<void>>(),
      buildingScopeGeneration: 0,
    } as unknown as RuntimeSignals;
    const response = {
      ok: () => true,
      url: () =>
        "https://example.supabase.co/rest/v1/buildings?select=id,organization_id",
      request: () => ({ method: () => "GET" }),
      json: async () => [
        { id: broaderBuildingId, organization_id: organizationId },
      ],
    } as unknown as Response;

    trackBuildingScopeResponse(response, signals);

    await expect(
      expectCapturedRpcBuildingScopes(signals, "broader buildings response"),
    ).rejects.toThrow(/does not belong to selected organization/);
  });

  test("replaces stale building ownership on each roster refresh", async () => {
    const staleBuildingId = "77777777-7777-4777-8777-777777777777";
    const refreshedBuildingId = "88888888-8888-4888-8888-888888888888";
    const signals = {
      buildingOrganizations: new Map([[staleBuildingId, organizationId]]),
      buildingScopeFailures: [],
      pendingBuildingScopeLoads: new Set<Promise<void>>(),
      buildingScopeGeneration: 0,
      buildingScopeRequestGenerations: new Map<Request, number>(),
    } as unknown as RuntimeSignals;
    const request = organizationsRequest();
    const response = {
      ok: () => true,
      url: () =>
        `https://example.supabase.co/rest/v1/rpc/${ORGANIZATIONS_RPC_NAME}`,
      request: () => request,
      json: async () => [
        {
          organization_id: organizationId,
          authorized_buildings: [{ id: refreshedBuildingId }],
        },
      ],
    } as unknown as Response;

    trackBuildingScopeRequest(request, signals);
    trackBuildingScopeResponse(response, signals);

    await expect
      .poll(() => signals.pendingBuildingScopeLoads.size)
      .toBe(0);
    expect(signals.buildingScopeFailures).toEqual([]);
    expect([...signals.buildingOrganizations]).toEqual([
      [refreshedBuildingId, organizationId],
    ]);
  });

  test("commits only the latest overlapping roster when JSON resolves out of order", async () => {
    const olderBuildingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const latestBuildingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const olderPayload = deferred<unknown>();
    const latestPayload = deferred<unknown>();
    const signals = {
      buildingOrganizations: new Map<string, string>(),
      buildingScopeFailures: [],
      pendingBuildingScopeLoads: new Set<Promise<void>>(),
      buildingScopeGeneration: 0,
      buildingScopeRequestGenerations: new Map<Request, number>(),
    } as unknown as RuntimeSignals;
    const response = (payload: Promise<unknown>) => {
      const request = organizationsRequest();
      return {
        request,
        response: {
          ok: () => true,
          url: () =>
            `https://example.supabase.co/rest/v1/rpc/${ORGANIZATIONS_RPC_NAME}`,
          request: () => request,
          json: () => payload,
        } as unknown as Response,
      };
    };
    const olderResponse = response(olderPayload.promise);
    const latestResponse = response(latestPayload.promise);

    trackBuildingScopeRequest(olderResponse.request, signals);
    trackBuildingScopeRequest(latestResponse.request, signals);
    trackBuildingScopeResponse(olderResponse.response, signals);
    trackBuildingScopeResponse(latestResponse.response, signals);

    latestPayload.resolve([
      {
        organization_id: organizationId,
        authorized_buildings: [{ id: latestBuildingId }],
      },
    ]);
    await expect
      .poll(() => signals.pendingBuildingScopeLoads.size)
      .toBe(1);
    expect([...signals.buildingOrganizations]).toEqual([
      [latestBuildingId, organizationId],
    ]);

    olderPayload.resolve([
      {
        organization_id: organizationId,
        authorized_buildings: [{ id: olderBuildingId }],
      },
    ]);
    await expect
      .poll(() => signals.pendingBuildingScopeLoads.size)
      .toBe(0);

    expect(signals.buildingScopeFailures).toEqual([]);
    expect([...signals.buildingOrganizations]).toEqual([
      [latestBuildingId, organizationId],
    ]);
  });

  test("orders overlapping roster captures by request start when response headers reverse", async () => {
    const olderBuildingId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd4";
    const latestBuildingId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5";
    const olderPayload = deferred<unknown>();
    const latestPayload = deferred<unknown>();
    const listeners = new Map<string, Array<(value: unknown) => void>>();
    const page = {
      on: (event: string, listener: (value: unknown) => void) => {
        const eventListeners = listeners.get(event) ?? [];
        eventListeners.push(listener);
        listeners.set(event, eventListeners);
      },
      url: () =>
        `https://ptcrm.vercel.app${ROUTE}?org=${organizationId}&tab=${VIEWS[0].id}`,
    } as unknown as Page;
    const emit = (event: string, value: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(value);
    };
    const request = () =>
      ({
        url: () =>
          `https://example.supabase.co/rest/v1/rpc/${ORGANIZATIONS_RPC_NAME}`,
        method: () => "POST",
        headers: () => ({}),
        resourceType: () => "fetch",
        postDataJSON: () => ({}),
      }) as unknown as Request;
    const response = (requestValue: Request, payload: Promise<unknown>) =>
      ({
        ok: () => true,
        status: () => 200,
        url: () =>
          `https://example.supabase.co/rest/v1/rpc/${ORGANIZATIONS_RPC_NAME}`,
        request: () => requestValue,
        json: () => payload,
      }) as unknown as Response;
    const olderRequest = request();
    const latestRequest = request();
    const olderResponse = response(olderRequest, olderPayload.promise);
    const latestResponse = response(latestRequest, latestPayload.promise);
    const signals = trackRuntimeSignals(page);

    emit("request", olderRequest);
    emit("request", latestRequest);
    emit("response", latestResponse);
    emit("response", olderResponse);

    latestPayload.resolve([
      {
        organization_id: organizationId,
        authorized_buildings: [{ id: latestBuildingId }],
      },
    ]);
    olderPayload.resolve([
      {
        organization_id: organizationId,
        authorized_buildings: [{ id: olderBuildingId }],
      },
    ]);
    await expect
      .poll(() => signals.pendingBuildingScopeLoads.size)
      .toBe(0);

    expect(signals.buildingScopeFailures).toEqual([]);
    expect([...signals.buildingOrganizations]).toEqual([
      [latestBuildingId, organizationId],
    ]);
  });

  test("ignores a stale invalid roster after the latest refresh commits", async () => {
    const latestBuildingId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
    const stalePayload = deferred<unknown>();
    const latestPayload = deferred<unknown>();
    const signals = {
      buildingOrganizations: new Map<string, string>(),
      buildingScopeFailures: [],
      pendingBuildingScopeLoads: new Set<Promise<void>>(),
      buildingScopeGeneration: 0,
      buildingScopeRequestGenerations: new Map<Request, number>(),
    } as unknown as RuntimeSignals;
    const response = (payload: Promise<unknown>) => {
      const request = organizationsRequest();
      return {
        request,
        response: {
          ok: () => true,
          url: () =>
            `https://example.supabase.co/rest/v1/rpc/${ORGANIZATIONS_RPC_NAME}`,
          request: () => request,
          json: () => payload,
        } as unknown as Response,
      };
    };
    const staleResponse = response(stalePayload.promise);
    const latestResponse = response(latestPayload.promise);

    trackBuildingScopeRequest(staleResponse.request, signals);
    trackBuildingScopeRequest(latestResponse.request, signals);
    trackBuildingScopeResponse(staleResponse.response, signals);
    trackBuildingScopeResponse(latestResponse.response, signals);

    latestPayload.resolve([
      {
        organization_id: organizationId,
        authorized_buildings: [{ id: latestBuildingId }],
      },
    ]);
    await expect
      .poll(() => signals.pendingBuildingScopeLoads.size)
      .toBe(1);

    stalePayload.resolve([
      {
        organization_id: organizationId,
        authorized_buildings: [{ id: "not-a-uuid" }],
      },
    ]);
    await expect
      .poll(() => signals.pendingBuildingScopeLoads.size)
      .toBe(0);

    expect(signals.buildingScopeFailures).toEqual([]);
    expect([...signals.buildingOrganizations]).toEqual([
      [latestBuildingId, organizationId],
    ]);
  });

  test("keeps the previous roster intact when a refresh is invalid", async () => {
    const previousBuildingId = "99999999-9999-4999-8999-999999999999";
    const partiallyValidBuildingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const signals = {
      buildingOrganizations: new Map([[previousBuildingId, organizationId]]),
      buildingScopeFailures: [],
      pendingBuildingScopeLoads: new Set<Promise<void>>(),
      buildingScopeGeneration: 0,
      buildingScopeRequestGenerations: new Map<Request, number>(),
    } as unknown as RuntimeSignals;
    const request = organizationsRequest();
    const response = {
      ok: () => true,
      url: () =>
        `https://example.supabase.co/rest/v1/rpc/${ORGANIZATIONS_RPC_NAME}`,
      request: () => request,
      json: async () => [
        {
          organization_id: organizationId,
          authorized_buildings: [
            { id: partiallyValidBuildingId },
            { id: "not-a-uuid" },
          ],
        },
      ],
    } as unknown as Response;

    trackBuildingScopeRequest(request, signals);
    trackBuildingScopeResponse(response, signals);

    await expect
      .poll(() => signals.pendingBuildingScopeLoads.size)
      .toBe(0);
    expect(signals.buildingScopeFailures).toEqual([
      "organizations roster building id must be a UUID",
    ]);
    expect([...signals.buildingOrganizations]).toEqual([
      [previousBuildingId, organizationId],
    ]);
  });

  test("treats P&L and snapshot wrappers as restricted finance RPCs", () => {
    const signals = {
      rpcRequests: [
        "business_performance_pnl_v1",
        "business_performance_snapshot_v1",
      ],
    } as RuntimeSignals;

    expect(() =>
      expectRestrictedRpcContract(signals, "restricted helper"),
    ).toThrow(/business_performance_pnl_v1.*business_performance_snapshot_v1/);
  });

  test("treats legacy P&L and snapshot RPCs as restricted finance RPCs", () => {
    const signals = {
      rpcRequests: ["fa_monthly_pnl_accrual", "fa_snapshot_kpis"],
    } as RuntimeSignals;

    expect(() =>
      expectRestrictedRpcContract(signals, "restricted legacy helper"),
    ).toThrow(/fa_monthly_pnl_accrual.*fa_snapshot_kpis/);
  });

  test("allows only organization discovery and the four occupancy/history wrappers for restricted users", () => {
    const allowedSignals = {
      rpcRequests: [
        "business_performance_organizations_v1",
        "business_performance_occupancy_snapshot_v1",
        "business_performance_upcoming_vacancy_v1",
        "business_performance_occupancy_monthly_v1",
        "business_performance_inventory_history_v1",
      ],
    } as RuntimeSignals;
    expect(() =>
      expectRestrictedRpcContract(allowedSignals, "restricted allowlist"),
    ).not.toThrow();

    const legacySignals = {
      rpcRequests: ["occupancy_snapshot_v2"],
    } as RuntimeSignals;
    expect(() =>
      expectRestrictedRpcContract(legacySignals, "restricted legacy RPC"),
    ).toThrow(/occupancy_snapshot_v2/);
  });

  test("rejects legacy and unknown RPCs on the standalone report", () => {
    const signals = {
      rpcRequestStarts: [
        {
          rpcName: "occupancy_snapshot_v2",
          pageUrl: `https://ptcrm.vercel.app${ROUTE}?org=dddd0000-0000-4000-8000-000000000001&tab=${VIEWS[2].id}`,
          payload: {},
        },
        {
          rpcName: "fa_snapshot_kpis",
          pageUrl: `https://ptcrm.vercel.app${ROUTE}?org=dddd0000-0000-4000-8000-000000000001&tab=${VIEWS[0].id}`,
          payload: {},
        },
        {
          rpcName: "business_performance_unknown_v1",
          pageUrl: `https://ptcrm.vercel.app${ROUTE}?org=dddd0000-0000-4000-8000-000000000001&tab=${VIEWS[0].id}`,
          payload: {},
        },
      ],
    } as RuntimeSignals;

    expect(() =>
      expectOnlyCurrentBusinessPerformanceRpcs(signals, "standalone helper"),
    ).toThrow(/occupancy_snapshot_v2.*fa_snapshot_kpis.*business_performance_unknown_v1/);
  });

  test("allows legacy finance RPC tracking on the preserved legacy report", () => {
    const signals = {
      rpcRequestStarts: [
        {
          rpcName: "fa_snapshot_kpis",
          pageUrl: `https://ptcrm.vercel.app${LEGACY_ANALYSIS_ROUTE}`,
          payload: {},
        },
      ],
    } as RuntimeSignals;

    expect(() =>
      expectOnlyCurrentBusinessPerformanceRpcs(signals, "legacy report helper"),
    ).not.toThrow();
  });

  test("rejects Business Performance report-data RPCs on legacy finance routes", () => {
    const signals = {
      rpcRequestStarts: [
        {
          rpcName: "business_performance_organizations_v1",
          pageUrl: `https://ptcrm.vercel.app${LEGACY_ANALYSIS_ROUTE}`,
          payload: {},
        },
        {
          rpcName: "business_performance_snapshot_v1",
          pageUrl: `https://ptcrm.vercel.app${PROFIT_HUB_ROUTE}`,
          payload: {},
        },
      ],
    } as RuntimeSignals;

    expect(() =>
      expectOnlyCurrentBusinessPerformanceRpcs(signals, "route isolation helper"),
    ).toThrow(/Business Performance RPCs outside the standalone route/);
  });

  test("rejects post-reset organization discovery on legacy finance routes", () => {
    const signals = {
      rpcRequestStarts: [LEGACY_ANALYSIS_ROUTE, PROFIT_HUB_ROUTE].map(
        (pageUrl) => ({
          rpcName: ORGANIZATIONS_RPC_NAME,
          pageUrl: `https://ptcrm.vercel.app${pageUrl}`,
          payload: {},
        }),
      ),
    } as RuntimeSignals;

    expect(() =>
      expectOnlyCurrentBusinessPerformanceRpcs(
        signals,
        "post-reset organization discovery",
      ),
    ).toThrow(/Business Performance RPCs outside the standalone route/);
  });

  test("fails closed when the restricted-content observer was not installed", async () => {
    const page = {
      evaluate: async () => undefined,
    } as unknown as Page;

    await expect(expectRestrictedContentNeverMounted(page)).rejects.toThrow(
      /observer must be installed/,
    );
  });

  test("retains restricted-content mount evidence across documents", async () => {
    let recordMount: ((marker: string) => void) | undefined;
    let currentDocumentObserverArmCount = 0;
    let initScriptPayload:
      | { markers: string[]; recorderName: string; selectors?: string[] }
      | undefined;
    const page = {
      exposeFunction: async (
        _name: string,
        callback: (marker: string) => void,
      ) => {
        recordMount = callback;
      },
      addInitScript: async (
        _script: unknown,
        payload: {
          markers: string[];
          recorderName: string;
          selectors?: string[];
        },
      ) => {
        initScriptPayload = payload;
      },
      evaluate: async () => {
        currentDocumentObserverArmCount += 1;
        return { installed: true, seenInDocument: false };
      },
    } as unknown as Page;

    await installRestrictedContentMountTracker(page, true);
    expect(currentDocumentObserverArmCount).toBe(1);
    expect(initScriptPayload?.selectors).toEqual([
      "#business-performance-active-report",
      '[data-testid="business-performance-view-picker"]',
    ]);
    expect(
      recordMount,
      "restricted-content observer needs a durable Node-side recorder",
    ).toBeDefined();
    recordMount!(RESTRICTED_CONTENT_MARKERS[0]);

    await expect(expectRestrictedContentNeverMounted(page)).rejects.toThrow(
      new RegExp(RESTRICTED_CONTENT_MARKERS[0]),
    );
  });
});

function relevantNetworkRequestLabel(page: Page, request: Request) {
  const requestUrl = new URL(request.url());
  let pageUrl: URL | null = null;
  try {
    pageUrl = new URL(page.url());
  } catch {
    // about:blank and other non-URL page states cannot own app chunks.
  }

  const sameOriginChunk =
    pageUrl?.protocol.startsWith("http") === true &&
    requestUrl.origin === pageUrl.origin &&
    (request.resourceType() === "script" ||
      request.resourceType() === "stylesheet");
  const supabaseApiRequest =
    SUPABASE_HOST_PATTERN.test(requestUrl.hostname) &&
    SUPABASE_API_PATH_PATTERN.test(requestUrl.pathname);

  if (sameOriginChunk) return `app chunk ${requestUrl.pathname}`;
  if (supabaseApiRequest) return `Supabase API ${requestUrl.pathname}`;
  return null;
}

function sameDocumentUrl(left: string, right: string) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.origin === rightUrl.origin &&
      leftUrl.pathname === rightUrl.pathname &&
      leftUrl.search === rightUrl.search
    );
  } catch {
    return false;
  }
}

function belongsToNavigationSource(
  requestPageUrl: string,
  requestReferer: string | null,
  sourceUrl: string | null,
) {
  if (!sourceUrl) return false;
  return (
    sameDocumentUrl(requestPageUrl, sourceUrl) ||
    (requestReferer !== null && sameDocumentUrl(requestReferer, sourceUrl))
  );
}

function isNotificationProbe(request: Request) {
  const requestUrl = new URL(request.url());
  return (
    request.method() === "HEAD" &&
    SUPABASE_HOST_PATTERN.test(requestUrl.hostname) &&
    requestUrl.pathname === "/rest/v1/notifications"
  );
}

function rpcRequestPayload(request: Request): unknown {
  try {
    return request.postDataJSON();
  } catch {
    return request.postData();
  }
}

function isOrganizationsRosterRequest(request: Request) {
  return (
    request.method() === "POST" &&
    new URL(request.url()).pathname ===
      `/rest/v1/rpc/${ORGANIZATIONS_RPC_NAME}`
  );
}

function isOrganizationsRosterResponse(response: Response) {
  return response.ok() && isOrganizationsRosterRequest(response.request());
}

function isBuildingScopeResponse(response: Response) {
  return isOrganizationsRosterResponse(response);
}

function captureOrganizationsRoster(payload: unknown) {
  if (!Array.isArray(payload)) {
    throw new Error("organizations roster response must be an array");
  }

  const buildingOrganizations = new Map<string, string>();
  for (const value of payload) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("organizations roster row must be an object");
    }
    const row = value as Record<string, unknown>;
    const organizationId = row.organization_id;
    if (
      typeof organizationId !== "string" ||
      !UUID_PATTERN.test(organizationId)
    ) {
      throw new Error("organizations roster organization_id must be a UUID");
    }
    if (!Array.isArray(row.authorized_buildings)) {
      throw new Error("organizations roster authorized_buildings must be an array");
    }

    for (const value of row.authorized_buildings) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("organizations roster building must be an object");
      }
      const buildingId = (value as Record<string, unknown>).id;
      if (typeof buildingId !== "string" || !UUID_PATTERN.test(buildingId)) {
        throw new Error("organizations roster building id must be a UUID");
      }
      buildingOrganizations.set(buildingId, organizationId);
    }
  }
  return buildingOrganizations;
}

async function captureBuildingOrganizations(
  response: Response,
  signals: RuntimeSignals,
  generation: number,
) {
  const payload: unknown = await response.json();
  const buildingOrganizations = captureOrganizationsRoster(payload);

  if (generation !== signals.buildingScopeGeneration) return;

  signals.buildingOrganizations.clear();
  for (const [buildingId, organizationId] of buildingOrganizations) {
    signals.buildingOrganizations.set(buildingId, organizationId);
  }
}

function trackBuildingScopeRequest(
  request: Request,
  signals: RuntimeSignals,
) {
  if (!isOrganizationsRosterRequest(request)) return;

  const generation = signals.buildingScopeGeneration + 1;
  signals.buildingScopeGeneration = generation;
  signals.buildingScopeRequestGenerations.set(request, generation);
}

function trackBuildingScopeResponse(
  response: Response,
  signals: RuntimeSignals,
) {
  const request = response.request();
  if (!isOrganizationsRosterRequest(request)) return;

  const generation = signals.buildingScopeRequestGenerations.get(request);
  signals.buildingScopeRequestGenerations.delete(request);
  if (!isBuildingScopeResponse(response)) return;
  if (generation === undefined) {
    signals.buildingScopeFailures.push(
      "organizations roster response is missing its request-start generation",
    );
    return;
  }

  const load = captureBuildingOrganizations(response, signals, generation).catch(
    (error) => {
      if (generation !== signals.buildingScopeGeneration) return;
      signals.buildingScopeFailures.push(
        error instanceof Error ? error.message : String(error),
      );
    },
  );
  signals.pendingBuildingScopeLoads.add(load);
  void load.finally(() => signals.pendingBuildingScopeLoads.delete(load));
}

function trackRuntimeSignals(page: Page): RuntimeSignals {
  const signals: RuntimeSignals = {
    pageErrors: [],
    rpcRequests: [],
    rpcRequestStarts: [],
    rpcResponseFailures: [],
    rpcRequestFailures: [],
    pendingRpcRequests: new Map(),
    buildingOrganizations: new Map(),
    buildingScopeFailures: [],
    pendingBuildingScopeLoads: new Set(),
    buildingScopeGeneration: 0,
    buildingScopeRequestGenerations: new Map(),
    networkResponseFailures: [],
    networkRequestFailures: [],
    pendingNetworkRequests: new Map(),
    navigationAbortSourceUrl: null,
    postCommitNotificationAbortWindow: false,
    trackingPaused: false,
  };

  page.on("pageerror", (error) => {
    if (!signals.trackingPaused) signals.pageErrors.push(error.message);
  });
  page.on("request", (request) => {
    trackBuildingScopeRequest(request, signals);
    if (signals.trackingPaused) {
      if (new URL(page.url()).pathname !== ROUTE) return;
      signals.trackingPaused = false;
    }
    const networkLabel = relevantNetworkRequestLabel(page, request);
    if (networkLabel) {
      const requestPageUrl = page.url();
      const requestReferer = request.headers().referer ?? null;
      signals.pendingNetworkRequests.set(request, {
        label: networkLabel,
        requestPageUrl,
        requestReferer,
        navigationAbortCandidate: belongsToNavigationSource(
          requestPageUrl,
          requestReferer,
          signals.navigationAbortSourceUrl,
        ),
      });
    }

    const rpcName = financeRpcName(request.url());
    if (!rpcName) return;
    signals.rpcRequests.push(rpcName);
    signals.rpcRequestStarts.push({
      rpcName,
      pageUrl: page.url(),
      payload: rpcRequestPayload(request),
      buildingOrganizationsAtStart: new Map(signals.buildingOrganizations),
      buildingScopeGenerationAtStart: signals.buildingScopeGeneration,
    });
    signals.pendingRpcRequests.set(request, rpcName);
  });
  page.on("response", (response) => {
    trackBuildingScopeResponse(response, signals);
    const request = response.request();
    const networkRequest = signals.pendingNetworkRequests.get(request);
    if (networkRequest) {
      if (!response.ok()) {
        signals.networkResponseFailures.push(
          `${response.status()} ${request.method()} ${networkRequest.label}`,
        );
      }
    }

    const rpcName = financeRpcName(response.url());
    if (!rpcName) return;
    signals.pendingRpcRequests.delete(request);
    if (!response.ok()) {
      signals.rpcResponseFailures.push(`${response.status()} ${rpcName}`);
    }
  });
  page.on("requestfinished", (request) => {
    signals.pendingNetworkRequests.delete(request);
    signals.buildingScopeRequestGenerations.delete(request);
  });
  page.on("requestfailed", (request) => {
    signals.buildingScopeRequestGenerations.delete(request);
    const failureText =
      request.failure()?.errorText ?? "unknown request failure";
    const networkRequest = signals.pendingNetworkRequests.get(request);
    let expectedNavigationAbort = false;
    if (networkRequest) {
      signals.pendingNetworkRequests.delete(request);
      const expectedPostCommitNotificationAbort =
        signals.postCommitNotificationAbortWindow &&
        isNotificationProbe(request) &&
        failureText === "net::ERR_ABORTED";
      expectedNavigationAbort =
        failureText === "net::ERR_ABORTED" &&
        (networkRequest.navigationAbortCandidate ||
          expectedPostCommitNotificationAbort);
      if (expectedPostCommitNotificationAbort) {
        signals.postCommitNotificationAbortWindow = false;
      }
      if (!expectedNavigationAbort) {
        signals.networkRequestFailures.push(
          `${request.method()} ${networkRequest.label}: ${failureText}`,
        );
      }
    }

    const rpcName = financeRpcName(request.url());
    if (!rpcName) return;
    signals.pendingRpcRequests.delete(request);
    if (!expectedNavigationAbort) {
      signals.rpcRequestFailures.push(`${rpcName}: ${failureText}`);
    }
  });

  return signals;
}

function markPendingNavigationAborts(signals: RuntimeSignals) {
  for (const networkRequest of signals.pendingNetworkRequests.values()) {
    networkRequest.navigationAbortCandidate = true;
  }
}

function clearRuntimeSignals(signals: RuntimeSignals) {
  markPendingNavigationAborts(signals);
  signals.rpcRequests.length = 0;
  signals.rpcRequestStarts.length = 0;
}

async function expectCapturedRpcBuildingScopes(
  signals: RuntimeSignals,
  context: string,
) {
  await expect
    .poll(() => signals.pendingBuildingScopeLoads.size, {
      message: `${context} building scope responses should finish parsing`,
    })
    .toBe(0);
  expect(
    signals.buildingScopeFailures,
    `${context} building scope capture failures: ${signals.buildingScopeFailures.join(" | ")}`,
  ).toEqual([]);

  for (const {
    rpcName,
    pageUrl,
    payload,
    buildingOrganizationsAtStart,
  } of signals.rpcRequestStarts) {
    const url = new URL(pageUrl);
    if (url.pathname !== ROUTE) continue;
    if (!METRIC_RPC_NAME_SET.has(rpcName)) continue;

    const organizationId = url.searchParams.get("org") ?? "";
    expectExplicitRpcBuildingScope(
      payload,
      organizationId,
      buildingOrganizationsAtStart ?? signals.buildingOrganizations,
      `${context} ${rpcName}`,
    );
  }
}

function beginNavigationBoundary(page: Page, signals: RuntimeSignals) {
  clearRuntimeSignals(signals);
  signals.navigationAbortSourceUrl = page.url();
  signals.postCommitNotificationAbortWindow = false;
  for (const networkRequest of signals.pendingNetworkRequests.values()) {
    networkRequest.navigationAbortCandidate = belongsToNavigationSource(
      networkRequest.requestPageUrl,
      networkRequest.requestReferer,
      signals.navigationAbortSourceUrl,
    );
  }
}

function endNavigationBoundary(signals: RuntimeSignals) {
  signals.navigationAbortSourceUrl = null;
}

async function runHardNavigationBoundary<T>(
  page: Page,
  signals: RuntimeSignals,
  navigate: () => Promise<T>,
) {
  signals.navigationAbortSourceUrl = page.url();
  signals.postCommitNotificationAbortWindow = false;
  markPendingNavigationAborts(signals);
  const sourceUrl = signals.navigationAbortSourceUrl;
  const endAtCommit = (frame: ReturnType<Page["mainFrame"]>) => {
    if (frame !== page.mainFrame()) return;
    if (signals.navigationAbortSourceUrl === sourceUrl) {
      endNavigationBoundary(signals);
    }
    signals.postCommitNotificationAbortWindow = true;
  };
  page.on("framenavigated", endAtCommit);

  try {
    return await navigate();
  } finally {
    page.off("framenavigated", endAtCommit);
    if (signals.navigationAbortSourceUrl === sourceUrl) {
      endNavigationBoundary(signals);
    }
    signals.postCommitNotificationAbortWindow = true;
  }
}

function expectRestrictedRpcContract(
  signals: RuntimeSignals,
  context: string,
) {
  const disallowedRequests = signals.rpcRequests.filter(
    (rpcName) => !RESTRICTED_ALLOWED_RPC_NAME_SET.has(rpcName),
  );
  expect(
    disallowedRequests,
    `${context} used RPCs outside organization discovery and the four occupancy/history wrappers: ${disallowedRequests.join(", ")}`,
  ).toEqual([]);
}

function expectOnlyCurrentBusinessPerformanceRpcs(
  signals: RuntimeSignals,
  context: string,
) {
  const misplacedRequests = signals.rpcRequestStarts
    .filter(
      ({ rpcName, pageUrl }) =>
        BUSINESS_PERFORMANCE_RPC_PATTERN.test(rpcName) &&
        new URL(pageUrl).pathname !== ROUTE,
    )
    .map(({ rpcName, pageUrl }) => `${rpcName} on ${new URL(pageUrl).pathname}`);
  expect(
    misplacedRequests,
    `${context} used Business Performance RPCs outside the standalone route: ${misplacedRequests.join(", ")}`,
  ).toEqual([]);

  const unsupportedRequests = signals.rpcRequestStarts
    .filter(({ rpcName, pageUrl }) => {
      const url = new URL(pageUrl);
      return (
        url.pathname === ROUTE &&
        !BUSINESS_PERFORMANCE_RPC_NAME_SET.has(rpcName)
      );
    })
    .map(({ rpcName }) => rpcName);
  expect(
    unsupportedRequests,
    `${context} used RPCs outside the exact thirteen business-performance wrappers: ${unsupportedRequests.join(", ")}`,
  ).toEqual([]);
}

async function installRestrictedContentMountTracker(
  page: Page,
  trackBusinessPerformanceShell = false,
) {
  if (restrictedContentMountEvidence.has(page)) return;

  const evidence: RestrictedContentMountEvidence = { markers: [] };
  const selectors = trackBusinessPerformanceShell
    ? [...BUSINESS_PERFORMANCE_DOM_SELECTORS]
    : [];
  restrictedContentMountEvidence.set(page, evidence);
  await page.exposeFunction(
    RESTRICTED_CONTENT_RECORDER,
    (marker: string) => {
      if (!evidence.markers.includes(marker)) evidence.markers.push(marker);
    },
  );
  await page.addInitScript(
    ({
      markers,
      recorderName,
      selectors,
    }: {
      markers: string[];
      recorderName: string;
      selectors: string[];
    }) => {
      const runtimeWindow = window as typeof window & {
        __restrictedBusinessObserverInstalled?: boolean;
        __restrictedBusinessContentSeen?: boolean;
        [key: string]: unknown;
      };
      runtimeWindow.__restrictedBusinessObserverInstalled = true;
      runtimeWindow.__restrictedBusinessContentSeen = false;

      const inspect = () => {
        const text = document.body?.innerText ?? "";
        const marker =
          selectors.find((candidate) => document.querySelector(candidate)) ??
          markers.find((candidate) => text.includes(candidate));
        if (!marker || runtimeWindow.__restrictedBusinessContentSeen) return;

        runtimeWindow.__restrictedBusinessContentSeen = true;
        const recordMount = runtimeWindow[recorderName];
        if (typeof recordMount === "function") void recordMount(marker);
      };
      const observe = () => {
        inspect();
        new MutationObserver(inspect).observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      };

      if (document.body) observe();
      else
        document.addEventListener("DOMContentLoaded", observe, { once: true });
    },
    {
      markers: [...RESTRICTED_CONTENT_MARKERS],
      recorderName: RESTRICTED_CONTENT_RECORDER,
      selectors,
    },
  );
  await page.evaluate(
    ({
      markers,
      recorderName,
      selectors,
    }: {
      markers: string[];
      recorderName: string;
      selectors: string[];
    }) => {
      const runtimeWindow = window as typeof window & {
        __restrictedBusinessObserverInstalled?: boolean;
        __restrictedBusinessContentSeen?: boolean;
        [key: string]: unknown;
      };
      runtimeWindow.__restrictedBusinessObserverInstalled = true;
      runtimeWindow.__restrictedBusinessContentSeen = false;

      const recordAddedNode = (node: Node) => {
        if (!(node instanceof Element)) return;
        const marker =
          selectors.find(
            (candidate) =>
              node.matches(candidate) || node.querySelector(candidate),
          ) ??
          markers.find((candidate) =>
            (node.textContent ?? "").includes(candidate),
          );
        if (!marker || runtimeWindow.__restrictedBusinessContentSeen) return;

        runtimeWindow.__restrictedBusinessContentSeen = true;
        const recordMount = runtimeWindow[recorderName];
        if (typeof recordMount === "function") void recordMount(marker);
      };
      const observe = () => {
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) recordAddedNode(node);
          }
        }).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      };

      if (document.documentElement) observe();
      else document.addEventListener("DOMContentLoaded", observe, { once: true });
    },
    {
      markers: [...RESTRICTED_CONTENT_MARKERS],
      recorderName: RESTRICTED_CONTENT_RECORDER,
      selectors,
    },
  );
}

async function expectRestrictedContentNeverMounted(page: Page) {
  const evidence = restrictedContentMountEvidence.get(page);
  expect(
    evidence,
    "restricted-content observer must be installed before navigation",
  ).toBeDefined();
  const currentDocumentState = await page.evaluate(
    () => {
      const runtimeWindow = window as typeof window & {
        __restrictedBusinessObserverInstalled?: boolean;
        __restrictedBusinessContentSeen?: boolean;
      };
      return {
        installed: runtimeWindow.__restrictedBusinessObserverInstalled === true,
        seenInDocument: runtimeWindow.__restrictedBusinessContentSeen === true,
      };
    },
  );
  expect(
    currentDocumentState.installed,
    "restricted-content observer must be installed before navigation",
  ).toBe(true);
  expect(
    currentDocumentState.seenInDocument,
    "restricted business-performance content must never mount",
  ).toBe(false);
  expect(
    evidence!.markers,
    `restricted business-performance content mounted in this or a prior document: ${evidence!.markers.join(" | ")}`,
  ).toEqual([]);
}

function expectCanonicalScopeAtRpcStart(
  signals: RuntimeSignals,
  view: View,
  allowedViews: readonly View[] = VIEWS,
  expectedBuildingIds?: readonly string[],
) {
  if (!DATA_BEARING_VIEW_IDS.has(view.id)) return;

  expect(
    allowedViews.some((allowedView) => allowedView.id === view.id),
    `${view.label} must be an allowed canonical view`,
  ).toBe(true);
  const metricRequestStarts = signals.rpcRequestStarts.filter(({ rpcName }) =>
    METRIC_RPC_NAME_SET.has(rpcName),
  );
  expect(
    metricRequestStarts.length,
    `${view.label} must capture at least one metric RPC start after the view becomes healthy`,
  ).toBeGreaterThan(0);

  for (const {
    rpcName,
    pageUrl,
    payload,
    buildingOrganizationsAtStart,
  } of metricRequestStarts) {
    const url = new URL(pageUrl);
    const organization = url.searchParams.get("org") ?? "";
    const tab = url.searchParams.get("tab");

    expect(
      url.pathname,
      `${rpcName} must start on the business report route`,
    ).toBe(ROUTE);
    expectDemoOrganizationScope(organization, `${rpcName} canonical scope`);
    expect(
      tab,
      `${rpcName} unexpected metric RPC start for ${tab ?? "missing tab"}; requested ${view.id}`,
    ).toBe(
      view.id,
    );
    const authoritativeRoster =
      buildingOrganizationsAtStart ?? signals.buildingOrganizations;
    expectExplicitRpcBuildingScope(
      payload,
      organization,
      authoritativeRoster,
      `${rpcName} canonical scope`,
    );
    const payloadBuildingIds = [
      ...((payload as Record<string, unknown>).p_building_ids as string[]),
    ].sort();
    const authoritativeBuildingIds = [
      ...(expectedBuildingIds ??
        [...authoritativeRoster]
          .filter(([, ownerOrganizationId]) => ownerOrganizationId === organization)
          .map(([buildingId]) => buildingId)),
    ].sort();
    expect(
      payloadBuildingIds,
      expectedBuildingIds
        ? `${rpcName} must equal the requested building filter scope`
        : `${rpcName} default all-buildings scope must equal the complete authoritative roster`,
    ).toEqual(authoritativeBuildingIds);
  }
}

async function openReport(page: Page, signals: RuntimeSignals) {
  signals.trackingPaused = true;
  await login(page, fullAccessUser());
  beginNavigationBoundary(page, signals);
  await runHardNavigationBoundary(page, signals, () => page.goto(ROUTE));
  signals.trackingPaused = false;
  await selectOrganizationIfNeeded(page);
  await expect(
    page.getByRole("heading", { name: PAGE_TITLE, exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => currentOrgParam(page) ?? "", {
      message: "report URL should contain ?org=<uuid>",
    })
    .toMatch(UUID_PATTERN);
  expectDemoOrganizationScope(currentOrgParam(page), "full-access report route");
  await expect
    .poll(() => currentTabParam(page), {
      message: `bare report URL should canonicalize to ?tab=${VIEWS[0].id}`,
    })
    .toBe(VIEWS[0].id);
  return currentOrgParam(page)!;
}

async function openRestrictedReport(
  page: Page,
  signals: RuntimeSignals,
  user: (typeof RESTRICTED_ACCESS_USERS)[number],
) {
  await installRestrictedContentMountTracker(page);
  signals.trackingPaused = true;
  await login(page, user);
  beginNavigationBoundary(page, signals);
  await runHardNavigationBoundary(page, signals, () => page.goto(ROUTE));
  signals.trackingPaused = false;
  await selectOrganizationIfNeeded(page);
  await expect(
    page.getByRole("heading", { name: PAGE_TITLE, exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => currentOrgParam(page) ?? "", {
      message: "restricted report URL should contain ?org=<uuid>",
    })
    .toMatch(UUID_PATTERN);
  expectDemoOrganizationScope(currentOrgParam(page), "restricted report route");
  await expect
    .poll(() => currentTabParam(page), {
      message: `restricted bare URL should canonicalize to ?tab=${RESTRICTED_VIEWS[0].id}`,
    })
    .toBe(RESTRICTED_VIEWS[0].id);
  return currentOrgParam(page)!;
}

function selectedTab(page: Page, view: View) {
  return page.getByRole("tab", { name: view.label, exact: true });
}

function currentTabParam(page: Page) {
  return new URL(page.url()).searchParams.get("tab");
}

function currentOrgParam(page: Page) {
  return new URL(page.url()).searchParams.get("org");
}

function shiftCanonicalMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function canonicalMonthEnd(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

function monthLabel(month: string) {
  const [year, monthNumber] = month.split("-");
  return `Tháng ${monthNumber}/${year}`;
}

function canonicalMonthFromLabel(label: string) {
  const match = label.match(/^Tháng (0[1-9]|1[0-2])\/(\d{4})$/);
  expect(match, `month picker label should be canonical: ${label}`).not.toBeNull();
  return `${match![2]}-${match![1]}`;
}

function expectPnlDateRange(
  signals: RuntimeSignals,
  month: string,
  context: string,
) {
  const pnlRequests = signals.rpcRequestStarts.filter(
    ({ rpcName }) => rpcName === "business_performance_pnl_v1",
  );
  expect(
    pnlRequests.length,
    `${context} should issue at least one P&L request`,
  ).toBeGreaterThan(0);
  for (const { payload } of pnlRequests) {
    expect(payload, `${context} P&L payload`).toMatchObject({
      p_start_date: `${shiftCanonicalMonth(month, -12)}-01`,
      p_end_date: canonicalMonthEnd(month),
    });
  }
}

function expectExactMetricBuildingScope(
  signals: RuntimeSignals,
  buildingId: string,
  context: string,
) {
  const metricRequests = signals.rpcRequestStarts.filter(({ rpcName }) =>
    METRIC_RPC_NAME_SET.has(rpcName),
  );
  expect(
    metricRequests.length,
    `${context} should issue at least one metric RPC`,
  ).toBeGreaterThan(0);
  for (const { rpcName, payload } of metricRequests) {
    expect(payload, `${context} ${rpcName} payload`).toMatchObject({
      p_building_ids: [buildingId],
    });
  }
}

async function selectOrganizationIfNeeded(page: Page) {
  const picker = page.getByRole("combobox", {
    name: /^Chọn tổ chức(?: báo cáo)?$/,
  });
  const isVisible = await picker
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (!isVisible) return null;

  await expect(picker).toBeEnabled();
  const tagName = await picker.evaluate((element) => element.tagName);
  if (tagName === "SELECT") {
    const firstAllowed = await picker
      .locator("option")
      .evaluateAll(
        (options) =>
          options
            .map((option) => option as HTMLOptionElement)
            .find((option) => !option.disabled && Boolean(option.value))?.value,
      );
    expect(
      firstAllowed,
      "organization picker needs an enabled option",
    ).toBeTruthy();
    await picker.selectOption(firstAllowed!);
  } else {
    await picker.click();
    await page
      .locator('[role="option"]:not([aria-disabled="true"])')
      .first()
      .click();
  }

  await expect
    .poll(() => currentOrgParam(page) ?? "", {
      message: "organization selection should set ?org=<uuid>",
    })
    .toMatch(UUID_PATTERN);
  expectDemoOrganizationScope(currentOrgParam(page), "organization selection");
}

async function recoverInvalidOrganizationIfAvailable(page: Page) {
  const picker = page.getByRole("combobox", {
    name: /^Chọn tổ chức(?: báo cáo)?$/,
  });
  if (await picker.isVisible().catch(() => false)) {
    await selectOrganizationIfNeeded(page);
    return true;
  }

  const invalidOrganizationAlert = page
    .getByRole("alert")
    .filter({ hasText: "Liên kết tổ chức không hợp lệ" });
  const inlineRecoveryControl = invalidOrganizationAlert
    .locator('button, a[href], [role="button"]')
    .first();
  if (await inlineRecoveryControl.isVisible().catch(() => false)) {
    await inlineRecoveryControl.click();
    return true;
  }

  return false;
}

async function expectRuntimeClean(
  consoleErrors: string[],
  signals: RuntimeSignals,
  context: string,
) {
  await expect
    .poll(() => signals.pendingNetworkRequests.size, {
      message: `${context} relevant network requests should settle`,
    })
    .toBe(0);
  await expect
    .poll(() => signals.pendingRpcRequests.size, {
      message: `${context} finance RPC requests should settle`,
    })
    .toBe(0);
  await expectCapturedRpcBuildingScopes(signals, context);
  expectOnlyCurrentBusinessPerformanceRpcs(signals, context);
  signals.postCommitNotificationAbortWindow = false;
  expect(
    consoleErrors,
    `${context} console errors: ${consoleErrors.join(" | ")}`,
  ).toEqual([]);
  expect(
    signals.pageErrors,
    `${context} page errors: ${signals.pageErrors.join(" | ")}`,
  ).toEqual([]);
  expect(
    signals.rpcResponseFailures,
    `${context} failed finance RPC responses: ${signals.rpcResponseFailures.join(" | ")}`,
  ).toEqual([]);
  expect(
    signals.rpcRequestFailures,
    `${context} failed finance RPC requests: ${signals.rpcRequestFailures.join(" | ")}`,
  ).toEqual([]);
  expect(
    signals.networkResponseFailures,
    `${context} non-2xx app chunk or Supabase responses: ${signals.networkResponseFailures.join(" | ")}`,
  ).toEqual([]);
  expect(
    signals.networkRequestFailures,
    `${context} failed app chunk or Supabase requests: ${signals.networkRequestFailures.join(" | ")}`,
  ).toEqual([]);
}

async function chooseMobileView(page: Page, picker: Locator, name: string) {
  const tagName = await picker.evaluate((element) => element.tagName);

  if (tagName === "SELECT") {
    await picker.focus();
    await expect(picker).toBeFocused();
    await picker.selectOption({ label: name });
    await expectMobilePickerSelection(picker, name);
    return;
  }

  await picker.click();
  await page.getByRole("option", { name, exact: true }).click();
  await expectMobilePickerSelection(picker, name);
}

async function chooseSearchableOption(
  picker: Locator,
  option: Locator,
) {
  await picker.click();
  await expect(option).toBeVisible();
  await option.click();
  await expect(picker).toBeFocused();
}

async function expectMobilePickerSelection(picker: Locator, name: string) {
  const tagName = await picker.evaluate((element) => element.tagName);
  if (tagName === "SELECT") {
    await expect(picker.locator("option:checked")).toHaveText(name);
  } else {
    await expect(picker).toContainText(name);
  }
}

async function selectAlternateBasisWithKeyboard(page: Page) {
  const picker = page.getByRole("combobox", {
    name: "Chọn cơ sở ghi nhận",
    exact: true,
  });
  const accrualLabel = "Dồn tích theo kỳ áp dụng";
  const voucherLabel = "Theo ngày phiếu — đối chiếu";

  await expect(picker).toBeVisible();
  await expect(picker).toBeEnabled();
  const currentLabel = (await picker.innerText()).trim();
  const targetLabel = currentLabel.includes("Dồn tích")
    ? voucherLabel
    : accrualLabel;

  await picker.focus();
  await expect(picker).toBeFocused();
  await picker.press("Enter");
  const targetOption = page.getByRole("option", {
    name: targetLabel,
    exact: true,
  });
  await expect(targetOption).toBeVisible();
  await page.keyboard.press(targetLabel === accrualLabel ? "Home" : "End");
  await expect(targetOption).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(picker).toContainText(targetLabel);
}

async function expectNativeMobilePickerKeyboardControl(
  page: Page,
  picker: Locator,
) {
  const initialView = VIEWS[0];
  const keyboardView = VIEWS[1];

  await expect(picker).toHaveJSProperty("tagName", "SELECT");
  await expect(picker).toHaveAttribute(
    "aria-controls",
    "business-performance-active-report",
  );
  await expectMobilePickerSelection(picker, initialView.label);
  await picker.focus();
  await expect(picker).toBeFocused();
  await picker.press("ArrowDown");
  await expectMobilePickerSelection(picker, keyboardView.label);
  await expect
    .poll(() => currentTabParam(page), {
      message: "native mobile picker keyboard selection should update ?tab",
    })
    .toBe(keyboardView.id);

  const activeReport = page.getByRole("region", {
    name: `Góc nhìn hiện tại: ${keyboardView.label}`,
    exact: true,
  });
  await expect(activeReport).toBeVisible();
  await expect(activeReport.getByText(keyboardView.content).first()).toBeVisible();
}

async function expectNoDocumentOverflow(page: Page, viewportWidth: number) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.clientWidth, "document client width").toBe(viewportWidth);
  expect(
    dimensions.scrollWidth,
    `document should not overflow horizontally at ${viewportWidth}px`,
  ).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function expectFirstOverviewKpiWithinFold(
  page: Page,
  viewportWidth: number,
  viewportHeight: number,
) {
  const firstKpi = page
    .locator('section[aria-labelledby="overview-pnl-title"] .border-l-4')
    .first();
  await expect(firstKpi).toContainText("Doanh thu");
  await expect(firstKpi).toBeVisible();

  const position = await firstKpi.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      bottom: rect.bottom,
    };
  });
  expect(
    position.width,
    `${viewportWidth}px first overview KPI should have non-zero width`,
  ).toBeGreaterThan(0);
  expect(
    position.height,
    `${viewportWidth}px first overview KPI should have non-zero height`,
  ).toBeGreaterThan(0);
  expect(
    position.scrollY,
    `${viewportWidth}px fold assertion must run before document scrolling`,
  ).toBe(0);
  expect(
    position.top,
    `${viewportWidth}px first overview KPI should start inside the viewport`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    position.bottom,
    `${viewportWidth}px first overview KPI should fit within the initial ${viewportHeight}px viewport`,
  ).toBeLessThanOrEqual(viewportHeight);
}

async function expectLocalTrendChartScrollers(
  page: Page,
  viewportWidth: number,
) {
  const regionNames = [
    "Doanh thu, chi phí và lợi nhuận — 13 tháng",
    "Biên lợi nhuận và tỷ lệ chi phí — 13 tháng",
  ] as const;

  for (const [index, name] of regionNames.entries()) {
    const scroller = page.getByRole("region", { name, exact: true });
    await expect(scroller).toBeVisible();
    const metric = await scroller.evaluate((element) => {
      element.scrollLeft = 0;
      const rect = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        scrollLeft: element.scrollLeft,
        left: rect.left,
        right: rect.right,
        overflowX: getComputedStyle(element).overflowX,
      };
    });

    expect(
      metric.overflowX,
      `trend chart scroller ${index + 1} overflow mode`,
    ).toMatch(/^(?:auto|scroll)$/);
    expect(
      metric.left,
      `trend chart scroller ${index + 1} stays inside the viewport`,
    ).toBeGreaterThanOrEqual(-1);
    expect(
      metric.right,
      `trend chart scroller ${index + 1} stays inside the viewport`,
    ).toBeLessThanOrEqual(viewportWidth + 1);

    await scroller.focus();
    await expect(scroller).toBeFocused();
    await scroller.press("ArrowRight");
    if (metric.scrollWidth > metric.clientWidth) {
      await expect
        .poll(() => scroller.evaluate((element) => element.scrollLeft), {
          message: `${name} should scroll right from the keyboard`,
        })
        .toBeGreaterThan(metric.scrollLeft);
    }
  }
}

async function expectViewHealthy(
  page: Page,
  view: View,
  consoleErrors: string[],
  signals: RuntimeSignals,
) {
  const viewPicker = page.getByTestId("business-performance-view-picker");
  await expect(viewPicker.getByText(view.content).first()).toBeVisible();
  await expect(
    viewPicker.locator('[role="status"][aria-label^="Đang tải"]'),
  ).toHaveCount(0);
  await expect(
    viewPicker
      .locator('[role="status"]')
      .filter({ hasText: "Đang tải dữ liệu tài chính" }),
  ).toHaveCount(0);
  await expect(
    viewPicker.getByRole("alert").filter({ hasText: /^Không thể tải/ }),
  ).toHaveCount(0);
  await expect(
    viewPicker.getByRole("button", { name: "Thử lại", exact: true }),
  ).toHaveCount(0);
  await expectRuntimeClean(consoleErrors, signals, view.label);
}

async function selectDesktopView(page: Page, view: View) {
  const tab = selectedTab(page, view);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => currentTabParam(page), {
      message: `${view.label} should set ?tab=${view.id}`,
    })
    .toBe(view.id);
}

async function selectDesktopViewWithCanonicalScope(
  page: Page,
  view: View,
  consoleErrors: string[],
  signals: RuntimeSignals,
) {
  consoleErrors.length = 0;
  clearRuntimeSignals(signals);
  await selectDesktopView(page, view);
  if (DATA_BEARING_VIEW_IDS.has(view.id)) {
    await runHardNavigationBoundary(page, signals, () => page.reload());
    await expect(selectedTab(page, view)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect.poll(() => currentTabParam(page)).toBe(view.id);
  }
  await expectViewHealthy(page, view, consoleErrors, signals);
  expectCanonicalScopeAtRpcStart(signals, view);
}

async function expectAllMobileViewsWithoutDocumentOverflow(
  page: Page,
  picker: Locator,
  consoleErrors: string[],
  signals: RuntimeSignals,
  viewportWidth: number,
  viewportHeight: number,
) {
  await page.setViewportSize({
    width: viewportWidth,
    height: viewportHeight,
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(() => page.evaluate(() => window.scrollY), {
      message: `${viewportWidth}px viewport scenario should start at the document top`,
    })
    .toBe(0);
  await expect(
    page
      .getByTestId("business-performance-view-picker")
      .getByRole("tablist", {
        name: "Góc nhìn tài chính",
        exact: true,
      }),
  ).toHaveCount(0);

  for (const view of VIEWS) {
    if (currentTabParam(page) !== view.id) {
      await chooseMobileView(page, picker, view.label);
    } else {
      await expectMobilePickerSelection(picker, view.label);
    }
    await expect
      .poll(() => currentTabParam(page), {
        message: `${view.label} should set ?tab=${view.id} at ${viewportWidth}px`,
      })
      .toBe(view.id);
    await expectViewHealthy(page, view, consoleErrors, signals);
    await expectNoDocumentOverflow(page, viewportWidth);

    if (view.id === VIEWS[0].id) {
      await expectFirstOverviewKpiWithinFold(
        page,
        viewportWidth,
        viewportHeight,
      );
    }
    if (view.id === VIEWS[5].id) {
      await expectLocalTrendChartScrollers(page, viewportWidth);
    }
  }
}

test.describe("Trung tâm Tài chính & Hiệu quả kinh doanh", () => {
  test("desktop renders all views and preserves tab navigation through URL history", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);
    const runtimeSignals = trackRuntimeSignals(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const organization = await openReport(page, runtimeSignals);

    const sidebarLink = page.getByRole("link", {
      name: "Trung tâm tài chính",
      exact: true,
    });
    await expect(sidebarLink).toBeVisible();
    await expect(sidebarLink).toHaveAttribute("href", ROUTE);

    const viewPicker = page.getByTestId("business-performance-view-picker");
    const desktopTabList = viewPicker.getByRole("tablist", {
      name: "Góc nhìn tài chính",
      exact: true,
    });
    await expect(desktopTabList.getByRole("tab")).toHaveCount(VIEWS.length);
    for (const view of VIEWS) {
      await expect(selectedTab(page, view)).toBeVisible();
    }
    await expect(selectedTab(page, VIEWS[0])).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect.poll(() => currentTabParam(page)).toBe(VIEWS[0].id);
    await expectViewHealthy(page, VIEWS[0], consoleErrors, runtimeSignals);
    expectCanonicalScopeAtRpcStart(runtimeSignals, VIEWS[0]);

    consoleErrors.length = 0;
    clearRuntimeSignals(runtimeSignals);
    await selectAlternateBasisWithKeyboard(page);
    await expectViewHealthy(page, VIEWS[0], consoleErrors, runtimeSignals);
    expectCanonicalScopeAtRpcStart(runtimeSignals, VIEWS[0]);

    await selectDesktopViewWithCanonicalScope(
      page,
      VIEWS[1],
      consoleErrors,
      runtimeSignals,
    );
    const buildingParam = VIEWS[1].id;

    await selectDesktopViewWithCanonicalScope(
      page,
      VIEWS[2],
      consoleErrors,
      runtimeSignals,
    );
    const occupancyParam = VIEWS[2].id;

    await runHardNavigationBoundary(page, runtimeSignals, () => page.reload());
    await expect(selectedTab(page, VIEWS[2])).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(currentTabParam(page)).toBe(occupancyParam);
    await expectViewHealthy(page, VIEWS[2], consoleErrors, runtimeSignals);

    await runHardNavigationBoundary(page, runtimeSignals, () => page.goBack());
    await expect(selectedTab(page, VIEWS[1])).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(currentTabParam(page)).toBe(buildingParam);
    await expectViewHealthy(page, VIEWS[1], consoleErrors, runtimeSignals);

    await runHardNavigationBoundary(page, runtimeSignals, () =>
      page.goForward(),
    );
    await expect(selectedTab(page, VIEWS[2])).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(currentTabParam(page)).toBe(occupancyParam);
    await expectViewHealthy(page, VIEWS[2], consoleErrors, runtimeSignals);

    for (const view of VIEWS.slice(3)) {
      await selectDesktopViewWithCanonicalScope(
        page,
        view,
        consoleErrors,
        runtimeSignals,
      );
    }

    await selectDesktopViewWithCanonicalScope(
      page,
      VIEWS[0],
      consoleErrors,
      runtimeSignals,
    );
    expect(currentOrgParam(page)).toBe(organization);
  });

  test("month and building filters persist and send exact RPC payload scope", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);
    const runtimeSignals = trackRuntimeSignals(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openReport(page, runtimeSignals);
    await expectViewHealthy(page, VIEWS[0], consoleErrors, runtimeSignals);

    const monthPicker = page.getByRole("combobox", {
      name: "Chọn kỳ báo cáo",
      exact: true,
    });
    const initialMonth = canonicalMonthFromLabel(
      (await monthPicker.innerText()).trim(),
    );
    const targetMonth = shiftCanonicalMonth(initialMonth, -1);
    const targetMonthLabel = monthLabel(targetMonth);

    consoleErrors.length = 0;
    clearRuntimeSignals(runtimeSignals);
    await chooseSearchableOption(
      monthPicker,
      page.getByRole("option", { name: targetMonthLabel, exact: true }),
    );
    await expect(monthPicker).toContainText(targetMonthLabel);
    await expectViewHealthy(page, VIEWS[0], consoleErrors, runtimeSignals);
    expectPnlDateRange(runtimeSignals, targetMonth, "month filter change");
    expectCanonicalScopeAtRpcStart(runtimeSignals, VIEWS[0]);

    consoleErrors.length = 0;
    clearRuntimeSignals(runtimeSignals);
    await runHardNavigationBoundary(page, runtimeSignals, () => page.reload());
    await expect(monthPicker).toContainText(targetMonthLabel);
    await expectViewHealthy(page, VIEWS[0], consoleErrors, runtimeSignals);
    expectPnlDateRange(runtimeSignals, targetMonth, "month filter reload");
    expectCanonicalScopeAtRpcStart(runtimeSignals, VIEWS[0]);

    const buildingPicker = page.getByRole("combobox", {
      name: "Chọn tòa nhà vật lý",
      exact: true,
    });
    await expect(buildingPicker).toBeVisible();
    await expect(buildingPicker).toBeEnabled();
    await buildingPicker.click();
    await expect
      .poll(() => page.getByRole("option").count(), {
        message: "building filter should expose all-buildings plus a physical building",
      })
      .toBeGreaterThan(1);
    const buildingOptions = await page.getByRole("option").evaluateAll(
      (options) =>
        options.map((option) => ({
          label: option.textContent?.trim() ?? "",
          value: option.getAttribute("data-value") ?? "",
        })),
    );
    const specificBuilding = buildingOptions.find(({ value }) =>
      UUID_PATTERN.test(value),
    );
    expect(
      specificBuilding,
      "building filter should expose a physical building UUID",
    ).toBeDefined();

    consoleErrors.length = 0;
    clearRuntimeSignals(runtimeSignals);
    await page
      .locator(
        `[role="option"][data-value="${specificBuilding!.value}"]`,
      )
      .click();
    await expect(buildingPicker).toBeFocused();
    await expect(buildingPicker).toContainText(specificBuilding!.label);
    await expectViewHealthy(page, VIEWS[0], consoleErrors, runtimeSignals);
    expectPnlDateRange(runtimeSignals, targetMonth, "building filter change");
    expectExactMetricBuildingScope(
      runtimeSignals,
      specificBuilding!.value,
      "building filter change",
    );
    expectCanonicalScopeAtRpcStart(runtimeSignals, VIEWS[0], VIEWS, [
      specificBuilding!.value,
    ]);
  });

  test("legacy analysis navigation remains additive", async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const runtimeSignals = trackRuntimeSignals(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openReport(page, runtimeSignals);
    await expectViewHealthy(page, VIEWS[0], consoleErrors, runtimeSignals);
    expectCanonicalScopeAtRpcStart(runtimeSignals, VIEWS[0]);

    const centerLink = page.getByRole("link", {
      name: "Trung tâm tài chính",
      exact: true,
    });
    const legacyAnalysisLink = page.getByRole("link", {
      name: "Phân tích tài chính",
      exact: true,
    });

    await expect(centerLink).toBeVisible();
    await expect(centerLink).toHaveAttribute("href", ROUTE);
    await expect(legacyAnalysisLink).toBeVisible();
    await expect(legacyAnalysisLink).toHaveAttribute(
      "href",
      LEGACY_ANALYSIS_ROUTE,
    );

    await installRestrictedContentMountTracker(page, true);
    consoleErrors.length = 0;
    clearRuntimeSignals(runtimeSignals);
    await runHardNavigationBoundary(page, runtimeSignals, () =>
      legacyAnalysisLink.click(),
    );
    await expect(
      page.getByRole("heading", {
        name: "Phân tích tài chính",
        exact: true,
      }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(LEGACY_ANALYSIS_ROUTE);
    await expect(page.getByRole("tab")).toHaveCount(5);
    await expect(page.locator("main .animate-pulse")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: PAGE_TITLE, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("business-performance-view-picker"),
    ).toHaveCount(0);
    await expect(
      page.locator("#business-performance-active-report"),
    ).toHaveCount(0);
    for (const view of VIEWS) {
      await expect(
        page.getByRole("tab", { name: view.label, exact: true }),
      ).toHaveCount(0);
    }
    await expectRestrictedContentNeverMounted(page);
    await expectRuntimeClean(
      consoleErrors,
      runtimeSignals,
      "legacy financial analysis",
    );
  });

  test("profit distribution route keeps the legacy Profit Hub isolated from Business Performance", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await login(page, fullAccessUser());
    await page.waitForLoadState("networkidle");
    const welcomeDialog = page.getByRole("dialog", {
      name: "Chào mừng",
      exact: true,
    });
    if (await welcomeDialog.isVisible().catch(() => false)) {
      await welcomeDialog
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(welcomeDialog).toBeHidden();
    }
    const financeReportsMenu = page.getByRole("button", {
      name: "Báo cáo tài chính",
      exact: true,
    });
    await expect(financeReportsMenu).toBeVisible();
    await financeReportsMenu.click();
    const profitHubLink = page
      .locator(`a[href="${PROFIT_HUB_ROUTE}"]`)
      .first();
    await expect(profitHubLink).toBeVisible();
    const consoleErrors = trackConsoleErrors(page);
    const runtimeSignals = trackRuntimeSignals(page);
    await installRestrictedContentMountTracker(page, true);
    clearRuntimeSignals(runtimeSignals);
    await runHardNavigationBoundary(page, runtimeSignals, () =>
      profitHubLink.click(),
    );

    expect(new URL(page.url()).pathname).toBe(PROFIT_HUB_ROUTE);
    await expect(
      page.locator("main").getByRole("button", {
        name: "Báo cáo Lợi Nhuận",
        exact: true,
      }),
    ).toBeVisible();
    const legacyReportTab = page.getByRole("tab", {
      name: "BC Doanh Thu Chi Phí",
      exact: true,
    });
    await expect(legacyReportTab).toBeVisible();
    await expect(legacyReportTab).toHaveAttribute("aria-selected", "true");
    await expect(
      page.locator("main").getByText("Doanh thu", { exact: true }).first(),
    ).toBeVisible();

    await expect(
      page.getByRole("heading", { name: PAGE_TITLE, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("business-performance-view-picker"),
    ).toHaveCount(0);
    await expect(
      page.locator("#business-performance-active-report"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("tablist", {
        name: "Góc nhìn tài chính",
        exact: true,
      }),
    ).toHaveCount(0);
    for (const view of VIEWS) {
      await expect(
        page.getByRole("tab", { name: view.label, exact: true }),
      ).toHaveCount(0);
    }
    await expectRestrictedContentNeverMounted(page);
    await expectRuntimeClean(consoleErrors, runtimeSignals, "legacy Profit Hub");
  });

  for (const restrictedUser of RESTRICTED_ACCESS_USERS) {
    test(`restricted ${restrictedUser} persona exposes only safe views and never mounts restricted finance`, async ({
      page,
    }) => {
    const consoleErrors = trackConsoleErrors(page);
    const runtimeSignals = trackRuntimeSignals(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const organization = await openRestrictedReport(
      page,
      runtimeSignals,
      restrictedUser,
    );

    const viewPicker = page.getByTestId("business-performance-view-picker");
    const desktopTabList = viewPicker.getByRole("tablist", {
      name: "Góc nhìn tài chính",
      exact: true,
    });
    await expect(desktopTabList.getByRole("tab")).toHaveCount(
      RESTRICTED_VIEWS.length,
    );
    for (const view of RESTRICTED_VIEWS) {
      await expect(selectedTab(page, view)).toBeVisible();
    }
    for (const view of VIEWS.filter(
      (candidate) =>
        !RESTRICTED_VIEWS.some((safeView) => safeView.id === candidate.id),
    )) {
      await expect(selectedTab(page, view)).toHaveCount(0);
    }
    await expect(
      page.getByText("Phạm vi xem được giới hạn theo quyền", { exact: true }),
    ).toBeVisible();
    await expectViewHealthy(
      page,
      RESTRICTED_VIEWS[0],
      consoleErrors,
      runtimeSignals,
    );
    expectCanonicalScopeAtRpcStart(
      runtimeSignals,
      RESTRICTED_VIEWS[0],
      RESTRICTED_VIEWS,
    );
    expectRestrictedRpcContract(runtimeSignals, "restricted bare route");
    await expectRestrictedContentNeverMounted(page);

    await selectDesktopView(page, RESTRICTED_VIEWS[1]);
    await expectViewHealthy(
      page,
      RESTRICTED_VIEWS[1],
      consoleErrors,
      runtimeSignals,
    );
    expectRestrictedRpcContract(runtimeSignals, "restricted safe views");

    consoleErrors.length = 0;
    clearRuntimeSignals(runtimeSignals);
    await expectRestrictedContentNeverMounted(page);
    await runHardNavigationBoundary(page, runtimeSignals, () =>
      page.goto(`${ROUTE}?org=${organization}&tab=${VIEWS[3].id}`),
    );
    await expect(
      page.getByRole("heading", { name: PAGE_TITLE, exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => currentTabParam(page), {
        message: `restricted deep link should canonicalize to ?tab=${RESTRICTED_VIEWS[0].id}`,
      })
      .toBe(RESTRICTED_VIEWS[0].id);
    expect(currentOrgParam(page)).toBe(organization);
    await expect(selectedTab(page, RESTRICTED_VIEWS[0])).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.getByText("Phạm vi xem được giới hạn theo quyền", { exact: true }),
    ).toBeVisible();
    await expectViewHealthy(
      page,
      RESTRICTED_VIEWS[0],
      consoleErrors,
      runtimeSignals,
    );
    expectCanonicalScopeAtRpcStart(
      runtimeSignals,
      RESTRICTED_VIEWS[0],
      RESTRICTED_VIEWS,
    );
    expectRestrictedRpcContract(runtimeSignals, "restricted deep link");
    for (const marker of RESTRICTED_CONTENT_MARKERS) {
      await expect(viewPicker.getByText(marker, { exact: true })).toHaveCount(
        0,
      );
    }
    await expectRestrictedContentNeverMounted(page);

    const backNavigationUrls: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) backNavigationUrls.push(frame.url());
    });
    await expectRestrictedContentNeverMounted(page);
    await runHardNavigationBoundary(page, runtimeSignals, () => page.goBack());
    await expect(selectedTab(page, RESTRICTED_VIEWS[1])).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect.poll(() => currentTabParam(page)).toBe(RESTRICTED_VIEWS[1].id);
    expect(
      backNavigationUrls.some(
        (url) => new URL(url).searchParams.get("tab") === VIEWS[3].id,
      ),
      "Back must not revisit the restricted tab URL after replace canonicalization",
    ).toBe(false);
    await expectViewHealthy(
      page,
      RESTRICTED_VIEWS[1],
      consoleErrors,
      runtimeSignals,
    );
    expectRestrictedRpcContract(
      runtimeSignals,
      "restricted history traversal",
    );
    await expectRestrictedContentNeverMounted(page);
    });
  }

  test("invalid tab query is replace-canonicalized while preserving organization scope", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);
    const runtimeSignals = trackRuntimeSignals(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const organization = await openReport(page, runtimeSignals);
    await expectViewHealthy(page, VIEWS[0], consoleErrors, runtimeSignals);
    expectCanonicalScopeAtRpcStart(runtimeSignals, VIEWS[0]);
    await selectDesktopView(page, VIEWS[1]);
    await expectViewHealthy(page, VIEWS[1], consoleErrors, runtimeSignals);

    consoleErrors.length = 0;
    clearRuntimeSignals(runtimeSignals);
    await runHardNavigationBoundary(page, runtimeSignals, () =>
      page.goto(`${ROUTE}?org=${organization}&tab=not-a-real-business-view`),
    );
    await expect(
      page.getByRole("heading", { name: PAGE_TITLE, exact: true }),
    ).toBeVisible();
    await expect.poll(() => currentTabParam(page)).toBe(VIEWS[0].id);

    await expect(selectedTab(page, VIEWS[0])).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(currentOrgParam(page)).toBe(organization);
    await expectViewHealthy(page, VIEWS[0], consoleErrors, runtimeSignals);
    expectCanonicalScopeAtRpcStart(runtimeSignals, VIEWS[0]);

    const backNavigationUrls: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) backNavigationUrls.push(frame.url());
    });
    await runHardNavigationBoundary(page, runtimeSignals, () => page.goBack());
    await expect(selectedTab(page, VIEWS[1])).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect.poll(() => currentTabParam(page)).toBe(VIEWS[1].id);
    expect(
      backNavigationUrls.some(
        (url) =>
          new URL(url).searchParams.get("tab") === "not-a-real-business-view",
      ),
      "Back must not revisit the invalid tab URL after replace canonicalization",
    ).toBe(false);
    await expectViewHealthy(page, VIEWS[1], consoleErrors, runtimeSignals);
  });

  test("out-of-scope organization fails closed without finance RPC requests", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);
    const runtimeSignals = trackRuntimeSignals(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openReport(page, runtimeSignals);
    await expectViewHealthy(page, VIEWS[0], consoleErrors, runtimeSignals);
    expectCanonicalScopeAtRpcStart(runtimeSignals, VIEWS[0]);
    consoleErrors.length = 0;
    clearRuntimeSignals(runtimeSignals);

    await runHardNavigationBoundary(page, runtimeSignals, () =>
      page.goto(
        `${ROUTE}?org=${INVALID_ORGANIZATION_ID}&tab=${VIEWS[0].id}`,
      ),
    );
    await expect(
      page.getByRole("heading", { name: PAGE_TITLE, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Liên kết tổ chức không hợp lệ", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Tổ chức trong đường dẫn không thuộc phạm vi hiện tại.", {
        exact: false,
      }),
    ).toBeVisible();
    const viewPicker = page.getByTestId("business-performance-view-picker");
    for (const view of VIEWS) {
      await expect(viewPicker.getByText(view.content)).toHaveCount(0);
    }
    await expect(
      viewPicker.locator('[role="status"][aria-label^="Đang tải"]'),
    ).toHaveCount(0);
    await expect(
      viewPicker
        .locator('[role="status"]')
        .filter({ hasText: "Đang tải dữ liệu tài chính" }),
    ).toHaveCount(0);
    expect(currentOrgParam(page)).toBe(INVALID_ORGANIZATION_ID);
    await expectRuntimeClean(
      consoleErrors,
      runtimeSignals,
      "out-of-scope organization",
    );
    const invalidOrganizationMetricRpcs = runtimeSignals.rpcRequests.filter(
      (rpcName) => METRIC_RPC_NAME_SET.has(rpcName),
    );
    expect(
      invalidOrganizationMetricRpcs,
      `out-of-scope navigation issued metric RPCs: ${invalidOrganizationMetricRpcs.join(", ")}`,
    ).toEqual([]);

    consoleErrors.length = 0;
    clearRuntimeSignals(runtimeSignals);
    const recoveryExposed = await recoverInvalidOrganizationIfAvailable(page);
    if (recoveryExposed) {
      await expect(
        page.getByText("Liên kết tổ chức không hợp lệ", { exact: true }),
      ).toHaveCount(0);
      await expect
        .poll(() => currentOrgParam(page) ?? "", {
          message: "invalid organization recovery should restore a valid org",
        })
        .toMatch(UUID_PATTERN);
      expectDemoOrganizationScope(
        currentOrgParam(page),
        "invalid organization recovery",
      );
      expect(currentOrgParam(page)).not.toBe(INVALID_ORGANIZATION_ID);
      await expect
        .poll(
          () => VIEWS.some((view) => view.id === currentTabParam(page)),
          { message: "recovery should restore a canonical business view" },
        )
        .toBe(true);
      const recoveredView = VIEWS.find(
        (view) => view.id === currentTabParam(page),
      );
      expect(recoveredView).toBeDefined();
      await expectViewHealthy(
        page,
        recoveredView!,
        consoleErrors,
        runtimeSignals,
      );
      expectCanonicalScopeAtRpcStart(runtimeSignals, recoveredView!);
    }
  });

  test("restricted quanly mobile exposes only safe views and replace-canonicalizes restricted deep links", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);
    const runtimeSignals = trackRuntimeSignals(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const organization = await openRestrictedReport(
      page,
      runtimeSignals,
      "quanly",
    );

    const viewPicker = page.getByTestId("business-performance-view-picker");
    const picker = viewPicker.getByRole("combobox", {
      name: "Chọn góc nhìn tài chính",
      exact: true,
    });
    await expect(picker).toBeVisible();
    await expect(
      viewPicker.getByRole("tablist", {
        name: "Góc nhìn tài chính",
        exact: true,
      }),
    ).toHaveCount(0);
    const availableOptions = await picker.locator("option").evaluateAll(
      (options) =>
        options.map((option) => ({
          label: (option as HTMLOptionElement).text,
          value: (option as HTMLOptionElement).value,
        })),
    );
    expect(availableOptions).toEqual(
      RESTRICTED_VIEWS.map((view) => ({
        label: view.label,
        value: view.id,
      })),
    );
    await expectMobilePickerSelection(picker, RESTRICTED_VIEWS[0].label);
    await expectViewHealthy(
      page,
      RESTRICTED_VIEWS[0],
      consoleErrors,
      runtimeSignals,
    );
    expectCanonicalScopeAtRpcStart(
      runtimeSignals,
      RESTRICTED_VIEWS[0],
      RESTRICTED_VIEWS,
    );
    expectRestrictedRpcContract(runtimeSignals, "restricted mobile bare route");
    await expectRestrictedContentNeverMounted(page);

    await chooseMobileView(page, picker, RESTRICTED_VIEWS[1].label);
    await expect.poll(() => currentTabParam(page)).toBe(RESTRICTED_VIEWS[1].id);
    await expectViewHealthy(
      page,
      RESTRICTED_VIEWS[1],
      consoleErrors,
      runtimeSignals,
    );
    expectRestrictedRpcContract(runtimeSignals, "restricted mobile safe views");

    consoleErrors.length = 0;
    clearRuntimeSignals(runtimeSignals);
    await expectRestrictedContentNeverMounted(page);
    await runHardNavigationBoundary(page, runtimeSignals, () =>
      page.goto(`${ROUTE}?org=${organization}&tab=${VIEWS[3].id}`),
    );
    await expect
      .poll(() => currentTabParam(page), {
        message: `restricted mobile deep link should canonicalize to ?tab=${RESTRICTED_VIEWS[0].id}`,
      })
      .toBe(RESTRICTED_VIEWS[0].id);
    expect(currentOrgParam(page)).toBe(organization);
    await expectMobilePickerSelection(picker, RESTRICTED_VIEWS[0].label);
    await expectViewHealthy(
      page,
      RESTRICTED_VIEWS[0],
      consoleErrors,
      runtimeSignals,
    );
    expectCanonicalScopeAtRpcStart(
      runtimeSignals,
      RESTRICTED_VIEWS[0],
      RESTRICTED_VIEWS,
    );
    expectRestrictedRpcContract(runtimeSignals, "restricted mobile deep link");
    for (const marker of RESTRICTED_CONTENT_MARKERS) {
      await expect(viewPicker.getByText(marker, { exact: true })).toHaveCount(
        0,
      );
    }
    await expectRestrictedContentNeverMounted(page);

    const backNavigationUrls: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) backNavigationUrls.push(frame.url());
    });
    await expectRestrictedContentNeverMounted(page);
    await runHardNavigationBoundary(page, runtimeSignals, () => page.goBack());
    await expect.poll(() => currentTabParam(page)).toBe(RESTRICTED_VIEWS[1].id);
    await expectMobilePickerSelection(picker, RESTRICTED_VIEWS[1].label);
    expect(
      backNavigationUrls.some(
        (url) => new URL(url).searchParams.get("tab") === VIEWS[3].id,
      ),
      "Mobile Back must not revisit the restricted tab URL after replace canonicalization",
    ).toBe(false);
    await expectViewHealthy(
      page,
      RESTRICTED_VIEWS[1],
      consoleErrors,
      runtimeSignals,
    );
    expectRestrictedRpcContract(
      runtimeSignals,
      "restricted mobile history traversal",
    );
    await expectRestrictedContentNeverMounted(page);
    await expectNoDocumentOverflow(page, 390);
  });

  test("mobile uses a view picker with keyboard control of a named region and no accessible horizontal tabs", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);
    const runtimeSignals = trackRuntimeSignals(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const organization = await openReport(page, runtimeSignals);

    const viewPicker = page.getByTestId("business-performance-view-picker");
    const picker = viewPicker.getByRole("combobox", {
      name: "Chọn góc nhìn tài chính",
      exact: true,
    });
    const desktopTabList = viewPicker.getByRole("tablist", {
      name: "Góc nhìn tài chính",
      exact: true,
    });

    await expect(picker).toBeVisible();
    await expect(desktopTabList).toHaveCount(0);
    await expectNativeMobilePickerKeyboardControl(page, picker);
    await expectViewHealthy(page, VIEWS[1], consoleErrors, runtimeSignals);

    await expectAllMobileViewsWithoutDocumentOverflow(
      page,
      picker,
      consoleErrors,
      runtimeSignals,
      390,
      844,
    );
    await chooseMobileView(page, picker, VIEWS[0].label);
    await expect.poll(() => currentTabParam(page)).toBe(VIEWS[0].id);
    consoleErrors.length = 0;
    clearRuntimeSignals(runtimeSignals);
    await runHardNavigationBoundary(page, runtimeSignals, () => page.reload());
    await expectMobilePickerSelection(picker, VIEWS[0].label);
    await expectViewHealthy(page, VIEWS[0], consoleErrors, runtimeSignals);
    expectCanonicalScopeAtRpcStart(runtimeSignals, VIEWS[0]);

    await expectAllMobileViewsWithoutDocumentOverflow(
      page,
      picker,
      consoleErrors,
      runtimeSignals,
      320,
      844,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await chooseMobileView(page, picker, VIEWS[5].label);
    await expect.poll(() => currentTabParam(page)).toBe(VIEWS[5].id);
    await expectViewHealthy(page, VIEWS[5], consoleErrors, runtimeSignals);
    await runHardNavigationBoundary(page, runtimeSignals, () => page.reload());
    await expect(picker).toBeVisible();
    await expectMobilePickerSelection(picker, VIEWS[5].label);
    expect(currentTabParam(page)).toBe(VIEWS[5].id);
    expect(currentOrgParam(page)).toBe(organization);
    await expect(desktopTabList).toHaveCount(0);
    await expectViewHealthy(page, VIEWS[5], consoleErrors, runtimeSignals);
    await expectNoDocumentOverflow(page, 390);
    await expectLocalTrendChartScrollers(page, 390);
  });
});
