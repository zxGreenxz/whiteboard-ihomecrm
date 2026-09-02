// Một nguồn phạm vi (G1-A): điều hướng / allowlist UI-control / chỉ dẫn trang
// đều phải SINH TỪ `COPILOT_PAGE_CONTRACTS`, không được viết tay lại.
import { describe, expect, it } from 'vitest';
import {
  CHI_DAN_NGOAI_PHAM_VI,
  KHOA_TRANG_UI_CONTROL,
  PILOT_UI_CONTROL_ROUTES,
  ROUTE_DIEU_HUONG,
  chiDanTrang,
} from '../pageScope';
import { COPILOT_PAGE_CONTRACTS } from '@/app/capabilities/registry';
import { ALL_PAGE_FEATURES } from '@/lib/permissionPages';

describe('ROUTE_DIEU_HUONG — sinh từ page contract', () => {
  it('mở rộng hơn hẳn 3 trang pilot cũ (đo 02/09/2026: 19 route)', () => {
    // `>=` chứ không `===`: thêm một contract mới là chuyện thường, và một test
    // đỏ vì lý do đó chỉ dạy người ta sửa con số cho xanh. Sàn 15 bắt đúng thứ
    // đáng bắt: ai đó vô tình rút danh sách về lại vài trang.
    expect(ROUTE_DIEU_HUONG.length).toBeGreaterThanOrEqual(15);
  });

  it('KHÔNG route nào chứa `:` — mo_trang không biết điền id nào', () => {
    // Điều hướng tới `/contracts/:id` nguyên văn ra màn 404 kèm câu
    // "✅ Đã mở trang" — lời khẳng định thành công đè lên một màn hình rỗng.
    for (const muc of ROUTE_DIEU_HUONG) expect(muc.route).not.toContain(':');
  });

  it('mọi route đều thuộc contract, không có route thêm tay', () => {
    const cuaHopDong = new Set(
      COPILOT_PAGE_CONTRACTS.map((page) => page.canonicalRoute ?? page.route),
    );
    expect(cuaHopDong.size).toBeGreaterThanOrEqual(15); // sàn chống-xanh-rỗng
    for (const muc of ROUTE_DIEU_HUONG) expect(cuaHopDong.has(muc.route)).toBe(true);
  });

  it('khoá và route đều DUY NHẤT — trùng thì z.enum nuốt mất một đích', () => {
    expect(new Set(ROUTE_DIEU_HUONG.map((m) => m.key)).size).toBe(ROUTE_DIEU_HUONG.length);
    expect(new Set(ROUTE_DIEU_HUONG.map((m) => m.route)).size).toBe(ROUTE_DIEU_HUONG.length);
  });

  it('nhãn tiếng Việt lấy từ catalog quyền, không phải khoá contract', () => {
    const theoRoute = new Map(ROUTE_DIEU_HUONG.map((m) => [m.route, m]));
    expect(theoRoute.get('/apartments')?.label).toBe('Căn hộ / Phòng');
    expect(theoRoute.get('/invoices')?.label).toBe('Hoá đơn');
    expect(theoRoute.get('/customers')?.label).toBe('Cư dân');
    // Nhãn rơi về khoá contract là dấu hiệu route không có trong catalog quyền:
    // mô hình sẽ đọc "reports.finance" thay vì "Báo cáo tài chính".
    for (const muc of ROUTE_DIEU_HUONG) expect(muc.label).not.toBe(muc.key);
  });

  it('mọi cặp module.action CÓ THẬT trong catalog quyền', () => {
    // Gõ sai không gây lỗi biên dịch: `canUse` chỉ trả false, nên tool báo
    // "Không có quyền xem trang X" — câu SAI SỰ THẬT đẩy người dùng đi xin
    // quyền họ đã có.
    const coThat = new Set(ALL_PAGE_FEATURES.map((f) => `${f.module}.${f.action}`));
    expect(coThat.size).toBeGreaterThanOrEqual(100); // sàn chống-xanh-rỗng
    for (const muc of ROUTE_DIEU_HUONG) {
      expect(coThat.has(`${muc.module}.${muc.action}`), `${muc.key}: ${muc.module}.${muc.action}`).toBe(true);
    }
  });
});

describe('PILOT_UI_CONTROL_ROUTES — allowlist thao tác', () => {
  it('đúng 3 trang pilot, và đó là các trang có safeControlIds', () => {
    expect([...PILOT_UI_CONTROL_ROUTES]).toEqual(['/apartments', '/invoices', '/customers']);
    expect([...KHOA_TRANG_UI_CONTROL]).toEqual(['rooms.list', 'invoices.list', 'customers.list']);
    const coControl = COPILOT_PAGE_CONTRACTS.filter((page) => page.safeControlIds.length > 0);
    expect(coControl.map((page) => page.canonicalRoute ?? page.route)).toEqual([
      ...PILOT_UI_CONTROL_ROUTES,
    ]);
  });

  it('là TẬP CON của phạm vi điều hướng — không có trang đứng-được mà không tới-được', () => {
    const dieuHuong = new Set(ROUTE_DIEU_HUONG.map((m) => m.route));
    for (const route of PILOT_UI_CONTROL_ROUTES) expect(dieuHuong.has(route)).toBe(true);
  });
});

describe('chiDanTrang — chỉ dẫn theo pageKey', () => {
  it('giữ nguyên nội dung tay cũ của pageContext', () => {
    expect(chiDanTrang('/apartments')).toBe(
      'Đang ở trang Căn hộ/Phòng. Bạn có thể lọc theo trạng thái/toà nhà bằng các ô lọc trên trang, hoặc điều hướng. KHÔNG chỉnh sửa/xoá dữ liệu.',
    );
    expect(chiDanTrang('/invoices')).toContain('TUYỆT ĐỐI KHÔNG duyệt/huỷ/xoá hoá đơn');
    expect(chiDanTrang('/customers')).toContain('KHÔNG sửa/xoá hồ sơ khách hàng');
  });

  it('trang chi tiết vẫn nhận chỉ dẫn của trang danh sách', () => {
    // Bản cũ khớp bằng `pathname.startsWith('/apartments')`. Bản mới đi qua
    // contract, nên phải chứng minh `/apartments/<id>` KHÔNG rơi ra ngoài
    // phạm vi — đó là mọi lần agent mở một phòng cụ thể.
    expect(chiDanTrang('/apartments/abc-123')).toBe(chiDanTrang('/apartments'));
    expect(chiDanTrang('/invoices/print/abc-123')).toBe(chiDanTrang('/invoices'));
  });

  it('trang có contract nhưng KHÔNG thuộc pilot ⇒ ngoài phạm vi', () => {
    // Điều hướng mở rộng hơn thao tác: `/tasks` tới được, nhưng page-agent
    // không có control nào ở đó nên chỉ dẫn phải nói dừng.
    expect(chiDanTrang('/tasks')).toBe(CHI_DAN_NGOAI_PHAM_VI);
  });

  it('route lạ và route miễn trừ ⇒ ngoài phạm vi', () => {
    expect(chiDanTrang('/khong-ton-tai-o-dau-ca')).toBe(CHI_DAN_NGOAI_PHAM_VI);
    expect(chiDanTrang('/settings/roles')).toBe(CHI_DAN_NGOAI_PHAM_VI);
    expect(CHI_DAN_NGOAI_PHAM_VI).toContain('ngoài phạm vi');
  });
});
