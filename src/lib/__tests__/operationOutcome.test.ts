import {expect,it} from 'vitest';
import {hasUnconfirmedResponse,isKnownRejectionCode} from '../operationOutcome';
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
// 24/11/2026: lời từ chối đã mang mã rõ mà câu báo nhúng số tiền "1.502.000" từng bị coi là rớt mạng,
// làm dấu chờ đối chiếu ở lại dù máy chủ đã lùi giao dịch.
it.each([
 ['P0001','Số tiền 1.502.000 đ vượt số dư của sổ.'],
 ['23505','duplicate key value violates unique constraint "ie_code_5035_key"'],
 ['42501','permission denied for voucher 504'],
 ['PGRST116','JSON object requested, multiple (or no) rows returned (id 1503)'],
])('mã từ chối %s có 502/503/504 trong câu báo vẫn là từ chối đã xác nhận',(code,message)=>{
 expect(hasUnconfirmedResponse({code,message})).toBe(false);
 expect(isConfirmedFinancialRejection({code,message})).toBe(true);
});
it('lỗi 5xx thật vẫn là chưa rõ kết quả dù kèm mã từ chối',()=>{
 expect(hasUnconfirmedResponse({code:'P0001',status:503,message:'Service Unavailable'})).toBe(true);
 expect(hasUnconfirmedResponse({code:'P0001',statusCode:502,message:'Bad Gateway'})).toBe(true);
 expect(isConfirmedFinancialRejection({code:'P0001',status:504,message:'x'})).toBe(false);
});
it('không có mã từ chối đã biết thì 502/503/504 trong câu báo vẫn là chưa rõ kết quả',()=>{
 expect(hasUnconfirmedResponse({message:'Request failed with 502'})).toBe(true);
 expect(hasUnconfirmedResponse({code:'',message:'error 504'})).toBe(true);
 expect(hasUnconfirmedResponse(new Error('Bad gateway 503'))).toBe(true);
});
it('chỉ ba số đó được miễn: chữ báo rớt mạng vẫn được dò với mã từ chối khác PT409',()=>{
 expect(hasUnconfirmedResponse({code:'55P03',message:'canceling statement due to lock timeout'})).toBe(true);
 expect(hasUnconfirmedResponse({code:'P0001',message:'TypeError: Failed to fetch'})).toBe(true);
});
it('PGRST116 nằm trong các mã từ chối đã biết; mã lạ và mã quá hạn thì không',()=>{
 expect(isKnownRejectionCode('PGRST116')).toBe(true);
 expect(isConfirmedFinancialRejection({code:'PGRST116',message:'JSON object requested, multiple (or no) rows returned'})).toBe(true);
 expect(isKnownRejectionCode('57014')).toBe(false);
 expect(isKnownRejectionCode('XX000')).toBe(false);
 expect(isKnownRejectionCode(undefined)).toBe(false);
});
