// @vitest-environment node

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BusinessPerformanceFilters,
  BusinessPerformancePnlRow,
} from "@/lib/businessPerformance";
import { RevenueCostStructureTab } from "../RevenueCostStructureTab";

const queryState = vi.hoisted(() => ({
  pnl: {
    data: [] as BusinessPerformancePnlRow[],
    isLoading: false,
    isError: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
}));

vi.mock("@/hooks/reports/useBusinessPerformance", () => ({
  useBusinessPerformancePnl: () => queryState.pnl,
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
  buildingIds: ["building-a", "building-b"],
  basis: "ACCRUAL",
  organizationId: "organization-a",
};

function pnlRow(
  buildingId: string,
  buildingName: string,
  revenue: number,
  expense: number,
): BusinessPerformancePnlRow {
  return {
    month: "2026-02-01",
    building_id: buildingId,
    building_name: buildingName,
    is_virtual: false,
    revenue,
    expense,
    net: revenue - expense,
  };
}

function renderTab() {
  return renderToStaticMarkup(<RevenueCostStructureTab filters={filters} />);
}

beforeEach(() => {
  queryState.pnl = {
    data: [
      pnlRow("building-a", "Tòa A", 100, 40),
      pnlRow("building-b", "Tòa B", 50, 20),
    ],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
});

describe("RevenueCostStructureTab table semantics", () => {
  it("marks the static caveat as a note", () => {
    const html = renderTab();

    expect(html).toMatch(/<div[^>]*role="note"[^>]*>/);
  });

  it("names the Thu/Chi tablist in Vietnamese", () => {
    const html = renderTab();

    expect(html).toMatch(
      /<div[^>]*role="tablist"[^>]*aria-label="Chọn cơ cấu Thu hoặc Chi"[^>]*>/,
    );
  });

  it("gives the building detail table an accessible name and scoped headers", () => {
    const html = renderTab();

    expect(html).toContain("<caption");
    expect(html).toContain("Cơ cấu doanh thu theo tòa");
    expect(html.match(/<th[^>]*scope="col"/g)).toHaveLength(3);
    expect(html.match(/<th[^>]*scope="row"/g)).toHaveLength(3);
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Tòa A<\/th>/);
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Tòa B<\/th>/);
    expect(html).toContain('aria-labelledby="income-structure-table-title"');
  });

  it("contains the mobile table and uses gap-based layout utilities", () => {
    const html = renderTab();
    const source = readFileSync(
      new URL("../RevenueCostStructureTab.tsx", import.meta.url),
      "utf8",
    );

    expect(html).toContain("min-w-0 max-w-full overflow-hidden");
    expect(html).toContain("min-w-[32rem]");
    expect(source).not.toMatch(/\bspace-[xy]-/);
  });

  it("labels the wide table scroller and makes it keyboard-focusable", () => {
    const html = renderTab();

    expect(html).toMatch(
      /<div(?=[^>]*role="region")(?=[^>]*tabindex="0")(?=[^>]*aria-label="Cuộn ngang bảng chi tiết cơ cấu doanh thu theo tòa")[^>]*>/,
    );
  });
});

describe("RevenueCostStructureTab query states", () => {
  it("keeps cached structure content with a retryable warning after a transient refetch error", () => {
    queryState.pnl = {
      ...queryState.pnl,
      isError: true,
      error: new Error("network timeout"),
    };

    const html = renderTab();

    expect(html).toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).toContain("Thử tải lại");
    expect(html).toContain("Tòa A");
  });

  it("blocks cached structure content for a permanent query error", () => {
    queryState.pnl = {
      ...queryState.pnl,
      isError: true,
      error: Object.assign(new Error("timeout while checking scope"), {
        code: "42501",
      }),
    };

    const html = renderTab();

    expect(html).not.toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).not.toContain("Tòa A");
    expect(html).toContain("Không thể tải cơ cấu Thu/Chi");
    expect(html).toContain("Thử lại");
  });
});
