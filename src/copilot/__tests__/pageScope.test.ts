// Một nguồn phạm vi (G1-A): điều hướng / allowlist UI-control / chỉ dẫn trang
// đều phải SINH TỪ `COPILOT_PAGE_CONTRACTS`, không được viết tay lại.
import { describe, expect, it } from 'vitest';
import {
  CHI_DAN_NGOAI_PHAM_VI,
  PILOT_UI_CONTROL_ROUTES,
  ROUTE_DIEU_HUONG,
  chiDanTrang,
  taoRouteDieuHuong,
} from '../pageScope';
import { COPILOT_PAGE_CONTRACTS } from '@/app/capabilities/registry';
import type { CopilotPageContract } from '@/app/capabilities/types';
import { ALL_PAGE_FEATURES, VISIBLE_PAGE_GROUPS } from '@/lib/permissionPages';

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
    const coControl = COPILOT_PAGE_CONTRACTS.filter((page) => page.safeControlIds.length > 0);
    // Khoá rollout mà `uiControlGuard` tra khi page-agent đứng ở ba trang này.
    expect(coControl.map((page) => page.key)).toEqual(['rooms.list', 'invoices.list', 'customers.list']);
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

describe('taoRouteDieuHuong — luật fail closed (kiểm bằng fixture, không bằng dữ liệu hôm nay)', () => {
  const hopDong = (over: Partial<CopilotPageContract> & { key: string; route: string }): CopilotPageContract => ({
    mode: 'read',
    permission: { module: 'rooms', action: 'view' },
    dataClass: 'internal',
    batch: 'property',
    rolloutKey: over.key,
    safeControlIds: [],
    ...over,
  });

  it('contract KHÔNG có trong VISIBLE_PAGE_GROUPS thì KHÔNG vào danh sách điều hướng', () => {
    // Đây là ca đắt: `VISIBLE_PAGE_GROUPS` chính là bản đã lọc trang của sản
    // phẩm CHƯA SHIP. Rơi về `?? page.key` (bản đầu) thì mo_trang vẫn mở trang
    // đó — chỉ khác là nhãn xấu. Lọc nhãn không phải lọc thành viên.
    const nhan = new Map([['/apartments', 'Căn hộ / Phòng']]);
    const ra = taoRouteDieuHuong(
      [hopDong({ key: 'rooms.list', route: '/apartments' }), hopDong({ key: 'chua.ship', route: '/chua-ship' })],
      nhan,
    );
    expect(ra.map((m) => m.route)).toEqual(['/apartments']);
    expect(ra.map((m) => m.key)).not.toContain('chua.ship');
  });

  it('bỏ route động, gộp theo canonicalRoute, và trang DANH SÁCH thắng trang chi tiết', () => {
    const nhan = new Map([['/contracts', 'Hợp đồng']]);
    const ra = taoRouteDieuHuong(
      [
        // Cố ý khai trang chi tiết TRƯỚC: kết quả không được phụ thuộc thứ tự.
        hopDong({ key: 'contracts.detail', route: '/contracts/:id', canonicalRoute: '/contracts' }),
        hopDong({ key: 'contracts.list', route: '/contracts' }),
      ],
      nhan,
    );
    expect(ra).toHaveLength(1);
    expect(ra[0]!.key).toBe('contracts.list');
    expect(ra[0]!.route).toBe('/contracts');
  });

  it('chỉ có trang chi tiết thì vẫn gộp về canonical (không mất đích)', () => {
    const ra = taoRouteDieuHuong(
      [hopDong({ key: 'x.detail', route: '/x/:id', canonicalRoute: '/x' })],
      new Map([['/x', 'X']]),
    );
    expect(ra.map((m) => m.route)).toEqual(['/x']);
  });

  it('lấy module/action từ chính contract, không chết cứng `view`', () => {
    const ra = taoRouteDieuHuong(
      [hopDong({ key: 'y.list', route: '/y', permission: { module: 'reports_finance', action: 'analysis' } })],
      new Map([['/y', 'Y']]),
    );
    expect(ra[0]!.module).toBe('reports_finance');
    expect(ra[0]!.action).toBe('analysis');
  });

  it('mọi route điều hướng THẬT đều có mặt trong VISIBLE_PAGE_GROUPS', () => {
    const hienThi = new Set(VISIBLE_PAGE_GROUPS.flatMap((n) => n.pages.map((p) => p.route)));
    for (const muc of ROUTE_DIEU_HUONG) expect(hienThi.has(muc.route)).toBe(true);
  });
});
