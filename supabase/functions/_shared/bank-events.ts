export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HASH = /^[a-f0-9]{64}$/;
export const MAX_BYTES = 64 * 1024;
export type JsonObject = Record<string, unknown>;
export type Environment = (name: string) => string | undefined;
export interface RpcResult { data: unknown; error: { code: string } | null }
export interface Dependencies {
  env?: Environment;
  rpc?: (name: string, args: JsonObject, authorization?: string) => Promise<RpcResult>;
  authorizeAdmin?: (authorization: string) => Promise<boolean>;
}
export class RequestError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function boundedText(value: unknown, bytes: number, nonempty = false): value is string {
  return typeof value === 'string' && value.isWellFormed()
    && (!nonempty || value.length > 0) && new TextEncoder().encode(value).length <= bytes;
}
export function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, offset] = m;
  const y = Number(year), mo = Number(month), d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31,30,31,30,31,31,30,31,30,31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1] && Number(hour) < 24
    && Number(minute) < 60 && Number(second) < 60
    && (offset === 'Z' || (Number(offset.slice(1,3)) < 24 && Number(offset.slice(4)) < 60));
}
const commonKeys = ['schemaVersion','event','id','deviceId','receivedAt'];
export function validateEvent(value: unknown, key: string | null): JsonObject {
  if (!object(value)) throw new RequestError(400,'invalid_payload');
  let keys: string[];
  if (value.event === 'sms.received' || value.event === 'gateway.test') {
    keys = [...commonKeys,'sender','body','subscriptionId'];
    if (!boundedText(value.sender,256) || !boundedText(value.body,8192)
      || !(value.subscriptionId === null || Number.isSafeInteger(value.subscriptionId))) throw new RequestError(400,'invalid_payload');
  } else if (value.event === 'notification.received') {
    keys = [...commonKeys,'packageName','appName','title','body'];
    if (!boundedText(value.packageName,255,true) || !boundedText(value.appName,512)
      || !boundedText(value.title,512) || !boundedText(value.body,8192)) throw new RequestError(400,'invalid_payload');
  } else if (value.event === 'gateway.heartbeat') {
    keys = [...commonKeys,'smsEnabled','notificationsEnabled','notificationAccess','smsPermission','appVersion'];
    if (!['smsEnabled','notificationsEnabled','notificationAccess','smsPermission'].every(k=>typeof value[k]==='boolean')
      || !boundedText(value.appVersion,64,true)) throw new RequestError(400,'invalid_payload');
  } else throw new RequestError(400,'invalid_event_type');
  if (Object.keys(value).length !== keys.length || !keys.every(k=>Object.hasOwn(value,k))
    || value.schemaVersion !== 1 || typeof value.id !== 'string' || !HASH.test(value.id) || value.id !== key
    || typeof value.deviceId !== 'string' || !UUID.test(value.deviceId) || !validTimestamp(value.receivedAt)) throw new RequestError(400,'invalid_payload');
  // PostgreSQL stores UUIDs in lower case; use the same representation in encryption AAD.
  const deviceId=value.deviceId.toLowerCase();
  return Object.fromEntries(keys.map(k=>[k,k==='deviceId'?deviceId:value[k]]));
}
export const cors = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info, x-idempotency-key',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
};
export function reply(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data),{status,headers:{...cors,'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
}
export function failed(error: unknown): Response {
  return error instanceof RequestError ? reply(error.status,{error:error.code}) : reply(503,{error:'service_unavailable'});
}
export async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??'')
    || request.headers.has('content-encoding')) throw new RequestError(415,'unsupported_media_type');
  if (Number(request.headers.get('content-length')) > MAX_BYTES) throw new RequestError(413,'payload_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400,'invalid_json');
  const chunks: Uint8Array[]=[]; let size=0;
  try {
    while(true) { const {value,done}=await reader.read(); if(done)break; size+=value.length;
      if(size>MAX_BYTES){await reader.cancel();throw new RequestError(413,'payload_too_large');} chunks.push(value); }
    const bytes=new Uint8Array(size); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  } catch(error) { if(error instanceof RequestError)throw error; throw new RequestError(400,'invalid_json'); }
}
export function bearer(request: Request): string {
  const header=request.headers.get('authorization')??'';
  if(!/^Bearer [A-Za-z0-9._~+/-]+={0,2}$/.test(header))throw new RequestError(401,'unauthorized');
  return header;
}
export async function sha256(value: string): Promise<string> {
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
function b64(bytes: Uint8Array): string { let value='';for(const b of bytes)value+=String.fromCharCode(b);return btoa(value); }
function unb64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value),c=>c.charCodeAt(0)); }
function encryptionKey(env: Environment,keyId: string): Promise<CryptoKey> {
  try {
    const keys: unknown=JSON.parse(env('BANK_EVENT_ENCRYPTION_KEYS')??'');
    if(!/^[a-zA-Z0-9._-]{1,64}$/.test(keyId)||!object(keys)||typeof keys[keyId]!=='string')throw new Error();
    const raw=unb64(keys[keyId]);if(raw.length!==32)throw new Error();
    return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
  } catch { throw new RequestError(503,'encryption_unavailable'); }
}
function aad(externalId: string,deviceId: string,payloadHash: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`bank-event:v1:${externalId}:${deviceId}:${payloadHash}`);
}
export async function encryptPayload(env: Environment,payload: JsonObject,payloadHash: string) {
  const keyId=env('BANK_EVENT_KEY_ID')??'';const key=await encryptionKey(env,keyId);
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,
    additionalData:aad(String(payload.id),String(payload.deviceId),payloadHash)},key,new TextEncoder().encode(JSON.stringify(payload)));
  return {keyId,nonce:b64(nonce),ciphertext:b64(new Uint8Array(ciphertext))};
}
export async function decryptPayload(env: Environment,record: JsonObject): Promise<unknown> {
  try {
    if(!object(record.event))throw new Error();
    const key=await encryptionKey(env,String(record.keyId));
    const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(String(record.nonce)),
      additionalData:aad(String(record.event.externalId),String(record.event.deviceId),String(record.payloadHash))},key,unb64(String(record.ciphertext)));
    const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(await sha256(raw)!==record.payloadHash)throw new Error();
    return JSON.parse(raw);
  } catch {throw new RequestError(503,'decryption_unavailable');}
}
export function newToken(): string {return Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');}
export function rpcError(code: string): RequestError {
  const status=code==='28000'?401:code==='42501'?403:code==='PT409'||code==='23505'?409:code==='P0002'?404:code.startsWith('22')?400:503;
  return new RequestError(status,status===401?'unauthorized':status===403?'forbidden':status===409?'conflict':status===404?'not_found':status===400?'invalid_request':'storage_unavailable');
}
export function runtimeDependencies(deps: Dependencies) {
  const env=deps.env??((name:string)=>Deno.env.get(name));
  const rpc=deps.rpc??(async(name:string,args:JsonObject,authorization?:string):Promise<RpcResult>=>{
    const url=env('SUPABASE_URL'), apiKey=env(authorization?'SUPABASE_ANON_KEY':'SUPABASE_SERVICE_ROLE_KEY');
    if(!url||!apiKey)throw new RequestError(503,'service_unavailable');
    const response=await fetch(`${url}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:apiKey,authorization:authorization??`Bearer ${apiKey}`,'content-type':'application/json','content-profile':'public','accept-profile':'public'},body:JSON.stringify(args),signal:AbortSignal.timeout(15000)});
    const data:unknown=await response.json();
    return response.ok?{data,error:null}:{data:null,error:{code:object(data)&&typeof data.code==='string'?data.code:'BACKEND_ERROR'}};
  });
  const authorizeAdmin=deps.authorizeAdmin??(async(authorization:string):Promise<boolean>=>{
    const url=env('SUPABASE_URL'),apiKey=env('SUPABASE_ANON_KEY');if(!url||!apiKey)throw new RequestError(503,'service_unavailable');
    const response=await fetch(`${url}/auth/v1/user`,{headers:{apikey:apiKey,authorization},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new RequestError(response.status===401||response.status===403?401:503,'unauthorized');
    const user:unknown=await response.json();if(!object(user)||typeof user.id!=='string')throw new RequestError(401,'unauthorized');
    const permission=await rpc('is_super_admin',{},authorization);
    if(permission.error)throw rpcError(permission.error.code);
    return permission.data===true;
  });
  return {env,rpc,authorizeAdmin};
}
