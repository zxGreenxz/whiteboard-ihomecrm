import {useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {LoadingState} from '@/components/loading/LoadingState';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {useRentSupportLifecycle,useRentSupportLifecycleActions,useRentSupportReconciliationContext} from '@/hooks/useRentSupportLifecycle';
import {reconciliationEntrySchema,type ReconciliationEntry,type ReconciliationPreview} from '@/lib/rentSupportLifecycle';
import {friendlyError} from '@/lib/friendlyError';

interface Props {organizationId:string;contractId:string;voucherId:string}
const money=(value:string)=>{const [whole,fraction]=value.split('.');return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g,'.')}${fraction?`,${fraction}`:''} đ`;};
const reviewLabel:Record<string,string>={LEGACY_REVIEW:'Cần xác nhận số đã giữ và chứng từ.',EVIDENCE_REVIEW:'Chứng từ chưa khớp hồ sơ đã ký.',ENGINE_NET_REVIEW:'Số thực nhận hoặc phiên bản phiếu đã thay đổi.',PAYEE_MISMATCH:'Người hưởng chưa khớp nguồn hỗ trợ.',SOURCE_ALREADY_ISSUED:'Nguồn đã có kết quả; cần xử lý hồ sơ hiện có.',REVERSAL_REVIEW:'Nguồn đang bị giữ hoặc cần đối chiếu.',COMMITMENT_REVIEW:'Phần đã giữ vượt cam kết được xác minh.'};
export function RentSupportReconciliationPanel(props:Props) {
 const [open,setOpen]=useState(false);
 return <section className="rounded-md border p-3 mx-4 my-2">
  <Button type="button" variant="ghost" onClick={()=>setOpen(v=>!v)} aria-expanded={open}>Hỗ trợ tiền thuê</Button>
  {open&&<PanelContent key={`${props.contractId}:${props.voucherId}`} {...props}/>}
 </section>;
}
function PanelContent({organizationId,contractId,voucherId}:Props) {
 const read=useRentSupportLifecycle(organizationId,contractId);
 const actions=useRentSupportLifecycleActions(organizationId);
 const source=read.data?.sources.find(s=>s.voucher_id===voucherId);
 const candidate=useRentSupportReconciliationContext(organizationId,contractId,voucherId,!!read.data?.plan_revision&&!source);
 const [reason,setReason]=useState(''),[gross,setGross]=useState(''),[held,setHeld]=useState(''),[confirmed,setConfirmed]=useState(false);
 const [action,setAction]=useState<'CANCEL'|'RESTORE'|'REVISE'>('CANCEL');
 const [prepared,setPrepared]=useState<{entry:ReconciliationEntry;preview:ReconciliationPreview}|null>(null);
 const [error,setError]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null);
 const request=useRef<{key:string;id:string}|null>(null);
 const editVersion=useRef(0);
 const requestId=(key:string)=>{if(request.current?.key!==key)request.current={key,id:crypto.randomUUID()};return request.current.id;};
 const changed=()=>{editVersion.current+=1;setPrepared(null);setError(null);setMessage(null);};
 const fail=(e:unknown)=>setError(friendlyError(e,'Không lưu được đối chiếu').description);
 if(read.isLoading)return <LoadingState label="lịch hỗ trợ" variant="cards" rows={3}/>;
 if(read.error)return <div role="alert">Không tải được thông tin hỗ trợ. <Button variant="link" onClick={()=>void read.refetch()}>Thử lại</Button></div>;
 if(!read.data?.plan_revision)return <p>Hợp đồng chưa có lịch hỗ trợ theo tháng được xác nhận.</p>;
 const data=read.data;
 const askReview=async()=>{
  if(!source)return;setError(null);
  const intent={sourceId:source.source_id,action,expectedFactsHash:source.proof_hash,reason};
  try {await actions.request.mutateAsync({...intent,requestId:requestId(JSON.stringify(intent))});setMessage('Đã lưu đề nghị rà soát. Số tiền và lịch sử hiện có được giữ nguyên.');}catch(e){fail(e);}
 };
 const preview=async()=>{
  if(!candidate.data)return;setError(null);setPrepared(null);
  const version=editVersion.current;
  const {engine_net,...identity}=candidate.data;
  try {
   const entry=reconciliationEntrySchema.parse({...identity,gross,previous_withheld:held,net:engine_net,confirmed,reason});
   const result=await actions.preview.mutateAsync([entry]);if(version===editVersion.current)setPrepared({entry,preview:result});
  }catch(e){if(version===editVersion.current)fail(e);}
 };
 const apply=async()=>{
  if(!prepared)return;setError(null);
  const intent={entries:[prepared.entry],batchHash:prepared.preview.batch_hash,reason:prepared.entry.reason};
  try {const result=await actions.apply.mutateAsync({...intent,requestId:requestId(JSON.stringify(intent))});setMessage(result.state==='COMPLETED'?'Đã lưu đối chiếu theo xác nhận của bạn. Không tạo khoản chi hoặc khấu trừ mới.':'Đã lưu hồ sơ cần đối chiếu. Chưa thay đổi khoản tiền.');setPrepared(null);}catch(e){fail(e);}
 };
 return <div className="space-y-3 text-sm">
  <dl className="grid grid-cols-3 gap-3"><div><dt>Cam kết</dt><dd>{money(data.committed)}</dd></div><div><dt>Đã hưởng</dt><dd>{money(data.consumed)}</dd></div><div><dt>Đã giữ, chưa dùng</dt><dd>{money(data.unused_committed)}</dd></div></dl>
  {data.issues.map(i=><p key={i.code}>{i.message}</p>)}
  {source&&<div className="space-y-2">
   <p>Quyền lợi {money(source.gross)} · Đã giữ {money(source.withheld)} · Thực nhận {money(source.net)}</p>
   <label className="block">Đề nghị đối chiếu <select className="border rounded p-1" value={action} onChange={e=>{const value=e.target.value;if(value==='CANCEL'||value==='RESTORE'||value==='REVISE'){setAction(value);changed();}}}><option value="CANCEL">Hủy phiếu nguồn</option><option value="RESTORE">Khôi phục phiếu nguồn</option><option value="REVISE">Điều chỉnh phiếu nguồn</option></select></label>
   <label className="block">Lý do<Textarea value={reason} onChange={e=>{setReason(e.target.value);changed();}}/></label>
   <Button disabled={reason.trim().length<8||actions.request.isPending} onClick={()=>void askReview()}>Lưu đề nghị rà soát</Button>
  </div>}
  {!source&&candidate.isLoading&&<LoadingState label="chứng từ đối chiếu" rows={3}/>}
  {!source&&candidate.error&&<p role="alert">Không đọc được căn cứ đối chiếu của phiếu này.</p>}
  {!source&&candidate.data&&<div className="space-y-2">
   <p>Đối chiếu phiếu cũ · Thực nhận trên phiếu: {money(candidate.data.engine_net)}</p>
   <label className="block">Tổng quyền lợi trước khấu trừ<Input inputMode="decimal" value={gross} onChange={e=>{setGross(e.target.value);changed();}}/></label>
   <label className="block">Số hỗ trợ đã giữ trước đây<Input inputMode="decimal" value={held} onChange={e=>{setHeld(e.target.value);changed();}}/></label>
   <p>{candidate.data.documents.length>0?`${candidate.data.documents.length} tài liệu ký của hợp đồng đã được đối chiếu danh tính.`:'Chưa có tài liệu ký đủ căn cứ; hồ sơ sẽ cần được rà soát.'}</p>
   <label className="block">Lý do và căn cứ đối chiếu<Textarea value={reason} onChange={e=>{setReason(e.target.value);changed();}}/></label>
   <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={e=>{setConfirmed(e.target.checked);changed();}}/>Tôi đã kiểm tra chứng từ, đúng người hưởng, tổng quyền lợi và phần hỗ trợ đã giữ.</label>
   <Button disabled={actions.preview.isPending||!gross||!held||reason.trim().length<8} onClick={()=>void preview()}>Xem đối chiếu</Button>
   {prepared&&<div className="space-y-2"><p>Tổng quyền lợi {money(prepared.preview.totals.gross)} · Đã giữ {money(prepared.preview.totals.previous_withheld)} · Thực nhận {money(prepared.preview.totals.net)}</p>
    {prepared.preview.rows.filter(r=>r.issue).map(r=><p key={r.source_id}>{reviewLabel[r.issue!]??'Cần xác minh thêm căn cứ đối chiếu.'}</p>)}
    <Button disabled={actions.apply.isPending} onClick={()=>void apply()}>{prepared.preview.state==='READY'?'Lưu đối chiếu':'Lưu hồ sơ cần rà soát'}</Button>
   </div>}
  </div>}
  {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
 </div>;
}
