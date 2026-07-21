import { expect, test, type Page } from '@playwright/test';

const APP_URL = process.env.FLEET_BASE_URL;

if (!APP_URL) {
  throw new Error('Thiếu FLEET_BASE_URL; hãy trỏ spec PWA vào preview local hoặc production cần xác minh.');
}

async function emulateStandaloneAndroid(page: Page) {
  await page.addInitScript(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    const standaloneResult = (query: string): MediaQueryList => ({
      matches: true,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    });

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) =>
        query === '(display-mode: standalone)'
          ? standaloneResult(query)
          : nativeMatchMedia(query),
    });
  });
}

test('auth bootstrap ignores a stuck Android Web Lock', async ({ page }) => {
  await page.addInitScript(() => {
    let calls = 0;
    const stuckLocks = {
      request: () => {
        calls += 1;
        return new Promise(() => {});
      },
      query: async () => ({ held: [], pending: [] }),
    };

    Object.defineProperty(Navigator.prototype, 'locks', {
      configurable: true,
      get: () => stuckLocks,
    });
    Object.defineProperty(window, '__pwaLockCalls', {
      configurable: true,
      get: () => calls,
    });
  });

  await page.goto(`${APP_URL}/`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login(?:\?|$)/, { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Đăng nhập' })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __pwaLockCalls?: number }).__pwaLockCalls)).toBe(0);
});

test('standalone deep link removes the HTML splash after route commit', async ({ page }) => {
  await emulateStandaloneAndroid(page);

  await page.goto(`${APP_URL}/forgot-password`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Quên mật khẩu?')).toBeVisible();
  await expect(page.locator('#app-splash')).toHaveCount(0, { timeout: 2_500 });
});

test('standalone watchdog does not reload a slow but healthy entry bundle', async ({ page }) => {
  await emulateStandaloneAndroid(page);

  let delayedEntry = false;
  let documentRequests = 0;
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests += 1;
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (
      !delayedEntry &&
      request.resourceType() === 'script' &&
      /\/assets\/index-[^/]+\.js(?:\?|$)/.test(request.url())
    ) {
      delayedEntry = true;
      await new Promise((resolve) => setTimeout(resolve, 13_000));
    }
    await route.continue();
  });

  await page.goto(`${APP_URL}/forgot-password`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Quên mật khẩu?')).toBeVisible();
  expect(delayedEntry).toBe(true);
  expect(documentRequests).toBe(1);
  expect(new URL(page.url()).searchParams.has('_ihome_boot')).toBe(false);
});

test('standalone entry watchdog recovers from one failed entry bundle', async ({ page }) => {
  await emulateStandaloneAndroid(page);

  let abortedEntry = '';
  let documentRequests = 0;
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests += 1;
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (
      !abortedEntry &&
      request.resourceType() === 'script' &&
      /\/assets\/index-[^/]+\.js(?:\?|$)/.test(url)
    ) {
      abortedEntry = url;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await page.goto(`${APP_URL}/forgot-password`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Quên mật khẩu?')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#app-splash')).toHaveCount(0);
  expect(abortedEntry).not.toBe('');
  expect(documentRequests).toBeGreaterThanOrEqual(2);
});

test('standalone entry watchdog stops retrying and shows manual recovery', async ({ page }) => {
  await emulateStandaloneAndroid(page);

  let abortedEntries = 0;
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (
      request.resourceType() === 'script' &&
      /\/assets\/index-[^/]+\.js(?:\?|$)/.test(request.url())
    ) {
      abortedEntries += 1;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await page.goto(`${APP_URL}/forgot-password`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Tải lại ứng dụng' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('#app-splash')).toHaveClass(/as-failed/);
  expect(abortedEntries).toBeGreaterThanOrEqual(2);
});
