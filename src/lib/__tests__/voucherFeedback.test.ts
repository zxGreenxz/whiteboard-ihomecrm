import {FinancialWorkflowError} from '../financialWorkflowError';
import { incomeExpenseFormSchema } from '../incomeExpenseValidation';
import { describe, expect, it } from 'vitest';
import { approvalDecisionFeedback, createdVoucherFeedback, voucherFailureMessage } from '../voucherFeedback';

describe('Phản hồi dựa kết quả phiếu', () => {
  it('tạo chờ duyệt không khẳng định đã thu chi', () => {
    expect(createdVoucherFeedback({ id: 'v1', approval_status: 'UNAPPROVED', code: 'PC01' }).message).toBe('Đã tạo phiếu PC01. Phiếu đang chờ duyệt, chưa ghi nhận thu/chi.');
    expect(createdVoucherFeedback({ id: 'v1', approval_status: 'APPROVED', posting_status: 'UNPOSTED' }).message).toBe('Đã tạo phiếu. Phiếu đã được duyệt, chưa ghi nhận thu/chi.');
  });
  it('chỉ kết luận ghi sổ khi máy chủ trả POSTED', () => {
    expect(createdVoucherFeedback({ id: 'v1', posting_status: 'POSTED' }).message).toBe('Đã tạo phiếu và ghi nhận thu/chi vào sổ quỹ.');
    expect(createdVoucherFeedback(null).kind).toBe('warning');
  });
  it('duyệt một bước vẫn chờ không báo duyệt hoàn tất', () => {
    expect(approvalDecisionFeedback({ state: 'PENDING_APPROVAL' }, 'APPROVE').message).toBe('Đã ghi nhận bước duyệt của bạn. Yêu cầu vẫn đang chờ các bước duyệt còn lại.');
    expect(approvalDecisionFeedback({ state: 'POSTED' }, 'APPROVE').message).toBe('Đã duyệt yêu cầu và ghi nhận thu/chi vào sổ quỹ.');
    expect(approvalDecisionFeedback({ state: 'REJECTED' }, 'REJECT').message).toBe('Đã từ chối yêu cầu.');
    expect(approvalDecisionFeedback({}, 'APPROVE').kind).toBe('warning');
  });
  it('timeout không khuyên thực hiện giao dịch thêm lần nữa; lỗi tiếng Việt cụ thể còn nguyên', () => {
    expect(voucherFailureMessage(new TypeError('Failed to fetch'), 'tạo phiếu')).toBe('Chưa xác nhận được kết quả tạo phiếu. Hãy tải lại danh sách và kiểm tra trạng thái phiếu trước khi thực hiện tiếp.');
    expect(voucherFailureMessage({code:'42501',message:'Không có quyền sử dụng sổ quỹ này'}, 'tạo phiếu')).toContain('Không có quyền sử dụng sổ quỹ này');
    expect(voucherFailureMessage({code:'55000',message:'canonical income expense is frozen'}, 'huỷ phiếu')).not.toMatch(/canonical|frozen/);
  });
});


describe('C05 số lần lặp hữu hạn', () => {
  const valid={type:'EXPENSE',name:'Phiếu',building_id:'b1',account_id:'a1',voucher_date:'2026-09-30',repeat_cycle:'MONTH',repeat_infinity:false,items:[{income_expense_type_id:'t1',quantity:1,unit_price:1,start_date:'2026-09-01',end_date:'2026-09-30'}]};
  it.each([0,-1,1.5,241,Number.NaN])('chặn %s bằng thông báo tiếng Việt đúng ô', repeat_count => {
    const result=incomeExpenseFormSchema.safeParse({...valid,repeat_count});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({path:['repeat_count'],message:expect.stringContaining('số nguyên từ 1 đến 240')})]));
  });
  it.each([1,240])('giữ nguyên biên hợp lệ %s',repeat_count=>expect(incomeExpenseFormSchema.safeParse({...valid,repeat_count}).success).toBe(true));
});

it.each(['partial','unknown'] as const)('keeps completed voucher IDs in %s feedback after losing the original cause',outcome=>{
 const error=new FinancialWorkflowError('Đã tạo phiếu, cần đối chiếu bước còn thiếu.',outcome,[{id:'voucher-1',label:'Đã tạo phiếu'}]);
 expect(voucherFailureMessage(error,'lập phiếu')).toContain('voucher-1');
 expect(voucherFailureMessage(error,'lập phiếu')).toContain('bước còn thiếu');
});
