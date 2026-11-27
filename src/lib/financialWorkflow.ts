import { financialPending, FinancialPendingError, isAttemptRunning, pendingHasSettled, pendingVerdictConclusive, trackRunningAttempt, type FinancialPendingMeta, type FinancialPendingRecord, type FinancialPendingScope, type FinancialPendingStore, type PendingReconciliation } from './financialPending';
import { friendlyError } from './friendlyError';
import { hasUnconfirmedResponse as voucherOutcomeUnknown, isKnownRejectionCode } from './operationOutcome';
import { pendingBlockMessage, pendingValve, type PendingValve } from './pendingValve';

import {FinancialAlreadyRecordedError,FinancialWorkflowError,workflowFeedbackDescription,type CompletedFinancialStep} from './financialWorkflowError';
export {FinancialAlreadyRecordedError,FinancialWorkflowError,RepeatableWriteUnknownError} from './financialWorkflowError';
export type {CompletedFinancialStep} from './financialWorkflowError';
export type {PendingReconciliation} from './financialPending';
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
  return isKnownRejectionCode((error as {code?:unknown}).code);
}

export interface FinancialWorkflowPersistence {
  scope: (businessKey:string, targetOrganizationId?:string|null) => Promise<FinancialPendingScope>;
  store?: FinancialPendingStore;
  /** Nơi nhận lời báo khi một lần ghi bị chặn bởi dấu của lần gửi trước. Mặc định là hộp cảnh báo dùng chung. */
  valve?: Pick<PendingValve,'report'>;
  now?: () => Date;
  /**
   * Namespace CHUNG của bản trước mà namespace này được tách ra (đợt 5: tách khoá theo thao tác). Dấu cũ ở đó cùng
   * khoá nghiệp vụ không cho biết nó thuộc thao tác nào, nên không đối chiếu tự động: chặn đúng bản ghi đó và mở hộp
   * cảnh báo (sau 2 phút người dùng tự gỡ). Không lặng lẽ bỏ qua, vì đó có thể là một lệnh tiền chưa rõ kết quả.
   */
  legacyNamespace?: string;
}
/** Tuỳ chọn thêm của một lượt ghi. `meta`: vài giá trị nguyên thuỷ lưu vào dấu (ví dụ trạng thái trước khi bấm). */
export interface FinancialWorkflowRunOptions {
  meta?: FinancialPendingMeta;
  /**
   * Đợt 6: còn dấu của lần gửi trước mà lượt này đổi những trường máy chủ KHÔNG so khi trả lại kết quả cũ theo mã yêu
   * cầu (gửi lại sẽ nhận bản ghi cũ mang giá trị cũ). Trả câu hướng dẫn thì lõi giữ dấu, mở hộp cảnh báo, không đối
   * chiếu, không gửi, và ném đúng câu đó; trả `null` thì đối chiếu như thường.
   */
  priorMismatch?: (pending: FinancialPendingRecord) => string | null;
}
/** Câu báo nêu thao tác ĐANG KẸT và giờ kẹt, đọc từ dấu; không dùng tên thao tác người dùng vừa bấm. */
const pendingFailure = (pending:FinancialPendingRecord,at:Date) => new FinancialWorkflowError(
  pendingBlockMessage(pending,pendingHasSettled(pending,at)),
  pending.completedIds.length ? 'partial' : 'unknown',
  pending.completedIds.map(id=>({id,label:`Bản ghi cần đối chiếu: ${id}`})),
);
export class FinancialWorkflowGuard {
  private active = new Set<string>();
  /** `attemptId`: dấu bền mà khoá trong bộ nhớ này soi theo. Dấu ấy đã được gỡ thì khoá hết hiệu lực. */
  private blocked = new Map<string, {error:FinancialWorkflowError;attemptId?:string}>();
  constructor(private persistence?:FinancialWorkflowPersistence) {}
  async run<T>(key: string, operation: string, task: (progress: FinancialWorkflowProgress) => Promise<T>, reconcile?: (pending:FinancialPendingRecord,progress:FinancialWorkflowProgress)=>Promise<PendingReconciliation<T>>, targetOrganizationId?:string|null, options:FinancialWorkflowRunOptions={}): Promise<T> {
    if (this.active.has(key)) throw new FinancialWorkflowError(
      `Yêu cầu ${operation} đang được xử lý. Chờ kết quả trước khi thực hiện tiếp.`, 'unknown', []);
    // Acquire synchronously, before scope resolution, to stop a double click.
    this.active.add(key);
    const store=this.persistence?.store??financialPending;
    const valve=this.persistence?.valve??pendingValve;
    const now=this.persistence?.now??(()=>new Date());
    let scope:FinancialPendingScope|undefined;
    let blockedKey=key;
    let pending:FinancialPendingRecord|undefined;
    const progress:FinancialWorkflowProgress = {completed: [] as CompletedFinancialStep[], stage: operation, requestKey: crypto.randomUUID()};
    let writerStarted=false;
    let recoveryAttempt=false;
    let resendPriorRequest=false;
    let alreadyRecorded:FinancialAlreadyRecordedError|undefined;
    let legacyBlocked:FinancialWorkflowError|undefined;
    let mismatchBlocked:FinancialWorkflowError|undefined;
    // Dấu đang có task chạy thì chưa thể coi là đã kết thúc, kể cả với guard khác trong tab.
    let stopTracking:(()=>void)|undefined;
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
        if(this.persistence.legacyNamespace){
          const legacy=store.read({...scope,namespace:this.persistence.legacyNamespace});
          if(legacy){
            try{valve.report({pending:legacy,blockedOperation:operation,store});}catch{/* giữ lỗi chính */}
            legacyBlocked=pendingFailure(legacy,now());
            throw legacyBlocked;
          }
        }
        const prior=store.read(scope);
        if(prior){
          pending=prior;recoveryAttempt=true;writerStarted=true;
          progress.requestKey=prior.requestKey??prior.attemptId;progress.stage='đối chiếu yêu cầu trước';
          Array.prototype.push.apply(progress.completed,prior.completedIds.map(id=>({id,label:`Bản ghi cần đối chiếu: ${id}`})));
          // Lượt ghi của dấu này còn chạy trong tab (vòng lặp nhiều bước chưa xong): chưa có gì để đối chiếu.
          if(isAttemptRunning(prior.attemptId))throw pendingFailure(prior,now());
          const mismatch=options.priorMismatch?.(prior);
          if(mismatch){
            try{valve.report({pending:prior,blockedOperation:operation,store});}catch{/* giữ lỗi chính */}
            mismatchBlocked=new FinancialWorkflowError(mismatch,prior.completedIds.length?'partial':'unknown',[...progress.completed]);
            throw mismatchBlocked;
          }
          // Domain code must read authoritative state before resuming only verified missing steps.
          const stopReconcile=trackRunningAttempt(prior.attemptId);
          let verdict:PendingReconciliation<T>;
          try{verdict=reconcile?await reconcile(prior,progress):null;}finally{stopReconcile();}
          // "Chưa thấy trên máy chủ" chỉ là "chưa ghi" khi lần gửi trước chắc chắn đã kết thúc, hoặc khi gửi lại cùng mã
          // không thể ghi hai lần. Kết luận lạ dạng (không phải một trong ba dạng đã biết) cũng là chưa kết luận được.
          // Only a conclusive verdict may release the prior marker, and only that exact marker.
          if(!pendingVerdictConclusive(verdict,prior,now())||!store.clearConfirmed(scope,prior.attemptId))throw pendingFailure(pending??prior,now());
          this.blocked.delete(blockedKey);
          if('result' in verdict)return verdict.result;
          if(verdict.outcome==='already-written'){
            alreadyRecorded=new FinancialAlreadyRecordedError(verdict.message,verdict.recordIds);
            throw alreadyRecorded;
          }
          // Lần trước chưa ghi: chạy lại như một lượt mới nhưng giữ mã yêu cầu cũ, để máy chủ nhận ra nếu lệnh cũ rốt cuộc đã tới.
          pending=undefined;recoveryAttempt=false;resendPriorRequest=true;
          progress.completed.length=0;progress.stage=operation;
        }
      }
      const blocked=this.blocked.get(blockedKey);
      if(blocked){
        // Tới đây thì kho không còn dấu nào cho khoá này. Khoá trong bộ nhớ soi theo một dấu bền đã được gỡ
        // (đối chiếu ở nơi khác, hoặc người dùng tự gỡ qua hộp cảnh báo) thì không còn lý do chặn.
        if(!scope||!blocked.attemptId)throw blocked.error;
        this.blocked.delete(blockedKey);
      }
      if(scope){
        pending=store.markPending(scope,{attemptId:resendPriorRequest?crypto.randomUUID():progress.requestKey,requestKey:progress.requestKey,operation,meta:options.meta});
        stopTracking=trackRunningAttempt(pending.attemptId);
      }
      writerStarted=true;
      const result=await task(progress);
      if(scope&&pending&&!store.clearConfirmed(scope,pending.attemptId))throw pendingFailure(pending,now());
      return result;
    } catch(error){
      // Task đã dừng: từ đây dấu của nó được xét theo giờ, không còn tính là đang chạy.
      stopTracking?.();
      // Kết luận "lần trước đã ghi" của chính lượt này: dấu đã gỡ, không còn gì để giữ hay chặn.
      if(alreadyRecorded&&error===alreadyRecorded)throw error;
      // Bị chặn bởi dấu khoá chung bản trước: dấu đó nằm ở namespace khác, lượt này chưa ghi gì và không giữ khoá nào.
      if(legacyBlocked&&error===legacyBlocked)throw error;
      // Chặn vì lượt này đổi trường máy chủ không so (`priorMismatch`): dấu cũ giữ nguyên, không khoá thêm trong bộ nhớ.
      if(mismatchBlocked&&error===mismatchBlocked)throw error;
      const collided=error instanceof FinancialPendingError?error.pending:null;
      const failure=collided?pendingFailure(collided,now()):error;
      let feedback=workflowFailure(failure,operation,progress.completed,progress.stage);
      if(recoveryAttempt&&pending){
        // Bị chặn bởi dấu của lần gửi trước (chưa có kết luận, hoặc phép đối chiếu hỏng giữa chừng).
        const completed=feedback instanceof FinancialWorkflowError?feedback.completed:progress.completed;
        feedback=new FinancialWorkflowError(pendingBlockMessage(pending,pendingHasSettled(pending,now())),completed.length?'partial':'unknown',[...completed],failure);
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
        this.blocked.set(blockedKey,{error:retainedFeedback,attemptId:scope?(pending??collided)?.attemptId:undefined});
        // Lần sau cùng khoá sẽ lại bị chặn bởi dấu này: báo hộp cảnh báo để người dùng có lối xử lý.
        // Lời báo là kênh phụ; nó hỏng thì lỗi chính của lượt ghi vẫn phải tới được nơi gọi.
        // Đợt 6: lần GỬI LẠI (cùng mã, sau `not-written`) mà vẫn chưa rõ kết quả cũng báo hộp cảnh báo với dấu mới, để một
        // phép gửi lại hỏng lặp lại (ví dụ biên nhận luôn sai) vẫn có lối tự gỡ sau 2 phút, không vòng lặp không lối ra.
        const blocker=recoveryAttempt?pending:(collided??(resendPriorRequest?pending:undefined));
        if(blocker){try{valve.report({pending:blocker,blockedOperation:operation,store});}catch{/* giữ lỗi chính */}}
        feedback=retainedFeedback;
      }else if(writerStarted&&!recoveryAttempt&&scope&&pending){
        // A known rejection with no successful step establishes no write occurred.
        store.clearConfirmed(scope,pending.attemptId);
      }
      throw feedback;
    } finally { stopTracking?.(); this.active.delete(key); }
  }
}

