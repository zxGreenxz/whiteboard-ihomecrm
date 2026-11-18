import { test, expect, type Browser, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USERS, trackConsoleErrors } from './auth';

/**
 * SỔ TỔNG LỢI NHUẬN CỔ ĐÔNG — tạm ứng cộng dồn + chủ chốt chi lợi nhuận theo tháng (migration 20261118041911).
 * Luồng chính trên dev server loopback trỏ project TEST:
 *
 *   0. Công tắc sổ tổng phải đang OFF (LEGACY): trang của chủ hiện thông báo "xem thử", nút Chi khoá.
 *   1. Bật ON tạm trên TEST bằng fixture SQL (`scripts/test-env/thu-sql.mjs --ghi`, danh tính phát hành
 *      GIẢ nhưng đúng định dạng; CAS theo phiên bản đọc trong cùng giao dịch, chỉ khi đang OFF).
 *   2. Cổ đông (có quyền tạm ứng, đang giữ một sổ quỹ) tự lập phiếu TẠM ỨNG ở hộp "Chi tạm ứng cho tôi":
 *      không ô tick xác nhận, ghi chú không bắt buộc ⇒ phiếu chờ duyệt, "tạm ứng chờ duyệt" tăng đúng số đó.
 *   3. Chủ công ty duyệt phiếu tạm ứng ở Hộp duyệt ⇒ "Tạm ứng đang có" tăng, "Lợi nhuận chưa chi" không đổi.
 *   4. Chủ thứ hai (tài khoản hệ thống TEST) mở hộp chốt "Chi lợi nhuận cổ đông": KHÔNG có ô nhập số tiền; ba
 *      dòng máy tính khớp xem trước của máy chủ, phần khấu trừ đã gồm khoản tạm ứng vừa duyệt ⇒ lập phiếu chi
 *      chờ duyệt cho phần còn lại.
 *   5. Chủ công ty duyệt phiếu tiền của lần chốt.
 *   6. Cổ đông đăng nhập: thấy HAI con số và lần chốt của CHÍNH MÌNH, không thấy tên cổ đông khác.
 *   7. Chủ công ty huỷ có lý do phiếu tiền của lần chốt (lần chốt tự hết hiệu lực) rồi huỷ phiếu tạm ứng ⇒
 *      hai con số về như trước.
 *   afterAll: huỷ bằng API mọi phiếu thử còn sống (phiếu tiền của lần chốt TRƯỚC, phiếu tạm ứng SAU) và trả
 *   công tắc về OFF (kiểm lại LEGACY) — phiếu đã huỷ ở lại TEST làm vết như quy ước TEST.
 *
 * Người duyệt là chủ công ty (chỉ thuộc công ty thật): khác người lập và khác người nhận ở cả hai phiếu.
 *
 * Điều kiện dữ liệu trên TEST (spec KIỂM và báo rõ, không tự bỏ qua bước nào):
 *   - cổ đông thử có trang Báo cáo Lợi Nhuận, có quyền "Được tạm ứng lợi nhuận" và đang GIỮ ít nhất một sổ quỹ
 *     tiền thật (máy chủ trả `can_create` + chính mình trong danh sách người nhận);
 *   - cổ đông thử còn lợi nhuận chưa chi: thực chi của lần chốt mặc định phải lớn hơn số tạm ứng thử, và
 *     không có phiếu lương đang chờ chủ xem lại.
 *
 * Chạy (một lượt, cùng dev server loopback như các spec TEST khác):
 *   FLEET_BASE_URL=http://127.0.0.1:5197 FLEET_TARGET_ENV=TEST FLEET_WORKERS=1 \
 *     TEST_SUPABASE_PUBLISHABLE_KEY=… FLEET_PASS_TEST_CHU=… FLEET_PASS_TEST_HETHONG=… \
 *     FLEET_TEST_SHAREHOLDER_EMAIL=… FLEET_PASS_TEST_SHAREHOLDER=… \
 *     npm run with-cred -- npm run e2e:fleet:bien-nhan -- --spec .e2e-fleet/specs/profit-ledger.spec.ts
 * Tài khoản cổ đông chỉ đi qua biến môi trường, không ghi vào repo. Spec ghi TEST (công tắc + phiếu thử) nên
 * không chạy song song với đồng bộ/runner TEST khác.
 */

