import { describe, expect, it } from 'vitest';
import type { Snapshot } from './contract';
import { selectBalance, selectMonth, selectGoals } from './selectors';

const snapshot=(amounts:number[]=[]):Snapshot=>({owner_id:'owner',schema_version:1,wallets:[],categories:[],transfers:[],budgets:[],goals:[],transactions:amounts.map((amount,i)=>({id:String(i),user_id:'owner',type:'EXPENSE',amount,txn_date:'2026-10-01',created_at:'2026-10-01T00:00:00Z',deleted_at:null,resolved_category_id:'food'}))} as unknown as Snapshot);
describe('exact personal money aggregates',()=>{
 it('adds decimal historical money exactly across totals, categories and budgets',()=>{
  const s=snapshot([0.1,0.2]);s.budgets=[{category_id:null,amount:1},{category_id:'food',amount:1}] as Snapshot['budgets'];
  expect(selectMonth(s,'2026-10')).toMatchObject({income:0,expense:0.3,net:-0.3,categories:[{amount:0.3}],budgets:[{spent:0.3,remaining:0.7},{spent:0.3,remaining:0.7}]});
  s.transactions.push({...s.transactions[0],id:'income',type:'INCOME',amount:0.5});
  expect(selectMonth(s,'2026-10').net).toBe(0.2);
 });
 it('subtracts budgets and goal balances without rounding historical precision',()=>{
  const s=snapshot([0.1]);s.budgets=[{category_id:null,amount:0.3}] as Snapshot['budgets'];
  s.goals=[{target:0.3,saved:0.1},{target:13,saved:12.125},{target:1,saved:2}] as Snapshot['goals'];
  expect(selectMonth(s,'2026-10').budgets[0].remaining).toBe(0.2);
  expect(selectGoals(s).map(g=>g.remaining)).toEqual([0.2,0.875,0]);
 });
 it.each([
  [[0.1,0.2],0.3], [[12.125,0.1,0.2,-12],0.425],
  [[Number.MAX_SAFE_INTEGER,0.1,-Number.MAX_SAFE_INTEGER,0.2],0.3],
  [[-Number.MAX_SAFE_INTEGER,-0.1,Number.MAX_SAFE_INTEGER,-0.2],-0.3],
  [[Number.MAX_SAFE_INTEGER-1,1],Number.MAX_SAFE_INTEGER],
  [[1e-7,2e-7],3e-7],
 ] as const)('sums wallets %j exactly (including cancellation)',(balances,want)=>{
  const s=snapshot();s.wallets=balances.map(balance=>({balance,hidden:true})) as Snapshot['wallets'];expect(selectBalance(s)).toBe(want);
 });
 it('repeated sums retain decimal values',()=>{
  const m=selectMonth(snapshot(Array(100).fill(0.1)),'2026-10');
  expect(m.expense).toBe(10);expect(m.categories[0].amount).toBe(10);
 });
 it.each([{amounts:[Number.MAX_SAFE_INTEGER,1]},{amounts:[Number.MAX_SAFE_INTEGER,0.1]},{amounts:[1_000_000_000_000,0.00001]}])('rejects totals that the Number boundary cannot retain: $amounts',({amounts})=>{
  const s=snapshot(amounts);s.wallets=amounts.map(balance=>({balance})) as Snapshot['wallets'];
  expect(()=>selectBalance(s)).toThrow(/biểu diễn chính xác/);
  expect(()=>selectMonth(s,'2026-10')).toThrow(/biểu diễn chính xác/);
 });
});
