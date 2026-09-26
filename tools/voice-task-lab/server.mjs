import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProvider } from './provider.mjs';
import { createEvaluationStore, exactKeys, LabError, summarize, validateEvaluation } from './evaluation.mjs';

const moduleDir=dirname(fileURLToPath(import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webp':'image/webp','.woff2':'font/woff2'};
const audioTypes=new Set(['audio/webm','audio/mp4','audio/wav','audio/mpeg','audio/ogg']);
const jsonTypes=new Set(['application/json']);
const digest=value=>createHash('sha256').update(value).digest();
const isWithin=(parent,child)=>{const path=relative(parent,child);return !path.startsWith(`..${sep}`)&&path!=='..'&&!isAbsolute(path);};
function send(response,status,data,headers={}) {response.writeHead(status,{'content-type':'application/json; charset=utf-8',...headers});response.end(JSON.stringify(data));}
async function readBody(request,maximum,allowedTypes) {
  const contentType=(request.headers['content-type']||'').split(';')[0].trim().toLowerCase();
  if(!allowedTypes.has(contentType))throw new LabError('CONTENT_TYPE','Định dạng dữ liệu không được hỗ trợ.',415);
  const announced=Number(request.headers['content-length']);
  if(Number.isFinite(announced)&&announced>maximum){request.resume();throw new LabError('TOO_LARGE','Dữ liệu gửi lên vượt giới hạn cho phép.',413);}
  const chunks=[];let length=0;
  for await(const chunk of request){length+=chunk.length;if(length>maximum)throw new LabError('TOO_LARGE','Dữ liệu gửi lên vượt giới hạn cho phép.',413);chunks.push(chunk);}
  if(!length)throw new LabError('VALIDATION','Nội dung gửi lên đang trống.');
  return {body:Buffer.concat(chunks),contentType};
}
async function readJson(request,maximum) {const {body}=await readBody(request,maximum,jsonTypes);try{return JSON.parse(body.toString('utf8'));}catch{throw new LabError('VALIDATION','Nội dung JSON không hợp lệ.');}}
async function assertPrivateDirectory(dataDir,distDir) {
  if(!dataDir||!isAbsolute(dataDir)||isWithin(distDir,resolve(dataDir)))throw new LabError('CONFIG','VOICE_LAB_DATA_DIR phải là thư mục tuyệt đối, riêng tư, ngoài mã nguồn.',500);
  let current=resolve(dataDir);
  while(true){
    try{await stat(join(current,'.git'));throw new LabError('CONFIG','Thư mục đánh giá phải nằm ngoài Git checkout.',500);}catch(error){if(error instanceof LabError)throw error;if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
    const parent=dirname(current);if(parent===current)break;current=parent;
  }
}
export async function createLabServer({
  provider=createProvider({baseUrl:process.env.NINEROUTER_BASE_URL,apiKey:process.env.NINEROUTER_API_KEY}),
  accessCode=process.env.VOICE_LAB_ACCESS_CODE,
  publicOrigin=process.env.VOICE_LAB_PUBLIC_ORIGIN,
  dataDir=process.env.VOICE_LAB_DATA_DIR,
  distDir=join(moduleDir,'dist'),
  port=Number(process.env.VOICE_LAB_PORT||4179),
}={}) {
  if(typeof accessCode!=='string'||accessCode.length<8||accessCode.length>256)throw new LabError('CONFIG','Mã truy cập phải dài từ 8 đến 256 ký tự.',500);
  let originUrl;
  try{originUrl=new URL(publicOrigin);if(originUrl.origin!==publicOrigin||!(originUrl.protocol==='https:'||(originUrl.protocol==='http:'&&originUrl.hostname==='127.0.0.1')))throw Error();}catch{throw new LabError('CONFIG','VOICE_LAB_PUBLIC_ORIGIN phải là origin HTTPS chính xác hoặc localhost để thử.',500);}
  if(!Number.isInteger(port)||port<0||port>65535)throw new LabError('CONFIG','Cổng máy chủ không hợp lệ.',500);
  distDir=resolve(distDir);await assertPrivateDirectory(dataDir,distDir);
  const store=await createEvaluationStore(dataDir),sessions=new Map(),attempts=[];
  const codeHash=digest(accessCode);let activeProviderCalls=0;
  async function useProvider(operation){if(activeProviderCalls>=2)throw new LabError('BUSY','Máy chủ đang xử lý hai yêu cầu. Vui lòng thử lại sau.',429);activeProviderCalls++;try{return await operation();}finally{activeProviderCalls--;}}
  const server=createServer(async(request,response)=>{
    response.setHeader('cache-control','no-store');
    response.setHeader('x-content-type-options','nosniff');
    response.setHeader('referrer-policy','no-referrer');
    response.setHeader('x-frame-options','DENY');
    response.setHeader('permissions-policy','microphone=(self), camera=(), geolocation=()');
    response.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url=new URL(request.url,'http://127.0.0.1');
      const localOrigin=`http://127.0.0.1:${server.address()?.port??port}`;
      const origin=request.headers.origin;
      if(!['GET','HEAD'].includes(request.method)&&origin!==publicOrigin&&origin!==localOrigin)throw new LabError('ORIGIN','Nguồn gửi yêu cầu không được phép.',403);
      if(request.method==='POST'&&url.pathname==='/api/session') {
        const now=Date.now();while(attempts.length&&attempts[0]<now-60000)attempts.shift();
        if(attempts.length>=5)throw new LabError('RATE_LIMIT','Đã thử đăng nhập nhiều lần. Vui lòng chờ một phút.',429);
        attempts.push(now);
        const body=await readJson(request,1024);exactKeys(body,['code']);
        if(typeof body.code!=='string'||body.code.length>256||!timingSafeEqual(codeHash,digest(body.code)))throw new LabError('UNAUTHORIZED','Mã truy cập không đúng.',401);
        for(const [token,expires] of sessions)if(expires<now)sessions.delete(token);
        if(sessions.size>=50)sessions.delete(sessions.keys().next().value);
        const token=randomBytes(32).toString('base64url');sessions.set(token,now+8*60*60*1000);
        send(response,200,{authenticated:true},{'set-cookie':`voice_lab_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${origin===localOrigin?'':'; Secure'}`});return;
      }
      const cookie=(request.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith('voice_lab_session='));
      const token=cookie?.slice('voice_lab_session='.length);
      const authenticated=!!token&&sessions.has(token)&&sessions.get(token)>Date.now();
      if(request.method==='GET'&&url.pathname==='/api/status') {send(response,200,authenticated?{authenticated:true,...await provider.capabilities()}:{authenticated:false});return;}
      if(url.pathname.startsWith('/api/')) {
        if(!authenticated)throw new LabError('UNAUTHORIZED','Vui lòng nhập mã truy cập để tiếp tục.',401);
        if(request.method==='POST'&&url.pathname==='/api/transcribe') {
          const {body,contentType}=await readBody(request,10*1024*1024,audioTypes);
          send(response,200,await useProvider(()=>provider.transcribe({model:url.searchParams.get('model'),audio:body,contentType})));return;
        }
        if(request.method==='POST'&&url.pathname==='/api/extract') {
          const body=await readJson(request,64*1024);exactKeys(body,['transcript','model','referenceTime','timeZone']);
          send(response,200,await useProvider(()=>provider.extract(body)));return;
        }
        if(request.method==='POST'&&url.pathname==='/api/evaluations') {
          const record=validateEvaluation(await readJson(request,128*1024));
          await store.upsert(record);const records=await store.list();send(response,200,{record,summary:summarize(records)});return;
        }
        if(request.method==='GET'&&['/api/evaluations','/api/export'].includes(url.pathname)) {
          const records=await store.list();send(response,200,{records,summary:summarize(records)},url.pathname==='/api/export'?{'content-disposition':'attachment; filename="voice-task-evaluations.json"'}:{});return;
        }
        throw new LabError('NOT_FOUND','Không tìm thấy chức năng yêu cầu.',404);
      }
      if(!['GET','HEAD'].includes(request.method))throw new LabError('NOT_FOUND','Không tìm thấy trang.',404);
      let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{throw new LabError('NOT_FOUND','Không tìm thấy trang.',404);}
      if(pathname==='/')pathname='/index.html';
      if(pathname.includes('\\')||pathname.split('/').some(segment=>segment.startsWith('.'))||pathname.includes('\u0000')||!types[extname(pathname)]||(extname(pathname)==='.html'&&pathname!=='/index.html'))throw new LabError('NOT_FOUND','Không tìm thấy tệp.',404);
      const target=resolve(distDir,`.${pathname}`);
      if(!isWithin(distDir,target))throw new LabError('NOT_FOUND','Không tìm thấy tệp.',404);
      let file;
      try {const resolved=await realpath(target);const root=await realpath(distDir);if(!isWithin(root,resolved))throw Error();const info=await stat(resolved);if(!info.isFile()||info.size>5*1024*1024)throw Error();file=await readFile(resolved);}catch{throw new LabError('NOT_FOUND','Không tìm thấy tệp.',404);}
      response.writeHead(200,{'content-type':types[extname(pathname)]});response.end(request.method==='HEAD'?undefined:file);
    } catch(error) {
      if(response.headersSent){response.end();return;}
      const safe=error instanceof LabError?error:new LabError('INTERNAL','Có lỗi trên máy chủ thử nghiệm. Vui lòng thử lại.',500);
      send(response,safe.status,{error:{code:safe.code,message:safe.message}});
    }
  });
  server.requestTimeout=90000;server.headersTimeout=15000;server.timeout=90000;server.maxHeadersCount=50;
  return server;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {const port=Number(process.env.VOICE_LAB_PORT||4179);const server=await createLabServer({port});server.listen(port,'127.0.0.1',()=>process.stdout.write(`Voice task lab listening on 127.0.0.1:${port}\n`));}
  catch(error){process.stderr.write(`${error instanceof LabError?error.message:'Không thể khởi động máy chủ thử nghiệm.'}\n`);process.exitCode=1;}
}
