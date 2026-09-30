import {useRef} from 'react';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError,workflowErrorMessage,type FinancialWorkflowGuard,type FinancialWorkflowProgress} from '@/lib/financialWorkflow';
import { VoucherPartialError, voucherFailureMessage } from "@/lib/voucherFeedback";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { isIeLifecycleFallbackSignal } from "@/lib/canonicalFallback";
import { todayISO } from '@/lib/collect';
import { rpcNullable } from "@/lib/rpcNullable";
import { approveCheckedVoucher } from "@/hooks/income-expenses/revisions";

type RpcError = { code?: string | null; message?: string | null };
type RpcResult = { data?: unknown; error: RpcError | null };

// GOTCHA: KHÔNG gán tách `supabase.rpc` ra biến (mất `this` → "reading 'rest'").
// Luôn gọi qua member expression để giữ binding.
const callUnregisteredRpc = (
  name: string,
  args: Record<string, unknown>,
): Promise<RpcResult> =>
  (supabase.rpc as unknown as (
    n: string,
    a: Record<string, unknown>,
  ) => Promise<RpcResult>)(name, args);

const isTerminationForfeitRpcUnavailable = (error: RpcError) => {
  if (error.code === "PGRST202") return true;
  if (error.code !== "42883") return false;

  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes("set_termination_forfeit_status_v1") &&
    message.includes("does not exist")
  );
};

const TERMINATION_FORFEIT_SYSTEM_SOURCES = new Set([
  "termination.forfeit_revenue",
  "termination.forfeit_offset",
]);
const TERMINATION_FORFEIT_LEGACY_MARKER = "[CẤN CỌC BỎ CỌC";

/**
 * Phiên bản duyệt hiện tại của phiếu, để gửi kèm làm CAS.
 *
 * Trả `null` khi KHÔNG ĐỌC ĐƯỢC (lỗi mạng, RLS giấu dòng, cột chưa có) —
 * server hiểu null là "không CAS" và giữ nguyên hành vi cũ. Đây là chỗ CỐ Ý
 * không dùng `?? 1`: bịa số 1 sẽ khớp với mọi phiếu chưa ai động tới, rồi sai
 * đúng vào lúc phiếu đã bị thay đổi — tức đúng lúc CAS phải bắt.
 */
const readApprovalVersion = async (id: string): Promise<number | null> => {
  const { data, error } = await supabase
    .from("income_expenses")
    .select("approval_version")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const raw = (data as { approval_version?: unknown }).approval_version;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
};

const isConfidentlyOrdinaryVoucher = async (id: string) => {
  const { data, error } = await supabase
    .from("income_expenses")
    .select("system_source, notes")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;

  const row = data as { system_source?: unknown; notes?: unknown };
  if (!("system_source" in row) || !("notes" in row)) return false;
  const rawSystemSource = row.system_source;
  const rawNotes = row.notes;
  if (rawSystemSource !== null && typeof rawSystemSource !== "string") {
    return false;
  }
  if (rawNotes !== null && typeof rawNotes !== "string") return false;
  const systemSource = typeof rawSystemSource === "string" ? rawSystemSource : "";
  const notes = typeof rawNotes === "string" ? rawNotes : "";

  return !(
    TERMINATION_FORFEIT_SYSTEM_SOURCES.has(systemSource) ||
    notes.startsWith(TERMINATION_FORFEIT_LEGACY_MARKER)
  );
};

const TERMINATION_FORFEIT_QUERY_KEYS = [
  ["invoices"],
  ["invoices-legacy"],
  ["invoice"],
  ["invoice-history"],
  ["invoice-vouchers"],
  ["invoice-statistics"],
  ["invoice-totals-by-ids"],
  ["first-invoice-details"],
  ["invoice-collectors"],
  ["unpaid-invoices"],
  ["ie-related-invoice"],
  ["room-latest-invoice"],
  ["payments"],
  ["payments-summary"],
  ["invoice-payments-summary"],
  ["dashboard-summary"],
  ["dashboard-alerts"],
  ["recent-activities"],
  ["deposit-dashboard"],
  ["cash-book"],
  ["cash-book-summary"],
  ["cash-flow-by-day"],
  ["settlement-report"],
  ["financial-analysis"],
  ["reports"],
  ["monthly-building-profit"],
  ["profit-verification"],
] as const;

