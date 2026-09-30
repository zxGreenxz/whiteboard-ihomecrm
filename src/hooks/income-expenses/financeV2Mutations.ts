import {useOrganization} from '@/contexts/OrganizationContext';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError,workflowErrorMessage} from '@/lib/financialWorkflow';
import {financialReadRows} from '@/lib/financialReadValidation';
// Finance V2 — mutation hooks gọi RPC canonical (Stage-5 writers, plan §7.2).
//
// CHỈ dùng khi route workflow/posting của org là CANONICAL (caller gate bằng
// useFinanceV2Routes + canWriteWorkflow/canWritePosting). Không có fallback raw
// DML: RPC lỗi = fail, hiển thị lỗi — đúng nguyên tắc §8 (42501 thật phải fail).
//
// RPC contracts (Stage-5 20260723050000):
//   approve_income_expense_v2(p_voucher uuid, p_expected_approval_version bigint,
//                             p_idempotency_key text) -> jsonb
//   post_approved_income_expense_v2(input jsonb)      -> jsonb
//   approve_and_post_income_expense_v2(input jsonb)   -> jsonb
// input = PostFinanceExecutionInput (src/lib/incomeExpensePostingValidation.ts).

import { useCallback, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { VoucherPartialError, voucherFailureMessage, voucherLifecycleFeedback } from "@/lib/voucherFeedback";
import { useAuth } from "@/hooks/useAuth";
import type { PostFinanceExecutionInput } from "@/lib/incomeExpensePostingValidation";
import { todayISO } from '@/lib/collect';
import { UploadTimeoutError } from '@/lib/uploadDeadline';
import { uploadFile, deleteFile, sanitizeStorageFileName, uploadToStorageWithDeadline } from "@/lib/storage";
import { validateAttachmentFile } from "@/components/income-expenses/AttachmentUpload";
import { periodBlockMessage } from "@/lib/cashbookClosing";
import { isStaleVersionError } from "@/lib/incomeExpenseRevision";

// RPC v2 chưa có trong generated types cho tới lần regen sau forward-apply.
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
const rpc = (fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult> =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => PromiseLike<RpcResult>)(fn, args);

function confirmV2Receipt(value:unknown,subjectId:string,action:'approve'|'post'|'approvePost'|'reverse'):unknown {
  const receipt=value && typeof value==='object'?value as Record<string,unknown>:{};
  const id=receipt.voucherId??receipt.refundVoucherId;
  if(id!==subjectId || voucherLifecycleFeedback(value,action).kind==='warning')throw new TypeError('Chưa xác nhận được đúng phiếu và trạng thái sau thao tác.');
  return value;
}
function requireSubjectId(value:unknown):asserts value is string {
  if(typeof value!=='string'||!value)throw new TypeError('Chưa xác định được phiếu cần xử lý.');
}

export type FinancePostingInput=PostFinanceExecutionInput & {organizationId?:string|null};

const INVALIDATE_KEYS = [
  ["income-expenses"],
  ["income-expense"],
  ["income-expense-batches"],
  ["voucher-with-batch"],
  ["income-expense-stats"],
  ["accounts-with-balance"],
  ["finance-v2-routes"],
] as const;

function useInvalidateMoney() {
  const qc = useQueryClient();
  return () => {
    for (const key of INVALIDATE_KEYS) qc.invalidateQueries({ queryKey: [...key] });
  };
}

/** Phiếu do FLOW HỆ THỐNG sở hữu (vd Hoàn tiền hoá đơn): RPC thủ công từ chối
 * "owned by system flow" — phải quyết định qua dispatcher §8. */
export function isOwnedBySystemFlow(message: string | null | undefined): boolean {
  return /owned by system flow/i.test(message ?? "");
}

/** Duyệt-only V2: balance KHÔNG đổi (khác legacy). */
export function useApproveIncomeExpenseV2(options:{scope?:'target'}={}) {
  const invalidate = useInvalidateMoney();
  const {selectedOrganizationId}=useOrganization();
  const workflow=useRef(persistentFinancialWorkflow('voucher-v2-approve',options));
  return useMutation({
    mutationFn: async (args: { voucherId: string; expectedApprovalVersion?: number; organizationId?:string|null }) => {
      requireSubjectId(args.voucherId);
      if(options.scope==='target'&&!args.organizationId)throw new FinancialWorkflowError('Chưa xác định được tổ chức của phiếu. Tải lại yêu cầu trước khi tiếp tục.','failure',[]);
      return workflow.current.run(args.voucherId,'duyệt phiếu',async progress=>{
      const { data, error } = await rpc("approve_income_expense_v2", {
        p_voucher: args.voucherId,
        p_expected_approval_version: args.expectedApprovalVersion ?? 1,
        p_idempotency_key: progress.requestKey,
      });
      if (error && isOwnedBySystemFlow(error.message)) {
        // 7ac: phiếu flow-owned (INVOICE_REFUND/TERMINATION_REFUND) duyệt qua
        // entrypoint dispatch — cùng quyền income_expenses.approve, không đổi cash.
        const owned = await rpc("decide_owned_income_expense_v2", {
          p_voucher: args.voucherId,
          p_decision: "approve",
          p_reason: null,
          p_idempotency_key: progress.requestKey,
        });
        if (owned.error) throw owned.error;
        const receipt=confirmV2Receipt(owned.data,args.voucherId,'approve');
        progress.completed.push({id:args.voucherId,label:'Đã duyệt phiếu'});
        return receipt;
      }
      if (error) throw error;
      const receipt=confirmV2Receipt(data,args.voucherId,'approve');
      progress.completed.push({id:args.voucherId,label:'Đã xác nhận duyệt phiếu'});
      return receipt;
      },undefined,args.organizationId??selectedOrganizationId??undefined);
    },
    onSuccess: (data) => {
      invalidate();
      const feedback = voucherLifecycleFeedback(data, "approve");
      toast[feedback.kind](feedback.message);
    },
    onError: (e: Error) => {
      // Phiếu vừa bị sửa khi đang mở hộp Duyệt (đợt 1 sửa phiếu): nói bằng lời
      // người đọc được và kéo bản mới về, thay cho "approval_version mismatch".
      if (isStaleVersionError(e)) invalidate();
      toast.error(workflowErrorMessage(e,'duyệt phiếu'));
    },
  });
}

/** Thu/Chi phiếu ĐÃ duyệt (CUSTODIAN, không cần quyền duyệt). */
export function usePostApprovedIncomeExpenseV2() {
  const invalidate = useInvalidateMoney();
  const {selectedOrganizationId}=useOrganization();
  const workflow=useRef(persistentFinancialWorkflow('voucher-v2-post'));
  return useMutation({
    mutationFn: async (input: FinancePostingInput) => {
      requireSubjectId(input.subjectId);
      const {organizationId,...postingInput}=input;
      return workflow.current.run(input.subjectId,'ghi nhận thu/chi',async progress=>{
      const { data, error } = await rpc("post_approved_income_expense_v2", { input:{...postingInput,idempotencyKey:progress.requestKey} });
      if (error) throw error;
      const receipt=confirmV2Receipt(data,input.subjectId,'post');
      progress.completed.push({id:input.subjectId,label:'Đã xác nhận ghi nhận thu/chi'});
      return receipt;
      },undefined,selectedOrganizationId??undefined);
    },
    onSuccess: (data) => {
      invalidate();
      const feedback = voucherLifecycleFeedback(data, "post");
      toast[feedback.kind](feedback.message);
    },
    onError: (e: unknown) => toast.error(workflowErrorMessage(e,'ghi nhận thu/chi')),
  });
}

/** Duyệt và Thu/Chi atomic (actor vừa approver vừa CUSTODIAN). */
export function useApproveAndPostIncomeExpenseV2(options:{scope?:'target'}={}) {
  const invalidate = useInvalidateMoney();
  const {selectedOrganizationId}=useOrganization();
  const workflow=useRef(persistentFinancialWorkflow('voucher-v2-approve-post',options));
  return useMutation({
    mutationFn: async (input: FinancePostingInput) => {
      requireSubjectId(input.subjectId);
      const {organizationId,...postingInput}=input;
      if(options.scope==='target'&&!organizationId)throw new FinancialWorkflowError('Chưa xác định được tổ chức của phiếu. Tải lại yêu cầu trước khi tiếp tục.','failure',[]);
      return workflow.current.run(input.subjectId,'duyệt và ghi nhận thu/chi',async progress=>{
      const { data, error } = await rpc("approve_and_post_income_expense_v2", { input:{...postingInput,idempotencyKey:progress.requestKey} });
      if (error) throw error;
      const receipt=confirmV2Receipt(data,input.subjectId,'approvePost');
      progress.completed.push({id:input.subjectId,label:'Đã xác nhận duyệt và ghi nhận thu/chi'});
      return receipt;
      },undefined,organizationId??selectedOrganizationId??undefined);
    },
    onSuccess: (data) => {
      invalidate();
      const feedback = voucherLifecycleFeedback(data, "approvePost");
      toast[feedback.kind](feedback.message);
    },
    onError: (e: unknown) => toast.error(workflowErrorMessage(e,'duyệt và ghi nhận thu/chi')),
  });
}

/** Hoàn tác phiếu ĐÃ GHI SỔ (mô hình 2 nút): tiền trả về sổ bằng bút toán đối
 *  dấu, phiếu về "Đã hoàn tác" — nằm chờ Chi lại hoặc Huỷ. CUSTODIAN đúng sổ. */
export function useReversePostingV2() {
  const invalidate = useInvalidateMoney();
  const {selectedOrganizationId}=useOrganization();
  const workflow=useRef(persistentFinancialWorkflow('voucher-v2-reverse'));
  return useMutation({
    mutationFn: async (args: {
      voucherId: string;
      cashbookId: string;
      reason?: string | null;
    }) => {
      requireSubjectId(args.voucherId);
      return workflow.current.run(args.voucherId,'hoàn tác thu/chi',async progress=>{
      const { data, error } = await rpc("reverse_posted_income_expense_v2", {
        p_voucher: args.voucherId,
        p_cashbook: args.cashbookId,
        p_posted_on: todayISO(),
        p_reason: args.reason || "Hoàn tác thủ công",
        p_idempotency_key: progress.requestKey,
      });
      if (error) throw error;
      const receipt=confirmV2Receipt(data,args.voucherId,'reverse');
      progress.completed.push({id:args.voucherId,label:'Đã xác nhận hoàn tác thu/chi'});
      return receipt;
      },undefined,selectedOrganizationId??undefined);
    },
    onSuccess: (data) => {
      invalidate();
      const feedback = voucherLifecycleFeedback(data, "reverse");
      toast[feedback.kind](feedback.message);
    },
    onError: (e: unknown) => toast.error(workflowErrorMessage(e,'hoàn tác thu/chi')),
  });
}

/**
 * Upload chứng từ theo flow §6.3: intent (server cấp path) → upload storage →
 * finalize (server verify + FINALIZED). Trả evidence_id hoặc null nếu lỗi.
 * Dùng làm onUploadEvidence của IncomeExpensePostingDialog.
 */
export async function uploadFinanceEvidence(
  file: File,
  organizationId?: string | null,
): Promise<string | null> {
  // PHẢI truyền org của phiếu: server-default là membership đầu tiên của user —
  // user đa-org sẽ bị stamp sai tenant ⇒ posting từ chối "not FINALIZED in tenant".
  try {
  const intent = await rpc("create_finance_evidence_upload_intent_v2", {
    p_organization_id: organizationId ?? null,
  });
  if (intent.error) {
    toast.error(voucherFailureMessage(intent.error, `chuẩn bị tải chứng từ “${file.name}”`));
    return null;
  }
  const { evidence_id, bucket_id, object_name } = intent.data as {
    evidence_id: string; bucket_id: string; object_name: string;
  };
  if([evidence_id,bucket_id,object_name].some(value=>typeof value!=='string'||!value))throw new TypeError('Chưa đọc được yêu cầu tải chứng từ.');
  // Có hạn chờ: hàm này là đường lùi chạy trong bước "đang ghi ảnh" của hộp Thu/Chi,
  // lúc hộp KHOÁ không cho đóng — upload kẹt không hạn là khoá hộp tới khi tắt app.
  // Quá hạn thì `up.error` là UploadTimeoutError, đi chung nhánh báo lỗi bên dưới.
  const up = await uploadToStorageWithDeadline(bucket_id, object_name, file, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (up.error) {
    toast.error(up.error instanceof UploadTimeoutError
      ? `Tải chứng từ “${file.name}” quá lâu. Chưa xác nhận tệp đã lưu. Giữ tệp và kiểm tra trạng thái chứng từ trước khi tải tiếp.`
      : voucherFailureMessage(up.error, `tải chứng từ “${file.name}”`));
    return null;
  }
  const fin = await rpc("finalize_finance_evidence_v2", { p_evidence_id: evidence_id });
  if (fin.error) {
    toast.error(voucherFailureMessage(fin.error, `xác nhận chứng từ “${file.name}”`));
    return null;
  }
  const receipt=fin.data as {evidence_id?:unknown;state?:unknown}|null;
  if(receipt?.evidence_id!==evidence_id || receipt.state!=='FINALIZED')throw new TypeError('Chưa xác nhận được chứng từ đã lưu hoàn tất.');
  return evidence_id;
  } catch (error) {
    toast.error(voucherFailureMessage(error, `tải chứng từ “${file.name}”`));
    return null;
  }
}

/**
 * 7ai: dùng LUÔN ảnh đã đính kèm trên phiếu làm chứng từ chi — không bắt tải lại.
 *
 * Ảnh đính kèm (`income_expenses.attachments`) và chứng từ (`finance_evidence_objects`)
 * là hai bản ghi khác nhau; RPC lập bản ghi chứng từ FINALIZED trỏ vào đúng file
 * đã có trong storage. Chỉ nhận file nằm trong attachments của chính phiếu đó.
 *
 * Không ném lỗi: chứng từ tự-nhận là tiện ích, hỏng thì người dùng vẫn tải tay.
 */
export async function adoptVoucherAttachmentsAsEvidence(
  voucherId: string,
): Promise<{ evidenceIds: string[]; skipped: { url: string; reason: string }[] }> {
  const { data, error } = await rpc("adopt_voucher_attachments_as_evidence_v2", {
    p_voucher: voucherId,
  });
  if (error) {
    console.warn("[financeV2] adopt_voucher_attachments_as_evidence_v2:", error.message);
    throw error;
  }
  const payload = data as {
    evidence_ids?: string[];
    skipped?: { url: string; reason: string }[];
  };
  return {
    evidenceIds: financialReadRows<string>(payload?.evidence_ids).map(id=>{if(typeof id!=='string' || !id)throw new TypeError('Chưa đọc được mã chứng từ của phiếu.');return id;}),
    skipped: financialReadRows<{url:string;reason:string}>(payload?.skipped).map(row=>{if(!row || typeof row.url!=='string' || typeof row.reason!=='string')throw new TypeError('Chưa đọc được các chứng từ bị bỏ qua.');return row;}),
  };
}

/** Binding sổ của CHÍNH actor (CUSTODIAN/KNOWER) — nguồn lọc selector §12.6. */
export function useMyCashbookAccessV2() {
  return useQuery({
    queryKey: ["my-cashbook-access-v2"],
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await rpc("list_my_cashbook_access_v2");
      if (error) {
        console.warn("[financeV2] list_my_cashbook_access_v2:", error.message);
        throw error;
      }
      return financialReadRows(data as { cashbook_id: string; possession_kind: string }[] | null);
    },
  });
}

/** Cờ hiển thị per-sổ cho trang Sổ quỹ: balance_visible bám ĐÚNG predicate RLS
 * posting lines (sổ không-binding → "—" thay vì 0 đ giả); can_manage/can_delete
 * mirror policy UPDATE/DELETE accounts (ẩn icon thay vì để bấm rồi 42501). */
export interface CashbookVisibility {
  cashbook_id: string;
  balance_visible: boolean;
  can_manage: boolean;
  can_delete: boolean;
}
export function useCashbookVisibilityV2() {
  return useQuery({
    queryKey: ["cashbook-visibility-v2"],
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await rpc("list_cashbook_visibility_v2");
      if (error) {
        console.warn("[financeV2] list_cashbook_visibility_v2:", error.message);
        throw error;
      }
      return financialReadRows(data as CashbookVisibility[] | null);
    },
  });
}

