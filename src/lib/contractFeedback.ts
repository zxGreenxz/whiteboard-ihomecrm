import { friendlyError, type OperationErrorRule } from './friendlyError';
import { contractBillingBoundMessages } from './contractBillingBounds';

/** Exact writer reasons from create_contract_v2. A code alone never identifies a field. */
export const contractCreateRules: readonly OperationErrorRule[] = [
  { message: 'Kỳ tính tiền đầu phải nằm trong thời hạn hợp đồng', description: 'Kỳ tính tiền đầu phải nằm trong thời hạn hợp đồng. Kiểm tra cả hai ngày tính tiền.', fieldErrors: {
    start_billing_date: 'Ngày bắt đầu tính tiền không được trước ngày bắt đầu hợp đồng',
    end_billing_date: 'Ngày kết thúc tính tiền không được sau ngày kết thúc hợp đồng',
  } },
  { message: /^Trạng thái phòng không cho phép tạo hợp đồng:/, description: 'Phòng không còn ở trạng thái cho phép ký. Tải lại danh sách phòng.', fieldErrors: { room_id: 'Phòng không còn sẵn để ký hợp đồng.' }, recovery: 'reload' },
  { message: 'Phòng đã có hợp đồng đang hiệu lực', description: 'Phòng đã có hợp đồng hiệu lực. Chọn phòng khác hoặc kiểm tra hợp đồng hiện có.', fieldErrors: { room_id: 'Phòng đã có hợp đồng hiệu lực.' }, recovery: 'reload' },
  { message: 'Phòng đang được người khác giữ chỗ', description: 'Phòng đang được người khác giữ chỗ. Tải lại phòng và cọc giữ chỗ.', fieldErrors: { room_id: 'Phòng đang được người khác giữ chỗ.' }, recovery: 'reload' },
  { message: 'Hợp đồng cần danh sách khách không trùng và đúng một người đại diện', description: 'Danh sách khách bị trùng hoặc chưa có đúng một người đại diện.', fieldErrors: { customers: 'Kiểm tra khách trùng và chọn đúng một người đại diện.' } },
  { message: 'Giá thuê hoặc tiền cọc không hợp lệ', description: 'Kiểm tra giá thuê và tiền cọc.', fieldErrors: { rent_price: 'Giá thuê phải là số không âm hợp lệ.', total_deposit: 'Tiền cọc phải là số không âm hợp lệ.' } },
  { message: 'Đơn giá dịch vụ không hợp lệ', description: 'Kiểm tra đơn giá dịch vụ riêng.', fieldErrors: { services: 'Đơn giá dịch vụ không hợp lệ.' } },
  { message: 'Mẫu hợp đồng không thuộc tổ chức hoặc không còn hiệu lực', description: 'Mẫu hợp đồng tự lấy từ cấu hình không còn dùng được. Vào Cài đặt > Mẫu tài liệu để kiểm tra mẫu đang áp dụng.', recovery: 'reload' },
  { message: 'Mẫu hóa đơn không thuộc tổ chức hoặc không còn hiệu lực', description: 'Mẫu hóa đơn tự lấy từ cấu hình không còn dùng được. Vào Cài đặt > Mẫu tài liệu để kiểm tra mẫu đang áp dụng.', recovery: 'reload' },
  { message: 'Phiếu cọc được chọn không hợp lệ hoặc đã được dùng', description: 'Cọc giữ chỗ đã thay đổi. Tải lại danh sách cọc và kiểm tra trước khi lưu.', fieldErrors: { orphan_deposits: 'Phiếu cọc không còn dùng được.' }, recovery: 'reload' },
  { message: 'Phiếu cọc đã đổi trạng thái trong lúc tạo hợp đồng', description: 'Phiếu cọc vừa đổi trạng thái. Tải lại danh sách cọc.', fieldErrors: { orphan_deposits: 'Phiếu cọc vừa đổi trạng thái.' }, recovery: 'reload' },
  { message: 'Tiền cọc đã nhận vượt số cọc của hợp đồng', description: 'Tiền cọc đã nhận vượt số cọc của hợp đồng.', fieldErrors: { total_deposit: 'Tiền cọc đã nhận vượt số cọc hợp đồng.' } },
  { message: 'Thiếu cọc: phải chọn DEBT hoặc FIRST_INVOICE', description: 'Chọn cách xử lý phần cọc còn thiếu.', fieldErrors: { deposit_debt_mode: 'Chọn nợ cọc hoặc thu trong hóa đơn đầu.' } },
  { message: 'Nợ cọc cần lý do và hạn bổ sung', description: 'Nhập lý do nợ cọc và hạn bổ sung.', fieldErrors: { deposit_debt_reason: 'Nhập lý do nợ cọc.', deposit_topup_due_date: 'Chọn hạn bổ sung cọc.' } },
  { message: 'Dòng cọc hóa đơn đầu phải đúng bằng phần cọc còn thiếu', description: 'Dòng cọc trong hóa đơn đầu không khớp phần cọc còn thiếu.', fieldErrors: { first_invoice: 'Kiểm tra dòng cọc trong hóa đơn đầu.' } },
  { message: 'Hạng mục hóa đơn đầu không hợp lệ', description: 'Kiểm tra các dòng hóa đơn đầu.', fieldErrors: { first_invoice: 'Hạng mục hóa đơn đầu không hợp lệ.' } },
  { message: 'Kỳ hạng mục hóa đơn phải có đủ từ ngày và đến ngày', description: 'Nhập đủ ngày cho hạng mục hóa đơn đầu.', fieldErrors: { first_invoice: 'Nhập đủ từ ngày và đến ngày.' } },
  { message: 'Kỳ hạng mục hóa đơn bị đảo ngày', description: 'Ngày của hạng mục hóa đơn đầu bị đảo.', fieldErrors: { first_invoice: 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.' } },
  { message: 'Kỳ hạng mục doanh thu phải nằm trong kỳ tính tiền đầu', description: 'Kỳ hạng mục doanh thu phải nằm trong kỳ tính tiền đầu.', fieldErrors: { first_invoice: 'Kiểm tra ngày của dòng doanh thu.' } },
  { message: 'Hạn trả hóa đơn đầu phải nằm trong kỳ tính tiền đầu', description: 'Kiểm tra ngày hạn trả hóa đơn đầu.', fieldErrors: { end_billing_date: 'Hạn trả phải nằm trong kỳ tính tiền đầu.' } },
  { message: 'Ngày phát hành hóa đơn đầu phải từ ngày ký đến hạn trả', description: 'Ngày phát hành hóa đơn đầu phải từ ngày ký đến hạn trả.', fieldErrors: { signed_date: 'Kiểm tra ngày ký và ngày phát hành hóa đơn.' } },
];

export function contractCreateFeedback(error: unknown, bounds?: { start_date?: string; end_date?: string }) {
  const rules = bounds ? [{ ...contractCreateRules[0], fieldErrors: contractBillingBoundMessages(bounds.start_date, bounds.end_date) }, ...contractCreateRules.slice(1)] : contractCreateRules;
  return friendlyError(error, 'Không lưu được hợp đồng', {
    operation: 'tạo hợp đồng', financial: true, rules,
  });
}

export function isContractTemplateSettingError(error: unknown): boolean {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return message === 'Mẫu hợp đồng không thuộc tổ chức hoặc không còn hiệu lực' ||
    message === 'Mẫu hóa đơn không thuộc tổ chức hoặc không còn hiệu lực';
}
