import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';
import { cleanupReservationLiveFixture, createReservationLiveFixture, type ReservationLiveFixture } from './reservation-settlement-admin';

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

async function reservationRow(page: Page, marker: string) {
  await page.goto('/deposits');
  await page.getByRole('button', { name: /^Sổ cọc đầy đủ/ }).click();
  await page.getByRole('tab', { name: 'Phiếu giữ chỗ', exact: true }).click();
  await page.getByPlaceholder('Tìm mã, nội dung, người nộp, phòng...').fill(marker);
  const row = page.getByRole('row').filter({ hasText: marker });
  await expect(row).toHaveCount(1);
  return row;
}

async function settleFully(page: Page, fixture: ReservationLiveFixture, marker: string) {
  const row = await reservationRow(page, marker);
  await row.getByRole('button', { name: 'Xử lý bỏ cọc', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Xử lý bỏ cọc', exact: true });
  const response = page.waitForResponse((r) => r.url().endsWith('/rpc/settle_reservation_deposit_v1'));
  await dialog.getByRole('button', { name: 'Xác nhận xử lý', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(dialog).not.toBeVisible();
}
const displayDate = (iso: string) => iso.split('-').reverse().join('');

test('DEMO: an already-open contract form preserves input and recovers after another browser settles its deposit', async ({ browser }) => {
  test.setTimeout(150_000);
  const marker = `[E2E-RESERVATION:${randomUUID()}]`, roomId = randomUUID();
  const contractContext = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  const settlementContext = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  try {
    const fixture = await createReservationLiveFixture(marker, roomId);
    const contractPage = await contractContext.newPage(), settlementPage = await settlementContext.newPage();
    const contractErrors = trackConsoleErrors(contractPage), settlementErrors = trackConsoleErrors(settlementPage);
    // Keep the form's initial orphan-deposit snapshot so this exercises the
    // server-race recovery path rather than the ordinary Realtime refresh path.
    await contractPage.routeWebSocket(/\/realtime\/v1\/websocket/, () => {});
    await Promise.all([login(contractPage, 'chunha'), login(settlementPage, 'chunha')]);
    const row = await reservationRow(contractPage, marker);
    await row.getByRole('button', { name: 'Tạo HĐ', exact: true }).click();
    const form = contractPage.getByRole('dialog').filter({ has: contractPage.getByRole('heading', { name: 'Tạo hợp đồng mới' }) });
    await expect(form).toContainText(fixture.room_name);
    await expect(form).toContainText(fixture.voucher_code);
    await form.getByLabel('Ghi chú').fill(`${marker} bản nháp vẫn giữ`);
    await form.locator('input[name="start_date"]').fill(displayDate(fixture.today));
    await form.locator('input[name="start_date"]').blur();
    const end = new Date(`${fixture.today}T12:00:00Z`); end.setUTCFullYear(end.getUTCFullYear() + 1);
    await form.locator('input[name="end_date"]').fill(displayDate(end.toISOString().slice(0, 10)));
    await form.locator('input[name="end_date"]').blur();
    await form.locator('input[name="start_billing_date"]').fill(displayDate(fixture.today));
    await form.locator('input[name="start_billing_date"]').blur();
    const firstMonthEnd = new Date(`${fixture.today}T12:00:00Z`); firstMonthEnd.setUTCMonth(firstMonthEnd.getUTCMonth() + 1, 0);
    await form.locator('input[name="end_billing_date"]').fill(displayDate(firstMonthEnd.toISOString().slice(0, 10)));
    await form.locator('input[name="end_billing_date"]').blur();
    await form.getByRole('button', { name: 'Thêm khách hàng', exact: true }).click();
    const customers = contractPage.getByRole('dialog', { name: 'Chọn khách hàng' });
    await customers.getByRole('checkbox').first().click();
    await customers.getByRole('button', { name: /^Xác nhận \(1\)$/ }).click();
    await expect(form.getByRole('button', { name: 'Lưu', exact: true })).toBeEnabled();

    await settleFully(settlementPage, fixture, marker);
    await expect(form.getByRole('button', { name: 'Lưu', exact: true })).toBeEnabled();
    const createResponse = contractPage.waitForResponse((r) => r.url().endsWith('/rpc/create_contract_v2'));
    await form.getByRole('button', { name: 'Lưu', exact: true }).click();
    expect((await createResponse).status()).toBeGreaterThanOrEqual(400);
    await expect(contractPage.getByText('Danh sách cọc giữ chỗ đã thay đổi', { exact: true })).toBeVisible();
    await expect(contractPage.getByText(/Đã tải lại cọc của phòng/)).toBeVisible();
    await expect(form.getByLabel('Ghi chú')).toHaveValue(`${marker} bản nháp vẫn giữ`);
    await expect(form).not.toContainText(fixture.voucher_code);
    expect(contractErrors.some((message) => message.includes('code: 55000') && message.includes('Phiếu cọc'))).toBe(true);
    expect(contractErrors.filter((message) => !message.includes('code: 55000') || !message.includes('Phiếu cọc'))).toEqual([]);
    expect(settlementErrors).toEqual([]);
  } finally {
    await Promise.all([contractContext.close(), settlementContext.close()]);
    await cleanupReservationLiveFixture(marker, roomId);
  }
});

test('DEMO: authenticated accounting user without settlement permission sees no settlement action', async ({ page }) => {
  test.setTimeout(90_000);
  const marker = `[E2E-RESERVATION:${randomUUID()}]`, roomId = randomUUID();
  try {
    const fixture = await createReservationLiveFixture(marker, roomId);
    await login(page, 'ketoan');
    const row = await reservationRow(page, marker);
    await expect(row.getByRole('button', { name: 'Xử lý bỏ cọc', exact: true })).toHaveCount(0);
  } finally { await cleanupReservationLiveFixture(marker, roomId); }
});
