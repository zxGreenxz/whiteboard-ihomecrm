// Sổ chiến lược đối chiếu: mỗi loại dấu «chờ đối chiếu» (namespace) khai một dòng.
//
// VÌ SAO CÓ SỔ NÀY
//   Một lần ghi chưa rõ kết quả để lại dấu bền trong trình duyệt. Dấu chỉ tự gỡ được khi nơi ghi có cách
//   đối chiếu với máy chủ; nơi chưa có thì người dùng phải tự xác nhận qua hộp cảnh báo (`van`). Sổ này cho
//   biết còn bao nhiêu nơi ở mức `van`, và `src/lib/__tests__/pendingStrategies.test.ts` làm đỏ mọi
//   namespace mới chưa khai, để không nơi ghi nào lọt vào mà chưa ai quyết cách đối chiếu.
//
// CỘT
//   money     Lần ghi tạo hoặc đổi trạng thái một khoản tiền (phiếu, lần thu, hoá đơn, lương, lợi nhuận, cọc,
//             bàn giao, chốt sổ, sổ quỹ, hợp đồng). Danh mục và thiết lập (loại, mẫu in, ngưỡng, sổ nhận tiền)
//             là không.
//   reconcile A  chạy lại luôn: ghi lặp lại cho cùng kết quả.
//             B  gửi lại cùng mã yêu cầu: máy chủ chống trùng theo mã.
//             C  đọc trạng thái: đã ở đích thì xong, còn cũ thì chạy lại.
//             D  tra đúng bản ghi theo mã do trình duyệt sinh hoặc ràng buộc duy nhất.
//             van  chưa có cách tự đối chiếu: dùng hộp cảnh báo.
//   silent    Không mở hộp cảnh báo (trang công khai). Dấu vẫn chặn như cũ cho tới khi nơi gọi có đối chiếu đúng.
//   label     Tên việc để câu báo gọi được dấu cũ không lưu tên thao tác. Không chứa tên khách hay số tiền.
//
// BỐ CỤC
//   Các dòng xếp theo KHỐI TỪNG ĐỢT của plan sửa (tab «Plan từng nơi gọi»), mỗi khối một tiêu đề và cách
//   khối kế một dòng trống. Mỗi đợt chỉ sửa khối của mình (đổi `van` thành A/B/C/D, thêm dòng khi tách
//   khoá), để các đợt chạy song song không xung đột khi merge. Namespace có nơi gọi ở nhiều đợt nằm ở khối
//   của đợt đầu tiên, kèm ghi chú đợt nào còn đụng tới.
//
// Đợt 1 (24/11/2026) khai mọi namespace là `van`; mỗi đợt sau chuyển dần sang A/B/C/D khi nơi gọi có hàm
// đối chiếu thật.

export type PendingReconcile = 'A' | 'B' | 'C' | 'D' | 'van';
export interface PendingStrategy {
  money: boolean;
  reconcile: PendingReconcile;
  label: string;
  /** Không mở hộp cảnh báo cho namespace này: nơi ghi chạy tự động trên trang công khai, người xem không phải nhân viên. */
  silent?: boolean;
}

const tien = (reconcile: PendingReconcile, label: string): PendingStrategy => ({ money: true, reconcile, label });
const khac = (reconcile: PendingReconcile, label: string): PendingStrategy => ({ money: false, reconcile, label });

