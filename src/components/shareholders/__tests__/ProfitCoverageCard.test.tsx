// @vitest-environment jsdom
// Khối "Tình trạng chốt LN Tháng × Toà" của tab Tổng quan (rà 21/10 F18/F20): trình bày đúng
// trạng thái ô, băng đối chiếu, LN chưa chốt và lý do rỗng — số liệu giả, tròn.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RegionQuery } from "@/components/errors/QueryRegion";
import type { ProfitOverviewCoverageData } from "@/hooks/useProfitOverviewCoverage";
import { buildProfitCoverage } from "@/lib/profitOverviewCoverage";
import { ProfitCoverageCard, ProfitCoverageMobile } from "../ProfitCoverageCard";

afterEach(cleanup);

const okQuery: RegionQuery = {
  data: [],
  status: "success",
  fetchStatus: "idle",
  isLoading: false,
  isError: false,
  error: null,
  dataUpdatedAt: 1,
  refetch: () => undefined,
};

const coverage = buildProfitCoverage({
  year: 2026,
  months: [9, 10],
  buildings: [
    { id: "b-a", name: "Toà A" },
    { id: "b-b", name: "Toà B" },
  ],
  snapshots: [
    { building_id: "b-a", period_month: "2026-09-01", status: "LOCKED", computed_profit: 1_000_000, adjusted_profit: 1_000_000 },
  ],
  accrual: [
    { month: "2026-09-01", building_id: "b-a", building_name: "Toà A", is_virtual: false, net: 1_200_000 },
    { month: "2026-09-01", building_id: "b-b", building_name: "Toà B", is_virtual: false, net: 500_000 },
    { month: "2026-10-01", building_id: "b-b", building_name: "Toà B", is_virtual: false, net: 300_000 },
    { month: "2026-09-01", building_id: "v", building_name: "Kho", is_virtual: true, net: -70_000 },
  ],
});

const data = (patch: Partial<ProfitOverviewCoverageData> = {}): ProfitOverviewCoverageData => ({
  coverage,
  months: [9, 10],
  today: { year: 2026, month: 10 },
  organizationSelected: true,
  hasBuildings: true,
  regionQueries: [okQuery],
  ...patch,
});

describe("ProfitCoverageCard (desktop)", () => {
  it("ma trận tháng × toà mang đúng trạng thái và các dòng đối chiếu có cơ sở", () => {
    render(<ProfitCoverageCard data={data()} year={2026} monthFilter={null} />);
    const card = screen.getByTestId("profit-coverage");
    expect(within(card).getByText(/Cơ sở: dồn tích theo kỳ phân bổ · chỉ phiếu đã duyệt · chỉ KQKD/)).toBeTruthy();
    const statuses = Array.from(card.querySelectorAll("[data-status]")).map((el) => el.getAttribute("data-status"));
    // T9: A chốt nhưng nguồn đổi, B chưa chốt · T10: A không phát sinh, B chưa chốt
    expect(statuses).toEqual(["LOCKED_CHANGED", "OPEN", "EMPTY", "OPEN"]);
    expect(within(card).getByText(/^Đã chốt 1 toà·tháng \(1 toà\): LN chốt .* · LN hiện tại .* · lệch \+/)).toBeTruthy();
    expect(within(card).getByText(/^LN chưa chốt \(ước tính, trước chia\): .* · 1 toà·tháng · T10 đang chạy/)).toBeTruthy();
    expect(within(card).getByText(/^Chi phí chung ở toà ảo — không vào chia LN: −/)).toBeTruthy();
    expect(within(card).getByLabelText(/Toà A · T9: đã chốt nhưng nguồn đã đổi/)).toBeTruthy();
  });

  it("chưa chọn công ty / chưa tới kỳ / công ty không có toà ⇒ nói rõ, không vẽ số", () => {
    const { rerender } = render(
      <ProfitCoverageCard data={data({ organizationSelected: false, coverage: null })} year={2026} monthFilter={null} />,
    );
    expect(screen.getByText("Chọn công ty để xem tình trạng chốt theo toà.")).toBeTruthy();
    rerender(<ProfitCoverageCard data={data({ months: [], coverage: null })} year={2027} monthFilter={null} />);
    expect(screen.getByText("Chưa tới kỳ nào của năm 2027 để chốt.")).toBeTruthy();
    rerender(<ProfitCoverageCard data={data({ hasBuildings: false, coverage: null })} year={2026} monthFilter={null} />);
    expect(screen.getByText("Công ty đang chọn chưa có toà nào.")).toBeTruthy();
    expect(screen.queryByText(/LN chưa chốt/)).toBeNull();
  });
});

describe("ProfitCoverageMobile", () => {
  it("mỗi tháng một dòng đếm, có dòng LN chưa chốt", () => {
    render(<ProfitCoverageMobile data={data()} year={2026} monthFilter={null} />);
    const card = screen.getByTestId("profit-coverage-mobile");
    expect(within(card).getByLabelText("1 toà chốt nhưng nguồn đã đổi")).toBeTruthy();
    expect(within(card).getAllByLabelText(/toà chưa chốt/)).toHaveLength(2);
    expect(within(card).getByText(/^LN chưa chốt \(ước tính, trước chia\)/)).toBeTruthy();
  });
});
