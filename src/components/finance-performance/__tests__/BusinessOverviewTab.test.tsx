// @vitest-environment node

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OccupancySnapshotRow } from "@/hooks/reports/useBusinessPerformance";
import type {
  BusinessPerformanceFilters,
  BusinessPerformancePnlRow,
  BusinessPerformanceSnapshotRow,
} from "@/lib/businessPerformance";
import { BusinessOverviewTab } from "../BusinessOverviewTab";

interface QueryStub<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: ReturnType<typeof vi.fn>;
}

const hookState = vi.hoisted(() => ({
  pnl: {} as QueryStub<BusinessPerformancePnlRow[]>,
  snapshot: {} as QueryStub<BusinessPerformanceSnapshotRow[]>,
  occupancy: {} as QueryStub<OccupancySnapshotRow[]>,
}));

const hookCalls = vi.hoisted(() => ({
  businessSnapshot: vi.fn(),
  occupancySnapshot: vi.fn(),
}));

const originalTimeZone = process.env.TZ;

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("@/hooks/reports/useBusinessPerformance", () => ({
  useBusinessPerformancePnl: () => hookState.pnl,
  useBusinessPerformanceSnapshot: (...args: unknown[]) => {
    hookCalls.businessSnapshot(...args);
    return hookState.snapshot;
  },
  useBusinessPerformanceOccupancySnapshot: (...args: unknown[]) => {
    hookCalls.occupancySnapshot(...args);
    return hookState.occupancy;
  },
}));

const baseFilters: BusinessPerformanceFilters = {
  month: "2024-02",
  periodStart: "2024-02-01",
  periodEnd: "2024-02-29",
  prevMonth: "2024-01",
  yoyMonth: "2023-02",
  t13Start: "2023-02-01",
  t13End: "2024-02-29",
  months12: [],
  buildingIds: ["building-a"],
  basis: "ACCRUAL",
  organizationId: "organization-a",
};

const validOccupancyRow: OccupancySnapshotRow = {
  building_id: "building-a",
  building_name: "Tòa A",
  total: 10,
  occupied: 6,
  reserved: 1,
  maintenance: 1,
  unavailable: 0,
  available: 2,
  occupancy_pct: 60,
  committed_pct: 70,
  missed_revenue: 8_000_000,
  generated_at: "2024-02-29T17:00:00Z",
};

const validBusinessSnapshotRow: BusinessPerformanceSnapshotRow = {
  building_id: "building-a",
  building_name: "Tòa A",
  total_rooms: 10,
  rooms_available: 2,
  rooms_occupied: 6,
  rooms_reserved: 1,
  rooms_maintenance: 1,
  rooms_unavailable: 0,
  vacancy_loss_month: 8_000_000,
  active_contracts: 6,
  avg_rent: 4_000_000,
  deposit_held: 12_345_678,
  receivable_total: 9_876_543,
  aging_not_due: 0,
  aging_1_30: 0,
  aging_31_60: 0,
  aging_61_90: 0,
  aging_over_90: 0,
};

function queryStub<T>(data: T | undefined): QueryStub<T> {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
}

function renderOverview(filters = baseFilters) {
  return renderToStaticMarkup(
    createElement(BusinessOverviewTab, { filters }),
  );
}

beforeEach(() => {
  hookCalls.businessSnapshot.mockClear();
  hookCalls.occupancySnapshot.mockClear();
  hookState.pnl = queryStub([]);
  hookState.snapshot = queryStub([]);
  hookState.occupancy = queryStub([]);
});

afterEach(() => {
  vi.useRealTimers();
  if (originalTimeZone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimeZone;
  }
});

