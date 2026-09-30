import type { OperationErrorRule } from './friendlyError';
// Verified against 20260730170000_cashbook_closing_ritual.sql; SQLSTATE alone is insufficient.
export const CASHBOOK_CLOSING_RULES: readonly OperationErrorRule[] = [
  {message:'Phải nhập số tiền thực đếm',fieldErrors:{counted:'Nhập số tiền thực kiểm đếm.'},description:'Nhập số tiền thực kiểm đếm.'},
  {message:/^Phải chọn NGƯỜI KHÁC để xác nhận nhận bàn giao/,fieldErrors:{confirmer:'Chọn người khác để xác nhận chốt sổ.'},description:'Chọn người khác để xác nhận chốt sổ.'},
  {message:'Người xác nhận không thuộc tổ chức này',fieldErrors:{confirmer:'Người được chọn không thuộc tổ chức. Chọn lại người xác nhận.'},description:'Chọn lại người xác nhận.'},
  {message:'Người được chọn không có quyền xác nhận nhận bàn giao sổ này',fieldErrors:{confirmer:'Người được chọn chưa có quyền xác nhận sổ này. Chọn người khác.'},description:'Chọn người có quyền xác nhận sổ này.'},
  {message:/^Số tiền bạn đếm \(.*\) khác số người giao khai/,fieldErrors:{counted:'Số tiền khác số người giao khai. Hai bên cần kiểm đếm lại.'},description:'Hai bên cần kiểm đếm lại trước khi chốt sổ.'},
  {message:/^(Số dư hệ thống đã đổi|Số dư đổi ngay trong lúc chốt|Không xác nhận được, sổ đã đổi)/,description:'Số liệu sổ đã thay đổi. Tải lại đề nghị và đối chiếu số dư trước khi xác nhận.',recovery:'reload'},
  {message:/^Đề nghị này đã .* rồi$/,description:'Đề nghị đã được xử lý. Tải lại trạng thái trước khi tiếp tục.',recovery:'reload'},
  {message:'Không tìm thấy đề nghị',description:'Đề nghị không còn trong danh sách bạn được phép xem. Tải lại danh sách đề nghị.',recovery:'reload'},
];
