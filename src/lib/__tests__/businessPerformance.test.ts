import { describe, expect, it } from "vitest";
import {
  BUSINESS_PERFORMANCE_TABS,
  RESTRICTED_FINANCE_TAB_IDS,
  BusinessPerformanceDataError,
  aggregatePnlByMonth,
  aggregateSnapshot,
  allowedBusinessPerformanceTabs,
  buildBusinessPerformanceFilters,
  buildPnlComparisons,
  canViewRestrictedBusinessPerformance,
  parseFiniteNumber,
  resolveAuthorizedBuildingIds,
  resolveBusinessPerformanceTab,
  type BusinessPerformanceOrganization,
  type BusinessPerformancePnlRow,
  type BusinessPerformanceSnapshotRow,
} from "@/lib/businessPerformance";

const ORGANIZATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUILDING_A = "11111111-1111-4111-8111-111111111111";
const BUILDING_B = "22222222-2222-4222-8222-222222222222";
const BUILDING_C = "33333333-3333-4333-8333-333333333333";

describe("business performance tab registry", () => {
  it("registers exactly the seven approved leaf tabs", () => {
    expect(BUSINESS_PERFORMANCE_TABS).toEqual([
      { id: "business-overview", label: "Tổng quan kinh doanh" },
      { id: "building-performance", label: "Hiệu quả tòa nhà" },
      { id: "occupancy-vacancy", label: "Lấp đầy & Phòng trống" },
      { id: "collections-debt", label: "Thu tiền & Công nợ" },
      { id: "revenue-cost-structure", label: "Cơ cấu Thu & Chi" },
      { id: "trends-comparison", label: "Xu hướng & So sánh" },
      { id: "data-definitions", label: "Dữ liệu & Định nghĩa" },
    ]);
  });

  it("keeps known tabs and falls back unknown values to the overview", () => {
    expect(resolveBusinessPerformanceTab("building-performance", true)).toBe(
      "building-performance",
    );
    expect(resolveBusinessPerformanceTab("unknown-tab", true)).toBe("business-overview");
    expect(resolveBusinessPerformanceTab(null, true)).toBe("business-overview");
  });

  it("exposes only safe tabs and falls back restricted direct links to occupancy", () => {
    expect(RESTRICTED_FINANCE_TAB_IDS).toEqual([
      "business-overview",
      "building-performance",
      "collections-debt",
      "revenue-cost-structure",
      "trends-comparison",
    ]);
    expect(allowedBusinessPerformanceTabs(false).map((tab) => tab.id)).toEqual([
      "occupancy-vacancy",
      "data-definitions",
    ]);
    expect(allowedBusinessPerformanceTabs(true)).toEqual(BUSINESS_PERFORMANCE_TABS);
    expect(resolveBusinessPerformanceTab("collections-debt", false)).toBe(
      "occupancy-vacancy",
    );
    expect(resolveBusinessPerformanceTab("data-definitions", false)).toBe(
      "data-definitions",
    );
    expect(resolveBusinessPerformanceTab("unknown-tab", false)).toBe(
      "occupancy-vacancy",
    );
  });
});

