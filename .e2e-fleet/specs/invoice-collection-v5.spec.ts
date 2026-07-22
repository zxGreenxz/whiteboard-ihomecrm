import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import { credentials, login, trackConsoleErrors } from './auth';
import {
  cleanupAccountingFixture,
  getAccountingPreflight,
  inspectAccountingState,
  type AccountingFixture,
  type AccountingPreflight,
  type AccountingState,
} from './accounting-admin';

// Headless E2E for the invoice.collection.v5 UI on org DEMO: log in, create a
// fresh contract + first invoice, collect it multi-tender through the V5 UI,
// assert the receipt/collection was created with balanced money, then reverse
// the whole collection through the UI. Console errors are tracked throughout
// and every fixture is reversed + cleaned up in `finally`. Modelled on
// specs/accounting-chain.spec.ts but scoped to collection + reversal.

const RENT_AMOUNT = 113_000;
const DEPOSIT_AMOUNT = 47_000;
const FIRST_TENDER_AMOUNT = 100_000;
const ALLOW_PREFLIGHT_SKIP = process.env.FLEET_ACCOUNTING_ALLOW_PREFLIGHT_SKIP === '1';
const RPC = (name: string) => new RegExp(`/rest/v1/rpc/${name}\\b`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test.describe.configure({ mode: 'serial' });

interface ContractRpcBody {
  contract?: { id?: unknown; contract_number?: unknown };
  invoice?: { id?: unknown; invoice_number?: unknown; total_amount?: unknown };
}
interface CollectionRpcBody {
  collection_id?: unknown;
  tenders?: unknown[];
}
interface ReversalRpcBody {
  collection_id?: unknown;
  status?: unknown;
}

function failOrSkipPreflight(reason: string): never {
  const message = `V5 collection E2E preflight failed: ${reason}`;
  if (ALLOW_PREFLIGHT_SKIP) {
    console.warn(`[invoice-collection-v5] PRE-DEPLOY SKIP: ${reason}`);
    test.skip(true, `${message} (explicit pre-deploy diagnostic skip)`);
  }
  throw new Error(
    `${message}. Chỉ pre-deploy diagnostic mới được đặt FLEET_ACCOUNTING_ALLOW_PREFLIGHT_SKIP=1.`,
  );
}

async function requiredPreflight(): Promise<
  AccountingPreflight & { ready: true; actorId: string; fixture: AccountingFixture }
> {
  let preflight: AccountingPreflight;
  try {
    preflight = await getAccountingPreflight(RENT_AMOUNT, DEPOSIT_AMOUNT);
  } catch (error) {
    failOrSkipPreflight(`không chạy được preflight SQL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!preflight.ready || !preflight.actorId || !preflight.fixture) {
    failOrSkipPreflight(preflight.reason);
  }
  return preflight as AccountingPreflight & {
    ready: true;
    actorId: string;
    fixture: AccountingFixture;
  };
}

function trackBrowserSupabaseProjectRefs(page: Page): Set<string> {
  const refs = new Set<string>();
  page.on('request', (request) => {
    try {
      const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(new URL(request.url()).hostname);
      if (match && match[1].toLowerCase() !== 'api') refs.add(match[1].toLowerCase());
    } catch {
      // ignore non-HTTP URLs
    }
  });
  return refs;
}

async function expectBrowserProject(page: Page, observedRefs: Set<string>, managementProjectRef: string) {
  const storageRefs = await page.evaluate(() =>
    Object.keys(localStorage).flatMap((key) => {
      const match = /^sb-([a-z0-9]+)-auth-token$/i.exec(key);
      return match ? [match[1].toLowerCase()] : [];
    }),
  );
  const browserRefs = [...new Set([...observedRefs, ...storageRefs])].sort();
  expect(
    browserRefs,
    'Management API phải trỏ đúng Supabase project mà browser đang dùng trước khi ghi dữ liệu.',
  ).toEqual([managementProjectRef.toLowerCase()]);
}

function isoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function displayDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}
function accountingDates(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const contractEnd = new Date(year + 1, month, 0);
  return {
    signed: isoDate(first),
    contractStart: isoDate(first),
    contractEnd: isoDate(contractEnd),
    billingStart: isoDate(first),
    billingEnd: isoDate(last),
  };
}

async function fillDate(input: Locator, iso: string) {
  await input.fill(displayDate(iso));
  await input.press('Tab');
  await expect(input).toHaveValue(displayDate(iso));
}

async function rpcBody<T>(response: Response, label: string): Promise<T> {
  const bodyText = await response.text();
  expect(response.ok(), `${label} trả HTTP ${response.status()}: ${bodyText.slice(0, 1500)}`).toBeTruthy();
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`${label} trả JSON không hợp lệ: ${bodyText.slice(0, 500)}`);
  }
  if (typeof body === 'string') body = JSON.parse(body);
  return (Array.isArray(body) && body.length === 1 ? body[0] : body) as T;
}

function requiredUuid(value: unknown, label: string): string {
  const text = String(value ?? '');
  expect(text, `${label} phải là UUID`).toMatch(UUID_RE);
  return text;
}
function numeric(value: unknown): number {
  return Number(value) || 0;
}

async function selectOption(page: Page, combobox: Locator, name: string) {
  await combobox.click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(combobox).toContainText(name);
}

function paymentCard(dialog: Locator, index: number): Locator {
  return dialog.getByText(`Thanh toán #${index}`, { exact: true }).locator('xpath=../..');
}

function assertCollectedState(state: AccountingState) {
  expect(state.invoiceStatus).toBe('PAID');
  expect(state.invoicePaid).toBe(state.invoiceTotal);
  expect(state.invoiceDeposit).toBe(DEPOSIT_AMOUNT);
  expect(state.collectionStatus).toBe('ACTIVE');
  expect(state.tenderCount).toBe(2);
  expect([...state.tenderMethods].sort()).toEqual(['TM', 'TT']);
  // Money invariant: applied classes sum back to the collected total.
  expect(state.pnlAllocated + state.depositAllocated).toBe(state.invoiceTotal);
  expect(state.depositAllocated).toBe(DEPOSIT_AMOUNT);
  expect(state.sourcePnl).toBe(state.pnlAllocated);
  expect(state.sourceDeposit).toBe(state.depositAllocated);
  expect(state.reversalPnl).toBe(0);
  expect(state.reversalDeposit).toBe(0);
  expect(state.activeReceiptCount).toBe(2);
  expect(state.reversedPaymentCount).toBe(0);
  expect(state.invalidReversalCount).toBe(0);
}

function assertReversedState(state: AccountingState) {
  expect(state.invoiceStatus).toBe('APPROVED');
  expect(state.invoicePaid).toBe(0);
  expect(state.collectionStatus).toBe('REVERSED');
  expect(state.activeReceiptCount).toBe(0);
  expect(state.reversedPaymentCount).toBe(2);
  expect(state.reversalPnl).toBe(state.pnlAllocated);
  expect(state.reversalDeposit).toBe(state.depositAllocated);
  expect(state.invalidReversalCount).toBe(0);
}

async function createContractThroughUi(
  page: Page,
  fixture: AccountingFixture,
  marker: string,
  dates: ReturnType<typeof accountingDates>,
  onCommitted: (contractId: string) => void,
) {
  await page.goto('/contracts');
  await expect(page.getByRole('heading', { name: 'Hợp đồng thuê' })).toBeVisible();

  const search = page.getByPlaceholder('Tìm theo mã HĐ, tên khách, SĐT, tên phòng...');
  const toolbar = search.locator('xpath=../..');
  await toolbar.locator('button:has(svg.lucide-plus)').first().click();

  const dialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Tạo hợp đồng mới' }),
  });
  await expect(dialog).toBeVisible();

  const comboboxes = dialog.getByRole('combobox');
  await selectOption(page, comboboxes.nth(0), fixture.buildingName);
  await selectOption(page, comboboxes.nth(1), fixture.roomName);

  await dialog.getByRole('button', { name: 'Thêm khách hàng' }).click();
  const customerDialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Chọn khách hàng' }),
  });
  await customerDialog.getByPlaceholder('Tìm theo tên, SĐT, CCCD...').fill(fixture.customerPhone);
  const customerCheckbox = customerDialog.getByRole('checkbox').first();
  await expect(customerCheckbox).toBeVisible();
  await customerCheckbox.click();
  await customerDialog.getByRole('button', { name: /^Xác nhận/ }).click();
  await expect(customerDialog).toBeHidden();
  await expect(dialog.getByText(fixture.customerName, { exact: true })).toBeVisible();

  await fillDate(dialog.locator('input[name="signed_date"]'), dates.signed);
  await fillDate(dialog.locator('input[name="start_date"]'), dates.contractStart);
  await fillDate(dialog.locator('input[name="end_date"]'), dates.contractEnd);
  await fillDate(dialog.locator('input[name="start_billing_date"]'), dates.billingStart);
  const billingEndInput = dialog.locator('input[name="end_billing_date"]');
  await expect(billingEndInput).not.toHaveValue('');
  await fillDate(billingEndInput, dates.billingEnd);

  const rentInput = dialog.locator('input[name="rent_price"]');
  const depositInput = dialog.locator('input[name="total_deposit"]');
  await rentInput.fill(String(RENT_AMOUNT));
  await rentInput.press('Tab');
  await expect(depositInput).toHaveValue('113.000');
  await depositInput.fill(String(DEPOSIT_AMOUNT));
  await depositInput.press('Tab');
  await dialog.locator('textarea[name="notes"]').fill(marker);

  await dialog.getByText('Đóng đủ trong hoá đơn', { exact: true }).click();
  await expect(dialog.getByRole('radio', { name: /Đóng đủ trong hoá đơn/ })).toBeChecked();
  await expect(
    dialog.getByRole('heading', { name: 'Xem trước hoá đơn cọc + tháng đầu' }),
  ).toBeVisible();

  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && RPC('create_contract_v2').test(response.url()),
    { timeout: 45_000 },
  );
  await dialog.getByRole('button', { name: /^Lưu$/ }).click();
  const response = await responsePromise;
  const body = await rpcBody<ContractRpcBody>(response, 'create_contract_v2');
  const contractId = requiredUuid(body?.contract?.id, 'contract.id');
  onCommitted(contractId);
  const invoiceId = requiredUuid(body?.invoice?.id, 'invoice.id');
  await expect(dialog).toBeHidden();

  const commissionDialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: /TẠO PHIẾU CHI HOA HỒNG/i }),
  });
  await expect(commissionDialog).toBeVisible();
  await commissionDialog.getByRole('button', { name: 'Bỏ qua' }).click();
  await expect(commissionDialog).toBeHidden();

  return {
    contractId,
    invoiceId,
    invoiceTotal: numeric(body?.invoice?.total_amount),
  };
}

