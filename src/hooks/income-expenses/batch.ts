import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError,isConfirmedFinancialRejection,workflowErrorMessage} from '@/lib/financialWorkflow';
import {financialReadRows} from '@/lib/financialReadValidation';
import {runFinancialPending} from '@/lib/financialPendingAction';
import type {FinancialPendingRecord,PendingReconciliation} from '@/lib/financialPending';
import { VoucherPartialError, voucherFailureMessage, voucherOutcomeUnknown } from "@/lib/voucherFeedback";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { batchChildVoucherName, type IncomeExpenseBatchFormValues } from "@/lib/incomeExpenseValidation";
import type { ImportIncomeExpenseRow } from "./types";
import { loadIncomeExpenseAccountingClassResolver } from "./accountingClass";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg, withOrgAll } from "@/lib/orgPayload";
import { reviseIncomeExpense, VOUCHER_QUERY_KEYS } from "./revisions";
import { revisionErrorMessage } from "@/lib/incomeExpenseRevision";

// Compat gateway V2 (Stage-7b drain): RPC chưa có trong generated types cho tới
// lần regen sau forward-apply — gọi qua cast (mẫu financeV2Mutations.ts).
// Server ép birth UNAPPROVED/PENDING (import/batch hết default-APPROVED — §8).
type CompatRpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};
const compatRpc = (
  fn: string,
  args?: Record<string, unknown>,
): PromiseLike<CompatRpcResult> =>
  (supabase.rpc as unknown as (
    f: string,
    a?: Record<string, unknown>,
  ) => PromiseLike<CompatRpcResult>)(fn, args);

/**
 * Huỷ một danh sách phiếu lẫn lộn THU/CHI, mỗi loại đi ĐÚNG cửa của nó.
 *
 * ie_compat_cancel_v2 từ chối phiếu ĐÃ GHI SỔ ("dùng reversal, không hủy trực
 * tiếp"). Từ Đợt B, phiếu THU tự ghi sổ ngay khi tạo ⇒ mọi đợt có phiếu thu sẽ
 * hỏng nếu vẫn đẩy tất cả vào compat. Phiếu THU đi cửa riêng
 * cancel_income_voucher_v1 (tự đảo bút toán, tự mở lại nợ hoá đơn); phiếu CHI
 * giữ nguyên đường cũ.
 *
 * Trả về số phiếu đã huỷ + danh sách lỗi theo từng phiếu để caller báo cho
 * đúng, thay vì hỏng cả mẻ chỉ vì một phiếu.
 */
async function cancelVouchersSplitByType(
  vouchers: { id: string; type?: string | null }[], reason: string,
  recordCompleted?:(ids:string[])=>void,
): Promise<{ cancelled: number; failures: { id: string; message: string; outcomeUnknown:boolean }[]; completedIds: string[] }> {
  const incomes = vouchers.filter(v => v.type === "INCOME");
  const others = vouchers.filter(v => v.type !== "INCOME");
  const failures: {id:string;message:string;outcomeUnknown:boolean}[] = [];
  const completedIds: string[] = [];
  let cancelled = 0;
  if (others.length) {
    try {
      const {data,error} = await compatRpc("ie_compat_cancel_v2", {p_ids:others.map(v=>v.id),p_reason:reason});
      if (error) throw error;
      const count = (data as {cancelled?:unknown} | null)?.cancelled;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > others.length) throw new TypeError("Missing cancellation receipt");
      if(recordCompleted && count!==others.length){
        const {data:rows,error:readError}=await supabase.from('income_expenses').select('id,approval_status').in('id',others.map(v=>v.id));
        if(readError || !Array.isArray(rows) || others.some(v=>!rows.some(row=>row.id===v.id&&row.approval_status==='CANCELLED')))throw new TypeError('Chưa xác nhận được từng phiếu chi trong đợt đã huỷ.');
      }
      cancelled += count; completedIds.push(...others.map(v=>v.id));
      recordCompleted?.(others.map(v=>v.id));
    } catch(error) {
      failures.push(...others.map(v=>({id:v.id,message:voucherFailureMessage(error,"huỷ phiếu"),outcomeUnknown:!isConfirmedFinancialRejection(error)})));
    }
  }
  for (const v of incomes) {
    try {
      const {data,error} = await compatRpc("cancel_income_voucher_v1", {p_voucher:v.id,p_reason:reason});
      if (error) throw error;
      const receipt = data as {id?:unknown;changed?:unknown} | null;
      if ((recordCompleted&&receipt?.id!==v.id) || typeof receipt?.changed !== "boolean") throw new TypeError("Missing cancellation receipt");
      if (receipt.changed) cancelled++;
      completedIds.push(v.id);
      recordCompleted?.([v.id]);
    } catch(error) { failures.push({id:v.id,message:voucherFailureMessage(error,"huỷ phiếu thu"),outcomeUnknown:!isConfirmedFinancialRejection(error)}); }
  }
  return {cancelled,failures,completedIds};
}

