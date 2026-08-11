// @vitest-environment node

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { capturedChartData, capturedChartProps, capturedLineProps, queryState } = vi.hoisted(() => ({
  capturedChartData: [] as Array<ReadonlyArray<Record<string, unknown>>>,
  capturedChartProps: [] as Array<Record<string, unknown>>,
  capturedLineProps: [] as Array<Record<string, unknown>>,
  queryState: {
    data: [] as BusinessPerformancePnlRow[],
    isLoading: false,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
}));

vi.mock("recharts", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => children ?? null;
  const Empty = (): null => null;

  return {
    CartesianGrid: Empty,
    Legend: ({ content }: { content?: ReactNode }) => content ?? null,
    Line: (props: Record<string, unknown>): null => {
      capturedLineProps.push(props);
      return null;
    },
    LineChart: ({
      children,
      data,
      ...props
    }: {
      children?: ReactNode;
      data: ReadonlyArray<Record<string, unknown>>;
    } & Record<string, unknown>) => {
      capturedChartData.push(data);
      capturedChartProps.push(props);
      return children ?? null;
    },
    ReferenceLine: Empty,
    ResponsiveContainer: Passthrough,
    Tooltip: Empty,
    XAxis: Empty,
    YAxis: Empty,
  };
});

vi.mock("@/hooks/reports/useBusinessPerformance", () => ({
  useBusinessPerformancePnl: () => queryState,
}));

import { absoluteDelta, TrendsComparisonTab } from "../TrendsComparisonTab";
import {
  buildBusinessPerformanceComparison,
  buildBusinessPerformanceFilters,
  type BusinessPerformancePnlRow,
} from "@/lib/businessPerformance";

function pnlRow(
  month: string,
  revenue: number,
  isVirtual = false,
): BusinessPerformancePnlRow {
  return {
    month: `${month}-01`,
    building_id: "building-a",
    building_name: "Tòa A",
    is_virtual: isVirtual,
    revenue,
    expense: 0,
    net: revenue,
  };
}

const filters = buildBusinessPerformanceFilters(
  "2024-02",
  ["building-a"],
  "ACCRUAL",
  "organization-a",
);

function renderTrends(rows: BusinessPerformancePnlRow[]) {
  queryState.data = rows;
  return renderToStaticMarkup(
    createElement(TrendsComparisonTab, { filters }),
  );
}

function getLabelledScrollRegion(html: string, labelledBy: string) {
  const regions = html.match(/<div[^>]*role="region"[^>]*>/g) ?? [];
  return regions.find((region) =>
    region.includes(`aria-labelledby="${labelledBy}"`),
  );
}

function getLegendItem(html: string, dataKey: string) {
  return html.match(
    new RegExp(`<li[^>]*data-series-key="${dataKey}"[^>]*>[\\s\\S]*?<\\/li>`),
  )?.[0];
}

beforeEach(() => {
  capturedChartData.length = 0;
  capturedChartProps.length = 0;
  capturedLineProps.length = 0;
  queryState.data = [];
  queryState.isLoading = false;
  queryState.isError = false;
  queryState.error = null;
  queryState.refetch.mockClear();
});

describe("trend query state", () => {
  it("keeps cached charts and tables visible with a retryable warning after a transient refetch error", () => {
    queryState.isError = true;
    queryState.error = new Error("network timeout");

    const html = renderTrends([pnlRow("2024-02", 150)]);

    expect(html).toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).toContain("Thử tải lại");
    expect(html).toContain("Bảng dữ liệu thay thế cho biểu đồ");
    expect(capturedChartData).toHaveLength(2);
  });

  it.each([
    ["authorization", Object.assign(new Error("unauthorized"), { status: 401 })],
    ["scope", new Error("organization scope mismatch")],
    [
      "validation",
      Object.assign(new Error("invalid cached payload"), {
        name: "BusinessPerformanceDataError",
      }),
    ],
  ])("blocks cached charts and tables for a %s error", (_kind, error) => {
    queryState.isError = true;
    queryState.error = error;

    const html = renderTrends([pnlRow("2024-02", 150)]);

    expect(html).not.toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).not.toContain("Bảng dữ liệu thay thế cho biểu đồ");
    expect(html).toContain("Không thể tải xu hướng tài chính");
    expect(html).toContain("Thử lại");
    expect(capturedChartData).toHaveLength(0);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["false", false],
    ["zero", 0],
    ["an empty string", ""],
  ])("fails closed when a cached query rejects with %s", (_kind, error) => {
    queryState.isError = true;
    queryState.error = error;

    const html = renderTrends([pnlRow("2024-02", 150)]);

    expect(html).toContain('role="alert"');
    expect(html).not.toContain('id="trend-data-table-title"');
    expect(capturedChartData).toHaveLength(0);
  });
});

describe("trend comparison deltas", () => {
  it("defines MoM, YoY, and the non-zero baseline rule in the comparison copy", () => {
    const html = renderTrends([pnlRow("2024-02", 150)]);

    expect(html).toContain(
      "MoM = kỳ hiện tại − kỳ trước; YoY = kỳ hiện tại − cùng tháng năm trước.",
    );
    expect(html).toContain(
      "Phần trăm chỉ hiển thị khi kỳ gốc có dữ liệu và khác 0.",
    );
  });

  it("keeps the absolute delta when the baseline is zero but omits the percent", () => {
    const comparison = buildBusinessPerformanceComparison(
      [pnlRow("2024-01", 0), pnlRow("2024-02", 150)],
      filters,
    );

    expect(
      absoluteDelta(
        comparison.revenue.current,
        comparison.revenue.previous,
      ),
    ).toBe(150);
    expect(comparison.revenue.momPct).toBeNull();
  });
});

