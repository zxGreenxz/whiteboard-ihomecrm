// Local build + real DEMO login/permissions/reference data. AI transport is controlled;
// recording uses Chromium's fake device. Never save vouchers or personal expenses.
import { expect, test } from '@playwright/test';
import { login } from './auth';

const DEMO = 'dddd0000-0000-4000-8000-000000000001';
test.use({ viewport: { width: 390, height: 844 }, launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

for (const role of ['chunha', 'quanly'] as const) {
  test(`DEMO ${role}: ghi âm tự gửi và ảnh kèm chữ tạo thẻ nháp`, async ({ page }) => {
    test.setTimeout(120_000);
    if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(process.env.FLEET_BASE_URL ?? '')) {
      throw new Error('Run against the local candidate build with FLEET_BASE_URL');
    }
    const errors: string[] = [];
    const aiCalls: string[] = [];
    const writes: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method());
      const moneyWrite = /\/rest\/v1\/(?:income_expenses|income_expense_items|personal_transactions|rpc\/(?:create|update|delete|cancel|approve|record|posting)[^/]*)(?:\?|$)/.test(url.pathname);
      const upload = /\/storage\/v1\/object\/(?!sign\/)/.test(url.pathname) || /\/(?:upload|presign|multipart)(?:\/|$)/.test(url.pathname);
      if (mutating && (moneyWrite || upload)) {
        writes.push(url.pathname);
        await route.abort('blockedbyclient');
        return;
      }
      await route.fallback();
    });
    await page.route('**/functions/v1/quick-entry/**', async route => {
      const request = route.request();
      expect(request.headers()['x-organization-id']).toBe(DEMO);
      expect(request.headers().authorization).toMatch(/^Bearer /);
      aiCalls.push(request.url());
      if (request.url().endsWith('/audio/transcriptions')) {
        await route.fulfill({ json: { text: 'sơn ba trăm nghìn' } });
      } else {
        await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ items: [{ desc: 'Sơn', amount_vnd: 300000, category: null, confidence: 0.9 }], total_vnd: 300000, date: null, vendor: null, building_mention: null, room_mention: null, customer_code: null, period_start: null, period_end: null }) } }] } });
      }
    });
    await login(page, role);
    await page.goto('/chi-tieu');
    await expect(page.getByRole('button', { name: 'Ảnh kèm nội dung', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Nói', exact: true }).click();
    await expect(page.getByText(/Đang nghe… 0:01/)).toBeVisible();
    await page.getByRole('button', { name: 'Xong', exact: true }).click();
    await expect(page.getByText('sơn ba trăm nghìn', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Nội dung khoản chi')).toHaveValue('');
    await page.getByLabel('Chọn ảnh kèm nội dung', { exact: true }).setInputFiles({ name: 'demo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6YV0AAAAASUVORK5CYII=', 'base64') });
    await page.getByLabel('Nội dung khoản chi').fill('DEMO sơn 300k');
    await expect(page.getByAltText('Ảnh chờ gửi')).toBeVisible();
    await page.getByRole('button', { name: 'Gửi', exact: true }).click();
    await expect(page.getByText('DEMO sơn 300k', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bỏ thẻ', exact: true })).toHaveCount(2);
    await expect(page.getByText('AI đang đọc…', { exact: false })).toHaveCount(0);
    expect(aiCalls.filter(url => url.endsWith('/audio/transcriptions'))).toHaveLength(1);
    expect(aiCalls.filter(url => url.endsWith('/chat/completions'))).toHaveLength(2);
    while (await page.getByRole('button', { name: 'Bỏ thẻ', exact: true }).count()) await page.getByRole('button', { name: 'Bỏ thẻ', exact: true }).first().click();
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
