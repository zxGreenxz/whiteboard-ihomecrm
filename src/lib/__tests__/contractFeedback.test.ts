import { describe, expect, it } from 'vitest';
import { contractCreateFeedback } from '../contractFeedback';

describe('contract create feedback', () => {
  it.each([
    ['Kỳ tính tiền đầu phải nằm trong thời hạn hợp đồng', 'start_billing_date'],
    ['Phòng đang được người khác giữ chỗ', 'room_id'],
    ['Hợp đồng cần danh sách khách không trùng và đúng một người đại diện', 'customers'],
    ['Đơn giá dịch vụ không hợp lệ', 'services'],
    ['Phiếu cọc được chọn không hợp lệ hoặc đã được dùng', 'orphan_deposits'],
    ['Tiền cọc đã nhận vượt số cọc của hợp đồng', 'total_deposit'],
    ['Thiếu cọc: phải chọn DEBT hoặc FIRST_INVOICE', 'deposit_debt_mode'],
    ['Nợ cọc cần lý do và hạn bổ sung', 'deposit_debt_reason'],
    ['Dòng cọc hóa đơn đầu phải đúng bằng phần cọc còn thiếu', 'first_invoice'],
    ['Kỳ hạng mục doanh thu phải nằm trong kỳ tính tiền đầu', 'first_invoice'],
  ])('maps verified reason %s to %s', (message, field) => {
    expect(contractCreateFeedback({ code: '22023', message }).fieldErrors).toHaveProperty(field);
  });

  it('does not guess a field from SQLSTATE alone', () => {
    expect(contractCreateFeedback({ code: '22023', message: 'Một điều kiện khác' }).fieldErrors).toEqual({});
  });
  it('directs an expired automatic template to its actual settings page without a phantom form field', () => {
    const feedback = contractCreateFeedback({ code: '42501', message: 'Mẫu hợp đồng không thuộc tổ chức hoặc không còn hiệu lực' });
    expect(feedback.fieldErrors).toEqual({});
    expect(feedback.description).toContain('Cài đặt > Mẫu tài liệu');
  });
});
