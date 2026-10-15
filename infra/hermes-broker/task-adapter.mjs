import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { domainExact, domainId } from './domain-contract.mjs';
import { BrokerError } from './broker.mjs';
import { createHash } from 'node:crypto';
import { TASK_ACTION, taskInput, taskResult, mayUseTask } from './task-contract.mjs';
import { createTaskFollowReads, extendTaskFollowAuthorization } from './task-follow-adapter.mjs';
const positive=value=>Number.isSafeInteger(value)&&value>0;
const keys=['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion','expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision'];
export function createTaskReads(options){
  const rpc=createBoundUserRpcTransport({...options,allowedNames:['hermes_task_create_action_v1','hermes_task_create_capabilities_v1']});
  const follow=createTaskFollowReads(options);
  return Object.freeze({followCapabilities:follow.capabilities,async capabilities({accessToken,organizationId},callOptions){
    if(!domainId(organizationId))throw new BrokerError('invalid_request');
    return rpc('hermes_task_create_capabilities_v1',accessToken,{p_organization_id:organizationId},callOptions,{optional:true});
  },async execute(operation,value,callOptions){
    if(!domainExact(value,['accessToken','binding','input'])||!domainExact(value.binding,keys)||!domainId(value.binding.connectionId)||!domainId(value.binding.expectedMembershipId)||
      !/^[a-f0-9]{64}$/.test(value.binding.tokenDigest)||['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'].some(key=>!positive(value.binding[key]))||
      !(value.binding.expectedPolicyVersion===0||positive(value.binding.expectedPolicyVersion)))throw new BrokerError('invalid_request');
    let input;try{input=taskInput(operation,value.input);}catch{throw new BrokerError('invalid_request');}
    return rpc('hermes_task_create_action_v1',value.accessToken,{p_binding:value.binding,p_operation:operation,p_input:input},callOptions,{write:operation==='create'});
  }});
}
export function createTaskAuth({baseAuth,reads}){
  if([baseAuth?.verifySession,baseAuth?.readAuthorization,reads?.capabilities].some(fn=>typeof fn!=='function'))throw new TypeError('invalid_task_auth');
  return Object.freeze({verifySession:input=>baseAuth.verifySession(input),async readAuthorization(input){
    const current=await baseAuth.readAuthorization(input);
    if(current.permissions.action.includes(TASK_ACTION)||current.companyCeilings.action.includes(TASK_ACTION))throw new BrokerError('context_changed');
    const cap=await reads.capabilities({accessToken:input.accessToken,organizationId:input.organizationId},{signal:input.signal});if(cap===null)return current;
    if(!domainExact(cap,['organizationId','userId','membershipId','authorizationVersion','isSuperadmin','policyVersion','allowed','companyEnabled','buildingIds'])||
      cap.organizationId!==input.organizationId||cap.userId!==input.userId||cap.membershipId!==current.membership.membershipId||cap.authorizationVersion!==current.membership.authorizationVersion||
      cap.isSuperadmin!==current.isSuperadmin||!(cap.policyVersion===0||positive(cap.policyVersion))||typeof cap.allowed!=='boolean'||typeof cap.companyEnabled!=='boolean'||
      cap.allowed&&!cap.companyEnabled||!Array.isArray(cap.buildingIds)||cap.buildingIds.length>256||cap.buildingIds.some(id=>!domainId(id))||new Set(cap.buildingIds).size!==cap.buildingIds.length||
      !cap.allowed&&cap.buildingIds.length)throw new BrokerError('context_changed');
    const extended={...current,permissions:{...current.permissions,action:[...current.permissions.action,...(cap.allowed?[TASK_ACTION]:[])]},
      companyCeilings:{...current.companyCeilings,action:[...current.companyCeilings.action,...(cap.companyEnabled?[TASK_ACTION]:[])]},
      scopesByPermission:{...current.scopesByPermission,...(cap.allowed?{[TASK_ACTION]:{buildingIds:[...cap.buildingIds],cashbookIds:[]}}:{})},
      epoch:createHash('sha256').update(JSON.stringify({base:current.epoch,cap})).digest('hex')};
    // Follow/progress/cancel and supervision ride on the task SQL family: when
    // the task RPC above is absent, their optional RPC is never consulted.
    if(typeof reads.followCapabilities!=='function')return extended;
    return extendTaskFollowAuthorization(extended,await reads.followCapabilities({accessToken:input.accessToken,organizationId:input.organizationId},{signal:input.signal}),input);
  }});
}
export function createTaskService({authority,connectionStore,crypto,auth,supabase,dependencyScope,fetch,clock=Date.now}={}){
  const reads=createTaskReads({...supabase,dependencyScope,fetch});
  const service=createBoundUserOperationService({authority,connectionStore,crypto,auth,reads,mayUse:mayUseTask,validateInput:taskInput,validateResult:taskResult,clock});
  return Object.freeze({prepareTask:service.prepare,finalizeTask:service.finalize});
}