describe("BusinessOverviewTab occupancy integrity", () => {
  it("passes the organization-bound scope to both snapshot hooks", () => {
    renderOverview();

    expect(hookCalls.businessSnapshot).toHaveBeenCalledWith(
      baseFilters.organizationId,
      baseFilters.buildingIds,
    );
    expect(hookCalls.occupancySnapshot).toHaveBeenCalledWith(
      baseFilters.organizationId,
      expect.any(String),
      baseFilters.buildingIds,
    );
  });

  it.each([
    [
      "a non-finite numeric value",
      { ...validOccupancyRow, missed_revenue: Number.POSITIVE_INFINITY },
    ],
    [
      "a building outside the requested physical scope",
      { ...validOccupancyRow, building_id: "building-b" },
    ],
  ])("renders a query error instead of aggregating %s", (_, row) => {
    hookState.occupancy = queryStub([row]);

    const html = renderOverview();

    expect(html).toContain("Không thể tải snapshot lấp đầy");
    expect(html).not.toContain(">Tổng phòng<");
  });

  it.each([
    [
      "a negative room-state count",
      { ...validOccupancyRow, maintenance: -1, available: 4 },
    ],
    [
      "a fractional room-state count",
      { ...validOccupancyRow, maintenance: 1.5, available: 1.5 },
    ],
    [
      "an unsafe-integer room count",
      {
        ...validOccupancyRow,
        total: Number.MAX_SAFE_INTEGER + 1,
        occupied: 0,
        reserved: 0,
        maintenance: 0,
        unavailable: 0,
        available: Number.MAX_SAFE_INTEGER + 1,
        occupancy_pct: 0,
        committed_pct: 0,
      },
    ],
    [
      "an occupied count above total rooms",
      {
        ...validOccupancyRow,
        total: 5,
        occupied: 6,
        reserved: 0,
        maintenance: 0,
        unavailable: 0,
        available: 0,
        occupancy_pct: 100,
        committed_pct: 100,
      },
    ],
    [
      "room-state counts that do not equal total rooms",
      { ...validOccupancyRow, available: 3 },
    ],
    [
      "an occupancy rate below zero",
      { ...validOccupancyRow, occupancy_pct: -0.1 },
    ],
    [
      "a committed rate above 100",
      { ...validOccupancyRow, committed_pct: 100.1 },
    ],
    [
      "an occupancy rate inconsistent with its counts",
      { ...validOccupancyRow, occupancy_pct: 50 },
    ],
    [
      "a committed rate inconsistent with its counts",
      { ...validOccupancyRow, committed_pct: 60 },
    ],
  ])("fails closed for %s", (_, row) => {
    hookState.occupancy = queryStub([row]);

    const html = renderOverview();

    expect(html).toContain("Không thể tải snapshot lấp đầy");
    expect(html).not.toContain(">Tổng phòng<");
  });

  it("keeps zero-room snapshots valid while rendering aggregate rates as unavailable", () => {
    hookState.occupancy = queryStub([
      {
        ...validOccupancyRow,
        total: 0,
        occupied: 0,
        reserved: 0,
        maintenance: 0,
        unavailable: 0,
        available: 0,
        occupancy_pct: 0,
        committed_pct: 0,
        missed_revenue: 0,
      },
    ]);

    const html = renderOverview();

    expect(html).not.toContain("Không thể tải snapshot lấp đầy");
    expect(html).toContain(">Tổng phòng<");
    expect(html).toMatch(/>—<\/div><div[^>]*>Tỷ lệ lấp đầy có trọng số<\/div>/);
    expect(html).toMatch(/>—<\/div><div[^>]*>Tỷ lệ cam kết có trọng số<\/div>/);
  });

  it("fails closed when individually safe row counts overflow the aggregate", () => {
    const maximumSafeRow: OccupancySnapshotRow = {
      ...validOccupancyRow,
      total: Number.MAX_SAFE_INTEGER,
      occupied: 0,
      reserved: 0,
      maintenance: 0,
      unavailable: 0,
      available: Number.MAX_SAFE_INTEGER,
      occupancy_pct: 0,
      committed_pct: 0,
    };
    hookState.occupancy = queryStub([
      maximumSafeRow,
      {
        ...maximumSafeRow,
        building_id: "building-b",
        building_name: "Tòa B",
      },
    ]);

    const html = renderOverview({
      ...baseFilters,
      buildingIds: ["building-a", "building-b"],
    });

    expect(html).toContain("Không thể tải snapshot lấp đầy");
    expect(html).not.toContain(">Tổng phòng<");
  });
});

describe("BusinessOverviewTab observation states", () => {
  it("does not claim there are no observations while P&L is loading", () => {
    hookState.pnl = {
      ...queryStub(undefined),
      isLoading: true,
    };

    const html = renderOverview();

    expect(html).toContain("Đang tổng hợp quan sát");
    expect(html).not.toContain("Không có điều kiện nào trong ba nhóm quan sát");
  });

  it("does not claim there are no observations when occupancy failed", () => {
    hookState.occupancy = {
      ...queryStub(undefined),
      isError: true,
      error: new Error("timeout"),
    };

    const html = renderOverview();

    expect(html).toContain("Chưa thể kết luận các quan sát");
    expect(html.match(/role="alert"/g)).toHaveLength(2);
    expect(html).not.toContain("Không có điều kiện nào trong ba nhóm quan sát");
  });

  it("announces the empty observations state as a status", () => {
    const html = renderOverview();

    expect(html).toMatch(
      /<p[^>]*role="status"[^>]*>Không có điều kiện nào trong ba nhóm quan sát:/,
    );
  });
});