async function collectInvoiceThroughUi(
  page: Page,
  invoiceId: string,
  fixture: AccountingFixture,
  marker: string,
  invoiceTotal: number,
): Promise<string> {
  expect(invoiceTotal).toBeGreaterThan(FIRST_TENDER_AMOUNT);
  await page.goto(`/invoices/${invoiceId}`);
  await expect(page.getByRole('button', { name: 'Ghi nhận thanh toán' })).toBeVisible();
  await page.getByRole('button', { name: 'Ghi nhận thanh toán' }).click();

  const dialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Ghi nhận thanh toán' }),
  });
  await expect(dialog).toBeVisible();

  const firstAccount = dialog.getByText('Sổ quỹ nhận *', { exact: true }).locator('..').getByRole('combobox');
  if (await firstAccount.count()) {
    await firstAccount.click();
    await page.getByRole('option', { name: fixture.receivingAccountName, exact: true }).click();
  }

  await dialog.getByRole('button', { name: 'Thêm dòng thanh toán' }).click();
  const first = paymentCard(dialog, 1);
  const second = paymentCard(dialog, 2);
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect(first.getByRole('combobox').first()).toContainText('TM');
  await expect(second.getByRole('combobox').first()).toContainText('TT');

  await first.locator('input[inputmode="numeric"]').first().fill(String(FIRST_TENDER_AMOUNT));
  await second.locator('input[inputmode="numeric"]').first().fill(String(invoiceTotal - FIRST_TENDER_AMOUNT));
  await dialog.locator('#notes').fill(marker);

  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && RPC('record_invoice_collection_v5').test(response.url()),
    { timeout: 45_000 },
  );
  await dialog.getByRole('button', { name: 'Ghi nhận thanh toán' }).click();
  const response = await responsePromise;
  const body = await rpcBody<CollectionRpcBody>(response, 'record_invoice_collection_v5');
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Đã thanh toán', { exact: true }).first()).toBeVisible();

  expect(body?.tenders).toHaveLength(2);
  return requiredUuid(body?.collection_id, 'collection_id');
}

