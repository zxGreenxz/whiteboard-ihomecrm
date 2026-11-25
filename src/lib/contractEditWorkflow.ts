import {z} from 'zod';
import {getSessionUser} from './authSession';
import {FinancialWorkflowError,isConfirmedFinancialRejection} from './financialWorkflow';
import {FinancialPendingStorageError,pendingHasSettled,trackRunningAttempt,type FinancialPendingRecord,type FinancialPendingScope} from './financialPending';
import {pendingBlockMessage,pendingValve,type PendingValve,type PendingValveStore} from './pendingValve';
import {readContractRelationSnapshot,sameContractCustomers,sameContractServices,type ContractRelationSnapshot} from './contractRelationReconcile';
import {supabase} from '@/integrations/supabase/client';
import {financialReadNumber} from './financialReadValidation';
import type {UpdateContractPayload} from '@/hooks/useContracts';

// Kho dấu riêng của SỬA HỢP ĐỒNG (đợt 7 plan sửa khoá vĩnh viễn, cách A).
//
// Một lần sửa ghi ba phần: thông tin hợp đồng (đặt giá trị), khách của hợp đồng (đối chiếu nguyên tử với danh sách lúc mở
// form) và dịch vụ của hợp đồng (xoá rồi chèn lại). Dấu lưu giá trị ĐÍCH của cả ba phần cùng pha của từng phần. Trước đợt 7,
// một lần gửi chưa rõ kết quả mà đọc lại chưa khớp giá trị đích là khoá vĩnh viễn. Nay:
//   - thông tin hợp đồng chưa khớp ⇒ gửi lại ĐÚNG giá trị đã lưu trong dấu (đặt giá trị lặp lại cho cùng kết quả), CHỈ khi các
//     trường đó còn đúng như lúc tạo dấu (`before`); người khác đã đổi thì không ghi đè. Dấu bản trước không có `before`
//     nên chỉ còn hộp cảnh báo;
//   - dịch vụ / khách đang ghi dở (pha xoá / chèn) ⇒ đọc lại: còn nguyên như lúc mở form thì chạy lại cả phần, đã rỗng thì
//     chèn lại, khớp đích thì xong. Lệnh chèn cũ có thể còn đang chạy nên chỉ gửi lại sau 2 phút kể từ lần ghi cuối;
//   - máy chủ từ chối rõ ở bước đầu (hết phiên, không có quyền, khớp 0 dòng) ⇒ gỡ dấu, không để pha «đang gửi»;
//   - còn lại (người khác đã đổi hợp đồng / khách / dịch vụ, đổi tổ chức, đọc hỏng) ⇒ giữ dấu và báo hộp cảnh báo chung:
//     sau 2 phút người dùng tự gỡ được, có nhật ký. Không ghi đè thay đổi của người khác.
// Khoá lưu trữ giữ nguyên (`ihome:contract-edit-pending:v1:…`) để dấu đang kẹt của bản trước tự gỡ được ở lần bấm sau.