interface ExcelImportResult {
  successCount:number;createdVouchers:Array<{row:number;id:string;code:string|null}>;failedCount:number;errors:Array<{row:number;message:string}>;
}
class ExcelImportUnconfirmed extends TypeError {
  constructor(readonly result:ExcelImportResult){super('Một số dòng Excel chưa được đối chiếu với máy chủ.');}
}
// The compat writer has no server request key. This lock covers unresolved imports
// for the actor/org; identical successful rows remain valid independent vouchers.
const excelSnapshotKey=(userId:string,organizationId:string)=>`ihome:excel-import-pending:v1:${userId}:${organizationId}`;

// Import phiếu thu/chi hàng loạt từ Excel
export const useImportIncomeExpenses = () => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId}=useOrganization();
  const workflow=persistentFinancialWorkflow('voucher-excel-import');

  return useMutation({
    mutationFn: async (
      rows: ImportIncomeExpenseRow[]
    ): Promise<ExcelImportResult> => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      if(rows.some(row=>!Number.isFinite(row.amount)||row.amount<=0))throw new Error('Nhập số tiền hợp lệ lớn hơn 0 ở từng dòng Excel.');
      const snapshotKey=excelSnapshotKey(user.id,selectedOrganizationId??'');
      try { return await workflow.run('excel-import','nhập phiếu từ Excel',async progress=>{
      let successCount = 0;
      const createdVouchers: Array<{ row: number; id: string; code: string | null }> = [];
      let failedCount = 0;
      const errors: Array<{ row: number; message: string }> = [];
      const accountingClassFor =
        await loadIncomeExpenseAccountingClassResolver(
          rows.map((row) => row.income_expense_type_id),
        );

      const unconfirmedRows:number[]=[];
      const failedRows:number[]=[];
      const snapshotRows=rows.map((row,index)=>({sourceRow:row.source_row??index+1,type:row.type,buildingId:row.building_id,itemTypeId:row.income_expense_type_id,voucherDate:row.voucher_date,amount:row.amount}));
      const saveSnapshot=()=>localStorage.setItem(snapshotKey,JSON.stringify({attemptId:progress.requestKey,rows:snapshotRows,createdVouchers,unconfirmedRows,failedRows}));
      saveSnapshot(); // Store real row positions before the first writer, without personal names/notes.
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          // organization_id do server suy (ie_compat_insert_v2 SECURITY DEFINER,
          // strip field client gửi) — không đọc buildings ở client vì RLS chỉ mở
          // cho ai có scope buildings.view, còn Thu/Chi cho phép all_buildings.
          // Phiếu + item trong MỘT call server-side (birth UNAPPROVED — §8).
          const { data: created, error: compatError } = await compatRpc("ie_compat_insert_v2", {
            p_row: {
              user_id: user.id,
              type: row.type,
              name: row.name,
              building_id: row.building_id,
              voucher_date: row.voucher_date,
            },
            p_items: [
              {
                income_expense_type_id: row.income_expense_type_id,
                accounting_class: accountingClassFor(
                  row.income_expense_type_id,
                ),
                description: row.item_name,
                quantity: 1,
                unit_price: row.amount,
              },
            ],
          });

          if (compatError) throw compatError;

          const receipt = created as {id?: string; code?: string} | null;
          if (typeof receipt?.id!=="string"||!receipt.id) throw new TypeError("Chưa xác nhận kết quả: Failed to fetch receipt");
          createdVouchers.push({ row: i + 1, id: receipt.id, code: receipt.code ?? null });
          progress.completed.push({id:receipt.id,label:`Đã tạo phiếu ${receipt.code??receipt.id} từ dòng ${snapshotRows[i].sourceRow}`});
          successCount++;
          saveSnapshot();
        } catch (err: any) {
          failedCount++;
          failedRows.push(snapshotRows[i].sourceRow);
          errors.push({ row: i + 1, message: voucherFailureMessage(err, "nhập phiếu") });
          if(!isConfirmedFinancialRejection(err))unconfirmedRows.push(snapshotRows[i].sourceRow);
          saveSnapshot();
        }
      }

      const result={successCount,failedCount,errors,createdVouchers};
      if(unconfirmedRows.length || (failedCount>0 && createdVouchers.length>0))throw new ExcelImportUnconfirmed(result);
      localStorage.removeItem(snapshotKey);
      return result;
      },undefined,selectedOrganizationId??undefined);
      } catch(error) {
        // Preserve row outcomes for the result screen while the durable guard stays blocked.
        let cause:unknown=error;const seen=new Set<unknown>();
        while(cause && !seen.has(cause)){
          if(cause instanceof ExcelImportUnconfirmed)return cause.result;
          seen.add(cause);cause=typeof cause==='object'?(cause as {cause?:unknown}).cause:undefined;
        }
        if(error instanceof FinancialWorkflowError){
          const raw=localStorage.getItem(snapshotKey);
          if(raw){
            const snapshot=JSON.parse(raw) as {unconfirmedRows?:unknown;failedRows?:unknown};
            const rows=snapshot.failedRows??snapshot.unconfirmedRows;
            if(Array.isArray(rows)&&rows.length>0&&rows.every(row=>Number.isInteger(row)&&row>0))throw new FinancialWorkflowError(`${workflowErrorMessage(error,'nhập phiếu từ Excel')} Dòng Excel chưa hoàn tất: ${rows.join(', ')}.`,error.outcome,error.completed,error);
          }
        }
        throw error;
      }
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["commission-interventions"] });
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      if (result.failedCount > 0) {
        toast.warning(`Đã tạo ${result.successCount} phiếu${result.createdVouchers.length?": "+result.createdVouchers.map(v=>v.code??v.id).join(", "):""}; ${result.failedCount} dòng chưa hoàn tất. Xem lỗi từng dòng và đối chiếu trước khi nhập lại.`);
      } else if (result.successCount > 0) {
        toast.success(`Đã tạo ${result.successCount} phiếu từ Excel. Xem trạng thái từng phiếu trong danh sách thu chi.`);
      } else toast.info("Không có dòng dữ liệu để nhập.");
    },
    onError: (error) => {
      toast.error(error instanceof FinancialWorkflowError ? workflowErrorMessage(error,'nhập phiếu từ Excel') : voucherFailureMessage(error, 'nhập phiếu từ Excel'));
    },
  });
};

