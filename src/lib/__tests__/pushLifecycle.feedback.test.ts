// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io=vi.hoisted(()=>({db:vi.fn(),session:vi.fn(),getReg:vi.fn(),register:vi.fn(),getSub:vi.fn(),subscribe:vi.fn(),unsubscribe:vi.fn(),permission:vi.fn(),invoke:vi.fn()}));
vi.mock('@/lib/authSession',()=>({getSessionUserId:io.session}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{
 let mode='read';let input:Record<string,unknown>={};const filters:Record<string,unknown>={};
 const execute=()=>io.db({mode,input,filters});
 const q={upsert:(value:Record<string,unknown>)=>{mode='upsert';input=value;return q;},delete:()=>{mode='delete';return q;},eq:(key:string,value:unknown)=>{filters[key]=value;return q;},select:()=>q,
 single:()=>execute(),maybeSingle:()=>execute(),then:(resolve:(value:unknown)=>unknown,reject:(error:unknown)=>unknown)=>Promise.resolve(execute()).then(resolve,reject)};
 return q;
},functions:{invoke:io.invoke}}}));
import { enablePush,disablePush,registerServiceWorker,getExistingSubscription,isSubscribed,sendTestPush,VAPID_PUBLIC_KEY } from '../push';
import {FinancialWorkflowError} from '../financialWorkflowError';
let current:PushSubscription|null;
let registration:ServiceWorkerRegistration;
function keyBytes(){const raw=atob(VAPID_PUBLIC_KEY.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer;}
function subscription(key=keyBytes()):PushSubscription{
 return {endpoint:'https://private-push.example/SECRET_ENDPOINT',options:{applicationServerKey:key},unsubscribe:io.unsubscribe,getKey:()=>new Uint8Array([1,2]).buffer} as unknown as PushSubscription;
}
function stored(){return {id:'device-a',user_id:'actor-a',endpoint:'https://private-push.example/SECRET_ENDPOINT',p256dh:'AQI',auth:'AQI',is_active:true};}
beforeEach(()=>{
 vi.clearAllMocks();io.session.mockResolvedValue('actor-a');current=subscription();
 io.getSub.mockImplementation(async()=>current);
 io.unsubscribe.mockImplementation(async()=>{current=null;return true;});
 io.subscribe.mockImplementation(async()=>{current=subscription();return current;});
 io.permission.mockResolvedValue('granted');
 registration={active:{},pushManager:{getSubscription:io.getSub,subscribe:io.subscribe}} as unknown as ServiceWorkerRegistration;
 io.getReg.mockImplementation(async()=>registration);io.register.mockImplementation(async()=>registration);
 vi.stubGlobal('PushManager',function(){});
 vi.stubGlobal('Notification',{permission:'granted',requestPermission:io.permission});
 Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{getRegistration:io.getReg,register:io.register,ready:Promise.resolve(registration)}});
 io.db.mockImplementation(async({mode,input}:{mode:string;input:Record<string,unknown>})=>({data:mode==='delete'?[stored()]:mode==='upsert'?{id:'device-a',...input}:stored(),error:null}));
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('push lifecycle truthful receipts',()=>{
 it('registration failure preserves the original cause and is not converted to null',async()=>{
  const failure=new Error('PRIVATE_SW_ERROR');io.getReg.mockRejectedValue(failure);
  await expect(registerServiceWorker()).rejects.toBe(failure);
 });
 it('enable registration failure does not replace it with another ready failure',async()=>{
  const failure=new Error('PRIVATE_SW_ERROR');io.getReg.mockRejectedValue(failure);
  Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{getRegistration:io.getReg,register:io.register,ready:Promise.resolve(registration)}});
  await expect(enablePush()).rejects.toBe(failure);
  expect(io.db).not.toHaveBeenCalled();
 });
 it('a browser without a worker returns no existing subscription without awaiting ready',async()=>{
  io.getReg.mockResolvedValue(undefined);
  await expect(getExistingSubscription()).resolves.toBeNull();
  expect(io.getSub).not.toHaveBeenCalled();
 });
 it('worker activation waiting is bounded and never claims enabled',async()=>{
  vi.useFakeTimers();registration={active:null,pushManager:{getSubscription:io.getSub,subscribe:io.subscribe}} as unknown as ServiceWorkerRegistration;
  Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{getRegistration:io.getReg,register:io.register,ready:new Promise(()=>{})}});
  const assertion=expect(enablePush()).rejects.toBeInstanceOf(Error);
  await vi.advanceTimersByTimeAsync(10000);await assertion;
  expect(io.subscribe).not.toHaveBeenCalled();expect(io.db).not.toHaveBeenCalled();
 });
 it.each(['false','throw'])('rotation stops on unconfirmed old-key unsubscribe %s',async mode=>{
  current=subscription(new Uint8Array([9]).buffer);
  const failure=new Error('PRIVATE_UNSUBSCRIBE');
  if(mode==='throw')io.unsubscribe.mockRejectedValue(failure);else io.unsubscribe.mockResolvedValue(false);
  await expect(enablePush()).rejects.toBeInstanceOf(FinancialWorkflowError);
  expect(io.subscribe).not.toHaveBeenCalled();expect(io.db).not.toHaveBeenCalled();
 });
 it('does not save a replacement subscription that still has the wrong key',async()=>{
  current=null;io.subscribe.mockResolvedValue(subscription(new Uint8Array([9]).buffer));
  await expect(enablePush()).rejects.toBeInstanceOf(FinancialWorkflowError);
  expect(io.db).not.toHaveBeenCalled();
 });
 it('known rotation uses the unchanged configured key and only then persists the matching subscription',async()=>{
  current=subscription(new Uint8Array([9]).buffer);
  await expect(enablePush()).resolves.toBe('granted');
  expect(io.unsubscribe).toHaveBeenCalledOnce();expect(io.subscribe).toHaveBeenCalledOnce();
  expect(new Uint8Array(io.subscribe.mock.calls[0][0].applicationServerKey)).toEqual(new Uint8Array(keyBytes()));
  expect(io.db).toHaveBeenCalledWith(expect.objectContaining({mode:'upsert'}));
 });
 it('browser subscribed but database save fails is partial with original cause',async()=>{
  current=null;const failure={code:'42501',message:'PRIVATE_DB_ERROR'};io.db.mockResolvedValue({data:null,error:failure});
  await expect(enablePush()).rejects.toMatchObject({outcome:'partial',cause:failure});
  expect(io.subscribe).toHaveBeenCalledOnce();
 });
 it.each([null,{id:'device-a',user_id:'wrong'},{id:'device-a',is_active:false}])('missing or wrong save receipt %j cannot report enabled',async data=>{
  io.db.mockResolvedValue({data,error:null});
  await expect(enablePush()).rejects.toMatchObject({outcome:'partial'});
 });
 it.each(['false','throw'])('disable never deletes server registration after failed native unsubscribe %s',async mode=>{
  if(mode==='false')io.unsubscribe.mockResolvedValue(false);else io.unsubscribe.mockRejectedValue(new Error('PRIVATE_UNSUBSCRIBE'));
  await expect(disablePush()).rejects.toBeInstanceOf(FinancialWorkflowError);
  expect(io.db).not.toHaveBeenCalled();
 });
 it('native unsubscribe confirmed but delete failure remains partial with original cause',async()=>{
  const failure={code:'42501',message:'PRIVATE_DELETE_ERROR'};io.db.mockResolvedValue({data:null,error:failure});
  await expect(disablePush()).rejects.toMatchObject({outcome:'partial',cause:failure});
  expect(current).toBeNull();
 });
 it.each<[unknown]>([[null],[[]],[[{id:'wrong',user_id:'actor-a',endpoint:'wrong'}]]])('unconfirmed delete receipt %j does not report completed',async data=>{
  io.db.mockResolvedValue({data,error:null});
  await expect(disablePush()).rejects.toMatchObject({outcome:'partial'});
 });
 it('known positive disable receipt completes and no subscription is a neutral no-op',async()=>{
  await expect(disablePush()).resolves.toBe('disabled');
  expect(current).toBeNull();io.db.mockClear();
  await expect(disablePush()).resolves.toBe('already-disabled');expect(io.db).not.toHaveBeenCalled();
 });
 it('enabled state requires a matching active server row, not merely a browser subscription',async()=>{
  io.db.mockResolvedValue({data:null,error:null});
  await expect(isSubscribed()).rejects.toBeInstanceOf(FinancialWorkflowError);
 });
 it('enabled read preserves database permission failure',async()=>{
  const failure={code:'42501',message:'PRIVATE_SELECT_ERROR'};io.db.mockResolvedValue({data:null,error:failure});
  await expect(isSubscribed()).rejects.toBe(failure);
 });
 it('known native plus matching active server row is enabled',async()=>{
  await expect(isSubscribed()).resolves.toBe(true);expect(io.db).toHaveBeenCalled();
 });
 it('read-only recheck does not clear pending cleanup while server registration remains',async()=>{
  const failure={code:'42501',message:'PRIVATE_DELETE_ERROR'};io.db.mockResolvedValue({data:null,error:failure});
  let pending:unknown;try{await disablePush();}catch(error){pending=error;}
  io.db.mockResolvedValue({data:stored(),error:null});
  await expect(isSubscribed(pending)).rejects.toMatchObject({outcome:'partial'});
  io.db.mockResolvedValue({data:null,error:null});
  await expect(isSubscribed(pending)).resolves.toBe(false);
 });
 it.each([null,{}, {sent:0,total:0,failed:0,pruned:0}])('malformed test-push result %j never becomes zero-device success',async data=>{
  io.invoke.mockResolvedValue({data,error:null});
  await expect(sendTestPush()).rejects.toBeTruthy();
 });
 it('Edge failure keeps the original error without replacing it with provider response body',async()=>{
  const failure={code:'EDGE_HTTP',context:{json:vi.fn().mockResolvedValue({error:'PRIVATE_PROVIDER_BODY'})}};
  io.invoke.mockResolvedValue({data:null,error:failure});
  await expect(sendTestPush()).rejects.toBe(failure);
 });
});
