// @vitest-environment node

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BusinessPerformanceFilters,
} from "@/lib/businessPerformance";
import type { BusinessPerformanceCategoryBreakdownRow } from "@/hooks/reports/useBusinessPerformanceGatedData";
import { RevenueCostStructureTab } from "../RevenueCostStructureTab";

const queryState = vi.hoisted(() => ({
  breakdown: {
    data: [] as BusinessPerformanceCategoryBreakdownRow[],
    isLoading: false,
    isError: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
}));

vi.mock("@/hooks/reports/useBusinessPerformance", () => ({
  useBusinessPerformanceCategoryBreakdown: () => queryState.breakdown,
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

function categoryRow(
  typeId: string,
  typeName: string,
  category: string,
  totalAmount: number,
): BusinessPerformanceCategoryBreakdownRow {
  return {
    month: "2026-02-01",
    side: "INCOME",
    type_id: typeId,
    type_name: typeName,
    category,
    total_amount: totalAmount,
    voucher_count: 1,
  };
}

function renderTab() {
  return renderToStaticMarkup(<RevenueCostStructureTab filters={filters} />);
}

beforeEach(() => {
  queryState.breakdown = {
    data: [
      categoryRow("type-a", "Tiền phòng", "Doanh thu cho thuê", 100),
      categoryRow("type-b", "Phí dịch vụ", "Doanh thu dịch vụ", 50),
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

  it("gives the category detail table an accessible name and scoped headers", () => {
    const html = renderTab();

    expect(html).toContain("<caption");
    expect(html).toContain("Cơ cấu doanh thu theo hạng mục");
    expect(html.match(/<th[^>]*scope="col"/g)).toHaveLength(4);
    expect(html.match(/<th[^>]*scope="row"/g)).toHaveLength(3);
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Tiền phòng<\/th>/);
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*>Phí dịch vụ<\/th>/);
    expect(html).toContain("Doanh thu cho thuê");
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
      /<div(?=[^>]*role="region")(?=[^>]*tabindex="0")(?=[^>]*aria-label="Cuộn ngang bảng chi tiết cơ cấu doanh thu theo hạng mục")[^>]*>/,
    );
  });
});

describe("RevenueCostStructureTab query states", () => {
  it("keeps cached structure content with a retryable warning after a transient refetch error", () => {
    queryState.breakdown = {
      ...queryState.breakdown,
      isError: true,
      error: new Error("network timeout"),
    };

    const html = renderTab();

    expect(html).toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).toContain("Thử tải lại");
    expect(html).toContain("Tiền phòng");
  });

  it("blocks cached structure content for a permanent query error", () => {
    queryState.breakdown = {
      ...queryState.breakdown,
      isError: true,
      error: Object.assign(new Error("timeout while checking scope"), {
        code: "42501",
      }),
    };

    const html = renderTab();

    expect(html).not.toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).not.toContain("Tiền phòng");
    expect(html).toContain("Không thể tải cơ cấu Thu/Chi");
    expect(html).toContain("Thử lại");
  });
});
