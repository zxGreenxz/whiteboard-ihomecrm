// Real TEST roles and database, supplied only by the guarded disposable-fixture runner.
import { expect, test, type Page } from '@playwright/test';

type Actor = { id: string; email: string; password: string };
type Fixtures = { org: string; ref: string; url: string; writer: Actor; viewer: Actor };
type LedgerSnapshot = {
  owner_id: string;
  wallets: Array<{ id: string; name: string; balance: number; version: number; hidden: boolean }>;
  categories: Array<{ id: string; name: string; type: string; version: number }>;
  transactions: Array<{ id: string; description: string | null; amount: number; type: string; version: number; deleted_at: string | null }>;
  transfers: Array<{ id: string; amount: number; goal_id: string | null; deleted_at: string | null }>;
  goals: Array<{ id: string; name: string; saved: number }>;
  budgets: Array<{ id: string; amount: number; category_id: string | null }>;
};
type NetworkControl = { loseReceiptFor?: string; lostReceipts: number; sttCalls: number; aiReads: number; snapshot?: LedgerSnapshot };
const fixture = JSON.parse(process.env.PERSONAL_FINANCE_TEST_FIXTURES || 'null') as Fixtures | null;
if (!fixture || fixture.ref === 'tryymsxyyckgbrmmvozx' || fixture.org !== 'dddd0000-0000-4000-8000-000000000001') {
  throw new Error('Run scripts/test-personal-finance-browser.mjs; guarded TEST fixtures are required');
}
const f: Fixtures = fixture;
if (new URL(f.url).hostname !== `${f.ref}.supabase.co`) throw new Error('TEST URL/ref mismatch');
const base = process.env.FLEET_BASE_URL || '';
if (!/^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error('Local candidate URL required');

// Independent accounts: a writer failure must not skip the read-only role proof.
test.use({
  viewport: { width: 390, height: 844 }, storageState: { cookies: [], origins: [] },
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

async function openAs(page: Page, actor: Actor, canWrite: boolean) {
  const errors: string[] = [];
  const blocked: string[] = [];
  const writes: Array<{ key: string; payload: Record<string, unknown> }> = [];
  const network: NetworkControl = { lostReceipts: 0, sttCalls: 0, aiReads: 0 };
  page.on('response', async response => {
    if (response.url() === `${f.url}/rest/v1/rpc/personal_finance_snapshot` && response.ok()) {
      const snapshot = await response.json() as LedgerSnapshot;
      expect(snapshot.owner_id).toBe(actor.id);
      network.snapshot = snapshot;
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async route => {
    const request = route.request();
    const target = new URL(request.url());
    const changing = !['GET', 'HEAD', 'OPTIONS'].includes(request.method());
    const deny = async () => { blocked.push(`${request.method()} ${target.origin}${target.pathname}`); await route.abort('blockedbyclient'); };
    if (target.hostname.endsWith('.supabase.co') && target.origin !== f.url) return deny();
    if (changing && target.origin !== f.url) return deny();
    if (target.origin === f.url && changing) {
      if (target.pathname.startsWith('/functions/v1/quick-entry/')) {
        if (!canWrite) return deny();
        expect(request.headers()['x-organization-id']).toBe(f.org);
        expect(request.headers().authorization).toMatch(/^Bearer /);
        // Only AI transport is deterministic; the saved batch still uses real JWT/RPC/SQL.
        if (target.pathname.endsWith('/audio/transcriptions')) {
          network.sttCalls += 1;
          return route.fulfill({ json: { text: 'TEST cà phê 1000' } });
        }
        if (target.pathname.endsWith('/chat/completions')) {
          network.aiReads += 1;
          return route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ items: [{ desc: 'TEST Cà phê giọng nói', amount_vnd: 1000, transactionType: 'EXPENSE', category: null, confidence: 0.9 }], total_vnd: 1000, date: null, vendor: null, building_mention: null, room_mention: null, customer_code: null, period_start: null, period_end: null }) } }] } });
        }
        return deny();
      } else if (target.pathname === '/rest/v1/rpc/personal_finance_mutate') {
        if (!canWrite) return deny();
        const body = request.postDataJSON();
        if (!body?.p_request_key || typeof body.p_payload !== 'object') return deny();
        writes.push({ key: body.p_request_key, payload: body.p_payload });
        if (network.loseReceiptFor === body.p_payload.action) {
          network.loseReceiptFor = undefined;
          // The real TEST database commits; the app cannot confirm that receipt.
          // Replay must use exactly this key/payload and leave one persisted entity.
          const committed = await route.fetch();
          expect(committed.ok()).toBe(true);
          network.lostReceipts += 1;
          await route.fulfill({ status: 200, contentType: 'application/json', json: { receiptUnavailable: true } });
          return;
        }
      } else if (target.pathname.startsWith('/rest/v1/rpc/')) {
        const name = target.pathname.split('/').pop() || '';
        // Existing layout roster RPC is SELECT-only (20260725001000 migration).
        if (!/^(?:get_|read_|list_|is_|has_|can_)/.test(name) && !['personal_finance_bootstrap', 'personal_finance_snapshot', 'business_performance_organizations_v1'].includes(name)) return deny();
      } else if (!['/auth/v1/token', '/auth/v1/logout'].includes(target.pathname)) return deny();
    }
    await route.continue();
  });
  await page.addInitScript(org => localStorage.setItem('ihomecrm.selectedOrganizationId', org), f.org);
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Tài Khoản' }).fill(actor.email);
  await page.getByRole('textbox', { name: 'Mật khẩu' }).fill(actor.password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/login'));
  await page.waitForLoadState('networkidle');
  await page.goto('/finance/personal-wallet');
  await expect(page.getByTestId('personal-finance-app')).toBeVisible();
  return { errors, blocked, writes, network };
}

