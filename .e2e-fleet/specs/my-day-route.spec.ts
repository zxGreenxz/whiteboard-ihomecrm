import { expect, test, type Page, type Route } from '@playwright/test';
import { credentials, trackConsoleErrors } from './auth';

const APP_URL = (process.env.FLEET_BASE_URL || 'https://ptcrm.vercel.app').replace(/\/$/, '');
const RPC = (name: string) => `**/rest/v1/rpc/${name}*`;

test.use({ viewport: { width: 390, height: 844 } });

type UiPreferences = Record<string, unknown>;

const summary = {
  today: { date: '2026-07-21', status: 'none', tick_source: null },
  attend: { n_chuan: 27, day_rate: 222_222, ticked_days: 12, tam_tinh: 2_666_664, budget: 6_000_000 },
  streak: {
    current: 3,
    best: 8,
    breaks_no_leave: 0,
    shields_free_left: 2,
    shields_reserve_left: 1,
    banked: [{ milestone: 4, delta: 300_000 }],
    next: { milestone: 8, delta: 500_000, days_to_go: 5 },
  },
  pending_checks: [],
  leave: { quota: 1, used: 0, left: 1 },
  stage: 'shadow_coverage',
};

const mission = (
  index: number,
  building_name: string,
  priority_bucket: number,
  days_since_full: number,
  days_since_touch: number,
  latitude: number | null,
  longitude: number | null,
  overrides: Record<string, unknown> = {},
) => ({
  building_id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  building_name,
  cluster_id: null,
  latitude,
  longitude,
  street_address: `${index} Đường kiểm thử`,
  ward: 'Phường 1',
  district: 'Gò Vấp',
  province: 'TP. Hồ Chí Minh',
  public_map_url: null,
  last_touch_date: '2026-07-17',
  last_full_date: '2026-07-15',
  days_since_touch,
  days_since_full,
  vacant_rooms: 0,
  rooms_total: 10,
  expiring_contracts: 0,
  open_jobs: 0,
  score: 10,
  priority_bucket,
  priority_label: priority_bucket === 0 ? 'full_overdue' : priority_bucket === 1 ? 'visit_due' : 'due_soon',
  touch_sla_days: 4,
  full_interval_days: 7,
  checked_today: false,
  last_full_by_name: 'Demo Quản lý',
  color: priority_bucket <= 1 ? 'red' : priority_bucket === 2 ? 'yellow' : 'green',
  reason: `${days_since_full} ngày chưa FULL · ${days_since_touch} ngày chưa ghé`,
  ...overrides,
});

const missions = [
  mission(1, '1392QT', 0, 8, 5, 10.790, 106.680),
  mission(2, '512TC', 1, 5, 4, 10.780, 106.690),
  mission(3, '403PVB', 1, 6, 4, 10.770, 106.700),
  mission(4, '44TL', 1, 4, 4, 10.760, 106.710),
  mission(5, '65NTG', 2, 6, 3, 10.750, 106.720),
  mission(6, '45/3 Trần Thái Tông', 2, 3, 3, null, null),
  mission(7, '32PVC', 4, 0, 0, 10.740, 106.730, {
    checked_today: true,
    priority_label: 'checked_today',
    color: 'green',
    last_touch_date: '2026-07-21',
    last_full_date: '2026-07-21',
  }),
  mission(8, '111PVC', 3, 2, 1, 10.730, 106.740, {
    priority_label: 'fresh',
    color: 'green',
  }),
];

async function fulfillJson(route: Route, value: unknown) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(value),
  });
}

async function loginAt(page: Page) {
  const user = credentials('quanly');
  const email = process.env.FLEET_EMAIL_QUANLY || user.email;
  await page.goto(`${APP_URL}/login`);
  await page.getByRole('textbox', { name: 'Tài Khoản' }).fill(email);
  await page.getByRole('textbox', { name: 'Mật khẩu' }).fill(user.pass);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 });
}