const invalidateTerminationForfeitQueries = (
  queryClient: ReturnType<typeof useQueryClient>,
) => {
  for (const queryKey of TERMINATION_FORFEIT_QUERY_KEYS) {
    queryClient.invalidateQueries({ queryKey });
  }
};

const trySetTerminationForfeitStatus = async (
  id: string,
  status: "APPROVED" | "UNAPPROVED" | "CANCELLED",
) => {
  const { error } = await callUnregisteredRpc(
    "set_termination_forfeit_status_v1",
    { p_voucher_id: id, p_status: status },
  );
  if (!error) return true;
  if (isTerminationForfeitRpcUnavailable(error)) {
    if (await isConfidentlyOrdinaryVoucher(id)) return false;
    throw error;
  }
  if (
    error.code === "55000" &&
    error.message?.includes("not a termination forfeit pair")
  ) {
    return false;
  }
  throw error;
};

const runVoucherLifecycle = async <T,>(workflow:FinancialWorkflowGuard,id:string,operation:string,task:(progress:FinancialWorkflowProgress)=>Promise<T>) => {
  try{return await workflow.run(id,operation,task);}
  catch(error){
    if(error instanceof FinancialWorkflowError && error.completed.length){
      const prior=error.cause instanceof VoucherPartialError?error.cause:undefined;
      const ids=error.completed.map(step=>step.id);
      throw new VoucherPartialError(prior?`${prior.message} Mã đã nhận: ${ids.join(', ')}.`:workflowErrorMessage(error,operation),ids,undefined,prior?.cause??error.cause);
    }
    throw error;
  }
};
const completedVoucher=(progress:FinancialWorkflowProgress,id:string,label:string)=>{
  if(!progress.completed.some(step=>step.id===id))progress.completed.push({id,label});
};
const requireCancelReceipt=(data:unknown,id:string)=>{
  const row=data as {id?:unknown;changed?:unknown}|null;
  if(row?.id!==id || typeof row.changed!=='boolean')throw new TypeError('Chưa xác nhận được trạng thái huỷ của đúng phiếu.');
  return row.changed;
};

// Duyệt phiếu thu/chi (UNAPPROVED → APPROVED). Dùng khi đã thực thanh toán
// phiếu nháp (vd phiếu chi hoa hồng tạo cùng hợp đồng).
//
// Luôn kèm phiên bản đang xem (đợt 1 sửa phiếu, 25/09/2026): một RPC
// approve_pending_income_expense_checked_v1 làm đủ thang ba bậc (cặp bỏ cọc →
// canonical → legacy) dưới khoá dòng và so approval_version — phiếu vừa bị sửa
// ⇒ PT409 "tải lại", người duyệt không duyệt nhầm một nội dung chưa xem. Thang
// ba bậc phía client (không kiểm phiên bản) đã gỡ cùng đợt.
export type ApproveVoucherInput = { id: string; expectedApprovalVersion: number };

export const useApproveVoucher = () => {
  const workflow=useRef(persistentFinancialWorkflow('voucher-lifecycle',{scope:'actor'})).current;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ApproveVoucherInput) => runVoucherLifecycle(workflow,input.id,'duyệt phiếu',async progress=>{
      const result=await approveCheckedVoucher({voucherId:input.id,expectedApprovalVersion:input.expectedApprovalVersion});
      if(result.id!==input.id || result.approved!==true || (result.mode!==undefined && !['VOUCHER','FORFEIT_PAIR'].includes(result.mode)))throw new TypeError('Chưa xác nhận được kết quả duyệt của đúng phiếu.');
      completedVoucher(progress,input.id,`Đã duyệt phiếu ${input.id}`);
      return result;
    }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["voucher-with-batch"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-revisions"] });
      if (result.mode === "FORFEIT_PAIR") {
        invalidateTerminationForfeitQueries(queryClient);
      }
      if (result.already) toast.info("Phiếu đã được duyệt trước đó. Không có thay đổi mới.");
      else toast.success("Đã duyệt phiếu. Hãy xem trạng thái thu/chi trên phiếu.");
    },
    onError: (error) => {
      console.error("Error approving voucher:", error);
      toast.error(error instanceof FinancialWorkflowError?workflowErrorMessage(error,"duyệt phiếu") : voucherFailureMessage(error,"duyệt phiếu"));
    },
  });
};

