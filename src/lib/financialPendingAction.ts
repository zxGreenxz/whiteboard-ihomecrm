import {financialPending,FinancialPendingError,isAttemptRunning,pendingHasSettled,trackRunningAttempt,type FinancialPendingMeta,type FinancialPendingRecord,type FinancialPendingScope,type FinancialPendingStore,type PendingReconciliation} from './financialPending';
import {isConfirmedFinancialRejection} from './financialWorkflow';
import {FinancialAlreadyRecordedError} from './financialWorkflowError';
import {pendingBlockMessage,pendingValve,type PendingValve} from './pendingValve';

export interface FinancialPendingRunOptions<T> {
  /** Tên thao tác lưu vào dấu, để câu báo gọi đúng việc đang kẹt. Không chứa tên khách hay số tiền. */
  operation?:string;
  requestKey?:string;
  meta?:FinancialPendingMeta;
  /** Đọc trạng thái thật trên máy chủ rồi kết luận về lần gửi trước. Không truyền thì dấu cũ chỉ gỡ được qua hộp cảnh báo. */
  reconcile?:(pending:FinancialPendingRecord)=>Promise<PendingReconciliation<T>>;
  valve?:Pick<PendingValve,'report'>;
  now?:()=>Date;
}

export interface FinancialPendingProgress {
  attemptId:string;requestKey:string;recordCompleted:(ids:readonly string[])=>void;
  /**
   * Mọi bước đã báo hoàn tất đều đã được dọn sạch VÀ đọc lại xác nhận (ví dụ phiếu con đã huỷ lại, đợt đã xoá).
   * Sau lời gọi này, một lỗi từ chối rõ ném ra được xử lý như chưa ghi gì: gỡ dấu. Lỗi chưa rõ kết quả vẫn giữ dấu.
   */
  releaseCompleted:()=>void;
}
/** Domain work must validate its positive receipt before returning. No replay payload is persisted. */
export async function runFinancialPending<T>(scope:FinancialPendingScope,work:(progress:FinancialPendingProgress)=>Promise<T>,store:FinancialPendingStore=financialPending,options:FinancialPendingRunOptions<T>={}):Promise<T>{
  const now=options.now??(()=>new Date());
  let requestKey:string=options.requestKey??crypto.randomUUID();
  const prior=store.read(scope);
  if(prior){
    // Bị chặn bởi dấu của lần gửi trước: nêu việc đang kẹt và giờ kẹt, rồi báo hộp cảnh báo để người dùng có lối xử lý.
    const blocked=(cause?:unknown)=>{
      const live=store.read(scope)??prior;
      try{(options.valve??pendingValve).report({pending:live,blockedOperation:options.operation,store});}catch{/* giữ lỗi chính */}
      return new FinancialPendingError(live,pendingBlockMessage(live,pendingHasSettled(live,now())),cause);
    };
    // Lượt ghi của dấu này còn chạy trong tab (bấm lần hai khi lần đầu chưa xong, hoặc vòng lặp nhiều bước): chờ, không đối chiếu.
    if(isAttemptRunning(prior.attemptId))throw blocked();
    let verdict:PendingReconciliation<T>=null;
    if(options.reconcile){
      const stop=trackRunningAttempt(prior.attemptId);
      let failed=false,cause:unknown;
      try{verdict=await options.reconcile(prior);}catch(error){failed=true;cause=error;}finally{stop();}
      if(failed)throw blocked(cause);
    }
    // "Chưa thấy trên máy chủ" chỉ là "chưa ghi" khi lần gửi trước chắc chắn đã kết thúc, hoặc khi gửi lại cùng mã không thể ghi
    // hai lần. Kết luận lạ dạng (không phải một trong ba dạng đã biết) cũng là chưa kết luận được.
    const conclusive=verdict!==null&&typeof verdict==='object'&&('result' in verdict
      ||verdict.outcome==='already-written'
      ||(verdict.outcome==='not-written'&&(verdict.serverDedupesRequestKey===true||pendingHasSettled(prior,now()))));
    if(verdict===null||!conclusive||!store.clearConfirmed(scope,prior.attemptId))throw blocked();
    if('result' in verdict)return verdict.result;
    if(verdict.outcome==='already-written')throw new FinancialAlreadyRecordedError(verdict.message,verdict.recordIds);
    // Lần trước chưa ghi: gửi lại với đúng mã yêu cầu cũ, để máy chủ nhận ra nếu lệnh cũ rốt cuộc đã tới.
    requestKey=prior.requestKey??prior.attemptId;
  }
  const pending=store.markPending(scope,{requestKey,operation:options.operation,meta:options.meta});
  let completed=false;
  const stopTracking=trackRunningAttempt(pending.attemptId);
  try{
    const result=await work({attemptId:pending.attemptId,requestKey,recordCompleted:ids=>{completed ||= ids.length>0;store.recordCompleted(scope,pending.attemptId,ids);},releaseCompleted:()=>{completed=false;}});
    if(!store.clearConfirmed(scope,pending.attemptId))throw new FinancialPendingError(store.read(scope));
    return result;
  }catch(error){
    // Only a verified no-write rejection permits a corrected request. A plain Error is not such proof.
    if(!completed&&isConfirmedFinancialRejection(error))store.clearConfirmed(scope,pending.attemptId);
    throw error;
  }finally{stopTracking();}
}
