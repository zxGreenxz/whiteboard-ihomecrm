import {useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {LoadingState} from '@/components/loading/LoadingState';
import {useRoomReservations,useUpdateRoomReservation} from '@/hooks/useRoomReservations';
import {useMyPermissions} from '@/hooks/useMyPermissions';
import {useAccounts} from '@/hooks/useAccounts';
import {canUse} from '@/lib/permissionPages';
import {todayISO} from '@/lib/collect';
import {formatCurrency} from '@/lib/utils';
import {reservationErrorMessage,type RoomReservation,type UpdateRoomReservationInput} from '@/lib/reservationIdentityRpc';
import {ReservationSettlementDialog} from './ReservationSettlementDialog';

export function RoomReservationPanel({roomId,buildingId,enabled=true}:{roomId?:string;buildingId?:string;enabled?:boolean}){
 const[status,setStatus]=useState<'HOLD'|'CONVERTED'|'CANCELLED'|''>('HOLD');
 const permissionQuery=useMyPermissions();const canRead=canUse(permissionQuery.data,'deposits','view',buildingId);
 const query=useRoomReservations({roomId,status:status||undefined,limit:200},enabled&&canRead);
 if(!enabled||!canRead)return null;
 return<section className="space-y-3 rounded-lg border p-4" aria-label="Hồ sơ giữ chỗ">
  <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Giữ chỗ / Cọc trước hợp đồng</h2><select aria-label="Trạng thái hồ sơ giữ chỗ" value={status} onChange={e=>setStatus(e.target.value as typeof status)} className="rounded border p-1"><option value="HOLD">Đang giữ chỗ</option><option value="CONVERTED">Đã ký hợp đồng</option><option value="CANCELLED">Đã hủy</option><option value="">Tất cả</option></select></div>
  <p className="text-xs text-muted-foreground">Hạn giữ chỉ nhắc xử lý, không tự nhả phòng hoặc xử lý cọc.</p>
  {query.isLoading?<LoadingState label="giữ chỗ" rows={2} onRetry={()=>void query.refetch()}/>:query.isError?<p role="alert">Không tải được hồ sơ giữ chỗ. <Button variant="link" onClick={()=>void query.refetch()}>Thử lại</Button></p>:
   query.data?.reservations.length?<div className="space-y-3">{query.data.reservations.map(r=><ReservationRow key={r.id+':'+r.revision} reservation={r} onMoneyClosed={()=>void query.refetch()}/>)}</div>:<p className="text-sm text-muted-foreground">Chưa có giữ chỗ</p>}
  {(query.data?.reservations.length??0)>=200&&<p className="text-xs">Đang hiện 200 hồ sơ. Mở theo từng phòng để xem hồ sơ cụ thể.</p>}
 </section>;
}
function ReservationRow({reservation:r,onMoneyClosed}:{reservation:RoomReservation;onMoneyClosed:()=>void}){
 const{data:permissions}=useMyPermissions();const mutation=useUpdateRoomReservation();
 const[edit,setEdit]=useState<'deadline'|'topup'|null>(null);const[deadline,setDeadline]=useState(r.hold_until??'');const[amount,setAmount]=useState('');const[accountId,setAccountId]=useState('');const[voucherDate,setVoucherDate]=useState(todayISO());const[error,setError]=useState('');const[settlementVoucher,setSettlementVoucher]=useState<string|null>(null);
 const{data:accounts=[]}=useAccounts({enabled:edit==='topup'});const intent=useRef<{fingerprint:string;key:string}|null>(null);
 const canEdit=canUse(permissions,'deposits','edit',r.building_id),canTopup=canUse(permissions,'deposits','create',r.building_id),canCancel=canUse(permissions,'deposits','delete',r.building_id);
 const moneyActive=r.receipts.some(p=>!p.released);
 async function submit(action:UpdateRoomReservationInput['action']){
  const input:Omit<UpdateRoomReservationInput,'idempotencyKey'>={reservationId:r.id,expectedRevision:r.revision,action};
  if(action==='UPDATE'){if(!deadline&&!r.receipts.length){setError('Giữ chỗ chưa nhận tiền phải chọn hạn.');return;}input.changes={holdUntil:deadline||null};}
  if(action==='TOPUP'){const money=Number(amount);if(!Number.isSafeInteger(money)||money<=0||!accountId){setError('Nhập tiền cọc dương và chọn sổ quỹ.');return;}input.receipt={amount:money,accountId,voucherDate,name:`Bổ sung cọc phòng ${r.room_name} · ${r.customer_name}`};}
  const fingerprint=JSON.stringify(input);if(intent.current?.fingerprint!==fingerprint)intent.current={fingerprint,key:`reservation-change-${crypto.randomUUID()}`};setError('');
  try{await mutation.mutateAsync({...input,idempotencyKey:intent.current.key});setEdit(null);}catch(e){setError(reservationErrorMessage(e));}
 }
 const sources=[...new Map(r.receipts.map(p=>[p.source_voucher_id,p])).values()];
 return<article className="space-y-2 rounded border p-3">
  <div><strong>{r.customer_name}</strong> · {r.customer_phone}<p className="text-sm">Phòng {r.room_name} · Tòa {r.building_name}</p></div>
  <p className="text-sm">{r.status==='HOLD'?'Đang giữ chỗ':r.status==='CONVERTED'?'Đã ký hợp đồng':'Đã hủy'} · Hạn: {r.hold_until??'Chưa đặt hạn'}</p>
  {r.overdue&&<p className="text-sm font-medium text-amber-700">Quá hạn · vẫn giữ chỗ cho khách này, cần điều chỉnh hoặc hủy thủ công.</p>}
  <p className="text-sm">{r.status==='CONVERTED'?'Nguồn cọc đã chuyển sang hợp đồng':`Đã nhận theo phiếu nguồn: ${formatCurrency(r.received_amount)}`}{!r.receipts.length?' · Giữ chỗ 0 đồng':''}</p>
  {sources.map(p=><div key={p.source_voucher_id} className="text-sm"><span>{p.code??p.source_voucher_id} · {r.status==='CONVERTED'?'Đã chuyển hợp đồng':p.released?'Đã xử lý/hủy':p.received?'Đã nhận':'Chờ duyệt/chưa nhận'} · {formatCurrency(p.amount)}</span>
    {r.status==='HOLD'&&p.received&&!p.released&&canUse(permissions,'deposits','refund',r.building_id)&&canUse(permissions,'income_expenses','approve',r.building_id)&&<Button size="sm" variant="link" onClick={()=>setSettlementVoucher(p.source_voucher_id)}>Xử lý cọc hiện tại</Button>}
  </div>)}
  {r.status==='HOLD'&&<div className="flex flex-wrap gap-2">{canEdit&&<Button size="sm" variant="outline" onClick={()=>{setEdit('deadline');setError('');}} disabled={mutation.isPending}>Điều chỉnh hạn</Button>}{canTopup&&<Button size="sm" variant="outline" onClick={()=>{setEdit('topup');setError('');}} disabled={mutation.isPending}>Bổ sung cọc</Button>}{canCancel&&<Button size="sm" variant="outline" disabled={mutation.isPending||moneyActive} onClick={()=>void submit('CANCEL')}>Hủy giữ chỗ</Button>}</div>}
  {r.status==='HOLD'&&moneyActive&&<p className="text-xs text-muted-foreground">Hủy/đối soát phiếu cọc theo luồng hiện tại trước khi hủy giữ chỗ. Phiếu chờ duyệt/chưa nhận không cộng vào tiền đã nhận.</p>}
  {edit==='deadline'&&<div className="flex flex-wrap items-end gap-2"><label className="text-sm">Hạn giữ chỗ<Input type="date" value={deadline} onChange={e=>setDeadline(e.target.value)} disabled={mutation.isPending}/></label><Button size="sm" onClick={()=>void submit('UPDATE')} disabled={mutation.isPending}>Lưu hạn</Button></div>}
  {edit==='topup'&&<div className="grid gap-2 sm:grid-cols-2"><label className="text-sm">Số tiền bổ sung<Input inputMode="numeric" value={amount} onChange={e=>setAmount(e.target.value.replace(/\D/g,''))} disabled={mutation.isPending}/></label><label className="text-sm">Sổ quỹ<select aria-label="Sổ quỹ bổ sung cọc" className="block w-full rounded border p-2" value={accountId} onChange={e=>setAccountId(e.target.value)} disabled={mutation.isPending}><option value="">Chọn sổ quỹ</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label className="text-sm">Ngày phiếu<Input type="date" value={voucherDate} onChange={e=>setVoucherDate(e.target.value)} disabled={mutation.isPending}/></label><Button className="self-end" onClick={()=>void submit('TOPUP')} disabled={mutation.isPending}>Tạo phiếu bổ sung cọc</Button></div>}
  {edit&&<Button size="sm" variant="ghost" onClick={()=>setEdit(null)} disabled={mutation.isPending}>Đóng thao tác</Button>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {!!r.history.length&&<details className="text-xs"><summary>Lịch sử giữ chỗ ({r.history.length})</summary><ol>{r.history.map(h=><li key={h.revision}>{h.action} · {new Date(h.changed_at).toLocaleString('vi-VN')} · {h.changed_by}</li>)}</ol></details>}
  {settlementVoucher&&<ReservationSettlementDialog voucherId={settlementVoucher} open onOpenChange={open=>{if(!open){setSettlementVoucher(null);onMoneyClosed();}}}/>}
 </article>;
}
