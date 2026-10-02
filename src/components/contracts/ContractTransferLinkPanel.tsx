import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { InlineSkeleton, LoadingState } from '@/components/loading/LoadingState';
import { Input } from '@/components/ui/input';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useAccounts } from '@/hooks/useAccounts';
import { canUse } from '@/lib/permissionPages';
import { useContractTransferLinks,useCancelContractTransferLink,useCreateContractTransferCommission } from '@/hooks/contracts/useContractTransferLinks';
import { transferErrorMessage,type ContractTransferLink,type TransferFilter } from '@/lib/contract-lifecycle/transfers';
import type { ContractExitCase } from '@/lib/contractExitCases';
import type { ContractDraft } from '@/lib/contractDrafts';
import { ContractTransferLinkDialog } from './ContractTransferLinkDialog';

export interface ContractTransferLinkPanelProps extends TransferFilter {exitCase?:ContractExitCase;draft?:ContractDraft;canEdit?:boolean;onOpenDraft?:(id:string)=>void}
const labels:Record<ContractTransferLink['money_state'],string>={INDEPENDENT:'Cọc mới và quyết toán cũ xử lý độc lập',NEEDS_REVIEW:'Cần xử lý tiền nhượng',FEE_PENDING:'Chờ quyết toán phí nhượng tại hồ sơ cũ',COMMISSION_PENDING:'Phí đã quyết toán · Chờ ký / nối phiếu môi giới',COMMISSION_LINKED:'Đã nối phiếu môi giới hiện hành'};
const events:Record<string,string>={CREATED:'Lập liên kết',CANCELLED:'Hủy liên kết',NEW_SIGNED:'Ký hợp đồng mới',FEE_APPLIED:'Đưa phí nhượng vào quyết toán',COMMISSION_LINKED:'Nối phiếu môi giới'};
const voucherStatuses:Record<string,string>={UNAPPROVED:'Chờ duyệt',APPROVED:'Đã duyệt',CANCELLED:'Đã hủy'};
function TransferCommissionDialog({link,onClose}:{link:ContractTransferLink;onClose:()=>void}){
  const {selectedOrganizationId}=useOrganization();const accounts=useAccounts();const save=useCreateContractTransferCommission();
  const [accountId,setAccountId]=useState('');const [bank,setBank]=useState('');const [number,setNumber]=useState('');const [request]=useState(()=>crypto.randomUUID());
  return <Dialog open onOpenChange={open=>{if(!open&&!save.isPending)onClose();}}><DialogContent><DialogHeader><DialogTitle>Nối phiếu môi giới</DialogTitle><DialogDescription>{link.broker_name} · {link.broker_fee?.toLocaleString('vi-VN')} đ. Phiếu được tạo hoặc nối qua nghiệp vụ hiện hành; trạng thái duyệt và chi theo chứng từ.</DialogDescription></DialogHeader>
    <label className="space-y-1 text-sm"><span>Sổ quỹ (tùy chọn)</span>{accounts.isLoading&&<InlineSkeleton label="sổ quỹ" width="5rem" className="ml-2"/>}<select aria-label="Sổ quỹ" className="flex h-10 w-full rounded-md border bg-background px-3" value={accountId} onChange={event=>setAccountId(event.target.value)} disabled={save.isPending}><option value="">Theo nghiệp vụ hiện hành</option>{accounts.data?.filter(x=>x.organization_id===selectedOrganizationId&&!x.is_virtual).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
    {accounts.isError&&<p role="alert" className="text-sm">Không tải được sổ quỹ. <Button variant="link" onClick={()=>void accounts.refetch()}>Thử lại</Button></p>}
    <label className="space-y-1 text-sm"><span>Ngân hàng người nhận (tùy chọn)</span><Input value={bank} onChange={event=>setBank(event.target.value)} maxLength={200}/></label>
    <label className="space-y-1 text-sm"><span>Số tài khoản người nhận (tùy chọn)</span><Input value={number} onChange={event=>setNumber(event.target.value)} maxLength={200}/></label>
    {save.isError&&<p role="alert" className="text-sm text-destructive">{transferErrorMessage(save.error)}</p>}
    <Button disabled={save.isPending} onClick={()=>save.mutate({linkId:link.id,expectedVersion:link.version,requestId:request,accountId:accountId||null,recipientBank:bank||null,recipientAccount:number||null},{onSuccess:onClose})}>{save.isPending?'Đang nối phiếu…':'Lập / nối phiếu hiện hành'}</Button>
  </DialogContent></Dialog>;
}
function TransferRow({link,canEdit,onOpenDraft}:{link:ContractTransferLink;canEdit:boolean;onOpenDraft?: (id:string)=>void}){
  const cancel=useCancelContractTransferLink();const [cancelReason,setCancelReason]=useState('');const [commissionOpen,setCommissionOpen]=useState(false);
  const [cancelRequest]=useState(()=>crypto.randomUUID());
  return <article className="space-y-2 rounded border p-3 text-sm">
    <p className="font-medium">{link.state==='CANCELLED'?'Đã hủy liên kết':'Nhượng'} · {link.mode==='BROKER'?'Qua môi giới':'Khách tự tìm'} · {link.old_customer_name??'Khách cũ'} → {link.new_customer_name}</p>
    <div className="flex flex-wrap gap-3"><Link className="underline" to={`/contracts/${link.old_contract_id}`}>Hồ sơ cũ {link.old_contract_number}</Link>{link.new_contract_id?<Link className="underline" to={`/contracts/${link.new_contract_id}`}>Hợp đồng mới {link.new_contract_number}</Link>:onOpenDraft?<Button className="h-auto p-0" variant="link" onClick={()=>onOpenDraft(link.new_draft_id)}>Mở nháp v{link.new_draft_revision}</Button>:<span>Nháp mới v{link.new_draft_revision} · Chưa ký</span>}</div>
    <p>{link.term_mode==='KEEP_OLD_END_DATE'?'Giữ hạn cũ':'Kỳ hạn mới'}: {link.starts_on} → {link.ends_on}</p>
    {link.state==='LINKED'&&<p className={link.money_state==='NEEDS_REVIEW'?'font-medium text-destructive':''}>{labels[link.money_state]}</p>}
    {link.deposit_mode==='OLD_DEPOSIT_OFFSET'&&<p>Cấn cọc mới chỉ là lựa chọn đã lưu; chưa chuyển cọc, chưa ký được theo nhánh này.</p>}
    {link.mode==='BROKER'&&<p>Môi giới: {link.broker_name}{link.deposit_base!==null&&<> · Cọc cũ {link.deposit_base.toLocaleString('vi-VN')} đ · Phí 50% {link.broker_fee?.toLocaleString('vi-VN')} đ trước khấu trừ khác</>}</p>}
    {link.commission_voucher_id&&<p>Phiếu {link.commission_code??link.commission_voucher_id.slice(0,8)} · {voucherStatuses[link.commission_approval_status??'']??'Xem trạng thái trên phiếu'} · Theo dõi duyệt/chi ở chứng từ hiện hành.</p>}
    <p>Lý do: {link.reason}</p>
    {canEdit&&link.state==='LINKED'&&link.new_contract_id===null&&link.fee_state!=='APPLIED'&&<div className="flex items-center gap-2"><Input aria-label="Lý do hủy liên kết" placeholder="Lý do hủy liên kết" value={cancelReason} onChange={event=>setCancelReason(event.target.value)} maxLength={2000}/><Button variant="outline" disabled={!cancelReason.trim()||cancel.isPending} onClick={()=>cancel.mutate({linkId:link.id,expectedVersion:link.version,reason:cancelReason.trim(),requestId:cancelRequest})}>Hủy liên kết</Button></div>}
    {canEdit&&link.state==='LINKED'&&link.mode==='BROKER'&&link.fee_state==='APPLIED'&&link.new_contract_id&&!link.commission_voucher_id&&<Button variant="outline" onClick={()=>setCommissionOpen(true)}>Lập / nối phiếu môi giới</Button>}
    {commissionOpen&&<TransferCommissionDialog link={link} onClose={()=>setCommissionOpen(false)}/>}
    <details><summary className="cursor-pointer">Lịch sử nhượng ({link.history.length})</summary><ol className="mt-2 space-y-2">{link.history.map(h=><li key={h.version}><p>{events[h.event]??h.event} · {h.reason}</p><p className="text-xs text-muted-foreground">{h.actor_name??h.actor_id} · {new Date(h.created_at).toLocaleString('vi-VN')}</p></li>)}</ol></details>
  </article>;
}
export function ContractTransferLinkPanel({contractId,draftId,exitCaseId,exitCase,draft,canEdit:editable,onOpenDraft}:ContractTransferLinkPanelProps){
  const {selectedOrganizationId}=useOrganization();const {data:permissions}=useMyPermissions();const canEdit=editable??canUse(permissions,'contracts','edit');
  const filter:TransferFilter=contractId?{contractId}:draftId||draft?{draftId:draftId??draft!.id}:{exitCaseId:exitCaseId??exitCase?.id};
  const query=useContractTransferLinks(filter);const [createOpen,setCreateOpen]=useState(false);
  // Ở hợp đồng / hồ sơ trả phòng khung này chỉ hiện khi đã có liên kết → chờ thì không vẽ
  // gì; mở từ bản nháp (bấm "Liên kết nhượng") thì là khối xám (chủ chốt 02/10/2026).
  if(query.isLoading)return <LoadingState label="liên kết nhượng" variant={draft?'lines':'none'} rows={3} className="p-3"/>;
  if(query.isError)return <p role="alert" className="p-3 text-sm">{transferErrorMessage(query.error)}<Button variant="link" onClick={()=>void query.refetch()}>Thử lại</Button></p>;
  const canCreate=canEdit&&!query.data?.some(x=>x.state==='LINKED')&&((exitCase&&exitCase.state==='PENDING')||(draft&&draft.status!=='SIGNED'));
  if(!canCreate&&!query.data?.length)return null;
  return <section key={`${selectedOrganizationId}:${contractId??draftId??exitCaseId}`} className="space-y-3 rounded border p-3" aria-label="Liên kết nhượng hai hợp đồng">
    <div className="flex justify-between gap-2"><h3 className="font-semibold">Nhượng · Hai hợp đồng liên kết</h3>{canCreate&&<Button size="sm" variant="outline" onClick={()=>setCreateOpen(true)}>Liên kết nháp khách mới</Button>}</div>
    {query.data?.map(link=><TransferRow key={`${selectedOrganizationId}:${link.id}:${link.version}`} link={link} canEdit={canEdit} onOpenDraft={onOpenDraft}/>)}
    {createOpen&&<ContractTransferLinkDialog key={`${selectedOrganizationId}:${exitCase?.id??draft?.id}`} open onOpenChange={setCreateOpen} exitCase={exitCase} draft={draft}/>}
  </section>;
}
