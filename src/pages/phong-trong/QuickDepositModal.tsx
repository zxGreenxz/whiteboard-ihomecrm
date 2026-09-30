import React,{useEffect,useMemo,useRef,useState} from 'react';
import {CurrencyInput} from '@/components/ui/currency-input';
import {validateInputDrafts} from '@/lib/inputDraftValidation';
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
 const create=useCreateRoomReservation({silent:true}),track=useTrack();const{data:accounts=[]}=useAccounts();
 const[mode,setMode]=useState<'HOLD'|'DEPOSIT'>('HOLD');const[amount,setAmount]=useState(0);const[holdUntil,setHoldUntil]=useState('');const[moveInDate,setMoveInDate]=useState('');const[topupDate,setTopupDate]=useState('');
 const[customer,setCustomer]=useState<CustomerBasic|null>(null);const[picker,setPicker]=useState(false);const[accountId,setAccountId]=useState('');const[myId,setMyId]=useState<string|null>(null);const[submitting,setSubmitting]=useState(false);const[error,setError]=useState('');
 const[fieldErrors,setFieldErrors]=useState<Partial<Record<'customer'|'holdUntil'|'amount'|'accountId',string>>>({});
 const modalRef=useRef<HTMLDivElement>(null),customerRef=useRef<HTMLButtonElement>(null),holdRef=useRef<HTMLInputElement>(null),amountRef=useRef<HTMLInputElement>(null),accountRef=useRef<HTMLSelectElement>(null);
 const clearField=(field:keyof typeof fieldErrors)=>setFieldErrors(current=>({...current,[field]:undefined}));
 const intent=useRef<{fingerprint:string;key:string}|null>(null);
 useEffect(()=>{let active=true;getSessionUser().then(u=>{if(active)setMyId(u?.id??null);});return()=>{active=false;};},[]);
 const defaultAccount=useMemo(()=>{const mine=accounts.filter(a=>a.user_id===myId);return mine.find(a=>a.is_default)??mine[0];},[accounts,myId]);
 useEffect(()=>{if(!accountId&&defaultAccount)setAccountId(defaultAccount.id);},[defaultAccount,accountId]);
 useEffect(()=>{setMode('HOLD');setAmount(0);setHoldUntil('');setMoveInDate('');setTopupDate('');setCustomer(null);setError('');setFieldErrors({});intent.current=null;},[room?.id]);
 if(!room)return null;const label=room.code||String(room.no);
 async function submit(){
  if(submitting||!room)return;
  const money=amount;const errors:typeof fieldErrors={};
  if(!customer)errors.customer='Phải chọn đúng một khách hàng.';
  if(mode==='HOLD'&&!holdUntil)errors.holdUntil='Chọn hạn giữ chỗ khi chưa nhận tiền.';
  if(mode==='DEPOSIT'&&(!Number.isSafeInteger(money)||money<=0))errors.amount='Nhập số tiền cọc nguyên dương hợp lệ.';
  if(mode==='DEPOSIT'&&!accountId)errors.accountId='Chọn sổ quỹ nhận cọc.';
  setFieldErrors(errors);setError('');
  if(Object.keys(errors).length){const refs={customer:customerRef,holdUntil:holdRef,amount:amountRef,accountId:accountRef};const first=(['customer','holdUntil','amount','accountId'] as const).find(field=>errors[field]);if(first)refs[first].current?.focus();return;}
  if(!validateInputDrafts(modalRef.current)||!customer)return;
  const input:Omit<CreateRoomReservationInput,'idempotencyKey'>={roomId:room.id,customerId:customer.id,holdUntil:holdUntil||null,intendedMoveInOn:moveInDate||null,topupDueOn:topupDate||null,
   ...(mode==='DEPOSIT'?{receipt:{amount:money,accountId,voucherDate:todayISO(),name:`Cọc phòng ${label} tòa ${room.buildingName}`}}:{})};
  const fingerprint=JSON.stringify(input);if(intent.current?.fingerprint!==fingerprint)intent.current={fingerprint,key:`room-reservation-${crypto.randomUUID()}`};
  setSubmitting(true);setError('');try{
   await create.mutateAsync({...input,idempotencyKey:intent.current.key});track.track('deposit_dialog',{room_id:room.id,room_code:room.code,room_name:String(room.no),building_id:room.buildingId,building_name:room.buildingName,metadata:{created:true,amount:mode==='HOLD'?0:money}});
   onDone(mode==='HOLD'?`Đã giữ phòng ${label} • Chưa thu tiền`:`Đã lưu cọc và giữ phòng ${label}`);onClose();
  }catch(e){const message=reservationErrorMessage(e);setError(message);}finally{setSubmitting(false);}
 }
 return<><div className="qd-scrim show" onClick={submitting?undefined:onClose}/><div ref={modalRef} className="qd-modal show" role="dialog" aria-modal="true" aria-label="Giữ chỗ hoặc nhận cọc">
  <div className="qd-head"><div className="qd-title"><Icon.Money/><span>Giữ chỗ / Nhận cọc</span></div><button className="qd-x" onClick={onClose} aria-label="Đóng" disabled={submitting}><Icon.Close/></button></div>
  <div className="qd-body"><div className="qd-room"><span className="qd-room-name">Phòng {label} · Tòa {room.buildingName}</span><span className="qd-room-price">{fmtPrice(room.price)} tr/th</span></div>
   <label><input type="radio" name="quick-reservation-mode" checked={mode==='HOLD'} onChange={()=>{setMode('HOLD');setFieldErrors({});}} disabled={submitting}/> Giữ chỗ chưa nhận tiền</label>{' '}
   <label><input type="radio" name="quick-reservation-mode" checked={mode==='DEPOSIT'} onChange={()=>{setMode('DEPOSIT');setFieldErrors({});}} disabled={submitting}/> Có nhận cọc</label>
   <div className="qd-field"><span className="qd-field-lbl">Khách hàng *</span><button ref={customerRef} type="button" className={`qd-input ${fieldErrors.customer?"border-destructive":""}`} aria-invalid={!!fieldErrors.customer} aria-describedby={fieldErrors.customer?"quick-customer-error":undefined} onClick={()=>setPicker(true)} disabled={submitting}>{customer?`${customer.full_name} · ${customer.phone}`:'Chọn khách hàng'}</button>{fieldErrors.customer&&<p id="quick-customer-error" role="alert" className="text-sm text-destructive">{fieldErrors.customer}</p>}</div>
   {mode==='DEPOSIT'&&<><label className="qd-field"><span className="qd-field-lbl">Số tiền cọc</span><CurrencyInput ref={amountRef} aria-label="Số tiền cọc" className={`qd-input ${fieldErrors.amount?"border-destructive":""}`} value={amount} aria-invalid={!!fieldErrors.amount} aria-describedby={fieldErrors.amount?"quick-amount-error":undefined} onChange={value=>{setAmount(value);clearField("amount");}} disabled={submitting}/>{fieldErrors.amount&&<p id="quick-amount-error" role="alert" className="text-sm text-destructive">{fieldErrors.amount}</p>}</label>
    <label className="qd-field"><span className="qd-field-lbl">Sổ quỹ nhận cọc</span><select aria-label="Sổ quỹ nhận cọc" ref={accountRef} className={`qd-input ${fieldErrors.accountId?"border-destructive":""}`} value={accountId} aria-invalid={!!fieldErrors.accountId} aria-describedby={fieldErrors.accountId?"quick-account-error":undefined} onChange={e=>{setAccountId(e.target.value);clearField("accountId");}} disabled={submitting}><option value="">Chọn sổ quỹ</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select>{fieldErrors.accountId&&<p id="quick-account-error" role="alert" className="text-sm text-destructive">{fieldErrors.accountId}</p>}</label><p>Phiếu cọc theo trạng thái duyệt/nhận tiền hiện tại; chờ duyệt chưa tính là đã nhận.</p></>}
   <div className="qd-dates"><label className="qd-field"><span className="qd-field-lbl">Giữ chỗ đến {mode==='HOLD'?'*':'(tùy chọn)'}</span><input ref={holdRef} className={`qd-input ${fieldErrors.holdUntil?"border-destructive":""}`} type="date" value={holdUntil} aria-invalid={!!fieldErrors.holdUntil} aria-describedby={fieldErrors.holdUntil?"quick-hold-error":undefined} onChange={e=>{setHoldUntil(e.target.value);clearField("holdUntil");}} disabled={submitting}/>{fieldErrors.holdUntil&&<p id="quick-hold-error" role="alert" className="text-sm text-destructive">{fieldErrors.holdUntil}</p>}</label><label className="qd-field"><span className="qd-field-lbl">Ngày dự kiến vào (tùy chọn)</span><input className="qd-input" type="date" value={moveInDate} onChange={e=>setMoveInDate(e.target.value)} disabled={submitting}/></label></div>
   {mode==='DEPOSIT'&&<label className="qd-field"><span className="qd-field-lbl">Ngày bổ sung cọc (tùy chọn)</span><input className="qd-input" type="date" value={topupDate} onChange={e=>setTopupDate(e.target.value)} disabled={submitting}/></label>}
   <p>Quá hạn chỉ nhắc xử lý, phòng vẫn giữ cho khách này đến khi hủy hoặc ký hợp đồng.</p>{error&&<p role="alert">{error}</p>}
  </div><div className="qd-actions"><button className="qd-btn qd-cancel" onClick={onClose} disabled={submitting}>Hủy</button><button className="qd-btn qd-submit" onClick={submit} disabled={submitting}>{submitting?'Đang lưu…':mode==='HOLD'?'Giữ chỗ 0 đồng':'Tạo cọc & giữ chỗ'}</button></div>
 </div><CustomerSelectionDialog open={picker} onOpenChange={setPicker} selectedCustomerIds={customer?[customer.id]:[]} onSelect={values=>{if(values.length!==1){setFieldErrors(current=>({...current,customer:'Phải chọn đúng một khách hàng.'}));customerRef.current?.focus();return;}setCustomer(values[0]);clearField('customer');setPicker(false);setError('');}}/></>;
}
