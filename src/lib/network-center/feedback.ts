import { friendlyError } from '@/lib/friendlyError';
import type { MaintenanceInput, NetworkActionRequest, NetworkBuilding, NetworkSettings } from './contracts';
import { NETWORK_ACTION_DEFINITIONS } from './model';

export function actionFieldErrors(site: NetworkBuilding, request: NetworkActionRequest): Record<string, string> {
  const errors: Record<string, string> = {};
  if (request.type === 'cycle_access_port') {
    const target = site.interfaces.find(item => item.id === String(request.fields.interfaceId ?? ''));
    if (!target || target.protected || target.role !== 'lan') errors['fields.interfaceId'] = 'Chọn cổng LAN được phép khởi động lại.';
    else if (target.status !== 'up') errors['fields.interfaceId'] = 'Cổng này đang ngắt kết nối. Chọn cổng LAN đang hoạt động.';
    const duration = Number(request.fields.durationSeconds);
    if (!Number.isInteger(duration) || duration < 5 || duration > 30) errors['fields.durationSeconds'] = 'Thời gian ngắt phải là số nguyên từ 5 đến 30 giây.';
  }
  if (request.reason.trim().length < 8) errors.reason = 'Nhập lý do thao tác, ít nhất 8 ký tự.';
  if (NETWORK_ACTION_DEFINITIONS.find(item => item.type === request.type)?.requiresIdentity && request.confirmation !== site.router.identity) {
    errors.confirmation = `Nhập đúng tên thiết bị ${site.router.identity} để xác nhận.`;
  }
  return errors;
}

export function maintenanceFieldErrors(input: Pick<MaintenanceInput, 'durationMinutes' | 'reason'>): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 15 || input.durationMinutes > 480) errors.durationMinutes = 'Thời lượng bảo trì phải là số nguyên từ 15 đến 480 phút.';
  if (input.reason.trim().length < 8) errors.reason = 'Nhập lý do bảo trì, ít nhất 8 ký tự.';
  return errors;
}

export function settingsFieldErrors(settings: NetworkSettings): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!Number.isInteger(settings.pollingSeconds) || settings.pollingSeconds < 30 || settings.pollingSeconds > 3600) errors.pollingSeconds = 'Chu kỳ kiểm tra phải là số nguyên từ 30 đến 3600 giây.';
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.backupHour.trim())) errors.backupHour = 'Chọn giờ sao lưu hợp lệ, từ 00:00 đến 23:59.';
  if (!['standard', 'strict'].includes(settings.alertSensitivity)) errors.alertSensitivity = 'Chọn ngưỡng cảnh báo.';
  return errors;
}

// Only messages constructed by this repository are safe to show. Raw RPC payloads
// remain in cause; other errors still go through the shared allow-listed mapper.
const repositoryMessages = /^(?:Tòa nhà đang ở chế độ chỉ đọc;|Network Center đang tắt cho tòa nhà này$|Cài đặt đã thay đổi;|Chưa nhận được kết quả hợp lệ cho |Chưa kết nối được với Trung tâm mạng\.|Chưa xác nhận được kết quả |Bạn không có quyền |Phiên đăng nhập đã hết hạn\.|Chưa thực hiện được |Thông tin yêu cầu chưa hợp lệ\.)/;
const demoMessages = new Set(["Tòa nhà không thuộc phạm vi Network Center", "MikroTik chưa được kết nối để thực thi thao tác", 'Tòa đang có cửa sổ bảo trì', 'Không tìm thấy bảo trì', 'Cấu hình chưa sẵn sàng để so sánh']);
export function networkFeedback(error: unknown, operation: string) {
  const feedback = friendlyError(error, `Chưa ${operation}.`, { operation });
  if (error instanceof Error && ((error.name === 'NetworkCenterRepositoryError' && repositoryMessages.test(error.message)) || demoMessages.has(error.message))) {
    return { ...feedback, description: `${feedback.title} ${error.message}`, ...(/^Chưa (?:nhận được|xác nhận được)/.test(error.message) ? { outcome: "unknown" as const, recovery: "reconcile" as const } : {}) };
  }
  return { ...feedback, description: `${feedback.title} ${feedback.description}` };
}