/** Dấu ghi từ bản này: mã đợt chính là mã yêu cầu của dấu. Dấu cũ hơn chỉ biết mã đợt khi đã nhận (completedIds[0]). */
const BATCH_ID_FROM_KEY = 'request-key';
/** Lệch giờ trình duyệt ↔ máy chủ chấp nhận khi tra đợt "tạo sau giờ kẹt" (chỉ cho dấu cũ chưa nhận mã đợt). */
const BATCH_CLOCK_SKEW_MS = 60 * 60_000;

/**
 * Đối chiếu lần tạo phiếu tổng chưa rõ kết quả (cách D, đợt 3). Thứ tự bước: đợt → từng phiếu con → nối phiếu vào
 * đợt; lỗi giữa chừng thì huỷ lại phiếu con và xoá đợt. Vì vậy:
 *  - Đợt còn trên máy chủ ⇒ lần trước đã ghi: báo mã đợt, không tạo thêm.
 *  - Đợt chưa từng được nhận mã và không có trên máy chủ ⇒ chưa ghi (lõi chỉ nhận sau 2 phút); gửi lại cùng mã đợt.
 *  - Đợt đã được nhận rồi bị xoá ⇒ lần trước đã tới bước phiếu con: phiếu con còn hiệu lực thì báo mã; không còn
 *    thì vẫn có thể có một phiếu con mất phản hồi mà không biết mã ⇒ chưa kết luận (hộp cảnh báo).
 */
