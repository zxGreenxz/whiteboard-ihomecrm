// `handleError` của ChatPanel chỉ biết một nhánh: not_entitled/not_permitted/403.
// Mọi thứ còn lại rơi vào `Lỗi: ${msg}` — người dùng đọc được nguyên văn
// `organization_required` hay `rollout_unavailable: công cụ "..."` và không biết
// phải làm gì. Đây đều là những lỗi CÓ HÀNH ĐỘNG SỬA rõ ràng.
import { describe, expect, it } from 'vitest';
import { THONG_BAO_CHUA_CHON_TO_CHUC, dienGiaiLoiChat } from '../chatErrors';

describe('dienGiaiLoiChat', () => {
  it('thiếu tổ chức: bảo thẳng phải chọn tổ chức', () => {
    expect(dienGiaiLoiChat('organization_required')).toBe('Hãy chọn tổ chức trước khi hỏi Copilot.');
  });

  it('lệch tổ chức: bảo mở lại cuộc trò chuyện', () => {
    expect(dienGiaiLoiChat('organization_mismatch')).toBe('Tổ chức đã đổi, mở lại cuộc trò chuyện.');
  });

  it('rollout tắt: nói rõ là chưa bật cho tổ chức, kể cả khi kèm đuôi mô tả', () => {
    expect(dienGiaiLoiChat('rollout_unavailable: công cụ "ds_phong" đã bị tắt.')).toBe(
      'Trang/công cụ này chưa được bật cho tổ chức.',
    );
  });

  it('hết quyền/hết hạn mức: giữ nguyên câu cũ của panel', () => {
    const mong = 'Tài khoản chưa được cấp quyền dùng AI Copilot hoặc đã hết hạn mức hôm nay.';
    expect(dienGiaiLoiChat('not_entitled')).toBe(mong);
    expect(dienGiaiLoiChat('Request failed with status 403')).toBe(mong);
  });

  it('mã riêng của rollout admin thì nhường cho formatCopilotRolloutError', () => {
    expect(dienGiaiLoiChat('copilot_rollout_stale_revision')).toBe(
      'Rollout đã thay đổi bởi phiên khác; hãy tải lại snapshot rồi thử lại.',
    );
    expect(dienGiaiLoiChat('rollout_evidence_required')).toBe(
      'Cần nhập đầy đủ lý do, liên kết bằng chứng và tham chiếu rollback.',
    );
  });

  it('`not_permitted` là chuyện HẠN MỨC CHAT, không phải rollout admin', () => {
    // formatCopilotRolloutError cũng nhận `not_permitted` và trả câu về quyền
    // sửa rollout — câu đó vô nghĩa với người đang chat. Nhánh chat phải thắng.
    expect(dienGiaiLoiChat('not_permitted')).toBe(
      'Tài khoản chưa được cấp quyền dùng AI Copilot hoặc đã hết hạn mức hôm nay.',
    );
  });

  it('câu "chưa chọn tổ chức" là HẰNG SỐ dùng chung với cửa gửi, không chép tay', () => {
    // Cửa gửi trong `availabilityGate` dùng lại đúng hằng số này. Hai bản sao
    // của cùng một câu sẽ lệch nhau ở lần sửa chữ đầu tiên.
    expect(dienGiaiLoiChat('organization_required')).toBe(THONG_BAO_CHUA_CHON_TO_CHUC);
  });

  it('sai tổ chức: nói rõ là sai CÔNG TY, không phải hết hạn mức', () => {
    // Panel ghép `code: message` (LoiModel.code + LoiModel.message), nên chuỗi
    // thật đi vào đây có cả mã máy lẫn câu tiếng Anh của tầng dưới.
    expect(dienGiaiLoiChat('organization_forbidden: No access to the selected organization')).toBe(
      'Bạn không có quyền dùng Copilot trong tổ chức đang chọn.',
    );
  });

  it('mã cụ thể thắng phỏng đoán theo mã HTTP', () => {
    // `organization_forbidden` về trên đường 403. Nếu nhánh /403/ chạy trước thì
    // người dùng đọc "hết hạn mức hôm nay" và đi xin quota — trong khi việc phải
    // làm là đổi ô chọn tổ chức.
    expect(dienGiaiLoiChat('organization_forbidden: HTTP 403')).toBe(
      'Bạn không có quyền dùng Copilot trong tổ chức đang chọn.',
    );
  });

  it('mã LẠ vẫn kéo theo câu gốc, không hiện trơ một token', () => {
    // Đây là lý do panel gửi CẢ mã lẫn câu. Gửi mỗi `code` thì người dùng đọc
    // "Lỗi: busy" và không có gì để chụp màn hình gửi đi.
    const ra = dienGiaiLoiChat('busy: Too many concurrent requests');
    expect(ra).toContain('Too many concurrent requests');
    expect(ra).not.toBe('Lỗi: busy');
  });

  it('lỗi lạ vẫn hiện nguyên văn — giấu đi thì không ai gỡ được', () => {
    expect(dienGiaiLoiChat('ECONNRESET')).toBe('Lỗi: ECONNRESET');
  });

  it('chuỗi rỗng cũng không làm vỡ định dạng', () => {
    expect(dienGiaiLoiChat('')).toBe('Lỗi: ');
  });
});
