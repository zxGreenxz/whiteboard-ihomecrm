import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';
import { createReservationLiveFixture, inspectReservationLiveFixture, inspectReservationReports, cleanupReservationLiveFixture, type ReservationLiveFixture } from './reservation-settlement-admin';

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

async function openLedger(page: Page, fixture: ReservationLiveFixture, marker: string) {
  await page.goto('/deposits');
  if (process.env.FLEET_EXPECT_BUILD_SHA) await expect(page.locator('meta[name="build-sha"]')).toHaveAttribute('content', process.env.FLEET_EXPECT_BUILD_SHA);
  await page.getByRole('button', { name: /^Sổ cọc đầy đủ/ }).click();
  await page.getByRole('tab', { name: 'Phiếu giữ chỗ', exact: true }).click();
  await page.getByPlaceholder('Tìm mã, nội dung, người nộp, phòng...').fill(marker);
  const row = page.getByRole('row').filter({ hasText: marker });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(fixture.room_name);
  return row;
}

async function settle(page: Page, row: ReturnType<Page['getByRole']>, fixture: ReservationLiveFixture, refund: number, mode: 'NOW' | 'LATER', date = fixture.today) {
  await row.getByRole('button', { name: 'Xử lý bỏ cọc', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Xử lý bỏ cọc', exact: true });
  await expect(dialog.getByRole('button', { name: 'Xác nhận xử lý', exact: true })).toBeEnabled();
  await dialog.getByLabel('Hoàn lại khách', { exact: true }).fill(String(refund));
  await dialog.getByLabel('Ngày xử lý', { exact: true }).fill(date);
  if (refund > 0) {
    await dialog.getByLabel('Cách hoàn', { exact: true }).selectOption(mode);
    if (mode === 'NOW') {
      await dialog.getByLabel('Sổ quỹ đã chi', { exact: true }).selectOption(fixture.account_id);
      await dialog.getByRole('checkbox', { name: 'Xác nhận đã trả tiền cho khách', exact: true }).check();
    }
  }
  const response = page.waitForResponse(r => r.url().endsWith('/rpc/settle_reservation_deposit_v1'));
  await dialog.getByRole('button', { name: 'Xác nhận xử lý', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(dialog).not.toBeVisible();
}

test('DEMO: two independent browsers receive settlement and refund changes through Realtime', async ({ browser }) => {
  test.setTimeout(180_000);
  const marker = `[E2E-RESERVATION:${randomUUID()}]`;
  const roomId = randomUUID();
  const a = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  const b = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  try {
    const fixture = await createReservationLiveFixture(marker, roomId);
    await cleanupReservationLiveFixture(marker, roomId, true);
    const pageA = await a.newPage(), pageB = await b.newPage();
    const errorsA = trackConsoleErrors(pageA), errorsB = trackConsoleErrors(pageB);
    const receivedTables = new Set<string>();
    let subscribed = false;
    pageB.on('websocket', socket => socket.on('framereceived', frame => {
      const raw = frame.payload.toString();
      if (raw.includes('phx_reply') && raw.includes('reservation_deposit_settlements') && raw.includes('ok')) subscribed = true;
      if (raw.includes('postgres_changes') && raw.includes(fixture.room_id)) {
        if (raw.includes('reservation_deposit_settlements')) receivedTables.add('settlement');
        if (raw.includes('income_expenses')) receivedTables.add('voucher');
      }
    }));
    await Promise.all([login(pageA, 'chunha'), login(pageB, 'chunha')]);
    const [rowA, rowB] = await Promise.all([openLedger(pageA, fixture, marker), openLedger(pageB, fixture, marker)]);
    await expect.poll(() => subscribed).toBe(true);
    expect(await inspectReservationLiveFixture(marker, roomId)).toMatchObject({ cash: 3000000, source_amount: 3000000, source_pnl: false, settlements: 0 });
    await settle(pageA, rowA, fixture, 1000000, 'LATER');
    await expect.poll(() => receivedTables.has('settlement')).toBe(true);
    await expect(rowB).toContainText('Đã bỏ cọc một phần');
    await expect(rowB).toContainText('Chờ hoàn');
    await expect(rowB.getByRole('button', { name: 'Tạo HĐ', exact: true })).toHaveCount(0);
    expect(await inspectReservationLiveFixture(marker, roomId)).toMatchObject({ cash: 3000000, retained: 2000000, refund: 1000000, effective_paid: 0, holding: false, room_status: 'AVAILABLE', settlements: 1 });
    const pendingA = pageA.locator('section').filter({ has: pageA.getByRole('heading', { name: 'Chờ hoàn cọc', exact: true }) });
    const pendingB = pageB.locator('section').filter({ has: pageB.getByRole('heading', { name: 'Chờ hoàn cọc', exact: true }) });
    await expect(pendingB).toContainText(fixture.voucher_code);
    await pendingA.locator(':scope > div').filter({ hasText: fixture.voucher_code }).getByRole('button', { name: 'Hoàn tiền', exact: true }).click();
    const refund = pageA.getByRole('dialog', { name: 'Hoàn tiền cọc', exact: true });
    await refund.getByLabel('Sổ quỹ đã chi', { exact: true }).selectOption(fixture.account_id);
    await refund.getByRole('checkbox', { name: 'Xác nhận đã trả toàn bộ tiền hoàn', exact: true }).check();
    receivedTables.delete('voucher');
    const response = pageA.waitForResponse(r => r.url().endsWith('/rpc/pay_reservation_refund_v1'));
    await refund.getByRole('button', { name: 'Ghi nhận hoàn tiền', exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(refund).not.toBeVisible();
    await expect.poll(() => receivedTables.has('voucher')).toBe(true);
    await expect(pendingB).not.toContainText(fixture.voucher_code);
    await expect(rowB).not.toContainText('Chờ hoàn');
    expect(await inspectReservationLiveFixture(marker, roomId)).toMatchObject({ cash: 2000000, retained: 2000000, refund: 1000000, effective_paid: 1000000, source_amount: 3000000, source_pnl: false, settlements: 1 });
    expect(errorsA).toEqual([]); expect(errorsB).toEqual([]);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await cleanupReservationLiveFixture(marker, roomId);
  }
});

test('DEMO: actual P&L reports retain only forfeited money and cashflow uses the real refund day', async ({ page }) => {
  test.setTimeout(150_000);
  const marker = `[E2E-RESERVATION:${randomUUID()}]`, roomId = randomUUID();
  try {
    const fixture = await createReservationLiveFixture(marker, roomId, 'PREVIOUS_MONTH');
    // P&L is monthly: cross a month boundary to distinguish recognition from
    // payment, while cashflow below still verifies the exact payment day.
    const date = new Date(`${fixture.today.slice(0, 7)}-01T12:00:00Z`);
    date.setUTCDate(0);
    const recognitionDay = date.toISOString().slice(0, 10);
    const beforeRecognition = await inspectReservationReports(fixture, recognitionDay);
    const beforePayment = await inspectReservationReports(fixture, fixture.today);
    await login(page, 'chunha');
    const row = await openLedger(page, fixture, marker);
    await settle(page, row, fixture, 1000000, 'NOW', recognitionDay);
    const afterRecognition = await inspectReservationReports(fixture, recognitionDay);
    const afterPayment = await inspectReservationReports(fixture, fixture.today);
    for (const basis of ['voucher', 'accrual'] as const) {
      expect(afterRecognition[basis].revenue - beforeRecognition[basis].revenue).toBe(2000000);
      expect(afterRecognition[basis].expense - beforeRecognition[basis].expense).toBe(0);
      expect(afterPayment[basis].revenue - beforePayment[basis].revenue).toBe(0);
      expect(afterPayment[basis].expense - beforePayment[basis].expense).toBe(0);
    }
    expect(afterRecognition.cash).toEqual(beforeRecognition.cash);
    expect(afterPayment.cash.income - beforePayment.cash.income).toBe(0);
    expect(afterPayment.cash.expense - beforePayment.cash.expense).toBe(1000000);
    expect(await inspectReservationLiveFixture(marker, roomId)).toMatchObject({ cash: 2000000, retained: 2000000, effective_paid: 1000000, source_amount: 3000000, source_pnl: false, settlements: 1 });
  } finally { await cleanupReservationLiveFixture(marker, roomId); }
});

test('DEMO: a committed settlement whose response is lost is recovered by reload without another receipt', async ({ page }) => {
  test.setTimeout(120_000);
  const marker = `[E2E-RESERVATION:${randomUUID()}]`, roomId = randomUUID();
  try {
    const fixture = await createReservationLiveFixture(marker, roomId);
    await login(page, 'chunha');
    const row = await openLedger(page, fixture, marker);
    await row.getByRole('button', { name: 'Xử lý bỏ cọc', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Xử lý bỏ cọc', exact: true });
    await expect(dialog.getByRole('button', { name: 'Xác nhận xử lý', exact: true })).toBeEnabled();
    let committed = false;
    await page.route('**/rest/v1/rpc/settle_reservation_deposit_v1', async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed = true;
      await route.abort('timedout');
    });
    await dialog.getByRole('button', { name: 'Xác nhận xử lý', exact: true }).click();
    await expect.poll(() => committed).toBe(true);
    await page.unroute('**/rest/v1/rpc/settle_reservation_deposit_v1');
    await page.reload();
    await page.getByRole('tab', { name: 'Phiếu giữ chỗ', exact: true }).click();
    const recovered = page.getByRole('row').filter({ hasText: marker });
    await expect(recovered).toContainText('Đã bỏ cọc');
    await expect(recovered.getByRole('button', { name: 'Xử lý bỏ cọc', exact: true })).toHaveCount(0);
    expect(await inspectReservationLiveFixture(marker, roomId)).toMatchObject({ cash: 3000000, retained: 3000000, refund: 0, effective_paid: 0, settlements: 1 });
  } finally { await cleanupReservationLiveFixture(marker, roomId); }
});