// Huỷ duyệt phiếu thu/chi (APPROVED → UNAPPROVED, về lại Nháp). Chỉ super admin
// (hoặc người tạo) — RPC unapprove_voucher tự kiểm quyền (user_id = auth.uid()
// OR is_super_admin()). Dùng khi cần sửa lại phiếu đã ghi nhận.
export const useUnapproveVoucher = () => {
  const workflow=useRef(persistentFinancialWorkflow('voucher-lifecycle',{scope:'actor'})).current;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => runVoucherLifecycle(workflow,id,'bỏ duyệt phiếu',async progress=>{
      if (await trySetTerminationForfeitStatus(id, "UNAPPROVED")) {
        await readStatusReceipt(id,'UNAPPROVED');completedVoucher(progress,id,`Đã bỏ duyệt phiếu ${id}`);return true;
      }

      // CAS (H3.2): server khoá dòng rồi so approval_version. Trang gọi hook
      // chỉ đưa được `id`, nên phiên bản phải đọc ở đây. Đọc-rồi-CAS vẫn đóng
      // đúng khoảng hở cần đóng — mọi thay đổi xen vào giữa lần đọc này và
      // lệnh ghi đều làm phép so lệch và bị từ chối.
      //
      // Đọc hỏng ⇒ KHÔNG gửi tham số ⇒ server dùng DEFAULT NULL ⇒ bỏ qua CAS.
      // CỐ Ý không bịa `?? 1`: một số bịa biến phép SO thành lời KHẲNG ĐỊNH
      // sai, và nó sai đúng vào lúc phiếu đã bị người khác động vào — tức đúng
      // lúc CAS phải bắt.
      //
      // `?? undefined` chứ không phải `null`: từ 16/09/2026 types.ts sinh lại
      // từ catalog thật khai `p_expected_approval_version?: number` (tham số
      // CÓ DEFAULT). Bỏ hẳn khoá khỏi payload và gửi null đều dẫn tới cùng một
      // chỗ trong thân hàm — nhánh `IS NOT NULL` không chạy — nên hành vi
      // không đổi, chỉ khác ở việc tsc kiểm được kiểu thay vì phải ép.
      const expectedApprovalVersion = await readApprovalVersion(id);

      const { error } = await supabase.rpc("unapprove_voucher", {
        voucher_id: id,
        p_expected_approval_version: expectedApprovalVersion ?? undefined,
      });
      if (error) {
        // Phiếu canonical bị đóng băng vòng đời (Phương án A): không quay về
        // Nháp được — hướng dẫn Huỷ + Tạo bản sao thay vì lỗi kỹ thuật khó hiểu.

        throw error;
      }
      await readStatusReceipt(id,'UNAPPROVED');completedVoucher(progress,id,`Đã bỏ duyệt phiếu ${id}`);
      return false;
    }),
    onSuccess: (isTerminationForfeit) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["voucher-with-batch"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      if (isTerminationForfeit) {
        invalidateTerminationForfeitQueries(queryClient);
      }
      toast.success("Đã chuyển phiếu về Chờ duyệt");
    },
    onError: (error) => {
      console.error("Error unapproving voucher:", error);
      toast.error(error instanceof FinancialWorkflowError?workflowErrorMessage(error,"bỏ duyệt phiếu") : voucherFailureMessage(error,"bỏ duyệt phiếu"));
    },
  });
};

