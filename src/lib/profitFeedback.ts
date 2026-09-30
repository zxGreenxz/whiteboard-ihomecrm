import { actionErrorMessage } from './actionFeedback';
import { FinancialWorkflowError } from './financialWorkflow';
import { voucherOutcomeUnknown } from './voucherFeedback';

export function validateProfitPerson(name: string, authUserId: string): Record<string,string> {
 const errors:Record<string,string>={};
 if(!authUserId) errors.authUserId='Chọn tài khoản đăng nhập.';
 if(!name.trim()) errors.name='Nhập tên hiển thị.';
 return errors;
}
export function validateShareRows(rows: readonly {building_id:string;percent:number}[]):Record<string,string>{
 const errors:Record<string,string>={}; const seen=new Set<string>();
 rows.forEach((r,i)=>{
  if(!r.building_id) errors[`rows.${i}.building_id`]='Chọn tòa nhà cho tỷ lệ này.';
  else if(seen.has(r.building_id)) errors[`rows.${i}.building_id`]='Tòa nhà này đã được chọn ở dòng khác.';
  seen.add(r.building_id);
  if(!Number.isFinite(r.percent)||r.percent<0||r.percent>100) errors[`rows.${i}.percent`]='Nhập tỷ lệ từ 0 đến 100%.';
 });return errors;
}
export function validateSalaryRules(rules: readonly {building_ids:string[];form:string;amount:number;percent:number}[]):Record<string,string>{
 const errors:Record<string,string>={};
 rules.forEach((r,i)=>{
  if(!r.building_ids.length) errors[`rules.${i}.building_ids`]='Chọn ít nhất một nhà hoặc xóa quy tắc này.';
  if(r.form==='FIXED'&&(!Number.isFinite(r.amount)||r.amount<0)) errors[`rules.${i}.amount`]='Nhập số tiền không âm.';
  if(r.form==='PERCENT'&&(!Number.isFinite(r.percent)||r.percent<0||r.percent>100)) errors[`rules.${i}.percent`]='Nhập tỷ lệ từ 0 đến 100%.';
 });return errors;
}
// Exact business phrases verified in profit_close_v2, scope_reset_guard and chot_loi_nhuan_theo_tung_nha migrations.
export function profitActionErrorMessage(error: unknown, operation: string):string {
 if(error instanceof FinancialWorkflowError) return error.message;
 const msg=typeof error==='object'&&error!==null&&'message' in error?String(error.message):'';
 if(['Không xác định được tổ chức','Không có nhà để chốt','Lý do chốt lại phải có 8–1000 ký tự','Cách xử lý phần chưa phân bổ không hợp lệ','Lý do xử lý phần chưa phân bổ phải có 8–500 ký tự','Không có toà nào đang khoá để mở','Lý do mở khoá phải có 8–1000 ký tự','Lý do đặt lại phải có 8–1000 ký tự'].includes(msg)) return msg;
 if(voucherOutcomeUnknown(error)) return `Chưa xác nhận được kết quả ${operation}. Tải lại trạng thái tháng và đối chiếu trước khi thực hiện tiếp.`;
 if(/^PROFIT_(SOURCE|STATE|SNAPSHOT)_CONFLICT\b/.test(msg)) return 'Dữ liệu hoặc trạng thái tháng vừa thay đổi. Tải lại số liệu, kiểm tra điều chỉnh và chọn lại phạm vi trước khi chốt.';
 if(/^Còn \d+ phiếu chờ duyệt trong tháng .+ của toà .+: .+ — duyệt hoặc huỷ trước khi chốt\.$/.test(msg)) return msg;
 if(/^\[TOTAL_GROUP_KHONG_DU\] Lương điều hành ".+" chia theo lợi nhuận của cả nhóm nhà nên phải chốt cùng lúc\. Còn thiếu: .+\.$/.test(msg)) return msg.replace('[TOTAL_GROUP_KHONG_DU] ','');
 if(msg==='UNLOCK requires LOCKED current snapshots'||msg==='RECLOSE requires an existing LOCKED snapshot for every building') return 'Có nhà trong vùng chọn không còn ở trạng thái Đã chốt. Tải lại số liệu và chọn lại các nhà cần thực hiện.';
 if(msg==='Every requested building must have a current period snapshot') return 'Có nhà chưa có bản chốt của tháng này. Tải lại số liệu và chọn lại phạm vi.';
 if(msg==='One or more buildings are already closed; use profit_reclose_v2') return 'Có nhà đã chốt lợi nhuận. Tải lại số liệu và dùng Chốt lại cho các nhà đó.';
 if(msg==='reason must contain 8..1000 characters') return 'Nhập lý do từ 8 đến 1000 ký tự.';
 if(msg==='Unallocated disposition reason must contain 8..500 characters') return 'Nhập lý do xử lý phần chưa phân bổ từ 8 đến 500 ký tự.';
 if(msg==='Unlock permission does not cover every requested building'||msg==='Permission denied: shareholder_profit.unlock') return 'Bạn không có quyền mở khoá lợi nhuận ở một hoặc nhiều nhà đã chọn.';
 return actionErrorMessage(error,`Chưa ${operation}.`);
}
export function readProfitActionResult(value:unknown, expectedCount?:number):{run_id:string;affected_buildings:number;idempotent_replay:boolean}{
 const r=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
 if(typeof r.run_id!=='string'||!r.run_id||!Number.isInteger(r.affected_buildings)||Number(r.affected_buildings)<1||(expectedCount!==undefined&&r.affected_buildings!==expectedCount)) throw new TypeError('Unconfirmed profit operation result');
 return {run_id:r.run_id,affected_buildings:Number(r.affected_buildings),idempotent_replay:r.idempotent_replay===true};
}
