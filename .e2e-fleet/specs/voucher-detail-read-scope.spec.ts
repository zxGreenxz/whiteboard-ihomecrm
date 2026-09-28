import { test, expect, type Page, type Request } from '@playwright/test';
import { ORIGINAL_VOUCHER_ID, RPC, testConnection, originalTestSession } from '../../scripts/test-voucher-detail-read-authz.mjs';

// Read-only browser checks against the TEST clone. Missing target/fixture is an
// error, never a skipped authorization test. No token/password enters artifacts.
let connection: Awaited<ReturnType<typeof testConnection>>;
let session: Awaited<ReturnType<typeof originalTestSession>>;
const detailPath = `/income-expense/voucher/${ORIGINAL_VOUCHER_ID}`;
const printPath = `/income-expense/print/${ORIGINAL_VOUCHER_ID}`;

test.beforeAll(async () => {
  const base = process.env.FLEET_BASE_URL ?? '';
  expect(base, 'explicit TEST preview/local URL required').toMatch(
    /^https?:\/\/(?:localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?|ihomecrm-git-test-env-[a-z0-9-]+\.vercel\.app)\/?$/,
  );
  connection = await testConnection();
  session = await originalTestSession(connection);
});

async function prepare(page: Page) {
  const errors: string[] = [], wrongTargets: string[] = [];
  const state = { errors, wrongTargets, printCalls: 0 };
  // Opt-in diagnostic only: pace dispatch to the real TEST server without
  // mocking responses, retrying requests, suppressing errors, or changing the
  // server timeout. The default remains the application's unpaced traffic.
  const configuredLimit = process.env.FLEET_REST_CONCURRENCY;
  const restLimit = configuredLimit === undefined ? 0 : Number(configuredLimit);
  if (configuredLimit !== undefined && (!Number.isInteger(restLimit) || restLimit < 1 || restLimit > 8)) {
    throw new Error('FLEET_REST_CONCURRENCY must be an integer from 1 to 8');
  }
  if (restLimit) test.info().annotations.push({
    type: 'controlled-transport-pacing',
    description: `Real TEST REST requests, concurrency ${restLimit}; UX evidence only, not production performance evidence`,
  });
  const active = new Set<Request>();
  const queued: Array<() => void> = [];
  let closed = false;
  const release = (request: Request) => {
    if (active.delete(request)) queued.shift()?.();
  };
  page.on('requestfinished', release);
  page.on('requestfailed', release);
  page.on('close', () => {
    closed = true;
    active.clear();
    for (const admit of queued.splice(0)) admit();
  });
  const admit = (request: Request) => new Promise<boolean>(resolveAdmitted => {
    const run = () => {
      if (closed) { resolveAdmitted(false); return; }
      active.add(request); resolveAdmitted(true);
    };
    if (active.size < restLimit) run(); else queued.push(run);
  });
  await page.exposeFunction('__voucherRecordPrint', () => { state.printCalls += 1; });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  await page.route('https://*.supabase.co/**', async route => {
    if (new URL(route.request().url()).origin !== connection.url) {
      wrongTargets.push(new URL(route.request().url()).origin);
      await route.abort('blockedbyclient'); return;
    }
    const request = route.request();
    if (restLimit && new URL(request.url()).pathname.startsWith('/rest/v1/')) {
      if (!await admit(request)) return;
    }
    try { await route.continue(); }
    catch (error) { release(request); if (!closed) throw error; }
  });
  await page.addInitScript(({ key, authSession }) => {
    localStorage.setItem(key, JSON.stringify(authSession));
    window.print = () => { void (window as unknown as { __voucherRecordPrint: () => Promise<void> }).__voucherRecordPrint(); };
  }, { key: `sb-${connection.cred.testRef}-auth-token`, authSession: session });
  return state;
}

