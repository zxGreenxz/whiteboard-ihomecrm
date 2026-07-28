// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BusinessPerformanceInventoryHistoryRow } from "@/hooks/reports/useBusinessPerformanceGatedData";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  upcoming: vi.fn(),
  trend: vi.fn(),
  history: vi.fn(),
}));

vi.mock("recharts", () => ({
  CartesianGrid: () => null,
  Line: () => null,
  LineChart: () => null,
  ResponsiveContainer: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock("@/hooks/reports/useBusinessPerformance", () => ({
  useBusinessPerformanceOccupancySnapshot: mocks.snapshot,
  useBusinessPerformanceUpcomingVacancy: mocks.upcoming,
  useBusinessPerformanceOccupancyTrend12m: mocks.trend,
  useBusinessPerformanceInventoryHistory: mocks.history,
}));

import { OccupancyVacancyTab } from "../OccupancyVacancyTab";

const filters = {
  month: "2026-02",
  periodStart: "2026-02-01",
  periodEnd: "2026-02-28",
  prevMonth: "2026-01",
  yoyMonth: "2025-02",
  t13Start: "2025-02-01",
  t13End: "2026-02-28",
  months12: [],
  buildingIds: ["building-a"],
  basis: "ACCRUAL" as const,
  organizationId: "organization-a",
};

function query(data: unknown) {
  return {
    data,
    error: null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
}

function cachedError(data: unknown, error: Error) {
  return {
    ...query(data),
    isError: true,
    error,
  };
}

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    building_id: "building-a",
    building_name: "Empty building",
    total: 0,
    occupied: 0,
    reserved: 0,
    maintenance: 0,
    unavailable: 0,
    available: 0,
    occupancy_pct: 0,
    committed_pct: 0,
    missed_revenue: 0,
    generated_at: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

function trendPoint(overrides: Record<string, unknown> = {}) {
  return {
    month: "2/2026",
    occupied: 0,
    total: 0,
    rate: 0,
    ...overrides,
  };
}

function upcomingRow(overrides: Record<string, unknown> = {}) {
  return {
    contract_id: "contract-a",
    contract_number: "HD-001",
    building_id: "building-a",
    building_name: "Empty building",
    room_id: "room-a",
    room_name: "Room 101",
    effective_end_date: "2026-08-01",
    days_remaining: 8,
    rent_price: 3_000_000,
    extension_applied: false,
    ...overrides,
  };
}

function historyRow(
  overrides: Partial<BusinessPerformanceInventoryHistoryRow> = {},
): BusinessPerformanceInventoryHistoryRow {
  return {
    snapshot_month: "2026-02-01",
    building_id: "building-a",
    building_name: "Empty building",
    snapshot_status: "FINALIZED",
    snapshot_missing: false,
    availability_reason: null,
    total: 4,
    occupied: 2,
    reserved: 1,
    maintenance: 0,
    unavailable: 0,
    available: 1,
    occupancy_pct: 50,
    committed_pct: 75,
    listed_rent_opportunity: 3_000_000,
    capacity_current: 12_000_000,
    capacity_blocked: 0,
    capacity_theory: 12_000_000,
    invalid_rent_room_count: 0,
    as_of_date: "2026-02-28",
    as_of_timestamp: "2026-02-28T16:55:00.000Z",
    captured_at: "2026-02-28T16:55:01.000Z",
    is_late: false,
    capture_version: 1,
    ...overrides,
  };
}

describe("OccupancyVacancyTab", () => {
  beforeEach(() => {
    mocks.snapshot.mockClear();
    mocks.upcoming.mockClear();
    mocks.trend.mockClear();
    mocks.history.mockClear();
    mocks.snapshot.mockReturnValue(query([snapshotRow()]));
    mocks.upcoming.mockReturnValue(query([]));
    mocks.trend.mockReturnValue(query([trendPoint()]));
    mocks.history.mockReturnValue(
      query([
        historyRow(),
        historyRow({
          snapshot_month: "2026-01-01",
          snapshot_status: "MISSING",
          snapshot_missing: true,
          availability_reason: "NO_SNAPSHOT",
          total: null,
          occupied: null,
          reserved: null,
          maintenance: null,
          unavailable: null,
          available: null,
          occupancy_pct: null,
          committed_pct: null,
          listed_rent_opportunity: null,
          capacity_current: null,
          capacity_blocked: null,
          capacity_theory: null,
          invalid_rent_room_count: null,
          as_of_date: null,
          as_of_timestamp: null,
          captured_at: null,
          is_late: null,
          capture_version: null,
        }),
      ]),
    );
  });

  it("renders authoritative month snapshots and preserves missing months", () => {
    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(mocks.history).toHaveBeenCalledWith(
      filters,
      "2025-03-01",
      "2026-02-01",
    );
    expect(html).toContain("Lịch sử snapshot cuối tháng");
    expect(html).toContain("Đã chốt");
    expect(html).toContain("Chưa có snapshot");
    expect(html).toContain("50,0%");
    expect(html).not.toContain("2026-01-01</th><td");
  });

  it("passes the organization-bound scope to every occupancy query", () => {
    renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(mocks.snapshot).toHaveBeenCalledWith(
      filters.organizationId,
      expect.any(String),
      filters.buildingIds,
    );
    expect(mocks.upcoming).toHaveBeenCalledWith(
      filters.organizationId,
      expect.any(String),
      60,
      filters.buildingIds,
    );
    expect(mocks.trend).toHaveBeenCalledWith(
      filters.organizationId,
      filters.buildingIds,
    );
  });

  it("uses note semantics for the static caveat", () => {
    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(html).toMatch(/<div[^>]*role="note"[^>]*>/);
  });

  it("labels the horizontal chart scroller and makes it keyboard-focusable", () => {
    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(html).toMatch(
      /<div(?=[^>]*role="region")(?=[^>]*tabindex="0")(?=[^>]*aria-label="Cuộn ngang biểu đồ tỷ lệ lấp đầy ước tính 12 tháng")[^>]*>/,
    );
  });

  it.each([
    ["snapshot", "Hiện trạng theo tòa"],
    ["trend", "Xem bảng dữ liệu biểu đồ"],
    ["upcoming", "Room 101"],
  ] as const)("keeps cached %s content for a transient refetch error", (source, marker) => {
    if (source === "snapshot") {
      mocks.snapshot.mockReturnValue(cachedError([snapshotRow()], new Error("network timeout")));
    } else if (source === "trend") {
      mocks.trend.mockReturnValue(cachedError([trendPoint()], new Error("network timeout")));
    } else {
      mocks.upcoming.mockReturnValue(cachedError([upcomingRow()], new Error("network timeout")));
    }

    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(html).toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).toContain(marker);
  });

  it.each([
    ["snapshot", "Hiện trạng theo tòa"],
    ["trend", "Xem bảng dữ liệu biểu đồ"],
    ["upcoming", "Room 101"],
  ] as const)("hides cached %s content for a permanent error", (source, marker) => {
    const error = Object.assign(new Error("timeout while checking scope"), {
      code: "42501",
    });
    if (source === "snapshot") mocks.snapshot.mockReturnValue(cachedError([snapshotRow()], error));
    else if (source === "trend") mocks.trend.mockReturnValue(cachedError([trendPoint()], error));
    else mocks.upcoming.mockReturnValue(cachedError([upcomingRow()], error));

    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(html).not.toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).not.toContain(marker);
    expect(html).toContain("Thử lại");
  });

  it("lets validation block cached snapshot data during a transient refetch error", () => {
    mocks.snapshot.mockReturnValue(
      cachedError([snapshotRow({ building_id: "building-b" })], new Error("network timeout")),
    );

    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(html).not.toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).not.toContain("Hiện trạng theo tòa");
    expect(html).toContain("Không thể tải ảnh chụp lấp đầy hiện tại");
  });


  it("renders unavailable rates for zero-room denominators", () => {
    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(html).not.toContain("0.0%");
    expect(html).toMatch(
      /<th[^>]*scope="row"[^>]*>2\/2026<\/th><td[^>]*>0<\/td><td[^>]*>0<\/td><td[^>]*>\u2014<\/td>/,
    );
    expect(html).toMatch(
      /<th[^>]*scope="row"[^>]*>Empty building<\/th>(?:<td[^>]*>0<\/td>){6}<td[^>]*>\u2014<\/td><td[^>]*>\u2014<\/td>/,
    );
  });

  it("keeps the KPI grid to one column at 320px before using two columns", () => {
    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(html).toContain("grid-cols-1");
    expect(html).toContain("min-[400px]:grid-cols-2");
    expect(html).toContain("min-[400px]:col-span-2");
  });

  it("uses explicit column and row scopes in all four data tables", () => {
    mocks.upcoming.mockReturnValue(query([upcomingRow()]));

    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(html.match(/<table/g)).toHaveLength(4);
    expect(html.match(/<th[^>]*scope="col"/g)).toHaveLength(27);
    expect(html.match(/<th[^>]*scope="row"/g)).toHaveLength(5);
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Empty building<\/th>/);
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>2\/2026<\/th>/);
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Room 101<\/th>/);
  });

  it("makes each wide data table a separately named keyboard-scroll region", () => {
    mocks.upcoming.mockReturnValue(query([upcomingRow()]));

    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    for (const label of [
      "Bảng hiện trạng phòng và tỷ lệ lấp đầy theo tòa",
      "Bảng dữ liệu tỷ lệ lấp đầy ước tính 12 tháng",
      "Bảng phòng sắp kết thúc hợp đồng trong 60 ngày",
    ]) {
      expect(html).toMatch(
        new RegExp(
          `<div(?=[^>]*role="region")(?=[^>]*aria-label="${label}")(?=[^>]*tabindex="0")[^>]*><table`,
        ),
      );
    }
  });

  it.each([
    ["negative total", { total: -1, unavailable: -1 }],
    ["negative occupied", { occupied: -1, available: 1 }],
    ["negative reserved", { reserved: -1, available: 1 }],
    ["negative available", { occupied: 1, available: -1 }],
    ["negative maintenance", { maintenance: -1, available: 1 }],
    ["negative unavailable", { unavailable: -1, available: 1 }],
  ])("rejects snapshot rows with %s", (_label, overrides) => {
    mocks.snapshot.mockReturnValue(query([snapshotRow(overrides)]));

    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(html).toContain("Không thể tải ảnh chụp lấp đầy hiện tại");
    expect(html).not.toMatch(/scope="row"[^>]*>Empty building<\/th>/);
  });

  it("rejects snapshot rows whose room-state counts do not equal total rooms", () => {
    mocks.snapshot.mockReturnValue(
      query([
        snapshotRow({
          total: 10,
          occupied: 4,
          reserved: 1,
          available: 3,
          maintenance: 1,
          unavailable: 0,
          occupancy_pct: 40,
          committed_pct: 50,
        }),
      ]),
    );

    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(html).toContain("Không thể tải ảnh chụp lấp đầy hiện tại");
    expect(html).not.toMatch(/scope="row"[^>]*>Empty building<\/th>/);
  });

  it.each([
    ["non-finite occupancy rate", { occupancy_pct: Number.NaN }],
    ["negative occupancy rate", { occupancy_pct: -0.1 }],
    ["committed rate above 100", { committed_pct: 100.1 }],
  ])("rejects snapshot rows with %s", (_label, overrides) => {
    mocks.snapshot.mockReturnValue(query([snapshotRow(overrides)]));

    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(html).toContain("Không thể tải ảnh chụp lấp đầy hiện tại");
  });

  it.each([
    ["negative occupied rooms", { occupied: -1, total: 1, rate: 0 }],
    ["occupied rooms above total", { occupied: 2, total: 1, rate: 100 }],
    ["non-finite rate", { occupied: 1, total: 1, rate: Number.NaN }],
    ["rate above 100", { occupied: 1, total: 1, rate: 100.1 }],
  ])("rejects trend rows with %s", (_label, overrides) => {
    mocks.trend.mockReturnValue(query([trendPoint(overrides)]));

    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(html).toContain("Không thể tải xu hướng lấp đầy ước tính");
    expect(html).not.toMatch(/scope="row"[^>]*>2\/2026<\/th>/);
  });

  it.each([
    ["null", null],
    ["malformed", "not-a-date"],
    ["impossible", "2026-02-30"],
    ["non-canonical", "2026-2-03"],
  ])("rejects a %s effective end date before date-fns rendering", (_label, value) => {
    mocks.upcoming.mockReturnValue(
      query([upcomingRow({ effective_end_date: value })]),
    );

    let html = "";
    expect(() => {
      html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);
    }).not.toThrow();
    expect(html).toContain("Không thể tải danh sách phòng sắp trống");
    expect(html).not.toContain("Room 101");
  });

  it.each([
    ["snapshot", "snapshot"],
    ["upcoming vacancy", "upcoming"],
  ])("rejects an out-of-scope building row from the %s query", (_label, source) => {
    if (source === "snapshot") {
      mocks.snapshot.mockReturnValue(
        query([snapshotRow({ building_id: "building-b" })]),
      );
    } else {
      mocks.upcoming.mockReturnValue(
        query([upcomingRow({ building_id: "building-b" })]),
      );
    }

    const html = renderToStaticMarkup(<OccupancyVacancyTab filters={filters} />);

    expect(html).not.toContain("Room 101</th>");
    expect(html).toContain(
      source === "snapshot"
        ? "Không thể tải ảnh chụp lấp đầy hiện tại"
        : "Không thể tải danh sách phòng sắp trống",
    );
  });
});