describe("BusinessOverviewTab cached query errors", () => {
  it.each([
    ["P&L", "pnl", "Đối chiếu theo kỳ"],
    ["occupancy", "occupancy", "Tỷ lệ lấp đầy có trọng số"],
    ["financial snapshot", "snapshot", "Tiền cọc đang giữ"],
  ] as const)("keeps cached %s content for a transient refetch error", (_, source, marker) => {
    if (source === "pnl") hookState.pnl = queryStub([pnlRow("2024-02", 125)]);
    if (source === "occupancy") hookState.occupancy = queryStub([validOccupancyRow]);
    if (source === "snapshot") hookState.snapshot = queryStub([validBusinessSnapshotRow]);
    hookState[source] = {
      ...hookState[source],
      isError: true,
      error: new Error("network timeout"),
    } as never;

    const html = renderOverview();

    expect(html).toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).toContain(marker);
  });

  it.each([
    ["P&L", "pnl", "Đối chiếu theo kỳ"],
    ["occupancy", "occupancy", "Tỷ lệ lấp đầy có trọng số"],
    ["financial snapshot", "snapshot", "Tiền cọc đang giữ"],
  ] as const)("hides cached %s content for a permanent error", (_, source, marker) => {
    if (source === "pnl") hookState.pnl = queryStub([pnlRow("2024-02", 125)]);
    if (source === "occupancy") hookState.occupancy = queryStub([validOccupancyRow]);
    if (source === "snapshot") hookState.snapshot = queryStub([validBusinessSnapshotRow]);
    hookState[source] = {
      ...hookState[source],
      isError: true,
      error: Object.assign(new Error("timeout while checking scope"), { code: "42501" }),
    } as never;

    const html = renderOverview();

    expect(html).not.toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).not.toContain(marker);
    expect(html).toContain("Thử lại");
  });

  it("blocks invalid cached occupancy data even when the refetch error is transient", () => {
    hookState.occupancy = {
      ...queryStub([{ ...validOccupancyRow, building_id: "building-b" }]),
      isError: true,
      error: new Error("network timeout"),
    };

    const html = renderOverview();

    expect(html).not.toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).not.toContain("Tỷ lệ lấp đầy có trọng số");
    expect(html).toContain("Không thể tải snapshot lấp đầy");
  });
});

describe("BusinessOverviewTab business date", () => {
  it("uses Asia/Ho_Chi_Minh for the snapshot date and current-month observation", () => {
    process.env.TZ = "America/Los_Angeles";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-02-29T17:30:00.000Z"));

    const html = renderOverview({
      ...baseFilters,
      month: "2024-03",
      periodStart: "2024-03-01",
      periodEnd: "2024-03-31",
      prevMonth: "2024-02",
      yoyMonth: "2023-03",
    });

    expect(html).toContain("Snapshot Occupancy v2 tại ngày 01/03/2024");
    expect(html).toContain("Tháng 03/2024 đang mở");
  });
});

describe("BusinessOverviewTab render semantics", () => {
  it("renders zero P&L KPIs for a successful month with no activity", () => {
    const html = renderOverview();

    expect(html).not.toContain("Chưa có dữ liệu KQKD cho kỳ đã chọn");
    expect(html).toMatch(/title="0\u00a0₫">0\u00a0₫<\/div><div[^>]*>Doanh thu<\/div>/);
    expect(html).toMatch(/title="0\u00a0₫">0\u00a0₫<\/div><div[^>]*>Chi phí<\/div>/);
    expect(html).toMatch(/title="0\u00a0₫">0\u00a0₫<\/div><div[^>]*>Lợi nhuận<\/div>/);
    expect(html).toMatch(/title="—">—<\/div><div[^>]*>Biên lợi nhuận<\/div>/);
  });

  it("marks leading and trailing button icons", () => {
    const html = renderOverview();

    expect(
      html.match(
        /<svg(?=[^>]*lucide-banknote)(?=[^>]*data-icon="inline-start")[^>]*>/g,
      ),
    ).toHaveLength(1);
    expect(
      html.match(
        /<svg(?=[^>]*lucide-arrow-right)(?=[^>]*data-icon="inline-end")[^>]*>/g,
      ),
    ).toHaveLength(3);
  });

  it("uses flex gaps instead of space-y utilities", () => {
    const source = readFileSync(
      new URL("../BusinessOverviewTab.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/\bspace-y-/);
  });

  it("adds a comparison caption and row headers", () => {
    hookState.pnl = queryStub([
      pnlRow("2024-02", 125),
      pnlRow("2024-01", 100),
    ]);

    const html = renderOverview();

    expect(html).toContain("<caption");
    expect(html.match(/<th[^>]*scope="row"/g)).toHaveLength(4);
  });

  it("makes the wide comparison table keyboard-scrollable", () => {
    const html = renderOverview();

    expect(html).toMatch(
      /<div(?=[^>]*role="region")(?=[^>]*aria-label="Bảng đối chiếu kết quả kinh doanh theo kỳ")(?=[^>]*tabindex="0")[^>]*><table/,
    );
  });

  it("keeps zero-baseline absolute deltas and renders '% không khả dụng'", () => {
    hookState.pnl = queryStub([
      pnlRow("2024-02", 125),
      pnlRow("2024-01", 0),
    ]);

    const html = renderOverview();

    expect(html).toContain("% không khả dụng");
  });

  it("uses one occupancy KPI column below 400px", () => {
    hookState.occupancy = queryStub([validOccupancyRow]);

    const html = renderOverview();

    expect(html).toContain("grid-cols-1");
    expect(html).toContain("min-[400px]:grid-cols-2");
    expect(html).toContain("min-[400px]:col-span-2");
  });
});

function pnlRow(month: string, revenue: number): BusinessPerformancePnlRow {
  return {
    month: `${month}-01`,
    building_id: "building-a",
    building_name: "Tòa A",
    is_virtual: false,
    revenue,
    expense: 0,
    net: revenue,
  };
}
