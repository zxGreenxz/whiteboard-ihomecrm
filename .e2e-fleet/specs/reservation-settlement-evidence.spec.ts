import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';
import { createReservationLiveFixture, cleanupReservationLiveFixture, inspectReservationLiveFixture } from './reservation-settlement-admin';

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

async function openSource(page: Page, marker: string, mobile: boolean) {
  await page.goto('/income-expense');
  if (process.env.FLEET_EXPECT_BUILD_SHA) await expect(page.locator('meta[name="build-sha"]')).toHaveAttribute('content', process.env.FLEET_EXPECT_BUILD_SHA);
  await page.getByPlaceholder(mobile ? 'Theo mã phòng, mã phiếu, tên, số tiền…' : 'Tìm mã phòng, tên/mã phiếu hoặc số tiền (±5.000đ)...').fill(marker);
  if (mobile) await page.getByText(marker, { exact: false }).first().click();
  else await page.getByRole('row').filter({ hasText: marker }).getByTitle('Xem chi tiết', { exact: true }).click();
}

for (const mobile of [false, true]) test(`DEMO: refund proof and direct receipt details (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  const marker = `[E2E-RESERVATION:${randomUUID()}]`, roomId = randomUUID();
  const consoleErrors = trackConsoleErrors(page);
  const fileName = `e2e-reservation-proof-${roomId}.png`;
  let uploadUrl = '', authorization = '', apiKey = '';
  let releaseUpload = () => {};
  const paused = new Promise<void>((resolve) => { releaseUpload = resolve; });
  let uploadStarted = false;
  await page.route('**/storage/v1/object/income-expense-attachments/**', async (route) => {
    if (route.request().method() !== 'POST' || !route.request().url().includes(`e2e-reservation-proof-${roomId}`)) return route.continue();
    uploadUrl = route.request().url();
    const headers = await route.request().allHeaders();
    authorization = headers.authorization; apiKey = headers.apikey;
    uploadStarted = true;
    await paused;
    await route.continue();
  });
  try {
    const fixture = await createReservationLiveFixture(marker, roomId);
    await login(page, 'chunha');
    await openSource(page, marker, mobile);
    await page.getByRole('button', { name: 'Xử lý bỏ cọc', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Xử lý bỏ cọc', exact: true });
    await dialog.getByLabel('Hoàn lại khách', { exact: true }).fill(mobile ? '3000000' : '1000000');
    await dialog.getByLabel('Sổ quỹ đã chi', { exact: true }).selectOption(fixture.account_id);
    await dialog.getByRole('checkbox', { name: 'Xác nhận đã trả tiền cho khách', exact: true }).check();
    await dialog.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'image/png', buffer: png });
    await expect.poll(() => uploadStarted).toBe(true);
    await expect(dialog.getByLabel('Cách hoàn', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Hoàn lại khách', { exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Xác nhận xử lý', exact: true })).toBeDisabled();
    const uploaded = page.waitForResponse((r) => r.request().method() === 'POST' && r.url() === uploadUrl);
    releaseUpload();
    expect((await uploaded).ok()).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Xác nhận xử lý', exact: true })).toBeEnabled();
    const result = page.waitForResponse((r) => r.url().endsWith('/rpc/settle_reservation_deposit_v1'));
    await dialog.getByRole('button', { name: 'Xác nhận xử lý', exact: true }).click();
    const response = await result;
    expect(response.status()).toBe(200);
    const settled = await response.json();
    const sent = response.request().postDataJSON().p_input;
    expect(sent.refundAttachments).toHaveLength(1);
    await expect(dialog).not.toBeVisible();
    const details = page.getByRole('region', { name: 'Thông tin xử lý bỏ cọc' });
    await expect(details.getByText('Khách đã bỏ cọc', { exact: true })).toBeVisible();
    await expect(details).toContainText('Người xử lý:');
    await expect(details).not.toContainText('Chưa có tên');
    await expect(details.getByRole('button', { name: 'Xem chứng từ hoàn tiền 1' })).toBeVisible();
    await expect.poll(() => details.locator('img').first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    if (mobile) {
      const sheet = page.locator('.sheet').filter({ has: details });
      expect((await sheet.boundingBox())!.width).toBeGreaterThan(350);
    }
    await details.getByRole('button', { name: 'Xem chứng từ hoàn tiền 1' }).click();
    await expect(page.getByRole('button', { name: /Đóng/ }).last()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(details.getByText('Khách đã bỏ cọc', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`source-${mobile ? 'mobile' : 'desktop'}.png`) });
    await page.goto(`/income-expense/voucher/${settled.refundVoucherId}`);
    await expect(page.getByText('Thông tin thu/chi', { exact: true })).toBeVisible();
    const creator = page.locator('div.grid').filter({ has: page.getByText('Người tạo', { exact: true }) });
    await expect(creator).not.toContainText('—');
    await expect(page.getByRole('region', { name: 'Thông tin xử lý bỏ cọc' }).getByRole('button', { name: 'Xem chứng từ hoàn tiền 1' })).toBeVisible();
    await expect(page.locator('img').filter({ visible: true }).first()).toBeVisible();
    expect(await inspectReservationLiveFixture(marker, roomId)).toMatchObject({ settlements: 1, effective_paid: mobile ? 3000000 : 1000000, source_amount: 3000000, source_pnl: false });
    expect(consoleErrors).toEqual([]);
  } finally {
    releaseUpload();
    // Only this test's randomly named DEMO upload is eligible for deletion.
    try {
      if (uploadUrl && authorization && uploadUrl.includes(`e2e-reservation-proof-${roomId}`)) {
        const url = new URL(uploadUrl), prefix = url.pathname.split('/income-expense-attachments/')[1];
        const removed = await page.request.delete(`${url.origin}/storage/v1/object/income-expense-attachments`, { headers: { authorization, apikey: apiKey }, data: { prefixes: [decodeURIComponent(prefix)] } });
        expect(removed.ok()).toBe(true);
      }
    } finally {
      await cleanupReservationLiveFixture(marker, roomId);
    }
  }
});
