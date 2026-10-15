import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { createTaskService } from './task-adapter.mjs';
import { taskActionInput,taskOptionsResult,mayUseTaskAction } from './task-input-contract.mjs';
import { BrokerError } from './broker.mjs';
import { createTaskFollowService } from './task-follow-adapter.mjs';
import { isTaskFollowOperation } from './task-follow-contract.mjs';
export function createTaskServiceWithOptions(options){
 const core=createTaskService(options),rpc=createBoundUserRpcTransport({...options.supabase,fetch:options.fetch,dependencyScope:options.dependencyScope,allowedNames:['hermes_task_input_options_v1']});
 const metadata=createBoundUserOperationService({...options,mayUse:mayUseTaskAction,validateInput:taskActionInput,validateResult:taskOptionsResult,
  reads:{execute(operation,value,callOptions){
   if(operation!=='options')throw new BrokerError('invalid_request');
   const input=taskActionInput(operation,value.input);
   return rpc('hermes_task_input_options_v1',value.accessToken,{p_binding:value.binding,p_input:input},callOptions);
  }}});
 const follow=createTaskFollowService(options);
 const issued=new WeakMap();
 return Object.freeze({async prepareTask(token,operation,input,callOptions){
  const kind=operation==='options'?'metadata':isTaskFollowOperation(operation)?'follow':'core';
  const receipt=await(kind==='metadata'?metadata.prepare(token,operation,input,callOptions):
   kind==='follow'?follow.prepareFollow(token,operation,input,callOptions):core.prepareTask(token,operation,input,callOptions));
  issued.set(receipt,kind);return receipt;
 },async finalizeTask(token,receipt,callOptions){
  if(!issued.has(receipt))throw new BrokerError('context_changed');const kind=issued.get(receipt);issued.delete(receipt);
  return kind==='metadata'?metadata.finalize(token,receipt,callOptions):kind==='follow'?follow.finalizeFollow(token,receipt,callOptions):core.finalizeTask(token,receipt,callOptions);
 }});
}