async function reconcileBatchCreate<T>(pending: FinancialPendingRecord, type: string): Promise<PendingReconciliation<T>> {
  const keyed = pending.meta?.batchId === BATCH_ID_FROM_KEY && !!pending.requestKey;
  const batchId = keyed ? pending.requestKey! : pending.completedIds[0];
  if (!batchId) {
    // Dấu cũ chưa nhận mã đợt: mã đợt do máy chủ sinh nên chỉ tra gần đúng (đợt của mình, cùng loại, sau giờ kẹt).
    const since = new Date(Date.parse(pending.startedAt) - BATCH_CLOCK_SKEW_MS).toISOString();
    const { data, error } = await supabase.from('income_expense_batches').select('id, created_at')
      .eq('user_id', pending.userId).eq('type', type).gte('created_at', since).order('created_at', { ascending: true }).limit(5);
    if (error) throw error;
    if (!Array.isArray(data)) throw new TypeError('Chưa đọc được danh sách phiếu tổng để đối chiếu.');
    const ids = (data as { id: string }[]).map(row => row.id);
    if (ids.length) return { outcome: 'already-written', message: `Có thể phiếu tổng đã được tạo ở lần gửi trước (mã đợt ${ids.join(', ')}). Mở danh sách phiếu tổng để kiểm tra trước khi lập lại.`, recordIds: ids };
    return { outcome: 'not-written' };
  }
  const { data: batch, error: batchError } = await supabase.from('income_expense_batches').select('id').eq('id', batchId).maybeSingle();
  if (batchError) throw batchError;
  if (batch) {
    return { outcome: 'already-written', message: `Phiếu tổng đã được tạo ở lần gửi trước (mã đợt ${batchId}). Mở danh sách phiếu tổng để kiểm tra trước khi lập lại.`, recordIds: [batchId] };
  }
  const batchConfirmed = pending.completedIds.includes(batchId);
  if (!batchConfirmed) return { outcome: 'not-written' };
  const childIds = pending.completedIds.filter(id => id !== batchId);
  if (childIds.length) {
    const { data: rows, error } = await supabase.from('income_expenses').select('id, code, approval_status, deleted_at').in('id', childIds);
    if (error) throw error;
    if (!Array.isArray(rows)) throw new TypeError('Chưa đọc được phiếu con để đối chiếu.');
    const live = (rows as { id: string; code: string | null; approval_status: string | null; deleted_at: string | null }[])
      .filter(row => row.approval_status !== 'CANCELLED' && !row.deleted_at);
    if (live.length) {
      const codes = live.map(row => row.code || row.id);
      return { outcome: 'already-written', message: `Phiếu tổng lần trước chưa hoàn tất; còn phiếu con chưa huỷ (mã ${codes.join(', ')}). Kiểm tra và huỷ các phiếu này trước khi lập lại.`, recordIds: codes };
    }
  }
  return null;
}

