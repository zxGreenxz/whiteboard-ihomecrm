import { test, expect, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Đường khói cho các bề mặt khai trong Capability Registry.
 *
 * VÌ SAO CẦN MỘT SPEC RIÊNG CHO VIỆC NÀY
 *   `check-capability-surfaces` đòi mỗi capability trỏ tới một spec E2E có thật.
 *   Không phải để chứng minh test xanh — mà để chặn việc một bề mặt ra đời với
 *   đủ route, quyền, nav, tài liệu mà KHÔNG AI từng mở nó một lần trên trình
 *   duyệt. Ba phép kiểm tĩnh kia đều kiểm từng mảnh: route tồn tại, guard đúng,
 *   quyền có trong picker — cả ba xanh vẫn có thể ra một trang trắng.
 *
 * PHÉP KIỂM Ở ĐÂY CỐ Ý NÔNG, và đó là chủ ý
 *   Mỗi route chỉ đòi: vào được (không rơi về /login, không 404 client-side),
 *   khung trang dựng xong, và KHÔNG có lỗi console app-level. Nghiệp vụ sâu đã có
 *   spec riêng (invoice-collection-v5, ie-create, cashbook-create-org-resolution,
 *   salary-mobile-period). Viết lại nghiệp vụ ở đây sẽ tạo hai bản khai cho cùng
 *   một hành vi — đúng thứ registry sinh ra để chống.
 *
 * TÀI KHOẢN: `chunha` (org DEMO). Đây là vai nhiều quyền nhất trong bộ DEMO, nên
 * một route hiện "Bạn không có quyền" ở đây là tín hiệu THẬT chứ không phải thiếu
 * quyền của tài khoản chạy test.
 *
 * KHÔNG GHI GÌ. Chỉ điều hướng và đọc — an toàn khi chạy trên production, đúng
 * ràng buộc "E2E chỉ ghi vào org DEMO".
 */

/** Route capability + một mốc chắc chắn có trên trang đó. */
const BE_MAT: ReadonlyArray<{ id: string; route: string; moc: string }> = [
  // Bốn bề mặt đã khai trong registry.
  { id: 'invoices', route: '/invoices', moc: 'Hoá đơn' },
  { id: 'cashbook', route: '/income-expense', moc: 'Thu chi' },
  { id: 'funds', route: '/finance/cashbooks', moc: 'Sổ quỹ' },
  { id: 'salary', route: '/finance/salary', moc: 'Bảng lương' },

  // Ứng viên capability đợt sau: đã có trang quyền + tài liệu hệ thống, thiếu
  // đúng đường khói này. Nhãn `moc` lấy từ chính Sidebar/launcher, không đặt lại.
  { id: 'buildings', route: '/buildings', moc: 'Toà nhà' },
  { id: 'rooms', route: '/apartments', moc: 'Căn hộ' },
  { id: 'services', route: '/services', moc: 'Dịch vụ' },
  { id: 'sale-phong', route: '/sale-phong', moc: 'Sale Phòng' },
  { id: 'assets', route: '/assets', moc: 'Tài sản' },
  { id: 'materials', route: '/materials', moc: 'Kho vật tư' },
  { id: 'leads', route: '/leads', moc: 'Khách hẹn' },
  { id: 'deposits', route: '/deposits', moc: 'Đặt cọc' },
  { id: 'contracts', route: '/contracts', moc: 'Hợp đồng' },
  { id: 'customers', route: '/customers', moc: 'Khách hàng' },
  { id: 'vehicles', route: '/vehicles', moc: 'Phương tiện' },
  { id: 'meters', route: '/meter-readings', moc: 'Ghi chỉ số' },
  { id: 'thu-tien', route: '/thu-tien', moc: 'Thu tiền' },
  { id: 'tasks', route: '/tasks', moc: 'Công việc' },
  { id: 'chat-zalo', route: '/chat-zalo', moc: 'Chat Zalo' },
  { id: 'building-map', route: '/building-map', moc: 'Sơ đồ toà nhà' },
  { id: 'notifications', route: '/notifications', moc: 'Thông báo' },
  { id: 'reports-real-estate', route: '/reports/real-estate', moc: 'Báo cáo' },
  { id: 'settings-general', route: '/settings/general', moc: 'Cài đặt' },
  { id: 'templates', route: '/settings/templates', moc: 'Mẫu biểu' },
  { id: 'overpayment', route: '/reports/finance/overpayment', moc: 'Tiền thừa' },
];

/**
 * Trang dựng xong chưa.
 *
 * KHÔNG dùng `networkidle`: app có realtime subscription nên mạng gần như không
 * bao giờ "idle", và chờ nó là chờ tới timeout ở MỌI route.
 */
async function choTrangDung(page: Page, moc: string) {
  await expect(page.getByText(moc, { exact: false }).first()).toBeVisible({ timeout: 45_000 });
}

for (const bm of BE_MAT) {
  test(`khói: ${bm.id} — ${bm.route} mở được và không lỗi console`, async ({ page }) => {
    const errs = trackConsoleErrors(page);
    await login(page, 'chunha');

    await page.goto(bm.route);

    // (1) KHÔNG bị đá về /login. Nếu phiên hỏng thì mọi khẳng định sau đều vô
    // nghĩa, nên kiểm điều này TRƯỚC và bằng thông báo riêng.
    await expect(page, `${bm.route} đá về /login — phiên đăng nhập hỏng`).not.toHaveURL(/\/login/);

    // (2) KHÔNG rơi vào màn "không có quyền". `chunha` là vai nhiều quyền nhất
    // của org DEMO, nên thấy màn này ở đây là lệch thật giữa registry và guard.
    await expect(
      page.getByText('Bạn không có quyền', { exact: false }),
      `${bm.route} chặn quyền với tài khoản chủ nhà — registry và guard đang lệch`,
    ).toHaveCount(0);

    // (3) Khung trang dựng xong.
    await choTrangDung(page, bm.moc);

    // (4) Không lỗi console app-level. Đây là chỗ bắt được trang "dựng xong mà
    // hỏng bên trong" — thứ mà mọi phép kiểm tĩnh đều không thấy.
    expect(errs, `${bm.route} có lỗi console: ${errs.join(' | ')}`).toEqual([]);
  });
}
