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
  ...expenseReasons(),
  // Trang Hợp đồng (Đợt 2, HOP-DONG-THAO-TAC-GHI.md mục 5). Mã dạng rejected vào cả REASONS của host-ownership.mjs.
  ...contractReasons(),
  // Trang Công việc (Đợt 2b, CONG-VIEC-THAO-TAC-GHI.md mục 2.4). Mã dạng rejected vào cả REASONS của host-ownership.mjs.
  ...taskReasons(),
  // Trang Hoá đơn (Đợt 3 Mốc 3 thu tiền + Mốc 4 ghi chỉ số, HOA-DON-THAO-TAC-GHI.md mục 5). Mã dạng rejected vào cả REASONS của host-ownership.mjs.
  ...invoiceReasons(),
});
export const ACTION_REASON_CODES = Object.freeze(Object.keys(ACTION_REASONS));
// Mã riêng từng trang, theo khối (test khoá: danh sách chung 20 mã + đúng các khối này, mỗi khối một trang).
export const ACTION_PAGE_REASON_BLOCKS = Object.freeze({
  expense: Object.freeze(Object.keys(expenseReasons())),
  contract: Object.freeze(Object.keys(contractReasons())),
  task: Object.freeze(Object.keys(taskReasons())),
  invoice: Object.freeze(Object.keys(invoiceReasons())),
});
function expenseReasons() {
  return {
    system_voucher: reason('rejected', 'never', 'Phiếu thuộc luồng hệ thống (thu tiền hoá đơn, cọc, thanh lý, hoa hồng, bàn giao, lương); sửa/huỷ/duyệt ở màn gốc trên web.'),
    evidence_required: reason('rejected', 'never', 'Phiếu chưa có chứng từ nên chưa chi được; thêm ảnh trên web hoặc chỉ duyệt.'),
  };
}
function contractReasons() {
  return {
    room_has_no_active_contract: reason('needs_input', 'fix', 'Phòng này không có hợp đồng đang hiệu lực (phòng trống hoặc đã trả); hỏi lại phòng/toà.'),
    notice_date_past: reason('needs_input', 'fix', 'Ngày báo trả đã qua; khách đã dọn đi thì dùng ghi nhận trả phòng, không thì hỏi lại ngày.'),
    renew_reason_ask: reason('needs_input', 'fix', 'Hỏi người dùng MỘT câu lý do gia hạn; họ nói không có thì gọi lại với noReason=true, không tự bịa lý do.'),
    notice_choice_required: reason('needs_input', 'fix', 'Hợp đồng đang có báo trả; hỏi người dùng gia hạn thì GIỮ hay HUỶ báo trả (keepMoveOutNotice).'),
    occupant_not_on_contract: reason('needs_input', 'fix', 'Người này không có trong hợp đồng của phòng; hỏi lại tên hoặc SĐT người ở.'),
    return_date_future: reason('needs_input', 'fix', 'Ngày trả phòng ở tương lai: khách chưa dọn đi thì dùng báo trả (contract.notice_set); đã dọn thì hỏi lại ngày trả thực tế.'),
    // Mốc 6 (gia hạn hàng loạt): không còn HĐ nào gia hạn được trong tháng đã nêu.
    renew_batch_empty: reason('needs_input', 'fix', 'Không có HĐ nào hết hạn trong tháng đó để gia hạn (trong phạm vi quyền, không tính HĐ đang có báo trả); hỏi lại tháng hoặc toà.'),
    already_returned: reason('rejected', 'never', 'Phòng đã ghi nhận trả phòng, đang chờ quyết toán trên web; không ghi lại.'),
    renew_price_change_web_only: reason('rejected', 'never', 'Gia hạn qua bot chỉ giữ nguyên giá và cọc; đổi giá/cọc làm trên web (Hợp đồng → Gia hạn).'),
    no_notice: reason('rejected', 'never', 'Hợp đồng này chưa có báo trả nào để huỷ.'),
    room_not_lockable: reason('rejected', 'never', 'Phòng không khoá tạm được: đã cọc, đang giữ chỗ hoặc đang có khách ở.'),
    room_already_locked: reason('rejected', 'never', 'Phòng đang được khoá tạm; gỡ khoá cũ trước nếu muốn khoá lại.'),
    no_open_lock: reason('rejected', 'never', 'Phòng này không có khoá tạm nào đang mở.'),
    cannot_remove_representative: reason('rejected', 'never', 'Không bỏ được người đại diện hợp đồng qua bot; đổi người đại diện trên web trước.'),
  };
}
// Trang Công việc: hạn mức giao việc qua bot (Q37). Số trong câu là seed của app_private.hermes_task_limits (20261022031548);
// task-actions.test.mjs khoá câu với seed — đổi seed phải đổi câu.
function taskReasons() {
  return {
    task_quota_user: reason('rejected', 'later', 'Anh/chị đã giao quá số việc cho phép trong 1 giờ qua bot (mặc định 30 việc/giờ; chủ sở hữu 60); thử lại sau ít phút hoặc tạo trên web.'),
    task_quota_pair: reason('rejected', 'later', 'Đã giao quá số việc cho phép cho cùng một người nhận trong 1 giờ (mặc định 10 việc/giờ; chủ sở hữu 40); thử lại sau ít phút hoặc tạo trên web.'),
    // Mốc 3 (task.update / task.cancel, 20261022074741): SQL kèm `link` tới việc trên web (CV12) khi biết đúng việc.
    cancel_blocked: reason('rejected', 'never', 'Việc đã có vật tư hoặc ảnh hoàn thành nên không huỷ qua bot; mở việc trên web (link kèm theo) để xử lý.'),
    task_not_open: reason('rejected', 'never', 'Việc đã hoàn thành, không còn mở; không sửa hay huỷ qua bot được (xem trên web, link kèm theo).'),
    // Mốc 4 (task.create_batch, 20261022164201): tối đa 20 việc MỘT lần đồng ý (Q37) — dạng needs_input: hỏi chia lô.
    batch_too_large: reason('needs_input', 'fix', 'Tối đa 20 việc một lần giao; chia thành nhiều lô (mỗi lô tối đa 20 việc) hoặc tạo trên web.'),
    // Mốc 5 (việc định kỳ, 20261023042424 / 20261023042436): trần 100 quy tắc đang chạy mỗi công ty (trigger CRM); trạng thái đã đúng
    // như yêu cầu (tạm dừng cái đang dừng, sửa mà không đổi gì) ⇒ hỏi lại, không ghi.
    recurrence_quota: reason('rejected', 'never', 'Công ty đã có 100 việc định kỳ đang chạy; tạm dừng hoặc xoá bớt trước khi tạo thêm.'),
    recurrence_unchanged: reason('needs_input', 'fix', 'Việc định kỳ này đã đúng như yêu cầu (đang chạy / đang tạm dừng, lịch không đổi); không cần ghi gì.'),
  };
}
// Trang Hoá đơn: Mốc 3 thu tiền + Mốc 4 ghi chỉ số.
function invoiceReasons() {
  return {
    // Mốc 3 — thu tiền.
    cash_collection_web_only: reason('rejected', 'never', 'Tiền mặt ghi trên web ở trang Thu tiền (/thu-tien); trợ lý chỉ ghi khoản chuyển khoản hoặc thanh toán (TT/POS).'),
    nothing_to_collect: reason('needs_input', 'fix', 'Hoá đơn này không còn số phải thu; hỏi lại người dùng phòng hoặc kỳ.'),
    debt_carried: reason('needs_input', 'fix', 'Nợ kỳ này đã cộng vào hoá đơn kỳ sau; thu ở hoá đơn kỳ sau (hỏi lại kỳ).'),
    overpay_needs_choice: reason('needs_input', 'fix', 'Khách trả dư; hỏi người dùng giữ lại cho kỳ sau (overpay=keep) hay trả lại khách (overpay=return).'),
    invoice_not_collectible: reason('rejected', 'never', 'Hoá đơn nháp hoặc đã huỷ, không thu tiền được.'),
    credit_requires_contract: reason('rejected', 'never', 'Hoá đơn không gắn hợp đồng nên không giữ phần dư được; chỉ trả lại khách.'),
    receiving_book_missing: reason('rejected', 'never', 'Toà chưa cài sổ nhận cho hình thức này, hoặc anh/chị không giữ/biết sổ nào của toà; cài ở Sổ nhận tiền trên web.'),
    reconciliation_required: reason('rejected', 'never', 'Hoá đơn có bút toán/cơ cấu chưa đối soát; nhờ kế toán kiểm trên web.'),
    // Mốc 4 — ghi chỉ số: bốn mã hỏi lại người dùng, hai mã chỉ đường web.
    meter_not_found: reason('needs_input', 'fix', 'Phòng không có công tơ đang dùng loại này; hỏi lại phòng hoặc loại (điện/nước).'),
    meter_ambiguous: reason('needs_input', 'fix', 'Phòng có nhiều công tơ cùng loại; hỏi mã công tơ.'),
    meter_duplicate_month: reason('needs_input', 'fix', 'Tháng này đã có chỉ số; chỉ thay khi người dùng nói rõ "sửa" (replace=true).'),
    meter_lower_than_previous: reason('needs_input', 'fix', 'Chỉ số mới nhỏ hơn chỉ số đầu; hỏi lại số trên công tơ.'),
    meter_used_by_invoice: reason('rejected', 'never', 'Chỉ số tháng này đã lên hoá đơn; sửa bằng điều chỉnh hoá đơn trên web.'),
    meter_has_later_reading: reason('rejected', 'never', 'Công tơ đã có chỉ số ngày sau ngày chốt; sửa chuỗi chỉ số trên web (trang Ghi chỉ số).'),
    // Mốc 5 — điều chỉnh / xác nhận kiểm tra / huỷ / khôi phục: hai mã hỏi lại người dùng, mười mã chỉ đường web hoặc báo trạng thái.
    adjust_no_change: reason('needs_input', 'fix', 'Điều chỉnh này không đổi gì trên hoá đơn; hỏi lại người dùng muốn đổi khoản nào, bao nhiêu.'),
    nothing_to_check: reason('needs_input', 'fix', 'Hoá đơn này không có điều chỉnh nào chờ xác nhận kiểm tra; hỏi lại phòng hoặc kỳ.'),
    adjust_meter_line_web_only: reason('rejected', 'never', 'Dòng điện/nước có chỉ số, tiền cọc hay khoản nội bộ chỉ sửa trên web (Hoá đơn → Điều chỉnh).'),
    adjust_has_rounding_or_credit: reason('rejected', 'never', 'Hoá đơn có làm tròn hoặc tiền dư đã cấn đang hiệu lực; đảo giao dịch ở Lịch sử thanh toán trên web trước.'),
    adjust_debt_carried: reason('rejected', 'never', 'Nợ của hoá đơn này đã chuyển sang hoá đơn kỳ sau; xử lý hoá đơn kỳ sau trên web trước.'),
    adjust_below_collected: reason('rejected', 'never', 'Tổng mới thấp hơn số đã thu; đảo lần thu ở Lịch sử thanh toán trên web trước khi giảm.'),
    adjustment_self_check_web_only: reason('rejected', 'never', 'Không tự xác nhận kiểm tra điều chỉnh do chính anh/chị làm qua bot (cần người khác kiểm); làm trên web nếu thật cần.'),
    cancel_has_payment: reason('rejected', 'never', 'Hoá đơn đã thu tiền nên không huỷ được; đảo lần thu ở Lịch sử thanh toán trên web trước.'),
    cancel_overdue_web_only: reason('rejected', 'never', 'Hoá đơn quá hạn chỉ huỷ trên web (trang Hoá đơn).'),
    restore_conflict: reason('rejected', 'never', 'Kỳ này đã có hoá đơn tháng khác đang hiệu lực cùng hợp đồng; không khôi phục được.'),
    invoice_already_cancelled: reason('rejected', 'never', 'Hoá đơn này đã huỷ; muốn dùng lại thì khôi phục trước.'),
    invoice_not_cancelled: reason('rejected', 'never', 'Hoá đơn này đang hiệu lực (chưa huỷ); không có gì để khôi phục.'),
  };
}
export const ACTION_INPUT_REASONS = Object.freeze(ACTION_REASON_CODES.filter(code => ACTION_REASONS[code].form === 'needs_input'));
export const ACTION_REJECT_REASONS = Object.freeze(ACTION_REASON_CODES.filter(code => ACTION_REASONS[code].form === 'rejected'));
/** Mã lạ (ngoài danh sách đóng) ⇒ crm_refused; không bao giờ để chuỗi khác lọt tới mô hình. */
export const actionReason = code => typeof code === 'string' && Object.hasOwn(ACTION_REASONS, code) ? code : 'crm_refused';
export const actionReasonText = code => ACTION_REASONS[actionReason(code)].text;
