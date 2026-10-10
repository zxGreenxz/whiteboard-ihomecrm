import React,{useEffect,useMemo,useRef,useState} from 'react';
import {CurrencyInput} from '@/components/ui/currency-input';
import {validateInputDrafts} from '@/lib/inputDraftValidation';
import {useAccounts} from '@/hooks/useAccounts';
import {useCreateRoomReservation} from '@/hooks/useRoomReservations';
import {getSessionUser} from '@/lib/authSession';
import {CustomerSelectionDialog,type CustomerBasic} from '@/components/contracts/CustomerSelectionDialog';
import {CUSTOMER_HINT_MAX,reservationErrorMessage,type CreateRoomReservationInput} from '@/lib/reservationIdentityRpc';
import {saleLockRemaining} from '@/lib/roomSaleLockRpc';
import {Icon} from './icons';
import {fmtPrice,type Room} from './sampleData';
import {useTrack} from './useTracking';
import {todayISO} from '@/lib/collect';

/** Nhận cọc giữ phòng: luôn có tiền. Chủ bỏ "giữ chỗ 0 đồng" 10/10/2026 — giữ phòng không thu
 * tiền là Lock tạm. Khách: chọn trong danh bạ HOẶC gõ tên gợi nhớ; tên gợi nhớ thành người nộp
 * và ghi chú của phiếu, phải gắn khách thật ở Quản lý cọc trước khi ký hợp đồng. Phiếu và giữ
 * chỗ ghi trong cùng một giao dịch máy chủ; phòng đang lock tạm thì lock tự gỡ. */
