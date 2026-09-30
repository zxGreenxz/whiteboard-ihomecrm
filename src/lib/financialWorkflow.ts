import { financialPending, FinancialPendingError, type FinancialPendingRecord, type FinancialPendingScope } from './financialPending';
import { friendlyError } from './friendlyError';
import { hasUnconfirmedResponse as voucherOutcomeUnknown } from './operationOutcome';

import {FinancialWorkflowError,workflowFeedbackDescription,type CompletedFinancialStep} from './financialWorkflowError';
export {FinancialWorkflowError} from './financialWorkflowError';
export type {CompletedFinancialStep} from './financialWorkflowError';
export interface FinancialWorkflowProgress {completed:CompletedFinancialStep[];stage:string;requestKey:string}

export function workflowFailure(error: unknown, operation: string, completed: readonly CompletedFinancialStep[], stage: string): unknown {
  if (error instanceof FinancialWorkflowError) {
    const merged = [...new Map([...error.completed, ...completed].map(step => [step.id, step])).values()];
    if (completed.length || (error.outcome === 'failure' && merged.length)) return new FinancialWorkflowError(
      `Chưa hoàn tất ${operation}. ${merged.map(item => item.label).join('; ')}. Chưa xác nhận xong bước ${stage}. Giữ các mã bên dưới và đối chiếu trước khi thực hiện tiếp; không lập lại toàn bộ.`,
      'partial', merged, error,
    );
    return merged.length === error.completed.length ? error : new FinancialWorkflowError(error.message, error.outcome, merged, error.cause);
  }
  if (completed.length) return new FinancialWorkflowError(
    `Chưa hoàn tất ${operation}. ${completed.map(item => item.label).join('; ')}. Chưa xác nhận xong bước ${stage}. Giữ các mã bên dưới và đối chiếu trước khi thực hiện tiếp; không lập lại toàn bộ.`,
    'partial', [...completed], error,
  );
  if (voucherOutcomeUnknown(error)) return new FinancialWorkflowError(
    `Chưa xác nhận được kết quả ${operation}. Tải lại trạng thái và đối chiếu giao dịch trước khi thực hiện tiếp.`,
    'unknown', [], error,
  );
  return error;
}

export function workflowErrorMessage(error: unknown, operation: string): string {
  if (error instanceof FinancialWorkflowError) return workflowFeedbackDescription(error);
  const feedback = friendlyError(error, `Chưa ${operation}.`, {operation, financial: true});
  return `${feedback.title} ${feedback.description}`;
}

/** PostgreSQL rejects the transaction for these known error classes. A generic JS error is not proof of rollback. */
export function isConfirmedFinancialRejection(error:unknown):boolean {
  if (voucherOutcomeUnknown(error)) return false;
  if (error instanceof FinancialWorkflowError) return error.outcome === 'failure';
  if (!error || typeof error !== 'object') return false;
  const code=String((error as {code?:unknown}).code??'');
  return /^(22[0-9A-Z]{3}|23[0-9A-Z]{3}|28[0-9A-Z]{3}|40001|40P01|42501|42883|55000|55P03|P0001|P0002|PT409|PGRST202|PGRST301|PGRST302)$/.test(code);
}

