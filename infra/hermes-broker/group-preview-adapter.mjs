// Fixed group preview transport and per-dispatched-command decision adapter.
import { createHash, randomUUID } from 'node:crypto';
import { mayUseGroupTool } from './capability-contract.mjs';
import { BrokerError } from './broker.mjs';
import { validateSessionMaterial } from './session-crypto.mjs';
import { projectAvailableRooms } from './room-read-projection.mjs';
import { readWithBaseAuthorization } from './authorization-extension.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA=/^[a-f0-9]{64}$/, TOKEN=/^hc_[A-Za-z0-9_-]{43}$/;
const baseKeys=['connectionId','tokenDigest','commandId','claimId','expectedEpoch','expectedPolicyVersion','expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision','requestId'];
const positive=v=>Number.isSafeInteger(v)&&v>0&&v<Number.MAX_SAFE_INTEGER;
const id=v=>typeof v==='string'&&UUID.test(v);
const fail=code=>{throw new BrokerError(code);};
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const record=v=>v!==null&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&Object.getOwnPropertyDescriptor(v,k)?.enumerable&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const exact=(v,keys)=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function ids(value,cap){
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<1||value.length>cap||Reflect.ownKeys(value).length!==value.length+1)fail('invalid_request');
  for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value')||!id(d.value))fail('invalid_request');}
  if(new Set(value).size!==value.length)fail('invalid_request');return [...value].sort();
}
function jwt(v){
  if(typeof v!=='string'||v.length>16384||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v))return false;
  try{const p=JSON.parse(Buffer.from(v.split('.')[1],'base64url'));return record(p)&&p.role==='authenticated'&&id(p.sub)&&id(p.session_id);}catch{return false;}
}
function base(v,origin='private_command'){
  const keys=origin==='external_mcp'?baseKeys.filter(key=>!['commandId','claimId'].includes(key)):baseKeys;
  if(!exact(v,keys)||!SHA.test(v.tokenDigest)||keys.filter(k=>['connectionId','commandId','claimId','expectedMembershipId','requestId'].includes(k)).some(k=>!id(v[k]))||
    ['expectedEpoch','expectedPolicyVersion','expectedAuthorizationVersion','expectedSessionRevision'].some(k=>!(k==='expectedPolicyVersion'&&v[k]===0)&&!positive(v[k])))fail('invalid_request');
  return Object.fromEntries(keys.map(k=>[k,v[k]]));
}
function iso(v){const n=typeof v==='string'?Date.parse(v):NaN;return positive(n)&&new Date(n).toISOString()===v?n:null;}
function intent(v){if(!exact(v,['roomIds','conversationIds']))fail('invalid_request');return freeze({roomIds:ids(v.roomIds,20),conversationIds:ids(v.conversationIds,8)});}
function dispatchSnapshot(value,expectedIds,write=false){
  if(!exact(value,['id','expiresAt','recipients'])||!id(value.id)||!iso(value.expiresAt)||!Array.isArray(value.recipients)||
    value.recipients.length<1||value.recipients.length>8||(expectedIds&&value.recipients.length!==expectedIds.length))fail('backend_unavailable');
  const conversations=new Set(),jobs=new Set();
  for(const row of value.recipients){
    if(!exact(row,['conversationId','jobId','status',...(write?[]:['name'])])||!id(row.conversationId)||!id(row.jobId)||
      conversations.has(row.conversationId)||jobs.has(row.jobId)||(expectedIds&&!expectedIds.includes(row.conversationId))||
      !(write?['queued']:['queued','processing','sent','failed','unknown']).includes(row.status)||
      (!write&&(typeof row.name!=='string'||!row.name.trim()||Buffer.byteLength(row.name)>500||row.name.includes('\0'))))fail('backend_unavailable');
    conversations.add(row.conversationId);jobs.add(row.jobId);
  }
  return value;
}
async function bounded(signal,timeoutMs,operation,dependencyScope){
  if(!(signal instanceof AbortSignal)||signal.aborted)fail('timeout');
  const controller=new AbortController();let rejectAbort;
  const interrupted=new Promise((_,reject)=>{rejectAbort=reject;});
  const stop=()=>{controller.abort();rejectAbort(new BrokerError('timeout'));};
  signal.addEventListener('abort',stop,{once:true});const timer=setTimeout(stop,timeoutMs);
  const check=()=>{if(signal.aborted||controller.signal.aborted)fail('timeout');};
  const run=()=>{check();return operation(controller.signal,check);};
  try{return await Promise.race([dependencyScope?dependencyScope.track(run):Promise.resolve().then(run),interrupted]);}
  catch(error){if(error instanceof BrokerError)throw error;fail('backend_unavailable');}
  finally{clearTimeout(timer);signal.removeEventListener('abort',stop);controller.abort();}
}
async function jsonBody(response,cap,signal){
  if(response.redirected||!response.body||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||Number(response.headers.get('content-length'))>cap){await response.body?.cancel().catch(()=>{});fail('backend_unavailable');}
  const reader=response.body.getReader(),chunks=[];let bytes=0,cancellation;
  const stop=()=>cancellation??=reader.cancel().catch(()=>{});signal.addEventListener('abort',stop,{once:true});
  try{while(true){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done)break;bytes+=part.value.byteLength;if(bytes>cap)fail('response_too_large');chunks.push(part.value);}return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));}
  finally{signal.removeEventListener('abort',stop);await stop();reader.releaseLock();}
}