/**
 * Kết quả của một lần đối chiếu CHỈ ĐỌC (`reconcilePendingOnly`).
 * - `written`: lần gửi trước đã ghi (`{result}` hoặc `already-written`); dấu đã gỡ. `message` là câu của hàm đối chiếu
 *   (chỉ có với `already-written`), `recordIds` là mã bản ghi biết được.
 * - `not-written`: tra chắc chắn lần gửi trước chưa ghi; dấu đã gỡ, KHÔNG gửi gì.
 * - `kept`: dấu để nguyên; `reason` cho biết vì sao (đang chạy trong tab, chưa lắng, đọc hỏng, chưa kết luận, cần gửi lại
 *   cùng mã, dấu đã đổi).
 */
export type PendingReadOnlyOutcome =
  | {kind:'written';message:string|null;recordIds:readonly string[];result?:unknown}
  | {kind:'not-written'}
  | {kind:'kept';reason:'running'|'unsettled'|'failed'|'inconclusive'|'resend-needed'|'gone'};

/**
 * Một namespace đăng ký cho quét nền khi mở app (đợt 11, `src/lib/pendingSweep.ts`). Khai ở tệp hook của nơi ghi và dựng
 * từ CHÍNH hàm đối chiếu mà lần bấm dùng, để hai bên không thể kết luận khác nhau.
 */
