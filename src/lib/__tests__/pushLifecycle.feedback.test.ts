// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io=vi.hoisted(()=>({db:vi.fn(),session:vi.fn(),getReg:vi.fn(),register:vi.fn(),getSub:vi.fn(),subscribe:vi.fn(),unsubscribe:vi.fn(),permission:vi.fn(),invoke:vi.fn()}));
vi.mock('@/lib/authSession',()=>({getSessionUserId:io.session}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{
 let mode='read';let input:Record<string,unknown>={};const filters:Record<string,unknown>={};
 const execute=()=>io.db({mode,input,filters});
 const q={upsert:(value:Record<string,unknown>)=>{mode='upsert';input=value;return q;},update:(value:Record<string,unknown>)=>{mode='update';input=value;return q;},delete:()=>{mode='delete';return q;},eq:(key:string,value:unknown)=>{filters[key]=value;return q;},select:()=>q,
 single:()=>execute(),maybeSingle:()=>execute(),then:(resolve:(value:unknown)=>unknown,reject:(error:unknown)=>unknown)=>Promise.resolve(execute()).then(resolve,reject)};
 return q;
},functions:{invoke:io.invoke}}}));
import { enablePush,disablePush,registerServiceWorker,getExistingSubscription,isSubscribed,sendTestPush,VAPID_PUBLIC_KEY,ensurePushSubscription,disablePushForLogout,recoverPushAfterBrowserChange } from '../push';
import {FinancialWorkflowError} from '../financialWorkflowError';
let current:PushSubscription|null;
let registration:ServiceWorkerRegistration;
function keyBytes(){const raw=atob(VAPID_PUBLIC_KEY.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer;}
function subscription(key=keyBytes()):PushSubscription{
 return {endpoint:'https://private-push.example/SECRET_ENDPOINT',options:{applicationServerKey:key},unsubscribe:io.unsubscribe,getKey:()=>new Uint8Array([1,2]).buffer} as unknown as PushSubscription;
}
function stored(){return {id:'device-a',user_id:'actor-a',endpoint:'https://private-push.example/SECRET_ENDPOINT',p256dh:'AQI',auth:'AQI',is_active:true,revoked_at:null as string|null};}
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
  await expect(enablePush('org-a')).rejects.toBe(failure);
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
  const assertion=expect(enablePush('org-a')).rejects.toBeInstanceOf(Error);
  await vi.advanceTimersByTimeAsync(10000);await assertion;
  expect(io.subscribe).not.toHaveBeenCalled();expect(io.db).not.toHaveBeenCalled();
 });
 it.each(['false','throw'])('rotation stops on unconfirmed old-key unsubscribe %s',async mode=>{
  current=subscription(new Uint8Array([9]).buffer);
  const failure=new Error('PRIVATE_UNSUBSCRIBE');
  if(mode==='throw')io.unsubscribe.mockRejectedValue(failure);else io.unsubscribe.mockResolvedValue(false);
  await expect(enablePush('org-a')).rejects.toBeInstanceOf(FinancialWorkflowError);
  expect(io.subscribe).not.toHaveBeenCalled();expect(io.db).not.toHaveBeenCalled();
 });
 it('does not save a replacement subscription that still has the wrong key',async()=>{
  current=null;io.subscribe.mockResolvedValue(subscription(new Uint8Array([9]).buffer));
  await expect(enablePush('org-a')).rejects.toBeInstanceOf(FinancialWorkflowError);
  expect(io.db).not.toHaveBeenCalled();
 });
 it('known rotation uses the unchanged configured key and only then persists the matching subscription',async()=>{
  current=subscription(new Uint8Array([9]).buffer);
  await expect(enablePush('org-a')).resolves.toBe('granted');
  expect(io.unsubscribe).toHaveBeenCalledOnce();expect(io.subscribe).toHaveBeenCalledOnce();
  expect(new Uint8Array(io.subscribe.mock.calls[0][0].applicationServerKey)).toEqual(new Uint8Array(keyBytes()));
  expect(io.db).toHaveBeenCalledWith(expect.objectContaining({mode:'upsert',input:expect.objectContaining({organization_id:'org-a'})}));
 });
 it('browser subscribed but database save fails is partial with original cause',async()=>{
  current=null;const failure={code:'42501',message:'PRIVATE_DB_ERROR'};io.db.mockResolvedValue({data:null,error:failure});
  await expect(enablePush('org-a')).rejects.toMatchObject({outcome:'partial',cause:failure});
  expect(io.subscribe).toHaveBeenCalledOnce();
 });
 it.each([null,{id:'device-a',user_id:'wrong'},{id:'device-a',is_active:false}])('missing or wrong save receipt %j cannot report enabled',async data=>{
  io.db.mockResolvedValue({data,error:null});
  await expect(enablePush('org-a')).rejects.toMatchObject({outcome:'partial'});
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

// ---- 21/10/2026: đối chiếu lúc khởi động (C7), dọn khi đăng xuất (C7), gửi thử đọc outcome (C8) ----
describe('ensurePushSubscription — đối chiếu đăng ký máy này với máy chủ',()=>{
 it('chưa cấp quyền hoặc không có subscription: không đọc/ghi máy chủ, không xin quyền',async()=>{
  vi.stubGlobal('Notification',{permission:'default',requestPermission:io.permission});
  await expect(ensurePushSubscription('org-a')).resolves.toBe('no-permission');
  vi.stubGlobal('Notification',{permission:'granted',requestPermission:io.permission});
  current=null;
  await expect(ensurePushSubscription('org-a')).resolves.toBe('no-subscription');
  expect(io.db).not.toHaveBeenCalled();expect(io.permission).not.toHaveBeenCalled();expect(io.subscribe).not.toHaveBeenCalled();
 });
 it('subscription theo khoá VAPID khác: để nút bật/tắt tự xoay khoá, không đụng gì',async()=>{
  current=subscription(new Uint8Array([9]).buffer);
  await expect(ensurePushSubscription('org-a')).resolves.toBe('other-key');
  expect(io.db).not.toHaveBeenCalled();expect(io.unsubscribe).not.toHaveBeenCalled();
 });
 it('đã khớp dòng active: không ghi gì',async()=>{
  await expect(ensurePushSubscription('org-a')).resolves.toBe('in-sync');
  expect(io.db).toHaveBeenCalledTimes(1);expect(io.db.mock.calls[0][0]).toMatchObject({mode:'read'});
 });
 it('máy chủ thiếu dòng (đăng ký mới do trình duyệt xoay): lưu với công ty đang chọn',async()=>{
  io.db.mockImplementation(async({mode,input}:{mode:string;input:Record<string,unknown>})=>({data:mode==='upsert'?{id:'device-a',...input}:null,error:null}));
  await expect(ensurePushSubscription('org-a')).resolves.toBe('saved');
  expect(io.db).toHaveBeenCalledWith(expect.objectContaining({mode:'upsert',input:expect.objectContaining({organization_id:'org-a',is_active:true})}));
  expect(io.unsubscribe).not.toHaveBeenCalled();
 });
 it('dòng bị prune (is_active=false): KHÔNG upsert lại endpoint chết — hủy, đăng ký mới, lưu, dọn dòng cũ',async()=>{
  const fresh={...subscription(),endpoint:'https://private-push.example/FRESH_ENDPOINT'} as PushSubscription;
  io.subscribe.mockImplementation(async()=>{current=fresh;return fresh;});
  io.db.mockImplementation(async({mode,input}:{mode:string;input:Record<string,unknown>})=>({data:mode==='upsert'?{id:'device-b',...input}:mode==='delete'?[]:{...stored(),is_active:false},error:null}));
  await expect(ensurePushSubscription('org-a')).resolves.toBe('resubscribed');
  expect(io.unsubscribe).toHaveBeenCalledOnce();expect(io.subscribe).toHaveBeenCalledOnce();
  const modes=io.db.mock.calls.map(([call])=>call.mode);
  expect(modes).toEqual(['read','upsert','delete']);
  expect(io.db.mock.calls[1][0].input).toMatchObject({endpoint:'https://private-push.example/FRESH_ENDPOINT'});
  expect(io.db.mock.calls[2][0].filters).toMatchObject({endpoint:'https://private-push.example/SECRET_ENDPOINT',user_id:'actor-a'});
 });
 it('lưu hỏng: ném PushOperationError mang lỗi gốc (bên gọi ghi log), không nuốt',async()=>{
  const failure={code:'42501',message:'PRIVATE_RLS'};
  io.db.mockImplementation(async({mode}:{mode:string})=>mode==='upsert'?{data:null,error:failure}:{data:null,error:null});
  await expect(ensurePushSubscription('org-a')).rejects.toMatchObject({cause:failure});
 });
 it.each([true,false])('dòng đã bị GỠ (revoked_at, is_active=%s): trả revoked — không lưu, không hủy, không subscribe lại',async active=>{
  io.db.mockImplementation(async()=>({data:{...stored(),is_active:active,revoked_at:'2026-10-22T01:00:00+00:00'},error:null}));
  await expect(ensurePushSubscription('org-a')).resolves.toBe('revoked');
  expect(io.db).toHaveBeenCalledTimes(1);expect(io.db.mock.calls[0][0]).toMatchObject({mode:'read'});
  expect(io.unsubscribe).not.toHaveBeenCalled();expect(io.subscribe).not.toHaveBeenCalled();
 });
 it('đối chiếu (lưu dòng thiếu) KHÔNG đụng revoked_at — chỉ công tắc bật mới xoá dấu thu hồi',async()=>{
  io.db.mockImplementation(async({mode,input}:{mode:string;input:Record<string,unknown>})=>({data:mode==='upsert'?{id:'device-a',revoked_at:null,...input}:null,error:null}));
  await ensurePushSubscription('org-a');
  const upsert=io.db.mock.calls.find(([c])=>c.mode==='upsert')![0];
  expect(upsert.input).not.toHaveProperty('revoked_at');
 });
 it('phong bì máy chủ méo (revoked_at sai kiểu) không bị coi là chưa gỡ',async()=>{
  io.db.mockImplementation(async()=>({data:{...stored(),revoked_at:42},error:null}));
  await expect(ensurePushSubscription('org-a')).rejects.toBeInstanceOf(TypeError);
  expect(io.subscribe).not.toHaveBeenCalled();
 });
});
describe('dấu thu hồi — isSubscribed / enablePush (SETTINGS-1)',()=>{
 it('máy này bị gỡ từ máy khác ⇒ công tắc TẮT (kể cả dòng lỡ is_active=true)',async()=>{
  io.db.mockResolvedValue({data:{...stored(),is_active:false,revoked_at:'2026-10-22T01:00:00Z'},error:null});
  await expect(isSubscribed()).resolves.toBe(false);
  io.db.mockResolvedValue({data:{...stored(),is_active:true,revoked_at:'2026-10-22T01:00:00Z'},error:null});
  await expect(isSubscribed()).resolves.toBe(false);
 });
 it('bật bằng công tắc ghi revoked_at=NULL và đòi biên nhận revoked_at=NULL',async()=>{
  await expect(enablePush('org-a')).resolves.toBe('granted');
  expect(io.db).toHaveBeenCalledWith(expect.objectContaining({mode:'upsert',input:expect.objectContaining({revoked_at:null,is_active:true})}));
  io.db.mockImplementation(async({mode,input}:{mode:string;input:Record<string,unknown>})=>({data:mode==='upsert'?{id:'device-a',...input,revoked_at:'2026-10-22T01:00:00Z'}:stored(),error:null}));
  await expect(enablePush('org-a')).rejects.toMatchObject({outcome:'partial'});
 });
});
describe('recoverPushAfterBrowserChange — SW không tự đăng ký lại được (NOTIF-CLIENT-7)',()=>{
 const OLD='https://private-push.example/SECRET_ENDPOINT';
 it('trình duyệt mất đăng ký + máy từng có dòng của tôi ⇒ đăng ký lại bằng khoá của app (không xin quyền), lưu, dọn dòng cũ',async()=>{
  current=null;
  const fresh={...subscription(),endpoint:'https://private-push.example/FRESH_ENDPOINT'} as PushSubscription;
  io.subscribe.mockImplementation(async()=>{current=fresh;return fresh;});
  io.db.mockImplementation(async({mode,input}:{mode:string;input:Record<string,unknown>})=>({data:mode==='upsert'?{id:'device-b',...input}:mode==='delete'?[]:{...stored(),is_active:false},error:null}));
  await expect(recoverPushAfterBrowserChange(OLD,'org-a')).resolves.toBe('resubscribed');
  expect(io.permission).not.toHaveBeenCalled();
  expect(new Uint8Array(io.subscribe.mock.calls[0][0].applicationServerKey)).toEqual(new Uint8Array(keyBytes()));
  expect(io.db.mock.calls.map(([c])=>c.mode)).toEqual(['read','upsert','delete']);
  expect(io.db.mock.calls[0][0].filters).toMatchObject({endpoint:OLD,user_id:'actor-a'});
  expect(io.db.mock.calls[2][0].filters).toMatchObject({endpoint:OLD,user_id:'actor-a'});
 });
 it('máy chưa từng có dòng của tôi / dòng đã gỡ / không biết endpoint cũ ⇒ không tự đăng ký',async()=>{
  current=null;
  io.db.mockResolvedValue({data:null,error:null});
  await expect(recoverPushAfterBrowserChange(OLD,'org-a')).resolves.toBe('no-prior-row');
  io.db.mockResolvedValue({data:{...stored(),is_active:false,revoked_at:'2026-10-22T01:00:00Z'},error:null});
  await expect(recoverPushAfterBrowserChange(OLD,'org-a')).resolves.toBe('revoked');
  await expect(recoverPushAfterBrowserChange(null,'org-a')).resolves.toBe('no-subscription');
  vi.stubGlobal('Notification',{permission:'default',requestPermission:io.permission});
  await expect(recoverPushAfterBrowserChange(OLD,'org-a')).resolves.toBe('no-permission');
  expect(io.subscribe).not.toHaveBeenCalled();expect(io.permission).not.toHaveBeenCalled();
 });
 it('trình duyệt vẫn có đăng ký ⇒ đối chiếu như thường',async()=>{
  await expect(recoverPushAfterBrowserChange(OLD,'org-a')).resolves.toBe('in-sync');
  expect(io.subscribe).not.toHaveBeenCalled();
 });
});
describe('disablePushForLogout — best-effort, không bao giờ chặn đăng xuất',()=>{
 it('gỡ được: hủy trình duyệt trước rồi xoá dòng của chính mình',async()=>{
  await expect(disablePushForLogout()).resolves.toBe('removed');
  expect(io.unsubscribe).toHaveBeenCalledOnce();
  expect(io.db).toHaveBeenCalledWith(expect.objectContaining({mode:'delete',filters:expect.objectContaining({user_id:'actor-a'})}));
 });
 it('lỗi giữa chừng: trả failed, không ném',async()=>{
  io.unsubscribe.mockRejectedValue(new Error('PRIVATE_UNSUBSCRIBE'));
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
  await expect(disablePushForLogout()).resolves.toBe('failed');
  warn.mockRestore();
 });
 it('treo (service worker không kích hoạt): hết 3 giây thì trả timeout',async()=>{
  vi.useFakeTimers();io.getReg.mockImplementation(()=>new Promise(()=>{}));
  const result=disablePushForLogout(3000);
  await vi.advanceTimersByTimeAsync(3000);
  await expect(result).resolves.toBe('timeout');
 });
});
describe('sendTestPush — kết quả gửi đọc từ outcome, kể cả khi HTTP không 2xx',()=>{
 const body=(over:Record<string,unknown>)=>({outcome:'SENT',total:1,sent:1,failed:0,pruned:0,errors:[],...over});
 const httpError=(status:number,json:unknown)=>({name:'FunctionsHttpError',context:{status,json:vi.fn().mockResolvedValue(json)}});
 it('SENT (200) trả outcome',async()=>{
  io.invoke.mockResolvedValue({data:body({}),error:null});
  await expect(sendTestPush()).resolves.toMatchObject({outcome:'SENT',sent:1});
 });
 it('PARTIAL (207 là 2xx) trả qua data',async()=>{
  io.invoke.mockResolvedValue({data:body({outcome:'PARTIAL',total:2,sent:1,failed:1,errors:[{host:'fcm',body:''}]}),error:null});
  await expect(sendTestPush()).resolves.toMatchObject({outcome:'PARTIAL',failed:1});
 });
 it.each([
  [422,{outcome:'NO_DEVICE',total:0,sent:0,failed:0,pruned:0,errors:[]}],
  [502,{outcome:'ALL_FAILED',total:2,sent:0,failed:2,pruned:1,errors:[{host:'fcm',body:'gone'},{host:'apple',body:''}]}],
  [502,{outcome:'PROVIDER_ERROR',total:0,sent:0,failed:0,pruned:0,errors:[]}],
 ])('HTTP %i là KẾT QUẢ gửi, không ném',async(status,json)=>{
  io.invoke.mockResolvedValue({data:null,error:httpError(status,json)});
  await expect(sendTestPush()).resolves.toMatchObject({outcome:(json as {outcome:string}).outcome});
 });
 it.each([
  [401,{outcome:'UNAUTHORIZED',total:0,sent:0,failed:0,pruned:0,errors:[]}],
  [502,{outcome:'SENT',total:0,sent:0,failed:0,pruned:0,errors:[]}],
  [422,{outcome:'NO_DEVICE'}],
 ])('HTTP %i với body %j: giữ nguyên lỗi gốc',async(status,json)=>{
  const failure=httpError(status,json);
  io.invoke.mockResolvedValue({data:null,error:failure});
  await expect(sendTestPush()).rejects.toBe(failure);
 });
 it('body không đọc được: giữ nguyên lỗi gốc',async()=>{
  const failure={context:{status:422,json:vi.fn().mockRejectedValue(new SyntaxError('PRIVATE'))}};
  io.invoke.mockResolvedValue({data:null,error:failure});
  await expect(sendTestPush()).rejects.toBe(failure);
 });
 it('200 thiếu outcome là kết quả méo',async()=>{
  io.invoke.mockResolvedValue({data:{total:1,sent:1,failed:0,pruned:0,errors:[]},error:null});
  await expect(sendTestPush()).rejects.toBeInstanceOf(FinancialWorkflowError);
 });
});
