import { actionErrorMessage } from './actionFeedback';
import { hasUnconfirmedResponse } from './operationOutcome';
export class ZaloActionUnknownError extends Error {
  readonly jobId?: string;
  constructor(operation:string, receipt?:{label:string;id:string;jobId?:string}, readonly cause?:unknown) {
    super(`Chưa xác nhận được kết quả ${operation}.${receipt ? ` ${receipt.label}: ${receipt.id}.` : ''} Đọc lại trạng thái trước khi thực hiện tiếp; không gửi lại yêu cầu này.`);
    this.jobId=receipt?.jobId;
  }
}
export class ZaloActionFailureError extends Error {
  constructor(message:string,readonly cause?:unknown){super(message);}
}
export const isZaloActionUnconfirmed=(error:unknown)=>error instanceof ZaloActionUnknownError || hasUnconfirmedResponse(error);
export function zaloActionErrorMessage(error:unknown,operation:string):string {
  if(error instanceof ZaloActionUnknownError || error instanceof ZaloActionFailureError) return error.message;
  if(hasUnconfirmedResponse(error)) return `Chưa xác nhận được kết quả ${operation}. Đọc lại trạng thái trước khi thực hiện tiếp; không gửi lại yêu cầu này.`;
  return actionErrorMessage(error,`Chưa ${operation}`);
}
