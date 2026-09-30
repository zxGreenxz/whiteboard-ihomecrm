import {it,expect} from 'vitest';
import {readInvoiceRelatedVouchers,readForceDeletePaymentRows} from '../invoiceRelatedRead';
it('query phiếu liên quan null không được thành không có chứng từ',()=>{expect(()=>readInvoiceRelatedVouchers(null)).toThrow();});
it.each([null,NaN,''])('item phiếu liên quan sai unit price %s không được thành0',unit_price=>{expect(()=>readInvoiceRelatedVouchers([{items:[{quantity:1,unit_price}]}] as unknown as Parameters<typeof readInvoiceRelatedVouchers>[0])).toThrow();});
it.each([null,NaN,''])('payment cần đối chiếu trước force cancel amount sai %s không được thành0',amount=>{expect(()=>readForceDeletePaymentRows([{amount}] as unknown as Parameters<typeof readForceDeletePaymentRows>[0])).toThrow();});
it('nguồn [] hoặc số0 thật vẫn hợp lệ',()=>{expect(readInvoiceRelatedVouchers([])).toEqual([]);expect(readInvoiceRelatedVouchers([{items:[{quantity:1,unit_price:0}]}])).toEqual([{items:[{quantity:1,unit_price:0}]}]);expect(readForceDeletePaymentRows([{amount:0}])).toEqual([{amount:0}]);});
