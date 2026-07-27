// Kiểm tra nhà — bằng chứng VỊ TRÍ không được để phát hiện muộn.
//
// Ca thật 27/07/2026 (toà 158PVC): 7/7 ảnh có geofence_status='gps_denied' vì
// nhân viên đứng trong nhà, GPS chính xác cao timeout 15s mà mỗi lần mở camera
// lại bắt lại từ đầu. Mọi mục checklist ✓ nhưng bấm Hoàn tất thì báo "Cần ≥1 ảnh
// trong bán kính toà" — và KHÔNG còn mục nào để bấm chụp nữa (ngõ cụt).
//
// Spec này chạy trên dev server local (FLEET_BASE_URL=http://localhost:8080) vì
// bản vá chưa lên prod. RPC ghi đều bị mock → KHÔNG đụng dữ liệu org nào.
import { expect, test, type Page, type Route } from '@playwright/test';
import { credentials, trackConsoleErrors } from './auth';

const APP_URL = (process.env.FLEET_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const RPC = (name: string) => `**/rest/v1/rpc/${name}*`;

// Camera giả của Chromium + tự chấp nhận prompt quyền camera.
test.use({
  viewport: { width: 390, height: 844 },
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    slowMo: process.env.FLEET_HEADED ? 350 : 0,
  },
});

const BUILDING_ID = '10000000-0000-4000-8000-000000000001';
const BUILDING = { name: '158PVC-TEST', lat: 10.845786, lng: 106.649803 };

const summary = {
  today: { date: '2026-07-27', status: 'none', tick_source: null },
  attend: { n_chuan: 27, day_rate: 222_222, ticked_days: 12, tam_tinh: 2_666_664, budget: 6_000_000 },
  streak: { current: 3, best: 8, breaks_no_leave: 0, shields_free_left: 2, shields_reserve_left: 1, banked: [], next: null },
  pending_checks: [],
  leave: { quota: 1, used: 0, left: 1 },
  stage: 'shadow_coverage',
};

const missions = [
  {
    building_id: BUILDING_ID,
    building_name: BUILDING.name,
    cluster_id: null,
    latitude: BUILDING.lat,
    longitude: BUILDING.lng,
    street_address: '158 Phan Văn Trị',
    ward: 'Phường 1',
    district: 'Gò Vấp',
    province: 'TP. Hồ Chí Minh',
    public_map_url: null,
    last_touch_date: '2026-07-20',
    last_full_date: '2026-07-18',
    days_since_touch: 7,
    days_since_full: 9,
    vacant_rooms: 2,
    rooms_total: 12,
    expiring_contracts: 0,
    open_jobs: 0,
    score: 10,
    priority_bucket: 0,
    priority_label: 'full_overdue',
    touch_sla_days: 4,
    full_interval_days: 7,
    checked_today: false,
    last_full_by_name: 'Demo Quản lý',
    color: 'red',
    reason: '9 ngày chưa FULL · 7 ngày chưa ghé',
  },
];

const session = {
  session_id: '20000000-0000-4000-8000-000000000001',
  type: 'FULL',
  status: 'open',
  session_date: '2026-07-27',
  checklist: [
    { key: 'tu_dien', label: 'Tủ điện tổng / CB', required: true, done: false },
    { key: 'pccc', label: 'PCCC — bình + lối thoát', required: true, done: false },
  ],
  reqs: { rooms: 12, size_idx: 1, photos_min: 5, dwell_min_seconds: 720 },
  photos_count: 0,
  dwell_seconds: 0,
  started_at: new Date().toISOString(),
  slot_counts: {},
};

async function fulfillJson(route: Route, value: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(value) });
}

async function loginAt(page: Page) {
  const user = credentials('quanly');
  await page.goto(`${APP_URL}/login`);
  await page.getByRole('textbox', { name: 'Tài Khoản' }).fill(process.env.FLEET_EMAIL_QUANLY || user.email);
  await page.getByRole('textbox', { name: 'Mật khẩu' }).fill(user.pass);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 });
}