// Tạo phiếu tổng = INSERT 1 batch + N phiếu con + N junction + N items.
export const useCreateIncomeExpenseBatch = (options: {silent?:boolean} = {}) => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async (input: IncomeExpenseBatchFormValues) => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";
      const accountingClassFor =
        await loadIncomeExpenseAccountingClassResolver(
          input.items.map((item) => item.income_expense_type_id),
        );

      return runFinancialPending({namespace:"voucher-batch-create",userId:user.id,organizationId:selectedOrganizationId ?? "",businessKey:input.type},async progress=>{
      // 1. INSERT batch metadata. Mã đợt = mã yêu cầu của dấu (UUID do trình duyệt sinh): phép đối chiếu tra đúng
      //    đợt theo mã này, và lần gửi lại dùng lại đúng mã nên khoá chính chặn đợt thứ hai (cách D).
      const { data: batch, error: batchError } = await supabase
        .from("income_expense_batches")
        .insert(withOrg({
          id: progress.requestKey,
          user_id: user.id,
          name: input.shared_name,
          type: input.type,
          payer_name: input.payer_name ?? null,
          attachments: input.attachments ?? [],
          notes: input.notes ?? null,
        }, selectedOrganizationId))
        .select()
        .single();

      if (batchError || !batch) {
        throw batchError ?? new Error("Chưa nhận được kết quả tạo đợt phiếu");
      }

      if(!batch.id)throw new TypeError("Chưa xác nhận mã đợt phiếu");
      progress.recordCompleted([batch.id]);
      // 2. Tạo N phiếu con qua ie_compat_insert_v2 (phiếu + item atomic mỗi
      //    call, birth UNAPPROVED — §8). Tạo TỪNG phiếu để giữ thứ tự rõ ràng
      //    (tương ứng với items input). Nếu lỗi ở giữa: rollback bằng cách xoá
      //    batch (CASCADE xoá junction) + huỷ phiếu con đã tạo.
      // Mang theo `type`: rollback phải biết phiếu nào đi cửa THU, phiếu nào đi
      // đường compat cũ (cả đợt cùng một type nên gán thẳng từ input).
      const childVouchers: { id: string; type?: string | null }[] = [];
      try {
        for (const item of input.items) {
          const { data: created, error: voucherError } = await compatRpc(
            "ie_compat_insert_v2",
            {
              p_row: {
                user_id: user.id,
                creator_name: creatorName,
                type: input.type,
                name: batchChildVoucherName(input.shared_name, item),
                building_id: item.building_id,
                room_id: item.room_id ?? null,
                account_id: input.account_id,
                payer_name: input.payer_name ?? null,
                attachments: input.attachments ?? [],
                business_result_accounting: input.business_result_accounting ?? null,
                voucher_date: input.voucher_date,
                repeat_cycle: "NONE",
                repeat_infinity: false,
                repeat_count: 0,
                repeat_remaining: 0,
              },
              p_items: [
                {
                  income_expense_type_id: item.income_expense_type_id,
                  accounting_class: accountingClassFor(item.income_expense_type_id),
                  description: item.description ?? null,
                  quantity: item.quantity,
                  unit_price: item.unit_price,
                  start_date: item.start_date ?? null,
                  end_date: item.end_date ?? null,
                },
              ],
            },
          );

          const voucherId = (created as { id?: string } | null)?.id;
          if (voucherError || !voucherId) {
            throw voucherError ?? new Error("Không thể tạo phiếu con");
          }
          childVouchers.push({ id: voucherId, type: input.type });
          progress.recordCompleted([voucherId]);
        }

        // 3. INSERT junction rows (bảng batch_items — ngoài phạm vi drain).
        const linkRows = childVouchers.map((v) => ({
          batch_id: (batch as any).id,
          income_expense_id: v.id,
        }));
        const { error: linkError } = await supabase
          .from("income_expense_batch_items")
          .insert(withOrgAll(linkRows, selectedOrganizationId));
        if (linkError) throw linkError;
      } catch (error: unknown) {
        // Keep all receipts even if compensation fails; the user must reconcile,
        // never blindly create the whole batch again after a multi-step failure.
        let cancelled = 0;
        let cleanupFailed = false;
        try {
          if (childVouchers.length > 0) {
            const cleanup = await cancelVouchersSplitByType(childVouchers, "Rollback tạo phiếu tổng lỗi");
            cancelled = cleanup.cancelled;
            cleanupFailed = cleanup.failures.length > 0 || cleanup.cancelled !== childVouchers.length;
          }
          // Đọc lại đúng một dòng bị xoá: RLS có thể xoá 0 dòng mà không báo lỗi.
          const removed = await supabase.from("income_expense_batches").delete().eq("id", (batch as any).id).select("id");
          cleanupFailed ||= !!removed.error || !Array.isArray(removed.data) || removed.data.length !== 1;
        } catch { cleanupFailed = true; }
        // Bước hỏng bị từ chối rõ (không ghi gì) và mọi bước trước đã được dọn, kiểm lại: không còn gì chờ đối chiếu.
        // Gỡ dấu để người dùng sửa lỗi rồi lập lại ngay. Bước hỏng chưa rõ kết quả thì có thể còn một phiếu con chưa
        // biết mã, nên vẫn giữ dấu.
        if (!cleanupFailed && isConfirmedFinancialRejection(error)) {
          progress.releaseCompleted();
          throw new FinancialWorkflowError(
            `Chưa tạo được đợt phiếu: ${voucherFailureMessage(error, "tạo đợt phiếu")} Các phiếu con đã tạo (${cancelled}) đã được huỷ lại và đợt đã được xoá; sửa lỗi rồi lập lại.`,
            "failure", [], error,
          );
        }
        throw new VoucherPartialError(
          `Chưa hoàn tất đợt phiếu. Đã nhận kết quả tạo ${childVouchers.length} phiếu, đã huỷ lại ${cancelled} phiếu.${cleanupFailed ? " Chưa xác nhận được việc dọn toàn bộ đợt." : ""} Hãy kiểm tra danh sách phiếu trước khi lập đợt mới.`,
          childVouchers.map(v => v.id), (batch as any).id, error,
        );
      }

      return { batch, voucherCount: childVouchers.length, voucherIds: childVouchers.map(v=>v.id) };
      },undefined,{operation:'tạo phiếu tổng',meta:{batchId:BATCH_ID_FROM_KEY},reconcile:pending=>reconcileBatchCreate(pending,input.type)});
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["commission-interventions"] });
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      if (!options.silent) toast.success(`Đã tạo ${result.voucherCount} phiếu trong một đợt. Xem trạng thái từng phiếu trong danh sách thu chi.`);
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["commission-interventions"] });
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      console.error("Error creating income expense batch:", error);
      if (!options.silent) toast.error(voucherFailureMessage(error, "tạo đợt phiếu"));
    },
  });
};