test('My Day shows every due building and persists a manually reordered route', async ({ page, context }) => {
  const consoleErrors = trackConsoleErrors(page);
  let preferences: UiPreferences = {};

  await loginAt(page);

  await page.route(RPC('get_my_day_summary'), (route) => fulfillJson(route, summary));
  await page.route(RPC('v5_route_candidates_self'), (route) => fulfillJson(route, missions));
  await page.route(RPC('set_my_ui_preference'), async (route) => {
    const body = route.request().postDataJSON() as { p_key: string; p_value: unknown };
    preferences = { ...preferences, [body.p_key]: body.p_value };
    await fulfillJson(route, preferences);
  });
  await page.route('**/rest/v1/profiles?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('select') === 'ui_preferences') {
      await fulfillJson(route, { ui_preferences: preferences });
      return;
    }
    await route.continue();
  });

  await context.grantPermissions(['geolocation'], { origin: new URL(APP_URL).origin });
  await context.setGeolocation({ latitude: 10.775, longitude: 106.700 });

  await page.goto(`${APP_URL}/my-day`);
  await expect(page.getByRole('heading', { name: 'Ngày hôm nay của tôi' })).toBeVisible();

  // Regression: no top-3 cap; every 4-day building stays visible together.
  await expect(page.getByText('512TC', { exact: true })).toBeVisible();
  await expect(page.getByText('403PVB', { exact: true })).toBeVisible();
  await expect(page.getByText('44TL', { exact: true })).toBeVisible();
  await expect(page.getByText('Đến nhịp kiểm tra FULL · 1')).toBeVisible();
  await expect(page.getByText('Nên ghé hôm nay · 3')).toBeVisible();
  await expect(page.getByText('Sắp đến nhịp · 2')).toBeVisible();
  await expect(page.getByText('Đã ghé hôm nay · 1')).toBeVisible();
  await expect(page.getByText('FULL 8 ngày · ghé 5 ngày')).toBeVisible();

  await page.getByRole('button', { name: 'Xếp tuyến' }).click();
  await expect(page.getByRole('heading', { name: 'Xếp tuyến hôm nay' })).toBeVisible();
  await expect(page.getByText('6 toà trong tuyến')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Chặng 1 · 4 toà' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Chặng 2 · 1 toà' })).toBeVisible();
  await expect(page.getByText('FULL 2/7 ngày · ghé 1/4 ngày')).toBeVisible();
  await expect(page.getByText('Giữ lại để đối chiếu · không đưa lại vào tuyến hôm nay')).toBeVisible();

  const firstChunkUrl = await page.getByRole('link', { name: 'Chặng 1 · 4 toà' }).getAttribute('href');
  expect(firstChunkUrl).toBeTruthy();
  expect(new URL(firstChunkUrl!).searchParams.get('waypoints')?.split('|')).toHaveLength(3);

  // Pointer DnD proves manual order can cross priority buckets.
  const drag512 = page.getByRole('button', { name: /Kéo để đổi vị trí 512TC/ });
  const drag1392 = page.getByRole('button', { name: /Kéo để đổi vị trí 1392QT/ });
  await drag512.scrollIntoViewIfNeeded();
  const source = await drag512.boundingBox();
  const target = await drag1392.boundingBox();
  expect(source).toBeTruthy();
  expect(target).toBeTruthy();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + 4, { steps: 15 });
  await page.mouse.up();

  const activeCards = page.locator('section[aria-labelledby="active-route-title"] article h3');
  await expect(activeCards.first()).toHaveText('512TC');
  await page.waitForTimeout(300);

  const saveRequest = page.waitForRequest(
    (request) => request.url().includes('/rest/v1/rpc/set_my_ui_preference'),
    { timeout: 5_000 },
  );
  const saveButton = page.getByRole('button', { name: 'Lưu tuyến hôm nay' });
  await expect(saveButton).toBeEnabled();
  await saveButton.click({ force: true });
  await saveRequest;
  await expect.poll(() => {
    const plan = preferences.v5_route_plan as { building_ids?: string[] } | undefined;
    return plan?.building_ids?.[0];
  }).toBe(missions[1].building_id);

  await page.reload();
  await expect(page.getByRole('button', { name: /Kiểm tra 512TC/ })).toBeVisible();
  await page.getByRole('button', { name: 'Xếp tuyến' }).click();
  await expect(activeCards.first()).toHaveText('512TC');

  await page.getByRole('button', { name: /Tối ưu từ vị trí này/ }).click();
  await expect(page.getByText('Đã tối ưu GPS')).toBeVisible();
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