// Huỷ phiếu thu/chi: đổi trạng thái sang CANCELLED. Nếu là phiếu INCOME mirror
// từ thanh toán hoá đơn (có payment_id), cũng xoá payment row tương ứng để
// trigger recompute invoice paid_amount/status (qua trigger DB).
export const useCancelIncomeExpense = () => {
  const workflow=useRef(persistentFinancialWorkflow('voucher-lifecycle',{scope:'actor'})).current;
  const queryClient = useQueryClient();

  return useMutation({
    // Nhận id thuần (mọi caller cũ) hoặc {id, reason} — reason ghi vào bút toán
    // hoàn tác khi huỷ phiếu ĐÃ GHI SỔ (plan: huỷ sau-chi phải có bằng chứng).
    mutationFn: async (input: string | { id: string; reason?: string | null }) => {
      const id = typeof input === "string" ? input : input.id;
      const reason = typeof input === "string" ? null : (input.reason ?? null);
      return runVoucherLifecycle(workflow,id,'huỷ phiếu',async progress=>{
      let reversed=false;
      if (await trySetTerminationForfeitStatus(id, "CANCELLED")) {
        await readStatusReceipt(id,'CANCELLED');completedVoucher(progress,id,`Đã huỷ phiếu ${id}`);return true;
      }

      // Đợt 4 — NHÁNH LINH HOẠT ĐỨNG TRƯỚC. Một transaction: đảo bút toán +
      // đóng phiếu + ghi dấu vết, KHÔNG sinh phiếu đối ứng.
      //
      // Không cần hỏi cờ chế độ ở client: cứ thử, server tự từ chối bằng
      // [STRICT_MODE] (org đang bật Chuẩn kế toán) hoặc [NOT_MANUAL] (phiếu
      // thuộc luồng khác) và mình rơi xuống thang cũ. Nhờ vậy cờ cũ trong cache
      // client không bao giờ làm sai hành vi.
      //
      // Chỉ thử khi có lý do đủ dài — writer bắt buộc ≥8 ký tự để còn đối soát.
      if (reason && reason.trim().length >= 8) {
        const flex = await supabase.rpc("cancel_income_expense_flex_v1", {
          p_voucher: id,
          p_reason: reason.trim(),
          p_expected_approval_version: undefined,
          p_expected_posting_version: undefined,
        });
        if (!flex.error) {
          const changed=requireCancelReceipt(flex.data,id);completedVoucher(progress,id,`Đã huỷ phiếu ${id}`);return changed?false:"unchanged" as const;
        }
        const flexMsg = flex.error.message ?? "";
        const canFallBack =
          flexMsg.includes("[STRICT_MODE]") || flexMsg.includes("[NOT_MANUAL]");
        if (!canFallBack) {

          throw flex.error;
        }
      }

      const { data: voucher, error: fetchErr } = await (supabase
        .from("income_expenses") as any)
        .select("id, type, payment_id, approval_status, account_id, posting_status")
        .eq("id", id)
        .maybeSingle();
      if (fetchErr) {

        throw fetchErr;
      }

      if(!voucher || voucher.id!==id)throw new FinancialWorkflowError('Chưa đọc được đúng phiếu cần huỷ. Tải lại phiếu trước khi tiếp tục.','failure',[]);

      // Finance V2 §2.2: phiếu ĐÃ GHI SỔ không huỷ trực tiếp — HOÀN TÁC trước
      // (posting event REVERSAL trả tiền về sổ, giữ dấu vết) rồi mới huỷ.
      // posting_status chưa vào generated types → đọc qua cast.
      const postingStatus = (voucher as { posting_status?: string | null })
        ?.posting_status;
      if (postingStatus === "POSTED") {
        const rev = await supabase.rpc(
          "reverse_posted_income_expense_v2",
          {
            p_voucher: id,
            p_cashbook: voucher?.account_id ?? null,
            p_posted_on: todayISO(),
            p_reason: reason || "Hoàn tác để huỷ phiếu",
            p_idempotency_key: progress.requestKey,
          },
        );
        if (rev.error) throw rev.error;
        const receipt=rev.data as {voucherId?:unknown;postingStatus?:unknown}|null;
        if(receipt?.voucherId!==id || receipt.postingStatus!=='REVERSED')throw new TypeError('Chưa xác nhận được hoàn tác của đúng phiếu.');
        reversed=true;completedVoucher(progress,id,`Đã hoàn tác phiếu ${id}`);
        progress.stage='huỷ phiếu sau hoàn tác';
      }

      try {
      // Canonical cancel (phiếu flow-owned): transition + audit hash-chain
      // server-side, KHÔNG đụng payments (phiếu canonical không gắn payment).
      // Phiếu legacy → tín hiệu fallback → giữ nguyên đường cũ bên dưới.
      // `cancel_income_expense_v1(p_reason text DEFAULT NULL)` — không lý do thì
      // bỏ hẳn khoá, server tự lấy DEFAULT NULL (đúng giá trị đang gửi).
      const canonical = await supabase.rpc("cancel_income_expense_v1", {
        p_voucher_id: id,
        p_reason: reason ?? undefined,
      });
      if (!canonical.error) {
        // cancel_income_expense_v1 RETURNS void: read the exact target, never invent a JSON receipt.
        await readStatusReceipt(id,'CANCELLED');completedVoucher(progress,id,`Đã huỷ phiếu ${id}`);
        return voucher.approval_status==='CANCELLED'?"unchanged" as const:false;
      }
      // 7ac: phiếu do FLOW HỆ THỐNG sở hữu (vd Hoàn tiền hoá đơn) — cancel v1
      // từ chối 'owned by system flow'; huỷ qua dispatcher §8 (release
      // reservation atomic), KHÔNG rơi xuống compat.
      if (/owned by system flow/i.test(canonical.error.message ?? "")) {
        const owned = await supabase.rpc(
          "decide_owned_income_expense_v2",
          {
            p_voucher: id,
            p_decision: "cancel",
            // `p_reason text` KHÔNG có DEFAULT ⇒ bắt buộc truyền, nhưng NULL là
            // giá trị hợp lệ (huỷ không kèm lý do). Bộ sinh không diễn đạt được.
            p_reason: rpcNullable(reason),
            p_idempotency_key: progress.requestKey,
          },
        );
        if (owned.error) {

          throw owned.error;
        }
        await readStatusReceipt(id,'CANCELLED');completedVoucher(progress,id,`Đã huỷ phiếu ${id}`);
        return false;
      }
      // Phiếu đã duyệt/đã hoàn tác: cancel v1 từ chối (chỉ nhận pending của
      // maker) — KHÔNG phải lỗi chặn, rơi xuống compat cancel (tự cấp token).
      const approvedShape =
        voucher?.approval_status === "APPROVED" ||
        postingStatus === "POSTED" ||
        postingStatus === "REVERSED";
      if (!isIeLifecycleFallbackSignal(canonical.error) && !approvedShape) {

        throw canonical.error;
      }

      // Stage-7 drain: huỷ phiếu legacy qua RPC ie_compat_cancel_v2 (client hết
      // UPDATE trực tiếp income_expenses). Phiếu đã POSTED (ghi sổ V2) bị server
      // từ chối 55000 — dùng reversal thay vì huỷ trực tiếp.
      const { data:compatData,error } = await callUnregisteredRpc("ie_compat_cancel_v2", {
        p_ids: [id],
        p_reason: reason,
      });
      if (error) {
        // 7ac: phiếu do FLOW HỆ THỐNG sở hữu (vd Hoàn tiền hoá đơn) — cả cancel
        // v1 lẫn compat đều từ chối; huỷ qua dispatcher §8 (release reservation).
        if (/owned by system flow/i.test(error.message ?? "")) {
          const owned = await supabase.rpc(
            "decide_owned_income_expense_v2",
            {
              p_voucher: id,
              p_decision: "cancel",
              // Như trên: bắt buộc-nhưng-nhận-NULL.
              p_reason: rpcNullable(reason),
              p_idempotency_key: progress.requestKey,
            },
          );
          if (owned.error) {

            throw owned.error;
          }
          await readStatusReceipt(id,'CANCELLED');completedVoucher(progress,id,`Đã huỷ phiếu ${id}`);
          return false;
        }
        throw error;
      }
      const cancelled=(compatData as {cancelled?:unknown}|null)?.cancelled;
      if(cancelled!==1)await readStatusReceipt(id,'CANCELLED');
      completedVoucher(progress,id,`Đã huỷ phiếu ${id}`);

      if (voucher?.type === "INCOME" && voucher?.payment_id) {
        const { error: payErr } = await supabase
          .from("payments")
          .delete()
          .eq("id", voucher.payment_id);
        if (payErr) {

          throw new VoucherPartialError("Phiếu đã huỷ nhưng chưa cập nhật được thanh toán hoá đơn. Hãy kiểm tra phiếu và hoá đơn liên quan; không huỷ lại phiếu.", [id], undefined, payErr);
        }
      }

      // Ghi nhật ký thao tác HUỶ (best-effort — không chặn nếu log lỗi).
      // T3 audit-monopoly: RPC log chỉ nhận NOTE/CANCELLED_NOTE/MANUAL_LOG —
      // client không được tự dập sự kiện lifecycle 'CANCELLED' (chỉ transition
      // engine được ghi). CANCELLED_NOTE là alias chuẩn cho huỷ-đường-legacy.
      await supabase.rpc("log_income_expense_action", {
        p_id: id,
        p_action: "CANCELLED_NOTE",
        p_note: undefined,
      });
      return false;
      } catch (error) {
        if (error instanceof VoucherPartialError) throw error;
        if (reversed) throw new VoucherPartialError("Đã hoàn tác lần thu/chi nhưng chưa xác nhận huỷ phiếu. Hãy tải lại phiếu và kiểm tra sổ quỹ trước khi thực hiện tiếp.", [id], undefined, error);
        throw error;
      }
      });
    },
    onSuccess: (isTerminationForfeit) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["voucher-with-batch"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice"] });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice-statistics"] });
      // Huỷ phiếu điện/nước từ Thu chi phải làm mới màn "Đóng điện nước" ngay
      // trên thiết bị thao tác (đối xứng usePayUtilityBill.onSuccess). Hub
      // realtime lo cross-client; đây lo tức thì cho client hiện tại.
      queryClient.invalidateQueries({ queryKey: ["utility-payments"] });
      if (isTerminationForfeit === true) {
        invalidateTerminationForfeitQueries(queryClient);
      }
      if (isTerminationForfeit === "unchanged") toast.info("Phiếu đã được huỷ trước đó. Không có thay đổi mới.");
      else toast.success("Đã huỷ phiếu.");
    },
    onError: (error) => {
      if (error instanceof VoucherPartialError) {
        for (const key of ["income-expenses", "income-expense", "accounts-with-balance", "invoices", "payments"]) queryClient.invalidateQueries({ queryKey: [key] });
      }
      console.error("Error cancelling income expense:", error);
      toast.error(error instanceof FinancialWorkflowError?workflowErrorMessage(error,"huỷ phiếu") : voucherFailureMessage(error,"huỷ phiếu"));
    },
  });
};

