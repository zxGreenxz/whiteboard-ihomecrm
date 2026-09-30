import {expect,it} from 'vitest';
import {FinancialWorkflowError} from '../financialWorkflow';
import {friendlyError} from '../friendlyError';
it('retains controlled partial feedback and identities ahead of the raw permission cause',()=>{
 const error=new FinancialWorkflowError('Đã lập phiếu; chưa cập nhật xong bảng lương.','partial',[{id:'voucher1',label:'Phiếu đã nhận'}],{code:'42501',message:'raw SQL table payroll'});
 const feedback=friendlyError(error,'Chưa chi lương',{operation:'chi lương',financial:true});
 expect(feedback.outcome).toBe('partial');expect(feedback.recovery).toBe('reconcile');expect(feedback.description).toContain('chưa cập nhật');expect(feedback.description).toContain('voucher1');expect(feedback.description).not.toContain('raw SQL');expect(feedback.code).toBe('42501');
});
