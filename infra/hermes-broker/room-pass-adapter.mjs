import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { readWithBaseAuthorization } from './authorization-extension.mjs';
import { domainExact, domainId } from './domain-contract.mjs';
import { BrokerError } from './broker.mjs';
import { createHash } from 'node:crypto';
import { ROOM_PASS_ACTION, ROOM_PASS_UPSERT_OPERATIONS, roomPassInput, roomPassResult, mayUseRoomPass } from './room-pass-contract.mjs';
const positive=value=>Number.isSafeInteger(value)&&value>0;
const keys=['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion','expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision'];
export function createRoomPassReads(options){
  const rpc=createBoundUserRpcTransport({...options,allowedNames:['hermes_room_pass_action_v1','hermes_room_pass_capabilities_v1','hermes_room_pass_upsert_v1','hermes_room_pass_upsert_v2']});
  return Object.freeze({async capabilities({accessToken,organizationId},callOptions){
    if(!domainId(organizationId))throw new BrokerError('invalid_request');
    return rpc('hermes_room_pass_capabilities_v1',accessToken,{p_organization_id:organizationId},callOptions,{optional:true});
  },async execute(operation,value,callOptions){
    if(!domainExact(value,['accessToken','binding','input'])||!domainExact(value.binding,keys)||!domainId(value.binding.connectionId)||!domainId(value.binding.expectedMembershipId)||
      !/^[a-f0-9]{64}$/.test(value.binding.tokenDigest)||['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'].some(key=>!positive(value.binding[key]))||
      !(value.binding.expectedPolicyVersion===0||positive(value.binding.expectedPolicyVersion)))throw new BrokerError('invalid_request');
    let input;try{input=roomPassInput(operation,value.input);}catch{throw new BrokerError('invalid_request');}
    const args={p_binding:value.binding,p_operation:operation,p_input:input};
    // lookup/upsert go to hermes_room_pass_upsert_v2: the reviewed v1 decides
    // everything, v2 only adds the full contact phone for the private reply
    // (absent = PGRST202 => backend_unavailable, never a v1 write). status asks v2,
    // then v1 (receipts with the masked contact), then the applied action v1 for
    // set_active receipts when neither upsert RPC is deployed yet.
    if(ROOM_PASS_UPSERT_OPERATIONS.includes(operation))
      return rpc('hermes_room_pass_upsert_v2',value.accessToken,args,callOptions,{write:operation==='upsert'});
    if(operation==='status'){
      for(const name of ['hermes_room_pass_upsert_v2','hermes_room_pass_upsert_v1']){
        const reconciled=await rpc(name,value.accessToken,args,callOptions,{optional:true});
        if(reconciled!==null)return reconciled;
      }
    }
    return rpc('hermes_room_pass_action_v1',value.accessToken,args,callOptions,{write:operation==='set_active'});
  }});
}
export function createRoomPassAuth({baseAuth,reads}){
  if([baseAuth?.verifySession,baseAuth?.readAuthorization,reads?.capabilities].some(fn=>typeof fn!=='function'))throw new TypeError('invalid_room_pass_auth');
  return Object.freeze({verifySession:input=>baseAuth.verifySession(input),async readAuthorization(input){
    const extended=await readWithBaseAuthorization(baseAuth,input,()=>reads.capabilities({accessToken:input.accessToken,organizationId:input.organizationId},{signal:input.signal}));
    const current=extended.current;
    if(current.permissions.action.includes(ROOM_PASS_ACTION)||current.companyCeilings.action.includes(ROOM_PASS_ACTION))throw new BrokerError('context_changed');
    const cap=extended.capability();if(cap===null)return current;
    if(!domainExact(cap,['organizationId','userId','membershipId','authorizationVersion','isSuperadmin','policyVersion','allowed','companyEnabled','buildingIds'])||
      cap.organizationId!==input.organizationId||cap.userId!==input.userId||cap.membershipId!==current.membership.membershipId||cap.authorizationVersion!==current.membership.authorizationVersion||
      cap.isSuperadmin!==current.isSuperadmin||!(cap.policyVersion===0||positive(cap.policyVersion))||typeof cap.allowed!=='boolean'||typeof cap.companyEnabled!=='boolean'||
      cap.allowed&&!cap.companyEnabled||!Array.isArray(cap.buildingIds)||cap.buildingIds.length>256||cap.buildingIds.some(id=>!domainId(id))||new Set(cap.buildingIds).size!==cap.buildingIds.length||
      !cap.allowed&&cap.buildingIds.length)throw new BrokerError('context_changed');
    return{...current,permissions:{...current.permissions,action:[...current.permissions.action,...(cap.allowed?[ROOM_PASS_ACTION]:[])]},
      companyCeilings:{...current.companyCeilings,action:[...current.companyCeilings.action,...(cap.companyEnabled?[ROOM_PASS_ACTION]:[])]},
      scopesByPermission:{...current.scopesByPermission,...(cap.allowed?{[ROOM_PASS_ACTION]:{buildingIds:[...cap.buildingIds],cashbookIds:[]}}:{})},
      epoch:createHash('sha256').update(JSON.stringify({base:current.epoch,cap})).digest('hex')};
  }});
}
export function createRoomPassService({authority,connectionStore,crypto,auth,supabase,dependencyScope,fetch,clock=Date.now}={}){
  const reads=createRoomPassReads({...supabase,dependencyScope,fetch});
  const service=createBoundUserOperationService({authority,connectionStore,crypto,auth,reads,mayUse:mayUseRoomPass,validateInput:roomPassInput,validateResult:roomPassResult,clock});
  return Object.freeze({prepareRoomPass:service.prepare,finalizeRoomPass:service.finalize});
}