// Writer acknowledgement and the exact target's authoritative status are separate evidence.
const readStatusReceipt = async (id:string,expectedApproval?:'UNAPPROVED'|'APPROVED'|'CANCELLED') => {
  try {
    const {data,error}=await supabase.from('income_expenses').select('id,code,approval_status,posting_status,verified_at').eq('id',id).maybeSingle();
    if(error || !data || data.id!==id)throw new TypeError('Chưa đọc được trạng thái của đúng phiếu sau thao tác.');
    if(expectedApproval && data.approval_status!==expectedApproval)throw new TypeError('Chưa xác nhận được trạng thái yêu cầu của phiếu.');
    if(data.approval_status!==undefined && !['UNAPPROVED','APPROVED','CANCELLED'].includes(String(data.approval_status)))throw new TypeError('Trạng thái duyệt phiếu chưa xác định.');
    if(data.posting_status!==undefined && !['UNPOSTED','POSTED','REVERSED','NOT_APPLICABLE'].includes(String(data.posting_status)))throw new TypeError('Trạng thái thu/chi phiếu chưa xác định.');
    return data;
  } catch(error) {
    throw Object.assign(new TypeError('Đã gửi yêu cầu nhưng chưa xác nhận được trạng thái phiếu. Đối chiếu trước khi thao tác tiếp.'),{cause:error});
  }
};

