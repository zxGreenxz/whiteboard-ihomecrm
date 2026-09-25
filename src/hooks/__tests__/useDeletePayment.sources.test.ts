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

import { COLLECTION_BLOCK_TEXT, undoErrorText, useDeletePayment } from "../useDeletePayment";

const LY_DO = "Thu trùng với anh Hiển lúc 14:05";

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
        reason: string;
      }) => Promise<{ mode: string; payment_id: string | null; collection_id: string | null }>;
    };

    const result = await mutation.mutationFn({
      payment_id: null,
      collection_id: "collection-pure-credit",
      reason: LY_DO,
    });

    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "reverse_invoice_collection_v5",
      expect.objectContaining({ p_collection_id: "collection-pure-credit", p_reason: LY_DO }),
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
        reason: string;
      }) => Promise<{ reversalMode: string | null }>;
    };

    const result = await mutation.mutationFn({
      payment_id: null,
      collection_id: "collection-inplace",
      reason: LY_DO,
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
      mutationFn: (input: { payment_id: string; reason: string }) => Promise<{ mode: string }>;
    };
    const result = await mutation.mutationFn({ payment_id: "payment-1", reason: LY_DO });

    expect(mocks.from).toHaveBeenCalledWith("payments");
    expect(builder.eq).toHaveBeenCalledWith("id", "payment-1");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "reverse_invoice_collection_v5",
      expect.objectContaining({ p_collection_id: "collection-1" }),
    );
    expect(result.mode).toBe("COLLECTION_REVERSED");
  });
});

describe("useDeletePayment — lý do hoàn tác do người bấm gõ (đợt 1 sửa phiếu)", () => {
  type Mutation = { mutationFn: (input: { collection_id: string; reason: string }) => Promise<unknown> };

  it("thiếu lý do / dưới 8 ký tự: chặn trước mọi lời gọi mạng", async () => {
    const { mutationFn } = useDeletePayment() as unknown as Mutation;
    await expect(mutationFn({ collection_id: "c1", reason: "" })).rejects.toThrow(
      "Phải ghi lý do hoàn tác (ít nhất 8 ký tự).",
    );
    await expect(mutationFn({ collection_id: "c1", reason: "  ngắn   " })).rejects.toThrow(/ít nhất 8 ký tự/);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("gửi đúng lý do đã gõ (bỏ khoảng trắng hai đầu), không còn câu điền sẵn", async () => {
    const { mutationFn } = useDeletePayment() as unknown as Mutation;
    await mutationFn({ collection_id: "c1", reason: `   ${LY_DO}   ` });
    const args = mocks.rpc.mock.lastCall?.[1] as { p_reason: string };
    expect(args.p_reason).toBe(LY_DO);
    expect(args.p_reason).not.toMatch(/từ giao diện hóa đơn/);
  });
});

describe("useDeletePayment — câu báo tháng đã chốt lợi nhuận", () => {
  it("câu mới: mọi phiếu của tháng bị khoá, nhờ chủ công ty mở khoá tháng", () => {
    expect(COLLECTION_BLOCK_TEXT.PROFIT_LOCKED).toBe(
      "Tháng của khoản thu này đã chốt lợi nhuận — mọi phiếu của tháng bị khoá; nhờ chủ công ty mở khoá tháng.",
    );
  });

  it("máy chủ còn trả câu cũ ('liên hệ quản trị') thì thay bằng câu mới", () => {
    expect(
      undoErrorText("[PROFIT_LOCKED] Lợi nhuận của tháng chứa khoản thu này đã chốt — hãy liên hệ quản trị để lập phiếu chi đối ứng ở kỳ hiện tại."),
    ).toBe(COLLECTION_BLOCK_TEXT.PROFIT_LOCKED);
  });

  it("máy chủ đã nói câu mới (kèm tháng + toà) thì giữ nguyên, chỉ bỏ tiền tố", () => {
    const moi = "Tháng 07/2026 của toà 15KV đã chốt lợi nhuận — mọi phiếu của tháng này bị khoá, không hoàn tác được. Nhờ chủ công ty mở khoá tháng.";
    expect(undoErrorText(`[PROFIT_LOCKED] ${moi}`)).toBe(moi);
  });

  it("lỗi khác giữ nguyên câu máy chủ", () => {
    expect(undoErrorText("Chỉ người đã thu khoản này mới hoàn tác được.")).toBe("Chỉ người đã thu khoản này mới hoàn tác được.");
    expect(undoErrorText("[HANDOVER_LOCKED] Phiếu nằm trong phiên bàn giao")).toBe("Phiếu nằm trong phiên bàn giao");
  });
});
