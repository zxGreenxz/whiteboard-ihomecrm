import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getRepresentativeName: vi.fn(),
  getSessionUserId: vi.fn(),
  rpc: vi.fn(),
  toastError: vi.fn(),
  useQuery: vi.fn((options: unknown) => options),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: mocks.useQuery,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
  },
}));

vi.mock("@/lib/authSession", () => ({
  getSessionUserId: mocks.getSessionUserId,
}));

vi.mock("@/lib/contractCustomerHelpers", () => ({
  getRepresentativeName: mocks.getRepresentativeName,
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

import { useRecentActivities, useRevenueChart } from "../useDashboard";

const makeQueryBuilder = (initialRows: Array<Record<string, any>>) => {
  let rows = [...initialRows];
  let limit: number | null = null;
  const builder: Record<string, any> = {};

  builder.select = vi.fn(() => builder);
  builder.order = vi.fn(() => builder);
  builder.eq = vi.fn((column: string, value: unknown) => {
    rows = rows.filter((row) => row[column] === value);
    return builder;
  });
  builder.gt = vi.fn((column: string, value: number) => {
    rows = rows.filter((row) => Number(row[column]) > value);
    return builder;
  });
  builder.neq = vi.fn((column: string, value: unknown) => {
    rows = rows.filter((row) => row[column] !== value);
    return builder;
  });
  builder.gte = vi.fn((column: string, value: string) => {
    rows = rows.filter((row) => row[column] == null || String(row[column]) >= value);
    return builder;
  });
  builder.lte = vi.fn((column: string, value: string) => {
    rows = rows.filter((row) => row[column] == null || String(row[column]) <= value);
    return builder;
  });
  builder.in = vi.fn((column: string, values: unknown[]) => {
    rows = rows.filter((row) => values.includes(row[column]));
    return builder;
  });
  builder.limit = vi.fn((value: number) => {
    limit = value;
    return builder;
  });
  builder.range = vi.fn((from: number, to: number) => Promise.resolve({
    data: rows.slice(from, to + 1),
    error: null,
  }));
  builder.then = (
    onFulfilled: (value: { data: Array<Record<string, any>>; error: null }) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve({
    data: limit == null ? rows : rows.slice(0, limit),
    error: null,
  }).then(onFulfilled, onRejected);

  return builder;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-21T12:00:00Z"));
  vi.clearAllMocks();
  mocks.getSessionUserId.mockResolvedValue("user-1");
  mocks.getRepresentativeName.mockImplementation(
    (contract: { display_name?: string } | null | undefined, fallback: string) =>
      contract?.display_name ?? fallback,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dashboard money views", () => {
  it("gộp doanh thu theo tháng server-side qua RPC revenue_by_month (miễn nhiễm cap-1000)", async () => {
    // RPC aggregate server-side (20260726132000) thay đường fetchAllRows cũ —
    // signed refund (-200) vẫn phải cộng đúng dấu, tháng thiếu vẫn hiện 0.
    mocks.rpc.mockResolvedValue({
      data: [
        { month_start: "2026-06-01", revenue: 1001 },
        { month_start: "2026-07-01", revenue: -200 },
      ],
      error: null,
    });

    const query = useRevenueChart(2, "building-1") as unknown as {
      queryFn: () => Promise<Array<{ month: string; revenue: number }>>;
    };
    const chart = await query.queryFn();

    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("revenue_by_month", {
      p_start: "2026-06-01",
      p_end: "2026-07-31",
      p_building_id: "building-1",
    });
    expect(chart.find((row) => row.month === "06/2026")?.revenue).toBe(1001);
    expect(chart.find((row) => row.month === "07/2026")?.revenue).toBe(-200);
  });

  it("keeps credit-bearing cash and excludes non-cash CT from recent activity", async () => {
    const contractsBuilder = makeQueryBuilder([]);
    const receiptsBuilder = makeQueryBuilder([
      {
        id: "cash-receipt",
        invoice_id: "invoice-1",
        collected_amount: 500,
        payment_method: "TM",
        payment_date: "2026-07-20",
      },
      {
        id: "pure-credit-tm",
        invoice_id: "invoice-2",
        collected_amount: 750,
        applied_amount: 0,
        credit_amount: 750,
        payment_method: "TM",
        payment_date: "2026-07-20",
      },
      {
        id: "non-cash-offset",
        invoice_id: "invoice-3",
        collected_amount: 900,
        payment_method: "CT",
        payment_date: "2026-07-20",
      },
    ]);
    const invoicesBuilder = makeQueryBuilder([
      { id: "invoice-1", contract: { display_name: "Tenant A" } },
      { id: "invoice-2", contract: { display_name: "Tenant B" } },
      { id: "invoice-3", contract: { display_name: "Tenant C" } },
    ]);
    const issuesBuilder = makeQueryBuilder([]);

    mocks.from.mockImplementation((table: string) => {
      if (table === "contracts") return contractsBuilder;
      if (table === "active_payment_receipts") return receiptsBuilder;
      if (table === "invoices") return invoicesBuilder;
      if (table === "issues") return issuesBuilder;
      throw new Error(`Unexpected table: ${table}`);
    });

    const query = useRecentActivities() as unknown as {
      queryFn: () => Promise<Array<{
        id: string;
        type: string;
        description: string;
        amount?: number;
      }>>;
    };
    const activities = await query.queryFn();

    expect(receiptsBuilder.neq).toHaveBeenCalledWith("payment_method", "CT");
    expect(receiptsBuilder.gt).toHaveBeenCalledWith("collected_amount", 0);
    expect(receiptsBuilder.order).toHaveBeenCalledWith("payment_date", { ascending: false });
    expect(receiptsBuilder.order).toHaveBeenCalledWith("id", { ascending: true });
    expect(activities).toEqual([
      expect.objectContaining({
        id: "cash-receipt",
        type: "payment",
        description: "Tenant A",
        amount: 500,
      }),
      expect.objectContaining({
        id: "pure-credit-tm",
        type: "payment",
        description: "Tenant B",
        amount: 750,
      }),
    ]);
  });
});