/** Sổ actor đang là CUSTODIAN — nguồn cho ô Sổ quỹ của Posting dialog (§12.6). */
export function useCustodianCashbooksV2(enabled: boolean) {
  return useQuery({
    queryKey: ["cashbooks-for-expense-v2"],
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await rpc("list_cashbooks_for_expense_v2");
      if (error) {
        throw error;
      }
      return financialReadRows(data as { id: string; name: string }[] | null);
    },
  });
}

/**
 * Kết quả một lần dán ảnh trong hộp thoại Thu/Chi.
 * `attachedToVoucher=false` nghĩa là phải đi ĐƯỜNG LÙI: ảnh chỉ nằm trong kho
 * chứng từ, không đính được lên phiếu (nên KHÔNG hiện ở dòng thu chi).
 */
export interface AttachPostingEvidenceResult {
  /** URL ảnh trên phiếu; null khi đi đường lùi. */
  url: string | null;
  /** Toàn bộ chứng từ hợp lệ của phiếu sau lần dán này. */
  evidenceIds: string[];
  skipped: { url: string; reason: string }[];
  attachedToVoucher: boolean;
}

export interface AttachPostingEvidenceOptions {
  voucherId: string;
  userId: string;
  organizationId?: string | null;
}

/** Kho ảnh đính kèm của phiếu thu chi — cũng là kho mà adopt nhận làm chứng từ (7ai). */
const POSTING_ATTACHMENT_BUCKET = "income-expense-attachments";