export function QuickDepositModal({room,onClose,onDone}:{room:Room|null;onClose:()=>void;onDone:(msg:string)=>void}){
 const create=useCreateRoomReservation({silent:true}),track=useTrack();const{data:accounts=[]}=useAccounts();
 const[amount,setAmount]=useState(0);const[holdUntil,setHoldUntil]=useState('');const[moveInDate,setMoveInDate]=useState('');const[topupDate,setTopupDate]=useState('');
 const[customer,setCustomer]=useState<CustomerBasic|null>(null);const[hint,setHint]=useState('');const[picker,setPicker]=useState(false);const[accountId,setAccountId]=useState('');const[myId,setMyId]=useState<string|null>(null);const[submitting,setSubmitting]=useState(false);const[error,setError]=useState('');
 const[fieldErrors,setFieldErrors]=useState<Partial<Record<'customer'|'amount'|'accountId',string>>>({});
 const modalRef=useRef<HTMLDivElement>(null),customerRef=useRef<HTMLInputElement>(null),amountRef=useRef<HTMLInputElement>(null),accountRef=useRef<HTMLSelectElement>(null);
 const clearField=(field:keyof typeof fieldErrors)=>setFieldErrors(current=>({...current,[field]:undefined}));
 const intent=useRef<{fingerprint:string;key:string}|null>(null);
 useEffect(()=>{let active=true;getSessionUser().then(u=>{if(active)setMyId(u?.id??null);});return()=>{active=false;};},[]);
 const defaultAccount=useMemo(()=>{const mine=accounts.filter(a=>a.user_id===myId);return mine.find(a=>a.is_default)??mine[0];},[accounts,myId]);
 useEffect(()=>{if(!accountId&&defaultAccount)setAccountId(defaultAccount.id);},[defaultAccount,accountId]);
 useEffect(()=>{setAmount(0);setHoldUntil('');setMoveInDate('');setTopupDate('');setCustomer(null);setHint('');setError('');setFieldErrors({});intent.current=null;},[room?.id]);
 if(!room)return null;const label=room.code||String(room.no);
 async function submit(){
  if(submitting||!room)return;
  const money=amount,name=hint.trim();const errors:typeof fieldErrors={};
  if(!customer&&!name)errors.customer='Gõ tên khách gợi nhớ hoặc chọn khách trong danh bạ.';
  else if(!customer&&name.length>CUSTOMER_HINT_MAX)errors.customer=`Tên khách gợi nhớ tối đa ${CUSTOMER_HINT_MAX} ký tự.`;
  if(!Number.isSafeInteger(money)||money<=0)errors.amount='Nhập số tiền cọc nguyên dương hợp lệ.';
  if(!accountId)errors.accountId='Chọn sổ quỹ nhận cọc.';
  setFieldErrors(errors);setError('');
  if(Object.keys(errors).length){const refs={customer:customerRef,amount:amountRef,accountId:accountRef};const first=(['customer','amount','accountId'] as const).find(field=>errors[field]);if(first)refs[first].current?.focus();return;}
  if(!validateInputDrafts(modalRef.current))return;
  const input:Omit<CreateRoomReservationInput,'idempotencyKey'>={roomId:room.id,...(customer?{customerId:customer.id}:{customerHint:name}),holdUntil:holdUntil||null,intendedMoveInOn:moveInDate||null,topupDueOn:topupDate||null,
   receipt:{amount:money,accountId,voucherDate:todayISO(),name:`Cọc phòng ${label} tòa ${room.buildingName}`}};
  const fingerprint=JSON.stringify(input);if(intent.current?.fingerprint!==fingerprint)intent.current={fingerprint,key:`room-reservation-${crypto.randomUUID()}`};
  setSubmitting(true);setError('');try{
   await create.mutateAsync({...input,idempotencyKey:intent.current.key});track.track('deposit_dialog',{room_id:room.id,room_code:room.code,room_name:String(room.no),building_id:room.buildingId,building_name:room.buildingName,metadata:{created:true,amount:money}});
   onDone(customer?`Đã lưu cọc và giữ phòng ${label}`:`Đã lưu cọc phòng ${label} cho "${name}" · nhớ gắn khách trước khi ký`);onClose();
  }catch(e){const message=reservationErrorMessage(e);setError(message);}finally{setSubmitting(false);}
 }
 return<><div className="qd-scrim show" onClick={submitting?undefined:onClose}/><div ref={modalRef} className="qd-modal show" role="dialog" aria-modal="true" aria-label="Nhận cọc giữ phòng">
  <div className="qd-head"><div className="qd-title"><Icon.Money/><span>Nhận cọc giữ phòng</span></div><button className="qd-x" onClick={onClose} aria-label="Đóng" disabled={submitting}><Icon.Close/></button></div>
  <div className="qd-body"><div className="qd-room"><span className="qd-room-name">Phòng {label} · Tòa {room.buildingName}</span><span className="qd-room-price">{fmtPrice(room.price)} tr/th</span></div>
   {room.status==='locked'&&room.saleLock&&<p className="qd-hint">Phòng đang lock tạm bởi {room.saleLock.lockedByMe?'bạn':room.saleLock.lockedByName} ({saleLockRemaining(room.saleLock.expiresAt)}). Lưu phiếu cọc sẽ gỡ lock.</p>}
   <div className="qd-field"><span className="qd-field-lbl">Khách hàng *</span>
    {customer?<div className="qd-chip"><span>{customer.full_name} · {customer.phone}</span><button type="button" onClick={()=>{setCustomer(null);setError('');}} disabled={submitting}>Bỏ chọn</button></div>
     :<div className="qd-customer"><input ref={customerRef} className={`qd-input ${fieldErrors.customer?"border-destructive":""}`} aria-label="Tên khách gợi nhớ" placeholder="VD: anh Tuấn xem phòng 18h" value={hint} maxLength={CUSTOMER_HINT_MAX} aria-invalid={!!fieldErrors.customer} aria-describedby={fieldErrors.customer?"quick-customer-error":undefined} onChange={e=>{setHint(e.target.value);clearField('customer');}} disabled={submitting}/>
      <button type="button" className="qd-pick" onClick={()=>setPicker(true)} disabled={submitting} aria-label="Chọn khách trong danh bạ">Danh bạ</button></div>}
    {!customer&&<p className="qd-hint">Chưa cần tạo khách: tên này ghi vào người nộp và ghi chú phiếu. Gắn khách thật ở Quản lý cọc trước khi ký hợp đồng.</p>}
    {fieldErrors.customer&&<p id="quick-customer-error" role="alert" className="text-sm text-destructive">{fieldErrors.customer}</p>}</div>
   <label className="qd-field"><span className="qd-field-lbl">Số tiền cọc</span><CurrencyInput ref={amountRef} aria-label="Số tiền cọc" className={`qd-input ${fieldErrors.amount?"border-destructive":""}`} value={amount} aria-invalid={!!fieldErrors.amount} aria-describedby={fieldErrors.amount?"quick-amount-error":undefined} onChange={value=>{setAmount(value);clearField("amount");}} disabled={submitting}/>{fieldErrors.amount&&<p id="quick-amount-error" role="alert" className="text-sm text-destructive">{fieldErrors.amount}</p>}</label>
   <label className="qd-field"><span className="qd-field-lbl">Sổ quỹ nhận cọc</span><select aria-label="Sổ quỹ nhận cọc" ref={accountRef} className={`qd-input ${fieldErrors.accountId?"border-destructive":""}`} value={accountId} aria-invalid={!!fieldErrors.accountId} aria-describedby={fieldErrors.accountId?"quick-account-error":undefined} onChange={e=>{setAccountId(e.target.value);clearField("accountId");}} disabled={submitting}><option value="">Chọn sổ quỹ</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select>{fieldErrors.accountId&&<p id="quick-account-error" role="alert" className="text-sm text-destructive">{fieldErrors.accountId}</p>}</label>
   <p className="qd-hint">Phiếu cọc theo trạng thái duyệt/nhận tiền hiện tại; chờ duyệt chưa tính là đã nhận.</p>
   <div className="qd-dates"><label className="qd-field"><span className="qd-field-lbl">Giữ chỗ đến (tùy chọn)</span><input className="qd-input" type="date" value={holdUntil} onChange={e=>setHoldUntil(e.target.value)} disabled={submitting}/></label><label className="qd-field"><span className="qd-field-lbl">Ngày dự kiến vào (tùy chọn)</span><input className="qd-input" type="date" value={moveInDate} onChange={e=>setMoveInDate(e.target.value)} disabled={submitting}/></label></div>
   <label className="qd-field"><span className="qd-field-lbl">Ngày bổ sung cọc (tùy chọn)</span><input className="qd-input" type="date" value={topupDate} onChange={e=>setTopupDate(e.target.value)} disabled={submitting}/></label>
   <p className="qd-hint">Quá hạn chỉ nhắc xử lý, phòng vẫn giữ cho khách này đến khi hủy hoặc ký hợp đồng.</p>{error&&<p role="alert" className="qd-err">{error}</p>}
  </div><div className="qd-actions"><button className="qd-btn qd-cancel" onClick={onClose} disabled={submitting}>Hủy</button><button className="qd-btn qd-submit" onClick={submit} disabled={submitting}>{submitting?'Đang lưu…':'Lưu cọc & giữ phòng'}</button></div>
 </div><CustomerSelectionDialog open={picker} onOpenChange={setPicker} selectedCustomerIds={customer?[customer.id]:[]} onSelect={values=>{if(values.length!==1){setFieldErrors(current=>({...current,customer:'Chọn đúng một khách hàng.'}));return;}setCustomer(values[0]);setHint('');clearField('customer');setPicker(false);setError('');}}/></>;
}
