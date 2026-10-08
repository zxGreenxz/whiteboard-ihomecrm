// Lưu thẻ nháp của trang "Báo chi nhanh".
//   Công ty  ⇒ useCreateIncomeExpense → create_income_expense_v1 (bộ máy chi quyết Đã duyệt /
//              Chờ duyệt y như phiếu lập tay) với khoá chống trùng cố định `qe-<id thẻ>`.
//   Cá nhân ⇒ transaction.batch atomic, một UUID cố định cho mỗi thẻ.
// Kết quả chia bốn loại để thẻ xử lý đúng: saved · unknown (rớt mạng, hoặc ví đã ghi được một phần —
// khoá thẻ, chỉ cho gửi lại Y NGUYÊN) · maybe_saved (23505: cùng khoá khác nội dung — lần trước có thể
// đã lưu) · rejected.
// Ảnh chứng từ tải MỘT lần trước khi lưu; URL giữ trên thẻ để lần gửi lại không tải lại.

import { useCreateIncomeExpense } from "@/hooks/income-expenses/mutations";
import type { CreateIncomeExpenseInput } from "@/hooks/income-expenses/types";
import { usePersonalFinanceMutation } from '@/hooks/personal-finance/usePersonalFinance';
import { PersonalFinanceError } from '@/lib/personalFinance/service';
import { getSessionUser } from "@/lib/authSession";
import { uploadFileDetailed } from "@/lib/storage";
import { hasUnconfirmedResponse } from "@/lib/operationOutcome";
import { createdVoucherFeedback, voucherFailureMessage } from "@/lib/voucherFeedback";
import { toCreateIncomeExpenseInput, toPersonalBatch } from "@/lib/quickEntry/convert";
import type { QuickDraft } from "@/lib/quickEntry/draft";
import { useCreateCompanyWalletVoucher } from '@/hooks/company-wallet/useCompanyWallets';
import { CompanyWalletError } from '@/lib/companyWallet/service';

export const ATTACHMENT_BUCKET = "income-expense-attachments";

/** `done` counts confirmed rows only; legacy partial counts are retained for reconciliation. */
export type SaveOutcome =
  | { kind: "saved"; code: string | null; approvalStatus: string | null; ids: string[]; done: number; message: string }
  | { kind: "unknown"; ids: string[]; done: number; message: string }
  | { kind: "maybe_saved"; ids: string[]; done: number; message: string }
  | { kind: "rejected"; ids: string[]; done: number; message: string };

const UNKNOWN_MESSAGE =
  "Chưa rõ đã lưu chưa (mất kết nối). Bấm “Gửi lại y nguyên” — máy chủ tự chống trùng — hoặc kiểm tra trong Thu chi.";
const MAYBE_SAVED_MESSAGE =
  "Thẻ này có thể đã được lưu ở lần trước. Kiểm tra trong Thu chi trước khi tạo thẻ mới.";
const COMPAT_UNKNOWN_MESSAGE =
  "Mất kết nối lúc lưu qua đường dự phòng (không chống trùng được) — phiếu có thể đã được tạo. Kiểm tra trong Thu chi trước khi lập lại.";

const codeOf = (e: unknown) => String((e as { code?: unknown } | null)?.code ?? "");

// uploadFileDetailed tự đổi đuôi khi nén có lợi; khi giữ file gốc (ảnh chụp màn hình PNG…) thì đuôi
// phải đúng loại ảnh ngay từ đầu.
const EXT: Record<string, string> = { "image/png": ".png", "image/webp": ".webp" };

export function useQuickEntrySave(organizationId: string | null = null) {
  const createIE = useCreateIncomeExpense();
  const personal = usePersonalFinanceMutation();
  const createWalletVoucher = useCreateCompanyWalletVoucher(organizationId);

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
      if(draft.entrySource === 'personal_wallet' && (!organizationId || draft.companyOrganizationId !== organizationId || !draft.companyWalletId)) {
        throw new Error('Chọn ví Công ty hợp lệ trong công ty đang nhập trước khi lưu.');
      }
      const row = (draft.entrySource === 'personal_wallet'
        ? await createWalletVoucher.mutateAsync({walletId:draft.companyWalletId!,idempotencyKey:input.idempotency_key!,input})
        : await createIE.mutateAsync(input)) as { id?: string; code?: string; approval_status?: string } | null;
      if(!row?.id) throw new TypeError('Chưa nhận được xác nhận tạo phiếu. Kiểm tra kết quả trước khi thử lại.');
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
      if (hasUnconfirmedResponse(e) || e instanceof CompanyWalletError && e.outcomeUnknown) {
        // Đường compat không có khoá chống trùng ⇒ gửi lại y nguyên có thể ra phiếu đôi: chỉ cho kiểm tra.
        if ((e as { ieCreatePath?: string } | null)?.ieCreatePath === "compat") {
          return { kind: "maybe_saved", ids: [], done: 0, message: COMPAT_UNKNOWN_MESSAGE };
        }
        return { kind: "unknown", ids: [], done: 0, message: UNKNOWN_MESSAGE };
      }
      return { kind: "rejected", ids: [], done: 0, message: voucherFailureMessage(e, "tạo phiếu") };
    }
  };

  /** One card = one atomic request. Historic partial/unknown writes need explicit reconciliation. */
  const savePersonal = async (draft: QuickDraft, alreadyDone = 0, onProgress?: (done:number)=>void): Promise<SaveOutcome> => {
    if(!draft.personalProtocol)return {kind:'maybe_saved',ids:[],done:alreadyDone,message:'Nháp cũ có khoản đã ghi hoặc chưa rõ kết quả. Đối chiếu Ví cá nhân trước khi tạo phần còn thiếu; không tự gửi lại.'};
    try {
      const key=draft.personalRequestKey??draft.id;
      const prior=personal.pending.find(p=>p.requestKey===key);
      const request=prior??personal.prepare(toPersonalBatch(draft),key);
      const receipt=await personal.mutateAsync(request);
      const ids=receipt.entities.map(r=>r.id);onProgress?.(ids.length);
      return {kind:'saved',code:null,approvalStatus:null,ids,done:ids.length,message:'Đã ghi vào Ví cá nhân.'};
    }catch(error){
      const unknown=error instanceof PersonalFinanceError ? error.outcomeUnknown||['network','internal'].includes(error.kind) : hasUnconfirmedResponse(error);
      return {kind:unknown?'unknown':'rejected',ids:[],done:0,message:unknown?'Chưa xác nhận kết quả. Gửi lại y nguyên; máy chủ chống trùng theo mã yêu cầu của Ví cá nhân.':error instanceof Error?error.message:'Không lưu được khoản vào Ví cá nhân.'};
    }
  };
  return { uploadPhoto, saveCompany, savePersonal, pendingPersonalRequests:personal.pending };
}
