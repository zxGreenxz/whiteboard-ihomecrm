import { describe,it,expect } from 'vitest';
import { draftsFromText,draftsFromBill,enrichFromAi,type ComposeContext } from '../compose';
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