type RelationPhase='reconciling'|'not-started'|'deleting'|'deleted'|'inserting'|'done'|'rejected';
type CorePhase='not-started'|'sending'|'done'|'rejected';
export interface ContractEditRequest extends ContractRelationSnapshot {contractId:string;updates:UpdateContractPayload;fieldsFingerprint:string;expectedCustomers?:ContractRelationSnapshot['customers'];commissionChangeReason?:string}
export interface ContractEditJob extends ContractEditRequest {
 version:1;actorId:string;attemptId:string;organizationId:string;corePhase:CorePhase;customersPhase:RelationPhase;servicesPhase:RelationPhase;
 baseline:ContractRelationSnapshot;startedAt:string;
 /** Đợt 7: giờ một lệnh ghi được gửi gần nhất. Dấu bản trước không có thì tính từ `startedAt`. */
 activeAt?:string;
 /** Đợt 7: giá trị của đúng các trường trong `updates` đọc được ngay trước khi tạo dấu. Dấu bản trước không có. */
 before?:Record<string,unknown>;
}
export interface ContractEditSnapshot extends ContractRelationSnapshot {contract:Record<string,unknown>&{id:string;organization_id?:string|null}}
export interface ContractRelationWriteProgress {skipDelete?:boolean;organizationId?:string;expectedCustomers?:ContractRelationSnapshot['customers'];onPhase?:(phase:'reconciling'|'deleting'|'deleted'|'inserting'|'done')=>void}
export interface ContractEditPorts {
 read:(contractId:string)=>Promise<ContractEditSnapshot>;
 update:(input:{id:string;updates:UpdateContractPayload;suppressSuccessToast:true;commissionChangeReason?:string})=>Promise<unknown>;
 customers:(input:{contractId:string;customers:ContractRelationSnapshot['customers']}&ContractRelationWriteProgress)=>Promise<unknown>;
 services:(input:{contractId:string;services:ContractRelationSnapshot['services']}&ContractRelationWriteProgress)=>Promise<unknown>;
 onJob?:(job:ContractEditJob|null)=>void;
}
/** Test: đồng hồ và hộp cảnh báo giả. */
export interface ContractEditDeps {now?:()=>Date;valve?:Pick<PendingValve,'report'>}
const customer=z.object({customer_id:z.string().min(1),is_representative:z.boolean(),notes:z.string().nullable().optional()});
const service=z.object({service_id:z.string().min(1),unit_price:z.number().finite().nonnegative(),initial_reading:z.number().finite().nullable().optional()});
const relations=z.object({customers:z.array(customer),services:z.array(service)});
const updatesSchema=z.object({room_id:z.string().optional(),signed_date:z.string().optional(),start_date:z.string().optional(),end_date:z.string().optional(),rent_price:z.number().finite().nonnegative().optional(),total_deposit:z.number().finite().nonnegative().optional(),payment_cycle:z.enum(['MONTHLY','QUARTERLY','SEMI_ANNUAL','ANNUAL']).optional(),start_billing_date:z.string().nullable().optional(),end_billing_date:z.string().nullable().optional(),contract_template_id:z.string().nullable().optional(),invoice_template_id:z.string().nullable().optional(),notes:z.string().nullable().optional(),discounts:z.object({months:z.number().finite(),amount_per_month:z.number().finite()}).nullable().optional()}).strict();
const phase=z.enum(['reconciling','not-started','deleting','deleted','inserting','done','rejected']);
const isoTime=z.string().refine(value=>Number.isFinite(Date.parse(value)));
const jobSchema=relations.extend({version:z.literal(1),actorId:z.string().min(1),attemptId:z.string().min(1),contractId:z.string().min(1),organizationId:z.string().min(1),fieldsFingerprint:z.string(),updates:updatesSchema,commissionChangeReason:z.string().trim().min(8).max(2000).optional(),corePhase:z.enum(['not-started','sending','done','rejected']),customersPhase:phase,servicesPhase:phase,baseline:relations,startedAt:isoTime,activeAt:isoTime.optional(),before:z.record(z.string(),z.unknown()).optional()});
const key=(actorId:string,id:string)=>`ihome:contract-edit-pending:v1:${encodeURIComponent(actorId)}:${encodeURIComponent(id)}`;
const active=new Set<string>();
function readJob(actorId:string,id:string):ContractEditJob|null {
 try {const raw=localStorage.getItem(key(actorId,id));if(raw===null)return null;const job=jobSchema.parse(JSON.parse(raw)) as ContractEditJob;if(job.actorId!==actorId||job.contractId!==id)throw new Error('scope');return job;}
 catch {throw new FinancialPendingStorageError();}
}
function saveJob(job:ContractEditJob){try{localStorage.setItem(key(job.actorId,job.contractId),JSON.stringify(job));}catch{throw new FinancialPendingStorageError();}}
function removeJob(actorId:string,id:string){try{localStorage.removeItem(key(actorId,id));}catch{throw new FinancialPendingStorageError();}}
export async function loadContractEditJob(contractId:string):Promise<ContractEditJob|null>{const actor=await getSessionUser();if(!actor)throw {code:'PGRST301'};return readJob(actor.id,contractId);}

