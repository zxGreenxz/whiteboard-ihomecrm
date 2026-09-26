import { test, expect, type Response } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
const REAL_ORG = 'aaaa0000-0000-4000-8000-000000000001';
const APP_ROUTE = '/voice-task-lab';
const API_ROUTE = '/api/voice-task-lab';

// Live app/API smoke. Chromium provides synthetic microphone hardware, while
// getUserMedia, MediaRecorder and audio playback remain the real browser APIs.
// No transcription/generation calls, CRM writes, screenshots or credential traces.
test.use({
  browserName: 'chromium',
  headless: true,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  trace: 'off',
  screenshot: 'off',
  video: 'off',
});

test.beforeEach(async ({ baseURL }) => {
  if (!process.env.FLEET_BASE_URL || !process.env.FLEET_PASS_CHUNHA) {
    throw new Error('Voice app E2E yêu cầu FLEET_BASE_URL và FLEET_PASS_CHUNHA được cấp rõ ràng; không dùng đích mặc định hoặc bỏ qua kiểm tra.');
  }
  const target = new URL(process.env.FLEET_BASE_URL);
  if (target.username || target.password || target.search || target.hash ||
      !(target.protocol === 'https:' || (target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname)))) {
    throw new Error('FLEET_BASE_URL phải là URL HTTPS hoặc localhost, không chứa credential/query.');
  }
  if (!baseURL || new URL(baseURL).origin !== target.origin) {
    throw new Error('Playwright baseURL phải khớp FLEET_BASE_URL được cấp cho lượt kiểm thử.');
  }
});

function isStatusResponse(response: Response): boolean {
  return new URL(response.url()).pathname === API_ROUTE &&
    response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'status';
}

test('API thật từ chối yêu cầu chưa đăng nhập', async ({ request }) => {
  const response = await request.post(API_ROUTE, { data: { action: 'status', organizationId: DEMO_ORG } });
  expect(response.status()).toBe(401);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
});

test('DEMO trên điện thoại ghi và nghe lại trong app; API chặn công ty khác', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = trackConsoleErrors(page);
  let pageErrors = 0;
  let generationRequests = 0;
  page.on('pageerror', () => { pageErrors += 1; });
  // If a regression starts recognition automatically, stop before sending audio
  // or creating a draft, and fail the explicit assertion below.
  await page.route('**/api/voice-task-lab', async route => {
    const body = route.request().postDataJSON() as { action?: string } | null;
    if (body?.action !== 'status') { generationRequests += 1; await route.abort(); return; }
    await route.continue();
  });

  await login(page, 'chunha');
  await page.evaluate(org => localStorage.setItem('ihomecrm.selectedOrganizationId', org), DEMO_ORG);
  const initialStatus = page.waitForResponse(isStatusResponse, { timeout: 45_000 });
  await page.goto(APP_ROUTE);
  const response = await initialStatus;
  expect(response.request().postDataJSON().organizationId).toBe(DEMO_ORG);
  expect(response.status()).toBe(200);
  expect((await response.json()).authenticated).toBe(true);
  await expect(page).toHaveURL(new RegExp(`${APP_ROUTE}/?$`));
  await expect(page.getByRole('heading', { name: 'Thử tạo việc bằng giọng nói', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Về trang chủ', exact: true })).toBeVisible();
  await expect(page.getByLabel('Mã truy cập', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Chỉ lưu trên thiết bị này · Tối đa 100 mẫu', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Probe a known existing other tenant, not an absent random organization.
  // This is status-only with the DEMO JWT; no production data is read or written.
  // Keep the verified DEMO JWT in memory; return only status/code from the page.
  // Never put the token into assertion messages, attachments or request traces.
  const authorization = await response.request().headerValue('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new Error('Yêu cầu API của app thiếu phiên đăng nhập.');
  const denied = await page.evaluate(async ({ authorization, organizationId, api }) => {
    try {
      const result = await fetch(api, {
        method: 'POST', headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'status', organizationId }),
      });
      const payload = await result.json() as { error?: { code?: string } };
      return { status: result.status, code: payload.error?.code ?? null };
    } catch { return { status: 0, code: 'NETWORK_FAILURE' }; }
  }, { authorization, organizationId: REAL_ORG, api: API_ROUTE });
  expect(denied).toEqual({ status: 403, code: 'FORBIDDEN' });

  await page.getByRole('button', { name: 'Bắt đầu ghi âm', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dừng ghi âm', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /00:0[1-9] \/ 01:00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Dừng ghi âm', exact: true }).click();
  const audio = page.getByLabel('Nghe lại bản ghi âm', { exact: true });
  await expect(audio).toBeVisible();
  await expect(audio).toHaveAttribute('src', /^blob:/);
  const startedPlayback = await audio.evaluate(async element => {
    const player = element as HTMLAudioElement;
    player.muted = true;
    await player.play();
    return !player.paused && player.error === null;
  });
  expect(startedPlayback).toBe(true);
  await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
  await audio.evaluate(element => (element as HTMLAudioElement).pause());

  const reloadedStatus = page.waitForResponse(isStatusResponse, { timeout: 45_000 });
  await page.reload();
  expect((await reloadedStatus).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Bắt đầu ghi âm', exact: true })).toBeVisible();
  await expect(page.getByLabel('Nghe lại bản ghi âm', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Mã truy cập', { exact: true })).toHaveCount(0);
  expect(generationRequests, 'Luồng ghi/nghe lại không được tự gửi âm thanh hoặc tạo bản nháp.').toBe(0);
  expect(pageErrors, 'Trang thử nghiệm không được phát sinh PageError.').toBe(0);
  expect(errors.length, 'Trang thử nghiệm không được phát sinh lỗi console ứng dụng.').toBe(0);
});
