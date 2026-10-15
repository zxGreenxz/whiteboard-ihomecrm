import { domainExact,domainId } from './domain-contract.mjs';
import { TASK_ACTION,taskInput,mayUseTask } from './task-contract.mjs';
import { TASK_FOLLOW_TOOLS,taskFollowOperation,isTaskFollowOperation,mayUseTaskFollow,taskFollowInput } from './task-follow-contract.mjs';
const kinds=['buildings','rooms','jobTypes','assignees'];
const fail=()=>{throw new TypeError('invalid_task_input_options');};
// Follow/progress/cancel join the same task tool family and broker dispatch.
export const taskActionOperation=name=>name==='crm_task_create'?'create':name==='crm_task_status'?'status':name==='crm_task_input_options'?'options':taskFollowOperation(name);
export const mayUseTaskAction=(effective,operation)=>operation==='options'?effective?.action?.includes(TASK_ACTION)===true:
 isTaskFollowOperation(operation)?mayUseTaskFollow(effective,operation):mayUseTask(effective,operation);
export function taskActionInput(operation,input){
 if(isTaskFollowOperation(operation))return taskFollowInput(operation,input);
 if(operation!=='options')return taskInput(operation,input);
 if(!domainExact(input,['kind','buildingId','query','limit','cursor'])||!kinds.includes(input.kind)||
  (input.kind==='buildings'?input.buildingId!==null:!domainId(input.buildingId))||
  typeof input.query!=='string'||[...input.query].length>100||input.query.includes('\0')||
  !Number.isSafeInteger(input.limit)||input.limit<1||input.limit>50||!(input.cursor===null||domainId(input.cursor)))fail();
 return {...input};
}
export function taskOptionsResult(operation,value,identity,input){
 if(operation!=='options'||!domainExact(value,['organizationId','kind','buildingId','items','nextCursor'])||value.organizationId!==identity.row.organizationId||
  value.kind!==input.kind||value.buildingId!==input.buildingId||!Array.isArray(value.items)||value.items.length>input.limit||!(value.nextCursor===null||domainId(value.nextCursor)))fail();
 for(const [index,item] of value.items.entries()){
  if(!domainExact(item,['id','label'])||!domainId(item.id)||typeof item.label!=='string'||item.label.length>500||item.label.includes('\0')||
   item.id<=(index?value.items[index-1].id:input.cursor??''))fail();
  if(input.kind==='buildings'&&Array.isArray(identity.scopesByPermission?.[TASK_ACTION]?.buildingIds)&&!identity.scopesByPermission[TASK_ACTION].buildingIds.includes(item.id))fail();
 }
 if(value.nextCursor!==null&&(value.items.length!==input.limit||value.nextCursor!==value.items.at(-1)?.id))fail();
 return structuredClone(value);
}
export const TASK_INPUT_TOOLS=Object.freeze([{name:'crm_task_input_options',description:'Tra ID và tên để tạo/giao công việc. Tra buildings trước; các loại rooms, jobTypes, assignees cần buildingId vừa chọn. Chỉ danh mục người dùng hiện tại được chọn theo RLS, không đọc công việc hay thông tin liên hệ.',
 inputSchema:{type:'object',additionalProperties:false,required:['kind','buildingId','query','limit','cursor'],properties:{kind:{enum:kinds},buildingId:{type:['string','null'],format:'uuid'},query:{type:'string',maxLength:100},limit:{type:'integer',minimum:1,maximum:50},cursor:{type:['string','null'],format:'uuid'}}},
 annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},...TASK_FOLLOW_TOOLS]);
