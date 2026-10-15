import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { createTaskService } from './task-adapter.mjs';
import { taskActionInput,taskOptionsResult,mayUseTaskAction } from './task-input-contract.mjs';
import { BrokerError } from './broker.mjs';
export function createTaskServiceWithOptions(options){
 const core=createTaskService(options),rpc=createBoundUserRpcTransport({...options.supabase,fetch:options.fetch,dependencyScope:options.dependencyScope,allowedNames:['hermes_task_input_options_v1']});
 const metadata=createBoundUserOperationService({...options,mayUse:mayUseTaskAction,validateInput:taskActionInput,validateResult:taskOptionsResult,
  reads:{execute(operation,value,callOptions){
   if(operation!=='options')throw new BrokerError('invalid_request');
   const input=taskActionInput(operation,value.input);
   return rpc('hermes_task_input_options_v1',value.accessToken,{p_binding:value.binding,p_input:input},callOptions);
  }}});
 const issued=new WeakMap();
 return Object.freeze({async prepareTask(token,operation,input,callOptions){
  const isMetadata=operation==='options',receipt=await(isMetadata?metadata.prepare(token,operation,input,callOptions):core.prepareTask(token,operation,input,callOptions));
  issued.set(receipt,isMetadata);return receipt;
 },async finalizeTask(token,receipt,callOptions){
  if(!issued.has(receipt))throw new BrokerError('context_changed');const isMetadata=issued.get(receipt);issued.delete(receipt);
  return isMetadata?metadata.finalize(token,receipt,callOptions):core.finalizeTask(token,receipt,callOptions);
 }});
}
