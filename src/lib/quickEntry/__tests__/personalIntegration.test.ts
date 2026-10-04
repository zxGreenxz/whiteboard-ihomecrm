import { describe,it,expect } from 'vitest';
import { draftsFromText,draftsFromBill,enrichFromAi,splitDraftTypes,type ComposeContext } from '../compose';
import { toPersonalBatch,toCreateIncomeExpenseInput } from '../convert';
import { parseAiResult } from '../aiSchema';
import { deserializeCards,serializeCards } from '../feedStorage';
import {inferTransactionType} from '../personalRefs';
const id='11111111-1111-4111-8111-111111111111';
const context:ComposeContext={today:'2026-09-30',mode:'personal',refs:{buildings:[],rooms:[]},categories:[],personalWalletId:id,personalCategoryRefs:[{id:'income',name:'Lương',type:'INCOME',hidden:false},{id:'expense',name:'Ăn uống',type:'EXPENSE',hidden:false}],newId:()=>crypto.randomUUID(),defaultAccountFor:()=>null};
describe('real personal QuickEntry',()=>{
 it('distinguishes received salary from paying wages and medicine',()=>{
  expect(inferTransactionType('nhận lương 10 triệu')).toBe('INCOME');
  expect(inferTransactionType('102LVT trả lương thợ 3 triệu')).toBe('EXPENSE');
  expect(inferTransactionType('mua thuốc 50k')).toBe('EXPENSE');
 });
 it('keeps identical independent lines; splits mixed income/expense',()=>{
  const drafts=draftsFromText('nhận lương 10 triệu; ăn sáng 50k; ăn sáng 50k',context);
  expect(drafts).toHaveLength(2);
  expect(drafts.map(s=>s.draft.transactionType)).toEqual(['INCOME','EXPENSE']);
  const expense=drafts[1].draft;expense.lines=expense.lines.map(l=>({...l,personalCategoryId:id}));
  expect(toPersonalBatch(expense).rows).toHaveLength(2);
 });
 it('validates AI type; maps only category refs of the same type; preserves user edits',()=>{
  const parsed=parseAiResult(JSON.stringify({items:[{desc:'lương',amount_vnd:200,transactionType:'INCOME',category:'c2'}]}),2);
  expect(parsed.ok).toBe(true);if(!parsed.ok)return;
  const [s]=draftsFromBill(parsed.value,context);expect(s.draft.lines[0].personalCategoryId).toBeNull();
  s.touched=['lines.0.personalCategoryId','transactionType'];s.draft.lines[0].personalCategoryId='income';
  const next=enrichFromAi(s,parsed.value,context);expect(next.draft.lines[0].personalCategoryId).toBe('income');
  expect(parseAiResult('{"items":[{"transactionType":"TRANSFER"}]}',2).ok).toBe(false);
 });
 it('quarantines legacy unconfirmed cards and keeps confirmed-row progress',()=>{
  const [s]=draftsFromText('ăn 50k',context);delete s.draft.personalProtocol;delete s.draft.personalRequestKey;
  const raw=serializeCards([{state:s,status:{kind:'unknown',message:'offline'},personalDone:1}],100);
  const [restored]=deserializeCards(raw,101);expect(restored.status.kind).toBe('maybe_saved');expect(restored.personalDone).toBe(1);
 });
 it('company income uses existing income writer without personal identities',()=>{
  const [s]=draftsFromText('thu tiền thuê 3 triệu',{...context,mode:'company'});
  const d={...s.draft,buildingId:'b',accountId:'a',lines:s.draft.lines.map(l=>({...l,categoryId:'rent'}))};
  expect(toCreateIncomeExpenseInput(d)).toMatchObject({type:'INCOME'});
  expect(toCreateIncomeExpenseInput(d)).not.toHaveProperty('personalWalletId');
 });
});

