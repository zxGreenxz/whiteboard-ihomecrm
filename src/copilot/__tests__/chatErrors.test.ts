// `handleError` của ChatPanel chỉ biết một nhánh: not_entitled/not_permitted/403.
// Mọi thứ còn lại rơi vào `Lỗi: ${msg}` — người dùng đọc được nguyên văn
// `organization_required` hay `rollout_unavailable: công cụ "..."` và không biết
// phải làm gì. Đây đều là những lỗi CÓ HÀNH ĐỘNG SỬA rõ ràng.
import { describe, expect, it } from 'vitest';
import { dienGiaiLoiChat } from '../chatErrors';

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

  it('lỗi lạ vẫn hiện nguyên văn — giấu đi thì không ai gỡ được', () => {
    expect(dienGiaiLoiChat('ECONNRESET')).toBe('Lỗi: ECONNRESET');
  });

  it('chuỗi rỗng cũng không làm vỡ định dạng', () => {
    expect(dienGiaiLoiChat('')).toBe('Lỗi: ');
  });
});
