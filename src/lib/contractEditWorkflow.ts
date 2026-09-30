import {z} from 'zod';
import {getSessionUser} from './authSession';
import {FinancialWorkflowError,isConfirmedFinancialRejection} from './financialWorkflow';
import {FinancialPendingStorageError} from './financialPending';
import {readContractRelationSnapshot,sameContractCustomers,sameContractServices,type ContractRelationSnapshot} from './contractRelationReconcile';
import {supabase} from '@/integrations/supabase/client';
import {financialReadNumber} from './financialReadValidation';
import type {UpdateContractPayload} from '@/hooks/useContracts';

type RelationPhase='not-started'|'deleting'|'deleted'|'inserting'|'done'|'rejected';
type CorePhase='not-started'|'sending'|'done'|'rejected';
export interface ContractEditRequest extends ContractRelationSnapshot {contractId:string;updates:UpdateContractPayload;fieldsFingerprint:string}
export interface ContractEditJob extends ContractEditRequest {
 version:1;actorId:string;attemptId:string;organizationId:string;corePhase:CorePhase;customersPhase:RelationPhase;servicesPhase:RelationPhase;
 baseline:ContractRelationSnapshot;startedAt:string;
}
export interface ContractEditSnapshot extends ContractRelationSnapshot {contract:Record<string,unknown>&{id:string;organization_id?:string|null}}
export interface ContractRelationWriteProgress {skipDelete?:boolean;organizationId?:string;onPhase?:(phase:'deleting'|'deleted'|'inserting'|'done')=>void}
export interface ContractEditPorts {
 read:(contractId:string)=>Promise<ContractEditSnapshot>;
 update:(input:{id:string;updates:UpdateContractPayload;suppressSuccessToast:true})=>Promise<unknown>;
 customers:(input:{contractId:string;customers:ContractRelationSnapshot['customers']}&ContractRelationWriteProgress)=>Promise<unknown>;
 services:(input:{contractId:string;services:ContractRelationSnapshot['services']}&ContractRelationWriteProgress)=>Promise<unknown>;
 onJob?:(job:ContractEditJob|null)=>void;
}
const customer=z.object({customer_id:z.string().min(1),is_representative:z.boolean(),notes:z.string().nullable().optional()});
const service=z.object({service_id:z.string().min(1),unit_price:z.number().finite().nonnegative(),initial_reading:z.number().finite().nullable().optional()});
const relations=z.object({customers:z.array(customer),services:z.array(service)});
const updatesSchema=z.object({room_id:z.string().optional(),signed_date:z.string().optional(),start_date:z.string().optional(),end_date:z.string().optional(),rent_price:z.number().finite().nonnegative().optional(),total_deposit:z.number().finite().nonnegative().optional(),payment_cycle:z.enum(['MONTHLY','QUARTERLY','SEMI_ANNUAL','ANNUAL']).optional(),start_billing_date:z.string().nullable().optional(),end_billing_date:z.string().nullable().optional(),contract_template_id:z.string().nullable().optional(),invoice_template_id:z.string().nullable().optional(),notes:z.string().nullable().optional(),discounts:z.object({months:z.number().finite(),amount_per_month:z.number().finite()}).nullable().optional()}).strict();
const phase=z.enum(['not-started','deleting','deleted','inserting','done','rejected']);
const jobSchema=relations.extend({version:z.literal(1),actorId:z.string().min(1),attemptId:z.string().min(1),contractId:z.string().min(1),organizationId:z.string().min(1),fieldsFingerprint:z.string(),updates:updatesSchema,corePhase:z.enum(['not-started','sending','done','rejected']),customersPhase:phase,servicesPhase:phase,baseline:relations,startedAt:z.string().refine(value=>Number.isFinite(Date.parse(value)))});
const key=(actorId:string,id:string)=>`ihome:contract-edit-pending:v1:${encodeURIComponent(actorId)}:${encodeURIComponent(id)}`;
const active=new Set<string>();
function readJob(actorId:string,id:string):ContractEditJob|null {
 try {const raw=localStorage.getItem(key(actorId,id));if(raw===null)return null;const job=jobSchema.parse(JSON.parse(raw)) as ContractEditJob;if(job.actorId!==actorId||job.contractId!==id)throw new Error('scope');return job;}
 catch {throw new FinancialPendingStorageError();}
}
function saveJob(job:ContractEditJob){try{localStorage.setItem(key(job.actorId,job.contractId),JSON.stringify(job));}catch{throw new FinancialPendingStorageError();}}
export async function loadContractEditJob(contractId:string):Promise<ContractEditJob|null>{const actor=await getSessionUser();if(!actor)throw {code:'PGRST301'};return readJob(actor.id,contractId);}
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