// Khôi phục phiếu thu/chi đã huỷ (CANCELLED → APPROVED). CHỈ super admin —
// RPC restore_income_expense tự kiểm quyền (is_super_admin). Với phiếu THU theo
// hoá đơn đã mất payment khi huỷ, RPC tạo lại payment (chặn trùng) để hoá đơn
// trở lại đã thu. Thao tác được ghi vào nhật ký (income_expense_audit_log).
export const useRestoreIncomeExpense = () => {
  const workflow=useRef(persistentFinancialWorkflow('voucher-lifecycle',{scope:'actor'})).current;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => runVoucherLifecycle(workflow,id,'khôi phục phiếu',async progress=>{
      const { error } = await supabase.rpc("restore_income_expense", {
        p_id: id,
      });
      if (error) {
        // Phiếu canonical đã huỷ là terminal (Phương án A) → dùng Tạo bản sao.

        throw error;
      }
      const receipt=await readStatusReceipt(id);
      if(!['UNAPPROVED','APPROVED'].includes(String(receipt.approval_status)))throw new TypeError('Chưa xác nhận trạng thái khôi phục phiếu.');
      completedVoucher(progress,id,`Đã khôi phục phiếu ${id}`);return receipt;
    }),
    onSuccess: (data, id) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["voucher-with-batch"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice"] });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice-statistics"] });
      queryClient.invalidateQueries({ queryKey: ["ie-history", id] });
      if (!data) toast.warning("Đã thực hiện khôi phục nhưng chưa đọc được trạng thái phiếu. Tải lại danh sách để kiểm tra trước khi thao tác tiếp.");
      else if (data.posting_status === "POSTED") toast.success(`Đã khôi phục phiếu ${data.code}. Phiếu đã ghi nhận thu/chi vào sổ quỹ.`);
      else if (data.approval_status === "UNAPPROVED") toast.success(`Đã khôi phục phiếu ${data.code}. Phiếu đang chờ duyệt.`);
      else toast.success(`Đã khôi phục phiếu ${data.code}. Hãy xem trạng thái thu/chi trong danh sách.`);
    },
    onError: (error) => {
      console.error("Error restoring income expense:", error);
      if(error instanceof FinancialWorkflowError && error.outcome!=="failure")toast.warning(workflowErrorMessage(error,"khôi phục phiếu"));
      else toast.error(voucherFailureMessage(error,"khôi phục phiếu"));
    },
  });
};

