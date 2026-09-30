import { friendlyError } from './friendlyError';
import { voucherFailureMessage, voucherOutcomeUnknown } from './voucherFeedback';
// Exact reasons from utility/period-fee writers and 20260801011000_special_fee_wire_autopost.sql.
const reasons = [
 ['Số tiền phải lớn hơn 0', 'Nhập số tiền lớn hơn 0.'],
 ['Giá công bố phải lớn hơn 0', 'Nhập giá công bố lớn hơn 0.'],
 ['Kỳ không hợp lệ (cần YYYY-MM)', 'Chọn lại kỳ đóng tiền.'],
 ['Tháng hiệu lực phải dạng YYYY-MM', 'Chọn tháng bắt đầu áp dụng giá.'],
 ['Không tìm thấy đồng hồ điện/nước', 'Không tìm thấy đồng hồ điện/nước. Tải lại danh sách đồng hồ của tòa.'],
 ['Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này', 'Chọn sổ quỹ bạn có quyền ghi chi.'],
 ['Sổ quỹ không hợp lệ hoặc là SỔ ẢO — phí cố định là tiền thật ra khỏi két', 'Chọn sổ quỹ tiền mặt hoặc ngân hàng có quyền ghi chi.'],
 ['Phiếu đã bị hủy trước đó', 'Phiếu đã được hủy trước đó. Tải lại danh sách; không cần hủy thêm.'],
 ['Bạn không có quyền thao tác trên toà này', 'Bạn chưa có quyền thao tác phí của tòa này. Liên hệ người quản lý quyền.'],
 ['Bạn không có quyền hủy phiếu này', 'Bạn chưa có quyền hủy phiếu phí này. Liên hệ người duyệt phiếu.'],
] as const;
export function feeFailureMessage(error:unknown, action:string):string {
 if (voucherOutcomeUnknown(error)) return voucherFailureMessage(error,action);
 return friendlyError(error,`Chưa ${action}`,{operation:action,financial:true,rules:reasons.map(([message,description])=>({message,description}))}).description;
}
export function parseGeneratedFeeReceipt(value:unknown) {
 const d = value as {period?:unknown;created?:unknown;posted?:unknown;totalAmount?:unknown;voucherIds?:unknown;note?:unknown}|null;
 if (!d || typeof d.period!=='string' || ![d.created,d.posted,d.totalAmount].every(n=>typeof n==='number' && Number.isFinite(n) && n>=0)
   || !Number.isInteger(d.created) || !Number.isInteger(d.posted) || (d.posted as number)>(d.created as number)
   || !Array.isArray(d.voucherIds) || d.voucherIds.some(id=>typeof id!=='string'||!id) || d.voucherIds.length!==d.created) {
   throw new TypeError('Chưa xác nhận đầy đủ các phiếu phí vừa tạo');
 }
 return {period:d.period,created:d.created as number,posted:d.posted as number,totalAmount:d.totalAmount as number,voucherIds:d.voucherIds as string[],note:typeof d.note==='string'?d.note:''};
}
