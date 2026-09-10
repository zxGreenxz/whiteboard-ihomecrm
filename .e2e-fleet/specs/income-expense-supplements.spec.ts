import { randomUUID, createHash } from 'node:crypto';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';
import { createReservationLiveFixture, cleanupReservationLiveFixture, snapshotReservationFinancialRows,
  cleanupReservationSupplementFixture, cleanupReservationSupplementOrphanLinks } from './reservation-settlement-admin';

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function findVoucher(page: Page, text: string, mobile: boolean) {
  await page.goto('/income-expense');
  if (process.env.FLEET_EXPECT_BUILD_SHA) await expect(page.locator('meta[name="build-sha"]')).toHaveAttribute('content', process.env.FLEET_EXPECT_BUILD_SHA);
  await page.getByPlaceholder(mobile ? 'Theo mã phòng, mã phiếu, tên, số tiền…' : 'Tìm mã phòng, tên/mã phiếu hoặc số tiền (±5.000đ)...').fill(text);
  if (mobile) await page.getByText(text, { exact: false }).first().click();
  else {
    const results = page.getByTitle('Xem chi tiết', { exact: true });
    await expect(results).toHaveCount(1);
    await results.click();
  }
}

for (const mobile of [false, true]) test(`DEMO append-only voucher evidence (${mobile ? 'mobile' : 'desktop'})`, async ({ page, browser }, info) => {
  test.setTimeout(240_000);
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  const marker = `[E2E-RESERVATION:${randomUUID()}]`, room = randomUUID();
  const note = `Bổ sung DEMO ${room}\nKhách đã nhận hoàn trả.`;
  const uploads: { url: string; authorization: string; apikey: string }[] = [];
  const errors = trackConsoleErrors(page);
  let observerContext: BrowserContext | undefined;
  let observer: Page | undefined;
  page.on('request', async request => {
    if (request.method() === 'POST' && request.url().includes('/storage/v1/object/income-expense-attachments/') && request.url().includes(room)) {
      const headers = await request.allHeaders();
      uploads.push({ url: request.url(), authorization: headers.authorization, apikey: headers.apikey });
    }
  });
  try {
    const fixture = await createReservationLiveFixture(marker, room);
    await login(page, 'chunha');
    await findVoucher(page, marker, mobile);
    await expect(page.getByRole('button', { name: 'Bổ sung chứng từ / ghi chú', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Xử lý bỏ cọc', exact: true }).click();
    const settleDialog = page.getByRole('dialog', { name: 'Xử lý bỏ cọc', exact: true });
    await settleDialog.getByLabel('Hoàn lại khách', { exact: true }).fill('1000000');
    await settleDialog.getByLabel('Sổ quỹ đã chi', { exact: true }).selectOption(fixture.account_id);
    await settleDialog.getByRole('checkbox', { name: 'Xác nhận đã trả tiền cho khách', exact: true }).check();
    await settleDialog.locator('input[type="file"]').setInputFiles({ name: `e2e-reservation-proof-${room}.png`, mimeType: 'image/png', buffer: png });
    await expect(settleDialog.getByRole('button', { name: 'Xác nhận xử lý', exact: true })).toBeEnabled();
    const settledResponse = page.waitForResponse(r => r.url().endsWith('/rpc/settle_reservation_deposit_v1'));
    await settleDialog.getByRole('button', { name: 'Xác nhận xử lý', exact: true }).click();
    const settleResponse = await settledResponse; expect(settleResponse.status()).toBe(200);
    const settled = await settleResponse.json();
    await page.goto(`/income-expense/voucher/${settled.refundVoucherId}`);
    await expect(page.getByRole('button', { name: 'Bổ sung chứng từ / ghi chú', exact: true })).toBeVisible();
    const codeNode = page.locator('div.grid').filter({ has: page.getByText('Mã phiếu', { exact: true }) }).locator('span.font-medium').first();
    await expect(codeNode).toHaveText(/^PC/);
    const refundCode = (await codeNode.textContent())!.trim();
    const before = await snapshotReservationFinancialRows(marker, room);
    if (!mobile) {
      observerContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
      await observerContext.addCookies((await page.context().cookies()).filter(cookie => cookie.name === '_vercel_jwt'));
      observer = await observerContext.newPage();
      await login(observer, 'ketoan');
      await observer.goto(`/income-expense/voucher/${settled.refundVoucherId}`);
      await expect(observer.getByText(refundCode, { exact: true })).toBeVisible();
      await expect(observer.getByTestId('voucher-supplement-note')).toHaveCount(0);
    }
    await findVoucher(page, refundCode, mobile);
    await page.getByRole('button', { name: 'Bổ sung chứng từ / ghi chú', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'BỔ SUNG CHỨNG TỪ / GHI CHÚ', exact: true });
    await expect(dialog.getByRole('textbox')).toHaveValue('');
    await expect(dialog.getByRole('combobox')).toHaveCount(0);
    const original = dialog.getByRole('region', { name: 'Nội dung đã có' });
    await expect(original.getByRole('button', { name: 'Xem chứng từ đã có 1', exact: true })).toBeVisible();
    await expect(original.getByRole('button', { name: /Xóa|Xoá|Gỡ/ })).toHaveCount(0);
    const oldNote = await original.textContent();
    await dialog.getByRole('textbox').fill(note);
    await dialog.locator('input[type="file"]').setInputFiles({ name: `e2e-reservation-proof-${room}-supp.png`, mimeType: 'image/png', buffer: png });
    await expect(dialog.getByRole('button', { name: 'Lưu bổ sung' })).toBeEnabled();
    const saving = page.waitForResponse(r => r.url().endsWith('/rpc/append_income_expense_supplement_v1'));
    await dialog.getByRole('button', { name: 'Lưu bổ sung' }).click();
    const saved = await saving; expect(saved.status()).toBe(200);
    expect(Object.keys(saved.request().postDataJSON()).sort()).toEqual(['p_attachments', 'p_idempotency_key', 'p_note', 'p_voucher']);
    expect(saved.request().postDataJSON().p_attachments).toHaveLength(1);
    await expect(dialog).not.toBeVisible();
    if (observer) await expect(observer.getByTestId('voucher-supplement-note')).toContainText(note);
    expect(await snapshotReservationFinancialRows(marker, room)).toEqual(before);
    await findVoucher(page, refundCode, mobile);
    await expect(page.getByTestId('voucher-supplement-note')).toContainText(note);
    await expect(page.getByTestId('voucher-supplement-note')).toContainText('Người bổ sung:');
    await page.getByTestId('voucher-supplement-note').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`supplement-${mobile ? 'mobile' : 'desktop'}.png`) });
    await page.getByRole('button', { name: 'Bổ sung chứng từ / ghi chú', exact: true }).click();
    await expect(dialog.getByRole('textbox')).toHaveValue('');
    await expect(original.getByRole('button', { name: /Xem chứng từ đã có/ })).toHaveCount(2);
    expect(await original.textContent()).toContain(oldNote!.split('Ảnh / chứng từ đã có')[0].trim());
    await dialog.getByRole('textbox').fill(`Ghi chú lần hai ${room}`);
    const secondSave = page.waitForResponse(r => r.url().endsWith('/rpc/append_income_expense_supplement_v1'));
    await dialog.getByRole('button', { name: 'Lưu bổ sung' }).click();
    expect((await secondSave).status()).toBe(200);
    await page.goto(`/income-expense/voucher/${fixture.voucher_id}`);
    const sourceProof = page.getByRole('region', { name: 'Thông tin xử lý bỏ cọc' });
    await expect(sourceProof.getByRole('button', { name: /Xem chứng từ hoàn tiền/ })).toHaveCount(2);
    await expect.poll(() => sourceProof.locator('img').evaluateAll((imgs: HTMLImageElement[]) => imgs.every(img => img.complete && img.naturalWidth > 0))).toBe(true);

    const newFile = uploads.find(x => x.url.includes('-supp.png'))!; expect(newFile).toBeTruthy();
    const url = new URL(newFile.url), path = url.pathname.split('/income-expense-attachments/')[1];
    const headers = { authorization: newFile.authorization, apikey: newFile.apikey };
    async function download() {
      const signed = await page.request.post(`${url.origin}/storage/v1/object/sign/income-expense-attachments/${path}`, { headers, data: { expiresIn: 120 } });
      expect(signed.ok()).toBe(true);
      const body = await signed.json();
      const signedUrl = new URL(`/storage/v1${body.signedURL}`, url.origin).href;
      const bytes = await page.request.get(signedUrl); expect(bytes.ok()).toBe(true); return bytes.body();
    }
    const hash = sha(await download());
    const overwrite = await page.request.put(newFile.url, { headers: { ...headers, 'content-type': 'image/png' }, data: png });
    expect(overwrite.ok()).toBe(false);
    const upsert = await page.request.post(newFile.url, { headers: { ...headers, 'content-type': 'image/png', 'x-upsert': 'true' }, data: png });
    expect(upsert.ok()).toBe(false);
    await page.request.delete(`${url.origin}/storage/v1/object/income-expense-attachments`, { headers, data: { prefixes: [decodeURIComponent(path)] } });
    expect(sha(await download())).toBe(hash);
    if (observer) {
      await expect(observer.getByTestId('voucher-supplement-note')).toHaveCount(2);
      await expect.poll(() => observer!.locator('img').evaluateAll((imgs: HTMLImageElement[]) => imgs.length >= 2 && imgs.every(img => img.complete && img.naturalWidth > 0))).toBe(true);
    }
    expect(await snapshotReservationFinancialRows(marker, room)).toEqual(before);
    expect(errors).toEqual([]);
  } finally {
    await observerContext?.close();
    await cleanupReservationSupplementFixture(marker, room);
    try {
      for (const upload of uploads) {
        const url = new URL(upload.url), path = url.pathname.split('/income-expense-attachments/')[1];
        expect(path, 'Unexpected cleanup path').toContain(room);
        const removed = await page.request.delete(`${url.origin}/storage/v1/object/income-expense-attachments`, {
          headers: { authorization: upload.authorization, apikey: upload.apikey }, data: { prefixes: [decodeURIComponent(path)] },
        });
        expect(removed.ok()).toBe(true);
      }
    } finally {
      await cleanupReservationLiveFixture(marker, room);
      await cleanupReservationSupplementOrphanLinks(marker, room);
    }
  }
});
