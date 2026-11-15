import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USERS, trackConsoleErrors } from './auth';

/**
 * SỔ TỔNG LỢI NHUẬN CỔ ĐÔNG — Đợt 2 (D2.16): luồng chính trên dev server loopback trỏ project TEST.
 *
 *   0. Công tắc sổ tổng phải đang OFF (LEGACY): trang của chủ hiện thông báo "xem thử", nút Chi khoá.
 *   1. Bật ON tạm trên TEST bằng fixture SQL (`scripts/test-env/thu-sql.mjs --ghi`, danh tính phát hành
 *      GIẢ nhưng đúng định dạng; CAS theo phiên bản đọc trong cùng giao dịch, chỉ khi đang OFF).
 *   2. Chủ thứ hai (tài khoản hệ thống TEST) lập phiếu chi lợi nhuận TRONG số dư cho cổ đông ⇒ phiếu chờ duyệt.
 *   3. Chủ công ty duyệt ở Hộp duyệt — thấy ghi chú sổ tổng (số dư lúc lập / bây giờ, sổ khoá lúc lập).
 *   4. Cổ đông đăng nhập: chỉ thấy tiền CỦA MÌNH (không tên cổ đông khác; % / doanh thu toà chỉ khi máy chủ gửi).
 *   5. Chủ công ty huỷ có lý do từ sổ chi tiết ⇒ số dư sổ tổng về như trước.
 *   afterAll: trả công tắc về OFF (kiểm lại LEGACY) và huỷ bằng API mọi phiếu thử còn sống — phiếu đã huỷ
 *   ở lại TEST làm vết như quy ước TEST.
 *
 * Người duyệt là chủ công ty (chỉ thuộc công ty thật). Hộp duyệt của tài khoản hệ thống (thuộc cả công ty
 * DEMO) đang không nhận ra phiếu sổ tổng khi có phiếu chờ của công ty khác mà nó không đọc được chi tiết —
 * lỗi giao diện đã báo riêng ở D2.16, không đóng vai trò người duyệt ở đây.
 *
 * Chạy (một lượt, cùng dev server loopback như các spec TEST khác):
 *   FLEET_BASE_URL=http://127.0.0.1:5197 FLEET_TARGET_ENV=TEST FLEET_WORKERS=1 \
 *     TEST_SUPABASE_PUBLISHABLE_KEY=… FLEET_PASS_TEST_CHU=… FLEET_PASS_TEST_HETHONG=… \
 *     FLEET_TEST_SHAREHOLDER_EMAIL=… FLEET_PASS_TEST_SHAREHOLDER=… \
 *     npm run with-cred -- npm run e2e:fleet:bien-nhan -- --spec .e2e-fleet/specs/profit-ledger.spec.ts
 * Cổ đông là một cổ đông CÓ trang Báo cáo Lợi Nhuận (reports_finance.profit_distribution); tài khoản của
 * họ chỉ đi qua biến môi trường, không ghi vào repo. Spec ghi TEST (công tắc + phiếu thử) nên không chạy
 * song song với đồng bộ/runner TEST khác.
 */

const APP_ORIGIN = 'http://127.0.0.1:5197';
const TEST_REF = 'hzulujxgonszuleqticb';
const TEST_HOST = `${TEST_REF}.supabase.co`;
const TEST_ORIGIN = `https://${TEST_HOST}`;
const ORGANIZATION_ID = 'aaaa0000-0000-4000-8000-000000000001';
const FEATURE_KEY = 'shareholder_profit.ledger_payout.v1';
const AMOUNT = 1_000;
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const RUN_TAG = randomUUID().slice(0, 8);
const NOTE = `[E2E sổ tổng ${RUN_TAG}] chi thử trên TEST — sẽ huỷ`;

