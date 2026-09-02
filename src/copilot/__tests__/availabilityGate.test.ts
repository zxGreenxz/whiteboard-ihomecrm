// Cửa "có được gửi lượt này không" theo độ tươi của snapshot quyền công cụ.
//
// Bệnh đã đo: `useCopilotAvailability` giữ staleTime 60s và KHÔNG có
// refetchInterval, trong khi `buildRegistry` trả về danh sách tool RỖNG khi
// snapshot null hoặc quá 60s. Hệ quả: mở panel, ngồi đọc một phút rồi hỏi —
// Copilot lặng lẽ trả lời như thể không có công cụ nào, không báo gì.
//
// Tách quyết định ra hàm thuần vì đây là phần đáng test nhất mà lại nằm trong
// một component không có môi trường DOM để render trong repo này.
import { describe, expect, it } from 'vitest';
import type { CopilotAvailabilitySnapshot } from '../featureFlags';
import {
  THONG_BAO_QUYEN_CHUA_TUOI,
  TUOI_TOI_DA_DE_GUI_MS,
  quyetDinhGuiTheoAvailability,
  quyetDinhGuiTheoNguCanh,
} from '../availabilityGate';
import { THONG_BAO_CHUA_CHON_TO_CHUC } from '../chatErrors';

const BAY_GIO = 1_800_000_000_000;
const ORG = '00000000-0000-4000-8000-00000000000a';

const snapshot = (fetchedAt: number): CopilotAvailabilitySnapshot => ({
  revision: 7,
  fetchedAt,
  organizationId: ORG,
  states: { 'page:rooms.list': 'enabled' },
});

describe('quyetDinhGuiTheoAvailability', () => {
  it('chưa có snapshot: không gửi, xin refetch, có thông báo tiếng Việt', () => {
    expect(quyetDinhGuiTheoAvailability(null, BAY_GIO)).toEqual({
      guiDuoc: false,
      canRefetch: true,
      thongBao: THONG_BAO_QUYEN_CHUA_TUOI,
    });
  });

  it(`snapshot cũ hơn ${TUOI_TOI_DA_DE_GUI_MS}ms: không gửi, xin refetch`, () => {
    const cu = snapshot(BAY_GIO - TUOI_TOI_DA_DE_GUI_MS - 1);
    expect(quyetDinhGuiTheoAvailability(cu, BAY_GIO)).toEqual({
      guiDuoc: false,
      canRefetch: true,
      thongBao: THONG_BAO_QUYEN_CHUA_TUOI,
    });
  });

  it('snapshot còn tươi: gửi thẳng, không cần refetch, không thông báo', () => {
    const tuoi = snapshot(BAY_GIO - TUOI_TOI_DA_DE_GUI_MS + 1);
    expect(quyetDinhGuiTheoAvailability(tuoi, BAY_GIO)).toEqual({
      guiDuoc: true,
      canRefetch: false,
    });
  });

  it('refetch xong vẫn null: vẫn KHÔNG gửi — đây là nhánh chặn thật', () => {
    const truoc = quyetDinhGuiTheoAvailability(null, BAY_GIO);
    expect(truoc.canRefetch).toBe(true);
    // Người gọi đã `await refetch()` và query vẫn trả null (mất mạng, RPC lỗi).
    const sau = quyetDinhGuiTheoAvailability(null, BAY_GIO + 1_200);
    expect(sau.guiDuoc).toBe(false);
    expect(sau.thongBao).toBe(THONG_BAO_QUYEN_CHUA_TUOI);
  });

  it('ngưỡng gửi chặt hơn ngưỡng 60s của snapshot để không hết hạn giữa lượt', () => {
    expect(TUOI_TOI_DA_DE_GUI_MS).toBeLessThan(60_000);
  });

  it('snapshot có mốc thời gian ở tương lai (đồng hồ lệch) cũng bị coi là chưa tươi', () => {
    expect(quyetDinhGuiTheoAvailability(snapshot(BAY_GIO + 5_000), BAY_GIO).guiDuoc).toBe(false);
  });
});

// Chưa chọn tổ chức là một chuyện HOÀN TOÀN KHÁC với snapshot cũ, dù cả hai đều
// dẫn tới `availability` rỗng. Query bị `enabled: false` nên `refetch()` chạy
// queryFn rồi trả `null` ngay — làm mới bao nhiêu lần cũng vậy. Bảo người dùng
// "thử lại sau vài giây" ở đây là hẹn một thứ không bao giờ đến, trong khi việc
// phải làm chỉ là chọn tổ chức.
describe('quyetDinhGuiTheoNguCanh', () => {
  it('chưa chọn tổ chức: báo đúng việc phải làm, KHÔNG hẹn chờ làm mới', () => {
    expect(quyetDinhGuiTheoNguCanh({ organizationId: null, snapshot: null, now: BAY_GIO })).toEqual({
      guiDuoc: false,
      canRefetch: false,
      thongBao: THONG_BAO_CHUA_CHON_TO_CHUC,
    });
  });

  it('chưa chọn tổ chức thì KHÔNG xin refetch, kể cả khi còn snapshot cũ trong tay', () => {
    const cu = snapshot(BAY_GIO - TUOI_TOI_DA_DE_GUI_MS - 1);
    const qd = quyetDinhGuiTheoNguCanh({ organizationId: null, snapshot: cu, now: BAY_GIO });
    expect(qd.canRefetch).toBe(false);
    expect(qd.thongBao).toBe(THONG_BAO_CHUA_CHON_TO_CHUC);
  });

  it('đã chọn tổ chức mà snapshot cũ: vẫn là chuyện làm mới, câu cũ giữ nguyên', () => {
    const cu = snapshot(BAY_GIO - TUOI_TOI_DA_DE_GUI_MS - 1);
    expect(quyetDinhGuiTheoNguCanh({ organizationId: ORG, snapshot: cu, now: BAY_GIO })).toEqual({
      guiDuoc: false,
      canRefetch: true,
      thongBao: THONG_BAO_QUYEN_CHUA_TUOI,
    });
  });

  it('đã chọn tổ chức + snapshot tươi: gửi được', () => {
    const tuoi = snapshot(BAY_GIO);
    expect(quyetDinhGuiTheoNguCanh({ organizationId: ORG, snapshot: tuoi, now: BAY_GIO })).toEqual({
      guiDuoc: true,
      canRefetch: false,
    });
  });

  it('hai lý do chặn KHÔNG được dùng chung một câu', () => {
    expect(THONG_BAO_CHUA_CHON_TO_CHUC).not.toBe(THONG_BAO_QUYEN_CHUA_TUOI);
  });
});