/** Real fixed HTTPS transport. Local JWT parsing only rejects malformed or
 * privileged input; actual /auth/v1/user verification is required by the service.
 * track covers raw fetch+body completion even if timeout observer returns first.
 * No credential fallback, retry, generic RPC, or caller-controlled host/path. */
export function createSupabaseGroupPreviewReads(options){return createGroupOriginReads(options,'private_command');}
// Fixed origin profiles are host dependencies, never MCP arguments.
export function createGroupOriginReads({url,publishableKey,fetch:request=globalThis.fetch,timeoutMs=10000,maxResponseBytes=2097152,dependencyScope}={},origin){
  if(!['private_command','external_mcp'].includes(origin))throw new TypeError('invalid_group_origin');
  const prefix=origin==='external_mcp'?'hermes_external_group_':'hermes_group_';
  let endpoint;try{endpoint=new URL(url);}catch{throw new TypeError('invalid_group_reads_config');}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash||
    typeof publishableKey!=='string'||!/^sb_publishable_[A-Za-z0-9_-]{1,512}$/.test(publishableKey)||typeof request!=='function'||
    !positive(timeoutMs)||timeoutMs>30000||!positive(maxResponseBytes)||maxResponseBytes>4194304||typeof dependencyScope?.track!=='function')throw new TypeError('invalid_group_reads_config');
  async function rpc(name,accessToken,args,{signal,onDispatch,onRejected}={},optionalAction=false,write=false){
    if(!jwt(accessToken))fail('invalid_request');
    if(write&&[onDispatch,onRejected].some(fn=>typeof fn!=='function'))fail('invalid_request');
    const body=JSON.stringify(args);
    let uncertain=false;
    try{return await bounded(signal,timeoutMs,async(innerSignal,check)=>{
      if(write){uncertain=true;onDispatch(args.p.requestId);}
      const response=await request(new URL('/rest/v1/rpc/'+name,endpoint).href,{method:'POST',redirect:'error',signal:innerSignal,
        headers:{apikey:publishableKey,authorization:`Bearer ${accessToken}`,'content-type':'application/json','content-profile':'public','accept-profile':'public'},body});
      if(innerSignal.aborted){await response.body?.cancel().catch(()=>{});check();}
      const data=await jsonBody(response,maxResponseBytes,innerSignal);check();
      if(write&&!response.ok&&exact(data,['code','message','details','hint'])&&typeof data.code==='string'&&typeof data.message==='string'&&
        [data.details,data.hint].every(value=>value===null||typeof value==='string')&&
        ((response.status===401)||(response.status===403&&data.code==='42501')||(response.status===409&&data.code==='PT409')||
          (response.status===400&&data.code==='22023')||(response.status===404&&data.code==='PGRST202'))){uncertain=false;onRejected();}
      // Management may retain the verified read-only base when this optional
      // rollout is absent. Every other error, including revocation, is strict.
      if(optionalAction&&exact(data,['code','message','details','hint'])&&typeof data.message==='string'&&
        [data.details,data.hint].every(value=>value===null||typeof value==='string')&&
        ((response.status===404&&data.code==='PGRST202')||
        (response.status===403&&data.code==='42501'&&data.message==='hermes_group_policy_absent')))return null;
      if(response.status===401)fail('unauthorized');if(response.status===403||data?.code==='42501')fail('forbidden');
      if(response.status===409&&data?.code==='PT409')fail('context_changed');
      if(response.status===400&&data?.code==='22023')fail('invalid_request');
      if(!response.ok||!record(data)||['error','error_code','error_description'].some(k=>Object.hasOwn(data,k)))fail('backend_unavailable');
      return data;
    },dependencyScope);}catch(error){if(write&&uncertain)fail('send_outcome_unknown');throw error;}
  }
  return Object.freeze({
    async actionContext(input,options){if(!exact(input,['accessToken','organizationId'])||!id(input.organizationId))fail('invalid_request');return rpc('hermes_group_action_context_v1',input.accessToken,{p_organization_id:input.organizationId},options);},
    async optionalActionContext(input,options){if(!exact(input,['accessToken','organizationId'])||!id(input.organizationId))fail('invalid_request');return rpc('hermes_group_action_context_v1',input.accessToken,{p_organization_id:input.organizationId},options,true);},
    async directory(input,options){if(!exact(input,['accessToken','binding']))fail('invalid_request');return rpc(prefix+'directory_v1',input.accessToken,{p:base(input.binding,origin)},options);},
    async dispatchStatus(input,options){
      if(!exact(input,['accessToken','dispatchId',...(origin==='external_mcp'?['binding']:[])])||!id(input.dispatchId))fail('invalid_request');
      return rpc(prefix+'send_status_v1',input.accessToken,origin==='external_mcp'?{p:{...base(input.binding,origin),dispatchId:input.dispatchId}}:{p_dispatch_id:input.dispatchId},options);
    },
    async decide(input,options){
      if(!exact(input,['accessToken','binding','intent','expectedContextVersion','intentDigest','roomReadDigest'])||
        ['expectedContextVersion','intentDigest','roomReadDigest'].some(k=>typeof input[k]!=='string'||!SHA.test(input[k])))fail('invalid_request');
      const selection=intent(input.intent);return rpc(prefix+'preview_decision_v1',input.accessToken,{p:{...base(input.binding,origin),...selection,
        expectedContextVersion:input.expectedContextVersion,intentDigest:input.intentDigest,roomReadDigest:input.roomReadDigest}},options);
    },
    async send(input,options){
      if(!exact(input,['accessToken','binding','intent','expectedContextVersion','intentDigest','roomReadDigest'])||
        ['expectedContextVersion','intentDigest','roomReadDigest'].some(k=>typeof input[k]!=='string'||!SHA.test(input[k])))fail('invalid_request');
      const selection=intent(input.intent);return rpc(prefix+'send_v1',input.accessToken,{p:{...base(input.binding,origin),...selection,
        expectedContextVersion:input.expectedContextVersion,intentDigest:input.intentDigest,roomReadDigest:input.roomReadDigest}},options,false,true);
    }
  });
}

