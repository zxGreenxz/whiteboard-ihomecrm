import { describe, expect, it } from 'vitest';
import { invoiceLifecycleFeedback, confirmedInvoiceReceipt } from '../invoiceFeedback';
describe('phản hồi hoá đơn theo kết quả máy chủ',()=>{
 it('khôi phục không đoán về đã duyệt',()=>{expect(invoiceLifecycleFeedback({invoice:{id:'i1',invoice_number:'HD-01',status:'PARTIAL_PAID'}},'khôi phục').description).toContain('thu một phần');});
 it('no-op nói không thay đổi',()=>{expect(invoiceLifecycleFeedback({invoice:{id:'i1',status:'CANCELLED'},noop:true},'huỷ').title).toContain('không thay đổi');});
 it('không coi phản hồi thiếu mã là đã tạo',()=>{expect(()=>confirmedInvoiceReceipt(null)).toThrow(TypeError);});
});
