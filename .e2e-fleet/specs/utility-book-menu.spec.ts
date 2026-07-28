// =============================================================================
// Dropdown "Sổ quỹ ghi chi" trên bảng Đóng tiền theo kỳ.
//
// Bug user báo 28/07/2026:
//   1. Mở dropdown ra một mảng nền to đè lên bảng — wrapper portal mượn class
//      .tt-stage nên ăn luôn background/padding/flex của cả màn hình (đo được
//      715×260 trong khi popup chỉ 260 rộng).
//   2. Lướt xuống trong danh sách là menu đóng ngay — listener 'scroll' bắt ở
//      capture phase nên nuốt cả scroll của chính popup.
//   3. Thiếu ô lọc nhanh khi có nhiều sổ.
//
// Test 2–4 cần ≥6 sổ quỹ nên TỰ TẠO sổ tạm (org DEMO) rồi xoá ở finally.
//
// Chạy: cd .e2e-fleet && FLEET_BASE_URL=http://localhost:8080 \
//         npx playwright test specs/utility-book-menu.spec.ts
// =============================================================================

import { test, expect, Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

const SEED_PREFIX = 'ZFleet Sổ ';
const SEED_NAMES = ['AG708', 'AG810', 'ATâm', 'Chung', 'HKDHIEN', 'HKDHUY', 'HKDTâm', 'Đức'];

interface Api { base: string; apikey: string; token: string; uid: string; org: string }

/** Bắt apikey từ request supabase đầu tiên (khỏi hard-code key vào repo). */
function trackApiKey(page: Page): { value: string | null } {
  const box: { value: string | null } = { value: null };
  page.on('request', (r) => {
    if (box.value) return;
    const k = r.headers()['apikey'];
    if (k && /supabase\.co\//.test(r.url())) box.value = k;
  });
  return box;
}

async function apiOf(page: Page, keyBox: { value: string | null }): Promise<Api> {
  const sess = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('sb-') && x.endsWith('-auth-token'));
    if (!k) return null;
    const s = JSON.parse(localStorage.getItem(k)!);
    return { ref: k.slice(3, -('-auth-token'.length)), token: s.access_token as string, uid: s.user.id as string };
  });
  expect(sess, 'phiên supabase trong localStorage').not.toBeNull();
  expect(keyBox.value, 'apikey bắt từ request app').toBeTruthy();
  const base = `https://${sess!.ref}.supabase.co`;
  const H = { apikey: keyBox.value!, authorization: `Bearer ${sess!.token}`, 'accept-profile': 'public' };
  const res = await page.request.get(
    `${base}/rest/v1/accounts?select=organization_id&user_id=eq.${sess!.uid}&limit=1`, { headers: H },
  );
  const rows = await res.json();
  expect(rows[0]?.organization_id, 'org của sổ quỹ hiện có').toBeTruthy();
  return { base, apikey: keyBox.value!, token: sess!.token, uid: sess!.uid, org: rows[0].organization_id };
}

const headers = (a: Api) => ({
  apikey: a.apikey, authorization: `Bearer ${a.token}`,
  'accept-profile': 'public', 'content-profile': 'public',
  prefer: 'return=representation', 'content-type': 'application/json',
});

/**
 * Tạo sổ tạm để danh sách đủ dài (test lọc/cuộn). Tên gắn `stamp` riêng từng
 * lần chạy vì các test chạy SONG SONG trên cùng tài khoản — trùng tên là kết
 * quả lọc lẫn của nhau. Trả id để xoá sau.
 */
async function seedBooks(page: Page, a: Api): Promise<{ ids: string[]; stamp: string }> {
  const stamp = Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 900 + 100);
  const res = await page.request.post(`${a.base}/rest/v1/accounts`, {
    headers: headers(a),
    data: SEED_NAMES.map((n, i) => ({
      organization_id: a.org, user_id: a.uid, code: `ZFL${stamp}${i}`,
      name: `${SEED_PREFIX}${n}-${stamp}`, initial_amount: 0, initial_date: '2026-01-01',
    })),
  });
  expect(res.ok(), `tạo sổ tạm: ${res.status()} ${await res.text()}`).toBeTruthy();
  return { ids: (await res.json()).map((r: { id: string }) => r.id), stamp };
}

async function removeBooks(page: Page, a: Api, ids: string[]) {
  if (!ids.length) return;
  const res = await page.request.delete(
    `${a.base}/rest/v1/accounts?id=in.(${ids.join(',')})`, { headers: headers(a) },
  );
  expect(res.ok(), 'dọn sổ tạm').toBeTruthy();
}

