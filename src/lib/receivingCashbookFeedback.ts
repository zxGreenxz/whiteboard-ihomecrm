import {friendlyError} from './friendlyError';
import {FinancialWorkflowError} from './financialWorkflow';
// Source: 20260925082815_so_nhan_tien.sql. Only verified business messages pass through.
export function receivingCashbookError(error: unknown, operation: string): string {
  if (error instanceof FinancialWorkflowError) return error.message;
  const result=friendlyError(error, `Chưa ${operation}.`, {operation,rules:[
    ...['Chỉ chủ công ty cài được sổ nhận tiền','Thành viên không còn hoạt động','Tối đa 20 sổ phụ cho một hình thức'].map(message=>({message,description:message})),
    {message:'Sổ tiền mặt riêng phải là sổ thật của tổ chức',description:'Chọn sổ quỹ tiền thật thuộc công ty đang làm việc.'},
    {message:'Sổ nhận tiền phải là sổ thật của tổ chức',description:'Chọn sổ quỹ tiền thật thuộc công ty đang làm việc.'},
    {message:'Toà nhà không tồn tại',description:'Tòa nhà không còn trong danh sách. Tải lại cấu hình sổ nhận tiền.'},
    {message:/^Người này chưa giữ sổ ".*" — cấp quyền giữ sổ trước rồi mới đặt làm sổ tiền mặt riêng$/,description:'Người được chọn chưa giữ sổ này. Cấp quyền giữ sổ trước khi đặt làm sổ tiền mặt riêng.'},
  ]});
  return result.description;
}