export interface PendingSweepHandler {
  /** Phạm vi công ty của dấu, như guard của nơi ghi: `actor` ⇒ 'actor-scope'; `selected` ⇒ công ty đang chọn. */
  scope:'actor'|'selected';
  /** Hàm đối chiếu CHỈ ĐỌC (không bước ghi nào), dựng được chỉ từ dấu (không cần dữ liệu của lần bấm). */
  reconcile:(pending:FinancialPendingRecord)=>Promise<PendingReconciliation<unknown>>;
  /** Gốc khoá react-query cần làm mới khi dấu được gỡ. */
  invalidate:readonly string[];
  /** Kết luận `{result}`: mã bản ghi người dùng nhận ra (số hoá đơn…) để câu báo nêu được bản ghi. */
  resultRecordIds?:(result:unknown)=>readonly string[];
}

/**
 * Chế độ CHỈ ĐỐI CHIẾU của lõi (đợt 11: quét nền khi mở app). Chạy hàm đối chiếu của đúng dấu `prior`, xét kết luận bằng
 * CÙNG luật với lần bấm (`pendingVerdictConclusive`), rồi chỉ gỡ đúng dấu đó (theo `attemptId`). KHÔNG BAO GIỜ chạy việc
 * ghi, không gửi lại: hàm này không nhận task nào.
 *
 * Khác lần bấm ở đúng hai chỗ, cả hai theo hướng giữ dấu:
 * - dấu chưa lắng (dưới `PENDING_SETTLE_MS`, hoặc lượt của nó còn chạy trong tab) thì không gọi hàm đối chiếu;
 * - `not-written` kèm `serverDedupesRequestKey` KHÔNG gỡ dấu. Lần bấm gỡ rồi gửi lại NGAY với CÙNG mã yêu cầu, nên kết
 *   luận «chưa ghi» chỉ an toàn nhờ chính lần gửi lại đó; ở đây không gửi gì, gỡ dấu là mất mã cũ và lần bấm sau sinh mã
 *   mới ⇒ có thể ghi trùng.
 * Hàm đối chiếu ném lỗi (đọc hỏng, mất mạng) ⇒ giữ dấu, không ném ra ngoài.
 */
