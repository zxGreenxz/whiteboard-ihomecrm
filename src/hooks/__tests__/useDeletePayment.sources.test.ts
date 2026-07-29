import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  invalidateQueries: vi.fn(),
  rpc: vi.fn(),
  toast: vi.fn(),
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

vi.mock("@/hooks/use-toast", () => ({
  useToast: vi.fn(() => ({ toast: mocks.toast })),
}));

import { useDeletePayment } from "../useDeletePayment";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: { status: "REVERSED" }, error: null });
});

describe("useDeletePayment source routing", () => {
  it("reverses a collection-only receipt without looking up a payment", async () => {
    const mutation = useDeletePayment() as unknown as {
      mutationFn: (input: {
        payment_id?: string | null;
        collection_id?: string | null;
      }) => Promise<{ mode: string; payment_id: string | null; collection_id: string | null }>;
    };

    const result = await mutation.mutationFn({
      payment_id: null,
      collection_id: "collection-pure-credit",
    });

    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "reverse_invoice_collection_v5",
      expect.objectContaining({ p_collection_id: "collection-pure-credit" }),
    );
    expect(result).toEqual({
      payment_id: null,
      collection_id: "collection-pure-credit",
      mode: "COLLECTION_REVERSED",
      // Đợt 5: payload không có `reversal_mode` (ở đây mock trả {status}) thì
      // FE đọc ra null và giữ nguyên câu chữ trung tính.
      reversalMode: null,
    });
  });

  it("đọc được đường server đã chạy khi payload có reversal_mode (Đợt 5)", async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: "REVERSED", reversal_mode: "IN_PLACE_CANCEL" },
      error: null,
    });
    const mutation = useDeletePayment() as unknown as {
      mutationFn: (input: {
        payment_id?: string | null;
        collection_id?: string | null;
      }) => Promise<{ reversalMode: string | null }>;
    };

    const result = await mutation.mutationFn({
      payment_id: null,
      collection_id: "collection-inplace",
    });

    expect(result.reversalMode).toBe("IN_PLACE_CANCEL");
  });

  it("validates a payment-only caller and discovers its V5 collection", async () => {
    const builder: Record<string, any> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.single = vi.fn().mockResolvedValue({
      data: { id: "payment-1", collection_id: "collection-1" },
      error: null,
    });
    mocks.from.mockReturnValue(builder);

    const mutation = useDeletePayment() as unknown as {
      mutationFn: (input: { payment_id: string }) => Promise<{ mode: string }>;
    };
    const result = await mutation.mutationFn({ payment_id: "payment-1" });

    expect(mocks.from).toHaveBeenCalledWith("payments");
    expect(builder.eq).toHaveBeenCalledWith("id", "payment-1");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "reverse_invoice_collection_v5",
      expect.objectContaining({ p_collection_id: "collection-1" }),
    );
    expect(result.mode).toBe("COLLECTION_REVERSED");
  });
});
