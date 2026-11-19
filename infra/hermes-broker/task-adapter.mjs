import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { readWithBaseAuthorization } from './authorization-extension.mjs';
import { domainExact, domainId } from './domain-contract.mjs';
import { BrokerError } from './broker.mjs';
import { createHash } from 'node:crypto';
import { TASK_ACTION, taskInput, taskResult, mayUseTask } from './task-contract.mjs';
import { createTaskFollowReads, extendTaskFollowAuthorization } from './task-follow-adapter.mjs';
import { TASK_PROGRESS_ACTION, TASK_CANCEL_ACTION } from './task-follow-contract.mjs';
const positive=value=>Number.isSafeInteger(value)&&value>0;
const TASK_CREATE_ACTION_ID='task.create';
const FOLLOW_KEY_ACTIONS=Object.freeze([[TASK_PROGRESS_ACTION,'task.update'],[TASK_CANCEL_ACTION,'task.cancel']]);
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
// createFromActions (Đợt 2b, CV1): danh mục thao tác ghi dùng chung của connector có task.create. Khi task.create SỐNG phía SQL
// (live.has — review Mốc 2 mục 6) tasks.create do lớp khung chung cấp (phạm vi đã giao buildings.view) và lớp này chỉ thêm khoá theo
// dõi/tiến độ/huỷ; khi chưa (connector mới + DB cũ) lớp này cấp tasks.create như trước, nên tạo việc và theo dõi cũ không mất. Hai
// lớp cùng cấp một khoá là context_changed (rào bên dưới), nên mỗi lời gọi chỉ một nguồn. Capability cũ chỉ đọc (cùng đợt với lớp
// dưới) khi task.create chưa sống theo lần đọc quyền trước: DB mới không tốn thêm lời gọi; lần đầu sau khởi động (danh mục sống còn
// trống) đọc cả hai; DB vừa mất dòng task.create giữa hai lời gọi thì đọc bù tuần tự. live được lớp khung chung (baseAuth) ghi trong
// chính lời gọi này, trước khi quyết định bên dưới.
// actionIds (Mốc 3): mã các thao tác trong danh mục của connector. task.update / task.cancel có mặt VÀ sống ⇒ lớp khung chung là nguồn
// của tasks.edit / tasks.delete; lớp theo dõi thôi cấp hai khoá đó (skip), như tasks.create ở trên.
export function createTaskAuth({baseAuth,reads,createFromActions=false,actionIds=[],live}){
  if([baseAuth?.verifySession,baseAuth?.readAuthorization,reads?.capabilities].some(fn=>typeof fn!=='function')||typeof createFromActions!=='boolean'||
    !Array.isArray(actionIds)||actionIds.some(id=>typeof id!=='string')||(live!==undefined&&typeof live?.has!=='function'))throw new TypeError('invalid_task_auth');
  const fromActions=()=>createFromActions&&(live===undefined||live.has(TASK_CREATE_ACTION_ID));
  const skip=()=>FOLLOW_KEY_ACTIONS.filter(([,id])=>actionIds.includes(id)&&(live===undefined||live.has(id))).map(([key])=>key);
  return Object.freeze({verifySession:input=>baseAuth.verifySession(input),async readAuthorization(input){
    // Task and follow capability RPCs start in the same wave as the base chain.
    // The follow observation is still consulted (and its failure surfaced) only
    // after a present, valid task capability, exactly as before.
    const follows=typeof reads.followCapabilities==='function';
    const capabilityInput={accessToken:input.accessToken,organizationId:input.organizationId};
    const legacy=!fromActions();
    const reading=await readWithBaseAuthorization(baseAuth,input,async()=>{
      const [task,follow]=await Promise.allSettled([legacy?reads.capabilities(capabilityInput,{signal:input.signal}):undefined,
        follows?reads.followCapabilities(capabilityInput,{signal:input.signal}):undefined]);
      return {task,follow};
    });
    const current=reading.current;
    let {task,follow}=reading.capability();
    if(fromActions()){
      if(!follows)return current;
      if(follow.status==='rejected')throw follow.reason;
      return extendTaskFollowAuthorization(current,follow.value,input,{skip:skip()});
    }
    if(current.permissions.action.includes(TASK_ACTION)||current.companyCeilings.action.includes(TASK_ACTION))throw new BrokerError('context_changed');
    if(!legacy)[task]=await Promise.allSettled([reads.capabilities(capabilityInput,{signal:input.signal})]);
    if(task.status==='rejected')throw task.reason;
    const cap=task.value;if(cap===null)return current;
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
    if(!follows)return extended;
    if(follow.status==='rejected')throw follow.reason;
    return extendTaskFollowAuthorization(extended,follow.value,input,{skip:skip()});
  }});
}
export function createTaskService({authority,connectionStore,crypto,auth,supabase,dependencyScope,fetch,clock=Date.now}={}){
  const reads=createTaskReads({...supabase,dependencyScope,fetch});
  const service=createBoundUserOperationService({authority,connectionStore,crypto,auth,reads,mayUse:mayUseTask,validateInput:taskInput,validateResult:taskResult,clock});
  return Object.freeze({prepareTask:service.prepare,finalizeTask:service.finalize});
}
