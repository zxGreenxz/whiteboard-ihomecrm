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
  'deposit-create': tien('B', 'tạo cọc giữ chỗ'), // create_room_reservation_v1 khoá phòng rồi tra khoá; thưởng Sale ngoài vùng giữ dấu
  'period-fee-pay': tien('A', 'đóng phí kỳ'), // pay_period_fee khoá slot rồi đếm phiếu; gửi lại KHÔNG ép, "đã có phiếu" = đã ghi
  'draft-fee-pay': tien('C', 'trả phiếu phí nháp'), // đọc trạng thái phiếu; pay_draft_fee_voucher khoá dòng, đòi còn nháp
  'period-fee-cancel': tien('A', 'huỷ phiếu phí kỳ'), // cancel_period_fee khoá dòng; "đã bị hủy trước đó" khi gửi lại = xong
  'utility-pay': tien('A', 'đóng điện nước'), // pay_utility_bill khoá công tơ × tháng, trùng ⇒ 55000 kèm mã phiếu
  'utility-cancel': tien('A', 'huỷ phiếu điện nước'), // như huỷ phiếu phí kỳ
  'special-fee-generate': tien('A', 'sinh phí đặc biệt'), // khoá theo kỳ, chỉ sinh ô còn thiếu (không trả kết quả cũ theo khoá)
  'reconciliation-propose': tien('D', 'đề nghị đối soát sổ'), // tra gần đúng (sổ, ngày, người đề nghị, sau giờ kẹt) tới đợt 10
  'invoice-cancel': tien('van', 'huỷ hoá đơn'), // huỷ hàng loạt đã đối chiếu cách C (đợt 3); huỷ lẻ (useCancelInvoice) chưa có hàm đối chiếu, đợt 5 đổi dòng này

  // Đợt 4: tạo khách, khách hẹn, bàn giao
  'customer-create': khac('van', 'tạo khách hàng'),
  'customer-import': khac('van', 'nhập khách hàng từ Excel'),
  'useCreateLead': khac('van', 'tạo khách hẹn'),
  'handover-create': tien('van', 'lập phiên bàn giao tiền'),
  'income-expense-type-create': khac('van', 'tạo loại thu chi'),

  // Đợt 5: chuyển trạng thái phiếu, hoá đơn, bàn giao, chốt sổ
  'voucher-lifecycle': tien('van', 'duyệt, huỷ hoặc khôi phục phiếu thu chi'), // 7 thao tác phiếu chung một dấu: statusMutations, flexMutations, incomeVoucherCancel
  'voucher-v2-approve': tien('van', 'duyệt phiếu'),
  'voucher-v2-post': tien('van', 'ghi sổ phiếu'),
  'voucher-v2-approve-post': tien('van', 'duyệt và ghi sổ phiếu'),
  'voucher-v2-reverse': tien('van', 'hoàn tác ghi sổ phiếu'),
  'approval-request': tien('van', 'xử lý yêu cầu duyệt'), // quyết định ở đợt 5; rút đề nghị là mã chết, xoá ở đợt 11
  'handover-lifecycle': tien('van', 'xác nhận hoặc huỷ phiên bàn giao tiền'), // 4 thao tác bàn giao chung một dấu
  'invoice-restore': tien('van', 'khôi phục hoá đơn'),
  'invoice-force-cancel': tien('van', 'buộc huỷ hoá đơn'),
  'closing-propose': tien('van', 'gửi đề nghị chốt sổ'),
  'closing-request-lifecycle': tien('van', 'xác nhận hoặc huỷ đề nghị chốt sổ'), // xác nhận và huỷ chung một dấu
  'voucher-batch-cancel': tien('van', 'huỷ đợt phiếu'),
  'cashbook-lifecycle': tien('van', 'sửa hoặc lưu trữ sổ quỹ'), // lưu trữ sổ ở đợt 5; sửa sổ ở đợt 8

  // Đợt 6: lương, tạo và gia hạn hợp đồng, lợi nhuận, sổ quỹ
  'salary-payout': tien('van', 'lập phiếu chi lương'),
  'profit-payout': tien('van', 'lập phiếu chi lương điều hành'),
  'salary-lock': tien('van', 'chốt bảng lương'),
  'salary-unlock': tien('van', 'mở khoá bảng lương'),
  'salary-adjustment': tien('van', 'lưu thưởng hoặc trừ lương'),
  'contract-create': tien('van', 'tạo hợp đồng'),
  'contract-notice-transition': tien('van', 'gia hạn hoặc chuyển phòng hợp đồng'), // gia hạn ở đợt 6; chuyển phòng ở đợt 7
  'cashbook-create': tien('van', 'tạo sổ quỹ'),
  'cashbook-reopening': tien('van', 'mở lại sổ quỹ'),
  'cashbook-form': tien('van', 'lưu sổ quỹ'),
  'voucher-batch-account': tien('van', 'đổi sổ đợt phiếu'),
  'profit-close': tien('van', 'chốt lợi nhuận'),
  'profit-unlock': tien('van', 'mở khoá lợi nhuận'),
  'profit-reset': tien('van', 'đặt lại lợi nhuận'),

  // Đợt 7: hợp đồng, chuyển khách hẹn, tạm trú
  'contract-signing': tien('van', 'ký hợp đồng'),
  'contract-excel-import': tien('van', 'nhập hợp đồng từ Excel'),
  'lead-conversion': tien('van', 'chuyển khách hẹn thành cọc'),
  'tenant-legacy-create': khac('van', 'tạo khách thuê'),
  'residence-registration-save': khac('van', 'lưu mã hồ sơ tạm trú'),
  'ct01-declaration-create': khac('van', 'tạo tờ khai CT01'),

  // Đợt 8: dữ liệu ghi lặp lại được
  'public-room-admin': khac('van', 'lưu link và cài đặt phòng công khai'), // link công khai ở đợt 8; cài đặt phòng công khai (usePublicRoomSettings) đã đúng
  'customer-update': khac('van', 'cập nhật khách hàng'),
  'customer-delete': khac('van', 'xoá khách hàng'),
  'useUpdateLead': khac('van', 'cập nhật khách hẹn'),
  'useDeleteLead': khac('van', 'xoá khách hẹn'),
  'lead-activity-create': khac('van', 'thêm hoạt động khách hẹn'),
  'lead-activity-delete': khac('van', 'xoá hoạt động khách hẹn'),
  'useUpdateMeterReading': khac('van', 'cập nhật chỉ số'),
  'useDeleteMeterReading': khac('van', 'xoá chỉ số'),
  'useBulkDeleteMeterReadings': khac('van', 'xoá chỉ số hàng loạt'),
  'service-update': khac('van', 'cập nhật dịch vụ'),
  'quota-update': khac('van', 'cập nhật định mức'),
  'building-services-replace': khac('van', 'lưu dịch vụ mặc định của toà'),
  'area-write': khac('van', 'lưu khu vực'), // sửa, gán toà, xoá ở đợt 8; tạo khu vực ở đợt 9
  'vehicle-update': khac('van', 'cập nhật xe'),
  'vehicle-delete': khac('van', 'xoá xe'),
  'material-purchase': khac('van', 'lưu phiếu nhập vật tư'), // sửa phiếu nhập ở đợt 8; tạo phiếu nhập ở đợt 9
  'material-job-usage': khac('van', 'lưu vật tư của công việc'),
  'income-expense-type-update': khac('van', 'cập nhật loại thu chi'),
  'income-expense-type-delete': khac('van', 'xoá loại thu chi'),
  'income-expense-template-update': khac('van', 'cập nhật mẫu in thu chi'),
  'income-expense-template-delete': khac('van', 'xoá mẫu in thu chi'),
  'income-expense-template-default': khac('van', 'đặt mẫu in thu chi mặc định'),
  'voucher-recurring-stop': khac('van', 'ngừng lặp phiếu'),
  'voucher-recurring-generate': tien('van', 'sinh phiếu định kỳ'),
  'voucher-kqkd': tien('van', 'đổi cờ KQKD của phiếu bỏ cọc'),
  'auto-approve-threshold': khac('van', 'lưu ngưỡng tự duyệt phiếu'),
  'receiving-personal': khac('van', 'lưu sổ tiền mặt riêng'),
  'receiving-building': khac('van', 'lưu sổ nhận tiền của toà'),
  'shareholder-sync': khac('van', 'lưu tỷ lệ cổ đông'),
  'profit-manager-save': khac('van', 'lưu quản lý và lương điều hành'),
  'shareholder-save': khac('van', 'lưu cổ đông'),

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
  'lucky-public-draw': { ...khac('van', 'quay số'), silent: true }, // trang công khai tự gọi khi mở; người xem ẩn danh không được thấy hộp gỡ khoá
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
