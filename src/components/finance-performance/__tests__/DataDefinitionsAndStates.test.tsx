// @vitest-environment node

import { readFileSync } from "node:fs";
import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";
import type { BusinessPerformanceFilters } from "@/lib/businessPerformance";
import { DataDefinitionsTab } from "../DataDefinitionsTab";
import { FinanceQueryError } from "../FinanceDataState";

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

function renderDefinitions(
  basis: BusinessPerformanceFilters["basis"],
  overrides: Partial<BusinessPerformanceFilters> = {},
) {
  return renderToStaticMarkup(
    createElement(DataDefinitionsTab, {
      filters: { ...baseFilters, basis, ...overrides },
    }),
  );
}

function renderDefinitionText(basis: BusinessPerformanceFilters["basis"]) {
  return renderDefinitions(basis).replace(/<[^>]+>/g, "");
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | null {
  if (!isValidElement(node)) return null;
  if (predicate(node)) return node;

  for (const child of Children.toArray(
    (node.props as { children?: ReactNode }).children,
  )) {
    const match = findElement(child, predicate);
    if (match) return match;
  }

  return null;
}

describe("DataDefinitionsTab", () => {
  it("documents the complete ACCRUAL precedence rules", () => {
    const text = renderDefinitionText("ACCRUAL");

    expect(text).toContain("invoices.billing_month");
    expect(text).toContain("không theo ngày thu tiền");
    expect(text).toContain("phân bổ đều theo tháng");
    expect(text).toContain("start_date");
    expect(text).toContain("end_date");
    expect(text).toContain("không có kỳ áp dụng");
    expect(text).toContain("voucher_date");
  });

  it("defines VOUCHER_DATE as a reconciliation date rather than cash settlement", () => {
    const text = renderDefinitionText("VOUCHER_DATE");

    expect(text).toContain("toàn bộ giá trị vào tháng của voucher_date");
    expect(text).toContain("mốc hạch toán và đối chiếu nghiệp vụ");
    expect(text).toContain("không xác nhận thời điểm thực nhận, thực chi");
  });

  it("lists only the active standalone MVP report sources", () => {
    const accrualHtml = renderDefinitions("ACCRUAL");
    const voucherHtml = renderDefinitions("VOUCHER_DATE");
    const expectedSources = [
      "business_performance_organizations_v1",
      "business_performance_pnl_v1",
      "business_performance_snapshot_v1",
      "business_performance_occupancy_snapshot_v1",
      "business_performance_upcoming_vacancy_v1",
      "business_performance_occupancy_monthly_v1",
      "business_performance_inventory_history_v1",
      "business_performance_reporting_roles_v1",
      "business_performance_break_even_v1",
      "business_performance_invoice_cohort_v1",
      "business_performance_cash_received_v1",
      "business_performance_category_breakdown_v1",
    ];

    for (const protectedSource of expectedSources) {
      expect(accrualHtml).toContain(protectedSource);
      expect(voucherHtml).toContain(protectedSource);
    }
    for (const html of [accrualHtml, voucherHtml]) {
      const uniqueSources = [
        ...new Set(
          html.match(/business_performance_[a-z0-9_]+_v1/g) ?? [],
        ),
      ].sort();

      expect(uniqueSources).toEqual([...expectedSources].sort());
    }
    for (const legacyDelegate of [
      "fa_monthly_pnl_accrual",
      "fa_monthly_pnl",
      "fa_snapshot_kpis",
      "occupancy_snapshot_v2",
      "occupancy_upcoming_vacancy_v2",
      "fa_occupancy_monthly",
      "fa_type_breakdown",
    ]) {
      expect(accrualHtml).not.toContain(legacyDelegate);
      expect(voucherHtml).not.toContain(legacyDelegate);
    }
  });

  it("explains organization and exact building authorization for the RPC scope", () => {
    const text = renderDefinitionText("ACCRUAL");

    expect(text).toContain("organization_id");
    expect(text).toContain("building_ids");
    expect(text).toContain("Mọi building_id được yêu cầu");
    expect(text).toContain("tổ chức đã chọn");
    expect(text).toContain("danh sách tòa vật lý được cấp quyền");
    expect(text).toContain("toàn bộ yêu cầu bị từ chối");
  });

  it("documents the delivered snapshot, break-even, cohort and category contracts", () => {
    const html = renderDefinitions("ACCRUAL");

    expect(html).toContain("generated_at");
    expect(html).toContain("không phải doanh thu thực tế đã mất");
    expect(html).toContain("Hòa vốn chỉ trả tỷ lệ khi");
    expect(html).toContain("Cohort hóa đơn tách");
    expect(html).toContain("Cơ cấu Thu/Chi theo hạng mục dùng RPC");
    expect(html).not.toContain("được ẩn cho đến khi");
  });
  it("uses non-assertive notes for static advisories at a UTC month boundary", () => {
    const originalTimeZone = process.env.TZ;
    process.env.TZ = "UTC";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T18:30:00.000Z"));

    try {
      const html = renderDefinitions("ACCRUAL", {
        month: "2026-08",
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
      });

      expect(html.match(/role="note"/g)).toHaveLength(2);
      expect(html).not.toContain('role="alert"');
    } finally {
      vi.useRealTimers();
      if (originalTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimeZone;
      }
    }
  });
});

describe("FinanceQueryError", () => {
  it("never renders raw backend diagnostics", () => {
    const rawDiagnostic =
      'permission denied for relation income_expenses; SQLSTATE 42501; hint="service_role"';
    const html = renderToStaticMarkup(
      createElement(FinanceQueryError, {
        error: {
          code: "42501",
          message: rawDiagnostic,
          details: "select * from private.income_expenses",
        },
        onRetry: vi.fn(),
      }),
    );

    expect(html).toContain("Bạn không có quyền xem phạm vi dữ liệu này");
    expect(html).not.toContain(rawDiagnostic);
    expect(html).not.toContain("private.income_expenses");
    expect(html).not.toContain("service_role");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('role="note"');
  });

  it("provides an accessible retry button and invokes the callback", () => {
    const onRetry = vi.fn();
    const tree = FinanceQueryError({ error: new Error("timeout"), onRetry });
    const retryButton = findElement(tree, (element) => element.type === Button);
    const html = renderToStaticMarkup(tree);

    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain("Thử lại");
    expect(retryButton).not.toBeNull();
    expect(retryButton?.props.children[0].props["data-icon"]).toBe(
      "inline-start",
    );

    retryButton?.props.onClick();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("finance performance component composition", () => {
  it.each(["../DataDefinitionsTab.tsx", "../FinanceDataState.tsx"])(
    "uses gap-based layout instead of space utilities in %s",
    (relativePath) => {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");

      expect(source).not.toMatch(/\bspace-[xy]-/);
    },
  );
});