/**
 * Tải MỘT file lên kho ảnh đính kèm, CHƯA gắn vào phiếu nào. Trả URL công khai
 * (có đuôi file ⇒ có thumbnail), hoặc null khi file không hợp lệ / tải hỏng —
 * lý do đã được toast.
 */
async function uploadPostingAttachmentFile(file: File, userId: string): Promise<string | null> {
  const invalid = validateAttachmentFile(file);
  if (invalid) {
    toast.error(invalid);
    return null;
  }

  const path = `${userId}/${Date.now()}-${sanitizeStorageFileName(file.name)}`;

  // Bắt lỗi để BÁO, không để nuốt: giữ lại đối tượng lỗi rồi quyết định ở
  // ngoài khối catch (catch trả rỗng là mẫu bị gate error-swallow chặn).
  let url: string | null = null;
  let loiTai: unknown = null;
  try {
    url = await uploadFile(POSTING_ATTACHMENT_BUCKET, path, file);
  } catch (e) {
    loiTai = e;
  }
  if (!url) {
    // Ảnh chỉ mới TẢI LÊN KHO, chưa gắn vào phiếu nào: quá hạn thì lần tải lại dùng
    // tên file mới và file lỡ tải xong muộn bị xoá (uploadToStorageWithDeadline) ⇒ tải
    // lại an toàn. Câu chung "không tải lại khi kết quả còn chưa rõ" dành cho giao dịch;
    // áp vào đây thì người chi kẹt, không có ảnh để chi.
    const quaHan = loiTai instanceof UploadTimeoutError ? loiTai
      : loiTai instanceof FinancialWorkflowError && loiTai.cause instanceof UploadTimeoutError ? loiTai.cause
      : null;
    // Ảnh nén dưới 1 MB chờ 20 giây; PDF lớn được chờ lâu hơn — nói đúng số đã chờ.
    const daCho = quaHan?.ms ? `quá ${Math.round(quaHan.ms / 1000)} giây` : 'quá lâu';
    toast.error(quaHan
      ? `Mạng chậm — ${daCho} chưa tải xong “${file.name}”. Ảnh chưa gắn vào phiếu; bấm Thêm chứng từ để tải lại.`
      : voucherFailureMessage(loiTai, `tải chứng từ “${file.name}”`));
    return null;
  }
  return url;
}

