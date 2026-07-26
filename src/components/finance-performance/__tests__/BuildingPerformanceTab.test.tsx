// @vitest-environment node

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BusinessPerformanceFilters,
  BusinessPerformancePnlRow,
} from "@/lib/businessPerformance";
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
