import React,{useEffect,useMemo,useRef,useState} from 'react';
import {toast} from 'sonner';
import {useAccounts} from '@/hooks/useAccounts';
import {useCreateRoomReservation} from '@/hooks/useRoomReservations';
import {getSessionUser} from '@/lib/authSession';
import {CustomerSelectionDialog,type CustomerBasic} from '@/components/contracts/CustomerSelectionDialog';
import {reservationErrorMessage,type CreateRoomReservationInput} from '@/lib/reservationIdentityRpc';
import {Icon} from './icons';
import {fmtPrice,type Room} from './sampleData';
import {useTrack} from './useTracking';
import {todayISO} from '@/lib/collect';

/** A hold is a customer claim. A positive deposit additionally creates
 * one current source voucher in the same server transaction. */
export function QuickDepositModal({room,onClose,onDone}:{room:Room|null;onClose:()=>void;onDone:(msg:string)=>void}){
 const create=useCreateRoomReservation(),track=useTrack();const{data:accounts=[]}=useAccounts();
 const[mode,setMode]=useState<'HOLD'|'DEPOSIT'>('HOLD');const[amount,setAmount]=useState('');const[holdUntil,setHoldUntil]=useState('');const[moveInDate,setMoveInDate]=useState('');const[topupDate,setTopupDate]=useState('');
 const[customer,setCustomer]=useState<CustomerBasic|null>(null);const[picker,setPicker]=useState(false);const[accountId,setAccountId]=useState('');const[myId,setMyId]=useState<string|null>(null);const[submitting,setSubmitting]=useState(false);const[error,setError]=useState('');
 const intent=useRef<{fingerprint:string;key:string}|null>(null);
 useEffect(()=>{let active=true;getSessionUser().then(u=>{if(active)setMyId(u?.id??null);});return()=>{active=false;};},[]);
 const defaultAccount=useMemo(()=>{const mine=accounts.filter(a=>a.user_id===myId);return mine.find(a=>a.is_default)??mine[0];},[accounts,myId]);
 useEffect(()=>{if(!accountId&&defaultAccount)setAccountId(defaultAccount.id);},[defaultAccount,accountId]);
 useEffect(()=>{setMode('HOLD');setAmount('');setHoldUntil('');setMoveInDate('');setTopupDate('');setCustomer(null);setError('');intent.current=null;},[room?.id]);
 if(!room)return null;const label=room.code||String(room.no);
 async function submit(){
  if(submitting||!room)return;
  if(!customer){setError('Phải chọn đúng một khách hàng.');return;}
  if(mode==='HOLD'&&!holdUntil){setError('Giữ chỗ chưa nhận tiền phải chọn hạn giữ chỗ.');return;}
  const money=Number(amount);if(mode==='DEPOSIT'&&(!Number.isSafeInteger(money)||money<=0||!accountId)){setError('Nhập số tiền cọc dương và chọn sổ quỹ.');return;}
  const input:Omit<CreateRoomReservationInput,'idempotencyKey'>={roomId:room.id,customerId:customer.id,holdUntil:holdUntil||null,intendedMoveInOn:moveInDate||null,topupDueOn:topupDate||null,
   ...(mode==='DEPOSIT'?{receipt:{amount:money,accountId,voucherDate:todayISO(),name:`Cọc phòng ${label} tòa ${room.buildingName}`}}:{})};
  const fingerprint=JSON.stringify(input);if(intent.current?.fingerprint!==fingerprint)intent.current={fingerprint,key:`room-reservation-${crypto.randomUUID()}`};
  setSubmitting(true);setError('');try{
   await create.mutateAsync({...input,idempotencyKey:intent.current.key});track.track('deposit_dialog',{room_id:room.id,room_code:room.code,room_name:String(room.no),building_id:room.buildingId,building_name:room.buildingName,metadata:{created:true,amount:mode==='HOLD'?0:money}});
   onDone(mode==='HOLD'?`Đã giữ phòng ${label} • Chưa thu tiền`:`Đã lưu cọc và giữ phòng ${label}`);onClose();
  }catch(e){const message=reservationErrorMessage(e);setError(message);toast.error(message);}finally{setSubmitting(false);}
 }
 return<><div className="qd-scrim show" onClick={submitting?undefined:onClose}/><div className="qd-modal show" role="dialog" aria-modal="true" aria-label="Giữ chỗ hoặc nhận cọc">
  <div className="qd-head"><div className="qd-title"><Icon.Money/><span>Giữ chỗ / Nhận cọc</span></div><button className="qd-x" onClick={onClose} aria-label="Đóng" disabled={submitting}><Icon.Close/></button></div>
  <div className="qd-body"><div className="qd-room"><span className="qd-room-name">Phòng {label} · Tòa {room.buildingName}</span><span className="qd-room-price">{fmtPrice(room.price)} tr/th</span></div>
   <label><input type="radio" name="quick-reservation-mode" checked={mode==='HOLD'} onChange={()=>setMode('HOLD')} disabled={submitting}/> Giữ chỗ chưa nhận tiền</label>{' '}
   <label><input type="radio" name="quick-reservation-mode" checked={mode==='DEPOSIT'} onChange={()=>setMode('DEPOSIT')} disabled={submitting}/> Có nhận cọc</label>
   <div className="qd-field"><span className="qd-field-lbl">Khách hàng *</span><button type="button" className="qd-input" onClick={()=>setPicker(true)} disabled={submitting}>{customer?`${customer.full_name} · ${customer.phone}`:'Chọn khách hàng'}</button></div>
   {mode==='DEPOSIT'&&<><label className="qd-field"><span className="qd-field-lbl">Số tiền cọc</span><input aria-label="Số tiền cọc" className="qd-input" inputMode="numeric" value={amount?Number(amount).toLocaleString('vi-VN'):''} onChange={e=>setAmount(e.target.value.replace(/\D/g,''))} disabled={submitting}/></label>
    <label className="qd-field"><span className="qd-field-lbl">Sổ quỹ nhận cọc</span><select className="qd-input" value={accountId} onChange={e=>setAccountId(e.target.value)} disabled={submitting}><option value="">Chọn sổ quỹ</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><p>Phiếu cọc theo trạng thái duyệt/nhận tiền hiện tại; chờ duyệt chưa tính là đã nhận.</p></>}
   <div className="qd-dates"><label className="qd-field"><span className="qd-field-lbl">Giữ chỗ đến {mode==='HOLD'?'*':'(tùy chọn)'}</span><input className="qd-input" type="date" value={holdUntil} onChange={e=>setHoldUntil(e.target.value)} disabled={submitting}/></label><label className="qd-field"><span className="qd-field-lbl">Ngày dự kiến vào (tùy chọn)</span><input className="qd-input" type="date" value={moveInDate} onChange={e=>setMoveInDate(e.target.value)} disabled={submitting}/></label></div>
   {mode==='DEPOSIT'&&<label className="qd-field"><span className="qd-field-lbl">Ngày bổ sung cọc (tùy chọn)</span><input className="qd-input" type="date" value={topupDate} onChange={e=>setTopupDate(e.target.value)} disabled={submitting}/></label>}
   <p>Quá hạn chỉ nhắc xử lý, phòng vẫn giữ cho khách này đến khi hủy hoặc ký hợp đồng.</p>{error&&<p role="alert">{error}</p>}
  </div><div className="qd-actions"><button className="qd-btn qd-cancel" onClick={onClose} disabled={submitting}>Hủy</button><button className="qd-btn qd-submit" onClick={submit} disabled={submitting}>{submitting?'Đang lưu…':mode==='HOLD'?'Giữ chỗ 0 đồng':'Tạo cọc & giữ chỗ'}</button></div>
 </div><CustomerSelectionDialog open={picker} onOpenChange={setPicker} selectedCustomerIds={customer?[customer.id]:[]} onSelect={values=>{if(values.length!==1){setError('Phải chọn đúng một khách hàng.');return;}setCustomer(values[0]);setPicker(false);setError('');}}/></>;
}
