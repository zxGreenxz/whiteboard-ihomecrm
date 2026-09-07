import { expect, test } from '@playwright/test';
import QRCode from 'qrcode';
import { login, trackConsoleErrors } from './auth';

test('contract customer dialog pastes CCCD only for individuals without saving', async ({ page, context }) => {
  const errors = trackConsoleErrors(page);
  let customerWrites = 0;
  let customerImageWrites = 0;
  await page.route('**/*', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = request.url();
    const isWrite = method === 'POST' || method === 'PUT';
    if (isWrite && /\/rest\/v1\/customers(?:\?|$)/.test(url)) {
      customerWrites += 1;
      await route.abort('blockedbyclient');
      return;
    }
    const decodedUrl = decodeURIComponent(url);
    const isCustomerImageUpload = isWrite && (
      /\/storage\/v1\/object\/customer-images(?:\/|\?|$)/.test(url)
      || (/\/upload(?:\?|$)/.test(url) && decodedUrl.includes('key=customer-images/'))
    );
    if (isCustomerImageUpload) {
      customerImageWrites += 1;
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  await login(page, 'chunha');
  await page.goto('/contracts');
  await page.locator('button.bg-green-500').first().click();
  await page.getByRole('button', { name: /Chọn khách|Thêm khách/ }).first().click();
  await page.getByRole('button', { name: 'Tạo mới' }).click();

  const dialog = page
    .getByRole('dialog')
    .filter({ hasText: 'Nhập thông tin khách hàng cho hệ thống quản lý' });
  await expect(dialog.getByText('Quét QR CCCD')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Quét bằng camera' })).toBeVisible();

  const payload =
    '001234567890|012345678|Nguyễn Minh An|02031994|Nữ|12 Đường Mẫu, Phường Thử, Thành phố Ví Dụ|06052022';
  const png = await QRCode.toBuffer(payload, { type: 'png', width: 500, margin: 4 });
  await dialog.getByLabel('Số điện thoại *').fill('0900000000');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) }),
    ]);
  }, png.toString('base64'));
  await dialog.getByTestId('cccd-qr-zone').focus();
  await page.keyboard.press('Control+V');

  await expect(dialog.getByLabel('Họ tên khách *')).toHaveValue('Nguyễn Minh An');
  await expect(dialog.getByLabel('CMND/CCCD')).toHaveValue('001234567890');
  await expect(dialog.getByText('Nữ', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByLabel('Địa chỉ thường trú')).toHaveValue(
    '12 Đường Mẫu, Phường Thử, Thành phố Ví Dụ',
  );
  expect(customerWrites).toBe(0);
  expect(customerImageWrites).toBe(0);

  await dialog.getByRole('tab', { name: 'Tổ chức' }).click();
  await expect(dialog.getByText('Quét QR CCCD')).toHaveCount(0);
  await dialog.getByRole('tab', { name: 'Cá nhân' }).click();
  await expect(dialog.getByText('Quét QR CCCD')).toBeVisible();
  expect(customerWrites).toBe(0);
  expect(customerImageWrites).toBe(0);
  expect(errors).toEqual([]);
});
