import assert from 'node:assert/strict';
import {createHandler} from './index.ts';
import {JsonObject,sha256} from './http.ts';

const token='ab'.repeat(32);
const id='c'.repeat(64);
const deviceId='30000000-0000-4000-8000-000000000001';
const settings={version:1,enabled:true,applies:true,intervalMin:30,toleranceMin:10,windows:[['08:00','11:30']],skipSunday:true,offDates:[],tz:'Asia/Ho_Chi_Minh',serverNow:'2026-01-05T01:30:09.000Z'};
const device={batteryPct:64,charging:false,idle:false,powerSave:false,appVersion:'1.0.0',sdkInt:34,locationPermission:'always',batteryOptimizationIgnored:true};
const fresh={status:'fresh',lat:10,lng:106,accuracyM:12,provider:'fused',ageMs:800,mock:false};
const ping=(overrides:JsonObject={}):JsonObject=>({schemaVersion:1,event:'location.ping',id,deviceId,recordedAt:'2026-01-05T01:30:07Z',slotAt:'2026-01-05T01:30:00Z',settingsVersion:1,fix:fresh,reason:null,device,...overrides});
const pair=(overrides:JsonObject={}):JsonObject=>({schemaVersion:1,event:'device.pair',id,deviceId,recordedAt:'2026-01-05T01:00:00Z',pairCode:'ABCDEFGH23',device:{model:'Thu',sdkInt:34,appVersion:'1.0.0'},...overrides});
const state=(overrides:JsonObject={}):JsonObject=>({schemaVersion:1,event:'device.state',id,deviceId,recordedAt:'2026-01-05T01:00:00Z',device,...overrides});
const request=(payload:unknown,authorization=`Bearer ${token}`,key=id)=>new Request('https://example.test/ingest',{method:'POST',headers:{authorization,'content-type':'application/json','x-idempotency-key':key},body:JSON.stringify(payload)});
const receipt=(status='accepted')=>({status,externalId:id,acceptedAt:'2026-01-05T01:30:09.000+00:00',settings});

Deno.test('dấu vị trí: chỉ gửi SHA-256 của bearer xuống SQL, trả biên nhận giờ Z',async()=>{
  let name='';let saved:JsonObject={};
  const handler=createHandler({rpc:async(n,args)=>{name=n;saved=args;return {data:receipt(),error:null};}});
  const response=await handler(request(ping()));
  assert.equal(response.status,201);
  assert.equal(name,'gps_checkin_ingest_v1');
  assert.equal(saved.p_digest,await sha256(token));
  assert.equal(JSON.stringify(saved).includes(token),false);
  assert.equal(saved.p_payload_hash,await sha256(JSON.stringify(ping())));
  const body=await response.json();
  assert.equal(body.ok,true);
  assert.equal(body.data.acceptedAt,'2026-01-05T01:30:09.000Z');
});

Deno.test('ghép nối: mã chỉ đi xuống SQL dưới dạng băm, không nằm trong sự kiện',async()=>{
  let name='';let saved:JsonObject={};
  const handler=createHandler({rpc:async(n,args)=>{name=n;saved=args;return {data:receipt('paired'),error:null};}});
  const response=await handler(request(pair()));
  assert.equal(response.status,201);
  assert.equal(name,'gps_checkin_pair_v1');
  assert.equal(saved.p_code_digest,await sha256('ABCDEFGH23'));
  assert.equal(saved.p_credential_digest,await sha256(token));
  assert.equal(JSON.stringify(saved).includes('ABCDEFGH23'),false);
});

Deno.test('mốc không có vị trí phải kèm lý do; có vị trí thì không được kèm lý do',async()=>{
  let calls=0;
  const handler=createHandler({rpc:async()=>{calls++;return {data:receipt('accepted'),error:null};}});
  assert.equal((await handler(request(ping({fix:{status:'none'},reason:'location_off'})))).status,201);
  assert.equal(calls,1);
  assert.equal((await handler(request(ping({fix:{status:'none'},reason:null})))).status,400);
  assert.equal((await handler(request(ping({reason:'timeout'})))).status,400);
  assert.equal(calls,1);
});

Deno.test('từ chối sai xác thực, sai hợp đồng trước khi chạm DB',async()=>{
  let calls=0;
  const handler=createHandler({rpc:async()=>{calls++;return {data:receipt(),error:null};}});
  for(const [payload,auth,key,status] of [
    [ping(),'',id,401],
    [ping(),'Bearer short',id,401],
    [ping(),`Bearer ${'A'.repeat(64)}`,id,401],
    [ping(),`Bearer ${token}`,'d'.repeat(64),400],
    [ping(),`Bearer ${token}`,'bad',400],
    [ping({organizationId:'forged'}),`Bearer ${token}`,id,400],
    [ping({recordedAt:'2026-02-30T01:02:03Z'}),`Bearer ${token}`,id,400],
    [ping({fix:{...fresh,lat:91}}),`Bearer ${token}`,id,400],
    [ping({fix:{...fresh,lng:'106'}}),`Bearer ${token}`,id,400],
    [ping({fix:{status:'lost'}}),`Bearer ${token}`,id,400],
    [ping({device:{...device,secret:'x'}}),`Bearer ${token}`,id,400],
    [ping({device:{...device,batteryPct:101}}),`Bearer ${token}`,id,400],
    [ping({device:{...device,constructor:'x'}}),`Bearer ${token}`,id,400],
    [ping({device:{...device,toString:'x'}}),`Bearer ${token}`,id,400],
    [ping({device:JSON.parse('{"__proto__":"x"}')}),`Bearer ${token}`,id,400],
    [ping({reason:'because'}),`Bearer ${token}`,id,400],
    [pair({pairCode:'abc'}),`Bearer ${token}`,id,400],
    [pair({pairCode:'IOIOIOIOIO'}),`Bearer ${token}`,id,400],
    [state({event:'device.unknown'}),`Bearer ${token}`,id,400],
  ] as const)assert.equal((await handler(request(payload,auth,key))).status,status,JSON.stringify(payload).slice(0,80));
  assert.equal(calls,0);
});

Deno.test('ánh xạ lỗi SQL sang mã HTTP',async()=>{
  for(const [code,status] of [['28000',401],['42501',403],['PT409',409],['PT429',429],['22023',400],['XX000',503]] as const){
    const handler=createHandler({rpc:async()=>({data:null,error:{code}})});
    assert.equal((await handler(request(ping()))).status,status);
  }
});

Deno.test('biên nhận DB sai dạng trả 502, không báo thành công giả',async()=>{
  for(const data of [null,{status:'accepted'},{...receipt(),externalId:'x'},{...receipt(),status:'weird'},{...receipt(),settings:null}]){
    const handler=createHandler({rpc:async()=>({data,error:null})});
    assert.equal((await handler(request(ping()))).status,502);
  }
});

Deno.test('chỉ nhận POST',async()=>{
  const handler=createHandler({rpc:async()=>({data:receipt(),error:null})});
  assert.equal((await handler(new Request('https://example.test/ingest',{method:'GET'}))).status,405);
  assert.equal((await handler(new Request('https://example.test/ingest',{method:'OPTIONS'}))).status,200);
});