/** Extension of the existing real durable auth adapter. Reuses its
 * Auth/membership/room checks. Adds independent fixed CRM read/action bits and
 * persisted company ceiling; DurableAuthority still intersects policy+connection.
 * Not a flag to make a fake object trusted. Missing RPC/metadata is a hard error. */
function capabilityAuthAdapter(baseAuth,readAction,optional){
  if(typeof baseAuth?.verifySession!=='function'||typeof baseAuth?.readAuthorization!=='function'||typeof readAction!=='function')throw new TypeError('invalid_group_auth_config');
  return Object.freeze({verifySession:input=>baseAuth.verifySession(input),async readAuthorization(input){
    const {current,capability}=await readWithBaseAuthorization(baseAuth,input,()=>readAction({accessToken:input.accessToken,organizationId:input.organizationId},{signal:input.signal}));
    if(current.permissions.action.length||current.companyCeilings.action.length||
      current.permissions.read.includes('chat_zalo.view')||current.companyCeilings.read.includes('chat_zalo.view'))fail('context_changed');
    const action=capability();
    if(optional&&action===null)return current;
    if(!exact(action,['organizationId','userId','membershipId','authorizationVersion','policyVersion','allowed','companyEnabled','readAllowed','readCompanyEnabled'])||
      action.organizationId!==input.organizationId||action.userId!==input.userId||!id(action.membershipId)||!positive(action.authorizationVersion)||!(action.policyVersion===0||positive(action.policyVersion))||
      ['allowed','companyEnabled','readAllowed','readCompanyEnabled'].some(key=>typeof action[key]!=='boolean'))fail('backend_unavailable');
    if(action.membershipId!==current.membership.membershipId||action.authorizationVersion!==current.membership.authorizationVersion)fail('context_changed');
    if(action.allowed&&!action.companyEnabled||action.readAllowed&&!action.readCompanyEnabled)fail('backend_unavailable');
    // This slice extends the existing no-action adapter only, never overwrites
    // independently introduced capabilities from a newer implementation.
    const granted=action.allowed?['chat_zalo.send']:[];
    return {...current,permissions:{read:[...current.permissions.read,...(action.readAllowed?['chat_zalo.view']:[])],action:granted},
      companyCeilings:{read:[...current.companyCeilings.read,...(action.readCompanyEnabled?['chat_zalo.view']:[])],action:action.companyEnabled?['chat_zalo.send']:[]},
      scopesByPermission:{...current.scopesByPermission,...(action.readAllowed?{'chat_zalo.view':{buildingIds:[],cashbookIds:[]}}:{}),...(action.allowed?{'chat_zalo.send':{buildingIds:[],cashbookIds:[]}}:{})},
      epoch:hash({baseEpoch:current.epoch,action})};
  }});
}
export function createGroupPreviewAuthAdapter({baseAuth,reads}={}){
  return capabilityAuthAdapter(baseAuth,reads?.actionContext?.bind(reads),false);
}
export function createConnectionActionAuthAdapter({baseAuth,reads}={}){
  return capabilityAuthAdapter(baseAuth,reads?.optionalActionContext?.bind(reads),true);
}
// Canonical core composition name. Existing exports remain compatibility entry
// points for fixtures/older hosts; all share this one CRM adapter implementation.
export const createHermesCapabilityAuthAdapter=createConnectionActionAuthAdapter;

