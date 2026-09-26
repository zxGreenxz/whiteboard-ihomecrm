import { createProvider } from './provider.mjs';
import { exactKeys, LabError, textField } from './evaluation.mjs';

const PROVIDER_BASE='https://ai.chillhome.io.vn/v1';
const MAX_BODY_BYTES=3*1024*1024;
const MAX_AUDIO_BYTES=2*1024*1024;
const MAX_AUTH_RESPONSE_BYTES=256*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUDIO_TYPES=new Set(['audio/webm','audio/mp4','audio/wav','audio/mpeg','audio/ogg']);
const validUuid=value=>typeof value==='string'&&UUID.test(value);
const unauthorized=()=>new LabError('UNAUTHORIZED','Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.',401);
const forbidden=()=>new LabError('FORBIDDEN','Bạn không có quyền dùng thử trong công ty đang chọn.',403);
const authUnavailable=()=>new LabError('AUTH_UNAVAILABLE','Chưa kiểm tra được phiên đăng nhập hoặc quyền truy cập. Vui lòng thử lại.',503);

function parseBody(request) {
  const mime=(request.headers?.['content-type']||'').split(';')[0].trim().toLowerCase();
  if(mime!=='application/json')throw new LabError('CONTENT_TYPE','Yêu cầu phải dùng JSON.',415);
  if(Number(request.headers?.['content-length'])>MAX_BODY_BYTES)throw new LabError('TOO_LARGE','Dữ liệu gửi lên vượt giới hạn.',413);
  let body=request.body;
  if(Buffer.isBuffer(body))body=body.toString('utf8');
  if(typeof body==='string') {
    if(Buffer.byteLength(body,'utf8')>MAX_BODY_BYTES)throw new LabError('TOO_LARGE','Dữ liệu gửi lên vượt giới hạn.',413);
    try{body=JSON.parse(body);}catch{throw new LabError('VALIDATION','Nội dung JSON không hợp lệ.');}
  }
  if(!body||typeof body!=='object'||Array.isArray(body))throw new LabError('VALIDATION','Nội dung gửi lên không hợp lệ.');
  if(Buffer.byteLength(JSON.stringify(body),'utf8')>MAX_BODY_BYTES)throw new LabError('TOO_LARGE','Dữ liệu gửi lên vượt giới hạn.',413);
  if(!validUuid(body.organizationId))throw new LabError('ORGANIZATION_REQUIRED','Vui lòng chọn công ty trước khi dùng thử.');
  if(body.action==='status')exactKeys(body,['action','organizationId']);
  else if(body.action==='extract')exactKeys(body,['action','organizationId','transcript','model','referenceTime','timeZone']);
  else if(body.action==='transcribe')exactKeys(body,['action','organizationId','model','audioBase64','contentType']);
  else throw new LabError('VALIDATION','Chức năng thử nghiệm không hợp lệ.');
  return body;
}

function decodeAudio(body) {
  const {audioBase64}=body;
  if(typeof audioBase64!=='string'||!audioBase64||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audioBase64))throw new LabError('VALIDATION','Dữ liệu âm thanh không hợp lệ.');
  if(audioBase64.length>4*Math.ceil(MAX_AUDIO_BYTES/3))throw new LabError('TOO_LARGE','Âm thanh phải nhỏ hơn hoặc bằng 2 MiB.',413);
  textField(body.contentType,100,true);
  const contentType=body.contentType.split(';')[0].trim().toLowerCase();
  if(!AUDIO_TYPES.has(contentType))throw new LabError('VALIDATION','Định dạng âm thanh không được hỗ trợ.');
  const audio=Buffer.from(audioBase64,'base64');
  if(audio.length>MAX_AUDIO_BYTES)throw new LabError('TOO_LARGE','Âm thanh phải nhỏ hơn hoặc bằng 2 MiB.',413);
  if(!audio.length||audio.toString('base64')!==audioBase64)throw new LabError('VALIDATION','Dữ liệu âm thanh không hợp lệ.');
  return {audio,contentType,model:body.model};
}

async function boundedAuthJson(response) {
  if(Number(response.headers.get('content-length'))>MAX_AUTH_RESPONSE_BYTES){await response.body?.cancel();throw authUnavailable();}
  const reader=response.body?.getReader();if(!reader)throw authUnavailable();
  const chunks=[];let bytes=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_AUTH_RESPONSE_BYTES){await reader.cancel();throw authUnavailable();}chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{throw authUnavailable();}finally{reader.releaseLock();}
}

