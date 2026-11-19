import {expect,it} from 'vitest';
import {hasUnconfirmedResponse} from '../operationOutcome';
import {FinancialWorkflowError} from '../financialWorkflowError';
import {isConfirmedFinancialRejection} from '../financialWorkflow';
it.each(['unknown','partial'] as const)('keeps durable %s blocked even after reload without its original network cause',outcome=>{
 expect(hasUnconfirmedResponse(new FinancialWorkflowError('Cần đối chiếu kết quả.',outcome,[{id:'v1',label:'Phiếu đã tạo'}]))).toBe(true);
});
it('keeps a confirmed business rejection editable',()=>{
 expect(hasUnconfirmedResponse(new FinancialWorkflowError('Dữ liệu chưa hợp lệ.','failure',[]))).toBe(false);
});
// 20261116015253: RPC kiểm phiên bản trả PT409. Câu lỗi nhúng md5 / số dư có thể chứa "502/503/504" —
// không được coi là mất phản hồi (guard tài chính sẽ chặn khoá đó vĩnh viễn).
it.each([
 'PROFIT_SOURCE_CONFLICT expected 9f5035c1aa0b4e1d8c0e7f6a5b4c3d2e, current 0a1b2c3d4e5f60718293a4b5c6d7e8f9',
 'Số dư hệ thống đã đổi từ 15030000.00 thành 15040000.00 kể từ lúc đề nghị — huỷ đề nghị và đếm lại.',
])('PT409 có số trong câu lỗi vẫn là từ chối đã xác nhận: %s',message=>{
 expect(hasUnconfirmedResponse({code:'PT409',message})).toBe(false);
 expect(isConfirmedFinancialRejection({code:'PT409',message})).toBe(true);
});
it('lỗi không mang mã PT409 vẫn dò câu lỗi như cũ',()=>{
 expect(hasUnconfirmedResponse({message:'upstream request timeout'})).toBe(true);
 expect(hasUnconfirmedResponse({code:'XX000',message:'proxy 503'})).toBe(true);
});
