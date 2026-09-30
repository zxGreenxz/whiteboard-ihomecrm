import {PendingCollectionError,CollectionStorageError} from './pendingCollection';
import {friendlyError} from './friendlyError';
import {voucherOutcomeUnknown} from './voucherFeedback';

// Verified client validation messages from paymentRecordRpc.ts/useBulkRecordPayment.ts.
const rules = [
  'Mỗi dòng thanh toán phải lớn hơn 0 và tối đa 2 số lẻ', 'Mỗi dòng thanh toán phải có sổ quỹ nhận',
  'Sổ quỹ nhận tiền phải là sổ thật, không phải sổ ảo', 'Sổ quỹ tiền thối phải là sổ ảo',
  'Sổ quỹ làm tròn phải là sổ ảo', 'Thiếu sổ quỹ tiền thối', 'Thiếu sổ quỹ làm tròn tiền thiếu',
  'Phải có ít nhất một dòng thanh toán', 'Số tiền thanh toán bằng 0', 'Tiền giữ nợ khách phải đúng bằng phần dư',
  'Không được làm tròn bỏ qua phần tiền cọc còn thiếu',
].map(message=>({message,description:message}));
for(const [method,label] of [['TM','Tiền mặt'],['TK','Chuyển khoản'],['TT','Thanh toán']] as const) {
 rules.push({message:`Thiếu sổ quỹ nhận cho ${method}`,description:`Chọn sổ nhận tiền cho hình thức ${label}.`});
 rules.push({message:`Sổ nhận ${method} phải là sổ quỹ thật`,description:`Chọn sổ tiền mặt hoặc ngân hàng cho hình thức ${label}.`});
}
rules.push({message:'Không thể giữ credit cho hóa đơn không có hợp đồng',description:'Hoá đơn chưa gắn hợp đồng nên chưa thể giữ tiền dư cho kỳ sau. Kiểm tra hợp đồng của hoá đơn.'});
rules.push({message:'Hóa đơn không gắn hợp đồng nên không thể giữ credit',description:'Hoá đơn chưa gắn hợp đồng nên chưa thể giữ tiền dư cho kỳ sau. Kiểm tra hợp đồng của hoá đơn.'});

export function collectionFailureMessage(error:unknown):string {
  if(error instanceof PendingCollectionError||error instanceof CollectionStorageError)return error.message;
  if(voucherOutcomeUnknown(error)) return 'Chưa xác nhận được kết quả thu tiền. Hãy tải lại hoá đơn và đối chiếu các khoản thu trước khi thực hiện tiếp.';
  const feedback=friendlyError(error,'Không thể ghi nhận thu tiền',{operation:'ghi nhận thu tiền',financial:true,rules});
  return feedback.description;
}

export function confirmedCollection(value:unknown):Record<string,unknown> {
  const result=value && typeof value==='object'?value as Record<string,unknown>:{};
  if(typeof result.collection_id!=='string'||!result.collection_id||typeof result.invoice_id!=='string'||!result.invoice_id) throw new TypeError('Missing collection confirmation');
  return result;
}

export function collectionSuccessMessage(value:unknown):string {
  const result=confirmedCollection(value);
  const invoice=result.invoice && typeof result.invoice==='object'?result.invoice as Record<string,unknown>:{};
  const amount=Number(result.applied_amount);
  const remaining=invoice.remaining_amount==null?null:Number(invoice.remaining_amount);
  const money=(n:number)=>n.toLocaleString('vi-VN')+' đ';
  const label=typeof invoice.invoice_number==='string'?`hoá đơn ${invoice.invoice_number}`:'hoá đơn';
  return `${result.recovered?'Đã đối chiếu và xác nhận lần thu trước. Không tạo khoản thu mới. ':''}${Number.isFinite(amount)?`Đã ghi nhận ${money(amount)} vào ${label}.`:`Đã ghi nhận khoản thu cho ${label}.`}${remaining!==null&&Number.isFinite(remaining)?` Còn phải thu ${money(Math.max(remaining,0))}.`:' Tải lại hoá đơn để xem số còn phải thu.'}`;
}
