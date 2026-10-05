import { test, expect } from '@playwright/test';

// Shipped app, unauthenticated read-only flow. Actual credential/role checks
// run separately. This cannot automate the iPhone Add to Home Screen sheet.
test.use({ storageState: { cookies: [], origins: [] } });

test('personal install identity survives login refresh, SPA transitions and a fresh launch', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const target = '/finance/personal-wallet?month=2026-10#transactions';
  await page.goto(target);
  await expect(page.getByRole('button', { name: 'Đăng nhập', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/login');
  expect(new URL(page.url()).searchParams.get('next')).toBe(target);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/personal-wallet.webmanifest');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Ví cá nhân');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Đăng nhập', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('next')).toBe(target);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/personal-wallet.webmanifest');

  const manifestResponse = await page.request.get('/personal-wallet.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.id).toBe('/finance/personal-wallet');
  expect(manifest.start_url).toBe('/finance/personal-wallet');
  // Real React Router Link exercises the AppRoutes commit signal.
  await page.getByRole('link', { name: 'Quên mật khẩu?' }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await page.goBack();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/personal-wallet.webmanifest');

  const fresh = await context.newPage();
  fresh.on('pageerror', error => errors.push(error.message));
  fresh.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await fresh.goto(manifest.start_url);
  await expect(fresh.getByRole('button', { name: 'Đăng nhập', exact: true })).toBeVisible();
  expect(new URL(fresh.url()).searchParams.get('next')).toBe('/finance/personal-wallet');
  await expect(fresh.locator('link[rel="manifest"]')).toHaveAttribute('href', '/personal-wallet.webmanifest');
  await fresh.close();
  expect(errors).toEqual([]);
});