export interface FinancialWorkflowPersistence {
  scope: (businessKey:string, targetOrganizationId?:string|null) => Promise<FinancialPendingScope>;
  store?: typeof financialPending;
}
const pendingFailure = (pending:FinancialPendingRecord,operation:string) => new FinancialWorkflowError(
  `Chưa xác nhận xong yêu cầu ${operation} trước đó. Mở chứng từ liên quan và đối chiếu với người quản lý trước khi thực hiện tiếp. Tải lại trang không hủy yêu cầu đã gửi.`,
  pending.completedIds.length ? 'partial' : 'unknown',
  pending.completedIds.map(id=>({id,label:`Bản ghi cần đối chiếu: ${id}`})),
);
export class FinancialWorkflowGuard {
  private active = new Set<string>();
  private blocked = new Map<string, FinancialWorkflowError>();
  constructor(private persistence?:FinancialWorkflowPersistence) {}
  async run<T>(key: string, operation: string, task: (progress: FinancialWorkflowProgress) => Promise<T>, reconcile?: (pending:FinancialPendingRecord,progress:FinancialWorkflowProgress)=>Promise<{result:T}|null>, targetOrganizationId?:string|null): Promise<T> {
    if (this.active.has(key)) throw new FinancialWorkflowError(
      `Yêu cầu ${operation} đang được xử lý. Chờ kết quả trước khi thực hiện tiếp.`, 'unknown', []);
    // Acquire synchronously, before scope resolution, to stop a double click.
    this.active.add(key);
    const store=this.persistence?.store??financialPending;
    let scope:FinancialPendingScope|undefined;
    let blockedKey=key;
    let pending:FinancialPendingRecord|undefined;
    const progress:FinancialWorkflowProgress = {completed: [] as CompletedFinancialStep[], stage: operation, requestKey: crypto.randomUUID()};
    let writerStarted=false;
    let recoveryAttempt=false;
    // Both initial execution and domain-verified recovery persist each new receipt immediately.
    progress.completed.push=(...steps:CompletedFinancialStep[])=>{
      const length=Array.prototype.push.apply(progress.completed,steps);
      if(scope&&pending)pending=store.recordCompleted(scope,pending.attemptId,steps.map(step=>step.id));
      return length;
    };
    try {
      if(this.persistence){
        scope=await this.persistence.scope(key, targetOrganizationId);
        blockedKey=JSON.stringify([scope.namespace,scope.userId,scope.organizationId,scope.businessKey]);
        const prior=store.read(scope);
        if(prior){
          pending=prior;recoveryAttempt=true;writerStarted=true;
          progress.requestKey=prior.requestKey??prior.attemptId;progress.stage='đối chiếu yêu cầu trước';
          Array.prototype.push.apply(progress.completed,prior.completedIds.map(id=>({id,label:`Bản ghi cần đối chiếu: ${id}`})));
          // Domain code must read authoritative state before resuming only verified missing steps.
          // Only a complete, positively verified receipt may release the prior marker.
          const recovered=reconcile?await reconcile(prior,progress):null;
          if(recovered){
            if(!store.clearConfirmed(scope,prior.attemptId))throw pendingFailure(prior,operation);
            this.blocked.delete(blockedKey);
            return recovered.result;
          }
          throw pendingFailure(prior,operation);
        }
      }
      const blocked=this.blocked.get(blockedKey);
      if(blocked)throw blocked;
      if(scope)pending=store.markPending(scope,{attemptId:progress.requestKey,requestKey:progress.requestKey});
      writerStarted=true;
      const result=await task(progress);
      if(scope&&pending&&!store.clearConfirmed(scope,pending.attemptId))throw pendingFailure(pending,operation);
      return result;
    } catch(error){
      const failure=error instanceof FinancialPendingError&&error.pending?pendingFailure(error.pending,operation):error;
      let feedback=workflowFailure(failure,operation,progress.completed,progress.stage);
      if(recoveryAttempt && (!(feedback instanceof FinancialWorkflowError)||feedback.outcome==='failure')){
        feedback=new FinancialWorkflowError(`Chưa đối chiếu xong yêu cầu ${operation} trước đó. Giữ các mã chứng từ và kiểm tra trạng thái trước khi thực hiện tiếp.`,progress.completed.length?'partial':'unknown',[...progress.completed],failure);
      }
      if(writerStarted && !(feedback instanceof FinancialWorkflowError) && !isConfirmedFinancialRejection(failure)) {
        feedback=new FinancialWorkflowError(`Chưa xác nhận được kết quả ${operation}. Giữ thông tin đang nhập, mở chứng từ liên quan và đối chiếu trước khi thực hiện tiếp.`, 'unknown', [...progress.completed], failure);
      }
      if(feedback instanceof FinancialWorkflowError&&feedback.outcome!=='failure'){
        let retainedFeedback:FinancialWorkflowError=feedback;
        if(writerStarted && scope && pending && feedback.completed.length){
          try { pending=store.recordCompleted(scope,pending.attemptId,feedback.completed.map(step=>step.id)); }
          catch(storageError){ retainedFeedback=new FinancialWorkflowError(`${feedback.message} Chưa lưu được đầy đủ mã đối chiếu trong trình duyệt. Giữ các mã đang hiển thị và liên hệ quản lý trước khi đóng trang.`,feedback.outcome,feedback.completed,storageError); }
        }
        this.blocked.set(blockedKey,retainedFeedback);
        feedback=retainedFeedback;
      }else if(writerStarted&&!recoveryAttempt&&scope&&pending){
        // A known rejection with no successful step establishes no write occurred.
        store.clearConfirmed(scope,pending.attemptId);
      }
      throw feedback;
    } finally { this.active.delete(key); }
  }
}