async function navigate(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Điều hướng ví cá nhân' }).getByRole('button', { name, exact: true }).click();
}

async function closeSheets(page: Page) {
  for (let n = 0; n < 4 && await page.getByRole('dialog').count(); n += 1) {
    const sheet = page.getByRole('dialog').last();
    const titleId = await sheet.getAttribute('aria-labelledby');
    await sheet.getByRole('button', { name: /^(Close|Đóng)$/ }).last().click();
    await expect(page.locator(`[aria-labelledby="${titleId}"]`)).not.toBeVisible();
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function manageCategories(page: Page) {
  await navigate(page, 'Giao dịch');
  await page.getByRole('button', { name: 'Cài đặt ví cá nhân', exact: true }).click();
  await page.getByRole('button', { name: 'Danh mục thu chi', exact: true }).click();
}

async function addTransaction(page: Page, options: { type: 'INCOME' | 'EXPENSE'; amount: number; description: string; category?: string }) {
  await navigate(page, 'Ghi thu chi');
  await page.getByRole("button", { name: "Nhập tay", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Ghi thu chi", exact: true });
  await editor.getByRole('button', { name: options.type === 'INCOME' ? '+ Thu nhập' : '− Chi tiêu', exact: true }).click();
  await editor.getByLabel('Số tiền', { exact: true }).fill(String(options.amount));
  await editor.getByRole('combobox', { name: "Ví thanh toán", exact: true }).selectOption({ label: 'Ví chính' });
  if (options.category) {
    await editor.getByRole('button', { name: 'Chọn danh mục', exact: true }).click();
    await page.getByRole('dialog').last().getByRole('button', { name: new RegExp(options.category) }).click();
  }
  await editor.getByLabel('Ghi chú', { exact: true }).fill(options.description);
  await editor.getByRole('button', { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  return editor;
}

function total(network: NetworkControl) {
  return network.snapshot?.wallets.reduce((sum, wallet) => sum + wallet.balance, 0);
}

test('real TEST writer: wallet, category, money CRUD, exact retry, transfers, budget and goal persist', async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  const observed = await openAs(page, f.writer, true);
  const { network } = observed;
  await expect(page.getByTestId('total-balance')).toContainText('0');
  await expect(page.getByTestId('month-income')).toContainText('0');
  await expect(page.getByTestId('month-expense')).toContainText('0');
  await expect(page.getByRole('button', { name: 'Công ty', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Quản lý ví', exact: true }).click();
  await page.getByRole('button', { name: 'Thêm ví', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'Thêm ví', exact: true });
  await editor.getByLabel('Tên ví', { exact: true }).fill('TEST Ngân hàng');
  await editor.getByRole('combobox', { name: 'Loại ví', exact: true }).selectOption('bank');
  await editor.getByLabel('Số dư ban đầu', { exact: true }).fill('1000000');
  await editor.getByRole('button', { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(editor).toHaveCount(0);
  await closeSheets(page);
  await expect.poll(() => total(network)).toBe(1_000_000);
  await expect(page.getByTestId('month-income')).toContainText('0');
  const bankId = network.snapshot?.wallets.find(wallet => wallet.name === 'TEST Ngân hàng')?.id;
  expect(bankId).toBeTruthy();
  if (!bankId) throw new Error('New server wallet missing');
  await page.getByRole('button', { name: 'Quản lý ví', exact: true }).click();
  await page.getByRole('button', { name: 'Sửa ví TEST Ngân hàng', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Sửa ví', exact: true });
  await editor.getByLabel('Ẩn khỏi tổng quan', { exact: true }).check();
  await editor.getByRole('button', { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(editor).toHaveCount(0);
  await closeSheets(page);
  await expect.poll(() => network.snapshot?.wallets.find(wallet => wallet.id === bankId)?.hidden).toBe(true);
  await expect(page.getByRole('button').filter({ hasText: 'TEST Ngân hàng' })).toHaveCount(0);
  await expect(page.getByTestId('total-balance')).toContainText('1.000.000');

  await manageCategories(page);
  await page.getByRole('button', { name: 'Thêm danh mục', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Thêm danh mục', exact: true });
  await editor.getByLabel('Tên danh mục', { exact: true }).fill('TEST Chi riêng');
  await editor.getByRole('button', { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(editor).toHaveCount(0);
  await closeSheets(page);
  await expect.poll(() => network.snapshot?.categories.some(category => category.name === 'TEST Chi riêng')).toBe(true);

  editor = await addTransaction(page, { type: 'INCOME', amount: 200_000, description: 'TEST Thu thật' });
  await expect(editor).toHaveCount(0);
  await closeSheets(page);
  await expect.poll(() => total(network)).toBe(1_200_000);

  network.loseReceiptFor = 'transaction.create';
  editor = await addTransaction(page, { type: 'EXPENSE', amount: 50_000, description: 'TEST Mất phản hồi', category: 'TEST Chi riêng' });
  await expect(editor.getByRole('alert')).toContainText('Chưa xác nhận');
  await expect(editor.getByLabel('Số tiền', { exact: true })).toBeDisabled();
  expect(network.lostReceipts).toBe(1);
  await editor.getByRole('button', { name: 'Gửi lại y nguyên', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await closeSheets(page);
  const retried = observed.writes.filter(write => (write.payload.data as { description?: string } | undefined)?.description === 'TEST Mất phản hồi');
  expect(retried).toHaveLength(2);
  expect(retried[0]).toEqual(retried[1]);
  await expect.poll(() => network.snapshot?.transactions.filter(transaction => transaction.description === 'TEST Mất phản hồi').length).toBe(1);
  await expect.poll(() => total(network)).toBe(1_150_000);

  // Leave the transient error toast after the intentional lost receipt; hovering pauses its timer.
  await page.mouse.move(5, 5);
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);

  // Row actions follow the visible, accessible record labels in the product.
  await navigate(page, 'Giao dịch');
  await page.getByRole('button', { name: "Xem TEST Mất phản hồi", exact: true }).click();
  editor = page.getByRole('dialog', { name: "Chi tiết giao dịch", exact: true });
  await editor.getByLabel('Số tiền', { exact: true }).fill('60000');
  await editor.getByLabel('Ghi chú', { exact: true }).fill('TEST Đã sửa');
  await editor.getByRole('button', { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => total(network)).toBe(1_140_000);
  await page.getByRole('button', { name: 'Xem TEST Đã sửa', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xóa giao dịch', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Xóa giao dịch', exact: true });
  await editor.getByRole('button', { name: 'Xác nhận xóa', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => total(network)).toBe(1_200_000);

  editor = await addTransaction(page, { type: 'EXPENSE', amount: 75_000, description: 'TEST Chi trong tháng', category: 'TEST Chi riêng' });
  await expect(editor).toHaveCount(0);
  await closeSheets(page);
  await navigate(page, 'Giao dịch');
  await page.getByRole('button', { name: 'Chuyển tiền giữa ví', exact: true }).click();
  editor = page.getByRole('dialog', { name: "Chuyển tiền giữa ví", exact: true });
  await editor.getByRole('combobox', { name: "Ví chuyển", exact: true }).selectOption(bankId);
  await editor.getByRole('combobox', { name: 'Ví nhận', exact: true }).selectOption({ label: 'Ví chính' });
  await editor.getByLabel('Số tiền', { exact: true }).fill('50000');
  await editor.getByRole('button', { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(editor).toHaveCount(0);
  await closeSheets(page);
  await expect.poll(() => total(network)).toBe(1_125_000);
  await expect.poll(() => network.snapshot?.transfers.filter(transfer => !transfer.deleted_at).length).toBe(1);

  await navigate(page, 'Ngân sách');
  await page.getByRole('button', { name: 'Thêm hạn mức', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Thêm hạn mức', exact: true });
  await editor.getByRole('button', { name: 'Chọn danh mục', exact: true }).click();
  await page.getByRole('dialog').last().getByRole('button', { name: /TEST Chi riêng/ }).click();
  await editor.getByLabel('Hạn mức mỗi tháng', { exact: true }).fill('100000');
  await editor.getByRole('button', { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => network.snapshot?.budgets.some(budget => budget.amount === 100_000)).toBe(true);

  await page.getByRole('button', { name: "Mục tiêu tiết kiệm", exact: true }).click();
  await page.getByRole('button', { name: 'Thêm mục tiêu', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Thêm mục tiêu', exact: true });
  await editor.getByLabel('Tên mục tiêu', { exact: true }).fill('TEST Quỹ dự phòng');
  await editor.getByLabel('Số tiền mục tiêu', { exact: true }).fill('500000');
  await editor.getByRole('combobox', { name: 'Ví tích lũy', exact: true }).selectOption(bankId);
  await editor.getByRole('button', { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole('button', { name: 'Góp tiền TEST Quỹ dự phòng', exact: true }).click();
  editor = page.getByRole('dialog', { name: "Chuyển tiền giữa ví", exact: true });
  await editor.getByRole('combobox', { name: "Ví chuyển", exact: true }).selectOption({ label: 'Ví chính' });
  await editor.getByLabel('Số tiền', { exact: true }).fill('100000');
  await editor.getByRole('button', { name: /^(?:Lưu(?: giao dịch| thay đổi)?|Chuyển tiền)$/ }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => network.snapshot?.goals.find(goal => goal.name === 'TEST Quỹ dự phòng')?.saved).toBe(100_000);
  await expect.poll(() => total(network)).toBe(1_125_000);

  await navigate(page, 'Tổng quan');
  await expect(page.getByTestId('month-income')).toContainText('200.000');
  await expect(page.getByTestId('month-expense')).toContainText('75.000');
  await page.getByRole('button', { name: 'Ghi âm', exact: true }).click();
  await expect(page.getByText(/Đang nghe… 0:01/)).toBeVisible();
  await page.getByRole('button', { name: 'Xong', exact: true }).click();
  const draftSheet = page.getByRole('dialog', { name: 'Ghi thu chi', exact: true });
  await expect(draftSheet).toBeVisible();
  await expect.poll(() => network.sttCalls).toBe(1);
  await expect.poll(() => network.aiReads).toBe(1);
  await expect(draftSheet.getByText('AI đang đọc…', { exact: false })).toHaveCount(0);
  await draftSheet.getByRole('combobox', { name: 'Ví cá nhân', exact: true }).click();
  await page.getByRole('option', { name: 'TEST Ngân hàng', exact: true }).click();
  await draftSheet.getByRole('combobox', { name: 'Danh mục dòng 1', exact: true }).click();
  await page.getByRole('option', { name: 'TEST Chi riêng', exact: true }).click();
  await draftSheet.getByRole('button', { name: 'Lưu vào ví', exact: true }).click();
  await expect.poll(() => total(network)).toBe(1_124_000);
  await closeSheets(page);
  await expect(page.getByTestId('month-income')).toContainText('200.000');
  await expect(page.getByTestId('month-expense')).toContainText('76.000');
  await page.screenshot({ path: testInfo.outputPath('real-test-home-390.png'), fullPage: true });
  await navigate(page, 'Báo cáo');
  await page.screenshot({ path: testInfo.outputPath('real-test-report-390.png'), fullPage: true });
  await page.reload();
  await navigate(page, 'Tổng quan');
  await expect(page.getByTestId('total-balance')).toContainText('1.124.000');
  await expect.poll(() => total(network)).toBe(1_124_000);
  expect(observed.blocked).toEqual([]);
  expect(observed.errors).toEqual([]);
});

test('real TEST viewer: own data is visible and write actions are absent', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const observed = await openAs(page, f.viewer, false);
  await expect(page.getByTestId('total-balance')).toContainText('0');
  for (const name of ['Ghi thu chi', 'Thêm ví', 'Thêm danh mục', 'Thêm hạn mức', 'Thêm mục tiêu', 'Chuyển ví']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  for (const name of ['Quản lý ví', 'Quản lý danh mục']) {
    if (name === 'Quản lý danh mục') await manageCategories(page);
    else await page.getByRole('button', { name, exact: true }).click();
    const manager = page.getByRole('dialog', { name, exact: true });
    await expect(manager.getByRole('button', { name: /^(?:Thêm |Sửa |Xóa )/ })).toHaveCount(0);
    await closeSheets(page);
  }
  for (const name of ['Giao dịch', 'Ngân sách', 'Báo cáo']) {
    await navigate(page, name);
    if (name === 'Ngân sách') await page.getByRole('button', { name: "Mục tiêu tiết kiệm", exact: true }).click();
    // “Chuyển ví” in the ledger is a read-only filter, not the entry action.
    await expect(page.getByRole('button', { name: /^(?:Thêm hạn mức|Thêm mục tiêu|Ghi thu chi)$/ })).toHaveCount(0);
  }
  await page.screenshot({ path: testInfo.outputPath('real-test-viewer-report-390.png'), fullPage: true });
  expect(observed.writes).toEqual([]);
  expect(observed.blocked).toEqual([]);
  expect(observed.errors).toEqual([]);
});
