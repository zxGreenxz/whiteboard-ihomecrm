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

export function workflowFeedbackDescription(error:FinancialWorkflowError):string{
 const ids=[...new Set(error.completed.map(step=>step.id).filter(id=>/^[\w-]{1,128}$/.test(id)&&!error.message.includes(id)))];
 return error.message+(ids.length?` Mã chứng từ cần đối chiếu: ${ids.join(', ')}.`:'');
}
