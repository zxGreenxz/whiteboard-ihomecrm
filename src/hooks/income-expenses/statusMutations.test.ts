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

describe("huỷ duyệt phiếu — CAS approval_version (H3.2)", () => {
  // unapprove_voucher giờ khoá dòng và so approval_version. Trang gọi hook chỉ
  // đưa được `id` (IncomeExpensePage.tsx:585), nên chính hook phải đọc phiên
  // bản hiện tại rồi gửi kèm — đọc-rồi-CAS, chứ không phải ghi mù.
  it("đọc approval_version rồi gửi kèm khi huỷ duyệt", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "set_termination_forfeit_status_v1") {
        return { data: null, error: { code: "PGRST202", message: "not found" } };
      }
      if (name === "unapprove_voucher") return { data: null, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    // Cùng một builder phục vụ HAI lần đọc: phân loại phiếu thường
    // (system_source/notes) rồi mới tới approval_version.
    const voucherQuery = mockVoucherRead({
      data: { system_source: null, notes: null, approval_version: 7 },
      error: null,
    });

    const mutation = useUnapproveVoucher() as unknown as StatusMutation;
    await expect(mutation.mutationFn("voucher-9")).resolves.toBe(false);

    expect(voucherQuery.select).toHaveBeenCalledWith("approval_version");
    expect(voucherQuery.eq).toHaveBeenCalledWith("id", "voucher-9");
    expect(mocks.rpc).toHaveBeenCalledWith("unapprove_voucher", {
      voucher_id: "voucher-9",
      p_expected_approval_version: 7,
    });
  });

  it("đọc không ra phiên bản thì gửi null — server bỏ qua CAS, KHÔNG tự bịa số", async () => {
    // Bịa `?? 1` ở client tệ hơn là không CAS: nó biến một phép SO thành một
    // lời KHẲNG ĐỊNH sai, và lần đầu tiên nó sai đúng là lúc phiếu đã bị người
    // khác động vào (approval_version > 1) — tức đúng lúc CAS phải bắt.
    //
    // Phép thử này chạy ĐƯỜNG THẬT thay vì đọc mã nguồn tìm chuỗi `?? 1`: bản
    // grep cũ vẫn xanh khi đổi nhánh dự phòng thành `: 1` (đo bằng
    // scripts/dot-bien.mjs), vì con số bịa không nhất thiết viết bằng `??`.
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "set_termination_forfeit_status_v1") {
        return { data: null, error: { code: "PGRST202", message: "not found" } };
      }
      if (name === "unapprove_voucher") return { data: null, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    // Phiếu thường (system_source/notes rỗng) nhưng cột phiên bản không đọc ra
    // số — đúng thế của một phiếu cũ chưa có approval_version, hoặc của một
    // dòng bị RLS giấu bớt cột.
    mockVoucherRead({
      data: { system_source: null, notes: null, approval_version: null },
      error: null,
    });

    const mutation = useUnapproveVoucher() as unknown as StatusMutation;
    await expect(mutation.mutationFn("voucher-9")).resolves.toBe(false);

    expect(mocks.rpc).toHaveBeenCalledWith("unapprove_voucher", {
      voucher_id: "voucher-9",
      // Đọc không ra phiên bản ⇒ BỎ tham số (server dùng DEFAULT NULL), không
      // gửi null: tham số có DEFAULT nên types.ts khai optional. Cùng một nhánh
      // trong thân hàm, chỉ khác ở chỗ tsc kiểm được.
      p_expected_approval_version: undefined,
    });
  });

  it("lệch phiên bản thì báo bằng lời người đọc được", async () => {
    const error = {
      code: "55000",
      message: "unapprove_voucher: approval_version mismatch (expected 7, found 8)",
    };
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "set_termination_forfeit_status_v1") {
        return { data: null, error: { code: "PGRST202", message: "not found" } };
      }
      if (name === "unapprove_voucher") return { data: null, error };
      throw new Error(`Unexpected RPC ${name}`);
    });
    mockVoucherRead({
      data: { system_source: null, notes: null, approval_version: 7 },
      error: null,
    });

    const mutation = useUnapproveVoucher() as unknown as StatusMutation;
    await expect(mutation.mutationFn("voucher-9")).rejects.toEqual(error);

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Phiếu vừa được người khác thay đổi — hãy tải lại trang rồi thử lại",
    );
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
