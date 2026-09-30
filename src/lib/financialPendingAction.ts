import {financialPending,FinancialPendingError,type FinancialPendingScope} from './financialPending';
import {isConfirmedFinancialRejection} from './financialWorkflow';

/** Domain work must validate its positive receipt before returning. No replay payload is persisted. */
export async function runFinancialPending<T>(scope:FinancialPendingScope,work:(progress:{attemptId:string;requestKey:string;recordCompleted:(ids:readonly string[])=>void})=>Promise<T>,store=financialPending):Promise<T>{
  const pending=store.markPending(scope,{requestKey:crypto.randomUUID()});
  let completed=false;
  try{
    const result=await work({attemptId:pending.attemptId,requestKey:pending.requestKey!,recordCompleted:ids=>{completed ||= ids.length>0;store.recordCompleted(scope,pending.attemptId,ids);}});
    if(!store.clearConfirmed(scope,pending.attemptId))throw new FinancialPendingError(store.read(scope));
    return result;
  }catch(error){
    // Only a verified no-write rejection permits a corrected request. A plain Error is not such proof.
    if(!completed&&isConfirmedFinancialRejection(error))store.clearConfirmed(scope,pending.attemptId);
    throw error;
  }
}
