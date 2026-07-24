import { test, expect, Page, Route } from '@playwright/test';

/**
 * Watchdog khởi động PWA standalone (inline script index.html).
 *
 * Án lệ Android 07/2026: đổi mạng WiFi→LTE làm socket chết → fetch entry JS
 * treo LƠ LỬNG (không error, không xong), location.replace() cứu hộ cũng treo
 * theo → splash xoay vô hạn, user phải kill app. Spec này mô phỏng đúng kịch
 * bản đó bằng route Playwright "giữ request không trả lời", và kiểm tra chuỗi
 * thoát hiểm: nhắc mạng chậm (soft) → tự reload (hard) → reload nghẽn → màn
 * lỗi + nút "Tải lại ứng dụng" (nav) → mạng sống lại → bấm nút → vào app thật.
 *
 * Chạy trên bản build thật (vite build + vite preview):
 *   npx vite build && npx vite preview --port 4173
 *   cd .e2e-fleet && FLEET_BASE_URL=http://localhost:4173 npx playwright test specs/pwa-boot-watchdog.spec.ts
 * (Không cần FLEET_PASS_* — các test này không đăng nhập.)
 */

// Rút ngắn timings watchdog cho test (prod: soft 12s / hard 30s / nav 6s).
const WD = { soft: 1200, hard: 2600, nav: 1500 };

/** Giả lập display-mode: standalone + timings ngắn — chạy TRƯỚC mọi script của trang. */
async function armStandalone(page: Page) {
  await page.addInitScript((wd) => {
    const orig = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) =>
      query === '(display-mode: standalone)'
        ? ({
            matches: true,
            media: query,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent: () => false,
          } as unknown as MediaQueryList)
        : orig(query)) as typeof window.matchMedia;
    (window as unknown as { __ihomeWdT: typeof wd }).__ihomeWdT = wd;
  }, WD);
}

test('entry JS treo + reload nghẽn: soft → hard → màn lỗi, bấm tải lại vào được app', async ({ page }) => {
  await armStandalone(page);

  // "Socket chết": giữ request lơ lửng — không fulfill, không abort.
  let networkDead = true;
  let heldNav: Route | null = null;
  await page.route('**/assets/index-*.js', async (route) => {
    if (!networkDead) return route.continue();
    // treo lơ lửng
  });
  // Navigation reload cứu hộ (?_ihome_boot=...) cũng treo — đúng án lệ Android.
  await page.route(
    (url) => url.searchParams.has('_ihome_boot'),
    async (route) => {
      if (!networkDead || route.request().resourceType() !== 'document') {
        return route.continue();
      }
      heldNav = route; // giữ lơ lửng — bước 3 sẽ khai tử (ERR_ABORTED)
    },
  );

  // load/DOMContentLoaded không bao giờ bắn khi module script treo → chờ 'commit'.
  await page.goto('/', { waitUntil: 'commit' });
  const splash = page.locator('#app-splash');
  await expect(splash).toBeVisible();

  // LƯU Ý: từ lúc watchdog phát location.replace() (hard), navigation pending
  // khiến MỌI locator assertion/click của Playwright đứng chờ navigation xong
  // (không bao giờ, vì route bị giữ) → soi DOM bằng waitForFunction/evaluate
  // chạy thẳng trong page context.

  // 1) SOFT: nhắc mạng chậm — spinner VẪN quay (download không bị hủy).
  await page.waitForFunction(
    () => {
      const el = document.getElementById('app-splash');
      const msg = document.getElementById('app-splash-msg');
      const spin = document.querySelector('#app-splash .as-spin');
      return !!el && el.classList.contains('as-slow')
        && !!msg && (msg.textContent || '').includes('Mạng chậm')
        && !!spin && getComputedStyle(spin).display !== 'none';
    },
    undefined,
    { timeout: 5_000 },
  );

  // 2) HARD tự reload → navigation nghẽn → NAV: màn lỗi + nút, spinner ẩn.
  //    (Trước fix, nhánh này xoay vô hạn — phải kill app.)
  await page.waitForFunction(
    () => {
      const el = document.getElementById('app-splash');
      const msg = document.getElementById('app-splash-msg');
      const spin = document.querySelector('#app-splash .as-spin');
      const retry = document.getElementById('app-splash-reload');
      return !!el && el.classList.contains('as-failed')
        && !!msg && (msg.textContent || '').includes('Không thể kết nối')
        && !!spin && getComputedStyle(spin).display === 'none'
        && !!retry && getComputedStyle(retry).display !== 'none';
    },
    undefined,
    { timeout: 10_000 },
  );

  // 3) Socket treo cuối cùng bị khai tử (ERR_ABORTED — trang cũ VẪN hiển thị
  //    màn lỗi, hết navigation pending nên Playwright thao tác lại được);
  //    mạng đã sống lại → bấm "Tải lại ứng dụng" → app boot thật (về /login
  //    vì chưa đăng nhập), splash gỡ khỏi DOM, URL sạch _ihome_boot.
  networkDead = false;
  await heldNav!.abort('aborted');
  await page.click('#app-splash-reload');
  await page.waitForURL(/\/login/, { timeout: 40_000 });
  await expect(page.locator('#app-splash')).toHaveCount(0);
  expect(page.url()).not.toContain('_ihome_boot');
});

test('boot bình thường (standalone): splash tự ẩn, không kẹt cảnh báo', async ({ page }) => {
  await armStandalone(page);
  await page.goto('/', { waitUntil: 'commit' });
  // Chưa đăng nhập → ProtectedRoute đẩy về /login; splash phải tự gỡ.
  await page.waitForURL(/\/login/, { timeout: 40_000 });
  await expect(page.locator('#app-splash')).toHaveCount(0, { timeout: 15_000 });
});

test('tab trình duyệt thường (không standalone): splash không hiển thị', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('#app-splash')).toBeHidden();
});
