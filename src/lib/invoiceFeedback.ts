import {friendlyError} from './friendlyError';
import {voucherOutcomeUnknown} from './voucherFeedback';

export function invoiceFailureMessage(error:unknown,operation:string):string {
  if(error instanceof InvoicePartialError) return error.message;
  if(voucherOutcomeUnknown(error)) return `Chưa xác nhận được kết quả ${operation}. Tải lại hoá đơn và kiểm tra trạng thái, các khoản thu trước khi thực hiện tiếp.`;
  return friendlyError(error,`Không thể ${operation}`,{operation,financial:true,rules:[
    {code:'23505',message:/idx_invoices_unique_contract_billing/,description:'Hợp đồng đã có hoá đơn cho kỳ đã chọn. Mở hoá đơn đang có hoặc chọn kỳ khác.'},
    {message:'Không thể chỉnh sửa hoá đơn ở trạng thái này',description:'Hoá đơn đã thay đổi trạng thái nên chưa thể sửa theo cách này. Tải lại hoá đơn để kiểm tra.'},
    {message:'Không thể huỷ hoá đơn ở trạng thái này (đã thu tiền hoặc đã huỷ)',description:'Hoá đơn đã thu tiền hoặc đã huỷ nên không thể huỷ theo cách này. Kiểm tra trạng thái và các khoản thu trên hoá đơn.'},
  ]}).description;
}

export function invoiceLabel(value:unknown):string {
  const row=value && typeof value==='object'?value as Record<string,unknown>:{};
  return typeof row.invoice_number==='string'&&row.invoice_number?`hoá đơn ${row.invoice_number}`:'hoá đơn';
}

export class InvoicePartialError extends Error {
  constructor(message:string, readonly invoiceId:string, readonly cause?:unknown) { super(message); this.name='InvoicePartialError'; }
}

export function confirmedInvoiceReceipt(value:unknown): Record<string,unknown> & {id:string} {
  const fail = (): never => { throw new TypeError('Chưa xác nhận được hoá đơn sau khi gửi yêu cầu.'); };
  const record = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
    return input as Record<string, unknown>;
  };
  const result = record(value);
  const row = 'invoice' in result ? record(result.invoice) : result;
  if (!('id' in row) && !('invoice_id' in row)) return fail();
  const ids: string[] = [];
  // The canonical create RPC returns invoice_id; existing row/nested receipts use id.
  // Every supplied identity must agree, so an alias cannot hide a malformed receipt.
  for (const part of row === result ? [row] : [result, row]) {
    for (const key of ['id', 'invoice_id'] as const) {
      if (!(key in part)) continue;
      const id = part[key];
      if (typeof id !== 'string' || !id.trim() || id !== id.trim()) return fail();
      if (key === 'invoice_id' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return fail();
      ids.push(id);
    }
  }
  const id = ids[0];
  if (!id || ids.some(candidate => candidate !== id)) return fail();
  return { ...row, id };
}

export function invoiceLifecycleFeedback(value:unknown,operation:string):{title:string;description:string} {
  const result=value && typeof value==='object'?value as Record<string,unknown>:{};
  const row=result.invoice && typeof result.invoice==='object'?result.invoice as Record<string,unknown>:result;
  const label=invoiceLabel(row);
  const states:Record<string,string>={DRAFT:'Nháp',APPROVED:'Đã duyệt, chưa thu',PARTIAL_PAID:'Đã thu một phần',PAID:'Đã thu đủ',OVERDUE:'Quá hạn',CANCELLED:'Đã huỷ'};
  const status=typeof row.status==='string'?states[row.status]:undefined;
  if(!status) return {title:'Chưa xác nhận được trạng thái hoá đơn',description:`Đã nhận phản hồi cho yêu cầu ${operation} ${label}, nhưng chưa đọc được trạng thái mới. Tải lại và đối chiếu trước khi thao tác tiếp.`};
  return {title:result.noop===true?`Trạng thái ${label} không thay đổi`:`Đã ${operation} ${label}`,description:`Trạng thái hiện tại: ${status}. Kiểm tra các khoản thu trên hoá đơn khi cần đối chiếu.`};
}
