// Cổng nhận dữ liệu của app «iHome Điểm danh» trên máy quản lý.
// Máy xác thực bằng bearer do chính app sinh; máy chủ chỉ nhận SHA-256 của nó (kiểm trong DB),
// nên `verify_jwt = false`. Hợp đồng dữ liệu: plan 2026-11-09, Phụ lục A.
import {bearer,boundedText,Dependencies,failed,HASH,JsonObject,object,readJson,reply,RequestError,rpcError,runtimeRpc,sha256,UUID,validTimestamp} from './http.ts';

const TOKEN=/^[a-f0-9]{64}$/;
const PAIR_CODE=/^[A-HJ-NP-Z2-9]{10}$/;
const COMMON=['schemaVersion','event','id','deviceId','recordedAt'];
const REASONS=['permission_denied','location_off','timeout','paused'];
const STATUSES=['paired','accepted','duplicate','state','ignored_out_of_window','ignored_off_day'];
const LOCATION_PERMISSIONS=['always','while_in_use','denied'];

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const intBetween=(value:unknown,min:number,max:number)=>Number.isSafeInteger(value)&&(value as number)>=min&&(value as number)<=max;
const invalid=():never=>{throw new RequestError(400,'invalid_payload');};

/** Tình trạng máy: chỉ nhận đúng các khoá đã khai, đúng kiểu; không khoá nào bắt buộc. */
function device(value:unknown):JsonObject{
  if(!object(value))invalid();
  const rules:Record<string,(v:unknown)=>boolean>={
    manufacturer:v=>boundedText(v,64),
    model:v=>boundedText(v,120),
    sdkInt:v=>intBetween(v,1,100),
    appVersion:v=>boundedText(v,64),
    batteryPct:v=>v===null||intBetween(v,0,100),
    charging:v=>typeof v==='boolean',
    idle:v=>typeof v==='boolean',
    powerSave:v=>typeof v==='boolean',
    locationEnabled:v=>typeof v==='boolean',
    locationPermission:v=>LOCATION_PERMISSIONS.includes(v as string),
    batteryOptimizationIgnored:v=>typeof v==='boolean',
    exactAlarmAllowed:v=>typeof v==='boolean',
    paused:v=>typeof v==='boolean',
  };
  const input=value as JsonObject;
  for(const [key,item] of Object.entries(input))if(!Object.hasOwn(rules,key)||!rules[key](item))invalid();
  return input;
}

function fix(value:unknown):JsonObject{
  if(!object(value))invalid();
  const input=value as JsonObject;
  if(input.status==='none'){
    if(Object.keys(input).length!==1)invalid();
    return {status:'none'};
  }
  if(input.status!=='fresh'&&input.status!=='stale')invalid();
  const keys=['status','lat','lng','accuracyM','provider','ageMs','mock'];
  if(Object.keys(input).some(k=>!keys.includes(k))||!keys.every(k=>Object.hasOwn(input,k)))invalid();
  if(!finite(input.lat)||input.lat<-90||input.lat>90
    ||!finite(input.lng)||input.lng<-180||input.lng>180
    ||!(input.accuracyM===null||(finite(input.accuracyM)&&input.accuracyM>=0))
    ||!(input.provider===null||boundedText(input.provider,32))
    ||!Number.isSafeInteger(input.ageMs)||(input.ageMs as number)<0
    ||typeof input.mock!=='boolean')invalid();
  return input;
}

export function validateEvent(value:unknown,key:string):JsonObject{
  if(!object(value))invalid();
  const input=value as JsonObject;
  let keys:string[];
  if(input.event==='device.pair')keys=[...COMMON,'pairCode','device'];
  else if(input.event==='location.ping')keys=[...COMMON,'slotAt','settingsVersion','fix','reason','device'];
  else if(input.event==='device.state')keys=[...COMMON,'device'];
  else throw new RequestError(400,'invalid_event_type');
  if(Object.keys(input).length!==keys.length||!keys.every(k=>Object.hasOwn(input,k))
    ||input.schemaVersion!==1||typeof input.id!=='string'||!HASH.test(input.id)||input.id!==key
    ||typeof input.deviceId!=='string'||!UUID.test(input.deviceId)||!validTimestamp(input.recordedAt))invalid();
  const out:JsonObject={...input,deviceId:(input.deviceId as string).toLowerCase(),device:device(input.device)};
  if(input.event==='device.pair'){
    if(typeof input.pairCode!=='string'||!PAIR_CODE.test(input.pairCode))invalid();
  }
  if(input.event==='location.ping'){
    if(!validTimestamp(input.slotAt)||!intBetween(input.settingsVersion,0,1_000_000))invalid();
    out.fix=fix(input.fix);
    if(!(input.reason===null||REASONS.includes(input.reason as string)))invalid();
    const none=(out.fix as JsonObject).status==='none';
    if(none&&input.reason===null)invalid();
    if(!none&&input.reason!==null)invalid();
  }
  return Object.fromEntries(keys.map(k=>[k,out[k]]));
}

export function createHandler(deps:Dependencies={}){
  const rpc=runtimeRpc(deps);
  return async(request:Request):Promise<Response>=>{
    if(request.method==='OPTIONS')return reply(200,{ok:true});
    try{
      if(request.method!=='POST')throw new RequestError(405,'method_not_allowed');
      const token=bearer(request).slice(7);
      if(!TOKEN.test(token))throw new RequestError(401,'unauthorized');
      const key=request.headers.get('x-idempotency-key');
      if(!key||!HASH.test(key))throw new RequestError(400,'invalid_idempotency_key');
      const event=validateEvent(await readJson(request),key);
      const digest=await sha256(token);
      const result=event.event==='device.pair'
        ?await rpc('gps_checkin_pair_v1',{
          p_code_digest:await sha256(event.pairCode as string),
          p_credential_digest:digest,
          p_fingerprint:`sha256:${digest.slice(0,12)}`,
          p_event:Object.fromEntries(Object.entries(event).filter(([k])=>k!=='pairCode')),
        })
        :await rpc('gps_checkin_ingest_v1',{p_digest:digest,p_event:event,p_payload_hash:await sha256(JSON.stringify(event))});
      if(result.error)throw rpcError(result.error.code);
      const receipt=result.data;
      if(!object(receipt)||!STATUSES.includes(String(receipt.status))||receipt.externalId!==event.id
        ||!validTimestamp(receipt.acceptedAt)||!object(receipt.settings))throw new RequestError(502,'invalid_storage_receipt');
      const created=receipt.status==='accepted'||receipt.status==='paired';
      return reply(created?201:200,{schemaVersion:1,ok:true,data:{...receipt,acceptedAt:new Date(String(receipt.acceptedAt)).toISOString()}});
    }catch(error){return failed(error);}
  };
}
if(import.meta.main)Deno.serve(createHandler());
