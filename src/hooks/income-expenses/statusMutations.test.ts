import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  invalidateQueries: vi.fn(),
  rpc: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  useMutation: vi.fn((options: unknown) => options),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: mocks.useMutation,
  useQueryClient: vi.fn(() => ({ invalidateQueries: mocks.invalidateQueries })),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import {
  useApproveVoucher,
  useCancelIncomeExpense,
  useUnapproveVoucher,
} from "./statusMutations";

type StatusMutation = {
  mutationFn: (id: string) => Promise<boolean>;
  onSuccess: (isTerminationForfeit: boolean) => void;
};

const FORFEIT_INVALIDATION_KEYS = [
  "income-expenses",
  "accounts-with-balance",
  "invoices",
  "invoices-legacy",
  "invoice",
  "invoice-history",
  "invoice-vouchers",
  "invoice-statistics",
  "invoice-totals-by-ids",
  "first-invoice-details",
  "invoice-collectors",
  "unpaid-invoices",
  "ie-related-invoice",
  "room-latest-invoice",
  "payments",
  "payments-summary",
  "invoice-payments-summary",
  "dashboard-summary",
  "dashboard-alerts",
  "recent-activities",
  "deposit-dashboard",
  "cash-book",
  "cash-book-summary",
  "cash-flow-by-day",
  "settlement-report",
  "financial-analysis",
  "reports",
  "monthly-building-profit",
  "profit-verification",
] as const;

const getInvalidatedRoots = () =>
  mocks.invalidateQueries.mock.calls.map(
    ([filters]) => (filters as { queryKey: readonly unknown[] }).queryKey[0],
  );

const mockVoucherRead = (result: {
  data: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}) => {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.maybeSingle = vi.fn().mockResolvedValue(result);
  mocks.from.mockReturnValue(builder);
  return builder;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockReset();
  mocks.rpc.mockReset();
});

describe("termination forfeit status rollout fallback", () => {
  it.each([
    {
      name: "PostgREST schema cache miss",
      error: {
        code: "PGRST202",
        message:
          "Could not find the function public.set_termination_forfeit_status_v1 in the schema cache",
      },
    },
    {
      name: "top-level PostgreSQL function-not-found",
      error: {
        code: "42883",
        message:
          "function public.set_termination_forfeit_status_v1(uuid, text) does not exist",
      },
    },
  ])("uses the existing approve flow for $name", async ({ error }) => {
    const voucherQuery = mockVoucherRead({
      data: { system_source: null, notes: "Phiếu nhập tay" },
      error: null,
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "set_termination_forfeit_status_v1") {
        return { data: null, error };
      }
      if (name === "approve_income_expense_v1") {
        return { data: null, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const mutation = useApproveVoucher() as unknown as StatusMutation;
    await expect(mutation.mutationFn("voucher-1")).resolves.toBe(false);

    expect(mocks.rpc).toHaveBeenNthCalledWith(
      1,
      "set_termination_forfeit_status_v1",
      { p_voucher_id: "voucher-1", p_status: "APPROVED" },
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "approve_income_expense_v1", {
      p_voucher_id: "voucher-1",
    });
    expect(mocks.from).toHaveBeenCalledWith("income_expenses");
    expect(voucherQuery.select).toHaveBeenCalledWith("system_source, notes");
    expect(voucherQuery.eq).toHaveBeenCalledWith("id", "voucher-1");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "canonical revenue source",
      data: { system_source: "termination.forfeit_revenue", notes: null },
    },
    {
      name: "canonical offset source",
      data: { system_source: "termination.forfeit_offset", notes: null },
    },
    {
      name: "reviewed legacy marker",
      data: {
        system_source: null,
        notes: "[CẤN CỌC BỎ CỌC contract-id] Bút toán nội bộ",
      },
    },
  ])("fails closed for a known forfeit with missing RPC: $name", async ({ data }) => {
    const rpcError = {
      code: "PGRST202",
      message:
        "Could not find the function public.set_termination_forfeit_status_v1 in the schema cache",
    };
    mockVoucherRead({ data, error: null });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: rpcError });

    const mutation = useApproveVoucher() as unknown as StatusMutation;
    await expect(mutation.mutationFn("forfeit-voucher")).rejects.toEqual(rpcError);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(rpcError.message);
  });

  it("fails closed when the voucher classification read fails", async () => {
    const rpcError = {
      code: "PGRST202",
      message:
        "Could not find the function public.set_termination_forfeit_status_v1 in the schema cache",
    };
    const readError = { code: "42501", message: "Voucher is not visible" };
    mockVoucherRead({ data: null, error: readError });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: rpcError });

    const mutation = useApproveVoucher() as unknown as StatusMutation;
    await expect(mutation.mutationFn("hidden-voucher")).rejects.toEqual(readError);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(readError.message);
  });

  it("fails closed when the voucher is missing or hidden by RLS", async () => {
    const rpcError = {
      code: "PGRST202",
      message:
        "Could not find the function public.set_termination_forfeit_status_v1 in the schema cache",
    };
    mockVoucherRead({ data: null, error: null });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: rpcError });

    const mutation = useApproveVoucher() as unknown as StatusMutation;
    await expect(mutation.mutationFn("unknown-voucher")).rejects.toEqual(rpcError);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(rpcError.message);
  });

  it("keeps ordinary vouchers on the existing approve flow", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "set_termination_forfeit_status_v1") {
        return {
          data: null,
          error: {
            code: "55000",
            message: "Voucher is not a termination forfeit pair",
          },
        };
      }
      if (name === "approve_income_expense_v1") {
        return { data: null, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const mutation = useApproveVoucher() as unknown as StatusMutation;
    await expect(mutation.mutationFn("ordinary-voucher")).resolves.toBe(false);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "permission denial",
      error: { code: "42501", message: "Forbidden" },
    },
    {
      name: "forfeit integrity failure",
      error: {
        code: "55000",
        message: "Termination forfeit payment integrity check failed",
      },
    },
    {
      name: "missing internal dependency",
      error: {
        code: "42883",
        message: "function app_private.require_termination_forfeit_payment_v1(uuid) does not exist",
      },
    },
  ])("fails closed for $name", async ({ error }) => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error });

    const mutation = useApproveVoucher() as unknown as StatusMutation;
    await expect(mutation.mutationFn("voucher-1")).rejects.toEqual(error);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(error.message);
  });
});

describe("termination forfeit status invalidations", () => {
  it.each([
    ["approve", "APPROVED", useApproveVoucher],
    ["unapprove", "UNAPPROVED", useUnapproveVoucher],
    ["cancel", "CANCELLED", useCancelIncomeExpense],
  ] as const)("refreshes invoice, payment, dashboard, and report data after %s", async (
    _name,
    status,
    useStatusMutation,
  ) => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });

    const mutation = useStatusMutation() as unknown as StatusMutation;
    const result = await mutation.mutationFn("forfeit-voucher");
    mutation.onSuccess(result);

    expect(result).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "set_termination_forfeit_status_v1",
      { p_voucher_id: "forfeit-voucher", p_status: status },
    );
    expect(getInvalidatedRoots()).toEqual(
      expect.arrayContaining([...FORFEIT_INVALIDATION_KEYS]),
    );
  });
});
