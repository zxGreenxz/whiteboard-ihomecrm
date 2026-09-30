import {expect,it} from 'vitest';
import {collectionFailureMessage,collectionSuccessMessage,confirmedCollection} from '../collectionFeedback';
it('D05 chỉ dùng số tiền và dư máy chủ xác nhận',()=>{
 expect(collectionSuccessMessage({collection_id:'c1',invoice_id:'i1',applied_amount:'500000',invoice:{invoice_number:'HD01',remaining_amount:'100000'}})).toBe('Đã ghi nhận 500.000 đ vào hoá đơn HD01. Còn phải thu 100.000 đ.');
});
it('không suy dư bằng0 khi không có readback',()=>{
 expect(collectionSuccessMessage({collection_id:'c1',invoice_id:'i1',applied_amount:500000})).toContain('Tải lại hoá đơn');
 expect(()=>confirmedCollection(null)).toThrow(TypeError);
});
it('D07 nói tiền dư thay credit, unknown không hướng dẫn gửi lại',()=>{
 expect(collectionFailureMessage(new Error('Không thể giữ credit cho hóa đơn không có hợp đồng'))).toContain('chưa thể giữ tiền dư');
 expect(collectionFailureMessage(new TypeError('Failed to fetch'))).toContain('đối chiếu các khoản thu');
 expect(collectionFailureMessage({code:'XX000',message:'relation private missing'})).not.toContain('relation');
});
