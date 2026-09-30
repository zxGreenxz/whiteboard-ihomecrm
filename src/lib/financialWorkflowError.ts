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

export function workflowFeedbackDescription(error:FinancialWorkflowError):string{
 const ids=[...new Set(error.completed.map(step=>step.id).filter(id=>/^[\w-]{1,128}$/.test(id)&&!error.message.includes(id)))];
 return error.message+(ids.length?` Mã chứng từ cần đối chiếu: ${ids.join(', ')}.`:'');
}
