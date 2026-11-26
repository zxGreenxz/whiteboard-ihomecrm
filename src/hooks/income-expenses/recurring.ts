import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError,workflowErrorMessage} from '@/lib/financialWorkflow';
import { voucherFailureMessage } from "@/lib/voucherFeedback";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// (Workflow Duyệt/Bỏ duyệt đã bị loại bỏ — phiếu mặc định APPROVED khi tạo,
//  Huỷ thì set CANCELLED qua useCancelIncomeExpense.)

// Dừng lặp lại cho 1 phiếu GỐC: giữ nguyên phiếu + các phiếu con đã sinh,
// chỉ ngừng sinh phiếu con tương lai.
//
// PHẢI ĐI RPC, KHÔNG ĐƯỢC .from().update() — đây là chỗ đã hỏng thật.
//   Migration 20260723070000 REVOKE UPDATE của `authenticated` trên
//   income_expenses; nhánh direct-DML cũ ở đây bị bỏ sót khỏi đợt dọn caller,
//   nên nút này trả 403 "permission denied for table income_expenses" suốt từ
//   23/07 tới lúc người dùng báo (27/08/2026). Lỗi kiểu này không có gì trong
//   repo bắt được ngoài gate check-money-table-dml — TypeScript không có gì để
//   nói, vì lời gọi hoàn toàn hợp lệ về kiểu.
//
// Đợt 8 (luật 5): ie_stop_recurring_v1 (production 26/11/2026) khoá phiếu FOR UPDATE rồi đặt repeat_cycle='NONE' (giá trị
// tuyệt đối); phiếu đã dừng thì trả {changed:false}, không ghi nhật ký. Gửi lại cho cùng kết quả nên không giữ dấu «chờ đối
// chiếu» nào: chưa rõ kết quả ⇒ báo rõ, bấm lại máy chủ trả «không đổi». Dấu bản trước (phạm vi người dùng) gỡ sau khi xong.
export const useStopRecurring = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // Nạp động: tệp này chưa từng nạp tĩnh module đó (cửa bundle-inventory).
      const { repeatableWrite } = await import('@/lib/recordWriteOutcome');
      const receipt = await repeatableWrite('dừng lặp phiếu', async () => {
        const {data,error} = await supabase.rpc("ie_stop_recurring_v1", { p_id: id });
        if (error) throw error;
        const row=data as {id?:unknown;changed?:unknown}|null;
        if(row?.id!==id || typeof row.changed!=='boolean')throw new FinancialWorkflowError('Chưa xác nhận đúng phiếu đã dừng lặp.','unknown',[{id,label:'Phiếu cần đối chiếu'}]);
        return {id,changed:row.changed};
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'voucher-recurring-stop', businessKey: id }, { organizationId: 'actor-scope' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần dừng sau gỡ lại. */ }
      return receipt;
    },
    onError: (error) => toast.error(error instanceof FinancialWorkflowError?workflowErrorMessage(error,'dừng lặp phiếu'):voucherFailureMessage(error,'dừng lặp phiếu')),
    onSuccess: (receipt) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["voucher-with-batch"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense"] });
      if(!receipt.changed)toast.info("Phiếu đã dừng lặp trước đó (có thể từ lần bấm trước). Không có thay đổi mới.");
      else toast.success("Đã dừng lặp lại cho phiếu này");
    },
  });
};

export type RecurringVoucherRow = { parent_id: string; child_id: string; voucher_date: string };
/** `resent`: lượt này là lần gửi lại sau một lần bấm chưa rõ kết quả (phiếu lần đó tạo, nếu có, không nằm trong danh sách). */
export type GeneratedRecurringVouchers = RecurringVoucherRow[] & { resent?: boolean };

// Sinh các phiếu lặp lại tới hôm nay (RPC). TIỀN: giữ dấu «chờ đối chiếu», cách A.
//   generate_recurring_vouchers (production 26/11/2026, md5 c63e6e44…) chỉ sinh kỳ (phiếu cha, ngày kỳ) CHƯA có phiếu con
//   nào, kể cả phiếu con đã xoá mềm; chỉ mục duy nhất uniq_ie_repeat_child_date (repeat_parent_id, voucher_date) WHERE
//   deleted_at IS NULL chặn phiếu con thứ hai kể cả khi hai lệnh chạy song song (mỗi phiếu con bọc EXCEPTION, trùng thì bỏ
//   qua). Chạy lại vì thế chỉ sinh phần còn thiếu: dấu của lần gửi trước luôn được gửi lại NGAY, không chờ 2 phút, không
//   chặn mãi. Dấu vẫn giữ để chặn bấm lần hai khi lần đầu còn chạy trong tab.
export const useGenerateRecurringVouchers = () => {
  const workflow=persistentFinancialWorkflow("voucher-recurring-generate",{scope:"actor"});
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<GeneratedRecurringVouchers> => {
      let resent=false;
      return workflow.run('generate','sinh phiếu định kỳ',async progress=>{
        // RBAC v2: không cần p_user_id; v2 tự lookup các owner caller được phép.
        const { data, error } = await supabase.rpc("generate_recurring_vouchers_v2");
        if (error) throw error;
        if(!Array.isArray(data)||data.some(row=>typeof row?.child_id!=='string'||!row.child_id||typeof row?.parent_id!=='string'||!row.parent_id))throw new TypeError("Chưa xác nhận các phiếu định kỳ vừa tạo");
        for(const row of data)progress.completed.push({id:row.child_id,label:`Đã tạo phiếu định kỳ ${row.child_id}`});
        const rows=data as RecurringVoucherRow[];
        return resent?Object.assign([...rows],{resent:true}):rows;
      },async()=>{resent=true;return {outcome:'not-written',serverDedupesRequestKey:true};});
    },
    onError: (error) => toast.error(error instanceof FinancialWorkflowError?workflowErrorMessage(error,'sinh phiếu định kỳ'):voucherFailureMessage(error,'sinh phiếu định kỳ')),
    onSuccess: (rows) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["voucher-with-batch"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      if (rows.length === 0) toast.info(rows.resent
        ? "Không còn phiếu định kỳ nào đến hạn. Phiếu do lần bấm trước tạo (nếu có) đã nằm trong danh sách thu chi; không tạo thêm."
        : "Không có phiếu định kỳ đến hạn. Không tạo phiếu mới.");
      else toast.success(`Đã tạo ${rows.length} phiếu định kỳ. Xem trạng thái từng phiếu trong danh sách thu chi.`);
    },
  });
};
