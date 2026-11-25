import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CreateDepositDialog } from '@/components/deposits/CreateDepositDialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useConvertLeadToDeposit, type LeadWithRelations } from '@/hooks/useLeads';
import { financialPending } from '@/lib/financialPending';
import { readLeadConversionTrace } from '@/lib/leadConversionProgress';
import { getSessionUser } from '@/lib/authSession';
import { getLeadDepositIncomeId } from '@/lib/depositIncomeRpc';
import { supabase } from '@/integrations/supabase/client';

export function ConvertLeadDialog({open,onOpenChange,lead}: {
  open:boolean; onOpenChange:(open:boolean)=>void; lead:LeadWithRelations
}){
  const {selectedOrganizationId:org}=useOrganization();
  const convert=useConvertLeadToDeposit({silent:true});
  const [recorded,setRecorded]=useState<string|null>(null);
  useEffect(()=>setRecorded(null),[lead.id]);
  const existing=useQuery({
    queryKey:['lead-deposit-income',org,lead.id],enabled:open && !!org,retry:false,staleTime:0,
    queryFn:async()=>{
      const user=await getSessionUser();
      if(!user||!org)throw new Error('Chưa xác nhận người dùng và tổ chức.');
      const pending=financialPending.read({namespace:'lead-conversion',userId:user.id,organizationId:org,businessKey:lead.id});
      if(pending){
        const trace=readLeadConversionTrace(pending.requestKey);
        if(!trace?.depositId || trace.leadId!==lead.id)throw new Error('Lần chuyển khách hẹn trước cần đối chiếu chứng từ ở Quản lý cọc.');
        const {data,error}=await supabase.from('deposits').select('id').eq('id',trace.depositId).eq('organization_id',org).is('deleted_at',null).maybeSingle();
        if(error||!data)throw new Error('Chưa xác nhận được phiếu cọc cũ của khách hẹn.');
        return data.id;
      }
      return getLeadDepositIncomeId(org, lead.id);
    },
  });
  const finish=async(id:string)=>{
    setRecorded(id);
    await convert.mutateAsync(lead.id);
    onOpenChange(false);
  };
  const id=recorded??existing.data;
  if(!open)return null;
  if(existing.isLoading||existing.isError||id){
    return <Dialog open onOpenChange={onOpenChange}><DialogContent>
      <DialogTitle>Chuyển khách hẹn sang đặt cọc</DialogTitle>
      <DialogDescription>{existing.isError ? (existing.error instanceof Error ? existing.error.message : 'Chưa đọc được chứng từ của khách hẹn.')
        : id ? 'Đã có phiếu cọc. Hoàn tất cập nhật trạng thái khách hẹn.' : 'Đang kiểm tra phiếu đã ghi cho khách hẹn.'}</DialogDescription>
      {convert.isError&&<p role="alert">Đã có phiếu cọc. Cập nhật trạng thái khách hẹn chưa thành công.</p>}
      {id?<Button disabled={convert.isPending} onClick={()=>convert.mutate(lead.id, { onSuccess: () => onOpenChange(false) })}>Hoàn tất chuyển đổi</Button>:
        existing.isError&&<Button onClick={()=>void existing.refetch()}>Tải lại</Button>}
    </DialogContent></Dialog>;
  }
  return <CreateDepositDialog open onOpenChange={onOpenChange} initialRoomId={lead.room_id}
    initialPayer={lead.customer_name??''} receiptRequestKey={'lead-income-'+lead.id} onReceipt={finish}/>;
}
