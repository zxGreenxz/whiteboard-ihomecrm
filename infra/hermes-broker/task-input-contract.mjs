import { domainExact,domainId,EMPTY_RESULT_HINT } from './domain-contract.mjs';
import { TASK_ACTION,taskInput,mayUseTask } from './task-contract.mjs';
import { TASK_FOLLOW_TOOLS,taskFollowOperation,isTaskFollowOperation,mayUseTaskFollow,taskFollowInput } from './task-follow-contract.mjs';
const kinds=['buildings','rooms','jobTypes','assignees'];
// 22/10/2026 (câu 29): job types (company catalog) and assignees (company members) are not filtered by building; the
// SQL guard (20261021172540) answers them with buildingId null when the user holds tasks.create on at least one
// building of the connection scope. kind=rooms still needs the building.
const companyWide=['jobTypes','assignees'];
const fail=()=>{throw new TypeError('invalid_task_input_options');};
// Follow/progress/cancel join the same task tool family and broker dispatch.
export const taskActionOperation=name=>name==='crm_task_create'?'create':name==='crm_task_status'?'status':name==='crm_task_input_options'?'options':taskFollowOperation(name);
export const mayUseTaskAction=(effective,operation)=>operation==='options'?effective?.action?.includes(TASK_ACTION)===true:
 isTaskFollowOperation(operation)?mayUseTaskFollow(effective,operation):mayUseTask(effective,operation);
export function taskActionInput(operation,input){
 if(isTaskFollowOperation(operation))return taskFollowInput(operation,input);
 if(operation!=='options')return taskInput(operation,input);
 if(!domainExact(input,['kind','buildingId','query','limit','cursor'])||!kinds.includes(input.kind)||
  (input.kind==='buildings'?!(input.buildingId===null||typeof input.buildingId==='string'):
   companyWide.includes(input.kind)?!(input.buildingId===null||domainId(input.buildingId)):!domainId(input.buildingId))||
  typeof input.query!=='string'||[...input.query].length>100||input.query.includes('\0')||
  !Number.isSafeInteger(input.limit)||input.limit<1||input.limit>50||!(input.cursor===null||domainId(input.cursor)))fail();
 // kind=buildings has no parent: any string the model puts there (16/10: the
 // company organizationId) is dropped to the null that SQL and the result check require.
 return input.kind==='buildings'?{...input,buildingId:null}:{...input};
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
// 22/10/2026 (TEST 21/10, bot thật): Hermes tạm khoá CẢ MCP server ~59 s sau ba kết quả isError liền nhau, nên lời gọi
// crm_task_input_options sai cách không trả lỗi trơn mà trả MỘT câu hướng dẫn tĩnh trong danh sách đóng này, dưới dạng
// kết quả thường (isError false, ok:false; broker.mjs). Chuỗi không bao giờ chứa giá trị đã gửi — chỉ nêu tham số đúng —
// và không có items: mô hình không thể đọc nhầm thành "danh mục rỗng". Không thay đổi một byte tools/list.
export const TASK_OPTIONS_HINTS=Object.freeze({
 kind:'kind là một trong: buildings, rooms, jobTypes, assignees.',
 rooms:'kind=rooms cần buildingId: gọi kind=buildings trước rồi truyền id toà vào buildingId.',
 buildingId:'buildingId là UUID toà từ kind=buildings, không phải tên/mã toà; jobTypes, assignees bỏ trống buildingId được.',
 input:'crm_task_input_options chỉ nhận: kind, buildingId (bắt buộc với rooms), query (tên, ≤100 ký tự), limit 1-50, cursor (nextCursor hoặc bỏ trống).',
 // Connector chạy trước migration 20261021172540: SQL v5 từ chối jobTypes/assignees thiếu buildingId bằng 22023.
 legacy:'CRM chưa tra được jobTypes/assignees khi thiếu buildingId: gọi kind=buildings trước rồi truyền buildingId.',
});
export const TASK_OPTIONS_HINT_TEXTS=Object.freeze(Object.values(TASK_OPTIONS_HINTS));
const plain=value=>value!==null&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
// Data value of an own key; an accessor is never invoked (arguments may carry getters).
const own=(value,key)=>{const descriptor=Object.hasOwn(value,key)?Object.getOwnPropertyDescriptor(value,key):undefined;
 return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;};
/** Static hint for options arguments the validator refused (already normalized: blank/nil UUID → null), or null for a
 * non-object (plain invalid_request). Pure; never throws. */
export function taskOptionsHint(args){
 try{
  if(!plain(args))return null;
  const kind=own(args,'kind'),building=own(args,'buildingId');
  if(!kinds.includes(kind))return TASK_OPTIONS_HINTS.kind;
  if(kind==='rooms'&&!domainId(building))return TASK_OPTIONS_HINTS.rooms;
  if(kind!=='buildings'&&building!==null&&!domainId(building))return TASK_OPTIONS_HINTS.buildingId;
  return TASK_OPTIONS_HINTS.input;
 }catch{return null;}
}
/** The validated company-wide lookup that SQL before 20261021172540 refuses with 22023 (invalid_request). */
export const taskOptionsCompanyWide=(operation,input)=>operation==='options'&&input?.buildingId===null&&companyWide.includes(input?.kind);
/** Ordinary tool payload for a refused lookup: nothing was read, the hint names the right call. */
export function taskOptionsRetry(hint){
 if(!TASK_OPTIONS_HINT_TEXTS.includes(hint))fail();
 return {ok:false,code:'invalid_request',huongDan:hint};
}
export const TASK_INPUT_TOOLS=Object.freeze([{name:'crm_task_input_options',description:'Task assign IDs: buildings, rooms, jobTypes, assignees. Chỉ kind=rooms cần buildingId (id toà từ kind=buildings); jobTypes, assignees là danh mục công ty, bỏ trống buildingId. Chỉ trả danh mục người dùng được chọn theo RLS, không đọc công việc hay liên hệ. '+EMPTY_RESULT_HINT,
 inputSchema:{type:'object',additionalProperties:false,required:['kind','buildingId','query','limit','cursor'],properties:{kind:{enum:kinds},buildingId:{type:['string','null'],format:'uuid',description:'Chỉ kind=rooms (bắt buộc): id toà từ kind=buildings, không phải ID công ty.'},query:{type:'string',maxLength:100,description:'Lọc theo tên; để trống để xem tất cả.'},limit:{type:'integer',minimum:1,maximum:50},cursor:{type:['string','null'],format:'uuid'}}},
 annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},...TASK_FOLLOW_TOOLS]);
