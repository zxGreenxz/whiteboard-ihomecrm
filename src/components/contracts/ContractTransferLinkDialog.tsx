import { useEffect,useRef,useState } from 'react';
import { Button } from '@/components/ui/button';
import { InlineSkeleton } from '@/components/loading/LoadingState';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useContractDrafts } from '@/hooks/useContractDrafts';
import { useContractExitCases } from '@/hooks/useContractExitCases';
import { useCreateContractTransferLink } from '@/hooks/contracts/useContractTransferLinks';
import type { ContractDraft } from '@/lib/contractDrafts';
import type { ContractExitCase } from '@/lib/contractExitCases';
import { transferErrorMessage,type CreateContractTransferInput } from '@/lib/contract-lifecycle/transfers';

export interface ContractTransferLinkDialogProps {open:boolean;onOpenChange:(open:boolean)=>void;exitCase?:ContractExitCase;draft?:ContractDraft}
export function ContractTransferLinkDialog({open,onOpenChange,exitCase:fixedExit,draft:fixedDraft}:ContractTransferLinkDialogProps){
  const {selectedOrganizationId}=useOrganization();
  const buildingId=fixedExit?.building_id??fixedDraft?.building_id;
  const drafts=useContractDrafts(buildingId,open);const exits=useContractExitCases({buildingId,state:'PENDING',limit:100});
  const save=useCreateContractTransferLink();const reset=save.reset;
  const [exitId,setExitId]=useState(fixedExit?.id??'');const [draftId,setDraftId]=useState(fixedDraft?.id??'');
  const [mode,setMode]=useState<CreateContractTransferInput['mode']>('SELF_FOUND');const [deposit,setDeposit]=useState<CreateContractTransferInput['depositMode']>('NEW_PAYMENT');
  const [term,setTerm]=useState<CreateContractTransferInput['termMode']>('KEEP_OLD_END_DATE');const [broker,setBroker]=useState('');const [reason,setReason]=useState('');
  const request=useRef<{intent:string;id:string}|null>(null);
  useEffect(()=>{setExitId(fixedExit?.id??'');setDraftId(fixedDraft?.id??'');setMode('SELF_FOUND');setDeposit('NEW_PAYMENT');setTerm('KEEP_OLD_END_DATE');setBroker('');setReason('');request.current=null;reset();},[open,selectedOrganizationId,fixedExit?.id,fixedDraft?.id,reset]);
  const exitCase=fixedExit??exits.data?.items.find(x=>x.id===exitId);
  const draft=fixedDraft??drafts.data?.find(x=>x.id===draftId);
  const pendingExits=(exits.data?.items??[]).filter(x=>!draft||x.room_at_handover_id===draft.room_id);
  const editableDrafts=(drafts.data??[]).filter(x=>x.status!=='SIGNED'&&(!exitCase||x.room_id===exitCase.room_at_handover_id));
  const ready=!!exitCase&&exitCase.state==='PENDING'&&!!draft&&draft.status!=='SIGNED'&&draft.room_id===exitCase.room_at_handover_id&&reason.trim()&&(mode!=='BROKER'||broker.trim());
  const submit=async()=>{
    if(!ready||!draft||!exitCase)return;
    const fields={oldExitCaseId:exitCase.id,newDraftId:draft.id,expectedExitVersion:exitCase.version,expectedDraftRevision:draft.revision,
      mode,depositMode:mode==='BROKER'?'NEW_PAYMENT' as const:deposit,termMode:term,brokerName:mode==='BROKER'?broker.trim():null,reason:reason.trim()};
    const intent=JSON.stringify(fields);if(request.current?.intent!==intent)request.current={intent,id:crypto.randomUUID()};
    try{await save.mutateAsync({...fields,requestId:request.current!.id});onOpenChange(false);}catch{/* rendered below */}
  };
  return <Dialog open={open} onOpenChange={value=>{if(!save.isPending)onOpenChange(value);}}><DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>Liên kết hai hợp đồng nhượng</DialogTitle><DialogDescription>Hồ sơ cũ giữ nguyên khách và lịch sử. Chọn nháp của khách mới cùng phòng; sửa ngày nhận, hạn và tiền cọc trong nháp trước khi liên kết.</DialogDescription></DialogHeader>
    {/* Đang nạp danh sách cho hai ô chọn: vạch xám ngay sau nhãn ô đó, không chữ "Đang tải" (chủ chốt 02/10/2026). */}
    {(drafts.isError||exits.isError)&&<p role="alert" className="text-destructive">Không tải được hồ sơ nguồn. <Button variant="link" onClick={()=>{void drafts.refetch();void exits.refetch();}}>Thử lại</Button></p>}
    <label className="space-y-1 text-sm"><span>Hồ sơ trả phòng cũ</span>{!fixedExit&&exits.isLoading&&<InlineSkeleton label="hồ sơ trả phòng chờ quyết toán" width="5rem" className="ml-2" />}<select aria-label="Hồ sơ trả phòng cũ" className="flex h-10 w-full rounded-md border bg-background px-3" disabled={!!fixedExit||save.isPending} value={exitId} onChange={event=>setExitId(event.target.value)}>
      <option value="">Chọn hồ sơ chờ quyết toán</option>{(fixedExit?[fixedExit]:pendingExits).map(x=><option key={x.id} value={x.id}>{x.contract_number??x.id.slice(0,8)} · {x.customer_name??'Khách cũ'} · {x.room_name}</option>)}</select></label>
    <label className="space-y-1 text-sm"><span>Nháp hợp đồng khách mới</span>{!fixedDraft&&drafts.isLoading&&<InlineSkeleton label="nháp hợp đồng" width="5rem" className="ml-2" />}<select aria-label="Nháp hợp đồng khách mới" className="flex h-10 w-full rounded-md border bg-background px-3" disabled={!!fixedDraft||save.isPending} value={draftId} onChange={event=>setDraftId(event.target.value)}>
      <option value="">Chọn nháp cùng phòng</option>{(fixedDraft?[fixedDraft]:editableDrafts).map(x=><option key={x.id} value={x.id}>{x.payload.customers.find(c=>c.is_representative)?.full_name||'Chưa có khách'} · v{x.revision} · {x.payload.form.start_date}</option>)}</select></label>
    {draft&&<p className="text-sm">Ngày nhận: {draft.payload.form.start_date||'Chưa có'} · Hạn: {draft.payload.form.end_date||'Chưa có'} · Cọc mới: {draft.payload.form.total_deposit.toLocaleString('vi-VN')} đ</p>}
    <label className="space-y-1 text-sm"><span>Nguồn khách mới</span><select aria-label="Nguồn khách mới" className="flex h-10 w-full rounded-md border bg-background px-3" value={mode} disabled={save.isPending} onChange={event=>{setMode(event.target.value as typeof mode);setDeposit('NEW_PAYMENT');}}><option value="SELF_FOUND">Khách tự tìm người nhận</option><option value="BROKER">Qua môi giới</option></select></label>
    {mode==='BROKER'?<><label className="space-y-1 text-sm"><span>Tên môi giới / người nhận hoa hồng</span><Input value={broker} onChange={event=>setBroker(event.target.value)} maxLength={200} disabled={save.isPending}/></label><p className="text-sm">Khách mới nộp đủ cọc mới. Phí nhượng bằng 50% cọc cũ trước các khấu trừ khác; phí và phiếu môi giới dùng chung liên kết này.</p></>:<label className="space-y-1 text-sm"><span>Cọc khách mới</span><select aria-label="Cọc khách mới" className="flex h-10 w-full rounded-md border bg-background px-3" value={deposit} disabled={save.isPending} onChange={event=>setDeposit(event.target.value as typeof deposit)}><option value="NEW_PAYMENT">Nộp cọc mới độc lập</option><option value="OLD_DEPOSIT_OFFSET">Dự kiến cấn cọc cũ · Cần xử lý tiền nhượng</option></select></label>}
    {deposit==='OLD_DEPOSIT_OFFSET'&&<p role="alert" className="rounded border p-3 text-sm">Chưa hỗ trợ chuyển cọc giữa hai hợp đồng; lựa chọn đã lưu để đối soát. Cọc chưa được chuyển; nháp liên kết chưa được ký theo nhánh này. Có thể hủy liên kết rồi xử lý độc lập qua luồng hiện hành.</p>}
    <label className="space-y-1 text-sm"><span>Hạn hợp đồng mới</span><select aria-label="Hạn hợp đồng mới" className="flex h-10 w-full rounded-md border bg-background px-3" value={term} disabled={save.isPending} onChange={event=>setTerm(event.target.value as typeof term)}><option value="KEEP_OLD_END_DATE">Giữ hạn cũ · nháp phải có đúng ngày kết thúc</option><option value="NEW_TERM">Kỳ hạn mới theo ngày trong nháp</option></select></label>
    <label className="space-y-1 text-sm"><span>Lý do / ghi chú liên kết</span><Textarea value={reason} onChange={event=>setReason(event.target.value)} maxLength={2000} disabled={save.isPending}/></label>
    {save.isError&&<p role="alert" className="text-sm text-destructive">{transferErrorMessage(save.error)}</p>}
    <Button disabled={!ready||save.isPending||drafts.isError||exits.isError} onClick={()=>void submit()}>{save.isPending?'Đang liên kết…':'Lưu liên kết nhượng'}</Button>
  </DialogContent></Dialog>;
}
