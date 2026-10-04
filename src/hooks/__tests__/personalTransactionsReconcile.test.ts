// @vitest-environment jsdom
// Recovery is now server request-key based; no content/time-window lookup is permitted.
import {beforeEach,describe,it,expect,vi} from 'vitest';
import {createPendingRequests} from '@/lib/personalFinance/pendingRequests';
import {PersonalFinanceError} from '@/lib/personalFinance/service';
import type {Mutation,Receipt} from '@/lib/personalFinance/contract';
const owner='11111111-1111-4111-8111-111111111111';
const payload:Mutation={action:'wallet.create',data:{name:'Ví'}};
const requests=()=>createPendingRequests(localStorage,async()=>owner);
const receipt=(key:string):Receipt=>({owner_id:owner,request_key:key,action:payload.action,entities:[{id:owner,user_id:owner,version:1}]});
const fail=()=>{throw new PersonalFinanceError('network','offline',null,true);};
beforeEach(()=>localStorage.clear());
describe('useCreatePersonalTransaction recovery contract',()=>{
 it('server already wrote: replay returns same receipt, never creates new request key',async()=>{
  const r=requests(),p=r.prepare(owner,payload);await expect(r.run(p,async()=>fail())).rejects.toThrow();
  const replay=vi.fn(async(key:string)=>receipt(key));expect(await requests().run(requests().list(owner)[0],replay)).toEqual(receipt(p.requestKey));expect(replay.mock.calls[0][0]).toBe(p.requestKey);
 });
 it('server did not write: retry same request can finish then independent entry proceeds',async()=>{
  const r=requests(),p=r.prepare(owner,payload);await expect(r.run(p,async()=>fail())).rejects.toThrow();await r.run(p,async key=>receipt(key));
  const next=r.prepare(owner,payload);expect(next.requestKey).not.toBe(p.requestKey);await r.run(next,async key=>receipt(key));expect(r.list(owner)).toEqual([]);
 });
 it('another entry is not blocked by an unknown request',async()=>{
  const r=requests(),p=r.prepare(owner,payload);await expect(r.run(p,async()=>fail())).rejects.toThrow();
  const other=r.prepare(owner,{...payload,data:{name:'Khác'}});await expect(r.run(other,async key=>receipt(key))).resolves.toBeTruthy();expect(r.list(owner)).toEqual([p]);
 });
 it('saving another entry cannot clear the pending request',async()=>{
  const r=requests(),p=r.prepare(owner,payload);await expect(r.run(p,async()=>fail())).rejects.toThrow();
  const other=r.prepare(owner,payload);await r.run(other,async key=>receipt(key));expect(r.list(owner)[0].requestKey).toBe(p.requestKey);await r.run(p,async key=>receipt(key));expect(r.list(owner)).toEqual([]);
 });
 it('identical content or different amounts never prove identity',()=>{
  const r=requests(),a=r.prepare(owner,payload),b=r.prepare(owner,payload),c=r.prepare(owner,{...payload,data:{name:'Khác'}});
  expect(new Set([a.requestKey,b.requestKey,c.requestKey]).size).toBe(3);
 });
 it('reconciliation belongs to current actor, never a time window',async()=>{
  const r=requests(),p=r.prepare(owner,payload);const stranger=createPendingRequests(localStorage,async()=>null);const send=vi.fn();
  await expect(stranger.run(p,send)).rejects.toThrow();expect(send).not.toHaveBeenCalled();expect(r.list(owner)).toEqual([p]);
 });
 it('retry network error keeps original payload and key',async()=>{
  const r=requests(),p=r.prepare(owner,payload);await expect(r.run(p,async()=>fail())).rejects.toThrow();await expect(requests().run(p,async()=>fail())).rejects.toThrow();expect(r.list(owner)).toEqual([p]);
 });
});
