import type { LuckyPublicState, LuckyAdminState } from './luckyDrawApi';
import { luckyPublicStateSchema, luckyAdminStateSchema } from './luckyReadModels';

export class PublicRequestError extends Error {
  constructor(readonly status = 0, readonly kind: 'http' | 'invalid-response' = 'http', readonly cause?: unknown) {
    super(kind === 'invalid-response' ? 'Chưa xác nhận được phản hồi của máy chủ.' : 'Yêu cầu chưa được xác nhận.');
    this.name = 'PublicRequestError';
  }
}
export function publicFailure(error: unknown, operation: string): string {
  const prefix = `Chưa ${operation.replace(/^(tải|lưu|gỡ|mở|xác nhận) /, "$1 được ")}.`;
  if (error instanceof PublicRequestError) {
    if (error.status === 429) return `${prefix} Có quá nhiều lượt truy cập. Vui lòng chờ rồi thử lại.`;
    if ([401, 403, 404, 410].includes(error.status)) return `${prefix} Liên kết không khả dụng hoặc bạn chưa được phép truy cập. Kiểm tra liên kết đã nhận.`;
    if (error.status >= 500) return `${prefix} Máy chủ chưa xử lý được yêu cầu. Tải lại trạng thái trước khi tiếp tục.`;
    return `${prefix} Chưa nhận được kết quả hợp lệ từ máy chủ. Tải lại trạng thái trước khi tiếp tục.`;
  }
  if (error instanceof Error && /Failed to fetch|NetworkError|network request failed/i.test(error.message)) return `${prefix} Không kết nối được máy chủ. Kiểm tra kết nối rồi tải lại trạng thái.`;
  if (error instanceof Error && /AbortError|TimeoutError/.test(error.name)) return `${prefix} Máy chủ phản hồi quá lâu. Tải lại trạng thái để kiểm tra kết quả trước khi tiếp tục.`;
  return `${prefix} Chưa xác nhận được kết quả. Tải lại trạng thái trước khi tiếp tục.`;
}

export function checkinCodeError(code: string): string | null {
  return /^\d{6,8}$/.test(code.trim()) ? null : 'Nhập mã điểm danh gồm 6–8 chữ số do ban tổ chức gửi.';
}

export function parseLuckyState(value: unknown): LuckyPublicState {
  const parsed = luckyPublicStateSchema.safeParse(value);
  if (!parsed.success) throw new PublicRequestError(0, 'invalid-response');
  return parsed.data as LuckyPublicState;
}
export function parseLuckyAdminState(value: unknown): LuckyAdminState {
  const parsed = luckyAdminStateSchema.safeParse(value);
  if (!parsed.success) throw new PublicRequestError(0, 'invalid-response');
  return parsed.data as LuckyAdminState;
}
