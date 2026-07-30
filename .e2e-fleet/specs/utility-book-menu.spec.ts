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
 *
 * PHẢI đi qua RPC canonical `create_cashbook_v1`, KHÔNG POST thẳng
 * /rest/v1/accounts: `20260730102000_money_tables_revoke_dml.sql` đã REVOKE
 * INSERT/UPDATE/DELETE trên `public.accounts` khỏi `authenticated` (đường cũ cho
 * client tự sửa `initial_amount`/`lock_date`, tức đổi số dư sổ quỹ mà không sinh
 * phiếu hay posting nào). Ghi thẳng bảng nay trả 403 `42501 permission denied
 * for table accounts` — đúng thiết kế, không phải lỗi. Giao diện thật cũng đã
 * chuyển sang RPC này (`useAccounts.ts` → `useCreateAccount`).
 */
async function seedBooks(page: Page, a: Api): Promise<{ ids: string[]; stamp: string }> {
  const stamp = Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 900 + 100);
  const ids: string[] = [];
  // RPC tạo MỘT sổ mỗi lần gọi (khác POST cũ ghi cả mảng), nên tuần tự hoá.
  for (const [i, n] of SEED_NAMES.entries()) {
    const payload = {
      p_name: `${SEED_PREFIX}${n}-${stamp}`,
      p_initial_amount: 0,
      p_initial_date: '2026-01-01',
      p_bank_name: null,
      p_account_number: null,
      p_quick_default_building_id: null,
      // Khoá chống phát lại của chính RPC — phải khác nhau từng sổ, kẻo sổ thứ
      // hai bị coi là bấm lại của sổ thứ nhất và không được tạo. RPC đòi
      // 8–200 ký tự ASCII an toàn, nên dùng CHỈ SỐ chứ không dùng `n`
      // (SEED_NAMES có 'ATâm'/'Đức' — tiếng Việt, bị từ chối P0001).
      p_idempotency_key: `fleet-${stamp}-${i}`,
      p_description: null,
      p_is_default: false,
      p_owner_user_id: null,
    };
    // create_cashbook_v1 DEADLOCK (40P01) khi nhiều worker cùng tạo sổ trên một
    // tài khoản — đã gặp thật với FLEET_WORKERS=3. 40P01 là lỗi TẠM THỜI, cách
    // xử lý đúng là thử lại; khoá chống phát lại giữ nguyên nên lần thử lại
    // không thể sinh sổ thứ hai. (Bản thân việc RPC deadlock được là quan sát
    // đáng báo cáo, không phải lỗi của test.)
    let res = await page.request.post(`${a.base}/rest/v1/rpc/create_cashbook_v1`, {
      headers: headers(a), data: payload,
    });
    for (let retry = 0; retry < 4 && !res.ok(); retry++) {
      const txt = await res.text();
      if (!txt.includes('40P01')) break;
      await new Promise((r) => setTimeout(r, 150 * (retry + 1)));
      res = await page.request.post(`${a.base}/rest/v1/rpc/create_cashbook_v1`, {
        headers: headers(a), data: payload,
      });
    }
    expect(res.ok(), `tạo sổ tạm qua create_cashbook_v1: ${res.status()} ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    // RPC trả json; id có thể nằm ở gốc hoặc trong khoá con tuỳ phiên bản.
    const id = body?.id ?? body?.cashbook_id ?? body?.account_id ?? body?.data?.id;
    expect(id, `create_cashbook_v1 phải trả id (nhận: ${JSON.stringify(body)})`).toBeTruthy();
    ids.push(id);
  }
  return { ids, stamp };
}

/**
 * Dọn sổ tạm qua `archive_cashbook_v1` (RPC mà giao diện dùng), vì DELETE thẳng
 * bảng cũng đã bị REVOKE. RPC từ chối nếu sổ còn phiếu — các sổ này vừa tạo và
 * chưa hề dùng nên phải xoá được; nếu không, để test đỏ chứ đừng bỏ qua âm thầm.
 */
async function removeBooks(page: Page, a: Api, ids: string[]) {
  if (!ids.length) return;
  for (const id of ids) {
    const res = await page.request.post(`${a.base}/rest/v1/rpc/archive_cashbook_v1`, {
      headers: headers(a), data: { p_cashbook_id: id },
    });
    expect(res.ok(), `dọn sổ tạm ${id}: ${res.status()} ${await res.text()}`).toBeTruthy();
  }
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