/** Per-dispatched-command decision port. `commandContext` is supplied by the
 * trusted dispatcher after its definite first dispatch ACK, never MCP args.
 * DB independently checks that claim, identity, binding and live ingress. Root
 * integration carries the existing claim through runtime's trusted turn context
 * and the supervisor WeakMap. Do NOT construct it from model JSON.
 * Receipt is empty/single-use; closure owns material. SQL is the final await. */
export function createGroupPreviewDecisions(options){return createGroupOriginDecisions(options,'private_command');}
export function createGroupOriginDecisions({authority,connectionStore,crypto,auth,reads,commandContext,requestId,clock=Date.now,timeoutMs=10000}={},origin){
  if(!['private_command','external_mcp'].includes(origin))throw new TypeError('invalid_group_origin');
  const privateOrigin=origin==='private_command';
  if([authority?.resolve,authority?.checkUnchanged,connectionStore?.readConnection,crypto?.open,auth?.verifySession,reads?.directory,reads?.decide,clock].some(fn=>typeof fn!=='function')||
    (privateOrigin?(!exact(commandContext,['commandId','claimId'])||!id(commandContext.commandId)||!id(commandContext.claimId)):(commandContext!==undefined||(requestId!==undefined&&!id(requestId))))||!positive(timeoutMs)||timeoutMs>30000)throw new TypeError('invalid_group_decisions_config');
  const context=Object.freeze(privateOrigin?{...commandContext}:{}),issued=new WeakMap();
  const now=()=>{const t=clock();if(!positive(t))fail('backend_unavailable');return t;};
  function ownerMatch(authorityRow,directory){
    if(!exact(directory,['authority','recipientRead'])||!record(directory.authority)||!record(directory.authority.owner)||!SHA.test(directory.authority.contextVersion)||!positive(directory.authority.expiresAt))fail('backend_unavailable');
    const expected={userId:authorityRow.userId,organizationId:authorityRow.organizationId,assistantId:authorityRow.assistantId,connectionId:authorityRow.id};
    if(!exact(directory.authority.owner,Object.keys(expected))||Object.keys(expected).some(k=>expected[k]!==directory.authority.owner[k]))fail('context_changed');
    if(directory.authority.expiresAt<=now())fail('unauthorized');
  }
  async function capture(token,selected,{signal}={}){
      if(typeof token!=='string'||!TOKEN.test(token))fail('unauthorized');const tokenDigest=hash(token);
      return bounded(signal,timeoutMs,async(innerSignal,check)=>{
        const before=await authority.resolve(token,{signal:innerSignal});check();
        if(!record(before)||!record(before.row)||before.row.state!=='active'||!positive(before.row.expiresAt)||before.row.expiresAt<=now()||
          !mayUseGroupTool(before.effective,selected===null?'directory':'preview'))fail('forbidden');
        const joined=await connectionStore.readConnection({tokenDigest},{signal:innerSignal});check();
        if(!record(joined)||joined.status!=='active'||!record(joined.connection)||!record(joined.session)||!record(joined.policy)||!record(joined.membership))fail('unauthorized');
        const row=joined.connection,session=joined.session;
        if(['id','assistantId','userId','organizationId','state','epoch','expiresAt'].some(k=>row[k]!==before.row[k])||row.tokenDigest!==tokenDigest||
          !id(row.credentialRef)||session.credentialRef!==row.credentialRef||!exact(session.binding,['assistantId','userId','organizationId','sessionId'])||
          ['assistantId','userId','organizationId'].some(k=>session.binding[k]!==row[k])||!id(session.binding.sessionId))fail('context_changed');
        const opened=validateSessionMaterial(crypto.open(session.envelope,session.binding));
        const {accessToken,expiresAt}=opened;opened.refreshToken=undefined;
        if(expiresAt!==session.expiresAt||expiresAt<=now())fail('unauthorized');
        const verified=await auth.verifySession({accessToken,signal:innerSignal});check();
        if(!exact(verified,['userId','sessionId','expiresAt'])||verified.userId!==row.userId||verified.sessionId!==session.binding.sessionId||verified.expiresAt!==expiresAt)fail('unauthorized');
        const binding=base({connectionId:row.id,tokenDigest,...context,expectedEpoch:row.epoch,expectedPolicyVersion:joined.policy.version,
          expectedMembershipId:joined.membership.membershipId,expectedAuthorizationVersion:joined.membership.authorizationVersion,expectedSessionRevision:session.revision,requestId:requestId??randomUUID()},origin);
        const directory=await reads.directory({accessToken,binding},{signal:innerSignal});check();ownerMatch(row,directory);
        const receipt=Object.freeze({});issued.set(receipt,{before,row,accessToken,expiresAt,tokenDigest,binding,selected,contextVersion:directory.authority.contextVersion,
          deadline:Math.min(now()+timeoutMs,expiresAt,row.expiresAt,directory.authority.expiresAt)});return receipt;
      });
  }
  async function settle(token,receipt,readBinding,{signal,onDispatch,onRejected}={},write=false){
    if(write&&!privateOrigin&&!id(requestId))fail('invalid_request');
    if(write&&(typeof reads.send!=='function'||[onDispatch,onRejected].some(fn=>typeof fn!=='function')))fail('tool_not_available');
    if(typeof token!=='string'||!TOKEN.test(token)||!issued.has(receipt))fail('context_changed');
    const snap=issued.get(receipt);issued.delete(receipt);
    if(snap.selected===null||hash(token)!==snap.tokenDigest||!exact(readBinding,['intentDigest','roomReadDigest','roomReadAt'])||
      readBinding.intentDigest!==hash(snap.selected)||typeof readBinding.roomReadDigest!=='string'||!SHA.test(readBinding.roomReadDigest)||!iso(readBinding.roomReadAt))fail('context_changed');
    const captured={...readBinding};let uncertain=false;
    const dispatched=dispatchId=>{uncertain=true;if(dispatchId!==snap.binding.requestId)fail('backend_unavailable');onDispatch(dispatchId);}, rejected=()=>{uncertain=false;onRejected();};
    try{return await bounded(signal,timeoutMs,async(innerSignal,check)=>{
      const fresh=()=>{check();if(now()>=snap.deadline||iso(captured.roomReadAt)>now())fail('context_changed');};fresh();
      const checked=await authority.checkUnchanged(token,snap.before,{signal:innerSignal});fresh();if(checked!==undefined)fail('context_changed');
      if(write&&!mayUseGroupTool(snap.before.effective,'send'))fail('forbidden');
      const input={accessToken:snap.accessToken,binding:snap.binding,intent:snap.selected,expectedContextVersion:snap.contextVersion,
        intentDigest:captured.intentDigest,roomReadDigest:captured.roomReadDigest};
      const final=await(write?reads.send(input,{signal:innerSignal,onDispatch:dispatched,onRejected:rejected}):reads.decide(input,{signal:innerSignal}));fresh();
      if(!exact(final,['decision','authority','recipientRead','roomPayload',...(write?['dispatch']:[])]))fail('backend_unavailable');
      ownerMatch(snap.row,{authority:final.authority,recipientRead:final.recipientRead});
      const d=final.decision;
      if(!exact(d,['kind','outcome','decisionId','tokenDigest','intentDigest','roomReadDigest','contextVersion','checkedAt','expiresAt'])||d.kind!=='hermes.group-room-preview.v1'||d.outcome!=='allow'||
        d.decisionId!==snap.binding.requestId||d.tokenDigest!==snap.tokenDigest||d.intentDigest!==captured.intentDigest||d.roomReadDigest!==captured.roomReadDigest||
        d.contextVersion!==snap.contextVersion||d.contextVersion!==final.authority.contextVersion||!positive(d.checkedAt)||d.checkedAt>now()||d.checkedAt<iso(captured.roomReadAt)||
        d.expiresAt!==final.authority.expiresAt||d.expiresAt<=now())fail('context_changed');
      const projected=projectAvailableRooms(final.roomPayload,{allowedBuildingIds:final.authority.allowedBuildingIds,offset:0,limit:100,readAt:iso(captured.roomReadAt)});
      if(hash(projected)!==captured.roomReadDigest)fail('context_changed');
      if(write){
        const dispatch=dispatchSnapshot(final.dispatch,snap.selected.conversationIds,true),expiresAt=iso(dispatch.expiresAt);
        if(dispatch.id!==snap.binding.requestId||expiresAt<=now()||expiresAt>now()+300000||expiresAt>Math.min(snap.expiresAt,snap.row.expiresAt))fail('backend_unavailable');
      }
      return freeze({decision:d,authority:final.authority,recipientRead:final.recipientRead,...(write?{dispatch:final.dispatch}:{})});
    });}catch(error){if(write&&uncertain)fail('send_outcome_unknown');throw error;}
  }
  return Object.freeze({
    prepare(token,rawIntent,options){return capture(token,intent(rawIntent),options);},
    prepareDirectory(token,options){return capture(token,null,options);},
    async finalizeStatus(token,receipt,dispatchId,{signal}={}){
      if(typeof reads.dispatchStatus!=='function')fail('tool_not_available');
      if(typeof token!=='string'||!TOKEN.test(token)||!id(dispatchId)||!issued.has(receipt))fail('context_changed');
      const snap=issued.get(receipt);issued.delete(receipt);
      if(hash(token)!==snap.tokenDigest||snap.selected!==null)fail('context_changed');
      return bounded(signal,timeoutMs,async(innerSignal,check)=>{
        const fresh=()=>{check();if(now()>=snap.deadline)fail('context_changed');};fresh();
        const checked=await authority.checkUnchanged(token,snap.before,{signal:innerSignal});fresh();if(checked!==undefined)fail('context_changed');
        const status=dispatchSnapshot(await reads.dispatchStatus({accessToken:snap.accessToken,dispatchId,...(!privateOrigin?{binding:snap.binding}:{})},{signal:innerSignal}));fresh();
        if(status.id!==dispatchId)fail('context_changed');
        // Status is owner-checked by SQL; the final directory also binds every
        // recipient to this connection's selected organization and bound bot.
        const final=await reads.directory({accessToken:snap.accessToken,binding:snap.binding},{signal:innerSignal});fresh();ownerMatch(snap.row,final);
        if(final.authority.contextVersion!==snap.contextVersion)fail('context_changed');
        return freeze({...final,dispatch:status});
      });
    },
    async finalizeDirectory(token,receipt,{signal}={}){
      if(typeof token!=='string'||!TOKEN.test(token)||!issued.has(receipt))fail('context_changed');
      const snap=issued.get(receipt);issued.delete(receipt);
      if(hash(token)!==snap.tokenDigest||snap.selected!==null)fail('context_changed');
      return bounded(signal,timeoutMs,async(innerSignal,check)=>{
        const fresh=()=>{check();if(now()>=snap.deadline)fail('context_changed');};fresh();
        const checked=await authority.checkUnchanged(token,snap.before,{signal:innerSignal});fresh();if(checked!==undefined)fail('context_changed');
        // The last await rereads the full claim, account, groups and read gate.
        const final=await reads.directory({accessToken:snap.accessToken,binding:snap.binding},{signal:innerSignal});fresh();ownerMatch(snap.row,final);
        if(final.authority.contextVersion!==snap.contextVersion)fail('context_changed');
        return freeze(final);
      });
    },
    finalize:(token,receipt,readBinding,options)=>settle(token,receipt,readBinding,options),
    dispatch:(token,receipt,readBinding,options)=>settle(token,receipt,readBinding,options,true),
  });
}
