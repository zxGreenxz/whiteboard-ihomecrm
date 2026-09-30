// Đường lùi chứng từ của hộp "Duyệt và Chi": khi server không cho đính ảnh lên
// phiếu, `fallbackToEvidenceStore` tải lại ảnh vào kho chứng từ bằng
// uploadFinanceEvidence — ngay trong bước "đang ghi ảnh", lúc hộp thoại KHOÁ không
// cho đóng (IncomeExpensePostingDialog: handleOpenChange). Upload kẹt ở đây từng
// không có hạn chờ ⇒ hộp khoá vĩnh viễn, chỉ còn cách tắt app. Nay quá hạn thì
// báo lỗi và trả null để hộp mở khoá.
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ rpc: vi.fn(), upload: vi.fn(), remove: vi.fn(), toastError: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: mock.rpc,
    storage: { from: () => ({ upload: mock.upload, remove: mock.remove, getPublicUrl: (p: string) => ({ data: { publicUrl: p } }) }) },
  },
}));
vi.mock("sonner", () => ({ toast: { error: mock.toastError, warning: vi.fn(), success: vi.fn() } }));
import { uploadFinanceEvidence } from "../financeV2Mutations";
import { uploadDeadlineMs } from "@/lib/storage";

afterEach(() => {
  vi.useRealTimers();
  mock.rpc.mockReset();
  mock.upload.mockReset();
  mock.toastError.mockReset();
});

describe("uploadFinanceEvidence", () => {
  it("tải lên kẹt: quá hạn thì báo lỗi và trả null, không giữ hộp thoại khoá mãi", async () => {
    vi.useFakeTimers();
    mock.rpc.mockImplementation(async (fn: string) =>
      fn === "create_finance_evidence_upload_intent_v2"
        ? { data: { evidence_id: "ev-1", bucket_id: "finance-evidence", object_name: "v2/org/x/ev-1" }, error: null }
        : { data: null, error: null });
    mock.upload.mockImplementation(() => new Promise(() => {}));
    const file = new File([new Uint8Array(300_000)], "bill.png", { type: "image/png" });
    const pending = uploadFinanceEvidence(file, "org");
    await vi.advanceTimersByTimeAsync(uploadDeadlineMs(file.size));
    await expect(pending).resolves.toBeNull();
    expect(mock.toastError).toHaveBeenCalledWith(expect.stringMatching(/quá lâu/));
    expect(mock.rpc).not.toHaveBeenCalledWith("finalize_finance_evidence_v2", expect.anything());
  });

  it("tải lên bình thường: vẫn finalize và trả mã chứng từ như cũ", async () => {
    mock.rpc.mockImplementation(async (fn: string) =>
      fn === "create_finance_evidence_upload_intent_v2"
        ? { data: { evidence_id: "ev-2", bucket_id: "finance-evidence", object_name: "v2/org/x/ev-2" }, error: null }
        : { data: { evidence_id: "ev-2", state: "FINALIZED" }, error: null });
    mock.upload.mockResolvedValue({ data: { path: "v2/org/x/ev-2" }, error: null });
    const file = new File([new Uint8Array(1_000)], "bill.png", { type: "image/png" });
    await expect(uploadFinanceEvidence(file, "org")).resolves.toBe("ev-2");
    expect(mock.upload).toHaveBeenCalledWith("v2/org/x/ev-2", file, { contentType: "image/png", upsert: false });
    expect(mock.rpc).toHaveBeenCalledWith("finalize_finance_evidence_v2", { p_evidence_id: "ev-2" });
  });
});