/**
 * DÁN ẢNH TRONG HỘP THOẠI THU/CHI = ĐÍNH ẢNH LÊN PHIẾU, rồi nhận chính file đó
 * làm chứng từ. Một tấm ảnh, một file trong kho, hai bản ghi trỏ về nó.
 *
 * VÌ SAO ĐỔI (chủ báo 27/08/2026): "bấm huỷ chi rồi bấm chi lại thêm ảnh chứng
 * từ nhưng sau đó không thấy ảnh đó trong dòng thu chi". Đường cũ
 * (`uploadFinanceEvidence`) ghi ảnh vào `finance_evidence_objects` với path
 * `v2/<org>/<mid>/<uuid>` — KHÔNG có đuôi file và KHÔNG nằm trong
 * `income_expenses.attachments`, mà mọi chỗ hiển thị (dòng thu chi, chi tiết
 * phiếu, mobile) chỉ đọc `attachments`. Nên ảnh chi xong là biến mất khỏi mắt
 * người dùng dù server vẫn giữ đủ bằng chứng.
 *
 * Đường mới đi bằng hai RPC đã có sẵn, không cần migration:
 *   uploadFile(...)  → publicUrl CÓ ĐUÔI FILE (isImageUrl bắt được ⇒ có thumbnail)
 *   annotate_income_expense_v1(add)      → URL vào attachments ⇒ dòng thu chi thấy ngay
 *   adopt_voucher_attachments_as_evidence_v2 → chính file đó thành evidence FINALIZED
 *
 * ĐƯỜNG LÙI: `annotate` từ chối 42501 khi actor không đủ quyền đính ảnh (vd thủ
 * quỹ giữ sổ khác sổ đang ghi trên phiếu). Lúc đó xoá file vừa tải cho khỏi rác
 * rồi quay về đường cũ — thà ảnh không hiện ở dòng còn hơn chặn người ta chi tiền.
 *
 * TỪ 25/09/2026 hộp Thu/Chi (`IncomeExpensePostingDialog`) KHÔNG dùng hàm này nữa
 * — nó gom ảnh tới lúc xác nhận (`usePostingAttachmentDraft`). Hàm còn phục vụ
 * `SettlementLifecycleModal`, vẫn ghi ngay khi dán (ghi nhận cho đợt 2).
 */
