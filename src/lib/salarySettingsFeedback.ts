import {friendlyError, type OperationErrorRule} from './friendlyError';
import {voucherOutcomeUnknown} from './voucherFeedback';
export const SALARY_SETTINGS_RULES: readonly OperationErrorRule[] = [
 {message:'Người này chưa có cấu hình hưởng lương trong công ty',description:'Người nhận chưa có cấu hình hưởng lương. Chọn lại người nhận hoặc bổ sung cấu hình.',fieldErrors:{staffId:'Chọn người đã có cấu hình hưởng lương.'}},
 {message:'Tên khoản trống hoặc quá dài',description:'Nhập tên khoản từ 1 đến 120 ký tự.',fieldErrors:{label:'Nhập tên khoản từ 1 đến 120 ký tự.'}},
 {message:'Lương QL bổ sung phải gắn một toà',description:'Chọn tòa nhà được bổ sung lương.',fieldErrors:{buildingId:'Chọn tòa nhà được bổ sung lương.'}},
 {message:'Toà không thuộc công ty của người nhận lương',description:'Chọn tòa nhà thuộc công ty của người nhận.',fieldErrors:{buildingId:'Tòa này không thuộc công ty của người nhận.'}},
 {message:'Mức tiền phải là số đồng nguyên dương',description:'Nhập số tiền nguyên lớn hơn 0.',fieldErrors:{amount:'Nhập số tiền nguyên lớn hơn 0.'}},
 {message:'Phải ghi lý do',description:'Nhập lý do thay đổi.',fieldErrors:{reason:'Nhập lý do thay đổi.'}},
 {message:'Khoá idempotency đã dùng cho một nội dung khác',description:'Yêu cầu này đã được gửi với nội dung khác. Đối chiếu khoản vừa lưu trước khi mở biểu mẫu mới.'},
 {message:/^Kỳ \d{2}\/\d{4} hoặc sau đó đã chốt lương — chọn kỳ áp dụng sau kỳ đã chốt$/,description:'Kỳ áp dụng hoặc kỳ sau đó đã chốt. Chọn một kỳ sau kỳ đã chốt.',fieldErrors:{effectiveMonth:'Chọn kỳ áp dụng sau kỳ lương đã chốt.'}},
 {message:'Thay đổi chạm kỳ lương đã chốt — kỳ đã chốt không bao giờ tính lại',description:'Thay đổi ảnh hưởng đến kỳ đã chốt. Chọn kỳ áp dụng sau kỳ đã chốt.',fieldErrors:{effectiveMonth:'Chọn kỳ áp dụng sau kỳ lương đã chốt.'}},
 {message:'Khoản đã áp vào kỳ lương đã chốt — dùng "Ngừng từ kỳ" thay vì xoá',description:'Khoản này đã có trong kỳ lương đã chốt. Dùng Ngừng từ kỳ để dừng từ một kỳ còn mở.'},
 {message:/^Kỳ \d{2}\/\d{4} đã chốt lương — mở khoá kỳ trước khi sửa số tiền$/,description:'Kỳ lương đã chốt. Mở khóa kỳ theo quy trình trước khi sửa số tiền.'},
 {message:'Chỉ chủ được kết án',description:'Bạn không có quyền kết luận ngày công. Liên hệ chủ công ty.'},
 {message:'Ngày này không ở trạng thái nghi án',description:'Ngày công không còn chờ xem xét. Tải lại danh sách để xem trạng thái mới.'},
 {message:'Chỉ chủ được chốt tiền v5',description:'Bạn không có quyền ghi tiền chuyên cần và chuỗi vào bảng lương.'},
 {message:'v5_money đang TẮT (shadow) — không được ghi tiền v5 vào lương',description:'Chế độ hiện tại chỉ tính thử. Chưa được ghi tiền chuyên cần và chuỗi vào bảng lương.'},
 {message:'Chỉ chủ được đổi cấu hình lương v5',description:'Bạn không có quyền đổi cấu hình lương. Liên hệ chủ công ty.'},
 {message:/^CHẶN LOCK: .+ chưa qua đủ 3 ASSERT \(caps=.+, flags=.+, payment_join=.+\)$/,description:'Chưa đủ điều kiện ghi vào lương. Kiểm tra các nhân viên có cảnh báo trong bảng đối soát tháng.'},
];
export function salarySettingsErrorMessage(error:unknown,operation:string){const f=friendlyError(error,`Chưa ${operation}.`,{operation,financial:true,rules:SALARY_SETTINGS_RULES});return `${f.title} ${f.description}`;}
export const SALARY_JOB_LABELS:Record<string,string>={nightly:'Tổng hợp cuối ngày',digest:'Gửi bản tin',tier:'Cập nhật lịch kiểm tra',score:'Tính điểm',close_period:'Chuyển kỳ',push_drain:'Xử lý hàng đợi thông báo'};
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export function salaryJobFeedback(value:unknown):{kind:'info'|'warning'|'success';message:string;blocksRepeat:boolean}{
 const root=record(value);if(!Array.isArray(root.ran)||!root.ran.length) throw new TypeError('Unconfirmed salary job result');
 let failed=root.ok!==true,completed=0;const details:string[]=[];
 for(const value of root.ran){const row=record(value);const label=SALARY_JOB_LABELS[String(row.job)]??'Tác vụ';
  if(row.skipped===true){details.push(`${label}: đã chạy trước đó, không chạy lại.`);continue;}
  if(row.ok===false||row.error){failed=true;details.push(`${label}: chưa hoàn tất.`);continue;}
  if(row.job==='digest'){
   if(!Number.isInteger(row.pushes)||!Number.isInteger(row.sent)||Number(row.sent)<0||Number(row.sent)>Number(row.pushes))throw new TypeError('Unconfirmed digest result');
   const n=Number(row.pushes),sent=Number(row.sent);if(sent<n)failed=true;
   details.push(n===0?'Bản tin: không có người cần gửi.':`Bản tin: dịch vụ tiếp nhận ${sent}/${n} lượt gửi; chưa xác nhận thiết bị hiển thị.`);if(n>0)completed++;continue;
  }
  if(row.job==='push_drain'){
   if(!Number.isInteger(row.batches)||!Number.isInteger(row.settled)||Number(row.batches)<0||Number(row.settled)<0||Number(row.settled)>Number(row.batches))throw new TypeError('Unconfirmed push batch result');
   if(Number(row.settled)<Number(row.batches))failed=true;
   const outcomes=record(row.outcomes);if(Object.entries(outcomes).some(([key,count])=>!['SENT','DUPLICATE'].includes(key)&&Number(count)>0))failed=true;
   details.push(`Hàng đợi thông báo: đã xử lý trạng thái ${row.settled}/${row.batches} nhóm gửi; chưa xác nhận thiết bị hiển thị.`);if(Number(row.batches)>0)completed++;continue;
  }
  const keys:Record<string,string>={tier:'expired_sessions',score:'mission_rows',close_period:'staff_processed'};const key=keys[String(row.job)];
  if(!key)throw new TypeError('Unconfirmed salary job step');
  const count=record(row.result)[key];
  if(!Number.isInteger(count)||Number(count)<0)throw new TypeError('Unconfirmed salary job step');
  if(Number(count)>0)completed++;details.push(Number(count)>0?`${label}: đã xử lý ${count} ${row.job==='tier'?'phiên kiểm tra':row.job==='score'?'dòng nhiệm vụ':'nhân viên'}.`:`${label}: không có dữ liệu cần cập nhật.`);
 }
 return {kind:failed?'warning':completed?'success':'info',message:details.join(' '),blocksRepeat:failed};
}
export function readSalaryWriteReceipt(value:unknown,key:'item_id'|'version_id'|'override_id'):{id:string;replayed:boolean}{const row=record(value);if(typeof row[key]!=='string'||!row[key])throw new TypeError('Unconfirmed salary write result');return {id:row[key],replayed:row.lap_lai===true};}
export async function loadHolidayPreset(preset:readonly {d:string;n:string}[],existing:readonly string[],add:(input:{holiday_date:string;name:string})=>Promise<unknown>){
 const dates=new Set(existing);const pending=preset.filter(row=>!dates.has(row.d));
 const results=await Promise.allSettled(pending.map(row=>add({holiday_date:row.d,name:row.n})));
 const completed: {date:string;name:string}[]=[];const failed:{date:string;name:string}[]=[];let unknown=false;
 // Promise.allSettled preserves the length and order of the mapped pending rows.
 results.forEach((result,i)=>{const item={date:pending[i]!.d,name:pending[i]!.n};if(result.status==='fulfilled')completed.push(item);else{failed.push(item);unknown ||= voucherOutcomeUnknown(result.reason);}});
 return {completed,failed,unknown,skipped:preset.length-pending.length};
}