async function openUtilityTable(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('flt:thu-tien:fee-cat', JSON.stringify('overview'));
  });
  await page.goto('/thu-tien');
  await page.locator('.tt-utility[title="Đóng tiền điện nước"]').click();
  await expect(page.locator('.ptt-panel')).toBeVisible();
  await page.locator('.ptt-panel .ptt-trigger').click();
  await page.locator('.ptt-panel .ptt-menu-item', { hasText: 'Điện & Nước' }).click();
}

function firstUnpaidRow(page: Page) {
  return page.locator('.ptt-panel .ud-table tbody tr').filter({ has: page.locator('.ud-attach') }).first();
}

async function openBookMenu(page: Page) {
  const row = firstUnpaidRow(page);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.locator('.ub-bookbtn').click();
  await expect(page.locator('.ub-bookpop')).toBeVisible();
}

test('so quy: popup khong ve mang nen de len bang', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'chunha');
  await openUtilityTable(page);
  await openBookMenu(page);

  const portal = page.locator('.ub-bookportal');
  const box = await portal.boundingBox();
  const pop = await page.locator('.ub-bookpop').boundingBox();
  expect(box, 'wrapper portal').not.toBeNull();

  // Wrapper phải ôm sát popup, không phình thành mảng nền (bản cũ: 715×260).
  expect(box!.width).toBeLessThanOrEqual(pop!.width + 2);
  expect(box!.height).toBeLessThanOrEqual(pop!.height + 2);

  const style = await portal.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, img: cs.backgroundImage, pad: cs.padding, pe: cs.pointerEvents };
  });
  expect(style.bg).toBe('rgba(0, 0, 0, 0)');
  expect(style.img).toBe('none');
  expect(style.pad).toBe('0px');
  expect(style.pe).toBe('none'); // phần rỗng quanh popup không nuốt click

  expect(errs, 'console errors').toEqual([]);
});

test('so quy: lươt trong danh sach khong lam dong menu', async ({ page }) => {
  const keyBox = trackApiKey(page);
  await login(page, 'chunha');
  const api = await apiOf(page, keyBox);
  const { ids } = await seedBooks(page, api);
  try {
    await openUtilityTable(page);
    await openBookMenu(page);

    const list = page.locator('.ub-booklist');
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight + 4), 'danh sách phải dài hơn khung').toBe(true);

    await list.hover();
    await page.mouse.wheel(0, 200);
    await expect(page.locator('.ub-bookpop')).toBeVisible();
    // Chromium áp scroll ở compositor nên đọc scrollTop ngay sau wheel là ăn
    // hên xui — poll thay vì đọc một phát (đỏ lai rai trên prod).
    await expect
      .poll(() => list.evaluate((el) => el.scrollTop), { message: 'đã cuộn được', timeout: 5_000 })
      .toBeGreaterThan(0);
  } finally {
    await removeBooks(page, api, ids);
  }
});

test('so quy: o loc nhanh — go khong dau van ra dung so, Enter chon luon', async ({ page }) => {
  const keyBox = trackApiKey(page);
  await login(page, 'chunha');
  const api = await apiOf(page, keyBox);
  const { ids, stamp } = await seedBooks(page, api);
  try {
    await openUtilityTable(page);
    await openBookMenu(page);

    const search = page.locator('.ub-booksearch-in');
    await expect(search, 'có ≥6 sổ thì phải hiện ô lọc').toBeVisible();

    const opts = page.locator('.ub-bookopt');
    const before = await opts.count();
    expect(before).toBeGreaterThan(3);

    // Gõ KHÔNG DẤU, chữ thường vẫn phải khớp "ZFleet Sổ HKDTâm-<stamp>".
    await search.fill(`hkdtam-${stamp}`);
    await expect(opts).toHaveCount(1);
    await expect(opts.first().locator('.ub-bookopt-nm')).toHaveText(`${SEED_PREFIX}HKDTâm-${stamp}`);

    // Enter = chọn kết quả đầu → menu đóng, chip đổi tên.
    await search.press('Enter');
    await expect(page.locator('.ub-bookpop')).toHaveCount(0);
    await expect(firstUnpaidRow(page).locator('.ub-bookbtn-nm')).toHaveText(`${SEED_PREFIX}HKDTâm-${stamp}`);
  } finally {
    await removeBooks(page, api, ids);
  }
});

test('so quy: loc khong khop thi bao ro, khong tra ve danh sach cu', async ({ page }) => {
  const keyBox = trackApiKey(page);
  await login(page, 'chunha');
  const api = await apiOf(page, keyBox);
  const { ids } = await seedBooks(page, api);
  try {
    await openUtilityTable(page);
    await openBookMenu(page);

    await page.locator('.ub-booksearch-in').fill('zzzkhongcosonao');
    await expect(page.locator('.ub-bookopt')).toHaveCount(0);
    await expect(page.locator('.ub-bookpop-empty')).toContainText('Không có sổ nào khớp');
  } finally {
    await removeBooks(page, api, ids);
  }
});
