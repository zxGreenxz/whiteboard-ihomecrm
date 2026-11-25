export interface CompletedFinancialStep { id: string; label: string }
/** UI-owned descriptions only. Raw server diagnostics remain in cause. */
export class FinancialWorkflowError extends Error {
  override readonly name = 'FinancialWorkflowError';
  constructor(
    message: string,
    readonly outcome: 'partial' | 'unknown' | 'failure',
    readonly completed: readonly CompletedFinancialStep[],
    readonly cause?: unknown,
  ) { super(message); }
}

/**
 * Đối chiếu cho thấy lần gửi TRƯỚC đã ghi: dấu đã gỡ và lượt này không ghi gì thêm. Người dùng xem bản ghi
 * rồi tự quyết có làm thêm không. `outcome` là `failure` vì không còn gì chờ đối chiếu; mã bản ghi nằm trong
 * câu báo và `recordIds`, không nằm trong `completed`, để một luồng bọc ngoài không coi đó là ghi dở dang.
 */
export class FinancialAlreadyRecordedError extends FinancialWorkflowError {
  readonly alreadyRecorded = true;
  readonly recordIds: readonly string[];
  constructor(message: string, recordIds: readonly string[] = []) {
    const ids = [...new Set(recordIds.filter(id => typeof id === 'string' && id))];
    const missing = ids.filter(id => !message.includes(id));
    super(message + (missing.length ? ` Mã bản ghi: ${missing.join(', ')}.` : ''), 'failure', []);
    this.recordIds = ids;
  }
}

/**
 * Đợt 8 (luật 5): kết quả CHƯA RÕ của một thao tác ghi lặp lại được (đặt giá trị theo mã, xoá theo mã, xoá mềm). Không
 * giữ dấu «chờ đối chiếu» nào và form KHÔNG khoá: bấm lại ghi lại đúng nội dung đó cho cùng kết quả. `outcome` vẫn là
 * `unknown` (lần gửi có thể đã ghi), nên câu báo không nói «chưa ghi»; nơi khoá form theo kết quả chưa rõ phải bỏ qua lỗi này.
 */
export class RepeatableWriteUnknownError extends FinancialWorkflowError {
  readonly repeatable = true;
  constructor(operation: string, cause?: unknown, completed: readonly CompletedFinancialStep[] = []) {
    super(`Chưa xác nhận được kết quả ${operation}. Bấm lại để thử lần nữa: thao tác này ghi lại đúng nội dung đó nên không tạo thêm bản ghi.`, 'unknown', completed, cause);
  }
}

export function workflowFeedbackDescription(error:FinancialWorkflowError):string{
 const ids=[...new Set(error.completed.map(step=>step.id).filter(id=>/^[\w-]{1,128}$/.test(id)&&!error.message.includes(id)))];
 return error.message+(ids.length?` Mã chứng từ cần đối chiếu: ${ids.join(', ')}.`:'');
}
