import { describe, expect, it } from 'vitest';
import { draftsFromText, draftsFromBill, enrichFromAi, splitDraftTypes, type ComposeContext } from '../compose';
import { parseAiResult } from '../aiSchema';
import { resolvePersonalDraft } from '../personalRefs';
import { serializeCards, deserializeCards } from '../feedStorage';
import type { Wallet } from '@/lib/personalFinance/contract';

const wallet = (id: string, name: string, kind: Wallet['kind'], is_default=false): Wallet => ({id,name,kind,is_default,hidden:false,user_id:'u',version:1,icon:'wallet',opening_balance:0,balance:0});
const wallets = [wallet('bank','Tk939','bank',true),wallet('cash','Tiền mặt','cash'),wallet('sp','Thẻ SP','other')];
const ctx = (list=wallets): ComposeContext => ({today:'2026-10-07',mode:'personal',refs:{buildings:[],rooms:[]},categories:[],personalWalletId:'bank',personalWallets:list,newId:()=>crypto.randomUUID(),defaultAccountFor:()=>null});
const ai = (input: unknown) => {const result=parseAiResult(JSON.stringify(input),0);if(!result.ok) throw new Error('AI evidence rejected');return result.value;};

describe('personal wallet precedence',()=>{
 it.each(['ăn sáng 50k','ăn sáng 50k tiền mặt','Grab 50k tiền mặt'])('chooses cash instead of bank default: %s',text=>{
  expect(draftsFromText(text,ctx())[0].draft.personalWalletId).toBe('cash');
 });
 it.each(['Shopee','ShopeeFood','Shopee Food','ShopeePay','Shopee Pay','Grab','GrabFood','Grab Food','GrabExpress','Grab Express','GrabBike','Grab Bike','GrabCar','Grab Car','GrabMart','Grab Mart','GrabTaxi','Grab Taxi','GrabRent','Grab Rent','GrabDelivery','Grab Delivery'])('recognizes platform service %s from text/STT',service=>{
  expect(draftsFromText(`${service} 50k`,ctx())[0].draft.personalWalletId).toBe('sp');
 });
 it.each(['không đi Grab, ăn sáng 50k','không phải Shopee, mua đồ ăn 50k','đồ ăn 50k','mua grabber 50k'])('does not invent platform spending: %s',text=>{
  expect(draftsFromText(text,ctx()).every(s=>s.draft.personalWalletId==='cash')).toBe(true);
 });
 it('honors a full explicit wallet name with normalized spelling and boundaries',()=>{
  expect(draftsFromText('Grab 50k từ ví TK939',ctx())[0].draft.personalWalletId).toBe('bank');
  expect(draftsFromText('Grab 50k vi the   sp',ctx())[0].draft.personalWalletId).toBe('sp');
  expect(draftsFromText('ăn 50k tài khoản 939',ctx())[0].draft.personalWalletId).toBe('cash');
  expect(draftsFromText('ăn 50k Tk9399',ctx())[0].draft.personalWalletId).toBe('cash');
 });
 it.each(['Grab 50k ví chưa tạo','ăn 50k ví Tk777'])('requires selection for an explicitly named unavailable wallet: %s',text=>{
  expect(draftsFromText(text,ctx())[0].draft.personalWalletId).toBeNull();
 });
 it('does not mistake the Vietnamese conjunction vì for an explicit wallet',()=>{
  expect(draftsFromText('ăn sáng 50k vì trời mưa',ctx())[0].draft.personalWalletId).toBe('cash');
 });
 it('groups each line by wallet and direction without leaking platform',()=>{
  const result=draftsFromText('Grab 50k; đổ xăng 100k tiền mặt; nhận lương 10 triệu',ctx());
  expect(result.map(s=>[s.draft.personalWalletId,s.draft.transactionType,s.draft.lines.length])).toEqual([['sp','EXPENSE',1],['cash','EXPENSE',1],['cash','INCOME',1]]);
 });
 it.each(['missing','hidden','duplicate'] as const)('requires selection when SP is %s and keeps intentional null on reload',kind=>{
  const list=kind==='missing'?wallets.slice(0,2):kind==='hidden'?wallets.map(w=>w.id==='sp'?{...w,hidden:true}:w):[...wallets,wallet('sp2','the sp','bank')];
  const state=draftsFromText('Grab 50k',ctx(list))[0];
  expect(state.draft.personalWalletId).toBeNull();
  const [restored]=deserializeCards(serializeCards([{state,status:{kind:'draft'},personalDone:0}],100),101);
  expect(resolvePersonalDraft(restored.state.draft,list,[]).personalWalletId).toBeNull();
 });
 it('rejects ambiguous explicit names and does not fall back to another wallet kind',()=>{
  expect(draftsFromText('ăn 50k ví Tk939',ctx([...wallets,wallet('bank2','tk939','bank')]))[0].draft.personalWalletId).toBeNull();
  expect(draftsFromText('ăn 50k tiền mặt',ctx(wallets.filter(w=>w.kind!=='cash')))[0].draft.personalWalletId).toBeNull();
  expect(draftsFromText('ăn 50k chuyển khoản',ctx(wallets.filter(w=>w.kind!=='bank')))[0].draft.personalWalletId).toBeNull();
 });
 it('reads optional image evidence while preserving old AI results',()=>{
  expect(draftsFromBill(ai({vendor:'quán QR ngân hàng STK 939',items:[{desc:'ăn',amount_vnd:50000}]}),ctx())[0].draft.personalWalletId).toBe('cash');
  expect(draftsFromBill(ai({payment_method:'bank_transfer',items:[{desc:'ăn',amount_vnd:50000}]}),ctx())[0].draft.personalWalletId).toBe('bank');
  expect(draftsFromBill(ai({platform:'grab',items:[{desc:'ăn',amount_vnd:50000}]}),ctx())[0].draft.personalWalletId).toBe('sp');
  expect(draftsFromBill(ai({platform:'shopee',items:[{desc:'ăn',amount_vnd:50000}]}),{...ctx(),sourceText:'tiền mặt'})[0].draft.personalWalletId).toBe('cash');
  expect(draftsFromBill(ai({platform:'grab',items:[{desc:'ăn',amount_vnd:50000}]}),{...ctx(),sourceText:'ví Tk939'})[0].sourceText).toBe('ví Tk939');
 });
 it('chooses bank first visible when no bank is default',()=>{
  const list=[wallet('cash','Tiền mặt','cash',true),wallet('hidden','Hidden','bank',true),wallet('bank','Tk939','bank')];list[1].hidden=true;
  expect(draftsFromBill(ai({payment_method:'bank_transfer',total_vnd:50000}),ctx(list))[0].draft.personalWalletId).toBe('bank');
 });
 it('recognizes actual platform names on old image output',()=>{
  expect(draftsFromBill(ai({vendor:'Grab Express',items:[{desc:'giao hàng',amount_vnd:50000}]}),ctx())[0].draft.personalWalletId).toBe('sp');
 });
 it('ignores negative AI platform evidence from text',()=>{
  const state=draftsFromText('không đi Grab, ăn sáng 50k',ctx())[0];
  expect(enrichFromAi(state,ai({platform:'grab',items:[{desc:'ăn sáng',amount_vnd:50000,platform:'grab'}]}),ctx()).draft.personalWalletId).toBe('cash');
 });
 it('separates image item platform evidence without spilling to unrelated rows',()=>{
  const result=draftsFromBill(ai({items:[{desc:'xe',amount_vnd:50000,platform:'grab'},{desc:'xăng',amount_vnd:100000}]}),ctx());
  expect(result.map(s=>[s.draft.personalWalletId,s.draft.lines[0].amount])).toEqual([['sp',50000],['cash',100000]]);
 });
 it('splits same-direction AI items by wallet and retains manual choice and separate request keys',()=>{
  const state=draftsFromText('đi xe rồi đổ xăng',ctx())[0];
  state.draft.personalRequestKey=crypto.randomUUID();
  const result=splitDraftTypes(enrichFromAi(state,ai({items:[{desc:'Grab',amount_vnd:50000,platform:'grab'},{desc:'xăng',amount_vnd:100000,payment_method:'cash'}]}),ctx()),ctx().newId);
  expect(result.map(s=>[s.draft.personalWalletId,s.draft.lines[0].amount])).toEqual([['sp',50000],['cash',100000]]);
  expect(new Set(result.map(s=>s.draft.id)).size).toBe(2);
  expect(new Set(result.map(s=>s.draft.personalRequestKey)).size).toBe(2);
  state.touched=['personalWalletId'];state.draft.personalWalletId='bank';
  expect(splitDraftTypes(enrichFromAi(state,ai({items:[{desc:'Grab',amount_vnd:50000,platform:'grab'},{desc:'xăng',amount_vnd:100000,payment_method:'cash'}]}),ctx()),ctx().newId).every(s=>s.draft.personalWalletId==='bank')).toBe(true);
 });
 it('uses common evidence when AI combines multiple same-wallet items or returns top-level evidence',()=>{
  const state=draftsFromText('đi xe rồi ăn',ctx())[0];
  expect(enrichFromAi(state,ai({items:[{desc:'xe',amount_vnd:50000,platform:'grab'},{desc:'ăn',amount_vnd:100000,platform:'grab'}]}),ctx()).draft.personalWalletId).toBe('sp');
 });
 it('uses top-level evidence with an item lacking optional fields',()=>{
  const state=draftsFromText('đi xe',ctx())[0];
  expect(enrichFromAi(state,ai({platform:'grab',items:[{desc:'xe',amount_vnd:50000}]}),ctx()).draft.personalWalletId).toBe('sp');
 });
 it.each(['Grab 50k không có bill','Shopee 100k chưa nhận hàng'])('retains positive platform despite unrelated negation: %s',text=>{
  expect(draftsFromText(text,ctx())[0].draft.personalWalletId).toBe('sp');
 });
 it.each(['chuyển khoản: phở 50k, cơm 30k','phở 50k, cơm 30k, tất cả chuyển khoản'])('a method said once applies to every line that names none: %s',text=>{
  expect(draftsFromText(text,ctx()).flatMap(s=>s.draft.lines.map(()=>s.draft.personalWalletId))).toEqual(['bank','bank']);
 });
 it('conflicting per-line methods are not spread to each other',()=>{
  expect(draftsFromText('phở 50k tiền mặt, cơm 30k chuyển khoản',ctx()).map(s=>s.draft.personalWalletId)).toEqual(['cash','bank']);
 });
 it.each(['grab 40k không trả bằng tiền mặt','không phải thanh toán tiền mặt, grab 40k','shopee 100k không phải grab'])('negation with several fillers removes only the negated phrase: %s',text=>{
  expect(draftsFromText(text,ctx())[0].draft.personalWalletId).toBe('sp');
 });
 it('one-word wallet names that are ordinary words need a lead such as "ví"',()=>{
  const list=[...wallets,wallet('home','Nhà','other'),wallet('car','Xe','other')];
  for (const text of ['ăn sáng 30k nha','tiền nhà 3tr','đổ xăng xe 50k']) expect(draftsFromText(text,ctx(list))[0].draft.personalWalletId).toBe('cash');
  expect(draftsFromText('gửi 3tr vào ví Nhà',ctx(list))[0].draft.personalWalletId).toBe('home');
 });
 it('does not treat a negated payment method as explicit cash',()=>{
  expect(draftsFromText('Grab 50k không tiền mặt',ctx())[0].draft.personalWalletId).toBe('sp');
  expect(draftsFromBill(ai({payment_method:'bank_transfer',total_vnd:50000}),{...ctx(),sourceText:'không tiền mặt'})[0].draft.personalWalletId).toBe('bank');
 });
});
