// @vitest-environment node

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BusinessPerformanceFilters, BusinessPerformanceSnapshotRow } from "@/lib/businessPerformance";
import type {
  BusinessPerformanceCashReceivedRow,
  BusinessPerformanceInvoiceCohortRow,
} from "@/hooks/reports/useBusinessPerformanceGatedData";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  cohort: vi.fn(),
  cash: vi.fn(),
}));

vi.mock("@/hooks/reports/useBusinessPerformance", () => ({
  useBusinessPerformanceSnapshot: mocks.snapshot,
  useBusinessPerformanceInvoiceCohort: mocks.cohort,
  useBusinessPerformanceCashReceived: mocks.cash,
}));

import { CollectionsDebtTab } from "../CollectionsDebtTab";

const filters: BusinessPerformanceFilters = {
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

const zeroReceivableSnapshot: BusinessPerformanceSnapshotRow = {
  building_id: "building-a",
  building_name: "Building A",
  total_rooms: 3,
  rooms_available: 1,
  rooms_occupied: 2,
  rooms_reserved: 0,
  rooms_maintenance: 0,
  rooms_unavailable: 0,
  vacancy_loss_month: 0,
  active_contracts: 2,
  avg_rent: 5_000_000,
  deposit_held: 4_000_000,
  receivable_total: 0,
  aging_not_due: 0,
  aging_1_30: 0,
  aging_31_60: 0,
  aging_61_90: 0,
  aging_over_90: 0,
};

function query(data: BusinessPerformanceSnapshotRow[]) {
  return {
    data,
    error: null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
}

function dataQuery<T>(data: T[]) {
  return {
    data,
    error: null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
}

const cohortRow: BusinessPerformanceInvoiceCohortRow = {
  building_id: "building-a",
  building_name: "Building A",
  cohort_month: "2024-02-01",
  cohort_available: true,
  billed_current_charge: 10_000_000,
  collected_current_charge: 7_500_000,
  remaining_current_charge: 2_500_000,
  collection_rate_pct: 75,
  invoice_count: 3,
  allocation_unknown_count: 0,
  allocation_unknown_amount: 0,
  component_anomaly_count: 0,
  carried_invoice_debt: 1_000_000,
  carried_deposit_debt: 0,
  current_deposit: 2_000_000,
  draft_pending_count: 1,
  draft_pending_amount: 3_000_000,
  settlement_count: 0,
  settlement_amount: 0,
  generated_at: "2024-02-29T00:00:00.000Z",
};

const cashRow: BusinessPerformanceCashReceivedRow = {
  building_id: "building-a",
  building_name: "Building A",
  cash_month: "2024-02-01",
  cash_received: 8_250_000,
  payment_event_count: 4,
  first_payment_date: "2024-02-02",
  last_payment_date: "2024-02-27",
  generated_at: "2024-02-29T00:00:00.000Z",
};

const cachedSnapshotMarker = "Cọc đang giữ";

function renderCollections() {
  return renderToStaticMarkup(
    createElement(CollectionsDebtTab, { filters }),
  );
}

describe("CollectionsDebtTab responsive and table semantics", () => {
  beforeEach(() => {
    mocks.snapshot.mockReset();
    mocks.cohort.mockReset();
    mocks.cash.mockReset();
    mocks.snapshot.mockReturnValue(query([zeroReceivableSnapshot]));
    mocks.cohort.mockReturnValue(dataQuery([cohortRow]));
    mocks.cash.mockReturnValue(dataQuery([cashRow]));
  });

  it("shows invoice cohort separately from factual cash received", () => {
    const html = renderCollections();

    expect(html).toContain("Hóa đơn phát hành theo cohort");
    expect(html).toContain("Tiền thực thu trong tháng");
    expect(html).toContain("10.000.000");
    expect(html).toContain("7.500.000");
    expect(html).toContain("8.250.000");
    expect(html).toContain("75,0%");
    expect(html).toContain("Nợ chuyển tiếp");
    expect(html).toContain("Cọc kỳ này");
  });

  it("fails cohort closed while keeping actual cash visible", () => {
    mocks.cohort.mockReturnValue(
      dataQuery([
        {
          ...cohortRow,
          cohort_available: false,
          billed_current_charge: null,
          collected_current_charge: null,
          remaining_current_charge: null,
          collection_rate_pct: null,
          allocation_unknown_count: 1,
          allocation_unknown_amount: 4_000_000,
        },
      ]),
    );

    const html = renderCollections();

    expect(html).toContain("Thiếu phân bổ thành phần: 4.000.000");
    expect(html).toContain("8.250.000");
    expect(html).not.toContain("Tỷ lệ thu cohort</span><span>0");
  });

  it("uses one summary column below the small breakpoint", () => {
    const html = renderCollections();

    expect(html).toContain(
      'class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"',
    );
    expect(html).not.toContain("col-span-2 sm:col-span-1");
  });

  it("scopes the aging table column headers and row labels", () => {
    const html = renderCollections();
    const captionIndex = html.indexOf("Bảng giá trị và tỷ trọng các bucket tuổi nợ hiện tại");
    const tableStart = html.lastIndexOf("<table", captionIndex);
    const tableSection = html.slice(tableStart, html.indexOf("</table>", captionIndex));

    expect(tableSection.match(/<th[^>]*scope="col"/g)).toHaveLength(3);
    expect(tableSection.match(/<th[^>]*scope="row"/g)).toHaveLength(6);
  });

  it("keeps live snapshot, ACTIVE, and zero-denominator semantics", () => {
    const html = renderCollections();
    const captionIndex = html.indexOf("Bảng giá trị và tỷ trọng các bucket tuổi nợ hiện tại");
    const tableStart = html.lastIndexOf("<table", captionIndex);
    const tableSection = html.slice(tableStart, html.indexOf("</table>", captionIndex));

    expect(mocks.snapshot).toHaveBeenCalledOnce();
    expect(mocks.snapshot).toHaveBeenCalledWith(
      filters.organizationId,
      filters.buildingIds,
    );
    expect(html.match(/ACTIVE/g)).toHaveLength(4);
    expect(tableSection.match(/<td[^>]*>\u2014<\/td>/g)).toHaveLength(6);
  });

  it("reserves alerts for query failures while rendering the persistent caveat as a note", () => {
    const successHtml = renderCollections();

    expect(successHtml.match(/role="note"/g)).toHaveLength(1);
    expect(successHtml).not.toContain('role="alert"');

    mocks.snapshot.mockReturnValue({
      data: undefined,
      error: new Error("network failure"),
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });

    const errorHtml = renderCollections();

    expect(errorHtml.match(/role="note"/g)).toHaveLength(1);
    expect(errorHtml.match(/role="alert"/g)).toHaveLength(1);
  });

  it("keeps cached snapshot data visible with a stale warning after a transient refetch error", () => {
    mocks.snapshot.mockReturnValue({
      ...query([zeroReceivableSnapshot]),
      error: new Error("network timeout"),
      isError: true,
    });

    const html = renderCollections();

    expect(html).toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).toContain("Thử lại");
    expect(html).toContain(cachedSnapshotMarker);
    expect(html).not.toContain("Không thể tải công nợ hiện tại");
  });

  it.each([
    ["authentication", Object.assign(new Error("Unauthorized"), { status: 401 })],
    ["scope", new Error("building scope mismatch")],
    ["validation", Object.assign(new Error("invalid snapshot row"), { name: "ValidationError" })],
  ])("hides cached snapshot data for a blocking %s error", (_kind, error) => {
    mocks.snapshot.mockReturnValue({
      ...query([zeroReceivableSnapshot]),
      error,
      isError: true,
    });

    const html = renderCollections();

    expect(html).not.toContain("Dữ liệu đang hiển thị có thể đã cũ");
    expect(html).not.toContain(cachedSnapshotMarker);
    expect(html).toContain("Không thể tải công nợ hiện tại");
    expect(html).toContain("Thử lại");
  });
});
