import {runFinancialPending} from '@/lib/financialPendingAction';
import {useOrganization} from '@/contexts/OrganizationContext';
import {getSessionUser} from '@/lib/authSession';
import {voucherOutcomeUnknown} from '@/lib/voucherFeedback';
// =============================================
// useReconciliations — đối soát/chốt số sổ quỹ (dùng cho sổ chuyển khoản tkHiep).
// 3 mutation gọi RPC SECURITY DEFINER (migration 20260701130000):
//   propose_reconciliation  — chụp số dư hệ thống + số đếm thực; không counterparty
//                             → chốt luôn (CONFIRMED), có counterparty → chờ xác nhận.
//   confirm_reconciliation  — người đối ứng/chủ sổ xác nhận (PENDING → CONFIRMED).
//   cancel_reconciliation   — người tạo/chủ sổ hủy.
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const useInvalidateRecon = () => {
  const qc = useQueryClient();
  return () => {
    for (const key of ['settlement-report', 'cashbook-reconciliations', 'accounts-with-balance']) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  };
};

export interface ProposeReconArgs {
  accountId: string;
  asOf: string;           // yyyy-mm-dd
  countedBalance: number;
  counterpartyId?: string | null;
  note?: string;
}

export function reconciliationReceipt(data:unknown) {
  const row=data && typeof data==='object'?data as Record<string,unknown>:{};
  if(typeof row.id!=='string'||!row.id||!['PENDING','CONFIRMED'].includes(String(row.status))||typeof row.system_balance!=='number'||!Number.isFinite(row.system_balance)||typeof row.diff!=='number'||!Number.isFinite(row.diff)) throw new TypeError('Chưa xác nhận được kết quả đối soát.');
  return row as {id:string;status:'PENDING'|'CONFIRMED';system_balance:number;diff:number};
}

const uncertainReconciliations=new Set<string>();
const reconciliationKey=(accountId:string,asOf:string)=>`${accountId}:${asOf}`;
export const isReconciliationUncertain=(accountId:string,asOf:string)=>uncertainReconciliations.has(reconciliationKey(accountId,asOf));
function stateReceipt(data:unknown,id:string,status:string) {
 const row=data as {id?:unknown;status?:unknown}|null;
 if(!row||row.id!==id||row.status!==status) throw new TypeError('Chưa xác nhận được trạng thái đối soát sau thao tác.');
 return {id,status};
}
export const useProposeReconciliation = () => {
  const invalidate = useInvalidateRecon();
  const {selectedOrganizationId}=useOrganization();
  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async (args: ProposeReconArgs) => {
      if(isReconciliationUncertain(args.accountId,args.asOf)) throw new TypeError("Lần đối soát trước chưa xác nhận. Tải lại danh sách để đối chiếu trước khi tạo tiếp.");
      const user=await getSessionUser();
      return runFinancialPending({namespace:'reconciliation-propose',userId:user?.id??'',organizationId:selectedOrganizationId??'',businessKey:reconciliationKey(args.accountId,args.asOf)},async progress=>{
      const { data, error } = await supabase.rpc('propose_reconciliation', {
        p_account_id: args.accountId,
        p_as_of: args.asOf,
        p_counted_balance: args.countedBalance,
        p_counterparty_id: args.counterpartyId ?? undefined,
        p_note: args.note ?? undefined,
      });
      if (error) throw error;
      const receipt=reconciliationReceipt(data);
      progress.recordCompleted([receipt.id]);
      return receipt;
      });
    },
    onError:(error,args)=>{if(voucherOutcomeUnknown(error))uncertainReconciliations.add(reconciliationKey(args.accountId,args.asOf));},
    onSuccess: invalidate,
  });
};

export const useConfirmReconciliation = () => {
  const invalidate = useInvalidateRecon();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc('confirm_reconciliation', { p_id: id });
      if (error) throw error;
      return stateReceipt(data,id,'CONFIRMED');
    },
    onSuccess: invalidate,
  });
};

// ĐỢT 6 — ĐÃ XOÁ useCreateOpeningAdjustment.
//
// Nó gọi `create_opening_adjustment`, mà Đợt 3 đã REVOKE khỏi `authenticated`
// (ACL trên prod còn mỗi `postgres`) vì hàm đó tự gỡ `lock_date = NULL` giữa
// transaction để lách chính trigger khoá của mình — mẫu bypass không được phép
// tồn tại song song với khoá vĩnh viễn. Giữ hook lại chỉ để UI gọi rồi ăn 42501
// SAU KHI đã kịp ghi một dòng cashbook_reconciliations.
//
// Khoá kỳ giờ đi qua nghi thức hai bên: propose_cashbook_closing_v1 →
// confirm_cashbook_closing_v1 (xem src/hooks/useCashbookClosing.ts), ghi biên
// bản vào app_private.cashbook_closures.

export const useCancelReconciliation = () => {
  const invalidate = useInvalidateRecon();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc('cancel_reconciliation', { p_id: id });
      if (error) throw error;
      return stateReceipt(data,id,'CANCELLED');
    },
    onSuccess: invalidate,
  });
};