const incomeCategory='22222222-2222-4222-8222-222222222222';
const expenseCategory='33333333-3333-4333-8333-333333333333';
const giftCategory='44444444-4444-4444-8444-444444444444';
const aiResult=(value:unknown)=>{const parsed=parseAiResult(JSON.stringify(value),3);if(!parsed.ok)throw new Error('Invalid test AI');return parsed.value;};
const mixedAi=aiResult({items:[{desc:'Lương',transactionType:'INCOME',amount_vnd:10_000_000,category:'c1'},{desc:'Ăn sáng',transactionType:'EXPENSE',amount_vnd:50_000,category:'c2'}]});
const typedContext=(mode:'personal'|'company'):ComposeContext=>({
 ...context,mode,
 personalCategoryRefs:[{id:incomeCategory,name:'Lương',type:'INCOME',hidden:false},{id:expenseCategory,name:'Ăn uống',type:'EXPENSE',hidden:false},{id:giftCategory,name:'Quà',type:'INCOME',hidden:false}],
 categories:[{id:incomeCategory,name:'Lương',type:'income',category:null},{id:expenseCategory,name:'Ăn uống',type:'expense',category:null},{id:giftCategory,name:'Quà',type:'income',category:null}],
});
describe.each(['personal','company'] as const)('review regressions: %s',mode=>{
 it.each([0,10_000_000])('one parsed line amount %i retains all mixed AI items before splitting',amount=>{
  const ctx=typedContext(mode);
  const [s]=draftsFromText('vừa nhận lương mười triệu rồi ăn sáng năm mươi nghìn',ctx);
  expect(s.draft.lines).toHaveLength(1);s.draft.lines[0].amount=amount;
  const result=splitDraftTypes(enrichFromAi(s,mixedAi,ctx),ctx.newId);
  expect(result.map(r=>({type:r.draft.transactionType,amount:r.draft.lines.reduce((sum,l)=>sum+l.amount,0)}))).toEqual([{type:'INCOME',amount:10_000_000},{type:'EXPENSE',amount:50_000}]);
  expect(result.flatMap(r=>r.draft.lines).map(l=>mode==='personal'?l.personalCategoryId:l.categoryId)).toEqual([incomeCategory,expenseCategory]);
 });
 it.each([false,true])('mixed expansion preserves edits with AI items reversed=%s',reverse=>{
  const ctx=typedContext(mode);const [s]=draftsFromText('nhận lương và ăn sáng',ctx);
  s.draft.date='2026-09-15';s.draft.lines[0]={...s.draft.lines[0],amount:9_000_000,description:'Lương đã kiểm',personalCategoryId:giftCategory,categoryId:giftCategory};
  s.touched=['date','lines.0.amount','lines.0.description','lines.0.personalCategoryId','lines.0.categoryId'];
  const result=splitDraftTypes(enrichFromAi(s,{...mixedAi,items:reverse?[...mixedAi.items].reverse():mixedAi.items},ctx),ctx.newId);
  const income=result.find(r=>r.draft.transactionType==='INCOME')!;const expense=result.find(r=>r.draft.transactionType==='EXPENSE')!;
  expect(result).toHaveLength(2);expect(income.draft.lines[0]).toMatchObject({amount:9_000_000,description:'Lương đã kiểm',personalCategoryId:giftCategory,categoryId:giftCategory});
  expect(expense.draft.lines[0]).toMatchObject({amount:50_000,transactionType:'EXPENSE'});expect(result.every(r=>r.draft.date==='2026-09-15')).toBe(true);
  expect(income.touched).toContain('lines.0.amount');expect(expense.touched).not.toContain('lines.0.amount');
 });
 it.each(['touched','locked'] as const)('an ambiguous %s original remains a same-direction aggregate without dropping the other direction',editKind=>{
  const ctx=typedContext(mode);const [s]=draftsFromText('nhận lương và ăn sáng',ctx);
  s.draft.lines[0].amount=9_000_000;s[editKind]=['lines.0.amount'];
  const ai={...mixedAi,items:[...mixedAi.items,{...mixedAi.items[0],desc:'Quà',amount_vnd:100_000,category:'c3'}]};
  const result=splitDraftTypes(enrichFromAi(s,ai,ctx),ctx.newId);
  expect(result.map(r=>r.draft.lines.map(l=>[l.transactionType,l.amount]))).toEqual([[['INCOME',9_000_000]],[['EXPENSE',50_000]]]);
  expect(result[0].draft.lines[0].description).toContain('Quà');
 });
 it.each([
  ['none','c1'],['date','c1'],['personalWalletId','c1'],
  ['none','c3'],['date','c3'],['personalWalletId','c3'],
 ] as const)('keeps independent AI rows with top-level edit %s and second category %s', (edit,secondCategory)=>{
  const ctx=typedContext(mode);const [s]=draftsFromText('nhận lương và ăn sáng',ctx);
  s.draft.lines[0].amount=0;s.touched=[];s.locked=[];
  if(edit!=='none'){
   s.touched=[edit];s.draft.date='2026-09-15';s.draft.personalWalletId=giftCategory;
  }
  const ai=aiResult({date:'2026-09-30',items:[
   {desc:'Khoản nhận thứ nhất',transactionType:'INCOME',amount_vnd:100_000,category:'c1'},
   {desc:'Khoản nhận thứ hai',transactionType:'INCOME',amount_vnd:100_000,category:secondCategory},
   {desc:'Ăn trưa',transactionType:'EXPENSE',amount_vnd:50_000,category:'c2'},
  ]});
  const result=splitDraftTypes(enrichFromAi(s,ai,ctx),ctx.newId);
  const lines=result.flatMap(r=>r.draft.lines);
  expect(lines.map(l=>[l.transactionType,l.amount])).toEqual([['INCOME',100_000],['INCOME',100_000],['EXPENSE',50_000]]);
  expect(lines.map(l=>mode==='personal'?l.personalCategoryId:l.categoryId)).toEqual([incomeCategory,secondCategory==='c1'?incomeCategory:giftCategory,expenseCategory]);
  expect(lines.map(l=>l.description)).toEqual(['Khoản nhận thứ nhất','Khoản nhận thứ hai','Ăn trưa']);
  if(edit==='date')expect(result.every(r=>r.draft.date==='2026-09-15')).toBe(true);
  if(edit==='personalWalletId')expect(result.every(r=>r.draft.personalWalletId===giftCategory)).toBe(true);
  const rowCounts=result.map(({draft})=>mode==='personal'?toPersonalBatch(draft).rows!.length:toCreateIncomeExpenseInput({...draft,buildingId:id,accountId:id}).items.length);
  expect(rowCounts).toEqual([2,1]);
 });
 it.each(['total','discount'] as const)('income photo %s reconciliation does not derive direction from category consensus',kind=>{
  const value=aiResult({items:[{desc:'Lương',transactionType:'INCOME',amount_vnd:10_000_000,category:'c1'},{desc:'Quà',transactionType:'INCOME',amount_vnd:100_000,category:'c3'},...(kind==='discount'?[{desc:'Giảm trừ',transactionType:'INCOME',amount_vnd:-10_000,category:null}]:[])],...(kind==='total'?{total_vnd:10_090_000}:{})});
  const [result]=draftsFromBill(value,typedContext(mode));
  expect(result.draft.transactionType).toBe('INCOME');expect(result.draft.lines[0]).toMatchObject({transactionType:'INCOME',amount:10_090_000});expect(result.flags).toContain('check_total');
  const ready={...result.draft,buildingId:id,accountId:id,lines:result.draft.lines.map(l=>({...l,categoryId:incomeCategory,personalCategoryId:incomeCategory}))};
  if(mode==='company')expect(toCreateIncomeExpenseInput(ready).type).toBe('INCOME');else expect(toPersonalBatch(ready).rows?.[0].type).toBe('INCOME');
 });
});
