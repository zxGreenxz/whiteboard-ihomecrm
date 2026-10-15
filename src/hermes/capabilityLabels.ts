// Hermes-only keys have no CRM catalog entry and need their own label. CRM keys
// keep the shared catalog label; a hint states where the Hermes tool is
// narrower than the CRM page. Display text only: never a grant or a choice.
const LABELS: Readonly<Record<string, string>> = Object.freeze({
  'assistant.context.read': 'Xem thông tin phiên và quyền của tôi',
  'assistant.memory.read': 'Xem ghi nhớ công việc CRM được phép',
  'assistant.memory.write': 'Lưu, sửa và quên ghi nhớ công việc CRM của tôi',
  'assistant.memory.supervise': 'Hermes tổng: tra ghi nhớ công việc được chia sẻ của người khác (theo quyền xem người dùng)',
});
const HINTS: Readonly<Record<string, string>> = Object.freeze({
  'tasks.edit': 'Hermes: theo dõi, nhắc và cập nhật tiến độ công việc',
  'tasks.delete': 'Hermes: huỷ công việc khi bạn yêu cầu rõ',
  'customers.create': 'Hermes: tạo khách cá nhân chưa gắn tòa; cần phạm vi Toàn tổ chức',
  'leads.create': 'Hermes: tạo khách hẹn mới chưa gắn tòa; cần phạm vi Toàn tổ chức',
  'income_expenses.create': 'Hermes: ghi phiếu CHI nhanh; thang duyệt CRM quyết trạng thái, Hermes không duyệt hay vào sổ',
  'income_expenses.approve': 'Hermes: chỉ cho phiếu chi Hermes ghi được duyệt ngay bằng quyền duyệt của bạn; không có công cụ duyệt',
  'income_expenses.view': 'Hermes: tra phiếu thu/chi, không gồm hạng mục hạn chế, lương, cổ đông',
  'meter_readings.view': 'Hermes: tra chỉ số công tơ theo ngày đọc',
  'deposits.view': 'Hermes: chỉ tổng cọc đang giữ theo tòa, không có chi tiết khách',
  'reports_finance.analysis': 'Hermes: lãi lỗ theo tòa trong kỳ tối đa 366 ngày',
});
const own = (map: Readonly<Record<string, string>>, key: string) => Object.prototype.hasOwnProperty.call(map, key);
export const hermesCapabilityLabel = (key: string): string => (own(LABELS, key) ? LABELS[key] : key);
export const hermesCapabilityHint = (key: string): string | undefined => (own(HINTS, key) ? HINTS[key] : undefined);
