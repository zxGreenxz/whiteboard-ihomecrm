// `runUiControl` có một khối guard 5 điều kiện kết thúc bằng `return` TRẦN.
// Người dùng bấm gửi, câu hỏi của họ hiện lên trong khung chat, dòng "đang điều
// khiển trang" nhấp nháy rồi... hết. Không trả lời, không lỗi, không gì cả.
//
// Năm điều kiện đó có năm cách sửa khác nhau (chọn tổ chức, xin quyền, chờ làm
// mới, mở lại cuộc trò chuyện) nên phải nói RA cái nào đang chặn.
import { describe, expect, it } from 'vitest';
import { THONG_BAO_QUYEN_CHUA_TUOI } from '../availabilityGate';
import type { CopilotAvailabilitySnapshot } from '../featureFlags';
import { lyDoChanUiControl } from '../uiControlGate';

const BAY_GIO = 1_800_000_000_000;
const ORG = '00000000-0000-4000-8000-00000000000a';
const ORG_KHAC = '00000000-0000-4000-8000-00000000000b';

const snapshot = (organizationId: string, fetchedAt = BAY_GIO): CopilotAvailabilitySnapshot => ({
  revision: 3,
  fetchedAt,
  organizationId,
  states: { 'page:rooms.list': 'enabled' },
});

const ngucanh = (ghiDe: Partial<Parameters<typeof lyDoChanUiControl>[0]> = {}) => ({
  cungPhamVi: true,
  coQuyenDieuKhien: true,
  organizationId: ORG,
  snapshot: snapshot(ORG),
  now: BAY_GIO,
  ...ghiDe,
});

describe('lyDoChanUiControl', () => {
  it('đủ điều kiện: không chặn', () => {
    expect(lyDoChanUiControl(ngucanh())).toBeNull();
  });

  it('đổi tổ chức giữa chừng', () => {
    expect(lyDoChanUiControl(ngucanh({ cungPhamVi: false }))).toBe(
      'Tổ chức đã đổi giữa chừng, mở lại cuộc trò chuyện rồi thử lại.',
    );
  });

  it('không có quyền điều khiển trang', () => {
    expect(lyDoChanUiControl(ngucanh({ coQuyenDieuKhien: false }))).toBe(
      'Tài khoản chưa được cấp quyền điều khiển trang.',
    );
  });

  it('chưa chọn tổ chức', () => {
    expect(lyDoChanUiControl(ngucanh({ organizationId: null }))).toBe(
      'Hãy chọn tổ chức trước khi dùng chế độ điều khiển trang.',
    );
  });

  it('quyền công cụ chưa tươi (null hoặc quá hạn) dùng đúng câu của cửa gửi', () => {
    expect(lyDoChanUiControl(ngucanh({ snapshot: null }))).toBe(THONG_BAO_QUYEN_CHUA_TUOI);
    expect(lyDoChanUiControl(ngucanh({ snapshot: snapshot(ORG, BAY_GIO - 60_000) }))).toBe(
      THONG_BAO_QUYEN_CHUA_TUOI,
    );
  });

  it('snapshot tươi nhưng thuộc tổ chức khác', () => {
    expect(lyDoChanUiControl(ngucanh({ snapshot: snapshot(ORG_KHAC) }))).toBe(
      'Quyền công cụ đang thuộc tổ chức khác, chờ làm mới rồi thử lại.',
    );
  });

  it('nhiều thứ hỏng cùng lúc thì báo cái NGOÀI CÙNG trước — sửa được ngay', () => {
    // Đổi tổ chức giữa chừng thì mọi thứ phía sau đều lệch theo; nói về
    // snapshot lúc đó là chỉ vào triệu chứng chứ không phải nguyên nhân.
    expect(lyDoChanUiControl(ngucanh({ cungPhamVi: false, snapshot: null }))).toBe(
      'Tổ chức đã đổi giữa chừng, mở lại cuộc trò chuyện rồi thử lại.',
    );
  });

  it('mọi lý do đều là tiếng Việt có dấu và kết thúc bằng dấu chấm', () => {
    const cacLyDo = [
      lyDoChanUiControl(ngucanh({ cungPhamVi: false })),
      lyDoChanUiControl(ngucanh({ coQuyenDieuKhien: false })),
      lyDoChanUiControl(ngucanh({ organizationId: null })),
      lyDoChanUiControl(ngucanh({ snapshot: null })),
      lyDoChanUiControl(ngucanh({ snapshot: snapshot(ORG_KHAC) })),
    ];
    expect(cacLyDo.every((s) => typeof s === 'string' && s.endsWith('.'))).toBe(true);
    expect(cacLyDo.every((s) => /[ăâđêôơưàáảãạ]/i.test(s ?? ''))).toBe(true);
  });
});
