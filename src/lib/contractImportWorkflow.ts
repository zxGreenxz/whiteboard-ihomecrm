import {z} from 'zod';
import {persistentFinancialWorkflow} from './persistentFinancialWorkflow';
import {financialPending,FinancialPendingStorageError} from './financialPending';
import {FinancialWorkflowError,isConfirmedFinancialRejection,type FinancialWorkflowProgress} from './financialWorkflow';
import {friendlyError} from './friendlyError';
import {confirmedRecordId} from './recordWriteOutcome';
import type {ContractImportRow} from './contractExcelHelpers';
// Nhập hợp đồng từ Excel (đợt 7, cách D). Mỗi dòng ghi thẳng bảng (khách → hợp đồng → liên kết → phòng), không có mã chống
// trùng phía máy chủ; nhưng production có `contracts_one_active_per_room_uq` (mỗi phòng một hợp đồng hiệu lực) và
// `contract_customers_unique` (hợp đồng, khách), nên:
//   - dòng chưa rõ kết quả: tra hợp đồng hiệu lực của phòng. Thấy và khớp đúng khách + nội dung dòng ⇒ của lần trước, làm
//     tiếp các bước sau; thấy mà không chứng minh được ⇒ báo «có thể của lần trước (mã …)», không nhập lại dòng đó; không
//     thấy ⇒ chạy lại dòng đó (ràng buộc theo phòng chặn hợp đồng thứ hai nếu lệnh cũ rốt cuộc tới sau);
//   - mỗi dòng độc lập: một dòng chưa rõ không dừng cả lượt;
//   - dấu «chờ đối chiếu» của lượt chỉ còn khi có dòng chưa rõ. Kết quả đã rõ (xong, bị từ chối, có thể của lần trước) nằm ở
//     ảnh chụp tiến độ; lượt sau bỏ qua dòng đã nhập đúng nội dung, không khoá gì.
const namespace='contract-excel-import';
const importErrorMessage=(error:unknown,operation:string)=>{const feedback=friendlyError(error,`Chưa ${operation}.`,{operation});return `${feedback.title} ${feedback.description}`;};
const STAGES=['ready','customer','contract','relations','room','completed','rejected','unknown','partial','not-sent','existing'] as const;
const rowSchema=z.object({sourceRow:z.number().int().positive(),fingerprint:z.string(),stage:z.enum(STAGES),customerId:z.string().optional(),customerCreated:z.boolean().optional(),contractId:z.string().optional(),roomId:z.string().optional(),message:z.string().optional()});
const snapshotSchema=z.object({userId:z.string(),organizationId:z.string(),buildingId:z.string(),attemptId:z.string(),rows:z.array(rowSchema)});
export type ContractImportProgressRow=z.infer<typeof rowSchema>;
type Snapshot=z.infer<typeof snapshotSchema>;
type Stage=ContractImportProgressRow['stage'];
/** Dòng mà kết quả lần ghi trước chưa rõ (kể cả lượt dừng giữa chừng vì đóng trang). */
const UNCERTAIN:readonly Stage[]=['unknown','partial','customer','contract','relations','room'];
/** Dòng đã có kết quả rõ, sửa file rồi nhập lại được. */
const SETTLED_UNFINISHED:readonly Stage[]=['rejected','not-sent','ready','existing'];
export interface ContractImportScope {userId:string;organizationId:string;buildingId:string}
export interface ContractImportReport {buildingId:string;success:number;failed:number;errors:{row:number;message:string}[];createdIds:{row:number;id:string}[];customerIds:{row:number;id:string}[];pending:boolean;canCorrect:boolean;message?:string}
/** Hợp đồng hiệu lực đang có của phòng ghi ở dòng Excel. `matches`: ngày và tiền khớp đúng dòng đó. */
export interface ActiveRoomContract {id:string;roomId:string;tenantId:string|null;matches:boolean}
export interface ContractImportSteps {
 customer:(row:ContractImportRow,priorId?:string)=>Promise<{id:string;created:boolean}>;
 contract:(row:ContractImportRow,customerId:string)=>Promise<{id:string;roomId:string}>;
 link:(contractId:string,customerId:string)=>Promise<void>;
 occupy:(roomId:string)=>Promise<void>;
 verify:(row:ContractImportProgressRow,input?:ContractImportRow)=>Promise<boolean>;
 verifyCustomer:(id:string,input:ContractImportRow)=>Promise<boolean>;
 /** Đợt 7: tra hợp đồng hiệu lực của phòng (`null` = đọc được mà không có). Đọc hỏng thì ném. */
 findActiveContract:(row:ContractImportRow)=>Promise<ActiveRoomContract|null>;
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
 return {buildingId:snapshot.buildingId,success:snapshot.rows.length-unfinished.length,failed:unfinished.length,errors:unfinished.map(row=>({row:row.sourceRow,message:row.message??'Dòng này chưa được gửi; sửa dòng bị từ chối trước khi tiếp tục.'})),createdIds:snapshot.rows.flatMap(row=>row.contractId?[{row:row.sourceRow,id:row.contractId}]:[]),customerIds:snapshot.rows.flatMap(row=>row.customerCreated&&row.customerId?[{row:row.sourceRow,id:row.customerId}]:[]),pending,canCorrect:unfinished.every(row=>SETTLED_UNFINISHED.includes(row.stage))};
}
export function readContractImportPending(scope:Pick<ContractImportScope,'userId'|'organizationId'>):ContractImportReport|null {
 const pending=financialPending.read(pendingScope(scope));if(!pending)return null;
 const snapshot=readSnapshot(scope);if(!snapshot||snapshot.attemptId!==(pending.requestKey??pending.attemptId))throw new FinancialPendingStorageError();
 return {...report(snapshot),message:'Lượt nhập trước còn dòng chưa rõ kết quả. Chọn lại đúng file rồi bấm nhập: hệ thống tra hợp đồng của từng dòng đó trước, dòng đã nhập không nhập lại.'};
}
async function fingerprint(row:ContractImportRow){
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([row.room_name,row.customer_name,row.customer_phone,row.customer_id_number??null,row.signed_date,row.start_date,row.end_date,row.rent_price,row.payment_cycle,row.deposit,row.notes??null])));
 return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
