// `handleError` của ChatPanel chỉ biết một nhánh: not_entitled/not_permitted/403.
// Mọi thứ còn lại rơi vào `Lỗi: ${msg}` — người dùng đọc được nguyên văn
// `organization_required` hay `rollout_unavailable: công cụ "..."` và không biết
// phải làm gì. Đây đều là những lỗi CÓ HÀNH ĐỘNG SỬA rõ ràng.
import { describe, expect, it } from 'vitest';
import { THONG_BAO_CHUA_CHON_TO_CHUC, dienGiaiLoiChat, dienGiaiLoiKeHoach } from '../chatErrors';

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

  it('chạm trần TOKEN nói đúng là token, không nói USD', () => {
    // `daily_token_quota` là mã RIÊNG của cửa mới trong `reserve_ai_usage`
    // (`20260903034632`). Gộp vào câu "hết hạn mức USD" là nói sai: hai provider
    // đang bật đều báo giá 0, người dùng chưa tiêu một xu nào.
    expect(dienGiaiLoiChat('daily_token_quota')).toBe(
      'Hôm nay bạn đã dùng hết hạn mức token Copilot. Thử lại vào ngày mai hoặc liên hệ quản trị.',
    );
    // Proxy ghép `code: message`, nên chuỗi thật thường có đuôi.
    expect(dienGiaiLoiChat('daily_token_quota: HTTP 403')).toBe(
      'Hôm nay bạn đã dùng hết hạn mức token Copilot. Thử lại vào ngày mai hoặc liên hệ quản trị.',
    );
  });

  it('`daily_quota` (trần USD) có câu RIÊNG, không rơi vào nhánh 403 chung', () => {
    // Trước đây nó rơi xuống `/not_entitled|not_permitted|403/` và người dùng đọc
    // "chưa được cấp quyền HOẶC hết hạn mức" — một câu hai vế, không vế nào chắc.
    expect(dienGiaiLoiChat('daily_quota')).toBe(
      'Hôm nay hệ thống đã dùng hết hạn mức chi phí Copilot. Thử lại vào ngày mai hoặc liên hệ quản trị.',
    );
  });

  it('daily_token_quota KHÔNG bị `daily_quota` nuốt mất', () => {
    // Hai mã khác nhau, hai cột cấu hình khác nhau. Nếu bảng tra để `daily_quota`
    // đứng trước và khớp theo chuỗi con thì… may là không khớp — nhưng test này
    // ghim lại điều đó để một lần đổi tên mã không lặng lẽ gộp hai câu.
    expect(dienGiaiLoiChat('daily_token_quota')).not.toBe(dienGiaiLoiChat('daily_quota'));
  });

  it('`copilot_feature_disabled` nói ĐÚNG việc: công tắc tắt, không phải thiếu quyền', () => {
    // Ba RPC miền nhạy cảm RAISE mã này với ERRCODE 42501. Cùng mã SQL với
    // `not_permitted`, nhưng hai câu chuyện khác nhau và hai người sửa khác nhau.
    expect(dienGiaiLoiChat('copilot_feature_disabled')).toBe(
      'Tính năng này đang tắt cho công ty của bạn.',
    );
    expect(dienGiaiLoiChat('copilot_feature_disabled: HTTP 403')).toBe(
      'Tính năng này đang tắt cho công ty của bạn.',
    );
  });

  it('`copilot_feature_disabled` KHÔNG bị nhánh 403 chung nuốt mất', () => {
    // Đây là hồi quy thật sự đáng canh: chuỗi lỗi từ PostgREST hay mang cả mã
    // HTTP, và nhánh phỏng đoán `/not_entitled|not_permitted|403/` nằm ngay sau
    // bảng tra. Một lần xếp sai thứ tự là người dùng lại đọc "chưa được cấp
    // quyền hoặc hết hạn mức" cho một thứ họ không tự sửa được.
    expect(dienGiaiLoiChat('copilot_feature_disabled: HTTP 403')).not.toBe(
      dienGiaiLoiChat('not_permitted'),
    );
  });

  it('chuỗi rỗng cũng không làm vỡ định dạng', () => {
    expect(dienGiaiLoiChat('')).toBe('Lỗi: ');
  });
});

// G5-B — điểm nối #4: 12 mã của uỷ quyền đứng phải có câu riêng, không rơi
// vào `Lỗi kế hoạch: <mã trần>` của `dienGiaiLoiKeHoach`.
describe('dienGiaiLoiKeHoach — uỷ quyền đứng (G5-B)', () => {
  it('mỗi mã grant_*/standing_* có câu tiếng Việt riêng, không phải mã trần', () => {
    const ma = [
      'standing_grant_not_permitted',
      'standing_grants_disabled',
      'action_not_grantable',
      'grant_expires_invalid',
      'grant_expired',
      'grant_max_per_day_invalid',
      'grant_limit',
      'grant_action_required',
      'grant_constraints_invalid',
      'grant_already_revoked',
      'grant_not_found',
      'grant_reason_required',
    ];
    for (const m of ma) {
      const cau = dienGiaiLoiKeHoach(m);
      expect(cau, m).not.toBe(`Lỗi kế hoạch: ${m}`);
      expect(cau, m).not.toContain(m);
    }
  });

  it('`standing_grant_not_permitted` không bị `not_permitted` chung nuốt mất — mã dài đứng trước', () => {
    expect(dienGiaiLoiKeHoach('standing_grant_not_permitted')).not.toBe(
      dienGiaiLoiKeHoach('not_permitted'),
    );
    expect(dienGiaiLoiKeHoach('standing_grant_not_permitted')).toContain('uỷ quyền đứng');
  });

  it('`grant_reason_required` không bị `reason_required` chung nuốt mất — mã dài đứng trước', () => {
    expect(dienGiaiLoiKeHoach('grant_reason_required')).not.toBe(
      dienGiaiLoiKeHoach('reason_required'),
    );
  });

  it('`grant_expired` và `grant_expires_invalid` là HAI mã khác nhau, không lẫn vào nhau', () => {
    expect(dienGiaiLoiKeHoach('grant_expired')).not.toBe(dienGiaiLoiKeHoach('grant_expires_invalid'));
  });
});