test.use({ viewport: { width: 1440, height: 950 }, serviceWorkers: 'block', trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial' });

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu ${name}; spec không được bỏ qua kiểm chứng TEST.`);
  return value;
}

// ---------------------------------------------------------------- công tắc (fixture SQL trên TEST)

function runTestSql(label: string, sql: string) {
  const script = join(process.cwd(), 'scripts', 'test-env', 'thu-sql.mjs');
  if (!existsSync(script)) throw new Error(`Không thấy ${script} — chạy spec từ gốc repo.`);
  const dir = mkdtempSync(join(tmpdir(), 'e2e-profit-ledger-'));
  try {
    const file = join(dir, `${label}.sql`);
    writeFileSync(file, sql, 'utf8');
    const run = spawnSync(process.execPath, [script, file, '--ghi'], { cwd: process.cwd(), encoding: 'utf8', timeout: 240_000, windowsHide: true });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    if (run.status !== 0 || !/ĐÃ GHI vào TEST/.test(output)) {
      throw new Error(`Fixture ${label} không ghi được vào TEST (exit ${run.status}): ${output.trim().split(/\r?\n/).slice(-6).join(' | ')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;

function routeOnSql(): string {
  const commit = /^[0-9a-f]{40}$/.test(process.env.EXPECTED_SOURCE_SHA ?? '') ? process.env.EXPECTED_SOURCE_SHA! : 'e2e0'.padEnd(40, '0');
  const digest = createHash('sha256').update(`e2e profit-ledger TEST ${RUN_TAG}`).digest('hex');
  return `DO $$
DECLARE v_version bigint; v_mode text;
BEGIN
  SELECT f.config_version, f.mode INTO v_version, v_mode
    FROM app_private.server_feature_flags f WHERE f.feature_key = ${sqlText(FEATURE_KEY)} FOR UPDATE;
  IF v_mode IS DISTINCT FROM 'OFF' THEN
    RAISE EXCEPTION 'E2E profit-ledger: công tắc đang %, không phải OFF — có lượt khác đang thử?', v_mode;
  END IF;
  PERFORM app_private.set_feature_route_v1(${sqlText(FEATURE_KEY)}, v_version, 'ON', NULL, NULL, NULL, NULL, NULL,
    ${sqlText(commit)}, ${sqlText(digest)}, ${sqlText(`TEST-E2E-profit-ledger-${RUN_TAG}`)},
    ${sqlText('TEST-E2E profit-ledger (không phải phát hành)')}, NULL, ${sqlText(`E2E profit-ledger ${RUN_TAG}: bật ON tạm trên TEST`)});
END $$;`;
}

function routeOffSql(): string {
  return `DO $$
DECLARE v_version bigint; v_mode text;
BEGIN
  SELECT f.config_version, f.mode INTO v_version, v_mode
    FROM app_private.server_feature_flags f WHERE f.feature_key = ${sqlText(FEATURE_KEY)} FOR UPDATE;
  IF v_mode IS DISTINCT FROM 'OFF' THEN
    PERFORM app_private.set_feature_route_v1(${sqlText(FEATURE_KEY)}, v_version, 'OFF', NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, ${sqlText(`E2E profit-ledger ${RUN_TAG}: trả về OFF`)});
  END IF;
  IF app_private.evaluate_feature_route(${sqlText(FEATURE_KEY)}, ${sqlText(ORGANIZATION_ID)}::uuid) <> 'LEGACY' THEN
    RAISE EXCEPTION 'E2E profit-ledger: công tắc chưa về LEGACY';
  END IF;
END $$;`;
}

// ---------------------------------------------------------------- API TEST (JWT thật, chỉ host TEST)

interface LedgerRow {
  shareholder_id: string;
  name: string;
  payouts_approved: number;
  payouts_pending: number;
  balance: number;
}

async function passwordGrant(email: string, password: string): Promise<string> {
  const response = await fetch(`${TEST_ORIGIN}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: requiredEnvironment('TEST_SUPABASE_PUBLISHABLE_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  });
  if (response.status !== 200) throw new Error(`Đăng nhập API trên TEST thất bại (HTTP ${response.status}).`);
  const session = await response.json() as { access_token?: unknown };
  if (typeof session.access_token !== 'string') throw new Error('Phiên TEST thiếu access_token.');
  return session.access_token;
}

async function rpc<T>(jwt: string, fn: string, body: Record<string, unknown>): Promise<{ status: number; data: T }> {
  const response = await fetch(`${TEST_ORIGIN}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: requiredEnvironment('TEST_SUPABASE_PUBLISHABLE_KEY'), Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json', 'Content-Profile': 'public', 'Accept-Profile': 'public',
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data: data as T };
}

/**
 * Hàm ĐỌC (E1/E3/E7) đọc lại khi TEST (gói Free) trả 502/503/504 tạm thời — đo 16/11/2026: E1 trả 503 ngay
 * sau fixture trả công tắc về OFF rồi lần sau 200. Chỉ dùng cho hàm đọc; hàm ghi không tự gửi lại ở đây.
 */
async function readRpc<T>(jwt: string, fn: string, body: Record<string, unknown>): Promise<{ status: number; data: T }> {
  let result = await rpc<T>(jwt, fn, body);
  for (const waitMs of [2_000, 5_000, 10_000]) {
    if (![502, 503, 504].includes(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    result = await rpc<T>(jwt, fn, body);
  }
  return result;
}

async function ownerLedger(jwt: string): Promise<{ route: string; shareholders: LedgerRow[] }> {
  const result = await readRpc<{ route: string; shareholders: LedgerRow[] }>(jwt, 'shareholder_profit_ledger_v1', { p_organization_id: ORGANIZATION_ID });
  expect(result.status, 'E1 sổ tổng của chủ').toBe(200);
  return result.data;
}

function rowOf(ledger: { shareholders: LedgerRow[] }, shareholderId: string): LedgerRow {
  const row = ledger.shareholders.find((r) => r.shareholder_id === shareholderId);
  if (!row) throw new Error('Không thấy dòng cổ đông thử trong sổ tổng E1.');
  const money = (value: unknown, field: string) => {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
    if (!Number.isFinite(n)) throw new Error(`E1 trả ${field} không phải số.`);
    return n;
  };
  return {
    shareholder_id: row.shareholder_id,
    name: String(row.name ?? ''),
    payouts_approved: money(row.payouts_approved, 'payouts_approved'),
    payouts_pending: money(row.payouts_pending, 'payouts_pending'),
    balance: money(row.balance, 'balance'),
  };
}

// ---------------------------------------------------------------- trình duyệt (chỉ cho đi loopback + TEST)

interface Session { context: BrowserContext; page: Page; consoleErrors: string[]; unexpected: string[] }

async function openSession(browser: Browser, email: string, password: string): Promise<Session> {
  const context = await browser.newContext({ baseURL: APP_ORIGIN, viewport: { width: 1440, height: 950 }, serviceWorkers: 'block' });
  const unexpected: string[] = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const allowed = url.origin === APP_ORIGIN || url.origin === TEST_ORIGIN || (url.protocol === 'https:' && FONT_HOSTS.has(url.hostname));
    if (allowed) { await route.continue(); return; }
    unexpected.push(`${route.request().method()} ${url.origin}`);
    await route.abort('blockedbyclient');
  });
  await context.routeWebSocket(/.*/, (socket) => {
    const url = new URL(socket.url());
    if (url.host === '127.0.0.1:5197' || url.hostname === TEST_HOST) { socket.connectToServer(); return; }
    unexpected.push(`ws ${url.origin}`);
    socket.close();
  });
  const page = await context.newPage();
  const consoleErrors = trackConsoleErrors(page);
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Tài Khoản' }).fill(email);
  await page.getByRole('textbox', { name: 'Mật khẩu' }).fill(password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
  return { context, page, consoleErrors, unexpected };
}

async function closeSession(session: Session | null) {
  if (!session) return;
  expect(session.unexpected, 'không request nào ra ngoài loopback/TEST').toEqual([]);
  expect(session.consoleErrors, 'không lỗi console của app').toEqual([]);
  await session.context.close();
}

async function openOwnerOverview(page: Page) {
  await page.goto('/reports/finance/profit-distribution?tab=overview');
  await expect(page.getByTestId('shareholder-ledger-card')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('shareholder-ledger-table')).toBeVisible({ timeout: 90_000 });
}

// ---------------------------------------------------------------- trạng thái dùng chung cho afterAll

const created = new Map<string, string>(); // voucher_id → mã phiếu
let routeTouched = false;
let ownerJwtForCleanup: string | null = null;

test.afterAll(async () => {
  test.setTimeout(300_000);
  const problems: string[] = [];
  if (ownerJwtForCleanup) {
    for (const [voucherId] of created) {
      const detail = await readRpc<{ voucher?: { approval_status?: string; posting_status?: string | null } }>(ownerJwtForCleanup, 'profit_ledger_payout_detail_v1', { p_voucher_id: voucherId });
      const status = detail.data?.voucher?.approval_status;
      if (detail.status !== 200 || !status) { problems.push(`không đọc được phiếu thử ${voucherId}`); continue; }
      if (status === 'CANCELLED') continue;
      const expectedState = status === 'UNAPPROVED' ? 'PENDING' : detail.data.voucher?.posting_status === 'POSTED' ? 'POSTED' : 'APPROVED_UNPOSTED';
      const cancel = await rpc(ownerJwtForCleanup, 'profit_ledger_payout_cancel_v1', {
        p_voucher_id: voucherId, p_reason: `E2E profit-ledger ${RUN_TAG}: dọn phiếu thử`, p_idempotency_key: randomUUID(), p_expected_state: expectedState,
      });
      if (cancel.status !== 200) problems.push(`không huỷ được phiếu thử ${voucherId} (HTTP ${cancel.status})`);
    }
  }
  if (routeTouched) {
    try { runTestSql('route-off', routeOffSql()); } catch (error) { problems.push(String((error as Error).message)); }
    if (ownerJwtForCleanup) {
      const ledger = await ownerLedger(ownerJwtForCleanup);
      if (ledger.route !== 'LEGACY') problems.push(`sổ tổng chưa về LEGACY (đang ${ledger.route})`);
    }
  }
  expect(problems, 'dọn TEST sau spec sổ tổng').toEqual([]);
});

test('sổ tổng lợi nhuận: chủ lập → chủ khác duyệt → cổ đông chỉ thấy tiền mình → huỷ có lý do', async ({ browser }) => {
  test.setTimeout(900_000);
  expect(requiredEnvironment('FLEET_BASE_URL'), 'chỉ chạy tại dev server loopback trỏ TEST').toBe(APP_ORIGIN);
  const ownerPassword = requiredEnvironment('FLEET_PASS_TEST_CHU');
  const makerPassword = requiredEnvironment('FLEET_PASS_TEST_HETHONG');
  const shareholderEmail = requiredEnvironment('FLEET_TEST_SHAREHOLDER_EMAIL');
  const shareholderPassword = requiredEnvironment('FLEET_PASS_TEST_SHAREHOLDER');
  expect(new Set([USERS.testchu, USERS.testhethong, shareholderEmail]).size, 'ba vai phải là ba tài khoản khác nhau').toBe(3);

  const ownerJwt = await passwordGrant(USERS.testchu, ownerPassword);
  ownerJwtForCleanup = ownerJwt;
  const shareholderJwt = await passwordGrant(shareholderEmail, shareholderPassword);
  const mine = await readRpc<{ shareholder?: { id?: string; name?: string } }>(shareholderJwt, 'shareholder_profit_my_ledger_v1', { p_organization_id: ORGANIZATION_ID });
  expect(mine.status, 'cổ đông thử phải xem được phần lợi nhuận của mình (E3)').toBe(200);
  const shareholderId = mine.data.shareholder?.id;
  expect(shareholderId, 'E3 trả mã cổ đông').toMatch(/^[0-9a-f-]{36}$/);

  const before = await ownerLedger(ownerJwt);
  expect(before.route, 'TEST phải đang ở LEGACY trước khi spec bật sổ tổng').toBe('LEGACY');
  const rowBefore = rowOf(before, shareholderId!);
  expect(rowBefore.balance, 'cổ đông thử còn số dư để chi trong số dư').toBeGreaterThanOrEqual(AMOUNT);
  const otherNames = before.shareholders.filter((r) => r.shareholder_id !== shareholderId).map((r) => r.name).filter((n) => n.trim().length >= 2);

  let owner: Session | null = null;
  let maker: Session | null = null;
  let holder: Session | null = null;
  try {
    // 0. LEGACY: thông báo "xem thử", nút Chi khoá.
    owner = await openSession(browser, USERS.testchu, ownerPassword);
    await test.step('LEGACY: sổ tổng chỉ xem thử, chưa chi được', async () => {
      await openOwnerOverview(owner!.page);
      await expect(owner!.page.getByTestId('profit-ledger-route-banner')).toContainText('xem thử');
      await expect(owner!.page.getByRole('button', { name: '＋ Chi lợi nhuận' })).toBeDisabled();
      await expect(owner!.page.getByTestId(`ledger-row-${shareholderId}`).getByRole('button', { name: 'Chi', exact: true })).toBeDisabled();
    });

    // 1. Bật ON tạm.
    routeTouched = true;
    runTestSql('route-on', routeOnSql());
    expect((await ownerLedger(ownerJwt)).route, 'sau fixture: CANONICAL').toBe('CANONICAL');

    // 2. Chủ thứ hai lập phiếu chi trong số dư.
    maker = await openSession(browser, USERS.testhethong, makerPassword);
    let voucherId = '';
    let code = '';
    await test.step('chủ thứ hai lập phiếu chi trong số dư', async () => {
      const page = maker!.page;
      await openOwnerOverview(page);
      await expect(page.getByTestId('profit-ledger-route-banner')).toHaveCount(0);
      await page.getByTestId(`ledger-row-${shareholderId}`).getByRole('button', { name: 'Chi', exact: true }).click();
      // Danh sách sổ quỹ (popover) cũng mang role=dialog ⇒ chọn đúng hộp theo tên.
      const dialog = page.getByRole('dialog', { name: 'Chi lợi nhuận cổ đông' });
      await expect(dialog).toContainText('Còn phải trả', { timeout: 60_000 });
      await dialog.getByRole('combobox').nth(1).click();
      await page.getByRole('option').first().click();
      await dialog.locator('input[name=amount]').fill(String(AMOUNT));
      await dialog.locator('textarea[name=note]').fill(NOTE);
      await expect(dialog).toContainText('tạm ứng 0 đ', { timeout: 60_000 });
      const response = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/shareholder_profit_ledger_payout_v1'), { timeout: 90_000 });
      await dialog.getByRole('button', { name: 'Lập phiếu chờ duyệt' }).click();
      const body = await (await response).json() as { voucher_id?: string; state?: string; within_amount?: number; advance_amount?: number };
      expect(body.state).toBe('PENDING_APPROVAL');
      expect(body.within_amount).toBe(AMOUNT);
      expect(body.advance_amount).toBe(0);
      voucherId = String(body.voucher_id);
      created.set(voucherId, '');
      const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Đã lập phiếu' }).first();
      await expect(toast).toContainText('chờ duyệt, chưa chi tiền', { timeout: 30_000 });
      code = ((await toast.innerText()).match(/PC\d+/) ?? [''])[0];
      expect(code, 'mã phiếu trong thông báo').toMatch(/^PC\d+$/);
      created.set(voucherId, code);
      const after = rowOf(await ownerLedger(ownerJwt), shareholderId!);
      expect(after.payouts_pending).toBe(rowBefore.payouts_pending + AMOUNT);
      expect(after.balance).toBe(rowBefore.balance - AMOUNT);
    });

    // 3. Chủ công ty duyệt ở Hộp duyệt, thấy ghi chú sổ tổng.
    await test.step('chủ công ty duyệt ở Hộp duyệt', async () => {
      const page = owner!.page;
      await page.goto('/approvals');
      const row = page.locator('tbody tr').filter({ hasText: code }).first();
      await expect(row).toBeVisible({ timeout: 90_000 });
      const note = row.locator('xpath=following-sibling::tr[1]');
      await expect(note).toContainText('Chi lợi nhuận cổ đông', { timeout: 60_000 });
      await expect(note).toContainText('Lúc lập');
      await expect(note).toContainText('Chỉ chi được từ sổ đã chọn lúc lập');
      const approve = row.getByRole('button', { name: 'Duyệt', exact: true });
      await expect(approve).toBeEnabled({ timeout: 60_000 });
      const response = page.waitForResponse((r) => /\/rest\/v1\/rpc\/(approve_income_expense_v2|decide_financial_request_v2)$/.test(new URL(r.url()).pathname), { timeout: 90_000 });
      await approve.click();
      expect((await response).status()).toBe(200);
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Đã duyệt phiếu' }).first()).toBeVisible({ timeout: 30_000 });
      const after = rowOf(await ownerLedger(ownerJwt), shareholderId!);
      expect(after.payouts_approved).toBe(rowBefore.payouts_approved + AMOUNT);
      expect(after.payouts_pending).toBe(rowBefore.payouts_pending);
    });

    // 4. Cổ đông chỉ thấy tiền của mình.
    holder = await openSession(browser, shareholderEmail, shareholderPassword);
    await test.step('cổ đông chỉ thấy tiền của mình', async () => {
      const page = holder!.page;
      const e3 = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/shareholder_profit_my_ledger_v1'), { timeout: 90_000 });
      await page.goto('/reports/finance/profit-distribution?tab=my-overview');
      const payload = await (await e3).json() as { route?: string; ready?: boolean; payouts?: Array<{ voucher_id?: string }>; percent_rows?: unknown; building_totals?: unknown };
      expect(payload.route).toBe('CANONICAL');
      expect(payload.ready).toBe(true);
      expect((payload.payouts ?? []).some((p) => p.voucher_id === voucherId), 'E3 có phiếu vừa duyệt của chính mình').toBe(true);
      await expect(page.getByTestId('self-kpi-balance')).toBeVisible({ timeout: 90_000 });
      await expect(page.getByText(code, { exact: true })).toBeVisible({ timeout: 60_000 });
      const main = await page.locator('main').innerText();
      for (const name of otherNames) {
        expect(new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'u').test(main), 'không thấy tên cổ đông khác').toBe(false);
      }
      if (!('percent_rows' in payload)) await expect(page.getByTestId('self-percent-card')).toHaveCount(0);
      if (!('building_totals' in payload)) await expect(page.getByTestId('self-building-totals-card')).toHaveCount(0);
    });

    // 5. Chủ công ty huỷ có lý do từ sổ chi tiết ⇒ số dư về như cũ.
    await test.step('chủ công ty huỷ có lý do, số dư sổ tổng về như cũ', async () => {
      const page = owner!.page;
      await openOwnerOverview(page);
      await page.getByTestId(`ledger-row-${shareholderId}`).getByRole('button', { name: 'Sổ', exact: true }).click();
      const entry = page.getByTestId(`ledger-entry-PAYOUT:${voucherId}`);
      await expect(entry).toBeVisible({ timeout: 90_000 });
      await entry.getByRole('button', { name: 'Huỷ', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Huỷ phiếu chi lợi nhuận' });
      await expect(dialog).toContainText('đã duyệt nhưng chưa chi tiền', { timeout: 30_000 });
      await dialog.locator('textarea').fill(`E2E sổ tổng ${RUN_TAG}: huỷ phiếu thử sau khi duyệt`);
      const response = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/profit_ledger_payout_cancel_v1'), { timeout: 90_000 });
      await dialog.getByRole('button', { name: 'Huỷ phiếu' }).click();
      const body = await (await response).json() as { changed?: boolean; cancellation_kind?: string };
      expect(body.changed).toBe(true);
      expect(body.cancellation_kind).toBe('CANCELLED_UNPOSTED');
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: `Đã huỷ phiếu ${code}` }).first()).toBeVisible({ timeout: 30_000 });
      const after = rowOf(await ownerLedger(ownerJwt), shareholderId!);
      expect(after.balance).toBe(rowBefore.balance);
      expect(after.payouts_approved).toBe(rowBefore.payouts_approved);
      expect(after.payouts_pending).toBe(rowBefore.payouts_pending);
    });
  } finally {
    await closeSession(holder);
    await closeSession(maker);
    await closeSession(owner);
  }
});
