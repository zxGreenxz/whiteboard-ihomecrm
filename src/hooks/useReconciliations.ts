import {runFinancialPending} from '@/lib/financialPendingAction';
import {FinancialAlreadyRecordedError} from '@/lib/financialWorkflowError';
import {useOrganization} from '@/contexts/OrganizationContext';
import {getSessionUser} from '@/lib/authSession';
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

const reconciliationKey=(accountId:string,asOf:string)=>`${accountId}:${asOf}`;
/** Dấu từ đợt 10a: mã yêu cầu của dấu đã lên máy chủ làm `p_request_key`. Dấu bản trước không có. */
const CO_MA='request-key-v1';
/** Cửa sổ tra đề nghị "tạo sau giờ kẹt" (giờ máy có thể lệch giờ máy chủ). Đề nghị đã gắn sổ và ngày nên cửa sổ rộng chỉ làm
 * báo "có thể đã tạo" nhiều hơn, không làm gửi trùng. */
const CLOCK_SKEW_MS=24*60*60_000;
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
      const user=await getSessionUser();
      let resend=false;
      return runFinancialPending({namespace:'reconciliation-propose',userId:user?.id??'',organizationId:selectedOrganizationId??'',businessKey:reconciliationKey(args.accountId,args.asOf)},async progress=>{
      // Đợt 10a: propose_reconciliation nhận mã yêu cầu tuỳ chọn (migration 20261126130735, md5 prosrc a264d586…): khoá theo
      // sổ rồi mới giữ mã kèm băm nội dung; cùng mã cùng nội dung trả lại đúng dòng đã tạo, khác nội dung 23505. Tham số
      // dựng trong biến: kiểu sinh tự động còn chưa có `p_request_key` cho tới khi sinh lại sau khi áp production.
      const params={
        p_account_id: args.accountId,
        p_as_of: args.asOf,
        p_counted_balance: args.countedBalance,
        p_counterparty_id: args.counterpartyId ?? undefined,
        p_note: args.note ?? undefined,
        p_request_key: progress.requestKey,
      };
      const { data, error } = await supabase.rpc('propose_reconciliation', params);
      // Gửi lại cùng mã mà máy chủ báo mã đã dùng với nội dung khác: lần trước ĐÃ tạo đề nghị (với số đếm/ghi chú cũ).
      // Chỉ nhận đúng lỗi «mã đã dùng» của hàm này; DETAIL là mã dòng đã có (chỉ nhận một mã gọn).
      if (resend && error && String((error as {code?:unknown}).code??'')==='23505' && (error as {hint?:unknown}).hint==='reconciliation_request_key_payload_mismatch') {
        const details=String((error as {details?:unknown}).details??'');
        throw new FinancialAlreadyRecordedError('Đề nghị đối soát này đã được tạo ở lần gửi trước (nội dung lúc đó khác nội dung đang gửi). Mở danh sách đối soát để kiểm tra trước khi tạo lại.',/^[0-9a-z-]{1,64}$/i.test(details)?[details]:[]);
      }
      if (error) throw error;
      const receipt=reconciliationReceipt(data);
      progress.recordCompleted([receipt.id]);
      return receipt;
      },undefined,{operation:'đề nghị đối soát sổ',meta:{dedupe:CO_MA},reconcile:async pending=>{
        if(pending.completedIds.length)return {outcome:'already-written',message:'Đề nghị đối soát này đã được tạo ở lần gửi trước.',recordIds:pending.completedIds};
        // Dấu từ đợt 10a: lần trước đã gửi đúng mã này ⇒ gửi lại ngay cùng mã (cách B): máy chủ chờ lệnh cũ còn chạy, rồi
        // trả lại dòng đã tạo hoặc báo mã đã dùng với nội dung khác.
        if(pending.meta?.dedupe===CO_MA&&pending.requestKey){resend=true;return {outcome:'not-written',serverDedupesRequestKey:true};}
        // Dấu bản trước (mã yêu cầu chưa từng lên máy chủ): tra gần đúng theo sổ, ngày, người đề nghị, tạo sau giờ kẹt —
        // lối ra một lần. Thấy thì chỉ báo "có thể đã tạo", không tự gửi; không thấy thì lõi chỉ cho gửi lại khi lần trước
        // đã quá 2 phút.
        const since=new Date(Date.parse(pending.startedAt)-CLOCK_SKEW_MS).toISOString();
        const {data,error}=await supabase.from('cashbook_reconciliations').select('id,status,created_at')
          .eq('account_id',args.accountId).eq('as_of_date',args.asOf).eq('proposed_by',pending.userId)
          .gte('created_at',since).order('created_at',{ascending:false}).limit(5);
        if(error)throw error;
        if(!Array.isArray(data))throw new TypeError('Chưa đọc được danh sách đối soát để đối chiếu.');
        const ids=(data as {id?:unknown}[]).map(row=>row.id).filter((id):id is string=>typeof id==='string'&&!!id);
        if(ids.length)return {outcome:'already-written',message:`Có thể đề nghị đối soát đã được tạo ở lần gửi trước (mã ${ids.join(', ')}). Mở danh sách đối soát để kiểm tra trước khi tạo lại.`,recordIds:ids};
        return {outcome:'not-written'};
      }});
    },
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