export function useAttachPostingEvidence() {
  const qc = useQueryClient();

  return useCallback(
    async (
      file: File,
      opts: AttachPostingEvidenceOptions,
    ): Promise<AttachPostingEvidenceResult | null> => {
      const bucket = POSTING_ATTACHMENT_BUCKET;
      const url = await uploadPostingAttachmentFile(file, opts.userId);
      if (!url) return null;

      const ann = await rpc("annotate_income_expense_v1", {
        p_voucher: opts.voucherId,
        p_add_attachments: [url],
      });

      if (ann.error) {
        // Kỳ đã đóng là lỗi THẬT — chi cũng sẽ hỏng, nói thẳng thay vì lùi âm thầm.
        const blocked = periodBlockMessage(ann.error.message);
        if (blocked) {
          toast.error(blocked);
          await cleanupOrphanUpload(bucket, url);
          return null;
        }

        // Thiếu quyền đính ảnh lên phiếu → vẫn chi được bằng đường chứng từ cũ.
        await cleanupOrphanUpload(bucket, url);
        const evidenceId = await uploadFinanceEvidence(file, opts.organizationId);
        if (!evidenceId) return null;
        toast.warning(
          "Ảnh đã lưu làm chứng từ chi, nhưng chưa đính được lên phiếu (thiếu quyền sửa) — nó sẽ không hiện ở dòng thu chi.",
        );
        return {
          url: null,
          evidenceIds: [evidenceId],
          skipped: [],
          attachedToVoucher: false,
        };
      }

      // Dòng thu chi phải thấy ảnh NGAY, kể cả khi người dùng bấm Huỷ bỏ sau đó.
      qc.invalidateQueries({ queryKey: ["income-expenses"] });
      qc.invalidateQueries({ queryKey: ["income-expense-batches"] });
      qc.invalidateQueries({ queryKey: ["income-expense"] });
      qc.invalidateQueries({ queryKey: ["voucher-with-batch"] });

      let adopted;
      try {
        adopted = await adoptVoucherAttachmentsAsEvidence(opts.voucherId);
      } catch (error) {
        throw new VoucherPartialError(
          "Ảnh đã đính vào phiếu nhưng chưa kiểm tra được chứng từ. Hãy tải lại phiếu để kiểm tra trước khi thu/chi; không tải lại cùng ảnh.",
          [opts.voucherId], undefined, error,
        );
      }

      return {
        url,
        evidenceIds: adopted.evidenceIds,
        skipped: adopted.skipped,
        attachedToVoucher: true,
      };
    },
    [qc],
  );
}