async function reverseCollectionThroughUi(page: Page, fixture: AccountingFixture, collectionId: string) {
  await page.goto('/reports/finance/profit-distribution');
  await expect(page.getByRole('heading', { name: 'Báo cáo Lợi Nhuận' })).toBeVisible();
  await page.getByRole('tab', { name: 'BC Doanh Thu Chi Phí' }).click();
  await selectOption(page, page.getByRole('combobox', { name: 'Chọn toà nhà' }), fixture.buildingName);

  const revenueRow = page
    .locator('tbody tr')
    .filter({ hasText: fixture.roomName })
    .filter({ has: page.locator('td:last-child button') })
    .first();
  await expect(revenueRow).toBeVisible({ timeout: 30_000 });
  await revenueRow.locator('td').last().getByRole('button').click();

  const paymentsDialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Các lần thanh toán' }),
  });
  await expect(paymentsDialog).toBeVisible();
  await expect(paymentsDialog.getByText('V5 khóa sổ', { exact: true })).toHaveCount(2);

  await paymentsDialog.locator('button[title^="Hoàn tác toàn bộ lần thu V5"]').first().click();
  const confirmDialog = page.getByRole('alertdialog').filter({
    has: page.getByRole('heading', { name: 'Hoàn tác lần thu tiền?' }),
  });
  await expect(confirmDialog).toContainText('2 dòng TM/TK/TT');

  const reversePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && RPC('reverse_invoice_collection_v5').test(response.url()),
    { timeout: 45_000 },
  );
  await confirmDialog.getByRole('button', { name: 'Hoàn tác' }).click();
  const reverseResponse = await reversePromise;
  const reverseBody = await rpcBody<ReversalRpcBody>(reverseResponse, 'reverse_invoice_collection_v5');
  expect(requiredUuid(reverseBody?.collection_id, 'reversal.collection_id')).toBe(collectionId);
  expect(reverseBody?.status).toBe('REVERSED');
  await expect(confirmDialog).toBeHidden();
  await expect(paymentsDialog.getByText('Chưa có phiếu thanh toán nào.', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(paymentsDialog).toBeHidden();
}

test('V5 UI: contract -> first invoice -> multi-tender collection -> reversal', async ({ page }) => {
  test.setTimeout(240_000);
  credentials('chunha');

  const dates = accountingDates();
  const preflight = await requiredPreflight();
  const fixture = preflight.fixture;
  const marker = `[E2E-ACCOUNTING:${Date.now()}-${Math.random().toString(16).slice(2)}]`;
  const consoleErrors = trackConsoleErrors(page);
  const browserProjectRefs = trackBrowserSupabaseProjectRefs(page);
  let committedContractId: string | null = null;

  try {
    await login(page, 'chunha');
    await expectBrowserProject(page, browserProjectRefs, preflight.managementProjectRef);
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('flt:')) localStorage.removeItem(key);
      }
    });

    const created = await createContractThroughUi(page, fixture, marker, dates, (contractId) => {
      committedContractId = contractId;
    });
    expect(created.invoiceTotal).toBeGreaterThanOrEqual(RENT_AMOUNT + DEPOSIT_AMOUNT);
    expect(consoleErrors, `console sau tạo HĐ: ${consoleErrors.join(' | ')}`).toEqual([]);

    const collectionId = await collectInvoiceThroughUi(page, created.invoiceId, fixture, marker, created.invoiceTotal);
    const collected = await inspectAccountingState(created.invoiceId, collectionId);
    assertCollectedState(collected);
    await test.info().attach('v5-after-collection.json', {
      body: JSON.stringify(collected, null, 2),
      contentType: 'application/json',
    });
    expect(consoleErrors, `console sau thu tiền: ${consoleErrors.join(' | ')}`).toEqual([]);

    await reverseCollectionThroughUi(page, fixture, collectionId);
    const reversed = await inspectAccountingState(created.invoiceId, collectionId);
    assertReversedState(reversed);
    await test.info().attach('v5-after-reversal.json', {
      body: JSON.stringify(reversed, null, 2),
      contentType: 'application/json',
    });
    expect(consoleErrors, `console cuối chuỗi: ${consoleErrors.join(' | ')}`).toEqual([]);
  } finally {
    await cleanupAccountingFixture(marker, committedContractId);
  }
});
