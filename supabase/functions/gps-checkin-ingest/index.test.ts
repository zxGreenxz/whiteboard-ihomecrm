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
// Vector chung với test của app Android: một khối `diag` hợp lệ, JSON một dòng, đúng thứ tự khoá app ghi.
const DIAG_SAMPLE='{"v":1,"path":"service","end":"settled","alarmLateMs":1250,"startMs":310,"captureMs":8420,"awakeMs":9100,"procAgeMs":5400000,"screenOn":false,"bucket":10,"foreground":true,"lastKnownAgeMs":282000,"sources":{"fused":{"on":true,"n":3,"firstMs":2100,"bestM":18.5},"gps":{"on":true,"n":0,"firstMs":null,"bestM":null},"network":{"on":false,"n":0,"firstMs":null,"bestM":null}}}';
const diag=(overrides:JsonObject={}):JsonObject=>({...JSON.parse(DIAG_SAMPLE),...overrides});
const source=(overrides:JsonObject={}):JsonObject=>({on:true,n:3,firstMs:2100,bestM:18.5,...overrides});
const without=(input:JsonObject,key:string):JsonObject=>Object.fromEntries(Object.entries(input).filter(([k])=>k!==key));

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

Deno.test('gọi RPC thật đúng schema public: PostgREST mặc định profile khác nên thiếu header là 503',async()=>{
  const realFetch=globalThis.fetch;
  let url='';let headers=new Headers();
  globalThis.fetch=(async(input:Request|URL|string,init?:RequestInit)=>{
    url=String(input);headers=new Headers(init?.headers);
    return new Response(JSON.stringify(receipt()),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  try{
    const env:Record<string,string>={SUPABASE_URL:'https://x.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'khoa-thu'};
    const response=await createHandler({env:(name)=>env[name]})(request(ping()));
    assert.equal(response.status,201);
    assert.equal(url,'https://x.supabase.test/rest/v1/rpc/gps_checkin_ingest_v1');
    assert.equal(headers.get('content-profile'),'public');
    assert.equal(headers.get('accept-profile'),'public');
    assert.equal(headers.get('authorization'),'Bearer khoa-thu');
  }finally{globalThis.fetch=realFetch;}
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

Deno.test('dấu kèm chẩn đoán: `diag` xuống SQL nguyên vẹn, đứng cuối sự kiện và nằm trong chuỗi băm',async()=>{
  let saved:JsonObject={};
  const handler=createHandler({rpc:async(_name,args)=>{saved=args;return {data:receipt(),error:null};}});
  assert.equal(JSON.stringify(JSON.parse(DIAG_SAMPLE)),DIAG_SAMPLE);
  const response=await handler(request(ping({diag:diag()})));
  assert.equal(response.status,201);
  const event=saved.p_event as JsonObject;
  assert.deepEqual(event.diag,JSON.parse(DIAG_SAMPLE));
  assert.deepEqual(Object.keys(event),[...Object.keys(ping()),'diag']);
  assert.equal(saved.p_payload_hash,await sha256(JSON.stringify(ping({diag:diag()}))));

  // Dấu của app 1.0.0: sự kiện xuống SQL không mọc thêm khoá `diag`, chuỗi băm vẫn là chuỗi cũ.
  assert.equal((await handler(request(ping()))).status,201);
  assert.equal(Object.hasOwn(saved.p_event as JsonObject,'diag'),false);
  assert.equal(JSON.stringify(saved.p_event),JSON.stringify(ping()));
  assert.equal(saved.p_payload_hash,await sha256(JSON.stringify(ping())));
});

Deno.test('chẩn đoán ở biên hợp lệ: trống được thì nhận null, nguồn nào không có thì khỏi gửi',async()=>{
  let calls=0;
  const handler=createHandler({rpc:async()=>{calls++;return {data:receipt(),error:null};}});
  const valid:JsonObject[]=[
    diag({procAgeMs:null,lastKnownAgeMs:null,bucket:null,sources:{}}),
    diag({path:'direct',alarmLateMs:-86_400_000,startMs:0,captureMs:86_400_000,awakeMs:86_400_000,bucket:0}),
    diag({alarmLateMs:86_400_000,bucket:100,procAgeMs:0,lastKnownAgeMs:Number.MAX_SAFE_INTEGER}),
    diag({sources:{fused:source(),gps:source({n:0,firstMs:null,bestM:null}),network:source({on:false,n:100_000,firstMs:86_400_000,bestM:10_000_000}),passive:source({firstMs:0,bestM:0})}}),
    ...['good','settled','best','last_known','none','pre'].map(end=>diag({end})),
  ];
  for(const item of valid)assert.equal((await handler(request(ping({diag:item})))).status,201,JSON.stringify(item));
  assert.equal(calls,valid.length);
});

Deno.test('chẩn đoán sai hợp đồng bị từ chối trước khi chạm DB',async()=>{
  let calls=0;
  const handler=createHandler({rpc:async()=>{calls++;return {data:receipt(),error:null};}});
  const sources=(fused:unknown)=>diag({sources:{fused}});
  const invalid:unknown[]=[
    null,[],'x',1,{},
    without(diag(),'awakeMs'),
    without(diag(),'sources'),
    diag({note:'x'}),
    // Đủ 13 khoá nhưng một khoá bị thay bằng toạ độ.
    {...without(diag(),'bucket'),lat:10},
    diag({v:2}),diag({v:'1'}),
    diag({path:'worker'}),diag({path:null}),
    diag({end:'timeout'}),diag({end:1}),
    diag({alarmLateMs:86_400_001}),diag({alarmLateMs:-86_400_001}),diag({alarmLateMs:null}),
    diag({startMs:310.5}),diag({startMs:'310'}),
    diag({captureMs:-1}),
    diag({awakeMs:86_400_001}),
    diag({procAgeMs:-1}),diag({procAgeMs:1.5}),
    diag({lastKnownAgeMs:'282000'}),diag({lastKnownAgeMs:-1}),
    diag({bucket:101}),diag({bucket:-1}),diag({bucket:'active'}),
    diag({screenOn:'false'}),diag({screenOn:null}),
    diag({foreground:0}),
    diag({sources:null}),diag({sources:[]}),diag({sources:'fused'}),
    diag({sources:{wifi:source()}}),
    diag({sources:JSON.parse('{"__proto__":{"on":true,"n":0,"firstMs":null,"bestM":null}}')}),
    sources(null),sources([true,3,2100,18.5]),
    sources(without(source(),'bestM')),
    sources(source({lat:10})),
    sources(source({on:'true'})),
    sources(source({n:-1})),sources(source({n:100_001})),sources(source({n:1.5})),sources(source({n:null})),
    sources(source({firstMs:-1})),sources(source({firstMs:86_400_001})),sources(source({firstMs:'2100'})),
    sources(source({bestM:-0.1})),sources(source({bestM:10_000_000.5})),sources(source({bestM:'18.5'})),
  ];
  for(const item of invalid){
    const response=await handler(request(ping({diag:item})));
    assert.equal(response.status,400,JSON.stringify(item));
    assert.deepEqual(await response.json(),{error:'invalid_payload'});
  }
  assert.equal(calls,0);
});

Deno.test('chẩn đoán chỉ đi kèm dấu vị trí: ở ghép nối và báo tình trạng nó là khoá lạ',async()=>{
  let calls=0;
  const handler=createHandler({rpc:async()=>{calls++;return {data:receipt('state'),error:null};}});
  for(const payload of [state({diag:diag()}),pair({diag:diag()})]){
    const response=await handler(request(payload));
    assert.equal(response.status,400);
    assert.deepEqual(await response.json(),{error:'invalid_payload'});
  }
  assert.equal(calls,0);
});
