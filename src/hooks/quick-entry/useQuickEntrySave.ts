// Lưu thẻ nháp của trang "Báo chi nhanh".
//   Công ty  ⇒ useCreateIncomeExpense → create_income_expense_v1 (bộ máy chi quyết Đã duyệt /
//              Chờ duyệt y như phiếu lập tay) với khoá chống trùng cố định `qe-<id thẻ>`.
//   Cá nhân  ⇒ useCreatePersonalTransaction, mỗi danh mục một khoản.
// Kết quả chia bốn loại để thẻ xử lý đúng: saved · unknown (rớt mạng, hoặc ví đã ghi được một phần —
// khoá thẻ, chỉ cho gửi lại Y NGUYÊN) · maybe_saved (23505: cùng khoá khác nội dung — lần trước có thể
// đã lưu) · rejected.
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
/** Ví không có khoá phía máy chủ: chống trùng là bước đối chiếu của hook ví trước khi ghi lại. */
const UNKNOWN_PERSONAL_MESSAGE =
  "Chưa rõ đã ghi chưa (mất kết nối). Bấm “Gửi lại y nguyên” — máy đối chiếu với ví trước khi ghi — hoặc xem Ví cá nhân.";
const MAYBE_SAVED_MESSAGE =
  "Thẻ này có thể đã được lưu ở lần trước. Kiểm tra trong Thu chi trước khi tạo thẻ mới.";
const COMPAT_UNKNOWN_MESSAGE =
  "Mất kết nối lúc lưu qua đường dự phòng (không chống trùng được) — phiếu có thể đã được tạo. Kiểm tra trong Thu chi trước khi lập lại.";
const partialMessage = (done: number, total: number, why: string) =>
  `Đã ghi ${done}/${total} khoản vào ví; khoản kế chưa ghi được: ${why} Bấm “Gửi lại y nguyên” để ghi tiếp phần còn lại.`;

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
      if (hasUnconfirmedResponse(e)) {
        // Đường compat không có khoá chống trùng ⇒ gửi lại y nguyên có thể ra phiếu đôi: chỉ cho kiểm tra.
        if ((e as { ieCreatePath?: string } | null)?.ieCreatePath === "compat") {
          return { kind: "maybe_saved", ids: [], done: 0, message: COMPAT_UNKNOWN_MESSAGE };
        }
        return { kind: "unknown", ids: [], done: 0, message: UNKNOWN_MESSAGE };
      }
      return { kind: "rejected", ids: [], done: 0, message: voucherFailureMessage(e, "tạo phiếu") };
    }
  };

  /**
   * Ví cá nhân KHÔNG có khoá chống trùng; `reconcile` của hook ví chỉ cứu khoản đang treo. Nên khi gửi
   * lại, bỏ qua `alreadyDone` khoản đầu đã chắc chắn ghi — nếu không, khoản đầu bị ghi hai lần.
   * `onProgress` báo ngay sau TỪNG khoản để thẻ lưu tiến độ trước khi khoản kế chạy (tải lại trang giữa
   * vòng không làm mất số khoản đã ghi). Đã ghi được ít nhất một khoản mà khoản kế bị từ chối ⇒ trả
   * 'unknown' để thẻ KHOÁ: sửa thẻ lúc này làm đổi cách chia khoản và `slice(done)` sẽ bỏ sót/ghi lặp.
   */
  const savePersonal = async (
    draft: QuickDraft,
    alreadyDone = 0,
    onProgress?: (done: number) => void,
  ): Promise<SaveOutcome> => {
    const all = toPersonalTransactionValues(draft);
    const ids: string[] = [];
    let done = alreadyDone;
    for (const values of all.slice(alreadyDone)) {
      try {
        const row = (await createPersonal.mutateAsync(values)) as { id?: string } | null;
        if (row?.id) ids.push(row.id);
        done += 1;
        onProgress?.(done);
      } catch (e) {
        if (hasUnconfirmedResponse(e)) return { kind: "unknown", ids, done, message: UNKNOWN_PERSONAL_MESSAGE };
        const why = recordWriteMessage(e, "thêm khoản vào ví cá nhân");
        if (done > 0) return { kind: "unknown", ids, done, message: partialMessage(done, all.length, why) };
        return { kind: "rejected", ids, done, message: why };
      }
    }
    return { kind: "saved", code: null, approvalStatus: null, ids, done, message: "Đã ghi vào Ví cá nhân." };
  };

  return { uploadPhoto, saveCompany, savePersonal };
}