// Same current-org permission semantics as useMyPermissions.can(). The RPC is
// authoritative: never fall back to get_my_permissions(), which unions orgs.
function canViewTasks(permissions) {
  if(permissions?.__superadmin===true)return true;
  const view=permissions?.tasks?.view;
  if(view===true)return true;
  if(!view||typeof view!=='object'||Array.isArray(view))return false;
  return view.org_wide===true || [view.building_ids,view.cashbook_ids].some(ids=>Array.isArray(ids)&&ids.length>0&&ids.every(validUuid));
}

export function createAppHandler({fetchImpl=fetch,getEnv=key=>process.env[key],now=Date.now}={}) {
  // Warm-instance limits only, matching existing customer-address-conversion.
  // Store verified user IDs and counters, never JWTs, audio or transcript text.
  const usage=new Map();let provider;
  function allowUser(userId,generation) {
    const timestamp=now();for(const [id,window]of usage)if(window.until<=timestamp)usage.delete(id);
    let window=usage.get(userId);
    if(!window){if(usage.size>=2000)return false;window={total:0,generations:0,until:timestamp+60000};usage.set(userId,window);}
    window.total++;if(generation)window.generations++;
    return window.total<=40&&window.generations<=10;
  }
  async function verifyAccess(request,body) {
    const authorization=request.headers?.authorization;
    if(typeof authorization!=='string'||authorization.length>8192||!/^Bearer \S+$/.test(authorization))throw unauthorized();
    let base;const publicKey=getEnv('VITE_SUPABASE_PUBLISHABLE_KEY');
    try {const url=new URL(getEnv('VITE_SUPABASE_URL'));if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error();base=url.origin;}catch{throw authUnavailable();}
    if(!publicKey)throw authUnavailable();
    const headers={authorization,apikey:publicKey,'content-type':'application/json'};
    async function call(path,body,auth=false) {
      let response;
      // PostgREST can expose a non-public default schema. Select the same public
      // schema as supabase-js for RPCs; GoTrue does not receive profile headers.
      const requestHeaders=path.startsWith('/rest/v1/rpc/')?{...headers,'content-profile':'public','accept-profile':'public'}:headers;
      try{response=await fetchImpl(base+path,{method:body===undefined?'GET':'POST',headers:requestHeaders,...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(5000)});}catch{throw authUnavailable();}
      if(!response.ok){await response.body?.cancel();if(auth&&(response.status===401||response.status===403))throw unauthorized();throw authUnavailable();}
      return boundedAuthJson(response);
    }
    const user=await call('/auth/v1/user',undefined,true);
    if(!validUuid(user?.id)||user.is_anonymous===true)throw unauthorized();
    if(!allowUser(user.id,body.action!=='status'))throw new LabError('RATE_LIMITED','Bạn đã thử nhiều lần liên tiếp. Vui lòng chờ một phút.',429);
    const directory=await call('/rest/v1/rpc/get_my_organizations',{});
    const belongsToOrganization=directory?.user_id===user.id&&Array.isArray(directory.organizations)&&directory.organizations.some(org=>org?.id===body.organizationId);
    if(!belongsToOrganization)throw forbidden();
    const permissions=await call('/rest/v1/rpc/get_my_permissions_v2',{p_org:body.organizationId});
    // Canonical platform-admin sentinel is accepted only after the explicit
    // membership check above; it never gives access to an arbitrary org.
    if(!canViewTasks(permissions))throw forbidden();
  }
  return async function voiceTaskLabHandler(request,response) {
    response.setHeader('Cache-Control','private, no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    if(request.method!=='POST'){response.setHeader('Allow','POST');return response.status(405).json({error:{code:'METHOD_NOT_ALLOWED',message:'Chỉ hỗ trợ POST.'}});}
    try {
      const body=parseBody(request);
      await verifyAccess(request,body);
      provider??=createProvider({baseUrl:PROVIDER_BASE,apiKey:getEnv('VOICE_LAB_NINEROUTER_API_KEY'),fetchImpl});
      if(body.action==='status')return response.status(200).json({authenticated:true,...await provider.capabilities()});
      if(body.action==='transcribe')return response.status(200).json(await provider.transcribe(decodeAudio(body)));
      const {transcript,model,referenceTime,timeZone}=body;
      return response.status(200).json(await provider.extract({transcript,model,referenceTime,timeZone}));
    }catch(error) {
      const safe=error instanceof LabError?error:new LabError('INTERNAL','Có lỗi trong trang thử nghiệm. Vui lòng thử lại.',500);
      if(safe.status===429)response.setHeader('Retry-After','60');
      return response.status(safe.status).json({error:{code:safe.code,message:safe.message}});
    }
  };
}
