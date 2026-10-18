// Hermes-only keys have no CRM catalog entry and need their own label. CRM keys
// keep the shared catalog label; a hint states where the Hermes tool is
// narrower than the CRM page. Display text only: never a grant or a choice.
const LABELS: Readonly<Record<string, string>> = Object.freeze({
  'assistant.context.read': 'Xem thông tin phiên và quyền của tôi',
  'assistant.memory.read': 'Xem ghi nhớ công việc CRM được phép',
  'assistant.memory.write': 'Lưu, sửa và quên ghi nhớ công việc CRM của tôi',
  'assistant.memory.supervise': 'Hermes tổng: tra ghi nhớ công việc được chia sẻ của người khác (theo quyền xem người dùng)',
  // Đợt 2: web không có khoá catalog cho hai màn này.
  'assistant.salary.self': 'Xem lương của tôi (như trang Lương của tôi)',
  'assistant.bank_events.read': 'Xem biến động số dư (chỉ super admin, như trang Biến động số dư)',
});
const HINTS: Readonly<Record<string, string>> = Object.freeze({
  'tasks.edit': 'Hermes: ghi cập nhật tiến độ công việc (theo dõi/nhắc dùng Xem + Tạo công việc)',
  'tasks.delete': 'Hermes: huỷ công việc khi bạn yêu cầu rõ',
  'customers.create': 'Hermes: tạo khách cá nhân chưa gắn tòa; cần phạm vi Toàn tổ chức',
  'leads.create': 'Hermes: tạo khách hẹn mới chưa gắn tòa; cần phạm vi Toàn tổ chức',
  'income_expenses.create': 'Hermes: ghi phiếu CHI nhanh; thang duyệt CRM quyết trạng thái, Hermes không duyệt hay vào sổ',
  'income_expenses.approve': 'Hermes: chỉ cho phiếu chi Hermes ghi được duyệt ngay bằng quyền duyệt của bạn; không có công cụ duyệt',
  'income_expenses.view': 'Hermes: tra phiếu thu/chi, không gồm hạng mục hạn chế, lương, cổ đông',
  'meter_readings.view': 'Hermes: tra chỉ số công tơ theo ngày đọc',
  'deposits.view': 'Hermes: chỉ tổng cọc đang giữ theo tòa, không có chi tiết khách',
  'reports_finance.analysis': 'Hermes: lãi lỗ theo tòa trong kỳ tối đa 366 ngày',
  // Đợt 2 (báo cáo qua mục lục crm_read_report_list): đúng phần web cho bạn xem, giao phạm vi kết nối.
  'reports_finance.payment_schedule': 'Hermes: lịch thanh toán hoá đơn theo tòa được chọn',
  'reports_finance.overpayment': 'Hermes: hoá đơn thu thừa theo tòa được chọn',
  'reports_finance.deposits_report': 'Hermes: báo cáo cọc theo tòa được chọn',
  'thu_tien.view': 'Hermes: thu tiền theo kỳ (đã thu, còn nợ, người thu)',
  'reports_finance.daily_cashbook': 'Hermes: sổ quỹ theo ngày của sổ bạn được xem',
  'reports_finance.cash_flow': 'Hermes: dòng tiền theo tháng, quý',
  'reports_finance.handover_report': 'Hermes: báo cáo bàn giao tiền',
  'reports_finance.collection_cycle': 'Hermes: thu và bàn giao theo chu kỳ',
  'cashbooks.view': 'Hermes: sổ quỹ và chốt sổ bạn được xem; không trả số tài khoản',
  'income_expenses.restricted_view': 'Hermes: lãi lỗ có khoản hạn chế (Hiệu quả kinh doanh) như web',
  'reports_finance.profit_distribution': 'Hermes: BC Doanh thu chi phí, phân bổ lợi nhuận như web',
  'shareholder_profit.view': 'Hermes: lợi nhuận cổ đông đúng phần web cho bạn xem',
  'personal_finance.view': 'Hermes: ví cá nhân của chính bạn',
  'vehicles.view': 'Hermes: tra xe; tên, SĐT chủ xe cần quyền xem khách hàng',
  'materials.view': 'Hermes: kho vật tư (tồn, nhập, xuất, kiểm kê)',
  'warehouses.view': 'Hermes: danh mục kho tài sản',
  'salary.view': 'Hermes: lương người khác khi web cho bạn xem bảng lương',
  'notifications.view': 'Hermes: thông báo của chính bạn',
  'network_center.view': 'Hermes: Network Center (router, cổng, sự cố, thiết bị); tên khách cần quyền xem khách hàng',
  'buildings.view': 'Hermes: tòa, khu, tầng',
  'meters.view': 'Hermes: danh sách công tơ',
  'suppliers.view': 'Hermes: tên nhà cung cấp, không SĐT/địa chỉ',
  'hotline.view': 'Hermes: hotline nội bộ',
  'task_types.view': 'Hermes: loại công việc, không thưởng/lương',
  'service_quotas.view': 'Hermes: định mức dịch vụ',
  'categories.view': 'Hermes: loại thu chi, ẩn hạng mục hạn chế, lương, cổ đông',
  'reports_real_estate.vacant_rooms': 'Hermes: báo cáo phòng trống',
  'reports_real_estate.expiring': 'Hermes: báo cáo hợp đồng sắp hết hạn',
  'reports_real_estate.renewals_transfers': 'Hermes: báo cáo gia hạn, nhượng',
  'reports_real_estate.promotions': 'Hermes: báo cáo khuyến mãi',
  'reports_real_estate.new_leases': 'Hermes: báo cáo hợp đồng mới',
  'reports_real_estate.terminations': 'Hermes: báo cáo thanh lý',
  'reports_real_estate.expense_ratio': 'Hermes: báo cáo tỷ lệ chi phí',
});
const own = (map: Readonly<Record<string, string>>, key: string) => Object.prototype.hasOwnProperty.call(map, key);
export const hermesCapabilityLabel = (key: string): string => (own(LABELS, key) ? LABELS[key] : key);
export const hermesCapabilityHint = (key: string): string | undefined => (own(HINTS, key) ? HINTS[key] : undefined);