export async function reconcilePendingOnly<T>(
  prior:FinancialPendingRecord,
  reconcile:(pending:FinancialPendingRecord)=>Promise<PendingReconciliation<T>>,
  options:{store?:Pick<FinancialPendingStore,'clearConfirmed'>;now?:()=>Date}={},
):Promise<PendingReadOnlyOutcome>{
  const store=options.store??financialPending;
  const now=options.now??(()=>new Date());
  // Lượt ghi của dấu, hoặc một lần đối chiếu khác của nó, đang chạy trong tab này: lần bấm đang lo, không tranh.
  if(isAttemptRunning(prior.attemptId))return {kind:'kept',reason:'running'};
  // Dấu chưa lắng: lệnh cũ có thể còn đang chạy trên máy chủ, «chưa thấy» chưa nói được gì.
  if(!pendingHasSettled(prior,now()))return {kind:'kept',reason:'unsettled'};
  // Trong lúc đối chiếu, dấu được coi là đang chạy: lần bấm cùng thao tác ở tab này chờ, không đối chiếu song song.
  const stop=trackRunningAttempt(prior.attemptId);
  let verdict:PendingReconciliation<T>;
  try{verdict=await reconcile(prior);}
  catch{/* Đọc hỏng / mất mạng: chưa kết luận được, dấu để nguyên, im lặng. */return {kind:'kept',reason:'failed'};}
  finally{stop();}
  if(!pendingVerdictConclusive(verdict,prior,now()))return {kind:'kept',reason:'inconclusive'};
  if('outcome' in verdict&&verdict.outcome==='not-written'&&verdict.serverDedupesRequestKey===true)return {kind:'kept',reason:'resend-needed'};
  const scope:FinancialPendingScope={namespace:prior.namespace,userId:prior.userId,organizationId:prior.organizationId,businessKey:prior.businessKey};
  let cleared=false;
  try{cleared=store.clearConfirmed(scope,prior.attemptId);}
  catch{/* Kho không gỡ được: dấu còn nguyên, lần bấm sau đối chiếu lại. */}
  if(!cleared)return {kind:'kept',reason:'gone'};
  if('result' in verdict)return {kind:'written',message:null,recordIds:[...prior.completedIds],result:verdict.result};
  if(verdict.outcome==='already-written')return {kind:'written',message:verdict.message,recordIds:[...(verdict.recordIds??[])]};
  return {kind:'not-written'};
}
