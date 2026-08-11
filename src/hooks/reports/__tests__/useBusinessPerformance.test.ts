import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBusinessPerformanceFilters,
  BusinessPerformanceDataError,
} from "@/lib/businessPerformance";

const mocks = vi.hoisted(() => ({
  // Cố ý KHÔNG khai kiểu tham số cho `vi.fn` ở đây. Đã thử
  // `vi.fn<(name: string, params?: Record<string, unknown>) => unknown>()` và nó
  // ĐỔI 2 lỗi thành 4: tham số hàm là contravariant, nên vừa chặn
  // `mockImplementation` nhận hình dạng params cụ thể, vừa không khớp chỗ đọc.
  // Mock RPC vốn nhận payload đủ hình dạng; chỗ ĐỌC mới là nơi biết mình mong gì.
  rpc: vi.fn(),
  useQuery: vi.fn((options: unknown) => options),
  authUser: { id: "user-a" } as { id: string } | null,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: mocks.useQuery,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: mocks.rpc },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ data: mocks.authUser }),
}));

import {
  useBusinessPerformanceOrganizations,
  useBusinessPerformancePnl,
  useBusinessPerformanceSnapshot,
} from "../useBusinessPerformance";
import * as businessPerformanceHooks from "../useBusinessPerformance";

type QueryOptions<T> = {
  enabled: boolean;
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  staleTime?: number;
  refetchInterval?: number | false;
  refetchOnWindowFocus?: boolean | "always";
  refetchIntervalInBackground?: boolean;
};

type OccupancyHookModule = {
  useBusinessPerformanceOccupancySnapshot: (
    organizationId: string,
    asOfDate: string,
    buildingIds: readonly string[],
    enabled?: boolean,
  ) => unknown;
  useBusinessPerformanceUpcomingVacancy: (
    organizationId: string,
    asOfDate: string,
    windowDays: number,
    buildingIds: readonly string[],
    enabled?: boolean,
  ) => unknown;
  useBusinessPerformanceOccupancyTrend12m: (
    organizationId: string,
    buildingIds: readonly string[],
    enabled?: boolean,
  ) => unknown;
};

const ORGANIZATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORGANIZATION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BUILDING_A = "11111111-1111-4111-8111-111111111111";
const BUILDING_B = "22222222-2222-4222-8222-222222222222";
const VIRTUAL_A = "33333333-3333-4333-8333-333333333333";
const USER_A = "user-a";
const USER_B = "user-b";

function buildingUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function organizationRpcRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    organization_id: ORGANIZATION_A,
    organization_name: "Organization A",
    authorized_buildings: [
      {
        id: BUILDING_A,
        name: "Building A",
        restricted_allowed: true,
        analysis_provenance: {
          permission_key: "reports_finance.analysis",
          decision_reason: "ROLE_PERMISSION",
        },
      },
    ],
    authorized_physical_building_count: 1,
    authorization_version: 7,
    ...overrides,
  };
}

function snapshotRpcRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    building_id: BUILDING_A,
    building_name: "A",
    total_rooms: 1,
    rooms_available: 1,
    rooms_occupied: 0,
    rooms_reserved: 0,
    rooms_maintenance: 0,
    rooms_unavailable: 0,
    vacancy_loss_month: 0,
    active_contracts: 0,
    avg_rent: 0,
    deposit_held: 0,
    receivable_total: 0,
    aging_not_due: 0,
    aging_1_30: 0,
    aging_31_60: 0,
    aging_61_90: 0,
    aging_over_90: 0,
    ...overrides,
  };
}

function occupancySnapshotRpcRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    building_id: BUILDING_A,
    building_name: "Building A",
    total: 4,
    occupied: 2,
    reserved: 1,
    maintenance: 0,
    unavailable: 0,
    available: 1,
    occupancy_pct: 50,
    committed_pct: 75,
    missed_revenue: 3_000_000,
    generated_at: "2026-07-25T03:00:00.000Z",
    ...overrides,
  };
}

function upcomingVacancyRpcRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contract_id: "44444444-4444-4444-8444-444444444444",
    contract_number: "HD-001",
    building_id: BUILDING_A,
    building_name: "Building A",
    room_id: "55555555-5555-4555-8555-555555555555",
    room_name: "101",
    effective_end_date: "2026-08-24",
    days_remaining: 30,
    rent_price: 3_000_000,
    extension_applied: false,
    ...overrides,
  };
}

function occupancyMonthlyRpcRow(
  buildingId = BUILDING_A,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    month: "2026-07-01",
    building_id: buildingId,
    building_name: buildingId,
    total_rooms: 4,
    occupied_rooms: 2,
    occupancy_pct: 50,
    ...overrides,
  };
}

const OCCUPANCY_TREND_MONTHS = [
  "2025-08-01",
  "2025-09-01",
  "2025-10-01",
  "2025-11-01",
  "2025-12-01",
  "2026-01-01",
  "2026-02-01",
  "2026-03-01",
  "2026-04-01",
  "2026-05-01",
  "2026-06-01",
  "2026-07-01",
] as const;