async function assertComplete(page: Page) {
  await expect(page.getByText('PC2609103', { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Thu chi khác', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('950NK', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/941[.,]040\s*đ/).first()).toBeVisible();
  await expect(page.getByText('Chi tiết phiếu chưa đầy đủ. Vui lòng tải lại trước khi thao tác')).toHaveCount(0);
  await expect(page.getByText('Không tải được hạng mục. Thử lại')).toHaveCount(0);
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`${viewport.name}: NATHAN reads item and contextual building label with real JWT`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = await prepare(page);
    const response = page.waitForResponse(r => r.url().includes(`/rpc/${RPC}`) && r.status() === 200);
    await page.goto(detailPath);
    const body = await (await response).json();
    const row = body.rows.find((r: { header: { id: string } }) => r.header.id === ORIGINAL_VOUCHER_ID);
    expect(row, 'same UUID must return one complete item').toBeTruthy();
    expect(row.items_complete).toBe(true); expect(row.expected_item_count).toBe(1);
    expect(row.items).toHaveLength(1);
    await assertComplete(page);
    expect(state.wrongTargets).toEqual([]); expect(state.errors).toEqual([]);
  });
}

test('desktop list: search original voucher and open complete detail popup', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await prepare(page);
  // Another APPROVED voucher has the same code. The regression UUID is pending;
  // selecting CASH would test a different voucher despite matching its code.
  await page.goto('/income-expense?layer=PENDING&approval_status=UNAPPROVED');
  await page.getByPlaceholder('Tìm mã phòng, tên/mã phiếu hoặc số tiền (±5.000đ)...').fill('PC2609103');
  const view = page.getByTitle('Xem chi tiết', { exact: true });
  await expect(view).toHaveCount(1, { timeout: 60_000 });
  const detailResponse = page.waitForResponse(response => response.url().includes(`/rpc/${RPC}`)
    && response.request().postDataJSON()?.p_voucher_ids?.length === 1
    && response.request().postDataJSON()?.p_voucher_ids?.[0] === ORIGINAL_VOUCHER_ID);
  await view.click();
  const payload = await (await detailResponse).json();
  expect(payload.rows.map((row: { header: { id: string } }) => row.header.id)).toEqual([ORIGINAL_VOUCHER_ID]);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Thu chi khác', { exact: false }).first()).toBeVisible();
  await expect(dialog.getByText('950NK', { exact: false }).first()).toBeVisible();
  await expect(dialog.getByText(/941[.,]040\s*đ/).first()).toBeVisible();
  await expect(dialog.getByText(/Không tải được đầy đủ chi tiết phiếu/)).toHaveCount(0);
  expect(state.wrongTargets).toEqual([]); expect(state.errors).toEqual([]);
});

test('print: complete real detail enables printing with items and building loaded', async ({ page }) => {
  const state = await prepare(page);
  await page.goto(printPath);
  await assertComplete(page);
  // TEST clone deliberately has no attachment bytes. Verify manual printing of
  // complete voucher data; successful automatic image loading is not claimed.
  await page.getByRole('button', { name: 'In phiếu', exact: true }).click();
  await expect.poll(() => state.printCalls).toBeGreaterThan(0);
  expect(state.wrongTargets).toEqual([]); expect(state.errors).toEqual([]);
});

test('print: incomplete reader result blocks automatic printing and shows retry state', async ({ page }) => {
  const state = await prepare(page);
  await page.clock.install();
  await page.route(`**/rest/v1/rpc/${RPC}`, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const json = await response.json();
    expect(json.rows.length, 'real fixture cannot be empty').toBeGreaterThan(0);
    for (const row of json.rows) {
      row.items = []; row.items_complete = false; row.issues = ['ITEMS_INCOMPLETE'];
    }
    await route.fulfill({ response, json });
  });
  await page.goto(printPath);
  await expect(page.getByText(/Không tải được đầy đủ chi tiết phiếu/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /Tải lại|Thử lại/i }).first()).toBeVisible();
  // Advance beyond the 500ms auto-print timer; incomplete data must never print.
  await page.clock.fastForward(1000);
  expect(state.printCalls).toBe(0);
  expect(state.wrongTargets).toEqual([]); expect(state.errors).toEqual([]);
});
