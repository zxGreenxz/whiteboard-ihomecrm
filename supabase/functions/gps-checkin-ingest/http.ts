// Tiện ích HTTP/PostgREST của cổng nhận điểm danh. Cố ý không dùng `_shared/bank-events.ts`:
// hai cổng độc lập với nhau, và đường deploy của TEST chỉ đóng gói thư mục của từng hàm.
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HASH=/^[a-f0-9]{64}$/;
const MAX_BYTES=16*1024;

export type JsonObject=Record<string,unknown>;
export interface RpcResult{data:unknown;error:{code:string}|null}
export interface Dependencies{
  env?:(name:string)=>string|undefined;
  rpc?:(name:string,args:JsonObject)=>Promise<RpcResult>;
}

export class RequestError extends Error{
  constructor(public status:number,public code:string){super(code);}
}

export function object(value:unknown):value is JsonObject{
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

export function boundedText(value:unknown,bytes:number):value is string{
  return typeof value==='string'&&value.isWellFormed()&&new TextEncoder().encode(value).length<=bytes;
}

export function validTimestamp(value:unknown):value is string{
  if(typeof value!=='string')return false;
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!m||!Number.isFinite(Date.parse(value)))return false;
  const [,year,month,day,hour,minute,second,offset]=m;
  const y=Number(year),mo=Number(month),d=Number(day);
  const days=[31,y%4===0&&(y%100!==0||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
  return mo>=1&&mo<=12&&d>=1&&d<=days[mo-1]&&Number(hour)<24&&Number(minute)<60&&Number(second)<60
    &&(offset==='Z'||(Number(offset.slice(1,3))<24&&Number(offset.slice(4))<60));
}

const cors={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info, x-idempotency-key',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
};

export function reply(status:number,data:unknown):Response{
  return new Response(JSON.stringify(data),{status,headers:{...cors,'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
}

export function failed(error:unknown):Response{
  return error instanceof RequestError?reply(error.status,{error:error.code}):reply(503,{error:'service_unavailable'});
}

export async function readJson(request:Request):Promise<unknown>{
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??'')
    ||request.headers.has('content-encoding'))throw new RequestError(415,'unsupported_media_type');
  if(Number(request.headers.get('content-length'))>MAX_BYTES)throw new RequestError(413,'payload_too_large');
  const reader=request.body?.getReader();
  if(!reader)throw new RequestError(400,'invalid_json');
  const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      size+=value.length;
      if(size>MAX_BYTES){await reader.cancel();throw new RequestError(413,'payload_too_large');}
      chunks.push(value);
    }
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }catch(error){
    if(error instanceof RequestError)throw error;
    throw new RequestError(400,'invalid_json');
  }
}

export function bearer(request:Request):string{
  const header=request.headers.get('authorization')??'';
  if(!/^Bearer [A-Za-z0-9._~+/-]+={0,2}$/.test(header))throw new RequestError(401,'unauthorized');
  return header;
}

export async function sha256(value:string):Promise<string>{
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}

export function rpcError(code:string):RequestError{
  const status=code==='28000'?401:code==='42501'?403:code==='PT409'||code==='23505'?409:code==='PT429'?429:code.startsWith('22')?400:503;
  return new RequestError(status,status===401?'unauthorized':status===403?'forbidden':status===409?'conflict':status===429?'rate_limited':status===400?'invalid_request':'storage_unavailable');
}

export function runtimeRpc(deps:Dependencies){
  const env=deps.env??((name:string)=>Deno.env.get(name));
  return deps.rpc??(async(name:string,args:JsonObject):Promise<RpcResult>=>{
    const url=env('SUPABASE_URL'),apiKey=env('SUPABASE_SERVICE_ROLE_KEY');
    if(!url||!apiKey)throw new RequestError(503,'service_unavailable');
    const response=await fetch(`${url}/rest/v1/rpc/${name}`,{
      method:'POST',
      headers:{apikey:apiKey,authorization:`Bearer ${apiKey}`,'content-type':'application/json'},
      body:JSON.stringify(args),
      signal:AbortSignal.timeout(10000),
    });
    const data:unknown=await response.json();
    return response.ok?{data,error:null}:{data:null,error:{code:object(data)&&typeof data.code==='string'?data.code:'BACKEND_ERROR'}};
  });
}
