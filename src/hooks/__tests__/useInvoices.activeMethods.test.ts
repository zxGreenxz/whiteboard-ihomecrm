import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getSessionUser: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: vi.fn(),
  useQuery: vi.fn(),
  useQueryClient: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
  },
}));

vi.mock("@/lib/authSession", () => ({
  getSessionUser: mocks.getSessionUser,
}));

import { invoicesListQuery } from "../useInvoices";

function makeInvoiceBuilder(rows: Array<Record<string, unknown>>, count = rows.length) {
  const builder: Record<string, any> = {};
  for (const method of [
    "select",
    "is",
    "order",
    "eq",
    "neq",
    "not",
    "in",
    "gte",
    "lte",
    "or",
    "range",
  ]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (
    onFulfilled: (value: { data: typeof rows; error: null; count: number }) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve({ data: rows, error: null, count }).then(onFulfilled, onRejected);
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: "user-1" });
});

describe("invoice payment-method drill-down", () => {
  it("filters with the active-receipt SETOF RPC and enriches page methods", async () => {
    const invoiceBuilder = makeInvoiceBuilder([
      {
        id: "invoice-1",
        payments: [
          { id: "active", payment_method: "TK", reversed_at: null },
          { id: "reversed", payment_method: "TM", reversed_at: "2026-07-21T00:00:00Z" },
        ],
      },
    ]);

    mocks.rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "invoice_payment_method_drilldown") {
        expect(args).toEqual({ p_payment_method: "TM" });
        return invoiceBuilder;
      }
      if (name === "invoice_active_payment_methods") {
        expect(args).toEqual({ p_invoice_ids: ["invoice-1"] });
        return Promise.resolve({
          data: [{ invoice_id: "invoice-1", payment_methods: ["TK", "TM"] }],
          error: null,
        });
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const query = invoicesListQuery(
      { payment_method: "TM" },
      { page: 1, pageSize: 20 },
    );
    const result = await query.queryFn();

    expect(mocks.from).not.toHaveBeenCalledWith("invoices");
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "invoice_payment_method_drilldown", {
      p_payment_method: "TM",
    });
    expect(invoiceBuilder.eq).not.toHaveBeenCalledWith("payments.payment_method", "TM");
    expect(invoiceBuilder.range).toHaveBeenCalledWith(0, 19);
    expect(result.data[0]).toMatchObject({
      id: "invoice-1",
      active_payment_methods: ["TK", "TM"],
      payments: [{ id: "active", payment_method: "TK", reversed_at: null }],
    });
  });
});
