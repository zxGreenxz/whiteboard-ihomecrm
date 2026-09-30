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
export const useStopRecurring = () => {
  const workflow=persistentFinancialWorkflow("voucher-recurring-stop",{scope:"actor"});
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => workflow.run(id,'dừng lặp phiếu',async progress=>{
      const {data,error} = await supabase.rpc("ie_stop_recurring_v1", { p_id: id });
      if (error) {

        throw error;
      }
      const receipt=data as {id?:unknown;changed?:unknown}|null;
      if(receipt?.id!==id || typeof receipt.changed!=='boolean')throw new TypeError('Chưa xác nhận đúng phiếu đã dừng lặp.');
      progress.completed.push({id,label:`Đã dừng lặp phiếu ${id}`});return {id,changed:receipt.changed};
    }),
    onError: (error) => toast.error(error instanceof FinancialWorkflowError?workflowErrorMessage(error,'dừng lặp phiếu'):voucherFailureMessage(error,'dừng lặp phiếu')),
    onSuccess: (receipt) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["voucher-with-batch"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense"] });
      if(!receipt.changed)toast.info("Phiếu đã dừng lặp trước đó. Không có thay đổi mới.");
      else toast.success("Đã dừng lặp lại cho phiếu này");
    },
  });
};

// Sinh các phiếu lặp lại tới hôm nay (RPC).
export const useGenerateRecurringVouchers = () => {
  const workflow=persistentFinancialWorkflow("voucher-recurring-generate",{scope:"actor"});
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => workflow.run('generate','sinh phiếu định kỳ',async progress=>{
      // RBAC v2: không cần p_user_id; v2 tự lookup các owner caller được phép.
      const { data, error } = await supabase.rpc("generate_recurring_vouchers_v2");
      if (error) {

        throw error;
      }
      if(!Array.isArray(data)||data.some(row=>typeof row?.child_id!=='string'||!row.child_id||typeof row?.parent_id!=='string'||!row.parent_id))throw new TypeError("Chưa xác nhận các phiếu định kỳ vừa tạo");
      for(const row of data)progress.completed.push({id:row.child_id,label:`Đã tạo phiếu định kỳ ${row.child_id}`});
      return data as Array<{ parent_id: string; child_id: string; voucher_date: string }>;
    }),
    onError: (error) => toast.error(error instanceof FinancialWorkflowError?workflowErrorMessage(error,'sinh phiếu định kỳ'):voucherFailureMessage(error,'sinh phiếu định kỳ')),
    onSuccess: (rows) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["voucher-with-batch"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      if (rows.length === 0) toast.info("Không có phiếu định kỳ đến hạn. Không tạo phiếu mới.");
      else toast.success(`Đã tạo ${rows.length} phiếu định kỳ. Xem trạng thái từng phiếu trong danh sách thu chi.`);
    },
  });
};