class BatchCancelUnconfirmed extends TypeError {
  constructor(readonly result:{count:number;failures:{id:string;message:string;outcomeUnknown:boolean}[];completedIds:string[]}){super('Một số phiếu trong đợt chưa được đối chiếu.');}
}
// Huỷ tất cả phiếu con của 1 batch (1 click)
export const useCancelIncomeExpenseBatch = () => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId}=useOrganization();
  const workflow=persistentFinancialWorkflow('voucher-batch-cancel');

  return useMutation({
    mutationFn: async (input: { batchId: string; reason: string }) => {
      const { batchId, reason } = input;
      if (reason.trim().length < 8 || reason.trim().length > 2000) throw new Error("Nhập lý do huỷ cả đợt từ 8 đến 2.000 ký tự.");
      try {return await workflow.run(batchId,'huỷ đợt phiếu',async progress=>{
      // 1. Lấy danh sách voucher_id thuộc batch
      const { data: links, error: linkError } = await supabase
        .from("income_expense_batch_items")
        .select("income_expense_id")
        .eq("batch_id", batchId);
      if (linkError) {
        throw linkError;
      }
      const ids = financialReadRows<any>(links).map((l) => l.income_expense_id);
      if (ids.length === 0) return { count: 0, failures: [], completedIds: [] };

      // 2. Đọc (read-only) các phiếu còn hiệu lực để biết payment_id cần
      //    cascade xoá; sau đó huỷ qua ie_compat_cancel_v2 (Stage-7: client
      //    không còn UPDATE trực tiếp income_expenses). Phiếu đã POSTED (ghi
      //    sổ V2) sẽ bị server từ chối — dùng reversal thay vì huỷ.
      const { data: vouchers, error: readError } = await supabase
        .from("income_expenses")
        .select("id, type, payment_id")
        .in("id", ids)
        .neq("approval_status", "CANCELLED");
      if (readError) {
        throw readError;
      }
      const activeVouchers = financialReadRows<any>(vouchers);
      if (activeVouchers.length === 0) return { count: 0, failures: [], completedIds: [] };

      const { cancelled, failures, completedIds } = await cancelVouchersSplitByType(
        activeVouchers,
        reason.trim(),
        ids=>progress.completed.push(...ids.map(id=>({id,label:`Đã huỷ phiếu ${id}`}))),
      );

      // Phiếu THU đã được server gỡ khoản thanh toán bên trong
      // cancel_income_voucher_v1 (đánh dấu reversed_at, hoá đơn tự mở lại nợ).
      // Chỉ còn phiếu CHI đường cũ mới cần client dọn payments hộ.
      const paymentIdsToDelete = activeVouchers
        .filter((v) => v.type !== "INCOME" && v.payment_id && !failures.some(f => f.id === v.id))
        .map((v) => v.payment_id);
      if (paymentIdsToDelete.length > 0) {
        const { error: payErr } = await supabase
          .from("payments")
          .delete()
          .in("id", paymentIdsToDelete);
        if (payErr) {
          throw new VoucherPartialError(`Đã huỷ ${cancelled} phiếu nhưng chưa cập nhật được thanh toán hoá đơn. Hãy kiểm tra phiếu và hoá đơn liên quan trước khi thao tác tiếp.`, activeVouchers.filter(v => !failures.some(f => f.id === v.id)).map(v => v.id), batchId, payErr);
        }
      }

      const result={count:cancelled,failures,completedIds};
      if(failures.some(failure=>failure.outcomeUnknown))throw new BatchCancelUnconfirmed(result);
      return result;
      },undefined,selectedOrganizationId??undefined);
      } catch(error) {
        let cause:unknown=error;const seen=new Set<unknown>();
        while(cause && !seen.has(cause)){
          if(cause instanceof BatchCancelUnconfirmed)return cause.result;
          seen.add(cause);cause=typeof cause==='object'?(cause as {cause?:unknown}).cause:undefined;
        }
        if(error instanceof FinancialWorkflowError && error.completed.length)throw new VoucherPartialError(workflowErrorMessage(error,'huỷ đợt phiếu'),error.completed.map(step=>step.id),batchId,error);
        throw error;
      }
    },
    onSuccess: ({ count, failures }) => {
      queryClient.invalidateQueries({ queryKey: ["commission-interventions"] });
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice"] });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice-statistics"] });
      queryClient.invalidateQueries({ queryKey: ["utility-payments"] });
      if (failures?.length) toast.warning(`Đã huỷ ${count} phiếu; ${failures.length} phiếu chưa huỷ được. Kiểm tra lại từng phiếu trước khi thực hiện tiếp.`);
      else if (count === 0) toast.info("Không còn phiếu nào trong đợt cần huỷ. Không có thay đổi mới.");
      else toast.success(`Đã huỷ ${count} phiếu trong đợt.`);
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["commission-interventions"] });
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.error(error instanceof FinancialWorkflowError?workflowErrorMessage(error,'huỷ đợt phiếu'):voucherFailureMessage(error, 'huỷ đợt phiếu'));
      console.error("Error cancelling income expense batch:", error);
    },
  });
};