/** UI invokes recovery explicitly. A mismatched read after an unknown write is never proof of rollback. */
export async function runContractEdit(request:ContractEditRequest,ports:ContractEditPorts):Promise<{contractId:string;fieldsFingerprint:string;customersFingerprint:string;servicesFingerprint:string}>{
 const actor=await getSessionUser();if(!actor)throw {code:'PGRST301'};const scope=key(actor.id,request.contractId);
 if(active.has(scope))throw new FinancialWorkflowError('Yêu cầu cập nhật hợp đồng đang được xử lý. Chờ kết quả trước khi tiếp tục.','unknown',[]);
 active.add(scope);let job:ContractEditJob|null=null;
 try {
  job=readJob(actor.id,request.contractId);ports.onJob?.(job);let actual:ContractEditSnapshot;
  try{actual=await ports.read(request.contractId);}catch(error){if(job)throw issue(job,'đọc dữ liệu hợp đồng/khách hàng/dịch vụ',error);throw error;}
  if(!actual.contract||actual.contract.id!==request.contractId)throw new TypeError('Chưa đọc được đúng hợp đồng.');
  if(!job){
   const parsed=updatesSchema.parse(request.updates) as UpdateContractPayload;const selected=relations.parse(request) as ContractRelationSnapshot;
   if(typeof actual.contract.organization_id!=='string'||!actual.contract.organization_id)throw new FinancialWorkflowError('Chưa đọc được tổ chức của hợp đồng. Tải lại hợp đồng trước khi cập nhật.','failure',[]);
   job={...request,...selected,updates:parsed,version:1,actorId:actor.id,attemptId:crypto.randomUUID(),organizationId:actual.contract.organization_id,corePhase:'not-started',customersPhase:'not-started',servicesPhase:'not-started',baseline:{customers:actual.customers,services:actual.services},startedAt:new Date().toISOString()};saveJob(job);
  } else if(actual.contract.organization_id!==job.organizationId)throw issue(job,'tổ chức đã thay đổi');
  ports.onJob?.(job);
  const current=job;
  const persist=()=>{saveJob(current);ports.onJob?.(current);};
  if(sameContractFields(actual.contract,current.updates))current.corePhase='done';
  else if(current.corePhase==='sending'||current.corePhase==='done')throw issue(current,'thông tin hợp đồng');
  else {
   current.corePhase='sending';persist();
   try{const receipt=await ports.update({id:current.contractId,updates:current.updates,suppressSuccessToast:true});
    if(!receipt||typeof receipt!=='object'||(receipt as {id?:unknown}).id!==current.contractId||!sameContractFields(receipt as Record<string,unknown>,current.updates))throw new TypeError('Chưa xác nhận được thông tin hợp đồng vừa cập nhật.');
    current.corePhase='done';persist();
   }catch(error){if(isConfirmedFinancialRejection(error)){
     // The first core writer was rejected by the server; no relation writer has started.
     try{localStorage.removeItem(scope);}catch{throw new FinancialPendingStorageError();}ports.onJob?.(null);job=null;throw error;
    }persist();throw issue(current,'thông tin hợp đồng',error);}
  }
  persist();
  actual=await ports.read(current.contractId);
  if(!sameContractFields(actual.contract,current.updates)||actual.contract.organization_id!==current.organizationId)throw issue(current,'thông tin hợp đồng đã thay đổi');
  for(const relation of ['customers','services'] as const){
   const phaseName=relation==='customers'?'customersPhase':'servicesPhase';
   // Type-safe branches keep each relation's distinct row shape.
   const desiredMatches=relation==='customers'?sameContractCustomers(actual.customers,current.customers):sameContractServices(actual.services,current.services);
   const unknownEmpty=actual[relation].length===0 && ['deleting','inserting'].includes(current[phaseName]);
   if(desiredMatches&&!unknownEmpty){current[phaseName]='done';persist();continue;}
   const relationPhase=current[phaseName];
   if(['deleting','inserting','done'].includes(relationPhase))throw issue(current,relation==='customers'?'khách hàng':'dịch vụ');
   if(relationPhase==='deleted'&&actual[relation].length)throw issue(current,'quan hệ đã có thay đổi khác');
   const baselineMatches=relation==='customers'?sameContractCustomers(actual.customers,current.baseline.customers):sameContractServices(actual.services,current.baseline.services);
   if((relationPhase==='not-started'||relationPhase==='rejected')&&!baselineMatches)throw issue(current,'quan hệ đã có thay đổi khác');
   const onPhase:ContractRelationWriteProgress['onPhase']=phase=>{current[phaseName]=phase;persist();};
   try{
    const common={contractId:current.contractId,organizationId:current.organizationId,skipDelete:relationPhase==='deleted',onPhase};
    if(relation==='customers')await ports.customers({...common,customers:current.customers});else await ports.services({...common,services:current.services});
    const confirmed=await ports.read(current.contractId);
    const matches=relation==='customers'?sameContractCustomers(confirmed.customers,current.customers):sameContractServices(confirmed.services,current.services);
    if(!matches)throw new TypeError('Chưa xác nhận được đầy đủ các dòng liên kết.');
    current[phaseName]='done';persist();actual=confirmed;
   }catch(error){if(isConfirmedFinancialRejection(error)){if(current[phaseName]==='inserting')current[phaseName]='deleted';else if(current[phaseName]==='deleting')current[phaseName]='rejected';}persist();throw issue(current,relation==='customers'?'khách hàng':'dịch vụ',error);}
  }
  const final=await ports.read(current.contractId);
  if(!sameContractFields(final.contract,current.updates)||!sameContractCustomers(final.customers,current.customers)||!sameContractServices(final.services,current.services))throw issue(current,'đối chiếu cuối');
  try{localStorage.removeItem(scope);}catch{throw new FinancialPendingStorageError();}ports.onJob?.(null);
  return {contractId:current.contractId,fieldsFingerprint:current.fieldsFingerprint,customersFingerprint:JSON.stringify(current.customers),servicesFingerprint:JSON.stringify(current.services)};
 }catch(error){if(job&&!(error instanceof FinancialWorkflowError))throw issue(job,'đọc/ghi dữ liệu liên quan',error);throw error;}finally{active.delete(scope);}
}
