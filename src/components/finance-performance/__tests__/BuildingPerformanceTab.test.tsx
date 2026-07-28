// @vitest-environment node

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BusinessPerformanceFilters,
  BusinessPerformancePnlRow,
} from "@/lib/businessPerformance";
import type {
  BusinessPerformanceBreakEvenRow,
  BusinessPerformanceReportingRoleRow,
} from "@/hooks/reports/useBusinessPerformanceGatedData";
import * as BuildingPerformanceModule from "../BuildingPerformanceTab";

const { BuildingPerformanceTab } = BuildingPerformanceModule;

type HorizontalScrollKeyDown = (event: {
  key: string;
  currentTarget: Pick<HTMLDivElement, "clientWidth" | "scrollLeft">;
  preventDefault: () => void;
}) => void;

const hookState = vi.hoisted(() => ({
  rows: [] as BusinessPerformancePnlRow[] | undefined,
  error: null as unknown,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  roles: [] as BusinessPerformanceReportingRoleRow[],
  breakEven: [] as BusinessPerformanceBreakEvenRow[],
  gatedRefetch: vi.fn(),
  mutateAsync: vi.fn(),
}));

const BUILDING_A_ID = "11111111-1111-4111-8111-111111111111";
const BUILDING_B_ID = "22222222-2222-4222-8222-222222222222";
const STALE_BUILDING_ID = "33333333-3333-4333-8333-333333333333";
const ORGANIZATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const authorizedBuildings = [
  { id: BUILDING_A_ID, name: "Tòa A" },
] as const;

vi.mock("@/hooks/reports/useBusinessPerformance", () => ({
  useBusinessPerformancePnl: () => ({
    data: hookState.rows,
    error: hookState.error,
    isLoading: hookState.isLoading,
    isError: hookState.isError,
    refetch: hookState.refetch,
  }),
  useBusinessPerformanceReportingRoles: () => ({
    data: hookState.roles,
    error: null,
    isLoading: false,
    isError: false,
    refetch: hookState.gatedRefetch,
  }),
  useBusinessPerformanceBreakEven: () => ({
    data: hookState.breakEven,
    error: null,
    isLoading: false,
    isError: false,
    refetch: hookState.gatedRefetch,
  }),
  useSetBusinessPerformanceReportingRole: () => ({
    mutateAsync: hookState.mutateAsync,
    isPending: false,
  }),
}));

const filters: BusinessPerformanceFilters = {
  month: "2026-02",
  periodStart: "2026-02-01",
  periodEnd: "2026-02-28",
  prevMonth: "2026-01",
  yoyMonth: "2025-02",
  t13Start: "2025-02-01",
  t13End: "2026-02-28",
  months12: [],
  buildingIds: [BUILDING_A_ID],
  basis: "ACCRUAL",
  organizationId: ORGANIZATION_ID,
};

function pnlRow(
  month: string,
  revenue: number,
  expense: number,
  buildingId = BUILDING_A_ID,
  buildingName = "Tòa A",
): BusinessPerformancePnlRow {
  return {
    month: `${month}-01`,
    building_id: buildingId,
    building_name: buildingName,
    is_virtual: false,
    revenue,
    expense,
    net: revenue - expense,
  };
}