/** Mock toàn bộ đường ghi của phiên kiểm tra; `geo` = kết quả server chấm ảnh. */
async function mockInspection(page: Page, geo: 'ok' | 'gps_denied' | 'out_of_range') {
  await page.route(RPC('get_my_day_summary'), (r) => fulfillJson(r, summary));
  await page.route(RPC('v5_route_candidates_self'), (r) => fulfillJson(r, missions));
  await page.route(RPC('start_inspection'), (r) => fulfillJson(r, session));
  await page.route(RPC('submit_inspection_photo'), (r) =>
    fulfillJson(r, { accepted: true, geofence_status: geo, distance_m: geo === 'out_of_range' ? 480 : null }),
  );
  await page.route('**/rest/v1/inspection_photos*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: '[]' }),
  );
  await page.route('**/storage/v1/object/job-attachments/**', (r) =>
    fulfillJson(r, { Key: 'job-attachments/mock.jpg', path: 'mock.jpg' }),
  );
}

/** Mở phiên Kiểm tra nhà từ màn "Ngày hôm nay của tôi". */
async function openRunner(page: Page) {
  await page.goto(`${APP_URL}/my-day`);
  await expect(page.getByRole('heading', { name: 'Ngày hôm nay của tôi' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`Kiểm tra ${BUILDING.name}`) }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`Kiểm tra nhà · ${BUILDING.name}`) })).toBeVisible();
}

test('không bắt được vị trí: cảnh báo NGAY ở camera và ở phiên, có nút đi tiếp', async ({ page, context }) => {
  const consoleErrors = trackConsoleErrors(page);
  await loginAt(page);
  await mockInspection(page, 'gps_denied');
  // KHÔNG grant geolocation → trình duyệt từ chối như khi đứng trong hầm/tủ điện
  await context.clearPermissions();

  await openRunner(page);
  await page.getByRole('button', { name: /Tủ điện tổng/ }).click();

  // 1) Camera phải nói thẳng là ảnh này không tính, ngay trước khi bấm chụp
  const warn = page.getByText('Chưa bắt được vị trí');
  await expect(warn).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Thử lấy vị trí lại' })).toBeVisible();

  // 2) Bấm chụp lần đầu = cảnh báo, không chụp vội; lần hai mới chụp (không CHẶN)
  const shutter = page.getByRole('button', { name: 'Chụp ảnh' });
  await shutter.click();
  await expect(page.getByText('Bấm lần nữa để chụp dù chưa có vị trí')).toBeVisible();
  await shutter.click();
  await page.getByRole('button', { name: 'Dùng ảnh này' }).click();

  // 3) Về phiên: cảnh báo thiếu bằng chứng vị trí + ĐƯỜNG ĐI TIẾP (đây là chỗ
  //    trước đây bí: mục đã ✓ hết mà banner chỉ nói "cần ảnh trong bán kính")
  await expect(page.getByText('Còn thiếu 1 ảnh có vị trí tại toà')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Chụp ảnh có vị trí' })).toBeVisible();
  await expect(page.getByRole('button', { name: /GPS trục trặc/ })).toBeVisible();

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('có vị trí trong bán kính: phiên hiện "1 ảnh có vị trí ✓", không cảnh báo', async ({ page, context }) => {
  const consoleErrors = trackConsoleErrors(page);
  await loginAt(page);
  await mockInspection(page, 'ok');
  await context.grantPermissions(['geolocation'], { origin: new URL(APP_URL).origin });
  await context.setGeolocation({ latitude: BUILDING.lat, longitude: BUILDING.lng });

  await openRunner(page);
  await page.getByRole('button', { name: /Tủ điện tổng/ }).click();

  await expect(page.getByText(/Trong phạm vi/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Chưa bắt được vị trí')).toHaveCount(0);
  await page.getByRole('button', { name: 'Chụp ảnh' }).click(); // 1 lần bấm là chụp
  await page.getByRole('button', { name: 'Dùng ảnh này' }).click();

  await expect(page.getByText('1 ảnh có vị trí ✓')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Còn thiếu 1 ảnh có vị trí tại toà')).toHaveCount(0);

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
