import {FinancialWorkflowError,workflowFeedbackDescription} from './financialWorkflowError';
import { hasUnconfirmedResponse } from './operationOutcome';
/** User feedback retains technical cause for logs; UI only uses title/description. */
export type FeedbackOutcome = 'failure' | 'unknown' | 'partial' | 'success' | 'no-op' | 'pending';
export type FeedbackRecovery = 'correct-fields' | 'reload' | 'reconcile' | 'sign-in' | 'contact-admin' | 'retry';
export interface FriendlyError {
  title: string; description: string; operation?: string;
  fieldErrors?: Record<string, string>; outcome?: FeedbackOutcome;
  recovery?: FeedbackRecovery; code?: string; cause?: unknown;
}
export interface OperationErrorRule {
  code?: string; message: string | RegExp; description: string;
  fieldErrors?: Record<string, string>; recovery?: FeedbackRecovery;
}
export interface FeedbackOptions {
  operation?: string; financial?: boolean;
  /** Source-verified reasons for this operation, never a SQLSTATE-only field guess. */
  rules?: readonly OperationErrorRule[];
}
function details(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return { message: typeof error === 'string' ? error : '' };
  const record = error as Record<string, unknown>;
  if (record.error && typeof record.error === 'object') return details(record.error);
  if (!record.code && record.cause && typeof record.cause === 'object') {
    const inner = details(record.cause);
    if (inner.code) return inner;
  }
  return record;
}
/**
 * Danh mục chi chuẩn (03/10/2026): ie_compat_insert_v2 từ chối lập tay hạng mục CHI system_only
 * (hoa hồng, thưởng sale, cọc, thanh lý) bằng 42501 + HINT 'ie_system_only_manual_blocked'.
 * Không phải lỗi quyền — người dùng phải lập từ hợp đồng / phiếu cọc / thanh lý.
 */