// ── Nối hộp cảnh báo chung (mục 6 «Cách dùng cho các đợt sau» của PR #480) ───────────────────────────────────────────────
export const CONTRACT_EDIT_NAMESPACE='contract-edit';
const OPERATION='cập nhật hợp đồng';
/** Dấu sửa hợp đồng dưới dạng chung để hộp cảnh báo hiển thị, ghi nhật ký và gỡ đúng lần gửi (khoá = attemptId). */
function asPending(job:ContractEditJob):FinancialPendingRecord {
 return {namespace:CONTRACT_EDIT_NAMESPACE,userId:job.actorId,organizationId:job.organizationId,businessKey:job.contractId,attemptId:job.attemptId,requestKey:job.attemptId,
  completedIds:job.corePhase==='done'?[job.contractId]:[],startedAt:job.startedAt,...(job.activeAt?{activeAt:job.activeAt}:{}),operation:OPERATION};
}
const ownJob=(scope:FinancialPendingScope)=>{
 if(scope.namespace!==CONTRACT_EDIT_NAMESPACE)return null;
 const job=readJob(scope.userId,scope.businessKey);
 return job&&job.organizationId===scope.organizationId?job:null;
};
/** Hai hàm hộp cảnh báo dùng để đọc lại và gỡ dấu sửa hợp đồng. */
export const contractEditValveStore:PendingValveStore={
 read:scope=>{const job=ownJob(scope);return job?asPending(job):null;},
 // Trả true CHỈ khi đã gỡ đúng dấu có attemptId đó; dấu đã là của lần gửi khác thì giữ nguyên.
 clearConfirmed:(scope,attemptId)=>{const job=ownJob(scope);if(!job||job.attemptId!==attemptId)return false;removeJob(job.actorId,job.contractId);return true;},
};

const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([name,item])=>[name,canonical(item)])):value;
export function sameContractFields(actual:Record<string,unknown>,expected:UpdateContractPayload):boolean {
 return Object.entries(expected).every(([field,value])=>{if(value===undefined)return true;const raw=actual[field];if(raw===undefined)return false;
  if(typeof value==='number'){try{return financialReadNumber(raw)===value;}catch{return false;}}
  if(/_date$/.test(field)&&typeof value==='string')return typeof raw==='string'&&raw.split('T')[0]===value.split('T')[0];
  return JSON.stringify(canonical(raw))===JSON.stringify(canonical(value));
 });
}
export async function readContractEditSnapshot(contractId:string):Promise<ContractEditSnapshot>{
 const [core,relationRows]=await Promise.all([supabase.from('contracts').select('*').eq('id',contractId).single(),readContractRelationSnapshot(contractId)]);
 if(core.error)throw core.error;if(!core.data||core.data.id!==contractId)throw new TypeError('Chưa đọc được đúng hợp đồng để đối chiếu.');
 return {...relationRows,contract:core.data as unknown as ContractEditSnapshot['contract']};
}
const issue=(job:ContractEditJob,part:string,cause?:unknown)=>new FinancialWorkflowError(`Hợp đồng ${job.contractId} chưa xác nhận xong phần ${part}. Tải lại và đối chiếu dữ liệu trước khi tiếp tục; không lưu lại toàn bộ hợp đồng.`,job.corePhase==='done'?'partial':'unknown',job.corePhase==='done'?[{id:job.contractId,label:`Đã lưu thông tin hợp đồng ${job.contractId}`}]:[],cause);
/** Phần quan hệ đang ghi dở, lệnh cũ có thể còn chạy: chưa đủ 2 phút kể từ lần ghi cuối thì chờ. */
class ContractEditWaitError extends FinancialWorkflowError {}