function occupancyMonthlyRpcMatrix(
  buildingIds: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown>[] {
  return buildingIds.flatMap((buildingId) =>
    OCCUPANCY_TREND_MONTHS.map((month) =>
      occupancyMonthlyRpcRow(buildingId, { month, ...overrides }),
    ),
  );
}

function getOccupancyHooks(): OccupancyHookModule {
  const hooks = businessPerformanceHooks as unknown as Partial<OccupancyHookModule>;
  for (const name of [
    "useBusinessPerformanceOccupancySnapshot",
    "useBusinessPerformanceUpcomingVacancy",
    "useBusinessPerformanceOccupancyTrend12m",
  ] as const) {
    if (typeof hooks[name] !== "function") {
      throw new Error(`Expected ${name} to be exported`);
    }
  }
  return hooks as OccupancyHookModule;
}

describe("business performance data hooks", () => {
  beforeEach(() => {
    mocks.authUser = { id: USER_A };
    mocks.rpc.mockReset();
    mocks.useQuery.mockClear();
  });

  it("bounds report staleness while mounted without background polling", () => {
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );

    const pnl = useBusinessPerformancePnl(filters) as unknown as QueryOptions<
      unknown[]
    >;
    const organizations =
      useBusinessPerformanceOrganizations() as unknown as QueryOptions<
        unknown[]
      >;
    const snapshot = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;

    expect(pnl).toMatchObject({ staleTime: 300_000, refetchInterval: 300_000 });
    expect(organizations).toMatchObject({
      staleTime: 300_000,
      refetchInterval: 300_000,
    });
    expect(snapshot).toMatchObject({
      staleTime: 60_000,
      refetchInterval: 60_000,
    });
    expect(
      [pnl, organizations, snapshot].every(
        (options) => options.refetchIntervalInBackground === undefined,
      ),
    ).toBe(true);
  });

  it("keeps the caller-level enablement gate disabled", () => {
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );

    expect(
      (
        useBusinessPerformancePnl(filters, false) as unknown as QueryOptions<
          unknown[]
        >
      ).enabled,
    ).toBe(false);
    expect(
      (
        useBusinessPerformanceOrganizations(false) as unknown as QueryOptions<
          unknown[]
        >
      ).enabled,
    ).toBe(false);
    expect(
      (
        useBusinessPerformanceSnapshot(
          ORGANIZATION_A,
          [BUILDING_A],
          false,
        ) as unknown as QueryOptions<unknown[]>
      ).enabled,
    ).toBe(false);
  });

  it("uses a principal-and-organization scoped P&L key and canonical RPC", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          month: "2024-02-01",
          building_id: BUILDING_A,
          building_name: "A",
          is_virtual: false,
          revenue: "150.5",
          expense: 50,
          net: "100.5",
        },
        {
          month: "2024-02-01",
          building_id: BUILDING_B,
          building_name: "B",
          is_virtual: false,
          revenue: 0,
          expense: 0,
          net: 0,
        },
      ],
      error: null,
    });
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_B, BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );

    const options = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;
    const rows = await options.queryFn();

    expect(options.enabled).toBe(true);
    expect(options.queryKey).toEqual([
      "business-performance",
      USER_A,
      "pnl",
      ORGANIZATION_A,
      "ACCRUAL",
      "2023-02-01",
      "2024-02-29",
      [BUILDING_A, BUILDING_B],
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith("business_performance_pnl_v1", {
      p_organization_id: ORGANIZATION_A,
      p_start_date: "2023-02-01",
      p_end_date: "2024-02-29",
      p_building_ids: [BUILDING_A, BUILDING_B],
      p_basis: "ACCRUAL",
    });
    expect(rows).toEqual([
      expect.objectContaining({ revenue: 150.5, expense: 50, net: 100.5 }),
      expect.objectContaining({ building_id: BUILDING_B }),
    ]);
  });

  it("chunks more than 84 buildings into bounded P&L RPC calls and combines every batch", async () => {
    const buildingIds = Array.from({ length: 85 }, (_, index) =>
      buildingUuid(index + 1),
    );
    mocks.rpc.mockImplementation(
      async (_functionName: string, params: { p_building_ids: string[] }) => ({
        data: params.p_building_ids.map((buildingId) => ({
          month: "2024-02-01",
          building_id: buildingId,
          building_name: buildingId,
          is_virtual: false,
          revenue: 10,
          expense: 1,
          net: 9,
        })),
        error: null,
      }),
    );
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [...buildingIds].reverse(),
      "ACCRUAL",
      ORGANIZATION_A,
    );

    const options = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;
    const rows = await options.queryFn();

    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    // Ép kiểu ở CHỖ ĐỌC, không ở chữ ký mock: `mock.calls` là `any[][]`, mà
    // `any[]` KHÔNG gán được vào tuple `[string, T]` (dài bao nhiêu không biết).
    // Chỗ đọc mới là nơi biết mình mong hình dạng gì, nên xác nhận ở đây.
    const batches = mocks.rpc.mock.calls.map((call) => {
      const [functionName, params] = call as [string, { p_building_ids: string[] }];
      expect(functionName).toBe("business_performance_pnl_v1");
      return params.p_building_ids;
    });
    expect(batches.map((batch) => batch.length)).toEqual([50, 35]);
    expect(batches.every((batch) => batch.length * 13 <= 650)).toBe(true);
    expect(batches.flat()).toEqual(buildingIds);
    expect(rows).toHaveLength(85);
    expect(rows[0]).toEqual(
      expect.objectContaining({ building_id: buildingIds[0] }),
    );
    expect(rows[84]).toEqual(
      expect.objectContaining({ building_id: buildingIds[84] }),
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      1,
      "business_performance_pnl_v1",
      expect.objectContaining({
        p_organization_id: ORGANIZATION_A,
        p_basis: "ACCRUAL",
      }),
    );
  });

  it("rejects a P&L row returned outside its individual RPC batch scope", async () => {
    const buildingIds = Array.from({ length: 51 }, (_, index) =>
      buildingUuid(index + 1),
    );
    mocks.rpc
      .mockResolvedValueOnce({
        data: [
          {
            month: "2024-02-01",
            building_id: buildingIds[50],
            building_name: "Wrong batch",
            is_virtual: false,
            revenue: 10,
            expense: 1,
            net: 9,
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null });
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      buildingIds,
      "ACCRUAL",
      ORGANIZATION_A,
    );

    const options = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).rejects.toMatchObject({
      field: "building_id",
    });
  });

  it("allows the canonical P&L RPC to omit zero-activity buildings", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );

    const options = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).resolves.toEqual([]);
  });

  it("rejects invalid numeric P&L payloads without substituting zero", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          month: "2024-02-01",
          building_id: BUILDING_A,
          building_name: "A",
          is_virtual: false,
          revenue: null,
          expense: 10,
          net: -10,
        },
      ],
      error: null,
    });
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "VOUCHER_DATE",
      ORGANIZATION_A,
    );

    const options = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).rejects.toBeInstanceOf(
      BusinessPerformanceDataError,
    );
    expect(mocks.rpc).toHaveBeenCalledWith("business_performance_pnl_v1", {
      p_organization_id: ORGANIZATION_A,
      p_start_date: "2023-02-01",
      p_end_date: "2024-02-29",
      p_building_ids: [BUILDING_A],
      p_basis: "VOUCHER_DATE",
    });
  });

  it("rejects a P&L row whose net disagrees with revenue minus expense", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          month: "2024-02-01",
          building_id: BUILDING_A,
          building_name: "A",
          is_virtual: false,
          revenue: 150.5,
          expense: 50,
          net: 99,
        },
      ],
      error: null,
    });
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );

    const options = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).rejects.toMatchObject({ field: "net" });
  });

  it("accepts floating-point noise when P&L net is database-consistent", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          month: "2024-02-01",
          building_id: BUILDING_A,
          building_name: "A",
          is_virtual: false,
          revenue: "0.3",
          expense: "0.2",
          net: "0.1",
        },
      ],
      error: null,
    });
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "VOUCHER_DATE",
      ORGANIZATION_A,
    );

    const options = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).resolves.toEqual([
      expect.objectContaining({ revenue: 0.3, expense: 0.2, net: 0.1 }),
    ]);
  });

  it.each([null, "2024-2", "2024-13", "2024-02garbage", "2024-02-30"])(
    "rejects a P&L row with invalid month %p inside the query function",
    async (month) => {
      mocks.rpc.mockResolvedValue({
        data: [
          {
            month,
            building_id: BUILDING_A,
            building_name: "A",
            is_virtual: false,
            revenue: 10,
            expense: 1,
            net: 9,
          },
        ],
        error: null,
      });
      const filters = buildBusinessPerformanceFilters(
        "2024-02",
        [BUILDING_A],
        "ACCRUAL",
        ORGANIZATION_A,
      );

      const options = useBusinessPerformancePnl(
        filters,
      ) as unknown as QueryOptions<unknown[]>;

      await expect(options.queryFn()).rejects.toMatchObject({ field: "month" });
    },
  );

  it("normalizes a canonical P&L month to the current database date shape", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          month: "2024-02",
          building_id: BUILDING_A,
          building_name: "A",
          is_virtual: false,
          revenue: 10,
          expense: 1,
          net: 9,
        },
      ],
      error: null,
    });
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );

    const options = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).resolves.toEqual([
      expect.objectContaining({ month: "2024-02-01" }),
    ]);
  });

  it("rejects an invalid runtime P&L basis before calling an RPC", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          month: "2024-02-01",
          building_id: BUILDING_A,
          building_name: "A",
          is_virtual: false,
          revenue: 0,
          expense: 0,
          net: 0,
        },
      ],
      error: null,
    });
    const filters = {
      ...buildBusinessPerformanceFilters(
        "2024-02",
        [BUILDING_A],
        "ACCRUAL",
        ORGANIZATION_A,
      ),
      basis: "CASH" as never,
    };

    const options = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).rejects.toMatchObject({ field: "basis" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["t13Start", "2024-2-01", "2024-02-29"],
    ["t13Start", "2024-02-30", "2024-03-31"],
    ["t13End", "2024-02-01", "2024-2-29"],
    ["t13End", "2024-02-01", "2024-02-30"],
    ["t13End", "2024-03-01", "2024-02-29"],
  ])(
    "rejects an invalid P&L date range at %s before calling an RPC",
    async (field, t13Start, t13End) => {
      mocks.rpc.mockResolvedValue({ data: [], error: null });
      const filters = {
        ...buildBusinessPerformanceFilters(
          "2024-02",
          [BUILDING_A],
          "ACCRUAL",
          ORGANIZATION_A,
        ),
        t13Start,
        t13End,
      };

      const options = useBusinessPerformancePnl(
        filters,
      ) as unknown as QueryOptions<unknown[]>;

      await expect(options.queryFn()).rejects.toMatchObject({ field });
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("trims UUID scope values before querying P&L", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          month: "2024-02-01",
          building_id: BUILDING_A,
          building_name: "A",
          is_virtual: false,
          revenue: 0,
          expense: 0,
          net: 0,
        },
      ],
      error: null,
    });
    const filters = {
      ...buildBusinessPerformanceFilters(
        "2024-02",
        [BUILDING_A],
        "ACCRUAL",
        ORGANIZATION_A,
      ),
      buildingIds: [` ${BUILDING_A} `],
      organizationId: ` ${ORGANIZATION_A} `,
    };

    const options = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).resolves.toHaveLength(1);
    expect(options.queryKey[3]).toBe(ORGANIZATION_A);
    expect(mocks.rpc).toHaveBeenCalledWith("business_performance_pnl_v1", {
      p_organization_id: ORGANIZATION_A,
      p_start_date: "2023-02-01",
      p_end_date: "2024-02-29",
      p_building_ids: [BUILDING_A],
      p_basis: "ACCRUAL",
    });
  });

  it.each([
    ["organizationId", { organizationId: "not-a-uuid" }],
    ["buildingIds", { buildingIds: ["not-a-uuid"] }],
  ])(
    "rejects invalid P&L UUID scope at %s before calling an RPC",
    async (field, override) => {
      mocks.rpc.mockResolvedValue({ data: [], error: null });
      const filters = {
        ...buildBusinessPerformanceFilters(
          "2024-02",
          [BUILDING_A],
          "ACCRUAL",
          ORGANIZATION_A,
        ),
        ...override,
      };

      const options = useBusinessPerformancePnl(
        filters,
      ) as unknown as QueryOptions<unknown[]>;

      await expect(options.queryFn()).rejects.toMatchObject({ field });
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("rejects successful null P&L and snapshot RPC payloads", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );
    const pnl = useBusinessPerformancePnl(filters) as unknown as QueryOptions<
      unknown[]
    >;
    const snapshot = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;

    await expect(pnl.queryFn()).rejects.toMatchObject({ field: "pnl" });
    await expect(snapshot.queryFn()).rejects.toMatchObject({
      field: "snapshot",
    });
  });

  it("rejects a virtual P&L row returned for an explicit physical scope", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          month: "2024-02-01",
          building_id: VIRTUAL_A,
          building_name: "Virtual",
          is_virtual: true,
          revenue: 10,
          expense: 1,
          net: 9,
        },
      ],
      error: null,
    });
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );

    const options = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).rejects.toMatchObject({
      field: "is_virtual",
    });
  });

  it.each([
    ["null", { is_virtual: null }],
    ["missing", {}],
  ])(
    "rejects a P&L row when is_virtual is %s",
    async (_label, virtualField) => {
      mocks.rpc.mockResolvedValue({
        data: [
          {
            month: "2024-02-01",
            building_id: BUILDING_A,
            building_name: "A",
            revenue: 10,
            expense: 1,
            net: 9,
            ...virtualField,
          },
        ],
        error: null,
      });
      const filters = buildBusinessPerformanceFilters(
        "2024-02",
        [BUILDING_A],
        "ACCRUAL",
        ORGANIZATION_A,
      );

      const options = useBusinessPerformancePnl(
        filters,
      ) as unknown as QueryOptions<unknown[]>;

      await expect(options.queryFn()).rejects.toMatchObject({
        field: "is_virtual",
      });
    },
  );

  it("rejects a P&L row outside the explicit requested building IDs", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          month: "2024-02-01",
          building_id: BUILDING_B,
          building_name: "B",
          is_virtual: false,
          revenue: 10,
          expense: 1,
          net: 9,
        },
      ],
      error: null,
    });
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );

    const options = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).rejects.toMatchObject({
      field: "building_id",
    });
  });

  it("gates analytics when no explicit physical building ID is ready", () => {
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [],
      "ACCRUAL",
      ORGANIZATION_A,
    );

    const pnl = useBusinessPerformancePnl(filters) as unknown as QueryOptions<
      unknown[]
    >;
    const snapshot = useBusinessPerformanceSnapshot(
      ORGANIZATION_A,
      [],
    ) as unknown as QueryOptions<unknown[]>;
    const organizations =
      useBusinessPerformanceOrganizations() as unknown as QueryOptions<
        unknown[]
      >;

    expect(pnl.enabled).toBe(false);
    expect(snapshot.enabled).toBe(false);
    expect(organizations.enabled).toBe(true);
  });

  it("disables every business-performance query while unauthenticated", () => {
    mocks.authUser = null;
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );

    const pnl = useBusinessPerformancePnl(filters) as unknown as QueryOptions<
      unknown[]
    >;
    const snapshot = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;
    const organizations =
      useBusinessPerformanceOrganizations() as unknown as QueryOptions<
        unknown[]
      >;

    expect(pnl.enabled).toBe(false);
    expect(snapshot.enabled).toBe(false);
    expect(organizations.enabled).toBe(false);
  });

  it("separates identical business-performance filters by principal", () => {
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );
    const userAOptions = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    mocks.authUser = { id: USER_B };
    const userBOptions = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    expect(userAOptions.queryKey[0]).toBe("business-performance");
    expect(userAOptions.queryKey[1]).toBe(USER_A);
    expect(userBOptions.queryKey[1]).toBe(USER_B);
    expect(userAOptions.queryKey).not.toEqual(userBOptions.queryKey);
  });

  it("separates snapshot caches by principal and organization", () => {
    const orgA = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;
    const orgB = useBusinessPerformanceSnapshot(ORGANIZATION_B, [
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;

    mocks.authUser = { id: USER_B };
    const userB = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;

    expect(orgA.queryKey).toEqual([
      "business-performance",
      USER_A,
      "snapshot",
      ORGANIZATION_A,
      [BUILDING_A],
    ]);
    expect(orgA.queryKey).not.toEqual(orgB.queryKey);
    expect(orgA.queryKey).not.toEqual(userB.queryKey);
  });

  it("blocks manual refetch before any explicit scope ID is ready", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [],
      "ACCRUAL",
      ORGANIZATION_A,
    );
    const pnl = useBusinessPerformancePnl(filters) as unknown as QueryOptions<
      unknown[]
    >;
    const snapshot = useBusinessPerformanceSnapshot(
      ORGANIZATION_A,
      [],
    ) as unknown as QueryOptions<unknown[]>;

    await expect(pnl.queryFn()).rejects.toMatchObject({ field: "buildingIds" });
    await expect(snapshot.queryFn()).rejects.toMatchObject({
      field: "buildingIds",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])(
    "blocks manual P&L refetch when organizationId is %p",
    async (organizationId) => {
      mocks.rpc.mockResolvedValue({ data: [], error: null });
      const filters = {
        ...buildBusinessPerformanceFilters(
          "2024-02",
          [BUILDING_A],
          "ACCRUAL",
          ORGANIZATION_A,
        ),
        organizationId: organizationId as string,
      };

      const options = useBusinessPerformancePnl(
        filters,
      ) as unknown as QueryOptions<unknown[]>;

      await expect(options.queryFn()).rejects.toMatchObject({
        field: "organizationId",
      });
      expect(options.enabled).toBe(false);
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "   "])(
    "blocks manual snapshot refetch when organizationId is %p",
    async (organizationId) => {
      mocks.rpc.mockResolvedValue({ data: [], error: null });
      const options = useBusinessPerformanceSnapshot(organizationId as string, [
        BUILDING_A,
      ]) as unknown as QueryOptions<unknown[]>;

      await expect(options.queryFn()).rejects.toMatchObject({
        field: "organizationId",
      });
      expect(options.enabled).toBe(false);
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("propagates P&L RPC failures unchanged", async () => {
    const rpcError = { code: "42501", message: "denied" };
    mocks.rpc.mockResolvedValue({ data: null, error: rpcError });
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );
    const options = useBusinessPerformancePnl(
      filters,
    ) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).rejects.toBe(rpcError);
  });

  it("returns the complete canonical organization roster contract", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          organization_id: ORGANIZATION_B,
          organization_name: "Organization B",
          authorized_buildings: [
            {
              id: BUILDING_B,
              name: "Building B",
              restricted_allowed: false,
              analysis_provenance: { decision_reason: "LEGACY_VIEW_ALLOW" },
            },
          ],
          authorized_physical_building_count: 1,
          authorization_version: 7,
        },
        {
          organization_id: ORGANIZATION_A,
          organization_name: "Organization A",
          authorized_buildings: [
            {
              id: BUILDING_A,
              name: "Building A",
              restricted_allowed: true,
              analysis_provenance: {
                permission_key: "reports_finance.analysis",
              },
            },
          ],
          authorized_physical_building_count: 1,
          authorization_version: 4,
        },
      ],
      error: null,
    });

    const options =
      useBusinessPerformanceOrganizations() as unknown as QueryOptions<
        unknown[]
      >;
    const rows = await options.queryFn();

    expect(options.queryKey).toEqual([
      "business-performance",
      USER_A,
      "organizations",
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "business_performance_organizations_v1",
    );
    expect(rows).toEqual([
      {
        id: ORGANIZATION_B,
        name: "Organization B",
        authorized_buildings: [
          {
            id: BUILDING_B,
            name: "Building B",
            restricted_allowed: false,
            analysis_provenance: { decision_reason: "LEGACY_VIEW_ALLOW" },
          },
        ],
        authorized_physical_building_count: 1,
        authorization_version: 7,
      },
      {
        id: ORGANIZATION_A,
        name: "Organization A",
        authorized_buildings: [
          {
            id: BUILDING_A,
            name: "Building A",
            restricted_allowed: true,
            analysis_provenance: {
              permission_key: "reports_finance.analysis",
            },
          },
        ],
        authorized_physical_building_count: 1,
        authorization_version: 4,
      },
    ]);
  });

  it.each([
    [null, "organizations[0]"],
    [[], "organizations[0]"],
    ["organization", "organizations[0]"],
  ])(
    "rejects a non-object canonical organization row %p",
    async (row, field) => {
      mocks.rpc.mockResolvedValue({ data: [row], error: null });
      const options =
        useBusinessPerformanceOrganizations() as unknown as QueryOptions<
          unknown[]
        >;

      await expect(options.queryFn()).rejects.toMatchObject({ field });
    },
  );

  it.each([
    [{ organization_id: "not-a-uuid" }, "organization_id"],
    [{ organization_name: "" }, "organization_name"],
    [{ authorized_buildings: null }, "authorized_buildings"],
    [{ authorized_buildings: {} }, "authorized_buildings"],
  ])(
    "rejects malformed canonical organization field at %s",
    async (override, field) => {
      mocks.rpc.mockResolvedValue({
        data: [organizationRpcRow(override)],
        error: null,
      });
      const options =
        useBusinessPerformanceOrganizations() as unknown as QueryOptions<
          unknown[]
        >;

      await expect(options.queryFn()).rejects.toMatchObject({ field });
    },
  );

  it("rejects an organization with no authorized physical buildings", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        organizationRpcRow({
          authorized_buildings: [],
          authorized_physical_building_count: 0,
        }),
      ],
      error: null,
    });
    const options =
      useBusinessPerformanceOrganizations() as unknown as QueryOptions<
        unknown[]
      >;

    await expect(options.queryFn()).rejects.toMatchObject({
      field: "authorized_buildings",
    });
  });

  it.each([
    [null, "authorized_buildings[0]"],
    [[], "authorized_buildings[0]"],
    [{ id: "not-a-uuid" }, "authorized_buildings[0].id"],
    [
      {
        id: BUILDING_A,
        name: "",
        restricted_allowed: true,
        analysis_provenance: {},
      },
      "authorized_buildings[0].name",
    ],
    [
      {
        id: BUILDING_A,
        name: "Building A",
        restricted_allowed: "true",
        analysis_provenance: {},
      },
      "authorized_buildings[0].restricted_allowed",
    ],
    [
      {
        id: BUILDING_A,
        name: "Building A",
        restricted_allowed: true,
        analysis_provenance: null,
      },
      "authorized_buildings[0].analysis_provenance",
    ],
    [
      {
        id: BUILDING_A,
        name: "Building A",
        restricted_allowed: true,
        analysis_provenance: [],
      },
      "authorized_buildings[0].analysis_provenance",
    ],
  ])(
    "rejects malformed authorized building payload %p",
    async (building, field) => {
      mocks.rpc.mockResolvedValue({
        data: [
          organizationRpcRow({
            authorized_buildings: [building],
          }),
        ],
        error: null,
      });
      const options =
        useBusinessPerformanceOrganizations() as unknown as QueryOptions<
          unknown[]
        >;

      await expect(options.queryFn()).rejects.toMatchObject({ field });
    },
  );

  it.each([
    ["authorized_physical_building_count", -1],
    ["authorized_physical_building_count", 1.5],
    ["authorized_physical_building_count", Number.MAX_SAFE_INTEGER + 1],
    ["authorized_physical_building_count", "1"],
    ["authorization_version", -1],
    ["authorization_version", 1.5],
    ["authorization_version", Number.MAX_SAFE_INTEGER + 1],
    ["authorization_version", "7"],
  ])(
    "rejects invalid non-negative safe integer %s=%p",
    async (field, value) => {
      mocks.rpc.mockResolvedValue({
        data: [organizationRpcRow({ [field]: value })],
        error: null,
      });
      const options =
        useBusinessPerformanceOrganizations() as unknown as QueryOptions<
          unknown[]
        >;

      await expect(options.queryFn()).rejects.toMatchObject({ field });
    },
  );

  it("rejects a roster count mismatch", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        organizationRpcRow({ authorized_physical_building_count: 2 }),
      ],
      error: null,
    });
    const options =
      useBusinessPerformanceOrganizations() as unknown as QueryOptions<
        unknown[]
      >;

    await expect(options.queryFn()).rejects.toMatchObject({
      field: "authorized_physical_building_count",
    });
  });

  it("rejects duplicate organization IDs", async () => {
    mocks.rpc.mockResolvedValue({
      data: [organizationRpcRow(), organizationRpcRow()],
      error: null,
    });
    const options =
      useBusinessPerformanceOrganizations() as unknown as QueryOptions<
        unknown[]
      >;

    await expect(options.queryFn()).rejects.toMatchObject({
      field: "organization_id",
    });
  });

  it("rejects duplicate building IDs within one organization", async () => {
    const building = {
      id: BUILDING_A,
      name: "Building A",
      restricted_allowed: true,
      analysis_provenance: {},
    };
    mocks.rpc.mockResolvedValue({
      data: [
        organizationRpcRow({
          authorized_buildings: [building, building],
          authorized_physical_building_count: 2,
        }),
      ],
      error: null,
    });
    const options =
      useBusinessPerformanceOrganizations() as unknown as QueryOptions<
        unknown[]
      >;

    await expect(options.queryFn()).rejects.toMatchObject({
      field: "authorized_buildings[1].id",
    });
  });

  it("rejects a building ID repeated across organizations", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        organizationRpcRow(),
        organizationRpcRow({
          organization_id: ORGANIZATION_B,
          organization_name: "Organization B",
        }),
      ],
      error: null,
    });
    const options =
      useBusinessPerformanceOrganizations() as unknown as QueryOptions<
        unknown[]
      >;

    await expect(options.queryFn()).rejects.toMatchObject({
      field: "authorized_buildings[0].id",
    });
  });

  it("propagates canonical organization RPC failures unchanged", async () => {
    const rpcError = { code: "42501", message: "denied" };
    mocks.rpc.mockResolvedValue({ data: null, error: rpcError });
    const options =
      useBusinessPerformanceOrganizations() as unknown as QueryOptions<
        unknown[]
      >;

    await expect(options.queryFn()).rejects.toBe(rpcError);
  });

  it("propagates RPC failures and parses every live snapshot number strictly", async () => {
    const rpcError = { code: "42501", message: "denied" };
    mocks.rpc.mockResolvedValueOnce({ data: null, error: rpcError });
    const failed = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_B,
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;

    await expect(failed.queryFn()).rejects.toBe(rpcError);

    mocks.rpc.mockResolvedValueOnce({
      data: [
        {
          building_id: BUILDING_A,
          building_name: "A",
          total_rooms: 10,
          rooms_available: 2,
          rooms_occupied: 8,
          rooms_reserved: 0,
          rooms_maintenance: 0,
          rooms_unavailable: 0,
          vacancy_loss_month: "5000000",
          active_contracts: 8,
          avg_rent: 3000000,
          deposit_held: 10000000,
          receivable_total: 2000000,
          aging_not_due: 1000000,
          aging_1_30: 1000000,
          aging_31_60: 0,
          aging_61_90: 0,
          aging_over_90: Number.POSITIVE_INFINITY,
        },
      ],
      error: null,
    });
    const invalid = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;

    await expect(invalid.queryFn()).rejects.toMatchObject({
      field: "aging_over_90",
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "business_performance_snapshot_v1",
      {
        p_organization_id: ORGANIZATION_A,
        p_building_ids: [BUILDING_A],
      },
    );
  });

  it("rejects a live snapshot row outside the explicit requested building IDs", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          building_id: BUILDING_B,
          building_name: "B",
          total_rooms: 1,
          rooms_available: 1,
          rooms_occupied: 0,
          rooms_reserved: 0,
          rooms_maintenance: 0,
          rooms_unavailable: 0,
          vacancy_loss_month: 1,
          active_contracts: 0,
          avg_rent: 0,
          deposit_held: 0,
          receivable_total: 0,
          aging_not_due: 0,
          aging_1_30: 0,
          aging_31_60: 0,
          aging_61_90: 0,
          aging_over_90: 0,
        },
      ],
      error: null,
    });
    const options = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).rejects.toMatchObject({
      field: "building_id",
    });
  });

  it("rejects duplicate snapshot rows for one requested building", async () => {
    mocks.rpc.mockResolvedValue({
      data: [snapshotRpcRow(), snapshotRpcRow()],
      error: null,
    });
    const options = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).rejects.toMatchObject({
      field: "building_id",
    });
  });

  it.each(
    [
      "total_rooms",
      "rooms_available",
      "rooms_occupied",
      "rooms_reserved",
      "rooms_maintenance",
      "rooms_unavailable",
      "active_contracts",
    ].flatMap((field) =>
      [-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((value) => [
        field,
        value,
      ] as const),
    ),
  )(
    "rejects invalid snapshot count %s=%p",
    async (field, value) => {
      mocks.rpc.mockResolvedValue({
        data: [snapshotRpcRow({ [field]: value })],
        error: null,
      });
      const options = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
        BUILDING_A,
      ]) as unknown as QueryOptions<unknown[]>;

      await expect(options.queryFn()).rejects.toMatchObject({ field });
    },
  );

  it.each([
    "vacancy_loss_month",
    "avg_rent",
    "deposit_held",
    "receivable_total",
    "aging_not_due",
    "aging_1_30",
    "aging_31_60",
    "aging_61_90",
    "aging_over_90",
  ])("rejects negative snapshot amount %s", async (field) => {
    mocks.rpc.mockResolvedValue({
      data: [snapshotRpcRow({ [field]: -0.01 })],
      error: null,
    });
    const options = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).rejects.toMatchObject({ field });
  });

  it("rejects a receivable total that differs from its aging buckets by one cent", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        snapshotRpcRow({
          receivable_total: 1,
          aging_not_due: 0.99,
        }),
      ],
      error: null,
    });
    const options = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).rejects.toMatchObject({
      field: "receivable_total",
    });
  });

  it("accepts floating-point noise when aging buckets equal receivable total", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        snapshotRpcRow({
          receivable_total: 0.3,
          aging_not_due: 0.1,
          aging_1_30: 0.2,
        }),
      ],
      error: null,
    });
    const options = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).resolves.toMatchObject([
      {
        receivable_total: 0.3,
        aging_not_due: 0.1,
        aging_1_30: 0.2,
      },
    ]);
  });

  it("rejects an impossible snapshot room partition", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        snapshotRpcRow({
          total_rooms: 1,
          rooms_available: 0,
          rooms_occupied: 2,
        }),
      ],
      error: null,
    });
    const options = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_A,
    ]) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).rejects.toMatchObject({
      field: "room_counts",
    });
  });

  it("fails closed when the canonical snapshot RPC omits a requested building", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          building_id: BUILDING_A,
          building_name: "A",
          total_rooms: 1,
          rooms_available: 1,
          rooms_occupied: 0,
          rooms_reserved: 0,
          rooms_maintenance: 0,
          rooms_unavailable: 0,
          vacancy_loss_month: 1,
          active_contracts: 0,
          avg_rent: 0,
          deposit_held: 0,
          receivable_total: 0,
          aging_not_due: 0,
          aging_1_30: 0,
          aging_31_60: 0,
          aging_61_90: 0,
          aging_over_90: 0,
        },
      ],
      error: null,
    });
    const options = useBusinessPerformanceSnapshot(ORGANIZATION_A, [
      BUILDING_A,
      BUILDING_B,
    ]) as unknown as QueryOptions<unknown[]>;

    await expect(options.queryFn()).rejects.toMatchObject({
      field: "building_id",
    });
  });

  it("uses org-bound occupancy snapshot and upcoming-vacancy RPCs with stable keys", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T03:00:00.000Z"));
    try {
      const {
        useBusinessPerformanceOccupancySnapshot,
        useBusinessPerformanceUpcomingVacancy,
      } = getOccupancyHooks();
      mocks.rpc
        .mockResolvedValueOnce({
          data: [
            occupancySnapshotRpcRow(),
            occupancySnapshotRpcRow({
              building_id: BUILDING_B,
              building_name: "Building B",
            }),
          ],
          error: null,
        })
        .mockResolvedValueOnce({
          data: [upcomingVacancyRpcRow()],
          error: null,
        });

      const snapshot = useBusinessPerformanceOccupancySnapshot(
        ` ${ORGANIZATION_A.toUpperCase()} `,
        "2026-07-25",
        [BUILDING_B, ` ${BUILDING_A} `, BUILDING_B],
      ) as unknown as QueryOptions<unknown[]>;
      const upcoming = useBusinessPerformanceUpcomingVacancy(
        ORGANIZATION_A,
        "2026-07-25",
        60,
        [BUILDING_A],
      ) as unknown as QueryOptions<unknown[]>;

      await expect(snapshot.queryFn()).resolves.toHaveLength(2);
      await expect(upcoming.queryFn()).resolves.toEqual([
        expect.objectContaining({
          building_id: BUILDING_A,
          days_remaining: 30,
        }),
      ]);

      expect(snapshot).toMatchObject({
        enabled: true,
        staleTime: 60_000,
        refetchInterval: 60_000,
        refetchOnWindowFocus: "always",
      });
      expect(snapshot.queryKey).toEqual([
        "business-performance",
        USER_A,
        "occupancy-snapshot",
        ORGANIZATION_A,
        "2026-07-25",
        [BUILDING_A, BUILDING_B],
      ]);
      expect(upcoming.queryKey).toEqual([
        "business-performance",
        USER_A,
        "upcoming-vacancy",
        ORGANIZATION_A,
        "2026-07-25",
        60,
        [BUILDING_A],
      ]);
      expect(mocks.rpc).toHaveBeenNthCalledWith(
        1,
        "business_performance_occupancy_snapshot_v1",
        {
          p_organization_id: ORGANIZATION_A,
          p_as_of_date: "2026-07-25",
          p_building_ids: [BUILDING_A, BUILDING_B],
        },
      );
      expect(mocks.rpc).toHaveBeenNthCalledWith(
        2,
        "business_performance_upcoming_vacancy_v1",
        {
          p_organization_id: ORGANIZATION_A,
          p_as_of_date: "2026-07-25",
          p_window_days: 60,
          p_building_ids: [BUILDING_A],
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates occupancy caches by principal, organization, and canonical building scope", () => {
    const { useBusinessPerformanceOccupancySnapshot } = getOccupancyHooks();
    const userAOrgA = useBusinessPerformanceOccupancySnapshot(
      ORGANIZATION_A,
      "2026-07-25",
      [BUILDING_B, BUILDING_A],
    ) as unknown as QueryOptions<unknown[]>;
    const userAOrgB = useBusinessPerformanceOccupancySnapshot(
      ORGANIZATION_B,
      "2026-07-25",
      [BUILDING_A, BUILDING_B],
    ) as unknown as QueryOptions<unknown[]>;

    mocks.authUser = { id: USER_B };
    const userBOrgA = useBusinessPerformanceOccupancySnapshot(
      ORGANIZATION_A,
      "2026-07-25",
      [BUILDING_A, BUILDING_B],
    ) as unknown as QueryOptions<unknown[]>;

    expect(userAOrgA.queryKey.at(-1)).toEqual([BUILDING_A, BUILDING_B]);
    expect(userAOrgA.queryKey).not.toEqual(userAOrgB.queryKey);
    expect(userAOrgA.queryKey).not.toEqual(userBOrgA.queryKey);
  });

  it("rejects invalid occupancy scopes before any RPC can run", async () => {
    const {
      useBusinessPerformanceOccupancySnapshot,
      useBusinessPerformanceUpcomingVacancy,
      useBusinessPerformanceOccupancyTrend12m,
    } = getOccupancyHooks();
    const invalidQueries = [
      useBusinessPerformanceOccupancySnapshot(" ", "2026-07-25", [BUILDING_A]),
      useBusinessPerformanceOccupancySnapshot(
        ORGANIZATION_A,
        "2026-02-30",
        [BUILDING_A],
      ),
      useBusinessPerformanceUpcomingVacancy(
        ORGANIZATION_A,
        "2026-07-25",
        0,
        [BUILDING_A],
      ),
      useBusinessPerformanceUpcomingVacancy(
        ORGANIZATION_A,
        "2026-07-25",
        60,
        [],
      ),
      useBusinessPerformanceOccupancyTrend12m(ORGANIZATION_A, []),
    ] as unknown as QueryOptions<unknown[]>[];

    for (const query of invalidQueries) {
      expect(query.enabled).toBe(false);
      await expect(query.queryFn()).rejects.toBeInstanceOf(
        BusinessPerformanceDataError,
      );
    }

    mocks.authUser = null;
    const unauthenticated = useBusinessPerformanceOccupancySnapshot(
      ORGANIZATION_A,
      "2026-07-25",
      [BUILDING_A],
    ) as unknown as QueryOptions<unknown[]>;
    expect(unauthenticated.enabled).toBe(false);
    await expect(unauthenticated.queryFn()).rejects.toMatchObject({
      field: "userId",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fails closed on outside-scope or malformed occupancy snapshot rows", async () => {
    const { useBusinessPerformanceOccupancySnapshot } = getOccupancyHooks();
    const options = useBusinessPerformanceOccupancySnapshot(
      ORGANIZATION_A,
      "2026-07-25",
      [BUILDING_A],
    ) as unknown as QueryOptions<unknown[]>;

    mocks.rpc.mockResolvedValueOnce({
      data: [occupancySnapshotRpcRow({ building_id: BUILDING_B })],
      error: null,
    });
    await expect(options.queryFn()).rejects.toMatchObject({
      field: "building_id",
    });

    mocks.rpc.mockResolvedValueOnce({
      data: [occupancySnapshotRpcRow({ occupancy_pct: 40 })],
      error: null,
    });
    await expect(options.queryFn()).rejects.toMatchObject({
      field: "occupancy_pct",
    });

    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(options.queryFn()).rejects.toMatchObject({
      field: "building_id",
    });
  });

  it("fails closed on outside-scope or malformed upcoming-vacancy rows", async () => {
    const { useBusinessPerformanceUpcomingVacancy } = getOccupancyHooks();
    const options = useBusinessPerformanceUpcomingVacancy(
      ORGANIZATION_A,
      "2026-07-25",
      60,
      [BUILDING_A],
    ) as unknown as QueryOptions<unknown[]>;

    mocks.rpc.mockResolvedValueOnce({
      data: [upcomingVacancyRpcRow({ building_id: BUILDING_B })],
      error: null,
    });
    await expect(options.queryFn()).rejects.toMatchObject({
      field: "building_id",
    });

    mocks.rpc.mockResolvedValueOnce({
      data: [upcomingVacancyRpcRow({ days_remaining: 31 })],
      error: null,
    });
    await expect(options.queryFn()).rejects.toMatchObject({
      field: "days_remaining",
    });
  });

  it.each([
    [
      {
        room_id: "66666666-6666-4666-8666-666666666666",
        room_name: "102",
      },
      "contract_id",
    ],
    [
      {
        contract_id: "77777777-7777-4777-8777-777777777777",
        contract_number: "HD-002",
      },
      "room_id",
    ],
  ])(
    "rejects duplicate upcoming-vacancy identity at %s",
    async (secondRowOverrides, field) => {
      const { useBusinessPerformanceUpcomingVacancy } = getOccupancyHooks();
      mocks.rpc.mockResolvedValue({
        data: [
          upcomingVacancyRpcRow(),
          upcomingVacancyRpcRow(secondRowOverrides),
        ],
        error: null,
      });
      const options = useBusinessPerformanceUpcomingVacancy(
        ORGANIZATION_A,
        "2026-07-25",
        60,
        [BUILDING_A],
      ) as unknown as QueryOptions<unknown[]>;

      await expect(options.queryFn()).rejects.toMatchObject({ field });
    },
  );

  it("batches occupancy trend RPCs at 50 buildings and aggregates all rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T03:00:00.000Z"));
    try {
      const { useBusinessPerformanceOccupancyTrend12m } = getOccupancyHooks();
      const buildingIds = Array.from({ length: 85 }, (_, index) =>
        buildingUuid(index + 1),
      );
      mocks.rpc.mockImplementation(
        async (
          _functionName: string,
          params: { p_building_ids: string[] },
        ) => ({
          data: occupancyMonthlyRpcMatrix(params.p_building_ids),
          error: null,
        }),
      );

      const options = useBusinessPerformanceOccupancyTrend12m(
        ORGANIZATION_A,
        [...buildingIds].reverse(),
      ) as unknown as QueryOptions<unknown[]>;
      const rows = await options.queryFn();

      expect(options.queryKey).toEqual([
        "business-performance",
        USER_A,
        "occupancy-trend-12m",
        ORGANIZATION_A,
        "2025-08-01",
        "2026-07-01",
        buildingIds,
      ]);
      expect(options).toMatchObject({
        staleTime: 300_000,
        refetchInterval: 300_000,
        refetchOnWindowFocus: "always",
      });
      expect(mocks.rpc).toHaveBeenCalledTimes(2);
      expect(
        mocks.rpc.mock.calls.map((call) => {
            const [functionName, params] = call as [
              string,
              { p_building_ids: string[]; p_start_date: string; p_end_date: string },
            ];
            expect(functionName).toBe(
              "business_performance_occupancy_monthly_v1",
            );
            expect(params).toMatchObject({
              p_organization_id: ORGANIZATION_A,
              p_start_date: "2025-08-01",
              p_end_date: "2026-07-01",
            });
            return params.p_building_ids.length;
        }),
      ).toEqual([50, 35]);
      expect(rows).toHaveLength(12);
      expect(rows[0]).toEqual({
        month: "8/2025",
        occupied: 170,
        total: 340,
        rate: 50,
      });
      expect(rows[11]).toEqual({
        month: "7/2026",
        occupied: 170,
        total: 340,
        rate: 50,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      "missing",
      () => occupancyMonthlyRpcMatrix([BUILDING_A]).slice(0, -1),
    ],
    [
      "duplicate",
      () => {
        const rows = occupancyMonthlyRpcMatrix([BUILDING_A]);
        return [...rows, rows[0]];
      },
    ],
    [
      "out-of-range",
      () => [
        ...occupancyMonthlyRpcMatrix([BUILDING_A]).slice(0, -1),
        occupancyMonthlyRpcRow(BUILDING_A, { month: "2025-07-01" }),
      ],
    ],
  ])(
    "rejects the invalid %s occupancy trend matrix case",
    async (_case, buildRows) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-25T03:00:00.000Z"));
      try {
        const { useBusinessPerformanceOccupancyTrend12m } =
          getOccupancyHooks();
        mocks.rpc.mockResolvedValue({ data: buildRows(), error: null });
        const options = useBusinessPerformanceOccupancyTrend12m(
          ORGANIZATION_A,
          [BUILDING_A],
        ) as unknown as QueryOptions<unknown[]>;

        await expect(options.queryFn()).rejects.toMatchObject({
          field: "month",
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("rejects occupancy trend rows outside a batch and preserves null zero-denominator rates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T03:00:00.000Z"));
    try {
      const { useBusinessPerformanceOccupancyTrend12m } = getOccupancyHooks();
      const buildingIds = Array.from({ length: 51 }, (_, index) =>
        buildingUuid(index + 1),
      );
      const outsideBatch = useBusinessPerformanceOccupancyTrend12m(
        ORGANIZATION_A,
        buildingIds,
      ) as unknown as QueryOptions<unknown[]>;
      mocks.rpc
        .mockResolvedValueOnce({
          data: [occupancyMonthlyRpcRow(buildingIds[50])],
          error: null,
        })
        .mockResolvedValueOnce({ data: [], error: null });
      await expect(outsideBatch.queryFn()).rejects.toMatchObject({
        field: "building_id",
      });

      mocks.rpc.mockReset();
      mocks.rpc.mockResolvedValue({
        data: occupancyMonthlyRpcMatrix([BUILDING_A], {
          total_rooms: 0,
          occupied_rooms: 0,
          occupancy_pct: 0,
        }),
        error: null,
      });
      const zeroDenominator = useBusinessPerformanceOccupancyTrend12m(
        ORGANIZATION_A,
        [BUILDING_A],
      ) as unknown as QueryOptions<Array<{ rate: number | null }>>;
      const zeroRows = await zeroDenominator.queryFn();
      expect(zeroRows).toHaveLength(12);
      expect(zeroRows.every((row) => row.rate === null)).toBe(true);

      mocks.rpc.mockResolvedValue({
        data: [
          occupancyMonthlyRpcRow(BUILDING_A, {
            total_rooms: 1,
            occupied_rooms: 2,
            occupancy_pct: 100,
          }),
        ],
        error: null,
      });
      await expect(zeroDenominator.queryFn()).rejects.toMatchObject({
        field: "occupied_rooms",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates occupancy authorization RPC failures unchanged", async () => {
    const {
      useBusinessPerformanceOccupancySnapshot,
      useBusinessPerformanceUpcomingVacancy,
      useBusinessPerformanceOccupancyTrend12m,
    } = getOccupancyHooks();
    const authError = { code: "42501", message: "denied" };
    mocks.rpc.mockResolvedValue({ data: null, error: authError });
    const queries = [
      useBusinessPerformanceOccupancySnapshot(
        ORGANIZATION_A,
        "2026-07-25",
        [BUILDING_A],
      ),
      useBusinessPerformanceUpcomingVacancy(
        ORGANIZATION_A,
        "2026-07-25",
        60,
        [BUILDING_A],
      ),
      useBusinessPerformanceOccupancyTrend12m(ORGANIZATION_A, [BUILDING_A]),
    ] as unknown as QueryOptions<unknown[]>[];

    for (const query of queries) {
      await expect(query.queryFn()).rejects.toBe(authError);
    }
  });
});
