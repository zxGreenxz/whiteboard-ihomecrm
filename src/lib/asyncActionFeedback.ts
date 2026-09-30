import {toast} from 'sonner';
import {reportBoundaryError} from '@/components/errors/boundaryReporter';
import type {FeedbackOptions,FriendlyError} from './friendlyError';

let nextFeedbackId=0;
type VisibleFeedback=Pick<FriendlyError,'title'|'description'>;

function safeFallback(fallback:string,options?:FeedbackOptions):VisibleFeedback {
 return {
  title:options?.operation?`Chưa xác nhận được kết quả ${options.operation}`:fallback,
  description:options?.financial
   ? 'Giữ thông tin đang nhập. Đối chiếu phiếu, sổ quỹ. Không gửi thêm khi chưa rõ kết quả.'
   : 'Giữ thông tin đang nhập. Kiểm tra trạng thái.',
 };
}

function reportDeliveryFailure(cause:unknown,actionError:unknown):void {
 try {
  reportBoundaryError(Object.assign(new Error('Feedback unavailable'),{cause,actionError}));
 } catch {
  // Diagnostics must not reject the detached feedback task.
 }
}

async function deliver(error:unknown,fallback:string,options:FeedbackOptions|undefined,id:string):Promise<void> {
 let feedback:VisibleFeedback;
 try {
  const {friendlyError}=await import('./friendlyError');
  feedback=friendlyError(error,fallback,options);
 } catch(cause) {
  reportDeliveryFailure(cause,error);
  feedback=safeFallback(fallback,options);
 }
 try {
  toast.error(feedback.title,{description:feedback.description,id});
 } catch(cause) {
  reportDeliveryFailure(cause,error);
  const safe=safeFallback(fallback,options);
  try {
   // Reuse this delivery ID if the first sink published before throwing.
   toast.error(safe.title,{description:safe.description,id});
  } catch(fallbackCause) {
   reportDeliveryFailure(fallbackCause,error);
  }
 }
}

/** Error-only delivery keeps the converter out of the bootstrap import graph. */
export function notifyActionError(error:unknown,fallback:string,options?:FeedbackOptions):void {
 const id=`async-action-error-${++nextFeedbackId}`;
 void deliver(error,fallback,options,id).catch(cause=>reportDeliveryFailure(cause,error));
}