function breakEvenRow(
  overrides: Partial<BusinessPerformanceBreakEvenRow> = {},
): BusinessPerformanceBreakEvenRow {
  return {
    building_id: BUILDING_A_ID,
    building_name: "Tòa A",
    analysis_window: "SELECTED_MONTH",
    window_start: "2026-02-01",
    window_end: "2026-02-01",
    source_month_count: 1,
    valid_month_count: 1,
    revenue: 12_000_000,
    expense: 5_000_000,
    net: 7_000_000,
    gap_to_zero: -7_000_000,
    r_room: 10_000_000,
    r_other: 2_000_000,
    r_pass: 0,
    f_landlord: 4_000_000,
    f_other: 1_000_000,
    v_room: 1_000_000,
    v_other: 0,
    e_pass: 0,
    mapping_coverage_pct: 100,
    unmapped_amount: 0,
    outside_model_amount: 0,
    missing_landlord_months: [],
    cmr_core: 0.9167,
    cmr_room: 0.9,
    r_core_be: 5_454_545,
    r_total_be: 5_454_545,
    r_room_be: 3_333_333,
    break_even_revenue_available: true,
    break_even_revenue_reason: null,
    room_break_even_revenue_available: true,
    room_break_even_revenue_reason: null,
    capacity_current: 5_000_000,
    capacity_blocked: 1_000_000,
    capacity_theory: 6_000_000,
    invalid_rent_room_count: 0,
    break_even_occupancy_current: 66.67,
    break_even_occupancy_theory: 55.56,
    room_revenue_utilization_pct: 200,
    break_even_occupancy_available: true,
    break_even_occupancy_reason: null,
    capacity_source: "LIVE",
    capacity_as_of: "2026-02-20T00:00:00.000Z",
    generated_at: "2026-02-20T00:00:00.000Z",
    ...overrides,
  };
}

function roleRow(
  overrides: Partial<BusinessPerformanceReportingRoleRow> = {},
): BusinessPerformanceReportingRoleRow {
  return {
    income_expense_type_id: "44444444-4444-4444-8444-444444444444",
    type_name: "Tiền nhà",
    side: "EXPENSE",
    category: "Chi phí cố định",
    finance_reporting_role: "LANDLORD_RENT_FIXED",
    effective_from: "2026-01-01",
    effective_to: null,
    confirmed_at: "2026-01-01T00:00:00.000Z",
    confirmed_by: "55555555-5555-4555-8555-555555555555",
    suggested_role: "LANDLORD_RENT_FIXED",
    can_manage: true,
    ...overrides,
  };
}

beforeEach(() => {
  hookState.rows = [
    pnlRow("2026-02", 12_000_000, 5_000_000),
    pnlRow("2026-01", 10_000_000, 4_000_000),
    pnlRow("2025-02", 9_000_000, 3_000_000),
  ];
  hookState.error = null;
  hookState.isLoading = false;
  hookState.isError = false;
  hookState.refetch.mockReset();
  hookState.gatedRefetch.mockReset();
  hookState.mutateAsync.mockReset();
  hookState.roles = [roleRow()];
  hookState.breakEven = [
    breakEvenRow(),
    breakEvenRow({ analysis_window: "THREE_MONTH_AVERAGE" }),
  ];
});

describe("BuildingPerformanceTab responsive layout", () => {
  it("keeps monetary metrics in one column at 320px and uses gap-based stacks", () => {
    const source = readFileSync(
      new URL("../BuildingPerformanceTab.tsx", import.meta.url),
      "utf8",
    );
    const metricGridClasses = source
      .match(/<dl className="([^"]+)"/)?.[1]
      .split(/\s+/);

    expect(source).not.toMatch(/\bspace-[xy]-/);
    expect(metricGridClasses).not.toContain("grid-cols-2");
    expect(metricGridClasses).toContain("sm:grid-cols-2");
  });
});