// Đổi sổ quỹ đồng loạt cho các phiếu con CHỜ DUYỆT của một đợt (UI "Sửa sổ quỹ ở
// phiếu tổng" — chỉ hiện khi mọi phiếu con đang cùng một sổ). Mỗi phiếu là một
// lần sửa có lưu vết (revise_pending_income_expense_v1) với cùng một lý do.
// Đợt có phiếu đã duyệt thì từ chối CẢ ĐỢT trước khi ghi gì: đổi một nửa là đợt
// lệch sổ. Phiếu đã huỷ bỏ qua.
const batchAccountIssues=new Map<string,unknown>();
export const getBatchAccountIssue=(batchId:string)=>batchAccountIssues.get(batchId);

export const useUpdateBatchAccount = () => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId}=useOrganization();
  const workflow=persistentFinancialWorkflow('voucher-batch-account');

  return useMutation({
    mutationFn: async (input: { batchId: string; accountId: string; reason: string }) => {
      const { batchId, accountId, reason } = input;
      try {return await workflow.run(batchId,'đổi sổ quỹ cho đợt phiếu',async progress=>{

      const { data: links, error: linkError } = await supabase
        .from("income_expense_batch_items")
        .select("income_expense_id")
        .eq("batch_id", batchId);
      if (linkError) {
        throw linkError;
      }
      const ids = financialReadRows(links).map((l) => l.income_expense_id);
      if (ids.length === 0) return { count: 0 };

      const { data: rows, error: rowsError } = await supabase
        .from("income_expenses")
        .select("id, code, approval_status, approval_version, account_id")
        .in("id", ids);
      if (rowsError) {
        throw rowsError;
      }
      const live = financialReadRows(rows).filter((r) => r.approval_status !== "CANCELLED");
      const daDuyet = live.filter((r) => r.approval_status !== "UNAPPROVED");
      if (daDuyet.length > 0) {
        const message =
          `Đợt có ${daDuyet.length} phiếu đã duyệt (${daDuyet.slice(0, 3).map((r) => r.code).join(", ")}` +
          `${daDuyet.length > 3 ? "…" : ""}) — chỉ đổi sổ được khi mọi phiếu còn Chờ duyệt.`;
        throw new FinancialWorkflowError(message,'failure',[]);
      }


      let count = 0;
      const completedIds: string[] = [];
      for (const r of live) {
        if (r.account_id === accountId) continue;
        try {
          const result = await reviseIncomeExpense({
            voucherId: r.id,
            expectedApprovalVersion: Number(r.approval_version),
            patch: { account_id: accountId },
            reason,
            idempotencyKey:`${progress.requestKey}:${r.id}`,
          });
          if(result.id!==r.id)throw new TypeError('Chưa xác nhận được đúng phiếu vừa đổi sổ.');
          if (result.changed) { count++; completedIds.push(r.id); progress.completed.push({id:r.id,label:`Đã đổi sổ phiếu ${r.code??r.id}`}); }
        } catch (error) {
          if(!completedIds.length && isConfirmedFinancialRejection(error))throw error;
          throw new VoucherPartialError(`${r.code}: ${revisionErrorMessage(error)} Đã đổi sổ cho ${count} phiếu trước đó. Hãy kiểm tra đợt phiếu trước khi tiếp tục.`, completedIds, batchId, error);
        }
      }

      return { count };
      },undefined,selectedOrganizationId??undefined);
      }catch(error){
        if(error instanceof FinancialWorkflowError && error.completed.length)throw new VoucherPartialError(workflowErrorMessage(error,'đổi sổ quỹ cho đợt phiếu'),error.completed.map(step=>step.id),batchId,error);
        throw error;
      }
    },
    onSuccess: ({ count }) => {
      for (const key of VOUCHER_QUERY_KEYS) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      if (count === 0) toast.info("Các phiếu đã dùng sổ quỹ này. Không có thay đổi mới.");
      else toast.success(`Đã đổi sổ quỹ cho ${count} phiếu trong đợt.`);
    },
    onError: (error,input) => {
      if(error instanceof VoucherPartialError||voucherOutcomeUnknown(error)) batchAccountIssues.set(input.batchId,error);
      // Đổi dở dang vẫn phải làm mới màn hình: vài phiếu đầu có thể đã đổi.
      for (const key of VOUCHER_QUERY_KEYS) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      console.error("Error updating batch account:", error);
      toast.error(error instanceof FinancialWorkflowError?workflowErrorMessage(error,'đổi sổ quỹ cho đợt phiếu'):voucherFailureMessage(error, 'đổi sổ quỹ cho đợt phiếu'));
    },
  });
};
