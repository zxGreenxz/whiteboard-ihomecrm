import {z} from 'zod';
import {persistentFinancialWorkflow} from './persistentFinancialWorkflow';
import {financialPending,FinancialPendingStorageError} from './financialPending';
import {FinancialWorkflowError,isConfirmedFinancialRejection,type FinancialWorkflowProgress} from './financialWorkflow';
import {friendlyError} from './friendlyError';
import {confirmedRecordId} from './recordWriteOutcome';
import type {ContractImportRow} from './contractExcelHelpers';
const namespace='contract-excel-import';
const importErrorMessage=(error:unknown,operation:string)=>{const feedback=friendlyError(error,`Chưa ${operation}.`,{operation});return `${feedback.title} ${feedback.description}`;};
const rowSchema=z.object({sourceRow:z.number().int().positive(),fingerprint:z.string(),stage:z.enum(['ready','customer','contract','relations','room','completed','rejected','unknown','partial','not-sent']),customerId:z.string().optional(),customerCreated:z.boolean().optional(),contractId:z.string().optional(),roomId:z.string().optional(),message:z.string().optional()});
const snapshotSchema=z.object({userId:z.string(),organizationId:z.string(),buildingId:z.string(),attemptId:z.string(),rows:z.array(rowSchema)});
export type ContractImportProgressRow=z.infer<typeof rowSchema>;
type Snapshot=z.infer<typeof snapshotSchema>;
export interface ContractImportScope {userId:string;organizationId:string;buildingId:string}
export interface ContractImportReport {buildingId:string;success:number;failed:number;errors:{row:number;message:string}[];createdIds:{row:number;id:string}[];customerIds:{row:number;id:string}[];pending:boolean;canCorrect:boolean;message?:string}
export interface ContractImportSteps {
 customer:(row:ContractImportRow,priorId?:string)=>Promise<{id:string;created:boolean}>;
 contract:(row:ContractImportRow,customerId:string)=>Promise<{id:string;roomId:string}>;
 link:(contractId:string,customerId:string)=>Promise<void>;
 occupy:(roomId:string)=>Promise<void>;
 verify:(row:ContractImportProgressRow,input?:ContractImportRow)=>Promise<boolean>;
 verifyCustomer:(id:string,input:ContractImportRow)=>Promise<boolean>;
}
const key=(scope:Pick<ContractImportScope,'userId'|'organizationId'>)=>`ihome:contract-import-progress:v1:${scope.userId}:${scope.organizationId}`;
const pendingScope=(scope:Pick<ContractImportScope,'userId'|'organizationId'>)=>({namespace,userId:scope.userId,organizationId:scope.organizationId,businessKey:'batch'});
function readSnapshot(scope:Pick<ContractImportScope,'userId'|'organizationId'>):Snapshot|null {
 try{const raw=localStorage.getItem(key(scope));if(!raw)return null;const parsed=snapshotSchema.parse(JSON.parse(raw));if(parsed.userId!==scope.userId||parsed.organizationId!==scope.organizationId)throw new Error();return parsed;}catch{throw new FinancialPendingStorageError();}
}
function save(scope:ContractImportScope,snapshot:Snapshot){try{localStorage.setItem(key(scope),JSON.stringify(snapshot));}catch{throw new FinancialPendingStorageError();}}
function remove(scope:ContractImportScope){try{localStorage.removeItem(key(scope));}catch{throw new FinancialPendingStorageError();}}
function report(snapshot:Snapshot,pending=true):ContractImportReport {
 const unfinished=snapshot.rows.filter(row=>row.stage!=='completed');
 return {buildingId:snapshot.buildingId,success:snapshot.rows.length-unfinished.length,failed:unfinished.length,errors:unfinished.map(row=>({row:row.sourceRow,message:row.message??'Dòng này chưa được gửi; sửa dòng bị từ chối trước khi tiếp tục.'})),createdIds:snapshot.rows.flatMap(row=>row.contractId?[{row:row.sourceRow,id:row.contractId}]:[]),customerIds:snapshot.rows.flatMap(row=>row.customerCreated&&row.customerId?[{row:row.sourceRow,id:row.customerId}]:[]),pending,canCorrect:unfinished.every(row=>['rejected','not-sent','ready'].includes(row.stage))};
}
export function readContractImportPending(scope:Pick<ContractImportScope,'userId'|'organizationId'>):ContractImportReport|null {
 const pending=financialPending.read(pendingScope(scope));if(!pending)return null;
 const snapshot=readSnapshot(scope);if(!snapshot||snapshot.attemptId!==(pending.requestKey??pending.attemptId))throw new FinancialPendingStorageError();
 return {...report(snapshot),message:'Lượt nhập trước chưa hoàn tất. Giữ các mã và dòng đã tạo để đối chiếu; không nhập lại toàn bộ file.'};
}
async function fingerprint(row:ContractImportRow){
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([row.room_name,row.customer_name,row.customer_phone,row.customer_id_number??null,row.signed_date,row.start_date,row.end_date,row.rent_price,row.payment_cycle,row.deposit,row.notes??null])));
 return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** Direct INSERTs have no backend retry key. Keep real row outcomes; never infer rollback from absence. */
