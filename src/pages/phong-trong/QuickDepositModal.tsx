import {useDepositIncomeHold} from '@/hooks/useDepositIncomeHold';
import { DepositScheduleFields } from '@/components/deposits/DepositScheduleFields';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {CurrencyInput} from '@/components/ui/currency-input';
import {validateInputDrafts} from '@/lib/inputDraftValidation';
import {useAccounts} from '@/hooks/useAccounts';
import {useCreateRoomReservation} from '@/hooks/useRoomReservations';
import {getSessionUser} from '@/lib/authSession';
import {CUSTOMER_HINT_MAX,reservationErrorMessage,type CreateRoomReservationInput} from '@/lib/reservationIdentityRpc';
import {saleLockRemaining} from '@/lib/roomSaleLockRpc';
import {Icon} from './icons';
import {fmtPrice,type Room} from './sampleData';
import {useTrack} from './useTracking';
import {todayISO} from '@/lib/collect';

export function QuickDepositModal({room,onClose,onDone,blockedReason}:{room:Room|null;onClose:()=>void;onDone:(msg:string)=>void;blockedReason?:string}){
 const create=useCreateRoomReservation({silent:true}),track=useTrack();const{data:accounts=[]}=useAccounts();
 const[amount,setAmount]=useState(0);const[holdUntil,setHoldUntil]=useState('');const[moveInDate,setMoveInDate]=useState('');const[topupDate,setTopupDate]=useState('');
 const[hint,setHint]=useState('');const[accountId,setAccountId]=useState('');const[myId,setMyId]=useState<string|null>(null);const[submitting,setSubmitting]=useState(false);const[error,setError]=useState('');
 const[fieldErrors,setFieldErrors]=useState<Partial<Record<'customer'|'amount'|'accountId',string>>>({});
 const modalRef=useRef<HTMLDivElement>(null),customerRef=useRef<HTMLInputElement>(null),amountRef=useRef<HTMLInputElement>(null),accountRef=useRef<HTMLSelectElement>(null);
 const clearField=(field:keyof typeof fieldErrors)=>setFieldErrors(current=>({...current,[field]:undefined}));
 const intent=useRef<{fingerprint:string;key:string}|null>(null);
 useEffect(()=>{let active=true;getSessionUser().then(u=>{if(active)setMyId(u?.id??null);});return()=>{active=false;};},[]);
 const defaultAccount=useMemo(()=>{const mine=accounts.filter(a=>a.user_id===myId);return mine.find(a=>a.is_default)??mine[0];},[accounts,myId]);
 useEffect(()=>{if(!accountId&&defaultAccount)setAccountId(defaultAccount.id);},[defaultAccount,accountId]);
 useEffect(()=>{setAmount(0);setHoldUntil('');setMoveInDate('');setTopupDate('');setHint('');setError('');setFieldErrors({});intent.current=null;},[room?.id]);
 const holdQuery=useDepositIncomeHold(room?.id);
 const loadedHold=useRef<string|null>(null);
 const loadedRevision=useRef<number|undefined>(undefined);
 useEffect(()=>{loadedHold.current=null;loadedRevision.current=undefined;},[room?.id]);
 useEffect(()=>{
   const hold=holdQuery.data;
   if(!hold || loadedHold.current===hold.id)return;
   loadedHold.current=hold.id;loadedRevision.current=hold.revision;setHint(current=>current||hold.payer||'');setHoldUntil(hold.hold_until??'');
   setMoveInDate(hold.intended_move_in_on??'');setTopupDate(hold.topup_due_on??'');
 },[holdQuery.data,room?.id]);
 if(!room)return null;const label=room.code||String(room.no);
 async function submit(){
  if(submitting||!room||blockedReason)return;
  if(holdQuery.isLoading||holdQuery.isError){setError('Chưa tải được đợt giữ chỗ của phòng.');return;}
  const money=amount,name=hint.trim();const errors:typeof fieldErrors={};
  if(!name)errors.customer='Nhập tên người gửi.';
  else if(name.length>CUSTOMER_HINT_MAX)errors.customer=`Người gửi tối đa ${CUSTOMER_HINT_MAX} ký tự.`;
  if(!Number.isSafeInteger(money)||money<=0)errors.amount='Nhập số tiền cọc nguyên dương hợp lệ.';
  if(!accountId)errors.accountId='Chọn sổ quỹ nhận cọc.';
  setFieldErrors(errors);setError('');
  if(Object.keys(errors).length){const refs={customer:customerRef,amount:amountRef,accountId:accountRef};const first=(['customer','amount','accountId'] as const).find(field=>errors[field]);if(first)refs[first].current?.focus();return;}
  if(!validateInputDrafts(modalRef.current))return;
  const input:Omit<CreateRoomReservationInput,'idempotencyKey'>={roomId:room.id,channel:'sale',expectedHoldId:loadedHold.current,expectedRevision:loadedRevision.current,customerHint:name,holdUntil:holdUntil||null,intendedMoveInOn:moveInDate||null,topupDueOn:topupDate||null,
   receipt:{amount:money,accountId,voucherDate:todayISO(),name:`Cọc phòng ${label} tòa ${room.buildingName}`}};
  const fingerprint=JSON.stringify(input);if(intent.current?.fingerprint!==fingerprint)intent.current={fingerprint,key:`room-reservation-${crypto.randomUUID()}`};
  setSubmitting(true);setError('');try{
   await create.mutateAsync({...input,idempotencyKey:intent.current.key});track.track('deposit_dialog',{room_id:room.id,room_code:room.code,room_name:String(room.no),building_id:room.buildingId,building_name:room.buildingName,metadata:{created:true,amount:money}});
   onDone(`Đã lưu cọc phòng ${label} cho “${name}”`);onClose();
  }catch(e){const message=reservationErrorMessage(e);setError(message);}finally{setSubmitting(false);}
 }
 return<><div className="qd-scrim show" onClick={submitting?undefined:onClose}/><div ref={modalRef} className="qd-modal show" role="dialog" aria-modal="true" aria-label="Nhận cọc giữ phòng">
  <div className="qd-head"><div className="qd-title"><Icon.Money/><span>Nhận cọc giữ phòng</span></div><button className="qd-x" onClick={onClose} aria-label="Đóng" disabled={submitting}><Icon.Close/></button></div>
  <div className="qd-body"><div className="qd-room"><span className="qd-room-name">Phòng {label} · Tòa {room.buildingName}</span><span className="qd-room-price">{fmtPrice(room.price)} tr/th</span></div>
   {room.exitHold&&<p className="qd-hint" data-testid="qd-exit-hold">Phòng đang chờ khách sang nhượng từ {room.exitHold.actualMoveOutOn.split('-').reverse().join('/')} (khách cũ {room.exitHold.oldCustomerName||'—'}{room.exitHold.oldContractNumber?' · '+room.exitHold.oldContractNumber:''}{room.exitHold.earlyReason==='SALE_ASSISTED'&&room.exitHold.saleName?' · sale '+room.exitHold.saleName:''}). Khách cọc phòng này là khách nhận; hợp đồng tạo sau sẽ tự nối với hồ sơ cũ{room.exitHold.earlyReason==='SELF_FOUND'?'; ca khách tự tìm không có hoa hồng môi giới hay thưởng sale':''}.</p>}
   {room.status==='locked'&&room.saleLock&&<p className="qd-hint">Phòng đang lock tạm bởi {room.saleLock.lockedByMe?'bạn':room.saleLock.lockedByName} ({saleLockRemaining(room.saleLock.expiresAt)}). Lưu phiếu cọc sẽ gỡ lock.</p>}
   <div className="qd-field"><span className="qd-field-lbl">Người gửi *</span>
    <input ref={customerRef} className={`qd-input ${fieldErrors.customer?"border-destructive":""}`} aria-label="Người gửi" placeholder="Nhập tên người gửi tiền cọc" value={hint} maxLength={CUSTOMER_HINT_MAX} aria-invalid={!!fieldErrors.customer} aria-describedby={fieldErrors.customer?"quick-customer-error":undefined} onChange={e=>{setHint(e.target.value);clearField('customer');}} disabled={submitting}/>
    {fieldErrors.customer&&<p id="quick-customer-error" role="alert" className="text-sm text-destructive">{fieldErrors.customer}</p>}</div>
   <label className="qd-field"><span className="qd-field-lbl">Số tiền cọc</span><CurrencyInput ref={amountRef} aria-label="Số tiền cọc" className={`qd-input ${fieldErrors.amount?"border-destructive":""}`} value={amount} aria-invalid={!!fieldErrors.amount} aria-describedby={fieldErrors.amount?"quick-amount-error":undefined} onChange={value=>{setAmount(value);clearField("amount");}} disabled={submitting}/>{fieldErrors.amount&&<p id="quick-amount-error" role="alert" className="text-sm text-destructive">{fieldErrors.amount}</p>}</label>
   <label className="qd-field"><span className="qd-field-lbl">Sổ quỹ nhận cọc</span><select aria-label="Sổ quỹ nhận cọc" ref={accountRef} className={`qd-input ${fieldErrors.accountId?"border-destructive":""}`} value={accountId} aria-invalid={!!fieldErrors.accountId} aria-describedby={fieldErrors.accountId?"quick-account-error":undefined} onChange={e=>{setAccountId(e.target.value);clearField("accountId");}} disabled={submitting}><option value="">Chọn sổ quỹ</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select>{fieldErrors.accountId&&<p id="quick-account-error" role="alert" className="text-sm text-destructive">{fieldErrors.accountId}</p>}</label>
   <p className="qd-hint">Phiếu cọc theo trạng thái duyệt/nhận tiền hiện tại; chờ duyệt chưa tính là đã nhận.</p>
   <DepositScheduleFields key={holdQuery.data?.id??room.id} voucherDate={todayISO()} value={{holdUntil,moveIn:moveInDate,topup:topupDate}}
    disabled={submitting} onChange={next=>{setHoldUntil(next.holdUntil);setMoveInDate(next.moveIn);setTopupDate(next.topup);}}/>
   <p className="qd-hint">Quá hạn chỉ nhắc xử lý, phòng vẫn giữ cho khách này đến khi hủy hoặc ký hợp đồng.</p>{error&&<p role="alert" className="qd-err">{error}</p>}{blockedReason&&<p role="alert" className="qd-err">{blockedReason}</p>}
  </div><div className="qd-actions"><button className="qd-btn qd-cancel" onClick={onClose} disabled={submitting}>Hủy</button><button className="qd-btn qd-submit" onClick={submit} disabled={submitting||!!blockedReason}>{submitting?'Đang lưu…':'Lưu cọc & giữ phòng'}</button></div>
 </div></>;
}