describe("BuildingPerformanceTab table semantics", () => {
  it("renders confirmed mapping controls and factual break-even values", () => {
    const html = renderToStaticMarkup(
      <BuildingPerformanceTab
        filters={filters}
        buildings={authorizedBuildings}
      />,
    );

    expect(html).toContain("Cấu hình vai trò tài chính");
    expect(html).toContain("Tiền nhà");
    expect(html).toContain("Chi phí thuê chủ nhà cố định");
    expect(html).toContain("Hòa vốn theo tòa");
    expect(html).toContain("Doanh thu hòa vốn");
    expect(html).toContain("5.454.545");
    expect(html).toContain("66,7%");
  });

  it("shows the backend reason and never substitutes zero for unavailable break-even", () => {
    hookState.breakEven = [
      breakEvenRow({
        break_even_revenue_available: false,
        break_even_revenue_reason: "UNMAPPED_AMOUNT",
        room_break_even_revenue_available: false,
        room_break_even_revenue_reason: "UNMAPPED_AMOUNT",
        break_even_occupancy_available: false,
        break_even_occupancy_reason: "ROOM_BREAK_EVEN_UNAVAILABLE",
        r_core_be: null,
        r_total_be: null,
        r_room_be: null,
        break_even_occupancy_current: null,
        break_even_occupancy_theory: null,
      }),
    ];

    const html = renderToStaticMarkup(
      <BuildingPerformanceTab
        filters={filters}
        buildings={authorizedBuildings}
      />,
    );

    expect(html).toContain("Còn số tiền chưa được mapping");
    expect(html).toContain("Chưa khả dụng");
    expect(html).not.toContain("Doanh thu hòa vốn</span><span>0");
  });

  it("uses note semantics for the persistent caveat", () => {
    const html = renderToStaticMarkup(
      <BuildingPerformanceTab
        filters={filters}
        buildings={authorizedBuildings}
      />,
    );

    expect(html.match(/role="note"/g)).toHaveLength(1);
    expect(html).not.toContain('role="alert"');
  });

  it("renders building names as row headers without changing the formula copy", () => {
    const html = renderToStaticMarkup(
      <BuildingPerformanceTab
        filters={filters}
        buildings={authorizedBuildings}
      />,
    );

    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Tòa A<\/th>/);
    expect(html).toContain("Doanh thu - Chi phí = Lợi nhuận");
    expect(html).toContain("biên lợi nhuận = Lợi nhuận / Doanh thu");
  });

  it("labels the desktop table scroller and makes it keyboard-focusable", () => {
    const html = renderToStaticMarkup(
      <BuildingPerformanceTab
        filters={filters}
        buildings={authorizedBuildings}
      />,
    );

    expect(html).toMatch(
      /<div(?=[^>]*role="region")(?=[^>]*tabindex="0")(?=[^>]*aria-label="Cuộn ngang bảng hiệu quả theo tòa nhà")[^>]*>/,
    );
    expect(html).toMatch(
      /<div(?=[^>]*role="region")(?=[^>]*aria-label="Cuộn ngang bảng hiệu quả theo tòa nhà")[^>]*><table/,
    );
  });

  it("moves the focused table scroller with horizontal arrow keys", () => {
    const handler = (
      BuildingPerformanceModule as typeof BuildingPerformanceModule & {
        scrollBuildingTableOnKeyDown?: HorizontalScrollKeyDown;
      }
    ).scrollBuildingTableOnKeyDown;

    expect(handler).toBeTypeOf("function");
    if (!handler) return;

    const scroller = { clientWidth: 400, scrollLeft: 100 };
    const preventDefault = vi.fn();
    handler({ key: "ArrowRight", currentTarget: scroller, preventDefault });

    expect(scroller.scrollLeft).toBeGreaterThan(100);
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});

describe("BuildingPerformanceTab cached query errors", () => {
  it("keeps cached building data visible with a retry warning for a transient error", () => {
    hookState.isError = true;
    hookState.error = new Error("network timeout");

    const html = renderToStaticMarkup(
      <BuildingPerformanceTab
        filters={filters}
        buildings={authorizedBuildings}
      />,
    );

    expect(html).toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).toContain("Thử tải lại");
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Tòa A<\/th>/);
    expect(html).not.toContain("Không thể tải hiệu quả theo tòa nhà");
  });

  it.each([
    ["auth", Object.assign(new Error("unauthorized"), { status: 401 })],
    ["scope", new Error("scope mismatch")],
    ["validation", Object.assign(new Error("malformed payload"), { name: "ValidationError" })],
    ["permanent", new Error("database contract changed")],
  ])("blocks cached building data for a %s error", (_, error) => {
    hookState.isError = true;
    hookState.error = error;

    const html = renderToStaticMarkup(
      <BuildingPerformanceTab
        filters={filters}
        buildings={authorizedBuildings}
      />,
    );

    expect(html).not.toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).not.toMatch(/<th[^>]*scope="row"[^>]*>Tòa A<\/th>/);
    expect(html).toContain("Không thể tải hiệu quả theo tòa nhà");
    expect(html).toContain("Thử lại");
  });
});

