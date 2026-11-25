import {supabase} from '@/integrations/supabase/client';
import {FinancialAlreadyRecordedError,isConfirmedFinancialRejection} from './financialWorkflow';
import {confirmedRecordId,recordWriteMessage} from './recordWriteOutcome';
import {personMatchKeys} from './clientRecordCreate';
import {legacyWindow,settleLegacyPending} from './legacyPendingExit';
import type {CustomerImportRow} from './customerExcelHelpers';
export interface CustomerImportReport {
 successRows:{name:string;id:string}[];partialRows:{name:string;id:string;reason:string}[];unknownRows:{name:string;reason:string}[];failRows:{name:string;reason:string}[];
 /** Dòng không gửi vì giống một khách đã tạo ở lượt nhập trước bị kẹt (hoặc lần tạo trước), kèm mã khách đó. */
 skippedRows:{name:string;id:string;reason:string}[];
 /** Dòng chưa rõ kết quả và dòng chưa gửi: nhập lại đúng các dòng này (cùng mã khách của từng dòng) là an toàn. */
 retryRows:CustomerImportRow[];
}
export async function saveImportedCustomerImages(id:string,images:Record<string,string>){
 const {data,error}=await supabase.from('customers').update({id_images:images}).eq('id',id).select('id').single();if(error)throw error;confirmedRecordId(data,'lưu ảnh CCCD khách nhập',id);
}
type CreatedRow={id:string;replayed?:boolean};
const asCreated=(value:string|CreatedRow):CreatedRow=>typeof value==='string'?{id:value}:value;
type LegacyCandidate={id:string;full_name:string|null;phone:string|null;id_number:string|null};

/**
 * Dấu khoá chung của lượt nhập bản trước đợt 4 (`customer-import`/`batch`, một dấu cho mọi lượt nhập): đọc một lần, lấy
 * khách người này đã tạo quanh giờ kẹt cùng các mã khách dấu cũ đã nhận, rồi gỡ dấu. Dòng giống một khách như thế được
 * bỏ qua kèm mã, không tự tạo lần nữa.
 */
async function legacyImportCandidates():Promise<LegacyCandidate[]>{
 const settled=await settleLegacyPending({namespace:'customer-import',businessKey:'batch'},async(pending,context)=>{
  const {from,to}=legacyWindow(pending);
  const columns='id, full_name, phone, id_number, created_at';
  const {data,error}=await supabase.from('customers').select(columns).eq('user_id',context.userId).eq('organization_id',context.organizationId).is('deleted_at',null).gte('created_at',from).lte('created_at',to).order('created_at',{ascending:false}).limit(500);
  if(error||!Array.isArray(data))throw error??new Error('Chưa đọc được khách quanh giờ kẹt.');
  const rows=[...data] as LegacyCandidate[];
  const known=pending.completedIds.filter(id=>!rows.some(row=>row.id===id));
  if(known.length){
   const {data:byId,error:byIdError}=await supabase.from('customers').select(columns).in('id',known).is('deleted_at',null);
   if(byIdError||!Array.isArray(byId))throw byIdError??new Error('Chưa đọc được khách của dấu cũ.');
   rows.push(...(byId as LegacyCandidate[]));
  }
  return rows;
 });
 return settled?.verdict??[];
}

/**
 * Nhập khách từ Excel, từng dòng một. KHÔNG giữ dấu «chờ đối chiếu» nào (đợt 4): mỗi dòng mang một mã khách riêng
 * (`client_id`, sinh lúc đọc file), nên gửi lại một dòng dùng đúng mã đó và máy chủ không cho ra khách thứ hai. Mọi
 * dòng đều có kết quả báo theo dòng; dòng chưa rõ kết quả và các dòng sau nó nằm ở `retryRows` để nhập lại.
 */
export async function importCustomerBatch(rows:CustomerImportRow[],steps:{create:(row:CustomerImportRow)=>Promise<string|CreatedRow>;uploadImages:(id:string,urls:string[])=>Promise<Record<string,string>>},onResult:(result:CustomerImportReport)=>void):Promise<CustomerImportReport>{
 const result:CustomerImportReport={successRows:[],partialRows:[],unknownRows:[],failRows:[],skippedRows:[],retryRows:[]};
 // Mã khách của dòng giữ trên chính đối tượng dòng, để lần nhập lại cùng các dòng đó gửi lại đúng mã.
 for(const row of rows)row.client_id??=crypto.randomUUID();
 const legacy=await legacyImportCandidates();
 for(const [index,row] of rows.entries()){
  const keys=personMatchKeys({name:row.full_name,phone:row.phone,idNumber:row.id_number});
  const seen=legacy.find(candidate=>personMatchKeys({name:candidate.full_name,phone:candidate.phone,idNumber:candidate.id_number}).some(key=>keys.includes(key)));
  if(seen){result.skippedRows.push({name:row.full_name,id:seen.id,reason:`Có thể đã tạo ở lượt nhập trước bị kẹt (mã ${seen.id}). Kiểm tra khách đó; nhập lại riêng dòng này nếu vẫn cần.`});continue;}
  let created:CreatedRow;
  try{
   created=asCreated(await steps.create(row));confirmedRecordId(created,'tạo khách nhập');
  }catch(error){
   const reason=recordWriteMessage(error,'nhập khách hàng');
   if(error instanceof FinancialAlreadyRecordedError){result.skippedRows.push({name:row.full_name,id:error.recordIds[0]??'',reason});continue;}
   if(isConfirmedFinancialRejection(error)){result.failRows.push({name:row.full_name,reason});continue;}
   // Chưa rõ kết quả: dừng lượt (mạng có thể đang hỏng), báo dòng này và các dòng sau để nhập lại đúng mã.
   result.unknownRows.push({name:row.full_name,reason});
   const rest=rows.slice(index+1);
   for(const remaining of rest)result.unknownRows.push({name:remaining.full_name,reason:'Chưa gửi dòng này vì dòng trước chưa xác nhận được kết quả. Bấm nhập lại các dòng chưa xong.'});
   result.retryRows.push(row,...rest);
   break;
  }
  const id=created.id;
  // Mã thật của khách (khác mã đã gửi khi khách cũ của dòng đã bị xoá và phải tạo lại bằng mã mới).
  row.client_id=id;
  if(created.replayed){
   // Khách mang mã của dòng này đã có từ lượt trước (dòng chưa rõ đã ghi, hoặc nhập lại cùng file): không tạo thêm,
   // không cập nhật theo file lần này, không tải lại ảnh.
   result.skippedRows.push({name:row.full_name,id,reason:`Đã có từ lượt nhập trước (mã ${id}); không tạo thêm và không cập nhật theo file lần này. Kiểm tra ảnh CCCD của khách nếu cần.`});
   continue;
  }
  if(row.id_image_urls?.length){
   try{
    const images=await steps.uploadImages(id,row.id_image_urls);await saveImportedCustomerImages(id,images);
    if(Object.keys(images).length!==row.id_image_urls.length || Object.values(images).some(value=>row.id_image_urls?.includes(value))){result.partialRows.push({name:row.full_name,id,reason:'Đã tạo khách nhưng ảnh chưa hoàn tất. Mở khách để thêm ảnh.'});continue;}
   }catch(error){result.partialRows.push({name:row.full_name,id,reason:`${recordWriteMessage(error,'lưu ảnh CCCD')} Khách đã tạo; mở khách để thêm ảnh.`});continue;}
  }
  result.successRows.push({name:row.full_name,id});
 }
 onResult(result);
 return result;
}