export async function importContractBatch(rows:ContractImportRow[],scope:ContractImportScope,steps:ContractImportSteps,onResult:(report:ContractImportReport)=>void):Promise<ContractImportReport> {
 if(!rows.length||rows.some(row=>!Number.isInteger(row.source_row)||Number(row.source_row)<1)||new Set(rows.map(row=>row.source_row)).size!==rows.length)throw new FinancialWorkflowError('Chưa xác định được dòng Excel gốc. Đọc lại file trước khi nhập.','failure',[]);
 const fingerprints=await Promise.all(rows.map(fingerprint));let latest:ContractImportReport|undefined;
 const publish=(snapshot:Snapshot)=>{latest=report(snapshot);onResult(latest);};
 const execute=async(snapshot:Snapshot,progress:FinancialWorkflowProgress)=>{
  save(scope,snapshot);
  for(let index=0;index<rows.length;index++){
   const input=rows[index],entry=snapshot.rows.find(row=>row.sourceRow===input.source_row)!;
   if(entry.stage==='completed')continue;
   entry.message=undefined;entry.fingerprint=fingerprints[index];
   try{
    progress.stage=`khách hàng dòng ${entry.sourceRow}`;entry.stage='customer';save(scope,snapshot);
    const customer=await steps.customer(input,entry.customerId);entry.customerId=confirmedRecordId(customer,'tạo khách nhập');entry.customerCreated=entry.customerCreated||customer.created;
    if(customer.created)progress.completed.push({id:customer.id,label:`Khách đã tạo từ dòng ${entry.sourceRow}`});save(scope,snapshot);
    progress.stage=`hợp đồng dòng ${entry.sourceRow}`;entry.stage='contract';save(scope,snapshot);
    const contract=await steps.contract(input,customer.id);entry.contractId=confirmedRecordId(contract,'tạo hợp đồng nhập');entry.roomId=contract.roomId;
    progress.completed.push({id:entry.contractId,label:`Hợp đồng đã tạo từ dòng ${entry.sourceRow}`});save(scope,snapshot);
    progress.stage=`liên kết khách dòng ${entry.sourceRow}`;entry.stage='relations';save(scope,snapshot);await steps.link(contract.id,customer.id);
    progress.stage=`cập nhật phòng dòng ${entry.sourceRow}`;entry.stage='room';save(scope,snapshot);await steps.occupy(contract.roomId);
    if(!await steps.verify(entry,input))throw new TypeError('Chưa xác nhận đầy đủ hợp đồng và liên kết đã tạo.');
    entry.stage='completed';save(scope,snapshot);publish(snapshot);
   }catch(error){
    entry.stage=entry.contractId?'partial':isConfirmedFinancialRejection(error)?'rejected':'unknown';entry.message=importErrorMessage(error,`nhập hợp đồng dòng ${entry.sourceRow}`);save(scope,snapshot);publish(snapshot);
    if(entry.stage!=='rejected')break;
   }
  }
  for(const entry of snapshot.rows)if(['ready','customer','contract','relations','room'].includes(entry.stage))entry.stage='not-sent';
  save(scope,snapshot);publish(snapshot);
  if(snapshot.rows.some(row=>row.stage!=='completed'))throw new FinancialWorkflowError('Lượt nhập có dòng chưa hoàn tất. Giữ các mã và đối chiếu dòng đã tạo; không nhập lại toàn bộ file.',progress.completed.length?'partial':snapshot.rows.some(row=>['unknown','partial'].includes(row.stage))?'unknown':'failure',progress.completed);
  return report(snapshot,false);
 };
 try{
  const result=await persistentFinancialWorkflow(namespace).run('batch','nhập hợp đồng từ Excel',progress=>execute({...scope,attemptId:progress.requestKey,rows:rows.map((row,index)=>({sourceRow:row.source_row!,fingerprint:fingerprints[index],stage:'ready'}))},progress),async(pending,progress)=>{
   const snapshot=readSnapshot(scope);if(!snapshot||snapshot.attemptId!==(pending.requestKey??pending.attemptId)||snapshot.buildingId!==scope.buildingId)return null;
   for(const entry of snapshot.rows){
    const input=rows.find(row=>row.source_row===entry.sourceRow);
    if(entry.contractId){if(!await steps.verify(entry,input))return null;entry.stage='completed';}
    else if(['unknown','partial','customer','contract','relations','room'].includes(entry.stage))return null;
    if(entry.customerCreated&&entry.customerId&&input&&!await steps.verifyCustomer(entry.customerId,input))return null;
   }
   for(let index=0;index<rows.length;index++){
    const entry=snapshot.rows.find(row=>row.sourceRow===rows[index].source_row);
    if(!entry||entry.stage==='completed'&&entry.fingerprint!==fingerprints[index])return null;
   }
   save(scope,snapshot);publish(snapshot);return {result:await execute(snapshot,progress)};
  },scope.organizationId);
  remove(scope);onResult(result);return result;
 }catch(error){
  if(latest){const hasIds=latest.createdIds.length>0||latest.customerIds.length>0;if(!hasIds&&latest.canCorrect){remove(scope);latest.pending=false;}
   latest.message=importErrorMessage(error,'nhập hợp đồng từ Excel');onResult(latest);return latest;
  }
  const prior=readContractImportPending(scope);if(prior){prior.message=importErrorMessage(error,'nhập hợp đồng từ Excel');onResult(prior);return prior;}
  throw error;
 }
}