export const PENDING_STRATEGIES: Readonly<Record<string, PendingStrategy>> = {
  // Đợt 2: thu tiền, hoàn tác, hoàn trả (thu tiền hoá đơn dùng kho riêng `pendingCollection.ts`, không nằm ở sổ này)
  'collection-reversal': tien('B', 'hoàn tác lần thu'), // reverse_invoice_collection_v5 / undo_invoice_payment_compat_v1 chống trùng theo khoá
  'invoice-refund': tien('B', 'lập hoàn trả'), // create_invoice_refund_obligation_v2 trả replayed:true; chỉ gửi lại sau 2 phút
  'collection-tender-method': tien('B', 'đổi hình thức thu'), // change_collection_tender_method_v1 trả replayed:true
  'payment-receipt-upload': tien('C', 'thêm ảnh chứng từ thanh toán'), // ô ảnh của phiếu thanh toán đã có = đã gắn

  // Đợt 3: lập phiếu, cọc, phí (họ runFinancialPending)
  'voucher-form-create': tien('B', 'lập phiếu thu/chi'), // create_income_expense_v1 theo khoá; đường compat: mã phiếu do trình duyệt sinh (D); dấu cũ: tra gần đúng
  'voucher-batch-create': tien('D', 'tạo phiếu tổng'), // mã đợt = mã yêu cầu của dấu; dọn sạch sau lỗi từ chối rõ thì gỡ dấu
  'room-deposit-receipt': tien('D', 'thu cọc theo phòng'), // Tra đúng phiếu của mã yêu cầu, gửi lại cùng mã khi chưa ghi.
  'deposit-create': tien('B', 'tạo cọc giữ chỗ'), // create_room_reservation_v1 khoá phòng rồi tra khoá; thưởng Sale ngoài vùng giữ dấu
  'period-fee-pay': tien('A', 'đóng phí kỳ'), // pay_period_fee khoá slot rồi đếm phiếu; gửi lại KHÔNG ép, "đã có phiếu" = đã ghi
  'draft-fee-pay': tien('C', 'trả phiếu phí nháp'), // đọc trạng thái phiếu; pay_draft_fee_voucher khoá dòng, đòi còn nháp
  'period-fee-cancel': tien('A', 'huỷ phiếu phí kỳ'), // cancel_period_fee khoá dòng; "đã bị hủy trước đó" khi gửi lại = xong
  'utility-pay': tien('A', 'đóng điện nước'), // pay_utility_bill khoá công tơ × tháng, trùng ⇒ 55000 kèm mã phiếu
  'utility-cancel': tien('A', 'huỷ phiếu điện nước'), // như huỷ phiếu phí kỳ
  'special-fee-generate': tien('A', 'sinh phí đặc biệt'), // khoá theo kỳ, chỉ sinh ô còn thiếu (không trả kết quả cũ theo khoá)
  'reconciliation-propose': tien('D', 'đề nghị đối soát sổ'), // tra gần đúng (sổ, ngày, người đề nghị, sau giờ kẹt) tới đợt 10
  'invoice-cancel': tien('C', 'huỷ hoá đơn'), // huỷ hàng loạt (đợt 3) và huỷ lẻ (đợt 5) đọc trạng thái hoá đơn; cancel_invoice_with_credit_v1 khoá rồi trả noop

  // Đợt 4: tạo khách, khách hẹn, bàn giao. Bốn dòng `khac` không còn ghi dấu mới (luật 5: không khoá dữ liệu không phải
  // tiền); chỉ còn đọc MỘT LẦN dấu khoá chung bản trước để lại (`settleLegacyPending`), đối chiếu gần đúng rồi gỡ.
  'customer-create': khac('D', 'tạo khách hàng'), // mã khách do trình duyệt sinh, gửi lại cùng mã (khoá chính chặn khách thứ hai); xe hỏng = khách đã tạo, không dấu
  'customer-import': khac('D', 'nhập khách hàng từ Excel'), // mỗi dòng một mã khách; báo theo dòng; dòng chưa xong nhập lại đúng mã; bỏ dấu lồng với tạo khách
  'useCreateLead': khac('D', 'tạo khách hẹn'), // như tạo khách
  'handover-create': tien('A', 'lập phiên bàn giao tiền'), // create_cash_handover khoá phiếu FOR UPDATE rồi đòi handover_id rỗng; đọc phiên của phiếu trước khi gửi
  'income-expense-type-create': khac('D', 'tạo loại thu chi'), // ràng buộc duy nhất (công ty, chiều, tên chuẩn hoá); trùng ⇒ trả loại đã có

  // Đợt 5: chuyển trạng thái phiếu, hoá đơn, bàn giao, chốt sổ. Ba dấu chung (`voucher-lifecycle`, `handover-lifecycle`,
  // `closing-request-lifecycle`) được tách theo thao tác; dòng của dấu chung giữ `van`: không ai ghi dấu mới ở đó, dấu
  // cũ không cho biết thuộc thao tác nào nên chặn đúng bản ghi đó qua hộp cảnh báo (`legacy` của nơi gọi mới).
  'voucher-lifecycle': tien('van', 'duyệt, huỷ hoặc khôi phục phiếu thu chi'), // dấu chung bản trước của 7 thao tác phiếu; chỉ còn đọc
  'voucher-approve': tien('A', 'duyệt phiếu'), // approve_pending_income_expense_checked_v1 khoá phiếu rồi trả `already`
  'voucher-unapprove': tien('C', 'bỏ duyệt phiếu'), // unapprove_voucher không xét trạng thái hiện tại: so trạng thái trước khi bấm, chờ 2 phút
  'voucher-cancel': tien('C', 'huỷ phiếu'), // thang huỷ cũ nhiều bước: đã hoàn tác mà chưa huỷ thì chỉ chạy bước huỷ
  'voucher-restore': tien('C', 'khôi phục phiếu'), // restore_income_expense không khoá dòng: chỉ gửi lại sau 2 phút
  'voucher-verify': tien('C', 'cập nhật trạng thái đã kiểm'), // nút bật/tắt: trạng thái đã đổi so với lúc bấm thì không gửi lần hai
  'voucher-flex-cancel': tien('A', 'huỷ phiếu'), // cancel_income_expense_flex_v1 khoá phiếu rồi trả {changed:false}
  'voucher-income-cancel': tien('A', 'huỷ phiếu thu'), // cancel_income_voucher_v1 khoá phiếu rồi trả {changed:false}
  'voucher-v2-approve': tien('B', 'duyệt phiếu'), // khoá phiếu rồi tra mã yêu cầu (finance_v2_begin_canonical_op); nội dung đổi ⇒ đọc trạng thái
  'voucher-v2-post': tien('B', 'ghi sổ phiếu'),
  'voucher-v2-approve-post': tien('B', 'duyệt và ghi sổ phiếu'),
  'voucher-v2-reverse': tien('B', 'hoàn tác ghi sổ phiếu'), // ngày ghi là hôm nay: qua ngày là nội dung khác ⇒ đọc trạng thái
  'approval-request': tien('C', 'xử lý yêu cầu duyệt'), // đọc trạng thái + phiên bản + bước của yêu cầu; rút đề nghị là mã chết, xoá ở đợt 11
  'handover-lifecycle': tien('van', 'xác nhận hoặc huỷ phiên bàn giao tiền'), // dấu chung bản trước của 4 thao tác bàn giao; chỉ còn đọc
  'handover-confirm': tien('C', 'xác nhận nhận bàn giao'), // bốn hàm bàn giao khoá phiên FOR UPDATE rồi mới xét trạng thái
  'handover-cancel-request': tien('C', 'xin huỷ phiên bàn giao'),
  'handover-cancel-confirm': tien('C', 'đồng ý huỷ phiên bàn giao'),
  'handover-cancel-reject': tien('C', 'từ chối huỷ phiên bàn giao'),
  'invoice-restore': tien('C', 'khôi phục hoá đơn'), // khoá hoá đơn rồi trả noop
  'invoice-force-cancel': tien('C', 'buộc huỷ hoá đơn'),
  'closing-propose': tien('C', 'gửi đề nghị chốt sổ'), // mỗi sổ một đề nghị chờ (CLOSURE_PENDING dưới khoá sổ): đọc danh sách
  'closing-request-lifecycle': tien('van', 'xác nhận hoặc huỷ đề nghị chốt sổ'), // dấu chung bản trước của xác nhận và huỷ; chỉ còn đọc
  'closing-confirm': tien('C', 'xác nhận chốt sổ'), // còn chờ ⇒ gửi lại; đã có biên bản đúng ngày ⇒ báo
  'closing-cancel': tien('A', 'huỷ đề nghị chốt sổ'), // cancel_cashbook_closing_v1 khoá rồi trả {changed:false}
  'voucher-batch-cancel': tien('A', 'huỷ đợt phiếu'), // đọc lại phiếu còn hiệu lực, huỷ phần còn (sau 2 phút: đường phiếu chi không xét đã huỷ)
  'cashbook-lifecycle': tien('van', 'sửa hoặc lưu trữ sổ quỹ'), // dấu chung bản trước; đợt 8: sửa sổ không ghi dấu mới (A, update_cashbook_metadata_v1 đặt giá trị, từ chối sổ đã lưu trữ), sửa thành công gỡ dấu của đúng sổ; lưu trữ (`cashbook-archive`) vẫn đọc dấu này qua `legacy`
  'cashbook-archive': tien('C', 'lưu trữ sổ quỹ'), // archive_cashbook_v1 khoá sổ chưa lưu trữ rồi mới xét

  // Đợt 6: lương, tạo và gia hạn hợp đồng, lợi nhuận, sổ quỹ. Các hàm máy chủ đều khoá (công ty / dòng / khoá tư vấn theo
  // mã) TRƯỚC khi tra mã yêu cầu (production 25/11/2026), nên gửi lại cùng mã ngay cũng không ghi hai lần. Dấu bản trước
  // của form sổ quỹ (`cashbook-form`) bị bỏ: hai lệnh con tự giữ dấu, phân quyền sổ gửi mã ổn định.
  'salary-payout': tien('B', 'lập phiếu chi lương'), // salary_payout_v1 khoá công ty rồi tra mã; không băm sổ quỹ, ngày, ghi chú ⇒ không cho đổi khi đối chiếu
  'profit-payout': tien('B', 'lập phiếu chi lương điều hành'), // manager_salary_payout_v1 khoá công ty rồi tra mã; không băm ghi chú
  'salary-lock': tien('B', 'chốt bảng lương'), // lock_salary_month_v2 khoá công ty rồi tra mã; gửi lại không rơi sang nhánh ghi cũ
  'salary-unlock': tien('C', 'mở khoá bảng lương'), // đọc trạng thái tháng; còn dòng khoá ⇒ gửi lại cùng mã (unlock_salary_month_v2 khoá công ty rồi tra mã)
  'salary-adjustment': tien('D', 'lưu thưởng hoặc trừ lương'), // sửa: chạy lại (A); thêm: mã khoản = mã của dấu, khoá chính chặn khoản thứ hai; dấu bản trước tra gần đúng tới đợt 10
  'contract-create': tien('B', 'tạo hợp đồng'), // create_contract_v2 khoá phòng + công ty rồi tra mã; 23505 khi gửi lại ⇒ đọc hợp đồng hiệu lực của phòng
  'contract-renew': tien('B', 'gia hạn hợp đồng'), // apply_contract_notice_transition_v1 khoá công ty + hợp đồng rồi tra mã; đọc sự kiện theo mã trước khi gửi lại
  'contract-notice-transition': tien('B', 'gia hạn hoặc chuyển phòng hợp đồng'), // đợt 7: chuyển phòng đọc sự kiện theo mã rồi gửi lại cùng mã (apply_contract_notice_transition_v1 khoá công ty + phòng + hợp đồng rồi tra mã); dấu gia hạn bản trước: sự kiện có ⇒ báo đã ghi, vẫn chặn gia hạn qua `legacy`
  'cashbook-create': tien('B', 'tạo sổ quỹ'), // create_cashbook_v1 khoá công ty rồi tra mã; không băm mô tả, sổ mặc định, toà mặc định ⇒ không cho đổi khi đối chiếu
  'cashbook-reopening': tien('B', 'mở lại sổ quỹ'), // đọc lịch sử theo mã; chưa có ⇒ gửi lại cùng mã (reopen_cashbook_v1 khoá sổ + khoá tư vấn theo mã)
  'voucher-batch-account': tien('A', 'đổi sổ đợt phiếu'), // revise_pending_income_expense_v1 khoá phiếu rồi so phiên bản; vòng bỏ qua phiếu đã đúng sổ
  'profit-close': tien('van', 'chốt lợi nhuận'), // dấu chung bản trước của chốt lần đầu và chốt lại (mã máy chủ không nằm trong dấu); chỉ còn đọc
  'profit-first-close': tien('B', 'chốt lợi nhuận lần đầu'), // _profit_write_close_v2_base khoá tư vấn theo mã rồi tra profit_close_runs
  'profit-reclose': tien('B', 'chốt lại lợi nhuận'),
  'profit-unlock': tien('B', 'mở khoá lợi nhuận'), // mã máy chủ suy từ mã của dấu; dấu bản trước (mã ngẫu nhiên) ⇒ hộp cảnh báo
  'profit-reset': tien('B', 'đặt lại lợi nhuận'),

  // Đợt 7: hợp đồng, chuyển khách hẹn, tạm trú (chuyển phòng ở dòng `contract-notice-transition` của khối đợt 6). Sửa hợp
  // đồng dùng kho riêng `contractEditWorkflow.ts` (cách A, nối hộp cảnh báo chung), không nằm ở sổ này. Dấu chuyển khách hẹn
  // bản trước (`lead-conversion`) chỉ còn được hộp chuyển khách hẹn đọc một lần; `tenant-legacy-create` bỏ cùng hook chết.
  'contract-signing': tien('B', 'ký hợp đồng'), // sign_and_checkin_contract_draft_v1 khoá phòng + công ty + nháp rồi tra lần ký theo nháp (một lần ký mỗi nháp)
  'contract-excel-import': tien('D', 'nhập hợp đồng từ Excel'), // dòng chưa rõ: tra hợp đồng hiệu lực của phòng (contracts_one_active_per_room_uq); mỗi dòng độc lập
  'residence-registration-save': khac('A', 'lưu mã hồ sơ tạm trú'), // upsert theo (công ty, mã hồ sơ), không ghi dấu mới; dấu bản trước gỡ sau lần lưu kế tiếp
  'ct01-declaration-create': khac('D', 'tạo tờ khai CT01'), // mã tờ khai do trình duyệt sinh, gửi lại cùng mã; không ghi dấu mới; dấu bản trước tra gần đúng một lần

  // Đợt 8: dữ liệu ghi lặp lại được. Dòng `khac` ở khối này không ghi dấu mới (luật 5): kết quả chưa rõ thì báo rõ và cho
  // bấm lại (`repeatableWrite`); dấu bản trước của đúng bản ghi gỡ sau lần ghi xong (`forgetLegacyPending`). Hai dòng `tien`
  // (sinh phiếu định kỳ, cờ KQKD) vẫn giữ dấu nhưng hàm đối chiếu luôn cho gửi lại ngay (máy chủ khoá rồi mới xét).
  'public-room-admin': khac('A', 'lưu link và cài đặt phòng công khai'), // link: không dấu; tạo chưa rõ ⇒ lần sau tìm link vừa tạo (báo mã), thu hồi chưa rõ ⇒ đọc lại trạng thái rồi gửi; nhãn gửi đã cắt (btrim chỉ cắt dấu cách). Cài đặt (usePublicRoomSettings) giữ dấu, chạy lại theo CAS
  'customer-update': khac('A', 'cập nhật khách hàng'), // sửa theo mã; xe chưa có mã khớp xe hiện có theo biển số chuẩn hoá khi lưu lại; xe dở = khách đã cập nhật, lưu lại
  'customer-delete': khac('C', 'xoá khách hàng'), // đọc deleted_at trước; soft_delete_customer khoá khách còn sống, 42501 + đã xoá = thành công
  'useUpdateLead': khac('A', 'cập nhật khách hẹn'), // sửa theo mã; khớp 0 dòng = PGRST116, từ chối rõ
  'useDeleteLead': khac('A', 'xoá khách hẹn'), // xoá mềm dòng còn sống; khớp 0 dòng ⇒ settleZeroRowDelete
  'lead-activity-create': khac('D', 'thêm hoạt động khách hẹn'), // mã do trình duyệt sinh (insertWithClientId), bấm lại cùng nội dung gửi đúng mã cũ (nhớ theo tab)
  'lead-activity-delete': khac('A', 'xoá hoạt động khách hẹn'), // xoá theo mã; khớp 0 dòng ⇒ settleZeroRowDelete
  'useUpdateMeterReading': khac('A', 'cập nhật chỉ số'), // UPDATE thẳng bảng, đặt giá trị tuyệt đối, chỉ trigger BEFORE; hoá đơn chỉ đọc chỉ số lúc lập
  'useDeleteMeterReading': khac('A', 'xoá chỉ số'), // xoá mềm dòng còn sống; khớp 0 dòng ⇒ settleZeroRowDelete
  'useBulkDeleteMeterReadings': khac('A', 'xoá chỉ số hàng loạt'), // mã thiếu trong biên nhận được đọc lại; mã lạ = chưa rõ
  'service-update': khac('A', 'cập nhật dịch vụ'), // đặt giá trị + đồng bộ toà áp dụng theo phần chênh, đọc lại mỗi lần
  'quota-update': khac('A', 'cập nhật định mức'), // xoá rồi chèn lại bậc (duy nhất quota_id+tier_number); khoảng thiếu bậc chờ hàm nguyên tử đợt 10
  'building-services-replace': khac('A', 'lưu dịch vụ mặc định của toà'), // xoá rồi chèn lại (duy nhất building_id+service_id); nguyên tử ở đợt 10
  'area-write': khac('van', 'lưu khu vực'), // sửa, gán toà, xoá: đợt 8 không ghi dấu (A; xoá mềm khu còn sống, gỡ toà khớp thiếu cặp ⇒ đọc lại); TẠO khu vực (khoá new) còn dấu tới đợt 9
  'vehicle-update': khac('A', 'cập nhật xe'), // sửa theo mã; khớp 0 dòng = PGRST116, từ chối rõ
  'vehicle-delete': khac('A', 'xoá xe'), // xoá mềm xe còn sống; khớp 0 dòng ⇒ đọc lại (đã xoá = xong, còn nguyên = không có quyền)
  'material-purchase': khac('van', 'lưu phiếu nhập vật tư'), // sửa phiếu nhập (khoá update:<id>): đợt 8 không ghi dấu (A; tổng, tồn, giá vốn do trigger tính lại từ mọi dòng; dấu bản trước gỡ sau lần sửa xong); TẠO phiếu nhập (khoá create) còn dấu tới đợt 9
  'material-job-usage': khac('A', 'lưu vật tư của công việc'), // không ghi dấu; xoá rồi chèn lại toàn bộ dòng, tồn do trigger tính lại; một phiếu mỗi công việc (uq_material_usages_job); nguyên tử ở đợt 10
  'income-expense-type-update': khac('A', 'cập nhật loại thu chi'), // sửa theo mã, đặt giá trị; khớp 0 dòng = từ chối rõ
  'income-expense-type-delete': khac('A', 'xoá loại thu chi'), // khớp 0 dòng ⇒ đọc lại: không còn = đã xoá, còn = không có quyền
  'income-expense-template-update': khac('A', 'cập nhật mẫu in thu chi'), // như sửa loại
  'income-expense-template-delete': khac('A', 'xoá mẫu in thu chi'), // xoá mềm mẫu còn sống; khớp 0 dòng ⇒ đọc lại
  'income-expense-template-default': khac('C', 'đặt mẫu in thu chi mặc định'), // mỗi lần đọc nhóm mẫu, chỉ làm phần còn thiếu; không ghi dấu
  'voucher-recurring-stop': khac('A', 'ngừng lặp phiếu'), // ie_stop_recurring_v1 khoá phiếu FOR UPDATE, đã dừng ⇒ changed:false; không ghi dấu
  'voucher-recurring-generate': tien('A', 'sinh phiếu định kỳ'), // generate_recurring_vouchers chỉ sinh kỳ chưa có phiếu con (uniq_ie_repeat_child_date); giữ dấu, gửi lại ngay
  'voucher-kqkd': tien('A', 'đổi cờ KQKD của phiếu bỏ cọc'), // set_forfeit_voucher_kqkd_v1 khoá phiếu rồi so cờ, đã đúng ⇒ changed:false; giữ dấu, gửi lại ngay
  'auto-approve-threshold': khac('A', 'lưu ngưỡng tự duyệt phiếu'), // set_ie_auto_approve_threshold_v1 upsert tuyệt đối theo công ty; không ghi dấu
  'receiving-personal': khac('A', 'lưu sổ tiền mặt riêng'), // set_personal_cash_book_v1 khoá công ty + dòng hiệu lực, chỉ đổi khi khác; không ghi dấu
  'receiving-building': khac('A', 'lưu sổ nhận tiền của toà'), // set_building_receiving_cashbooks_v1 khoá công ty, đặt cả bộ trong một giao dịch; không ghi dấu
  'shareholder-sync': khac('A', 'lưu tỷ lệ cổ đông'), // xoá toà bỏ đi + upsert theo (toà, cổ đông), tỷ lệ tuyệt đối; không ghi dấu; chưa nguyên tử (đợt 10)
  'profit-manager-save': khac('D', 'lưu quản lý và lương điều hành'), // sửa: A (hồ sơ theo mã, xoá rồi tạo lại cả bộ quy tắc); thêm: tra theo tài khoản (profit_managers.auth_user_id duy nhất); không ghi dấu
  'shareholder-save': khac('D', 'lưu cổ đông'), // bỏ dấu lồng; sửa theo mã (A), thêm tra theo tài khoản (shareholders.auth_user_id duy nhất)

  // Đợt 9: tạo mới ở màn thiết lập, nhập Excel, Quay số
  'room-create': khac('van', 'tạo phòng'),
  'meter-create': khac('van', 'tạo công tơ'),
  'building-create': khac('van', 'tạo toà nhà'),
  'building-form-save': khac('van', 'lưu toà nhà'),
  'building-owner-form-save': khac('van', 'lưu toà nhà và chủ sở hữu'),
  'vehicle-create': khac('van', 'tạo xe'),
  'asset-create': khac('van', 'tạo tài sản'),
  'asset-handover-create': khac('van', 'tạo biên bản bàn giao tài sản'),
  'asset-movement-create': khac('van', 'ghi di chuyển tài sản'),
  'asset-maintenance-create': khac('van', 'tạo phiếu bảo trì tài sản'),
  'service-create': khac('van', 'tạo dịch vụ'),
  'quota-create': khac('van', 'tạo định mức'),
  'material-adjustment': khac('van', 'kiểm kê vật tư'), // tạo phiếu kiểm kê và đặt tồn kho chung một dấu
  'material-adjustment-batch': khac('van', 'kiểm kê nhiều vật tư'),
  'material-manual-usage': khac('van', 'tạo phiếu xuất vật tư'),
  'income-expense-template-create': khac('van', 'tạo mẫu in thu chi'),
  'voucher-excel-import': tien('van', 'nhập thu chi từ Excel'),
  'useImportMeterReadings': khac('van', 'nhập chỉ số từ Excel'),
  'useBulkCreateMeterReadings': khac('van', 'tạo chỉ số hàng loạt'),
  // Viết thẳng, KHÔNG trải (`...khac(...)`): phép trải ở cấp tệp làm Rollup coi cả sổ là có tác dụng phụ, nên mọi chunk dính tới
  // bộ chống ghi trùng phải nạp riêng sổ này (đợt 8 đo: chunk sổ tách riêng, bảng nạp trước của chunk entry vượt ngưỡng).
  'lucky-public-draw': { money: false, reconcile: 'van', label: 'quay số', silent: true }, // trang công khai tự gọi khi mở; người xem ẩn danh không được thấy hộp gỡ khoá
  'lucky-admin': khac('van', 'thao tác quản trị Quay số'), // 9 thao tác quản trị Quay số chung một dấu

  // Đợt 11: mã chết, xoá cùng nơi gọi
  'copilot-confirmation': tien('van', 'xác nhận thao tác của trợ lý Hermes'),
  'invoice-approve': tien('van', 'duyệt hoá đơn'),
  'invoice-unapprove': tien('van', 'bỏ duyệt hoá đơn'),
  'useCreateMeterReading': khac('van', 'tạo chỉ số'),
  'useApproveMeterReading': khac('van', 'duyệt chỉ số'),
  'useBulkApproveMeterReadings': khac('van', 'duyệt chỉ số hàng loạt'),
  'useUnapproveMeterReading': khac('van', 'bỏ duyệt chỉ số'),
  'room-bulk-create': khac('van', 'tạo nhiều phòng'),
  'shareholder-account-link': khac('van', 'tạo tài khoản cổ đông'),

  // Đã đúng theo plan: không đợt nào sửa nơi gọi; vẫn khai `van` cho tới khi được xác nhận lại
  'profit-ledger-advance': tien('van', 'ghi tạm ứng lợi nhuận'),
  'profit-ledger-settle': tien('van', 'chốt chi lợi nhuận'),
  'profit-ledger-settle-void': tien('van', 'huỷ chốt chi lợi nhuận'),
  'profit-ledger-cancel': tien('van', 'huỷ khoản trong sổ lợi nhuận'),
  'profit-ledger-marker': tien('van', 'đặt mốc sổ lợi nhuận'),
  'profit-ledger-salary-resolve': tien('van', 'xử lý lương trong sổ lợi nhuận'),
  'shared-fund': tien('van', 'ghi quỹ chung'),
  'residence-dossier-upload': khac('van', 'tải ảnh hồ sơ tạm trú'),
  'residence-dossier-term': khac('van', 'lưu hạn hợp đồng của ảnh hồ sơ'),
  'residence-dossier-remove': khac('van', 'xoá ảnh hồ sơ tạm trú'),
};

export function pendingStrategyOf(namespace: string): PendingStrategy | undefined {
  return Object.prototype.hasOwnProperty.call(PENDING_STRATEGIES, namespace) ? PENDING_STRATEGIES[namespace] : undefined;
}