describe("BuildingPerformanceTab zero-activity scaffolding", () => {
  it("scaffolds only the authorized roster and never exposes UUIDs as labels", () => {
    hookState.rows = [];
    const buildings = [
      { id: BUILDING_A_ID, name: "Tòa A" },
      { id: BUILDING_B_ID, name: "Tòa B" },
    ];

    const html = renderToStaticMarkup(
      <BuildingPerformanceTab
        filters={{
          ...filters,
          buildingIds: [BUILDING_A_ID, BUILDING_B_ID, STALE_BUILDING_ID],
        }}
        buildings={buildings}
      />,
    );

    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Tòa A<\/th>/);
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Tòa B<\/th>/);
    expect(html).not.toContain(BUILDING_A_ID);
    expect(html).not.toContain(BUILDING_B_ID);
    expect(html).not.toContain(STALE_BUILDING_ID);
    expect(html).not.toContain("Chưa có dữ liệu P&amp;L theo tòa");
  });

  it("keeps roster names authoritative and ignores P&L rows outside the roster", () => {
    hookState.rows = [
      pnlRow("2026-02", 12_000_000, 5_000_000, BUILDING_A_ID, BUILDING_A_ID),
      pnlRow("2026-02", 99_000_000, 1_000_000, STALE_BUILDING_ID, "Tòa stale"),
    ];

    const html = renderToStaticMarkup(
      <BuildingPerformanceTab
        filters={{
          ...filters,
          buildingIds: [BUILDING_A_ID, STALE_BUILDING_ID],
        }}
        buildings={authorizedBuildings}
      />,
    );

    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Tòa A<\/th>/);
    expect(html).not.toContain(BUILDING_A_ID);
    expect(html).not.toContain("Tòa stale");
    expect(html).not.toContain("99.000.000");
  });

  it("limits the roster to requested IDs without materializing stale filter entries", () => {
    hookState.rows = [];
    const buildings = [
      { id: BUILDING_A_ID, name: "Tòa A" },
      { id: BUILDING_B_ID, name: "Tòa B" },
    ];

    const html = renderToStaticMarkup(
      <BuildingPerformanceTab
        filters={{
          ...filters,
          buildingIds: [BUILDING_A_ID, STALE_BUILDING_ID],
        }}
        buildings={buildings}
      />,
    );

    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Tòa A<\/th>/);
    expect(html).not.toContain("Tòa B");
    expect(html).not.toContain(STALE_BUILDING_ID);
  });

  it("compares requested periods as zero activity when their P&L rows are absent", () => {
    hookState.rows = [pnlRow("2026-02", 12_000_000, 5_000_000)];

    const html = renderToStaticMarkup(
      <BuildingPerformanceTab
        filters={filters}
        buildings={authorizedBuildings}
      />,
    );

    expect(html).not.toContain("Không có đủ hai kỳ");
    expect(html.match(/% không khả dụng/g)).toHaveLength(4);
    expect(html).toContain("Nền 01/2026:");
    expect(html).toContain("Nền 02/2025:");
  });

  it("does not replace an unavailable P&L source with zero activity", () => {
    hookState.rows = undefined;

    const html = renderToStaticMarkup(
      <BuildingPerformanceTab
        filters={filters}
        buildings={authorizedBuildings}
      />,
    );

    expect(html).toContain("Nguồn dữ liệu P&amp;L chưa khả dụng");
    expect(html).not.toMatch(/<th[^>]*scope="row"[^>]*>building-a<\/th>/);
  });

  it("shows a scope state when the authorized roster is empty even if filters are stale", () => {
    hookState.rows = [];

    const html = renderToStaticMarkup(
      <BuildingPerformanceTab filters={filters} buildings={[]} />,
    );

    expect(html).toContain("Chưa có tòa vật lý trong phạm vi");
    expect(html).not.toMatch(/<th[^>]*scope="row"/);
  });
});