const APP_ORIGIN = 'http://127.0.0.1:5197';
const TEST_REF = 'hzulujxgonszuleqticb';
const TEST_HOST = `${TEST_REF}.supabase.co`;
const TEST_ORIGIN = `https://${TEST_HOST}`;
const ORGANIZATION_ID = 'aaaa0000-0000-4000-8000-000000000001';
const FEATURE_KEY = 'shareholder_profit.ledger_payout.v1';
/** Số tiền của phiếu TẠM ỨNG thử. Lần chốt không có số nhập tay: máy chủ tính. */
const AMOUNT = 1_000;
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const RUN_TAG = randomUUID().slice(0, 8);
const ADVANCE_NOTE = `[E2E sổ tổng ${RUN_TAG}] tạm ứng thử trên TEST — sẽ huỷ`;
const SETTLE_NOTE = `[E2E sổ tổng ${RUN_TAG}] chốt chi thử trên TEST — sẽ huỷ`;

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

/** Mọi RPC gọi bằng POST — ba hàm đọc của vị thế / tạm ứng là VOLATILE, gọi GET là máy chủ trả 25006. */
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
 * Hàm ĐỌC đọc lại khi TEST (gói Free) trả 502/503/504 tạm thời — đo 16/11/2026: E1 trả 503 ngay sau fixture
 * trả công tắc về OFF rồi lần sau 200. Chỉ dùng cho hàm đọc; hàm ghi không tự gửi lại ở đây.
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

function money(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) throw new Error(`Máy chủ trả ${field} không phải số.`);
  return n;
}

/** So hai số tiền (2 số lẻ): phép cộng trừ số thực không làm lệch kết quả. */
function sameMoney(actual: number | null, expected: number, message: string) {
  expect(actual, `${message} — máy chủ phải trả số`).not.toBeNull();
  expect(actual ?? Number.NaN, message).toBeCloseTo(expected, 2);
}

async function ownerLedgerRoute(jwt: string): Promise<{ route: string; names: Array<{ shareholder_id: string; name: string }> }> {
  const result = await readRpc<{ route: string; shareholders: Array<{ shareholder_id: string; name: string }> }>(jwt, 'shareholder_profit_ledger_v1', { p_organization_id: ORGANIZATION_ID });
  expect(result.status, 'E1 sổ tổng của chủ').toBe(200);
  return { route: result.data.route, names: result.data.shareholders.map((r) => ({ shareholder_id: r.shareholder_id, name: String(r.name ?? '') })) };
}

/** Hai con số của một cổ đông theo vị thế R1 (cùng nguồn với màn của chủ). */
interface Position {
  unpaid: number;
  advance: number;
  advancePending: number;
  cashPending: number;
  balance: number;
  /** Phần tạm ứng đã bị khấu trừ / trừ qua lương NHIỀU hơn tạm ứng đã duyệt (máy chủ gấp vào lợi nhuận chưa chi). */
  overoffset: number;
}

async function positionOf(jwt: string, shareholderId: string): Promise<Position> {
  const result = await readRpc<{ shareholders?: Array<Record<string, unknown>> }>(jwt, 'shareholder_profit_positions_v1', { p_organization_id: ORGANIZATION_ID });
  expect(result.status, 'R1 vị thế cổ đông của chủ').toBe(200);
  const row = (result.data.shareholders ?? []).find((r) => r.shareholder_id === shareholderId);
  if (!row) throw new Error('Không thấy cổ đông thử trong vị thế R1.');
  const position: Position = {
    unpaid: money(row.unpaid_profit, 'unpaid_profit'),
    advance: money(row.advance_outstanding, 'advance_outstanding'),
    advancePending: money(row.advance_pending, 'advance_pending'),
    cashPending: money(row.settlement_cash_pending, 'settlement_cash_pending'),
    balance: money(row.balance, 'balance'),
    overoffset: money((row.components as Record<string, unknown> | undefined)?.advance_overoffset, 'components.advance_overoffset'),
  };
  // Bất biến của máy chủ trên số trả ra.
  expect(position.unpaid - position.advance - position.advancePending, 'lợi nhuận chưa chi − tạm ứng đang có − tạm ứng chờ duyệt = số dư ròng').toBeCloseTo(position.balance, 2);
  expect(position.advance, 'tạm ứng đang có không bao giờ âm').toBeGreaterThanOrEqual(0);
  return position;
}

