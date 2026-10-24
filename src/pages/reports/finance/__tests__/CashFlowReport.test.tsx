// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

type Period = {
  organization_id: string; building_id: string; period: string;
  income: number; expense: number; net: number;
};
type QueryFixture = {
  data: Period[] | undefined;
  status: "success" | "error" | "pending";
  fetchStatus: "idle" | "fetching";
  isLoading: boolean; isError: boolean; error: unknown;
  refetch: ReturnType<typeof vi.fn>;
};
const h = vi.hoisted(() => ({
  query: {} as QueryFixture,
  useCashFlowReport: vi.fn(),
  chart: [] as Array<{ month: number; income: number; expense: number; net: number }>,
  buildingOptions: [] as Array<{ value: string; label: string }>,
  organizationId: "org-a",
  persistedBuildingId: "all",
  buildingValue: "all",
  buildingsStatus: "success" as "success" | "error" | "pending",
}));
vi.mock("@/components/layout/MainLayout", () => ({ default: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("react-router-dom", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("@/contexts/OrganizationContext", () => ({ useOrganization: () => ({ selectedOrganizationId: h.organizationId }) }));
vi.mock("@/hooks/usePersistedState", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return { usePersistedState: (key: string) => React.useState(key.endsWith(":year") ? 2026 : h.persistedBuildingId) };
});
vi.mock("@/hooks/useCashFlowReport", () => ({ useCashFlowReport: h.useCashFlowReport }));
vi.mock("@/hooks/useBuildings", () => ({
  useBuildings: () => ({
    data: [
      { id: "building-a", name: "Tòa A", organization_id: "org-a" },
      { id: "building-b", name: "Tòa B", organization_id: "org-b" },
      { id: "building-demo", name: "Tòa DEMO", organization_id: "org-demo" },
    ],
    status: h.buildingsStatus,
    fetchStatus: h.buildingsStatus === "pending" ? "fetching" : "idle",
    isLoading: h.buildingsStatus === "pending", isError: h.buildingsStatus === "error",
    error: h.buildingsStatus === "error" ? new Error("buildings unavailable") : null,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: (props: { value: string; placeholder?: string; options: Array<{ value: string; label: string }> }) => {
    if (props.placeholder === "Chọn tòa nhà") { h.buildingOptions = props.options; h.buildingValue = props.value; }
    return null;
  },
}));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => children,
  BarChart: ({ data }: { data: typeof h.chart }) => { h.chart = data; return <div data-testid="cash-flow-chart" />; },
  Bar: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, Legend: () => null,
}));

import CashFlowReport from "../CashFlowReport";

const money = (value: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(value);
const fixture = (period: string, income: number, expense: number, building = "building-a"): Period => ({
  organization_id: "org-a", building_id: building, period, income, expense, net: income - expense,
});
beforeEach(() => {
  h.query = { data: [], status: "success", fetchStatus: "idle", isLoading: false, isError: false, error: null, refetch: vi.fn() };
  h.useCashFlowReport.mockReset().mockImplementation(() => h.query);
  h.chart = [];
  h.buildingOptions = [];
  h.organizationId = "org-a";
  h.persistedBuildingId = "all";
  h.buildingValue = "all";
  h.buildingsStatus = "success";
});
afterEach(cleanup);

it("maps months and totals each quarter/year once even when RPC includes quarter aggregates", () => {
  h.query.data = [
    fixture("2026-07", 120, 20),
    fixture("2026-07", 30, 10, "building-b"),
    fixture("2026-08", 80, 15),
    fixture("2026-09", 40, 5),
    fixture("2026-Q3", 240, 40),
    fixture("2026-Q3", 30, 10, "building-b"),
    fixture("2026-10", 10, 2),
    fixture("2026-Q4", 10, 2),
  ];
  render(<CashFlowReport />);
  expect(h.useCashFlowReport).toHaveBeenCalledWith(2026, undefined, { enabled: true });
  expect(h.chart).toHaveLength(12);
  expect(h.chart[6]).toMatchObject({ month: 7, income: 150, expense: 30, net: 120 });
  expect(h.chart[7]).toMatchObject({ month: 8, income: 80, expense: 15, net: 65 });
  expect(h.chart[8]).toMatchObject({ month: 9, income: 40, expense: 5, net: 35 });
  const quarter = screen.getByText("III").closest("tr");
  expect(quarter).not.toBeNull();
  expect(within(quarter!).getAllByRole("cell").slice(1, 4).map((cell) => cell.textContent))
    .toEqual([270, 50, 220].map(money));
  const year = screen.getByText("Cả năm").closest("tr");
  expect(within(year!).getAllByRole("cell").slice(1, 4).map((cell) => cell.textContent))
    .toEqual([280, 52, 228].map(money));
});

it("labels cash receipts and limits building options to the selected organization", () => {
  render(<CashFlowReport />);
  expect(screen.getAllByRole("columnheader", { name: "Thu vào" })).toHaveLength(2);
  expect(screen.getAllByRole("columnheader", { name: "Chi ra" })).toHaveLength(2);
  expect(screen.getAllByRole("columnheader", { name: "Chênh lệch" })).toHaveLength(2);
  expect(screen.queryByText("Doanh thu")).toBeNull();
  expect(screen.getByText(/Tiền cọc thực nhận vẫn được tính vào thu/)).toBeTruthy();
  expect(h.buildingOptions).toEqual([{ value: "all", label: "Tất cả tòa nhà" }, { value: "building-a", label: "Tòa A" }]);
});

it("keeps source errors visible instead of rendering an empty financial report", () => {
  h.query = { ...h.query, data: undefined, status: "error", isError: true, error: { code: "42501", message: "denied" } };
  render(<CashFlowReport />);
  expect(screen.getByRole("alert").textContent).toContain("Chưa tải được báo cáo dòng tiền");
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByTestId("cash-flow-chart")).toBeNull();
  expect(screen.getByRole("button", { name: "Tải lại" })).toBeTruthy();
});

it("keeps pending data behind the loading state", () => {
  h.query = { ...h.query, data: undefined, status: "pending", fetchStatus: "fetching", isLoading: true };
  render(<CashFlowReport />);
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByTestId("cash-flow-chart")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("clears a persisted building from DEMO without requesting it for the selected organization", () => {
  h.persistedBuildingId = "building-demo";
  render(<CashFlowReport />);
  expect(h.buildingValue).toBe("all");
  expect(h.useCashFlowReport.mock.calls.every((call) => call[1] === undefined && call[2].enabled === true)).toBe(true);
});

it("does not send the previous organization's building during an organization switch", () => {
  h.persistedBuildingId = "building-a";
  const view = render(<CashFlowReport />);
  expect(h.useCashFlowReport).toHaveBeenLastCalledWith(2026, "building-a", { enabled: true });
  h.useCashFlowReport.mockClear();
  h.organizationId = "org-b";
  view.rerender(<CashFlowReport />);
  expect(h.buildingValue).toBe("all");
  expect(h.useCashFlowReport.mock.calls.every((call) => call[1] === undefined && call[2].enabled === true)).toBe(true);
  expect(h.buildingOptions).toEqual([{ value: "all", label: "Tất cả tòa nhà" }, { value: "building-b", label: "Tòa B" }]);
});

it.each(["pending", "error"] as const)("preserves the building choice and waits when the building source is %s", (status) => {
  h.persistedBuildingId = "building-demo";
  h.buildingsStatus = status;
  const view = render(<CashFlowReport />);
  expect(h.buildingValue).toBe("building-demo");
  expect(h.useCashFlowReport).toHaveBeenLastCalledWith(2026, undefined, { enabled: false });
  h.buildingsStatus = "success";
  view.rerender(<CashFlowReport />);
  expect(h.buildingValue).toBe("all");
  expect(h.useCashFlowReport).toHaveBeenLastCalledWith(2026, undefined, { enabled: true });
});