export const SYSTEM_ONLY_MANUAL_BLOCKED_FEEDBACK = {
  title: 'Không lập tay được hạng mục này',
  description: 'Hoa hồng, thưởng sale và các khoản cọc/thanh lý chỉ tạo từ hợp đồng, phiếu cọc hoặc thanh lý.',
} as const;
export function isSystemOnlyManualBlocked(error: unknown): boolean {
  const record = details(error);
  if (String(record.code ?? '').trim() !== '42501') return false;
  const hint = String(record.hint ?? '');
  const raw = String(record.message ?? '');
  return hint.includes('ie_system_only_manual_blocked') || raw.includes('ie_system_only_manual_blocked')
    || /chỉ được tạo từ luồng nghiệp vụ/i.test(raw);
}
const LEGACY_REASONS: Record<string, readonly string[]> = {
  '42501': ['Sổ quỹ cọc không thuộc tổ chức', 'Không có quyền tạo hợp đồng', 'Không có quyền ghi tiền cọc vào sổ đã chọn', 'Khách hàng không thuộc tổ chức'],
  '55000': ['Phiếu cọc được chọn không hợp lệ hoặc đã được dùng', 'Số tiền cọc phải lớn hơn 0', 'Phòng đang có hợp đồng hiệu lực'],
};
export function friendlyError(error: unknown, fallbackTitle = 'Chưa thực hiện được thao tác', options: FeedbackOptions = {}): FriendlyError {
  const record = details(error);
  const code = String(record.code ?? '').trim();
  const raw = String(record.message ?? '').trim();
  const status = Number(record.status ?? 0);
  const base: FriendlyError = {
    title: fallbackTitle,
    description: 'Chưa xác định được nguyên nhân. Giữ thông tin đang nhập và kiểm tra lại trạng thái trước khi tiếp tục; nếu vẫn gặp lỗi, liên hệ quản trị viên.',
    operation: options.operation, fieldErrors: {}, outcome: 'failure', recovery: 'reload', code: code || undefined, cause: error,
  };
  const result = (change: Partial<FriendlyError>): FriendlyError => ({ ...base, ...change });
  if(error instanceof FinancialWorkflowError)return result({description:workflowFeedbackDescription(error),outcome:error.outcome,recovery:error.outcome==='failure'?'reload':'reconcile'});
  if (code === '55000' && raw.includes('RENT_SUPPORT_WRITERS_DISABLED')) return result({ description: 'Chức năng lưu lịch hỗ trợ tiền thuê chưa được bật. Nội dung đang nhập vẫn được giữ; chưa ghi nhận thay đổi.' });
  if (status === 401 || ['PGRST301','PGRST302','JWT_EXPIRED'].includes(code) || /jwt.*expired|not authenticated|unauthorized|refresh token.*(invalid|not found)/i.test(raw)) {
    return result({ title: 'Phiên đăng nhập đã hết hạn', description: 'Đăng nhập lại để tiếp tục.', recovery: 'sign-in' });
  }
  if (isSystemOnlyManualBlocked(error)) return result({ ...SYSTEM_ONLY_MANUAL_BLOCKED_FEEDBACK, recovery: 'correct-fields' });
  if (options.operation) {
    const rule = options.rules?.find(item => (!item.code || item.code === code) &&
      (typeof item.message === 'string' ? item.message === raw : new RegExp(item.message.source, item.message.flags.replace('g', '')).test(raw)));
    if (rule) return result({ description: rule.description, fieldErrors: rule.fieldErrors ?? {}, recovery: rule.recovery ?? (rule.fieldErrors ? 'correct-fields' : 'reload') });
  }
  if (LEGACY_REASONS[code]?.includes(raw)) return result({ description: raw });
  if (code === '55000' && /is frozen|scope may only|authorized transition may only|canonical income expense/i.test(raw)) {
    return result({ title: 'Thao tác bị khoá bởi hệ thống kế toán', description: 'Một phiếu liên quan đang bị khóa. Kiểm tra trạng thái phiếu trước khi tiếp tục; nếu vẫn gặp lỗi, liên hệ quản trị viên.' });
  }
  if (hasUnconfirmedResponse(error)) {
    return result({
      title: options.operation ? `Chưa xác nhận được kết quả ${options.operation}` : 'Chưa xác nhận được kết quả thao tác',
      description: options.financial
        ? 'Kiểm tra giao dịch trong sổ quỹ và đối chiếu phiếu này trước khi tiếp tục. Không gửi thêm giao dịch khi kết quả chưa được xác nhận.'
        : 'Chưa nhận được xác nhận từ máy chủ. Giữ thông tin đang nhập và tải lại trạng thái để kiểm tra thao tác đã được thực hiện hay chưa.',
      outcome: 'unknown', recovery: 'reconcile',
    });
  }
  if (code === '42501' || status === 403 || /permission denied|row-level security|insufficient privilege/i.test(raw)) {
    return result({ title: 'Không đủ quyền',
      description: options.operation ? `Bạn không có quyền ${options.operation}. Vui lòng liên hệ quản trị viên.` : 'Tài khoản của bạn chưa được cấp quyền cho thao tác này. Vui lòng liên hệ quản trị viên.',
      recovery: 'contact-admin' });
  }
  if (code === '23505' || /duplicate key|already exists/i.test(raw)) return result({ title: 'Trùng dữ liệu', description: 'Thông tin này đã được sử dụng. Kiểm tra bản ghi hiện có trước khi lưu.' });
  if (code === '23503' || /foreign key/i.test(raw)) return result({ description: 'Một thông tin liên quan không còn sử dụng được hoặc vẫn đang được sử dụng ở nơi khác. Tải lại danh sách liên quan để kiểm tra.' });
  if (['42703','42P01','42883','42601','PGRST202','PGRST204','XX000'].includes(code) || /schema cache|does not exist/i.test(raw)) {
    return result({ description: 'Thao tác chưa hoàn tất do lỗi hệ thống. Giữ thông tin đang nhập và liên hệ quản trị viên nếu lỗi tiếp tục.', recovery: 'contact-admin' });
  }
  if (['40001','40P01','55P03'].includes(code)) return result({ description: 'Dữ liệu đang được xử lý hoặc vừa thay đổi. Tải lại trạng thái và đối chiếu thông tin đang nhập trước khi tiếp tục.' });
  if (code === 'PGRST116') return result({ description: 'Chưa tìm thấy dữ liệu trong phạm vi bạn được phép xem. Tải lại danh sách để kiểm tra.' });
  if (['23502','23514','22P02','22001','22003','22023'].includes(code)) return result({ description: 'Thông tin gửi lên chưa hợp lệ. Kiểm tra các trường trong biểu mẫu; nếu không thấy trường cần sửa, liên hệ quản trị viên.' });
  return base;
}