describe("authoritative organization roster selection", () => {
  const organization: BusinessPerformanceOrganization = {
    id: ORGANIZATION_A,
    name: "Organization A",
    authorized_buildings: [
      {
        id: BUILDING_C,
        name: "Building C",
        restricted_allowed: true,
        analysis_provenance: { permission_key: "reports_finance.analysis" },
      },
      {
        id: BUILDING_A,
        name: "Building A",
        restricted_allowed: true,
        analysis_provenance: { permission_key: "reports_finance.analysis" },
      },
      {
        id: BUILDING_B,
        name: "Building B",
        restricted_allowed: false,
        analysis_provenance: { permission_key: "reports_finance.analysis" },
      },
    ],
    authorized_physical_building_count: 3,
    authorization_version: 7,
  };

  it("resolves an empty UI selection to every building in the authoritative roster", () => {
    expect(resolveAuthorizedBuildingIds(organization, [])).toEqual([
      BUILDING_A,
      BUILDING_B,
      BUILDING_C,
    ]);
    expect(resolveAuthorizedBuildingIds(organization, undefined)).toEqual([
      BUILDING_A,
      BUILDING_B,
      BUILDING_C,
    ]);
  });

  it("intersects explicit IDs with the selected organization roster", () => {
    expect(
      resolveAuthorizedBuildingIds(organization, [
        BUILDING_C,
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
        BUILDING_A.toUpperCase(),
        BUILDING_C,
      ]),
    ).toEqual([BUILDING_A, BUILDING_C]);
  });

  it("fails closed for an unknown organization or unknown building selection", () => {
    expect(resolveAuthorizedBuildingIds(null, [])).toEqual([]);
    expect(
      resolveAuthorizedBuildingIds(organization, [
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
      ]),
    ).toEqual([]);
  });

  it("allows restricted analytics only for a non-empty all-allowed resolved scope", () => {
    expect(canViewRestrictedBusinessPerformance(organization, [BUILDING_A])).toBe(
      true,
    );
    expect(
      canViewRestrictedBusinessPerformance(organization, [BUILDING_A, BUILDING_C]),
    ).toBe(true);
    expect(canViewRestrictedBusinessPerformance(organization, [])).toBe(false);
    expect(canViewRestrictedBusinessPerformance(organization, [BUILDING_B])).toBe(
      false,
    );
    expect(
      canViewRestrictedBusinessPerformance(organization, [
        BUILDING_A,
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
      ]),
    ).toBe(false);
    expect(
      canViewRestrictedBusinessPerformance(organization, [
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
      ]),
    ).toBe(false);
    expect(canViewRestrictedBusinessPerformance(undefined, [BUILDING_A])).toBe(
      false,
    );
  });
});

describe("strict finite-number parsing", () => {
  it("accepts finite numbers, numeric strings, and zero", () => {
    expect(parseFiniteNumber(0, "amount")).toBe(0);
    expect(parseFiniteNumber(-12.5, "amount")).toBe(-12.5);
    expect(parseFiniteNumber(" 42.75 ", "amount")).toBe(42.75);
  });

  it.each([
    null,
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    false,
    [],
    {},
    "",
    "   ",
    "12x",
    "Infinity",
    "-Infinity",
  ])(
    "rejects invalid numeric payload %p with a typed error",
    (value) => {
      expect(() => parseFiniteNumber(value, "revenue")).toThrow(BusinessPerformanceDataError);
      try {
        parseFiniteNumber(value, "revenue");
      } catch (error) {
        expect(error).toMatchObject({ field: "revenue" });
      }
    },
  );
});

describe("canonical filters", () => {
  it("derives leap-safe month boundaries, comparison periods, and sorted explicit IDs", () => {
    expect(
      buildBusinessPerformanceFilters(
        "2024-02",
        [` ${BUILDING_C} `, BUILDING_A, BUILDING_C],
        "ACCRUAL",
        ` ${ORGANIZATION_A} `,
      ),
    ).toEqual({
      month: "2024-02",
      periodStart: "2024-02-01",
      periodEnd: "2024-02-29",
      prevMonth: "2024-01",
      yoyMonth: "2023-02",
      t13Start: "2023-02-01",
      t13End: "2024-02-29",
      months12: [
        "2023-03",
        "2023-04",
        "2023-05",
        "2023-06",
        "2023-07",
        "2023-08",
        "2023-09",
        "2023-10",
        "2023-11",
        "2023-12",
        "2024-01",
        "2024-02",
      ],
      buildingIds: [BUILDING_A, BUILDING_C],
      basis: "ACCRUAL",
      organizationId: ORGANIZATION_A,
    });
  });

  it.each(["2024-2", "24-02", "2024-00", "2024-13", "not-a-month"])(
    "rejects a non-canonical month %s",
    (month) => {
      expect(() =>
        buildBusinessPerformanceFilters(
          month,
          [BUILDING_A],
          "VOUCHER_DATE",
          ORGANIZATION_A,
        ),
      )
        .toThrow(BusinessPerformanceDataError);
    },
  );

  it("rejects an invalid runtime basis", () => {
    expect(() =>
      buildBusinessPerformanceFilters(
        "2024-02",
        [BUILDING_A],
        "CASH" as never,
        ORGANIZATION_A,
      ),
    ).toThrow(BusinessPerformanceDataError);
  });
});

