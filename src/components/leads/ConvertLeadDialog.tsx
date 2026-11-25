import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CreateDepositDialog } from '@/components/deposits/CreateDepositDialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useConvertLeadToDeposit, type LeadWithRelations } from '@/hooks/useLeads';
import { financialPending, pendingHasSettled, type FinancialPendingScope } from '@/lib/financialPending';
import { forgetLeadConversionTrace, resolveLegacyLeadConversion } from '@/lib/leadConversionProgress';
import { legacyWindow } from '@/lib/legacyPendingExit';
import { getSessionUser } from '@/lib/authSession';
import { getLeadDepositIncomeId } from '@/lib/depositIncomeRpc';
import { supabase } from '@/integrations/supabase/client';

const OPERATION = 'chuyển khách hẹn thành đặt cọc';

interface ExistingReceipt {
  id: string | null;
  /** Câu báo riêng khi phiếu là của lần chuyển bản trước (đặc biệt khi chỉ tra gần đúng). */
  note?: string;
  /** Dấu bản trước cần gỡ khi khách hẹn đã chuyển xong. */
  legacy?: { scope: FinancialPendingScope; attemptId: string; requestKey?: string };
}

export function ConvertLeadDialog({open,onOpenChange,lead}: {
  open:boolean; onOpenChange:(open:boolean)=>void; lead:LeadWithRelations
}){
  const {selectedOrganizationId:org}=useOrganization();
  const convert=useConvertLeadToDeposit({silent:true});
  const [recorded,setRecorded]=useState<string|null>(null);
  useEffect(()=>setRecorded(null),[lead.id]);
  const existing=useQuery({
    queryKey:['lead-deposit-income',org,lead.id],enabled:open && !!org,retry:false,staleTime:0,
    queryFn:async():Promise<ExistingReceipt>=>{
      const user=await getSessionUser();
      if(!user||!org)throw new Error('Chưa xác nhận người dùng và tổ chức.');
      // Đợt 7: dấu của luồng chuyển khách hẹn bản trước không còn chặn mãi (xem `leadConversionProgress.ts`).
      const scope:FinancialPendingScope={namespace:'lead-conversion',userId:user.id,organizationId:org,businessKey:lead.id};
      const pending=financialPending.read(scope);
      if(pending){
        const verdict=await resolveLegacyLeadConversion(pending,lead.id,{
          readDeposit:async id=>{
            const {data,error}=await supabase.from('deposits').select('id').eq('id',id).eq('organization_id',org).is('deleted_at',null).maybeSingle();
            if(error)throw error;return data;
          },
          findDeposits:async(tenantId,prior)=>{
            const window=legacyWindow(prior);
            const {data,error}=await supabase.from('deposits').select('id,created_at').eq('tenant_id',tenantId).eq('organization_id',org).is('deleted_at',null)
              .gte('created_at',window.from).lte('created_at',window.to).order('created_at',{ascending:false}).limit(5);
            if(error)throw error;if(!Array.isArray(data))throw new TypeError('Chưa đọc được phiếu cọc của lần chuyển trước.');
            return data.map(row=>row.id);
          },
        });
        const legacy={scope,attemptId:pending.attemptId,requestKey:pending.requestKey};
        if(verdict.kind==='deposit')return {id:verdict.depositId,legacy,note:verdict.exact
          ?`Lần chuyển khách hẹn trước đã ghi phiếu cọc (mã ${verdict.depositId}). Hoàn tất cập nhật trạng thái khách hẹn.`
          :`Có thể lần chuyển khách hẹn trước đã ghi phiếu cọc (mã ${verdict.depositId}). Kiểm tra phiếu ở Quản lý cọc; đúng là phiếu của khách này thì bấm Hoàn tất chuyển đổi, không tạo phiếu khác.`};
        if(verdict.kind==='clear'){
          if(financialPending.clearConfirmed(scope,pending.attemptId))forgetLeadConversionTrace(pending.requestKey);
        }else{
          // Chưa kết luận được: chặn đúng khách hẹn này qua hộp cảnh báo; sau 2 phút người dùng tự gỡ rồi bấm Tải lại.
          const {pendingBlockMessage,pendingValve}=await import('@/lib/pendingValve');
          const record={...pending,operation:pending.operation??OPERATION};
          try{pendingValve.report({pending:record,blockedOperation:OPERATION,store:financialPending});}catch{/* giữ lỗi chính */}
          throw new Error(pendingBlockMessage(record,pendingHasSettled(record)));
        }
      }
      return {id:await getLeadDepositIncomeId(org, lead.id)};
    },
  });
  const settleLegacy=()=>{
    const legacy=existing.data?.legacy;
    if(!legacy)return;
    try{if(financialPending.clearConfirmed(legacy.scope,legacy.attemptId))forgetLeadConversionTrace(legacy.requestKey);}catch{/* dấu cũ không chặn bước đã xong */}
  };
  const finish=async(id:string)=>{
    setRecorded(id);
    await convert.mutateAsync(lead.id);
    onOpenChange(false);
  };
  const id=recorded??existing.data?.id;
  if(!open)return null;
  if(existing.isLoading||existing.isError||id){
    return <Dialog open onOpenChange={onOpenChange}><DialogContent>
      <DialogTitle>Chuyển khách hẹn sang đặt cọc</DialogTitle>
      <DialogDescription>{existing.isError ? (existing.error instanceof Error ? existing.error.message : 'Chưa đọc được chứng từ của khách hẹn.')
        : id ? (recorded ? 'Đã có phiếu cọc. Hoàn tất cập nhật trạng thái khách hẹn.' : existing.data?.note ?? 'Đã có phiếu cọc. Hoàn tất cập nhật trạng thái khách hẹn.') : 'Đang kiểm tra phiếu đã ghi cho khách hẹn.'}</DialogDescription>
      {convert.isError&&<p role="alert">Đã có phiếu cọc. Cập nhật trạng thái khách hẹn chưa thành công.</p>}
      {id?<Button disabled={convert.isPending} onClick={()=>convert.mutate(lead.id, { onSuccess: () => { settleLegacy(); onOpenChange(false); } })}>Hoàn tất chuyển đổi</Button>:
        existing.isError&&<Button onClick={()=>void existing.refetch()}>Tải lại</Button>}
    </DialogContent></Dialog>;
  }
  return <CreateDepositDialog open onOpenChange={onOpenChange} initialRoomId={lead.room_id}
    initialPayer={lead.customer_name??''} receiptRequestKey={'lead-income-'+lead.id} onReceipt={finish}/>;
}
