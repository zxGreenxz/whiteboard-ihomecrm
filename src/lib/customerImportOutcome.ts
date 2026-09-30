import {supabase} from '@/integrations/supabase/client';
import {FinancialWorkflowError,isConfirmedFinancialRejection} from './financialWorkflow';
import {persistentFinancialWorkflow} from './persistentFinancialWorkflow';
import {confirmedRecordId,recordWriteMessage} from './recordWriteOutcome';
import type {CustomerImportRow} from './customerExcelHelpers';
export interface CustomerImportReport {
 successRows:{name:string;id:string}[];partialRows:{name:string;id:string;reason:string}[];unknownRows:{name:string;reason:string}[];failRows:{name:string;reason:string}[];
}
export async function saveImportedCustomerImages(id:string,images:Record<string,string>){
 const {data,error}=await supabase.from('customers').update({id_images:images}).eq('id',id).select('id').single();if(error)throw error;confirmedRecordId(data,'lưu ảnh CCCD khách nhập',id);
}
export async function importCustomerBatch(rows:CustomerImportRow[],steps:{create:(row:CustomerImportRow)=>Promise<string>;uploadImages:(id:string,urls:string[])=>Promise<Record<string,string>>},onResult:(result:CustomerImportReport)=>void){
 return persistentFinancialWorkflow('customer-import').run('batch','nhập khách hàng từ Excel',async(progress)=>{
 const result:CustomerImportReport={successRows:[],partialRows:[],unknownRows:[],failRows:[]};
 for(const row of rows){try{
  const id=await steps.create(row);confirmedRecordId({id},'tạo khách nhập');progress.completed.push({id,label:'Khách nhập đã nhận mã'});
  if(row.id_image_urls?.length){try{const images=await steps.uploadImages(id,row.id_image_urls);await saveImportedCustomerImages(id,images);if(Object.keys(images).length!==row.id_image_urls.length || Object.values(images).some(value=>row.id_image_urls?.includes(value))){result.partialRows.push({name:row.full_name,id,reason:'Đã tạo khách nhưng ảnh chưa hoàn tất.'});continue;}}catch(error){result.partialRows.push({name:row.full_name,id,reason:recordWriteMessage(error,'lưu ảnh CCCD')});continue;}}
  result.successRows.push({name:row.full_name,id});
 }catch(error){
   const reason=recordWriteMessage(error,'nhập khách hàng');
   if(isConfirmedFinancialRejection(error)){result.failRows.push({name:row.full_name,reason});}
   else {
     if(error instanceof FinancialWorkflowError)progress.completed.push(...error.completed);
     result.unknownRows.push({name:row.full_name,reason});
     for(const remaining of rows.slice(rows.indexOf(row)+1))result.failRows.push({name:remaining.full_name,reason:'Chưa gửi dòng này vì kết quả tạo khách trước chưa được xác nhận.'});
     break;
   }
 }}
 onResult(result);
 if(result.unknownRows.length || result.partialRows.length || (result.failRows.length && progress.completed.length))throw new FinancialWorkflowError('Lượt nhập có dòng chưa hoàn tất. Giữ file và các mã khách đã có; mở đúng khách để đối chiếu, không nhập lại toàn bộ file.',progress.completed.length?'partial':'unknown',progress.completed);
 if(result.failRows.length)throw new FinancialWorkflowError('Chưa nhập được khách hàng trong lượt này. Giữ file và kiểm tra lỗi từng dòng trước khi thử lại.','failure',[]);
 });
}