describe("P&L aggregation and comparisons", () => {
  const row = (
    month: string,
    buildingId: string,
    revenue: number,
    expense: number,
  ): BusinessPerformancePnlRow => ({
    month: `${month}-01`,
    building_id: buildingId,
    building_name: buildingId,
    is_virtual: false,
    revenue,
    expense,
    net: revenue - expense,
  });

  it("aggregates all buildings by month without inventing missing months", () => {
    const result = aggregatePnlByMonth([
      row("2024-01", "A", 100, 40),
      row("2024-01", "B", 50, 20),
      row("2024-02", "A", 200, 80),
    ]);

    expect(result.get("2024-01")).toEqual({
      month: "2024-01",
      revenue: 150,
      expense: 60,
      net: 90,
      marginPct: 60,
      expenseRatioPct: 40,
    });
    expect(result.has("2023-12")).toBe(false);
  });

  it("scaffolds explicitly requested missing months as zero activity", () => {
    const result = aggregatePnlByMonth(
      [row("2024-02", "A", 200, 80)],
      ["2024-01", "2024-02", "2024-03"],
    );

    expect(result.get("2024-01")).toEqual({
      month: "2024-01",
      revenue: 0,
      expense: 0,
      net: 0,
      marginPct: null,
      expenseRatioPct: null,
    });
    expect(result.get("2024-03")).toEqual({
      month: "2024-03",
      revenue: 0,
      expense: 0,
      net: 0,
      marginPct: null,
      expenseRatioPct: null,
    });
  });

  it("builds zero-valued comparison periods when a successful query has no activity", () => {
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );

    const comparison = buildPnlComparisons([], filters);

    expect(comparison.current).toEqual({
      month: "2024-02",
      revenue: 0,
      expense: 0,
      net: 0,
      marginPct: null,
      expenseRatioPct: null,
    });
    expect(comparison.previous?.revenue).toBe(0);
    expect(comparison.yearAgo?.revenue).toBe(0);
    expect(comparison.revenue).toEqual({
      current: 0,
      previous: 0,
      yearAgo: 0,
      momPct: null,
      yoyPct: null,
    });
  });

  it("builds MoM and YoY comparisons and preserves null when a base is missing or zero", () => {
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_A],
      "ACCRUAL",
      ORGANIZATION_A,
    );
    const comparison = buildPnlComparisons(
      [
        row("2023-02", "A", 100, 70),
        row("2024-01", "A", 0, 20),
        row("2024-02", "A", 150, 60),
      ],
      filters,
    );

    expect(comparison.current?.net).toBe(90);
    expect(comparison.previous?.net).toBe(-20);
    expect(comparison.yearAgo?.net).toBe(30);
    expect(comparison.revenue.momPct).toBeNull();
    expect(comparison.revenue.yoyPct).toBe(50);
    expect(comparison.expense.momPct).toBe(200);
    expect(comparison.net.yoyPct).toBe(200);
  });
});

describe("live snapshot aggregation", () => {
  const snapshot = (
    overrides: Partial<BusinessPerformanceSnapshotRow>,
  ): BusinessPerformanceSnapshotRow => ({
    building_id: "building-a",
    building_name: "A",
    total_rooms: 10,
    rooms_available: 2,
    rooms_occupied: 8,
    rooms_reserved: 0,
    rooms_maintenance: 0,
    rooms_unavailable: 0,
    vacancy_loss_month: 5_000_000,
    active_contracts: 8,
    avg_rent: 3_000_000,
    deposit_held: 10_000_000,
    receivable_total: 2_000_000,
    aging_not_due: 1_000_000,
    aging_1_30: 1_000_000,
    aging_31_60: 0,
    aging_61_90: 0,
    aging_over_90: 0,
    ...overrides,
  });

  it("sums live values and weights average rent by active contracts", () => {
    expect(
      aggregateSnapshot([
        snapshot({ avg_rent: 3_000_000, active_contracts: 8 }),
        snapshot({
          building_id: "building-b",
          total_rooms: 10,
          rooms_available: 8,
          rooms_occupied: 2,
          active_contracts: 2,
          avg_rent: 5_000_000,
        }),
      ]),
    ).toMatchObject({
      total_rooms: 20,
      rooms_occupied: 10,
      occupancy_pct: 50,
      active_contracts: 10,
      avg_rent: 3_400_000,
      receivable_total: 4_000_000,
    });
  });

  it("returns null for no rows instead of rendering a synthetic zero snapshot", () => {
    expect(aggregateSnapshot([])).toBeNull();
  });
});
