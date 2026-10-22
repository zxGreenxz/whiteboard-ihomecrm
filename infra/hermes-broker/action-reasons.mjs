// Danh sách ĐÓNG lý do của thao tác ghi Hermes (Đợt 1 nền chung, docs/plans/hermes-crm/NEN-CHUNG-THAO-TAC-GHI.md
// mục 6). Mỗi mã có một câu tiếng Việt tĩnh (câu duy nhất tới mô hình — không bao giờ chuyển nguyên văn lỗi SQL,
// vì lỗi có thể chứa ID/dữ liệu), một chỉ dẫn thử lại và một DẠNG:
//   needs_input — thiếu/sai/mơ hồ đầu vào, cần người dùng nói thêm: trả về như KẾT QUẢ thường (isError=false).
//                 Ca thử Công việc trên TEST (21/10): sau 3 lời gọi bị từ chối liên tiếp Hermes khoá cả MCP server
//                 ~59 s và bot bỏ cuộc, nên tình huống "hỏi lại người dùng" không được là lỗi.
//   rejected    — lỗi thật (quyền, nghiệp vụ, hệ thống): BrokerError action_rejected kèm reason + detail.
// Mã mới phải vào ĐỒNG THỜI file này và REASONS của infra/hermes-runtime/host-ownership.mjs (sổ audit host nhận
// trường reason): audit-codes.test.mjs khoá hai tập bằng nhau — thiếu mã là đúng lớp sự cố 21/10.
// Dữ liệu thuần, không import: dùng được từ broker, test và (về sau) bundle web.
const reason = (form, retry, text) => Object.freeze({ form, retry, text });
export const ACTION_REASON_FORMS = Object.freeze(['needs_input', 'rejected']);
// retry: fix = sửa lệnh/hỏi lại rồi gọi lại; preview = xem trước lại (token mới); later = chờ rồi thử; never = không thử lại.
export const ACTION_REASON_RETRIES = Object.freeze(['fix', 'preview', 'later', 'never']);
export const ACTION_REASONS = Object.freeze({
  unknown_action: reason('needs_input', 'fix', 'Không có thao tác này; xem danh sách bằng crm_action_list.'),
  invalid_params: reason('needs_input', 'fix', 'Tham số thiếu hoặc sai; sửa theo khuôn của thao tác ở crm_action_list.'),
  name_unresolved: reason('needs_input', 'fix', 'Chưa xác định được toà/phòng/người trong phạm vi quyền của anh/chị; hỏi lại người dùng, không đoán.'),
  reason_required: reason('needs_input', 'fix', 'Cần ghi lý do (ít nhất 8 ký tự); hỏi người dùng lý do.'),
  amount_out_of_range: reason('needs_input', 'fix', 'Số tiền ngoài giới hạn cho phép; hỏi lại người dùng số tiền.'),
  date_out_of_range: reason('needs_input', 'fix', 'Ngày không hợp lệ (ngoài khoảng cho phép hoặc ở tương lai); hỏi lại người dùng ngày.'),
  not_found: reason('needs_input', 'fix', 'Không tìm thấy đối tượng này trong phạm vi quyền của anh/chị; hỏi lại người dùng.'),
  action_disabled: reason('rejected', 'never', 'Thao tác này chưa được bật cho kết nối.'),
  not_allowed: reason('rejected', 'never', 'Anh/chị không có quyền làm thao tác này ở toà này.'),
  private_chat_only: reason('rejected', 'never', 'Lệnh ghi chỉ nhận trong chat riêng.'),
  state_changed: reason('rejected', 'preview', 'Dữ liệu vừa đổi sau bản xem trước; cần xem trước lại.'),
  request_conflict: reason('rejected', 'preview', 'Mã yêu cầu này đã dùng cho lệnh khác; xem trước lại để lấy mã mới.'),
  period_locked: reason('rejected', 'never', 'Kỳ này đã chốt (lợi nhuận, sổ quỹ hoặc bàn giao); không ghi được.'),
  cashbook_not_held: reason('rejected', 'never', 'Anh/chị không giữ sổ quỹ này.'),
  not_pending: reason('rejected', 'never', 'Phiếu đã vào sổ hoặc không còn chờ duyệt.'),
  quota_exceeded: reason('rejected', 'later', 'Vượt hạn mức của CRM; thử lại sau.'),
  strict_mode: reason('rejected', 'never', 'Công ty đang bật chế độ chặt; thao tác này làm trên web.'),
  web_only: reason('rejected', 'never', 'Trường hợp này phải làm trên web.'),
  duplicate_request: reason('rejected', 'never', 'Lệnh này đã được ghi trước đó.'),
  crm_refused: reason('rejected', 'never', 'CRM từ chối, chưa phân loại được lý do; kiểm trên web.'),
  // Thu chi (Đợt 2, docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 2.3).
  system_voucher: reason('rejected', 'never', 'Phiếu thuộc luồng hệ thống (thu tiền hoá đơn, cọc, thanh lý, hoa hồng, bàn giao, lương); sửa/huỷ/duyệt ở màn gốc trên web.'),
  evidence_required: reason('rejected', 'never', 'Phiếu chưa có chứng từ nên chưa chi được; thêm ảnh trên web hoặc chỉ duyệt.'),
  // Trang Công việc (Đợt 2b, CONG-VIEC-THAO-TAC-GHI.md mục 2.4): hạn mức giao việc qua bot (Q37). Số trong câu là seed của
  // app_private.hermes_task_limits (20261022031548); task-actions.test.mjs khoá câu với seed — đổi seed phải đổi câu.
  task_quota_user: reason('rejected', 'later', 'Anh/chị đã giao quá số việc cho phép trong 1 giờ qua bot (mặc định 30 việc/giờ; chủ sở hữu 60); thử lại sau ít phút hoặc tạo trên web.'),
  task_quota_pair: reason('rejected', 'later', 'Đã giao quá số việc cho phép cho cùng một người nhận trong 1 giờ (mặc định 10 việc/giờ; chủ sở hữu 40); thử lại sau ít phút hoặc tạo trên web.'),
});
export const ACTION_REASON_CODES = Object.freeze(Object.keys(ACTION_REASONS));
export const ACTION_INPUT_REASONS = Object.freeze(ACTION_REASON_CODES.filter(code => ACTION_REASONS[code].form === 'needs_input'));
export const ACTION_REJECT_REASONS = Object.freeze(ACTION_REASON_CODES.filter(code => ACTION_REASONS[code].form === 'rejected'));
/** Mã lạ (ngoài danh sách đóng) ⇒ crm_refused; không bao giờ để chuỗi khác lọt tới mô hình. */
export const actionReason = code => typeof code === 'string' && Object.hasOwn(ACTION_REASONS, code) ? code : 'crm_refused';
export const actionReasonText = code => ACTION_REASONS[actionReason(code)].text;