/** UI gọi lại thao tác này để hoàn tất lần sửa đang dở; mọi bước đều đọc lại máy chủ trước khi ghi. */
export async function runContractEdit(request:ContractEditRequest,ports:ContractEditPorts,deps:ContractEditDeps={}):Promise<{contractId:string;fieldsFingerprint:string;customersFingerprint:string;servicesFingerprint:string;confirmedCustomers:ContractRelationSnapshot['customers']}>{
 const now=deps.now??(()=>new Date());
 const actor=await getSessionUser();if(!actor)throw {code:'PGRST301'};const scope=key(actor.id,request.contractId);
 if(active.has(scope))throw new FinancialWorkflowError('Yêu cầu cập nhật hợp đồng đang được xử lý. Chờ kết quả trước khi tiếp tục.','unknown',[]);
 active.add(scope);let job:ContractEditJob|null=null;let recovering=false;let stopTracking:(()=>void)|undefined;
 try {
  job=readJob(actor.id,request.contractId);recovering=!!job;ports.onJob?.(job);let actual:ContractEditSnapshot;
  // Hộp cảnh báo không gỡ dấu của lượt còn đang chạy trong tab này (kể cả lúc đang đọc lần đầu).
  if(job)stopTracking=trackRunningAttempt(job.attemptId);
  try{actual=await ports.read(request.contractId);}catch(error){if(job)throw issue(job,'đọc dữ liệu hợp đồng/khách hàng/dịch vụ',error);throw error;}
  if(!actual.contract||actual.contract.id!==request.contractId)throw new TypeError('Chưa đọc được đúng hợp đồng.');
  if(!job){
   if(!request.expectedCustomers)throw new FinancialWorkflowError('Chưa đọc được danh sách khách hàng lúc mở form. Đóng và mở lại hợp đồng trước khi lưu.','failure',[]);
   const expectedCustomers=z.array(customer).parse(request.expectedCustomers);
   if(!sameContractCustomers(actual.customers,expectedCustomers as ContractRelationSnapshot['customers']))throw new FinancialWorkflowError('Danh sách khách hàng đã thay đổi từ lúc mở form. Đóng và mở lại hợp đồng để đối chiếu.','failure',[]);
   const parsed=updatesSchema.parse(request.updates) as UpdateContractPayload;const selected=relations.parse(request) as ContractRelationSnapshot;
   if(typeof actual.contract.organization_id!=='string'||!actual.contract.organization_id)throw new FinancialWorkflowError('Chưa đọc được tổ chức của hợp đồng. Tải lại hợp đồng trước khi cập nhật.','failure',[]);
   const before=Object.fromEntries(Object.entries(parsed).filter(([,value])=>value!==undefined).map(([field])=>[field,actual.contract[field]??null]));
   job={...request,...selected,updates:parsed,before,version:1,actorId:actor.id,attemptId:crypto.randomUUID(),organizationId:actual.contract.organization_id,corePhase:'not-started',customersPhase:'not-started',servicesPhase:'not-started',baseline:{customers:expectedCustomers as ContractRelationSnapshot['customers'],services:actual.services},startedAt:now().toISOString()};saveJob(job);
  } else if(actual.contract.organization_id!==job.organizationId)throw issue(job,'tổ chức đã thay đổi');
  ports.onJob?.(job);
  const current=job;
  if(!stopTracking)stopTracking=trackRunningAttempt(current.attemptId);
  /** Lưu pha mà không đổi đồng hồ: đọc lại thấy đã xong không phải là một lệnh ghi mới. */
  const persist=()=>{saveJob(current);ports.onJob?.(current);};
  /** Lưu pha của một lệnh ghi vừa gửi: đồng hồ 2 phút tính lại từ đây. */
  const touch=()=>{current.activeAt=now().toISOString();persist();};
  if(sameContractFields(actual.contract,current.updates))current.corePhase='done';
  // Đã xác nhận lưu ở lần trước mà nay khác: người khác đã sửa sau đó. Không ghi đè.
  else if(current.corePhase==='done')throw issue(current,'thông tin hợp đồng đã thay đổi sau lần lưu trước');
  // Lần bấm sau mà các trường không còn như lúc tạo dấu: người khác đã sửa (hoặc dấu bản trước không biết lúc đó ra sao).
  // Không ghi đè; giữ dấu và báo hộp cảnh báo.
  else if(recovering&&!(current.before&&sameContractFields(actual.contract,current.before as UpdateContractPayload)))throw issue(current,'thông tin hợp đồng đã được thay đổi ở nơi khác');
  else {
   // Cách A: chưa khớp giá trị đích (lần trước chưa ghi, hoặc chưa gửi) ⇒ gửi (lại) đúng giá trị đã lưu trong dấu.
   current.corePhase='sending';touch();
   try{const receipt=await ports.update({id:current.contractId,updates:current.updates,suppressSuccessToast:true,...(current.commissionChangeReason?{commissionChangeReason:current.commissionChangeReason}:{})});
    if(!receipt||typeof receipt!=='object'||(receipt as {id?:unknown}).id!==current.contractId||!sameContractFields(receipt as Record<string,unknown>,current.updates))throw new TypeError('Chưa xác nhận được thông tin hợp đồng vừa cập nhật.');
    current.corePhase='done';persist();
   }catch(error){if(isConfirmedFinancialRejection(error)){
     // Máy chủ từ chối rõ phần đầu tiên (hết phiên, không có quyền, khớp 0 dòng…): chưa phần nào được ghi, gỡ dấu.
     removeJob(actor.id,current.contractId);ports.onJob?.(null);job=null;throw error;
    }persist();throw issue(current,'thông tin hợp đồng',error);}
  }
  persist();
  actual=await ports.read(current.contractId);
  if(!sameContractFields(actual.contract,current.updates)||actual.contract.organization_id!==current.organizationId)throw issue(current,'thông tin hợp đồng đã thay đổi');
  for(const relation of ['customers','services'] as const){
   const phaseName=relation==='customers'?'customersPhase':'servicesPhase';
   const same=(rows:ContractEditSnapshot[typeof relation],target:ContractRelationSnapshot[typeof relation])=>relation==='customers'
    ?sameContractCustomers(rows as ContractRelationSnapshot['customers'],target as ContractRelationSnapshot['customers'])
    :sameContractServices(rows as ContractRelationSnapshot['services'],target as ContractRelationSnapshot['services']);
   if(same(actual[relation],current[relation])){current[phaseName]='done';persist();continue;}
   const relationPhase=current[phaseName];
   // Đã xác nhận xong ở lần trước mà nay khác đích: người khác đã đổi sau đó. Không ghi đè.
   if(relationPhase==='done')throw issue(current,relation==='customers'?'khách hàng':'dịch vụ');
   const empty=actual[relation].length===0;
   const atBaseline=same(actual[relation],current.baseline[relation]);
   let expectedCustomers:ContractRelationSnapshot['customers'];
   if(relationPhase==='deleting'||relationPhase==='inserting'||relationPhase==='deleted'){
    // Đang ghi dở. Chỉ hai trạng thái chứng minh được việc của mình: còn nguyên như lúc mở form, hoặc đã xoá hết.
    if(!empty&&!atBaseline)throw issue(current,'quan hệ đã có thay đổi khác');
    // Lệnh xoá / chèn cũ có thể vẫn đang chạy: chỉ gửi lại khi đã đủ 2 phút kể từ lần ghi cuối.
    const inFlight=relationPhase==='inserting'||(relationPhase==='deleting'&&!empty);
    if(inFlight&&!pendingHasSettled({startedAt:current.activeAt??current.startedAt},now()))throw new ContractEditWaitError(pendingBlockMessage(asPending(current),false),current.corePhase==='done'?'partial':'unknown',[]);
    expectedCustomers=empty?[]:current.baseline.customers;
   } else {
    if(!atBaseline)throw issue(current,'quan hệ đã có thay đổi khác');
    expectedCustomers=current.baseline.customers;
   }
   const onPhase:ContractRelationWriteProgress['onPhase']=phase=>{current[phaseName]=phase;touch();};
   try{
    const common={contractId:current.contractId,organizationId:current.organizationId,skipDelete:empty&&relationPhase!=='not-started'&&relationPhase!=='reconciling'&&relationPhase!=='rejected',onPhase};
    if(relation==='customers')await ports.customers({...common,expectedCustomers,customers:current.customers});else await ports.services({...common,services:current.services});
    const confirmed=await ports.read(current.contractId);
    if(!same(confirmed[relation],current[relation]))throw new TypeError('Chưa xác nhận được đầy đủ các dòng liên kết.');
    current[phaseName]='done';persist();actual=confirmed;
   }catch(error){if(isConfirmedFinancialRejection(error)){if(current[phaseName]==='inserting')current[phaseName]='deleted';else if(current[phaseName]==='deleting'||current[phaseName]==='reconciling')current[phaseName]='rejected';}persist();throw issue(current,relation==='customers'?'khách hàng':'dịch vụ',error);}
  }
  const final=await ports.read(current.contractId);
  if(!sameContractFields(final.contract,current.updates)||!sameContractCustomers(final.customers,current.customers)||!sameContractServices(final.services,current.services))throw issue(current,'đối chiếu cuối');
  removeJob(actor.id,current.contractId);ports.onJob?.(null);job=null;
  return {contractId:current.contractId,fieldsFingerprint:current.fieldsFingerprint,customersFingerprint:JSON.stringify(current.customers),servicesFingerprint:JSON.stringify(current.services),confirmedCustomers:current.customers};
 }catch(error){
  const feedback=job&&!(error instanceof FinancialWorkflowError)?issue(job,'đọc/ghi dữ liệu liên quan',error):error;
  // Lần bấm để hoàn tất một lần sửa đang dở mà vẫn chưa kết luận được: báo hộp cảnh báo chung (sau 2 phút người dùng tự
  // gỡ, có nhật ký). Lần gửi đầu tiên không báo, như lõi chung. Lời báo là kênh phụ: hỏng thì lỗi chính vẫn tới nơi gọi.
  stopTracking?.();
  if(recovering&&job){try{(deps.valve??pendingValve).report({pending:asPending(job),blockedOperation:OPERATION,store:contractEditValveStore});}catch{/* giữ lỗi chính */}}
  throw feedback;
 }finally{stopTracking?.();active.delete(scope);}
}