describe("trend chart accessibility and missing data", () => {
  it("labels the chart fallback table and scopes every column and row header", () => {
    const html = renderTrends([pnlRow("2024-02", 150)]);
    const comparisonSection = html.slice(
      html.indexOf('id="comparison-table-title"'),
      html.indexOf('id="trend-data-table-title"'),
    );
    const tableSection = html.slice(html.indexOf('id="trend-data-table-title"'));

    expect(comparisonSection).toContain("<caption");
    expect(comparisonSection.match(/<th[^>]*scope="col"/g)).toHaveLength(8);
    expect(comparisonSection.match(/<th[^>]*scope="row"/g)).toHaveLength(4);
    expect(tableSection).toContain("<caption");
    expect(tableSection.match(/<th[^>]*scope="col"/g)).toHaveLength(6);
    expect(tableSection.match(/<th[^>]*scope="row"/g)).toHaveLength(13);
  });

  it("maps every visible legend dash and marker to its line without relying on color", () => {
    const html = renderTrends([pnlRow("2024-02", 150)]);

    expect(capturedChartProps).toHaveLength(2);
    expect(capturedChartProps.every((props) => props.accessibilityLayer === false)).toBe(true);

    const seriesKeys = ["revenue", "expense", "net", "marginPct", "expenseRatioPct"];
    seriesKeys.forEach((dataKey) => {
      const line = capturedLineProps.find((props) => props.dataKey === dataKey);
      const legendItem = getLegendItem(html, dataKey);
      const dashPattern = line?.strokeDasharray ?? "solid";
      const dotRadius = (line?.dot as { r?: number } | undefined)?.r;

      expect(line).toBeDefined();
      expect(legendItem).toBeDefined();
      expect(legendItem).toContain(`data-stroke-pattern="${dashPattern}"`);
      expect(legendItem).toContain(`data-dot-radius="${dotRadius}"`);
      expect(legendItem).toContain(`<circle cx="24" cy="6" r="${dotRadius}"`);
      if (dashPattern === "solid") {
        expect(legendItem).not.toContain("stroke-dasharray=");
      } else {
        expect(legendItem).toContain(`stroke-dasharray="${dashPattern}"`);
      }
    });

    const patternsFor = (keys: readonly string[]) =>
      keys.map((dataKey) =>
        capturedLineProps.find((props) => props.dataKey === dataKey)?.strokeDasharray ?? "solid",
      );
    expect(new Set(patternsFor(["revenue", "expense", "net"])).size).toBe(3);
    expect(new Set(patternsFor(["marginPct", "expenseRatioPct"])).size).toBe(2);

    const netLine = capturedLineProps.find((props) => props.dataKey === "net");
    const netLegendItem = getLegendItem(html, "net");
    expect(netLine?.stroke).toBe("hsl(var(--foreground))");
    expect(netLegendItem).toContain('stroke="hsl(var(--foreground))"');
    expect(netLegendItem).not.toContain("#334155");
  });

  it("scaffolds every absent month in the 13-month chart window as zero activity", () => {
    renderTrends([
      pnlRow("2023-02", 999, true),
      pnlRow("2024-01", 100),
      pnlRow("2024-02", 150),
    ]);

    expect(capturedChartData).toHaveLength(2);
    expect(capturedChartData[0]).toHaveLength(13);
    expect(capturedChartData[0].find((row) => row.month === "2023-02")).toEqual({
      month: "2023-02",
      label: "2/23",
      revenue: 0,
      expense: 0,
      net: 0,
      marginPct: null,
      expenseRatioPct: null,
    });
  });

  it("renders only zero-scaffolded rows and matching copy after a successful empty query", () => {
    const html = renderTrends([]);
    const trendTableSection = html.slice(html.indexOf('id="trend-data-table-title"'));

    expect(html).not.toContain("Chưa có dữ liệu xu hướng");
    expect(trendTableSection).toContain(
      "Tháng không có dòng lãi/lỗ được hiển thị bằng 0 cho doanh thu, chi phí và lợi nhuận",
    );
    expect(trendTableSection).not.toContain("Không có dữ liệu");
    expect(capturedChartData).toHaveLength(2);
    expect(capturedChartData[0]).toHaveLength(13);
    expect(capturedChartData[0].every((row) => !("available" in row))).toBe(true);
    expect(capturedChartData[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          month: "2024-02",
          revenue: 0,
          expense: 0,
          net: 0,
          marginPct: null,
          expenseRatioPct: null,
        }),
      ]),
    );
  });

  it("makes every horizontal chart and table scroller keyboard-focusable and labelled", () => {
    const html = renderTrends([pnlRow("2024-02", 150)]);
    const labels = [
      "money-trend-title",
      "ratio-trend-title",
      "comparison-table-title",
      "trend-data-table-title",
    ];

    expect(html).not.toContain("-mx-2");
    expect(html.match(/role="region"/g)).toHaveLength(4);
    labels.forEach((label) => {
      const region = getLabelledScrollRegion(html, label);

      expect(region).toBeDefined();
      expect(region).toContain('tabindex="0"');
      expect(region).toMatch(/class="[^"]*overflow-(?:x-)?auto[^"]*"/);
    });
  });
});
