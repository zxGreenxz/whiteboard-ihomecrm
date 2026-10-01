// Lưu thẻ nháp của trang "Báo chi nhanh".
//   Công ty  ⇒ useCreateIncomeExpense → create_income_expense_v1 (bộ máy chi quyết Đã duyệt /
//              Chờ duyệt y như phiếu lập tay) với khoá chống trùng cố định `qe-<id thẻ>`.
//   Cá nhân  ⇒ useCreatePersonalTransaction, mỗi danh mục một khoản.
// Kết quả chia bốn loại để thẻ xử lý đúng: saved · unknown (rớt mạng — khoá thẻ, chỉ cho gửi lại
// Y NGUYÊN) · maybe_saved (23505: cùng khoá khác nội dung — lần trước có thể đã lưu) · rejected.
// Ảnh chứng từ tải MỘT lần trước khi lưu; URL giữ trên thẻ để lần gửi lại không tải lại.

import { useCreateIncomeExpense } from "@/hooks/income-expenses/mutations";
import type { CreateIncomeExpenseInput } from "@/hooks/income-expenses/types";
import { useCreatePersonalTransaction } from "@/hooks/usePersonalTransactions";
import { getSessionUser } from "@/lib/authSession";
import { uploadFileDetailed } from "@/lib/storage";
import { hasUnconfirmedResponse } from "@/lib/operationOutcome";
import { createdVoucherFeedback, voucherFailureMessage } from "@/lib/voucherFeedback";
import { recordWriteMessage } from "@/lib/recordWriteOutcome";
import { toCreateIncomeExpenseInput, toPersonalTransactionValues } from "@/lib/quickEntry/convert";
import type { QuickDraft } from "@/lib/quickEntry/draft";

export const ATTACHMENT_BUCKET = "income-expense-attachments";

/** `done` = số khoản đã chắc chắn ghi (cộng dồn qua các lần gửi) — gửi lại thì bỏ qua chừng đó khoản. */
export type SaveOutcome =
  | { kind: "saved"; code: string | null; approvalStatus: string | null; ids: string[]; done: number; message: string }
  | { kind: "unknown"; ids: string[]; done: number; message: string }
  | { kind: "maybe_saved"; ids: string[]; done: number; message: string }
  | { kind: "rejected"; ids: string[]; done: number; message: string };

const UNKNOWN_MESSAGE =
  "Chưa rõ đã lưu chưa (mất kết nối). Bấm “Gửi lại y nguyên” — máy chủ tự chống trùng — hoặc kiểm tra trong Thu chi.";
const MAYBE_SAVED_MESSAGE =
  "Thẻ này có thể đã được lưu ở lần trước. Kiểm tra trong Thu chi trước khi tạo thẻ mới.";

const codeOf = (e: unknown) => String((e as { code?: unknown } | null)?.code ?? "");

// uploadFileDetailed tự đổi đuôi khi nén có lợi; khi giữ file gốc (ảnh chụp màn hình PNG…) thì đuôi
// phải đúng loại ảnh ngay từ đầu.
const EXT: Record<string, string> = { "image/png": ".png", "image/webp": ".webp" };

export function useQuickEntrySave() {
  const createIE = useCreateIncomeExpense();
  const createPersonal = useCreatePersonalTransaction();

  const uploadPhoto = async (file: File, draftId: string): Promise<string> => {
    const user = await getSessionUser();
    if (!user) throw new Error("Phiên đăng nhập đã hết, hãy đăng nhập lại.");
    const ext = EXT[file.type] ?? ".jpg";
    const stored = await uploadFileDetailed(ATTACHMENT_BUCKET, `${user.id}/${Date.now()}-qe-${draftId}${ext}`, file);
    return stored.url;
  };

  const saveCompany = async (draft: QuickDraft): Promise<SaveOutcome> => {
    try {
      // Hình CompanyVoucherInput khớp CreateIncomeExpenseInput — TypeScript so ở dòng này.
      const input: CreateIncomeExpenseInput = toCreateIncomeExpenseInput(draft);
      const row = (await createIE.mutateAsync(input)) as { id?: string; code?: string; approval_status?: string } | null;
      return {
        kind: "saved",
        code: row?.code ?? null,
        approvalStatus: row?.approval_status ?? null,
        ids: row?.id ? [row.id] : [],
        done: 1,
        message: createdVoucherFeedback(row).message,
      };
    } catch (e) {
      if (codeOf(e) === "23505") return { kind: "maybe_saved", ids: [], done: 0, message: MAYBE_SAVED_MESSAGE };
      if (hasUnconfirmedResponse(e)) return { kind: "unknown", ids: [], done: 0, message: UNKNOWN_MESSAGE };
      return { kind: "rejected", ids: [], done: 0, message: voucherFailureMessage(e, "tạo phiếu") };
    }
  };

  /**
   * Ví cá nhân KHÔNG có khoá chống trùng; `reconcile` của hook ví chỉ cứu khoản đang treo. Nên khi gửi
   * lại, bỏ qua `alreadyDone` khoản đầu đã chắc chắn ghi — nếu không, khoản đầu bị ghi hai lần.
   */
  const savePersonal = async (draft: QuickDraft, alreadyDone = 0): Promise<SaveOutcome> => {
    const ids: string[] = [];
    let done = alreadyDone;
    for (const values of toPersonalTransactionValues(draft).slice(alreadyDone)) {
      try {
        const row = (await createPersonal.mutateAsync(values)) as { id?: string } | null;
        if (row?.id) ids.push(row.id);
        done += 1;
      } catch (e) {
        if (hasUnconfirmedResponse(e)) return { kind: "unknown", ids, done, message: UNKNOWN_MESSAGE };
        return { kind: "rejected", ids, done, message: recordWriteMessage(e, "thêm khoản vào ví cá nhân") };
      }
    }
    return { kind: "saved", code: null, approvalStatus: null, ids, done, message: "Đã ghi vào Ví cá nhân." };
  };

  return { uploadPhoto, saveCompany, savePersonal };
}
