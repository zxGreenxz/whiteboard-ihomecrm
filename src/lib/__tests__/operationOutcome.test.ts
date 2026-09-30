import {expect,it} from 'vitest';
import {hasUnconfirmedResponse} from '../operationOutcome';
import {FinancialWorkflowError} from '../financialWorkflowError';
it.each(['unknown','partial'] as const)('keeps durable %s blocked even after reload without its original network cause',outcome=>{
 expect(hasUnconfirmedResponse(new FinancialWorkflowError('Cần đối chiếu kết quả.',outcome,[{id:'v1',label:'Phiếu đã tạo'}]))).toBe(true);
});
it('keeps a confirmed business rejection editable',()=>{
 expect(hasUnconfirmedResponse(new FinancialWorkflowError('Dữ liệu chưa hợp lệ.','failure',[]))).toBe(false);
});