const isUniqueViolation=(error:unknown)=>!!error&&typeof error==='object'&&String((error as {code?:unknown}).code??'')==='23505';
const roomTakenMessage=(sourceRow:number,contractId:string)=>`Phòng của dòng ${sourceRow} đã có hợp đồng hiệu lực (mã ${contractId}), có thể là của lần nhập trước. Mở hợp đồng đó để kiểm tra; dòng này không nhập lại.`;
/** Phòng của dòng đã có hợp đồng hiệu lực không chứng minh được là của lần nhập này: kết quả rõ, không nhập lại dòng đó. */
class RoomTakenError extends Error {}
/** Direct INSERTs have no backend retry key: absence never proves rollback; the room's active contract does (unique index). */
export async function importContractBatch(rows:ContractImportRow[],scope:ContractImportScope,steps:ContractImportSteps,onResult:(report:ContractImportReport)=>void):Promise<ContractImportReport> {
 if(!rows.length||rows.some(row=>!Number.isInteger(row.source_row)||Number(row.source_row)<1)||new Set(rows.map(row=>row.source_row)).size!==rows.length)throw new FinancialWorkflowError('Chưa xác định được dòng Excel gốc. Đọc lại file trước khi nhập.','failure',[]);
 const fingerprints=await Promise.all(rows.map(fingerprint));let latest:ContractImportReport|undefined;
 const publish=(snapshot:Snapshot)=>{latest=report(snapshot);onResult(latest);};
 /**
  * Kết luận các dòng chưa rõ của một ảnh chụp trước khi chạy tiếp. Trả `false` khi có dòng chưa rõ mà file đang nhập không
  * còn dòng đó (không biết phòng để tra): chưa kết luận được.
  */
 const resolveUncertain=async(snapshot:Snapshot):Promise<boolean>=>{
  for(const entry of snapshot.rows){
   const index=rows.findIndex(row=>row.source_row===entry.sourceRow);
   const input=index>=0?rows[index]:undefined;
   // Mã khách của lần trước (tạo mới hay tìm theo SĐT) chỉ được dùng lại khi vẫn đúng người của dòng đang nhập (SĐT khớp);
   // khác thì tra theo SĐT như dòng mới.
   if(entry.stage!=='completed'&&!entry.contractId&&entry.customerId&&input&&!await steps.verifyCustomer(entry.customerId,input)){entry.customerId=undefined;entry.customerCreated=false;}
   if(!UNCERTAIN.includes(entry.stage))continue;
   // Dòng chưa rõ chỉ được kết luận bằng ĐÚNG dòng đó của file (cùng số dòng VÀ cùng nội dung). File đã đổi ở dòng này thì
   // không biết lần trước gửi gì: chưa kết luận được (giữ dấu, hộp cảnh báo).
   if(!input||fingerprints[index]!==entry.fingerprint)return false;
   let found:ActiveRoomContract|null;
   try{found=await steps.findActiveContract(input);}
   catch(error){
    // Máy chủ từ chối rõ phép tra của riêng dòng này (phòng đã đổi tên / bị xoá, mất quyền đọc hợp đồng): dòng không nhập được,
    // không ghi gì; báo rõ cho dòng đó thay vì làm hỏng cả lượt mãi. Lỗi chưa rõ (mạng) thì vẫn chưa kết luận được.
    if(!isConfirmedFinancialRejection(error))throw error;
    entry.stage='existing';
    entry.message=`${importErrorMessage(error,`tra hợp đồng của phòng dòng ${entry.sourceRow}`)} Lần nhập trước có thể đã tạo hợp đồng cho dòng này: kiểm tra phòng và hợp đồng trước khi nhập lại.`;
    continue;
   }
   if(entry.contractId){
    // Hợp đồng đã nhận mã: chỉ còn liên kết khách và phòng, hai bước ghi lặp lại được, nhưng chỉ khi nó vẫn là hợp đồng hiệu
    // lực của phòng (không đặt lại «có người ở» cho một phòng mà hợp đồng đó đã thôi hiệu lực).
    if(found?.id===entry.contractId){entry.stage='partial';entry.roomId=entry.roomId??found.roomId;continue;}
    entry.stage='existing';
    entry.message=`Hợp đồng mã ${entry.contractId} tạo ở lần nhập trước (dòng ${entry.sourceRow}) không còn là hợp đồng hiệu lực của phòng. Kiểm tra hợp đồng đó; dòng này không nhập lại.`;
    continue;
   }
   if(!found){entry.stage='ready';entry.message=undefined;continue;}
   if(entry.customerId&&found.tenantId===entry.customerId&&found.matches){
    entry.contractId=found.id;entry.roomId=found.roomId;entry.stage='partial';continue;
   }
   entry.stage='existing';entry.message=roomTakenMessage(entry.sourceRow,found.id);
  }
  // Dòng đã nhập xong mà file lần này ghi nội dung khác: không nhập lại, báo để người dùng sửa hợp đồng đã có.
  for(let index=0;index<rows.length;index++){
   const entry=snapshot.rows.find(row=>row.sourceRow===rows[index].source_row);
   if(entry?.stage==='completed'&&entry.fingerprint!==fingerprints[index]){
    entry.stage='existing';
    entry.message=`Dòng ${entry.sourceRow} đã nhập ở lần trước (hợp đồng mã ${entry.contractId ?? 'chưa rõ'}) với nội dung khác file này. Sửa hợp đồng đó nếu cần; dòng này không nhập lại.`;
   }
  }
  return true;
 };
 const execute=async(snapshot:Snapshot,progress:FinancialWorkflowProgress)=>{
  save(scope,snapshot);
  for(let index=0;index<rows.length;index++){
   const input=rows[index];
   let entry=snapshot.rows.find(row=>row.sourceRow===input.source_row);
   if(!entry){entry={sourceRow:input.source_row!,fingerprint:fingerprints[index],stage:'ready'};snapshot.rows.push(entry);}
   if(entry.stage==='completed'||entry.stage==='existing')continue;
   entry.message=undefined;entry.fingerprint=fingerprints[index];
   try{
    if(!entry.contractId){
     progress.stage=`khách hàng dòng ${entry.sourceRow}`;entry.stage='customer';save(scope,snapshot);
     const customer=await steps.customer(input,entry.customerId);entry.customerId=confirmedRecordId(customer,'tạo khách nhập');entry.customerCreated=entry.customerCreated||customer.created;
     if(customer.created)progress.completed.push({id:customer.id,label:`Khách đã tạo từ dòng ${entry.sourceRow}`});save(scope,snapshot);
     progress.stage=`hợp đồng dòng ${entry.sourceRow}`;entry.stage='contract';save(scope,snapshot);
     let contract:{id:string;roomId:string};
     try{contract=await steps.contract(input,customer.id);}
     catch(error){
      if(!isUniqueViolation(error))throw error;
      // Phòng đã có hợp đồng hiệu lực (chỉ mục duy nhất theo phòng): tra để biết là của lần trước hay của người khác.
      let found:ActiveRoomContract|null=null;
      try{found=await steps.findActiveContract(input);}
      catch{/* Không tra được: giữ lời từ chối 23505 của máy chủ làm kết quả của dòng. */}
      if(!found)throw error;
      if(found.tenantId!==customer.id||!found.matches)throw new RoomTakenError(roomTakenMessage(entry.sourceRow,found.id));
      contract={id:found.id,roomId:found.roomId};
     }
     entry.contractId=confirmedRecordId(contract,'tạo hợp đồng nhập');entry.roomId=contract.roomId;
     progress.completed.push({id:entry.contractId,label:`Hợp đồng đã tạo từ dòng ${entry.sourceRow}`});save(scope,snapshot);
    }
    const contractId=entry.contractId,customerId=entry.customerId,roomId=entry.roomId;
    // Hợp đồng của lần trước (đã nhận mã, hoặc vừa tra thấy đúng): ghi mã vào dấu trước các bước tiếp theo.
    if(!progress.completed.some(step=>step.id===contractId))progress.completed.push({id:contractId,label:`Hợp đồng đã tạo từ dòng ${entry.sourceRow}`});
    if(!customerId||!roomId)throw new TypeError('Chưa có đủ mã khách và phòng của hợp đồng đã tạo.');
    progress.stage=`liên kết khách dòng ${entry.sourceRow}`;entry.stage='relations';save(scope,snapshot);
    // Liên kết đã có (khoá duy nhất hợp đồng + khách) là bước đã xong ở lần trước.
    try{await steps.link(contractId,customerId);}catch(error){if(!isUniqueViolation(error))throw error;}
    progress.stage=`cập nhật phòng dòng ${entry.sourceRow}`;entry.stage='room';save(scope,snapshot);await steps.occupy(roomId);
    if(!await steps.verify(entry,input))throw new TypeError('Chưa xác nhận đầy đủ hợp đồng và liên kết đã tạo.');
    entry.stage='completed';save(scope,snapshot);publish(snapshot);
   }catch(error){
    if(error instanceof RoomTakenError){entry.stage='existing';entry.message=error.message;}
    else{entry.stage=entry.contractId?'partial':isConfirmedFinancialRejection(error)?'rejected':'unknown';entry.message=importErrorMessage(error,`nhập hợp đồng dòng ${entry.sourceRow}`);}
    save(scope,snapshot);publish(snapshot);
    // Mỗi dòng độc lập: dòng chưa rõ hay bị từ chối không dừng các dòng sau.
   }
  }
  for(const entry of snapshot.rows)if(entry.stage==='ready')entry.stage='not-sent';
  save(scope,snapshot);publish(snapshot);
  // Dấu của lượt chỉ giữ khi còn dòng chưa rõ kết quả; các dòng khác đã có kết quả rõ trong ảnh chụp.
  if(snapshot.rows.some(row=>UNCERTAIN.includes(row.stage)))throw new FinancialWorkflowError('Lượt nhập có dòng chưa rõ kết quả. Giữ các mã đã tạo; lần nhập sau với đúng file sẽ tra hợp đồng của từng dòng đó trước, không nhập lại dòng đã có.',progress.completed.length?'partial':'unknown',progress.completed);
  return report(snapshot,false);
 };
 try{
  const result=await persistentFinancialWorkflow(namespace).run('batch','nhập hợp đồng từ Excel',async progress=>{
   // Không có dấu: lượt mới. Ảnh chụp của lượt trước (kết quả đã rõ, hoặc dấu đã được gỡ qua hộp cảnh báo) cho biết dòng nào
   // đã nhập đúng nội dung này (bỏ qua) và dòng nào chưa rõ (tra trước khi chạy lại).
   let prior:Snapshot|null=null;try{prior=readSnapshot(scope);}catch{prior=null;}
   const carried=prior&&prior.buildingId===scope.buildingId?prior:null;
   const snapshot:Snapshot={...scope,attemptId:progress.requestKey,rows:rows.map((row,index)=>{
    const old=carried?.rows.find(entry=>entry.sourceRow===row.source_row);
    // Chỉ mang sang dòng của ĐÚNG nội dung đó (cùng số dòng, cùng dấu vân tay): đã nhập xong thì bỏ qua, chưa rõ thì tra trước.
    if(old&&old.fingerprint===fingerprints[index]&&(old.stage==='completed'||UNCERTAIN.includes(old.stage)))return {...old};
    // Khách đã tạo ở lượt trước cho dòng này (dòng bị từ chối ở bước hợp đồng): dùng lại (sau khi kiểm SĐT) để không tạo khách thứ hai.
    const customer=old&&!old.contractId&&old.customerCreated&&old.customerId?{customerId:old.customerId,customerCreated:true}:{};
    return {sourceRow:row.source_row!,fingerprint:fingerprints[index],stage:'ready' as const,...customer};
   })};
   // Bước này chỉ đọc: đọc hỏng là chưa ghi gì, từ chối rõ để dấu vừa ghi được gỡ ngay.
   try{await resolveUncertain(snapshot);}
   catch(error){throw new FinancialWorkflowError('Chưa đọc được hợp đồng của các dòng chưa rõ ở lượt nhập trước. Kiểm tra kết nối rồi nhập lại; chưa dòng nào được ghi.','failure',[],error);}
   return execute(snapshot,progress);
  },async(pending,progress)=>{
   const snapshot=readSnapshot(scope);if(!snapshot||snapshot.attemptId!==(pending.requestKey??pending.attemptId)||snapshot.buildingId!==scope.buildingId)return null;
   if(!await resolveUncertain(snapshot))return null;
   save(scope,snapshot);publish(snapshot);return {result:await execute(snapshot,progress)};
  },scope.organizationId);
  if(result.failed===0)remove(scope);
  onResult(result);return result;
 }catch(error){
  if(latest){const hasIds=latest.createdIds.length>0||latest.customerIds.length>0;if(!hasIds&&latest.canCorrect){remove(scope);latest.pending=false;}
   latest.message=importErrorMessage(error,'nhập hợp đồng từ Excel');onResult(latest);return latest;
  }
  const prior=readContractImportPending(scope);if(prior){prior.message=importErrorMessage(error,'nhập hợp đồng từ Excel');onResult(prior);return prior;}
  throw error;
 }
}