interface SettlePreview {
  through: string | null;
  recognized: number | null;
  offset: number | null;
  cash: number | null;
  advancePending: number;
  blockedReason: string | null;
  markerMonth: string | null;
  settlements: Array<{ id: string; cash_voucher_id: string | null }>;
}

/** Xem trước chốt R5 — không truyền tháng (máy chủ chọn tháng đủ điều kiện mới nhất), không truyền sổ. */
async function settlePreviewOf(jwt: string, shareholderId: string): Promise<SettlePreview> {
  const result = await readRpc<Record<string, unknown>>(jwt, 'shareholder_profit_settlement_preview_v1', {
    p_shareholder_id: shareholderId, p_through_month: null, p_account_id: null,
  });
  expect(result.status, 'R5 xem trước chốt').toBe(200);
  const data = result.data;
  const optional = (value: unknown, field: string) => (value === null || value === undefined ? null : money(value, field));
  const position = (data.position ?? {}) as Record<string, unknown>;
  const settlements = Array.isArray(data.settlements) ? data.settlements as Array<Record<string, unknown>> : [];
  return {
    through: typeof data.through_month === 'string' ? data.through_month : null,
    recognized: optional(data.recognized_amount, 'recognized_amount'),
    offset: optional(data.advance_offset_amount, 'advance_offset_amount'),
    cash: optional(data.cash_amount, 'cash_amount'),
    advancePending: money(data.advance_pending, 'advance_pending'),
    blockedReason: typeof data.blocked_reason === 'string' ? data.blocked_reason : null,
    markerMonth: typeof position.marker_month === 'string' ? position.marker_month : null,
    settlements: settlements.map((row) => ({ id: String(row.id), cash_voucher_id: typeof row.cash_voucher_id === 'string' ? row.cash_voucher_id : null })),
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

const isRpc = (response: Response, fn: string) => new URL(response.url()).pathname === `/rest/v1/rpc/${fn}`;

function requestBody(response: Response): Record<string, unknown> {
  const body: unknown = response.request().postDataJSON();
  return body && typeof body === 'object' ? body as Record<string, unknown> : {};
}

/**
 * Số tiền như màn hình in ("1.500.000 đ" ở hộp, "1.500.000 ₫" ở bảng): so phần số, có chặn hai đầu để
 * "1.500.000" không khớp nhầm "11.500.000".
 */
function amountText(amount: number): RegExp {
  const digits = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(amount).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\d.])${digits}(?![\\d.])`);
}

/** Chọn dòng đầu của ô chọn sổ quỹ (danh sách thả cũng mang role=dialog ⇒ chọn theo chữ gợi ý của ô). */
async function pickFirstCashbook(page: Page, dialog: Locator) {
  await dialog.getByRole('combobox').filter({ hasText: 'Chọn sổ quỹ' }).click();
  await page.getByRole('option').first().click();
}

/** Chủ công ty duyệt một phiếu ở Hộp duyệt sau khi đọc ghi chú sổ tổng của phiếu đó. */
async function approveAtInbox(page: Page, code: string, noteTexts: readonly string[]) {
  await page.goto('/approvals');
  const row = page.locator('tbody tr').filter({ hasText: code }).first();
  await expect(row).toBeVisible({ timeout: 90_000 });
  const note = row.locator('xpath=following-sibling::tr[1]');
  for (const text of noteTexts) await expect(note).toContainText(text, { timeout: 60_000 });
  const approve = row.getByRole('button', { name: 'Duyệt', exact: true });
  await expect(approve).toBeEnabled({ timeout: 60_000 });
  const response = page.waitForResponse((r) => /\/rest\/v1\/rpc\/(approve_income_expense_v2|decide_financial_request_v2)$/.test(new URL(r.url()).pathname), { timeout: 90_000 });
  await approve.click();
  expect((await response).status()).toBe(200);
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Đã duyệt phiếu' }).first()).toBeVisible({ timeout: 30_000 });
}

/** Hộp huỷ dùng chung: phiếu đã duyệt, chưa chi tiền ⇒ huỷ có lý do, không có bút toán đảo. */
async function cancelApprovedVoucher(page: Page, code: string, reason: string) {
  const dialog = page.getByRole('dialog', { name: 'Huỷ phiếu chi lợi nhuận' });
  await expect(dialog).toContainText('đã duyệt nhưng chưa chi tiền', { timeout: 30_000 });
  await dialog.locator('textarea').fill(reason);
  const response = page.waitForResponse((r) => isRpc(r, 'profit_ledger_payout_cancel_v1'), { timeout: 90_000 });
  await dialog.getByRole('button', { name: 'Huỷ phiếu' }).click();
  const body = await (await response).json() as { changed?: boolean; cancellation_kind?: string };
  expect(body.changed).toBe(true);
  expect(body.cancellation_kind).toBe('CANCELLED_UNPOSTED');
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: `Đã huỷ phiếu ${code}` }).first()).toBeVisible({ timeout: 30_000 });
}

// ---------------------------------------------------------------- trạng thái dùng chung cho afterAll

/** Phiếu thử theo THỨ TỰ lập: phiếu tạm ứng trước, phiếu tiền của lần chốt sau. */
const created: string[] = [];
let routeTouched = false;
let ownerJwtForCleanup: string | null = null;

test.afterAll(async () => {
  test.setTimeout(300_000);
  const problems: string[] = [];
  if (ownerJwtForCleanup) {
    // Huỷ NGƯỢC thứ tự lập: phiếu tiền của lần chốt trước (lần chốt tự hết hiệu lực, phần khấu trừ được nhả),
    // rồi mới tới phiếu tạm ứng mà lần chốt đó đã khấu trừ.
    for (const voucherId of [...created].reverse()) {
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
      const ledger = await ownerLedgerRoute(ownerJwtForCleanup);
      if (ledger.route !== 'LEGACY') problems.push(`sổ tổng chưa về LEGACY (đang ${ledger.route})`);
    }
  }
  expect(problems, 'dọn TEST sau spec sổ tổng').toEqual([]);
});

test('sổ tổng lợi nhuận: cổ đông tạm ứng → chủ duyệt → chủ chốt chi theo tháng (khấu trừ tạm ứng) → duyệt → cổ đông tự xem → huỷ có lý do', async ({ browser }) => {
  test.setTimeout(1_200_000);
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
  const shareholderId = mine.data.shareholder?.id ?? '';
  expect(shareholderId, 'E3 trả mã cổ đông').toMatch(/^[0-9a-f-]{36}$/);

  const before = await ownerLedgerRoute(ownerJwt);
  expect(before.route, 'TEST phải đang ở LEGACY trước khi spec bật sổ tổng').toBe('LEGACY');
  const otherNames = before.names.filter((r) => r.shareholder_id !== shareholderId).map((r) => r.name).filter((n) => n.trim().length >= 2);

  let owner: Session | null = null;
  let maker: Session | null = null;
  let holder: Session | null = null;
  try {
    // 0. LEGACY: thông báo "xem thử", nút Chi khoá.
    owner = await openSession(browser, USERS.testchu, ownerPassword);
    await test.step('LEGACY: sổ tổng chỉ xem thử, chưa chốt chi được', async () => {
      await openOwnerOverview(owner!.page);
      await expect(owner!.page.getByTestId('profit-ledger-route-banner')).toContainText('xem thử');
      await expect(owner!.page.getByRole('button', { name: '＋ Chi lợi nhuận' })).toBeDisabled();
      await expect(owner!.page.getByTestId(`ledger-row-${shareholderId}`).getByRole('button', { name: 'Chi', exact: true })).toBeDisabled();
    });

    // 1. Bật ON tạm.
    routeTouched = true;
    runTestSql('route-on', routeOnSql());
    expect((await ownerLedgerRoute(ownerJwt)).route, 'sau fixture: CANONICAL').toBe('CANONICAL');

    // Điều kiện dữ liệu của TEST — đọc khi sổ tổng đã chạy thật, TRƯỚC mọi lệnh ghi của spec.
    const options = await readRpc<{ can_create?: boolean; accounts?: unknown[]; payees?: Array<{ shareholder_id?: string; is_self?: boolean }> }>(
      shareholderJwt, 'shareholder_profit_advance_options_v1', { p_organization_id: ORGANIZATION_ID });
    expect(options.status, 'R3 danh sách lập phiếu tạm ứng của cổ đông thử').toBe(200);
    expect(options.data.can_create === true && (options.data.accounts ?? []).length > 0
      && (options.data.payees ?? []).some((p) => p.shareholder_id === shareholderId && p.is_self === true),
    'cổ đông thử phải có quyền "Được tạm ứng lợi nhuận" và đang giữ một sổ quỹ tiền thật trên TEST').toBe(true);
    const position0 = await positionOf(ownerJwt, shareholderId);
    expect(position0.overoffset, 'cổ đông thử không ở trạng thái tạm ứng đã bị khấu trừ vượt (số thử mới cộng trừ thẳng được)').toBe(0);
    const preview0 = await settlePreviewOf(ownerJwt, shareholderId);
    expect(preview0.through, 'cổ đông thử phải có tháng chốt chi được').not.toBeNull();
    expect([null, 'ACCOUNT_REQUIRED'], 'lần chốt mặc định không bị khoá (không phiếu lương chờ xem lại)').toContain(preview0.blockedReason);
    expect(preview0.cash ?? 0, 'thực chi của lần chốt mặc định phải lớn hơn số tạm ứng thử').toBeGreaterThan(AMOUNT);

    // 2. Cổ đông tự lập phiếu tạm ứng.
    holder = await openSession(browser, shareholderEmail, shareholderPassword);
    let advanceVoucherId = '';
    let advanceCode = '';
    await test.step('cổ đông tự lập phiếu tạm ứng: không ô tick, không bắt lý do', async () => {
      const page = holder!.page;
      await page.goto('/reports/finance/profit-distribution?tab=my-overview');
      await expect(page.getByTestId('self-kpi-unpaid')).toBeVisible({ timeout: 90_000 });
      await expect(page.getByTestId('self-kpi-advance')).toBeVisible();
      await page.getByRole('button', { name: 'Chi tạm ứng cho tôi' }).click();
      const dialog = page.getByRole('dialog', { name: 'Chi tạm ứng lợi nhuận cho tôi' });
      await expect(dialog.getByTestId('profit-advance-position')).toBeVisible({ timeout: 60_000 });
      await expect(dialog.getByRole('checkbox')).toHaveCount(0);
      await dialog.locator('input[name=amount]').fill(String(AMOUNT));
      await dialog.locator('textarea[name=note]').fill(ADVANCE_NOTE);
      const checked = page.waitForResponse((r) => {
        if (!isRpc(r, 'shareholder_profit_advance_preview_v1')) return false;
        const body = requestBody(r);
        return Number(body.p_amount) === AMOUNT && typeof body.p_account_id === 'string';
      }, { timeout: 90_000 });
      await pickFirstCashbook(page, dialog);
      expect((await checked).status(), 'R4 kiểm phiếu tạm ứng đúng số tiền + sổ').toBe(200);
      await expect(dialog.getByTestId('profit-advance-after')).toContainText(amountText(position0.advancePending + AMOUNT), { timeout: 60_000 });
      await expect(dialog.getByText('Đang tính lại…')).toHaveCount(0);
      await expect(dialog.getByTestId('profit-advance-blocked')).toHaveCount(0);
      const response = page.waitForResponse((r) => isRpc(r, 'shareholder_profit_advance_v1'), { timeout: 90_000 });
      await dialog.getByRole('button', { name: 'Lập phiếu chờ duyệt' }).click();
      const body = await (await response).json() as { voucher_id?: string; state?: string; within_amount?: number; advance_amount?: number; payout_kind?: string; maker_kind?: string };
      expect(body.state).toBe('PENDING_APPROVAL');
      expect(body.payout_kind).toBe('ADVANCE');
      expect(body.maker_kind).toBe('CUSTODIAN_ADVANCE');
      sameMoney(money(body.within_amount, 'within_amount'), 0, 'phiếu tạm ứng không có phần "trong số dư"');
      sameMoney(money(body.advance_amount, 'advance_amount'), AMOUNT, 'cả số tiền là tạm ứng');
      advanceVoucherId = String(body.voucher_id);
      created.push(advanceVoucherId);
      const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'tạm ứng' }).first();
      await expect(toast).toContainText('chờ chủ duyệt, chưa chi tiền', { timeout: 30_000 });
      advanceCode = ((await toast.innerText()).match(/PC\d+/) ?? [''])[0];
      expect(advanceCode, 'mã phiếu tạm ứng trong thông báo').toMatch(/^PC\d+$/);
      const after = await positionOf(ownerJwt, shareholderId);
      sameMoney(after.advancePending, position0.advancePending + AMOUNT, 'tạm ứng chờ duyệt tăng đúng số vừa lập');
      sameMoney(after.advance, position0.advance, 'tạm ứng đang có chưa đổi khi phiếu còn chờ duyệt');
      sameMoney(after.unpaid, position0.unpaid, 'tạm ứng không đụng lợi nhuận chưa chi');
    });

    // 3. Chủ công ty duyệt phiếu tạm ứng.
    await test.step('chủ công ty duyệt phiếu tạm ứng ⇒ tạm ứng đang có tăng, lợi nhuận chưa chi không đổi', async () => {
      await approveAtInbox(owner!.page, advanceCode, [
        'Tạm ứng lợi nhuận', 'Lúc lập', 'Người giữ sổ tự lập phiếu tạm ứng cho chính mình', 'Chỉ chi được từ sổ đã chọn lúc lập',
      ]);
      const after = await positionOf(ownerJwt, shareholderId);
      sameMoney(after.advance, position0.advance + AMOUNT, 'tạm ứng đang có tăng đúng số vừa duyệt (cộng dồn)');
      sameMoney(after.advancePending, position0.advancePending, 'tạm ứng chờ duyệt về như trước');
      sameMoney(after.unpaid, position0.unpaid, 'duyệt tạm ứng không đụng lợi nhuận chưa chi');
    });

    // 4. Chủ thứ hai chốt chi lợi nhuận: máy tính số, khấu trừ khoản tạm ứng vừa duyệt.
    const position1 = await positionOf(ownerJwt, shareholderId);
    const preview1 = await settlePreviewOf(ownerJwt, shareholderId);
    expect(preview1.through).toBe(preview0.through);
    sameMoney(preview1.recognized, preview0.recognized ?? Number.NaN, 'phần ghi nhận không đổi vì tạm ứng không đụng lợi nhuận chưa chi');
    sameMoney(preview1.offset, (preview0.offset ?? Number.NaN) + AMOUNT, 'khấu trừ gồm cả khoản tạm ứng vừa duyệt');
    sameMoney(preview1.cash, (preview0.cash ?? Number.NaN) - AMOUNT, 'thực chi giảm đúng bằng khoản tạm ứng vừa duyệt');
    const recognized = preview1.recognized ?? 0;
    const offset = preview1.offset ?? 0;
    const cash = preview1.cash ?? 0;
    maker = await openSession(browser, USERS.testhethong, makerPassword);
    let settlementId = '';
    let cashVoucherId = '';
    let cashCode = '';
    await test.step('chủ thứ hai chốt chi lợi nhuận: không nhập số tiền, ba dòng máy tính khớp máy chủ', async () => {
      const page = maker!.page;
      await openOwnerOverview(page);
      await expect(page.getByTestId('profit-ledger-route-banner')).toHaveCount(0);
      await expect(page.getByTestId(`ledger-unpaid-${shareholderId}`)).toContainText(amountText(position1.unpaid), { timeout: 90_000 });
      await expect(page.getByTestId(`ledger-advance-${shareholderId}`)).toContainText(amountText(position1.advance));
      await page.getByTestId(`ledger-row-${shareholderId}`).getByRole('button', { name: 'Chi', exact: true }).click();
      // Danh sách thả (popover) cũng mang role=dialog ⇒ chọn đúng hộp theo tên.
      const dialog = page.getByRole('dialog', { name: 'Chi lợi nhuận cổ đông' });
      await expect(dialog.getByTestId('profit-settle-preview')).toBeVisible({ timeout: 60_000 });
      await expect(dialog.locator('input[name=amount]')).toHaveCount(0);
      await expect(dialog.getByText('Chốt đến hết tháng')).toBeVisible();
      await expect(dialog.getByTestId('profit-settle-recognized')).toContainText(amountText(recognized));
      await expect(dialog.getByTestId('profit-settle-offset')).toContainText(amountText(offset));
      await expect(dialog.getByTestId('profit-settle-cash')).toContainText(amountText(cash));
      await expect(dialog.getByTestId('profit-settle-marker-reminder')).toHaveCount(preview1.markerMonth === null && preview1.settlements.length === 0 ? 1 : 0);
      await expect(dialog.getByTestId('profit-settle-pending-advance')).toHaveCount(preview1.advancePending > 0 ? 1 : 0);
      const recalculated = page.waitForResponse((r) => isRpc(r, 'shareholder_profit_settlement_preview_v1') && typeof requestBody(r).p_account_id === 'string', { timeout: 90_000 });
      await pickFirstCashbook(page, dialog);
      expect((await recalculated).status(), 'R5 tính lại theo sổ quỹ đã chọn').toBe(200);
      await expect(dialog.getByText('Đang tính lại…')).toHaveCount(0);
      await expect(dialog.getByTestId('profit-settle-cash')).toContainText(amountText(cash));
      await dialog.locator('textarea[name=note]').fill(SETTLE_NOTE);
      const response = page.waitForResponse((r) => isRpc(r, 'shareholder_profit_settle_v1'), { timeout: 90_000 });
      await dialog.getByRole('button', { name: 'Lập phiếu chờ duyệt' }).click();
      const settled = await response;
      const sent = requestBody(settled);
      sameMoney(money(sent.p_expected_recognized, 'p_expected_recognized'), recognized, 'gửi đúng phần ghi nhận đang hiện');
      sameMoney(money(sent.p_expected_cash, 'p_expected_cash'), cash, 'gửi đúng thực chi đang hiện');
      expect(sent.p_through_month).toBe(preview1.through);
      const body = await settled.json() as { state?: string; settlement_id?: string; voucher_id?: string | null; recognized_amount?: number; advance_offset_amount?: number; cash_amount?: number };
      expect(body.state).toBe('PENDING_APPROVAL');
      sameMoney(money(body.recognized_amount, 'recognized_amount'), recognized, 'máy chủ ghi đúng phần ghi nhận đã xem');
      sameMoney(money(body.advance_offset_amount, 'advance_offset_amount'), offset, 'máy chủ ghi đúng phần khấu trừ đã xem');
      sameMoney(money(body.cash_amount, 'cash_amount'), cash, 'máy chủ ghi đúng thực chi đã xem');
      settlementId = String(body.settlement_id);
      cashVoucherId = String(body.voucher_id);
      created.push(cashVoucherId);
      const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Đã chốt chi lợi nhuận' }).first();
      await expect(toast).toContainText('chờ duyệt, chưa chi tiền', { timeout: 30_000 });
      cashCode = ((await toast.innerText()).match(/PC\d+/) ?? [''])[0];
      expect(cashCode, 'mã phiếu tiền của lần chốt trong thông báo').toMatch(/^PC\d+$/);
      const after = await positionOf(ownerJwt, shareholderId);
      sameMoney(after.unpaid, position1.unpaid - recognized, 'lợi nhuận chưa chi giảm đúng phần ghi nhận');
      sameMoney(after.advance, position1.advance - offset, 'tạm ứng đang có giảm đúng phần khấu trừ');
      sameMoney(after.advancePending, position1.advancePending, 'phiếu tiền của lần chốt KHÔNG tính là tạm ứng chờ duyệt');
      sameMoney(after.cashPending, position1.cashPending + cash, 'tiền của lần chốt đang chờ duyệt');
    });

    // 5. Chủ công ty duyệt phiếu tiền của lần chốt.
    await test.step('chủ công ty duyệt phiếu tiền của lần chốt', async () => {
      await approveAtInbox(owner!.page, cashCode, ['Chi lợi nhuận cổ đông', 'Lúc lập', 'Phiếu chi lợi nhuận do chủ lập', 'Chỉ chi được từ sổ đã chọn lúc lập']);
      const after = await positionOf(ownerJwt, shareholderId);
      sameMoney(after.cashPending, position1.cashPending, 'không còn tiền của lần chốt chờ duyệt');
      sameMoney(after.unpaid, position1.unpaid - recognized, 'lợi nhuận chưa chi giữ nguyên sau khi duyệt phiếu tiền');
      sameMoney(after.advance, position1.advance - offset, 'phiếu tiền đã duyệt của lần chốt không thành tạm ứng');
      sameMoney(after.advancePending, position1.advancePending, 'tạm ứng chờ duyệt không đổi');
    });

    // 6. Cổ đông chỉ thấy tiền của mình: hai con số + lần chốt.
    await test.step('cổ đông thấy hai con số và lần chốt của mình, không thấy cổ đông khác', async () => {
      const page = holder!.page;
      const afterSettle = await positionOf(ownerJwt, shareholderId);
      const e3 = page.waitForResponse((r) => isRpc(r, 'shareholder_profit_my_ledger_v1'), { timeout: 90_000 });
      const r2 = page.waitForResponse((r) => isRpc(r, 'shareholder_profit_my_position_v1'), { timeout: 90_000 });
      await page.goto('/reports/finance/profit-distribution?tab=my-overview');
      const payload = await (await e3).json() as { route?: string; ready?: boolean; payouts?: Array<{ voucher_id?: string }>; percent_rows?: unknown; building_totals?: unknown };
      expect(payload.route).toBe('CANONICAL');
      expect(payload.ready).toBe(true);
      for (const id of [advanceVoucherId, cashVoucherId]) {
        expect((payload.payouts ?? []).some((p) => p.voucher_id === id), 'E3 có phiếu của chính mình').toBe(true);
      }
      const myPosition = await (await r2).json() as { unpaid_profit?: unknown; advance_outstanding?: unknown; settlements?: Array<{ id?: string }> };
      sameMoney(money(myPosition.unpaid_profit, 'unpaid_profit'), afterSettle.unpaid, 'R2: lợi nhuận chưa chi khớp vị thế của chủ');
      sameMoney(money(myPosition.advance_outstanding, 'advance_outstanding'), afterSettle.advance, 'R2: tạm ứng đang có khớp vị thế của chủ');
      expect((myPosition.settlements ?? []).some((s) => s.id === settlementId), 'R2 có lần chốt vừa lập').toBe(true);
      await expect(page.getByTestId('self-kpi-unpaid')).toContainText(amountText(afterSettle.unpaid), { timeout: 90_000 });
      await expect(page.getByTestId('self-kpi-advance')).toContainText(amountText(afterSettle.advance));
      await expect(page.getByTestId(`self-settlement-${settlementId}`)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(advanceCode, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      const main = await page.locator('main').innerText();
      for (const name of otherNames) {
        expect(new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'u').test(main), 'không thấy tên cổ đông khác').toBe(false);
      }
      if (!('percent_rows' in payload)) await expect(page.getByTestId('self-percent-card')).toHaveCount(0);
      if (!('building_totals' in payload)) await expect(page.getByTestId('self-building-totals-card')).toHaveCount(0);
    });

    // 7. Chủ công ty huỷ có lý do: phiếu tiền của lần chốt trước, phiếu tạm ứng sau ⇒ hai con số về như cũ.
    await test.step('chủ công ty huỷ phiếu tiền của lần chốt ⇒ lần chốt hết hiệu lực', async () => {
      const page = owner!.page;
      await openOwnerOverview(page);
      await page.getByTestId(`ledger-row-${shareholderId}`).getByRole('button', { name: 'Chi', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Chi lợi nhuận cổ đông' });
      const settlement = dialog.getByTestId(`profit-settle-row-${settlementId}`);
      await expect(settlement).toContainText(cashCode, { timeout: 90_000 });
      await settlement.getByRole('button', { name: 'Huỷ phiếu chi' }).click();
      await cancelApprovedVoucher(page, cashCode, `E2E sổ tổng ${RUN_TAG}: huỷ phiếu tiền của lần chốt thử`);
      await expect(dialog.getByTestId(`profit-settle-row-${settlementId}`)).toHaveCount(0, { timeout: 60_000 });
      expect((await settlePreviewOf(ownerJwt, shareholderId)).settlements.some((s) => s.id === settlementId), 'lần chốt không còn hiệu lực').toBe(false);
      const after = await positionOf(ownerJwt, shareholderId);
      sameMoney(after.unpaid, position1.unpaid, 'lợi nhuận chưa chi về như trước lần chốt');
      sameMoney(after.advance, position1.advance, 'phần khấu trừ được nhả: tạm ứng đang có về như trước lần chốt');
      await dialog.getByRole('button', { name: 'Đóng', exact: true }).click();
    });
    await test.step('chủ công ty huỷ phiếu tạm ứng từ sổ chi tiết ⇒ hai con số về như trước', async () => {
      const page = owner!.page;
      await page.getByTestId(`ledger-row-${shareholderId}`).getByRole('button', { name: 'Sổ', exact: true }).click();
      const entry = page.getByTestId(`ledger-entry-PAYOUT:${advanceVoucherId}`);
      await expect(entry).toBeVisible({ timeout: 90_000 });
      await entry.getByRole('button', { name: 'Huỷ', exact: true }).click();
      await cancelApprovedVoucher(page, advanceCode, `E2E sổ tổng ${RUN_TAG}: huỷ phiếu tạm ứng thử sau khi duyệt`);
      expect(await positionOf(ownerJwt, shareholderId), 'hai con số về đúng như trước khi thử').toEqual(position0);
    });
  } finally {
    await closeSession(holder);
    await closeSession(maker);
    await closeSession(owner);
  }
});