/** Xoá file vừa tải khi bước sau hỏng — không để lại rác trong kho. Lỗi thì bỏ qua. */
async function cleanupOrphanUpload(bucket: string, publicUrl: string): Promise<void> {
  try {
    const marker = `/object/public/${bucket}/`;
    const idx = publicUrl.indexOf(marker);
    if (idx === -1) return;
    await deleteFile(bucket, decodeURIComponent(publicUrl.slice(idx + marker.length)));
  } catch {
    // Rác một file không đáng để làm hỏng luồng chi tiền.
  }
}

/**
 * Gỡ một ảnh khỏi phiếu ngay trong hộp thoại Thu/Chi. Server chỉ cho NGƯỜI CÓ
 * QUYỀN SỬA thu chi gỡ (gỡ bằng chứng là hành vi sửa, không phải chú thích) —
 * bị từ chối thì báo thật, không giả vờ đã gỡ.
 */
export function useRemovePostingAttachment() {
  const qc = useQueryClient();

  return useCallback(
    async (voucherId: string, url: string): Promise<{ evidenceIds: string[]; skipped: { url: string; reason: string }[] } | null> => {
      const res = await rpc("annotate_income_expense_v1", {
        p_voucher: voucherId,
        p_remove_attachments: [url],
      });
      if (res.error) {
        toast.error(voucherFailureMessage(res.error, "gỡ chứng từ khỏi phiếu"));
        return null;
      }
      qc.invalidateQueries({ queryKey: ["income-expenses"] });
      qc.invalidateQueries({ queryKey: ["income-expense-batches"] });
      qc.invalidateQueries({ queryKey: ["income-expense"] });
      qc.invalidateQueries({ queryKey: ["voucher-with-batch"] });
      try {
        return await adoptVoucherAttachmentsAsEvidence(voucherId);
      } catch (error) {
        throw new VoucherPartialError(
          "Ảnh đã gỡ khỏi phiếu nhưng chưa kiểm tra được chứng từ còn lại. Hãy tải lại phiếu để kiểm tra trước khi thu/chi.",
          [voucherId], undefined, error,
        );
      }
    },
    [qc],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hộp Thu/Chi GOM thay đổi ảnh tới lúc xác nhận (E2, chủ chốt 25/09/2026).
//
// Trước đây dán ảnh = ghi lên phiếu NGAY (useAttachPostingEvidence), gỡ ảnh cũng
// vậy (useRemovePostingAttachment) — bấm Huỷ bỏ thì phiếu đã đổi rồi. Luật mới:
//   dán/thêm  → chỉ tải lên kho, hộp thoại giữ URL trong danh sách chờ;
//   bấm X     → ảnh vừa thêm: xoá file luôn; ảnh cũ của phiếu: chỉ ẩn đi;
//   xác nhận  → MỘT lệnh annotate (thêm + gỡ) → adopt → rồi mới ghi sổ;
//   huỷ/đóng  → xoá đúng các file vừa tải trong lần mở này, phiếu không đổi.
// ─────────────────────────────────────────────────────────────────────────────

/** Thay đổi ảnh đã gom trong hộp Thu/Chi, chờ ghi lên phiếu. */
export interface PostingAttachmentChanges {
  /** Ảnh vừa tải lên kho trong lần mở hộp này. */
  add: string[];
  /** Ảnh đang có trên phiếu mà người dùng bấm X. */
  remove: string[];
}

/**
 * Kết quả ghi ảnh lên phiếu. Kiểu phẳng thay vì union: repo chạy `strict: false`
 * nên `if (res.ok)` không thu hẹp được union.
 */
export interface CommitPostingAttachmentsResult {
  /** Ảnh đã ghi, chỉ bước kiểm chứng từ chưa đọc được. Không xoá ảnh hay ghi sổ. */
  evidenceReadFailed?: boolean;
  ok: boolean;
  /** Toàn bộ chứng từ hợp lệ của phiếu sau khi ghi (rỗng khi `ok=false`). */
  evidenceIds: string[];
  skipped: { url: string; reason: string }[];
  /** Câu báo cho người dùng khi `ok=false`. */
  message: string | null;
  /** Hỏng vì kỳ đã đóng / tháng đã chốt — lỗi THẬT, không có đường lùi. */
  periodBlocked: boolean;
}

/**
 * GHI thay đổi ảnh đã gom lên phiếu — bước đầu của nút xác nhận, TRƯỚC lệnh ghi sổ.
 *
 * Thêm và gỡ đi chung MỘT lệnh `annotate_income_expense_v1` nên phiếu đổi trọn
 * gói hoặc không đổi gì. Sau đó adopt để chính các file trên phiếu thành chứng
 * từ FINALIZED. Thứ tự "ghi ảnh → adopt → ghi sổ" là bắt buộc: lệnh ghi sổ đòi
 * mã chứng từ (không nhận ảnh trong payload), mà adopt chỉ nhận file ĐANG nằm
 * trong `attachments` của phiếu.
 *
 * Không toast: hộp thoại quyết định câu báo và có đi đường lùi hay không.
 */
export async function commitPostingAttachmentChanges(
  voucherId: string,
  changes: PostingAttachmentChanges,
): Promise<CommitPostingAttachmentsResult> {
  const ann = await rpc("annotate_income_expense_v1", {
    p_voucher: voucherId,
    p_add_attachments: changes.add,
    p_remove_attachments: changes.remove,
  });
  if (ann.error) {
    const blocked = periodBlockMessage(ann.error.message);
    return {
      ok: false,
      evidenceIds: [],
      skipped: [],
      message: blocked || voucherFailureMessage(ann.error, "lưu chứng từ lên phiếu"),
      periodBlocked: !!blocked,
    };
  }
  try {
    const adopted = await adoptVoucherAttachmentsAsEvidence(voucherId);
    return { ok: true, evidenceIds: adopted.evidenceIds, skipped: adopted.skipped, message: null, periodBlocked: false };
  } catch (error) {
    console.error("Evidence read failed after attachments were committed:", error);
    return { ok: true, evidenceIds: [], skipped: [], evidenceReadFailed: true, message: "Ảnh đã lưu trên phiếu nhưng chưa kiểm tra được chứng từ. Chưa ghi nhận thu/chi; hãy mở lại phiếu để kiểm tra.", periodBlocked: false };
  }
}

/**
 * Xoá khỏi kho các file đã tải trong một lần mở hộp Thu/Chi mà KHÔNG được ghi
 * lên phiếu (Huỷ bỏ, đóng hộp, gỡ ảnh vừa thêm, hoặc đã chuyển sang đường lùi).
 * Chỉ được gọi với URL do chính lần mở đó tải lên — ảnh có sẵn của phiếu không
 * bao giờ đi qua đây. Lỗi từng file thì bỏ qua (xem `cleanupOrphanUpload`).
 */
export async function discardPostingAttachmentUploads(urls: string[]): Promise<void> {
  await Promise.all(urls.map((u) => cleanupOrphanUpload(POSTING_ATTACHMENT_BUCKET, u)));
}

/**
 * Bộ ba cho hộp Thu/Chi: `upload` chỉ tải lên kho (thư mục theo tài khoản đang
 * đăng nhập), `commit` ghi thay đổi lên phiếu lúc xác nhận rồi làm mới danh sách
 * thu chi, `discard` xoá file vừa tải khi huỷ.
 */
export function usePostingAttachmentDraft() {
  const { data: authUser } = useAuth();
  const qc = useQueryClient();
  const userId = authUser?.id ?? "";

  const upload = useCallback(
    async (file: File): Promise<string | null> => {
      if (!userId) {
        toast.error("Chưa xác định được tài khoản đăng nhập — thử lại sau giây lát.");
        return null;
      }
      return uploadPostingAttachmentFile(file, userId);
    },
    [userId],
  );

  const commit = useCallback(
    async (voucherId: string, changes: PostingAttachmentChanges) => {
      const res = await commitPostingAttachmentChanges(voucherId, changes);
      if (res.ok) {
        // Ảnh đã nằm trên phiếu — dòng thu chi phải thấy ngay, kể cả khi lệnh ghi sổ sau đó lỗi.
        qc.invalidateQueries({ queryKey: ["income-expenses"] });
        qc.invalidateQueries({ queryKey: ["income-expense-batches"] });
        qc.invalidateQueries({ queryKey: ["income-expense"] });
        qc.invalidateQueries({ queryKey: ["voucher-with-batch"] });
      }
      return res;
    },
    [qc],
  );

  return useMemo(
    () => ({ upload, commit, discard: discardPostingAttachmentUploads }),
    [upload, commit],
  );
}