// Đánh dấu "đã kiểm" / bỏ kiểm phiếu thu/chi. Toggle theo trạng thái hiện tại
// (RPC tự xử lý logic + check quyền). Note rỗng → lưu NULL.
export const useVerifyIncomeExpense = () => {
  const workflow=useRef(persistentFinancialWorkflow('voucher-lifecycle',{scope:'actor'})).current;
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; note: string | null }) => runVoucherLifecycle(workflow,input.id,'cập nhật trạng thái đã kiểm',async progress=>{
      // Canonical verify (phiếu flow-owned, token-wrapped); legacy fallback.
      // `p_note text DEFAULT NULL` ở cả hai RPC: bỏ ghi chú thì bỏ luôn khoá,
      // server lấy DEFAULT NULL — vẫn là "note rỗng → lưu NULL" như trước.
      const canonical = await supabase.rpc("verify_income_expense_v1", {
        p_id: input.id,
        p_note: input.note ?? undefined,
      });
      if (!canonical.error) {
        const receipt=await readStatusReceipt(input.id);
        if(receipt.verified_at!==null && (typeof receipt.verified_at!=='string' || !Number.isFinite(Date.parse(receipt.verified_at))))throw new TypeError('Chưa xác nhận được trạng thái đã kiểm.');
        completedVoucher(progress,input.id,`Đã cập nhật trạng thái đã kiểm phiếu ${input.id}`);return receipt;
      }
      if (!isIeLifecycleFallbackSignal(canonical.error)) {

        throw canonical.error;
      }

      const { error } = await supabase.rpc("verify_income_expense", {
        p_id: input.id,
        p_note: input.note ?? undefined,
      });
      if (error) {

        throw error;
      }
      const receipt=await readStatusReceipt(input.id);
      if(receipt.verified_at!==null && (typeof receipt.verified_at!=='string' || !Number.isFinite(Date.parse(receipt.verified_at))))throw new TypeError('Chưa xác nhận được trạng thái đã kiểm.');
      completedVoucher(progress,input.id,`Đã cập nhật trạng thái đã kiểm phiếu ${input.id}`);return receipt;
    }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["voucher-with-batch"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      if (!data || !("verified_at" in data)) toast.warning("Đã thực hiện cập nhật nhưng chưa đọc được trạng thái đã kiểm. Tải lại phiếu để kiểm tra, không bấm đổi trạng thái thêm lần nữa.");
      else toast.success(data.verified_at ? `Đã đánh dấu phiếu ${data.code} là đã kiểm.` : `Đã bỏ đánh dấu đã kiểm của phiếu ${data.code}.`);
    },
    onError: (error) => {
      console.error("Error verifying income expense:", error);
      if(error instanceof FinancialWorkflowError && error.outcome!=="failure")toast.warning(`${workflowErrorMessage(error,"cập nhật trạng thái đã kiểm")} Không bấm đổi trạng thái thêm lần nữa.`);
      else toast.error(voucherFailureMessage(error,"cập nhật trạng thái đã kiểm"));
    },
  });
};
