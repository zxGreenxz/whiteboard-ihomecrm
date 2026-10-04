import { describe, expect, it } from 'vitest';
import { createPendingRequests } from './pendingRequests';
import { selectMonth, selectBalance, selectGoals, localMonth, csvCell } from './selectors';
import { PersonalFinanceError } from './service';
import type { Snapshot, Mutation, Receipt } from './contract';
import {transactionChanges,transactionInput} from './transactionInput';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const key = '33333333-3333-4333-8333-333333333333';
const payload: Mutation = { action: 'wallet.create', data: { name: 'Tiền mặt' } };
const receipt = { owner_id: owner, request_key: key, action: payload.action, entities: [{ id: other, user_id: owner, version: 1 }] } as Receipt;
function fixture() {
 const data = new Map<string, string>();
 const storage = { get length(){return data.size;}, key:(i:number)=>[...data.keys()][i]??null, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string,v: string) => { data.set(k,v); }, removeItem: (k: string) => { data.delete(k); } };
 return { data, storage };
}
describe('pending money requests', () => {
 it('persists before send; reload replays original key/payload and owner only', async () => {
  const {storage}=fixture(); let actor=owner;
  const requests=createPendingRequests(storage, async()=>actor);
  const pending=requests.prepare(owner,payload,key);
  await expect(requests.run(pending,async()=>{ throw new PersonalFinanceError('network','offline',null,true); })).rejects.toThrow('offline');
  const reloaded=createPendingRequests(storage,async()=>actor);
  expect(reloaded.list(other)).toEqual([]);
  expect(reloaded.list(owner)).toEqual([pending]);
  actor=other;
  await expect(reloaded.run(pending,async()=>receipt)).rejects.toThrow();
  expect(reloaded.list(owner)).toHaveLength(1);
  actor=owner;
  await expect(reloaded.run(pending,async(k,p)=>{expect(k).toBe(key); expect(p).toEqual(payload);return receipt;})).resolves.toEqual(receipt);
  expect(reloaded.list(owner)).toEqual([]);
 });
 it('locks double submit, rejects changed payload, preserves unknown on actor change', async()=>{
  const {storage}=fixture(); let actor=owner; let calls=0;
  const r=createPendingRequests(storage,async()=>actor);const p=r.prepare(owner,payload,key);
  expect(()=>r.prepare(owner,{...payload,data:{name:'Changed'}},key)).toThrow();
  let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});
  const write=async()=>{calls++; await gate;return receipt;};
  const a=r.run(p,write),b=r.run(p,write);await Promise.resolve();await Promise.resolve();
  actor=other; finish();
  await expect(a).rejects.toThrow();await expect(b).rejects.toThrow();
  expect(calls).toBe(1);expect(r.list(owner)).toHaveLength(1);
 });
 it('identical independent operations get different keys',()=>{
  const r=createPendingRequests(fixture().storage,async()=>owner);
  expect(r.prepare(owner,payload).requestKey).not.toBe(r.prepare(owner,payload).requestKey);
 });
 it('storage failure prevents sending an unrecoverable request',()=>{
  const storage=fixture().storage;storage.setItem=()=>{throw new Error('quota');};
  expect(()=>createPendingRequests(storage,async()=>owner).prepare(owner,payload)).toThrow('quota');
 });
});
it('legacy fractional value is omitted from unrelated edits and version is never replaced',()=>{
 const before={id:key,user_id:owner,version:7,type:'EXPENSE' as const,amount:100.75,txn_date:'2020-01-01',description:' cũ ',category:'Ăn uống',wallet_id:null,category_id:null,resolved_wallet_id:owner,resolved_category_id:key,created_at:'2020-01-01T00:00:00Z',updated_at:'2020-01-01T00:00:00Z',deleted_at:null};
 const changes=transactionChanges(before,{type:before.type,amount:before.amount,txn_date:before.txn_date,category:before.category,description:'Mới'});
 expect(changes).toEqual({description:'Mới'});expect(transactionInput(changes,{wallets:[],categories:[]} as unknown as Snapshot,before)).toEqual({description:'Mới'});expect(before.version).toBe(7);
});
describe('server snapshot selectors',()=>{
 const snapshot={owner_id:owner, schema_version:1,wallets:[{balance:123.75,hidden:true},{balance:-2}],categories:[],transfers:[{amount:900}],budgets:[{id:'all',category_id:null,amount:2000},{id:'food',category_id:'food',amount:1000}],goals:[],transactions:Array.from({length:1005},(_,i)=>({id:String(i),user_id:owner,type:i===1004?'INCOME':'EXPENSE',amount:i===0?0.5:1,txn_date:'2026-09-01',created_at:'2026-09-01T00:00:00Z',deleted_at:null,resolved_category_id:'food'}))} as unknown as Snapshot;
 it('counts every row, preserves fractions, separates income/expense, ignores transfers and other owners',()=>{
  const s={...snapshot,transactions:[...snapshot.transactions,{...snapshot.transactions[1],user_id:other,amount:999999}]};
  expect(selectMonth(s,'2026-09')).toMatchObject({income:1,expense:1003.5,net:-1002.5});
  expect(selectBalance(s)).toBe(121.75);
  expect(selectMonth(s,'2026-08')).toMatchObject({income:0,expense:0});
  expect(selectMonth(s,'2026-09').budgets.map(b=>b.spent)).toEqual([1003.5,1003.5]);
 });
 it('escapes CSV formula prefixes, quotes and newlines',()=>{
  expect(csvCell(' =SUM(A1)')).toBe('"\' =SUM(A1)"');
  expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
 });
 it('uses local month and real goal contributions without counting them as income',()=>{
  expect(localMonth(new Date(2026,8,30,23,59))).toBe('2026-09');
  const s={...snapshot,goals:[{id:'goal',target:500,saved:200}],transfers:[{user_id:owner,goal_id:'goal',deleted_at:null,amount:200},{user_id:owner,goal_id:'goal',deleted_at:'x',amount:100}]} as unknown as Snapshot;
  const [goal]=selectGoals(s);expect(goal).toMatchObject({saved:200,remaining:300,ratio:0.4});expect(goal.contributions).toHaveLength(1);expect(selectMonth(s,'2026-09').income).toBe(1);
 });
});
