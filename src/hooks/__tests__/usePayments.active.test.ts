import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getSessionUser: vi.fn(),
  useMutation: vi.fn(),
  useQuery: vi.fn((options: unknown) => options),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: mocks.useMutation,
  useQuery: mocks.useQuery,
  useQueryClient: mocks.useQueryClient,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mocks.from },
}));

vi.mock("@/lib/authSession", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { usePayments, usePaymentsSummary } from "../usePayments";

const makeQueryBuilder = (initialRows: Array<Record<string, unknown>>) => {
  let rows = [...initialRows];
  const builder: Record<string, any> = {};

  for (const method of ["select", "order", "gte", "lte", "eq"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.is = vi.fn((column: string, value: unknown) => {
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
  builder.range = vi.fn((from: number, to: number) => Promise.resolve({
    data: rows.slice(from, to + 1),
    error: null,
  }));
  builder.then = (
    onFulfilled: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);

  return builder;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: "user-1" });
});

describe("active payment queries", () => {
  it("paginates the full list and excludes reversed payments", async () => {
    const activeRows = Array.from(
      { length: 1001 },
      (_, index): Record<string, unknown> => ({
        id: `active-${index}`,
        payment_date: "2026-07-01",
        reversed_at: null,
      }),
    );
    const builder = makeQueryBuilder([
      ...activeRows,
      { id: "reversed", reversed_at: "2026-07-21T00:00:00Z" },
    ]);
    mocks.from.mockReturnValue(builder);

    const query = usePayments() as unknown as {
      queryFn: () => Promise<Array<{ id: string }>>;
    };
    const rows = await query.queryFn();

    expect(mocks.from).toHaveBeenCalledWith("payments");
    expect(builder.is).toHaveBeenCalledWith("reversed_at", null);
    expect(builder.order).toHaveBeenCalledWith("payment_date", { ascending: false });
    expect(builder.order).toHaveBeenCalledWith("id", { ascending: true });
    expect(builder.range).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(1001);
    expect(rows.some((row) => row.id === "reversed")).toBe(false);
  });

  it("includes credit-bearing cash tenders and excludes non-cash CT", async () => {
    const collectedRows = Array.from({ length: 1000 }, (_, index) => ({
      id: `receipt-${index}`,
      collected_amount: 1,
      payment_method: "TM",
      payment_date: "2026-07-01",
    }));
    const builder = makeQueryBuilder([
      ...collectedRows,
      {
        id: "pure-credit-tm",
        collected_amount: 900,
        applied_amount: 0,
        credit_amount: 900,
        payment_method: "TM",
        payment_date: "2026-07-02",
      },
      {
        id: "non-cash-offset",
        collected_amount: 700,
        payment_method: "CT",
        payment_date: "2026-07-03",
      },
    ]);
    mocks.from.mockReturnValue(builder);

    const query = usePaymentsSummary("2026-07-01", "2026-07-31") as unknown as {
      queryFn: () => Promise<{
        total: number;
        count: number;
        byMethod: Record<string, number>;
      }>;
    };
    const summary = await query.queryFn();

    expect(mocks.from).toHaveBeenCalledWith("active_payment_receipts");
    expect(builder.neq).toHaveBeenCalledWith("payment_method", "CT");
    expect(builder.gt).toHaveBeenCalledWith("collected_amount", 0);
    expect(builder.order).toHaveBeenCalledWith("payment_date", { ascending: true });
    expect(builder.order).toHaveBeenCalledWith("id", { ascending: true });
    expect(builder.range).toHaveBeenCalledTimes(3);
    expect(summary).toEqual({
      total: 1900,
      count: 1001,
      byMethod: { TM: 1900 },
    });
  });
});
