import { test, expect, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';
import {
  cleanupDemoCommissionManagerFixture,
  cleanupDemoSalaryConfig,
  cleanupDemoSalaryFixture,
  demoSalaryMonthlyIds,
  demoSalaryStaffGivenName,
  demoSalaryStaffId,
  ensureDemoSalaryConfig,
} from './accounting-admin';

// Hoa hồng quản lý đi sổ ảo, trả qua lương (migration 20260927155251). Nghiệm thu SAU
// khi migration lên production: org DEMO nằm chung database production, nên trước lúc
// đó màn lương báo "Máy chủ chưa có chức năng hoa hồng quản lý" và spec ĐỎ — cố ý.
//
// Đường thật của người dùng:
//   1. Phiếu Thưởng nóng Sale (chờ duyệt) ở SỔ THẬT, người nhận = tên quản lý fixture
//      ⇒ màn lương hiện "Chưa gán QL": có trong thu nhập, KHÔNG có trong tiền chuyển.
//   2. Bấm khoản → "Chuyển sang trả qua lương" ⇒ chip "Trả qua lương", tiền chuyển
//      tăng ĐÚNG số phiếu; phiếu nằm ở sổ ảo, NON_CASH / NOT_APPLICABLE, vẫn chờ duyệt.
//
// Ghi dữ liệu: chỉ org DEMO. afterAll/finally gỡ liên kết + huỷ phiếu + xoá mềm HĐ,
// trả phòng, dọn dòng lương nháp và cấu hình fixture.
test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
const AMOUNT = 321_000;
const BOOK = 'Hoa hồng QL chờ trả lương';
let fixtureState: 'existing' | 'created' | null = null;
let keepMonthly: string[] = [];
let staffId = '';
let givenName = '';

test.beforeAll(async () => {
  keepMonthly = await demoSalaryMonthlyIds();
  staffId = await demoSalaryStaffId();
  givenName = await demoSalaryStaffGivenName();
  fixtureState = await ensureDemoSalaryConfig();
});

test.afterAll(async () => {
  console.log('[salary-commission-manager] dọn kỳ nháp:', await cleanupDemoSalaryFixture('E2E fleet hhql ', keepMonthly));
  if (fixtureState === 'created') console.log('[salary-commission-manager] dọn cấu hình:', await cleanupDemoSalaryConfig());
});

async function captureSupabaseAuth(page: Page) {
  const req = await page.waitForRequest((r) => /\/rest\/v1\//.test(r.url()), { timeout: 30_000 });
  const h = req.headers();
  return { base: new URL(req.url()).origin, apikey: h['apikey'], auth: h['authorization'] };
}
type SbAuth = Awaited<ReturnType<typeof captureSupabaseAuth>>;
async function sbGet<T>(a: SbAuth, path: string): Promise<T> {
  const r = await fetch(`${a.base}/rest/v1/${path}`, { headers: { apikey: a.apikey, Authorization: a.auth } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}
async function sbRpc(a: SbAuth, name: string, body: unknown) {
  const r = await fetch(`${a.base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: a.apikey, Authorization: a.auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { ok: r.ok, status: r.status, json: json as Record<string, unknown> | null, text };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (base: string, days: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};
const money = (s: string) => Number(s.replace(/[^\d-]/g, '')) || 0;
const cashOf = async (page: Page) =>
  money(await page.getByText('Tiền thực chuyển', { exact: true }).locator('xpath=following-sibling::span[1]').innerText());

async function openIncome(page: Page) {
  await page.goto('/finance/salary');
  const tab = page.getByRole('button', { name: /Thu nhập & thanh toán/ });
  await expect(tab).toBeVisible({ timeout: 45_000 });
  await tab.click();
  await page.getByRole('button').filter({ hasText: '(fixture E2E)' }).first().click();
  await expect(page.getByText('Tiền thực chuyển', { exact: true })).toBeVisible();
}

test('chủ công ty: phiếu HH của quản lý ở sổ thật → chuyển sang trả qua lương', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = trackConsoleErrors(page);
  let contractId: string | null = null;
  let voucherId: string | null = null;
  let room: { id: string; status: string } | null = null;

  try {
    await login(page, 'chunha');
    const nav = page.goto('/income-expense');
    const auth = await captureSupabaseAuth(page);
    await nav;

    // ── Fixture: phòng trống + khách + sổ THẬT → HĐ → phiếu Thưởng nóng Sale ──
    const buildings = await sbGet<{ id: string }[]>(auth, `buildings?select=id&organization_id=eq.${DEMO_ORG}&deleted_at=is.null`);
    const rooms = await sbGet<{ id: string; status: string }[]>(
      auth, `rooms?select=id,status&building_id=in.(${buildings.map((b) => b.id).join(',')})&status=eq.AVAILABLE&deleted_at=is.null`);
    const busy = new Set((await sbGet<{ room_id: string }[]>(
      auth, `contracts?select=room_id&status=eq.ACTIVE&deleted_at=is.null&organization_id=eq.${DEMO_ORG}`)).map((c) => c.room_id));
    const free = rooms.filter((r) => !busy.has(r.id));
    expect(free.length, 'cần ít nhất 1 phòng DEMO trống').toBeGreaterThan(0);
    room = { id: free[0].id, status: free[0].status };
    const [customer] = await sbGet<{ id: string }[]>(auth, `customers?select=id&organization_id=eq.${DEMO_ORG}&deleted_at=is.null&limit=1`);
    const [realBook] = await sbGet<{ id: string; name: string }[]>(
      auth, `accounts?select=id,name&organization_id=eq.${DEMO_ORG}&deleted_at=is.null&is_virtual=eq.false&limit=1`);
    expect(customer && realBook, 'DEMO phải có khách hàng và sổ quỹ thật').toBeTruthy();

    const today = iso(new Date());
    const hd = await sbRpc(auth, 'create_contract_v2', {
      p_payload: {
        contract: {
          room_id: room.id, signed_date: today, start_date: today, end_date: addDays(today, 365),
          rent_price: 5_000_000, total_deposit: 0, payment_cycle: 'MONTHLY',
          start_billing_date: today, end_billing_date: addDays(today, 29),
          contract_template_id: null, invoice_template_id: null, notes: '[E2E] hhql fixture', discounts: [],
          deposit_debt_mode: null, deposit_debt_reason: null, deposit_topup_due_date: null,
        },
        customers: [{ customer_id: customer.id, is_representative: true, notes: null }],
        services: [], deposit_receipts: [], existing_deposit_voucher_ids: [],
      },
      p_idempotency_key: `e2e-hhql-${Date.now()}`,
    });
    expect(hd.ok, `create_contract_v2 → ${hd.status} ${hd.text}`).toBeTruthy();
    contractId = (hd.json?.contract as { id?: string } | undefined)?.id ?? null;
    expect(contractId).toBeTruthy();

    const sale = await sbRpc(auth, 'create_commission_voucher', {
      p_contract_id: contractId, p_kind: 'sale', p_amount: AMOUNT, p_voucher_date: today,
      p_account_id: realBook.id, p_payer_name: givenName, p_recipient_name: givenName,
      p_recipient_bank: null, p_recipient_account: null,
      p_item_description: '[E2E] hhql thưởng nóng Sale', p_attachments: [],
    });
    expect(sale.ok, `create_commission_voucher → ${sale.status} ${sale.text}`).toBeTruthy();
    voucherId = String(sale.json?.id ?? '');
    const [v0] = await sbGet<{ name: string; approval_status: string }[]>(auth, `income_expenses?select=name,approval_status&id=eq.${voucherId}`);
    expect(v0.approval_status, 'Thưởng nóng Sale không tự duyệt').toBe('UNAPPROVED');

    // ── 1. Màn lương: có trong thu nhập, KHÔNG có trong tiền chuyển ──────────
    await openIncome(page);
    const line = page.getByRole('button', { name: new RegExp(v0.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first();
    await expect(line, 'phiếu khớp tên người nhận phải hiện ở nhóm Hoa hồng').toBeVisible({ timeout: 30_000 });
    await expect(line).toContainText('Khi duyệt sẽ chi từ sổ');
    await expect(page.getByText('Hoa hồng chi từ sổ thật (không chuyển lại)')).toBeVisible();
    const cash0 = await cashOf(page);

    // ── 2. Chuyển sang trả qua lương ────────────────────────────────────────
    await line.click();
    const drawer = page.getByRole('dialog', { name: v0.name });
    await expect(drawer.getByText('Chưa gán QL', { exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: /^Chuyển sang trả qua lương/ }).click();
    await expect(page.getByText(/Đã gán quản lý/)).toBeVisible({ timeout: 30_000 });
    // Trước khi gán, dòng mô tả cũng có chữ "trả qua lương" ("…bấm để chuyển sang trả
    // qua lương") — nên phải đo đúng câu của trạng thái mới VÀ câu cũ đã biến mất.
    await expect(line).toContainText('Chờ duyệt · tự duyệt khi chốt, trả qua lương', { timeout: 30_000 });
    await expect(line).not.toContainText('Khi duyệt sẽ chi từ sổ');
    await expect.poll(() => cashOf(page), { timeout: 30_000 }).toBe(cash0 + AMOUNT);

    // ── 3. Phía máy chủ: phiếu ở sổ ảo, không ghi sổ tiền, vẫn chờ duyệt ────
    const [v1] = await sbGet<{ account_id: string; posting_mode: string; posting_status: string; approval_status: string }[]>(
      auth, `income_expenses?select=account_id,posting_mode,posting_status,approval_status&id=eq.${voucherId}`);
    expect(v1).toMatchObject({ posting_mode: 'NON_CASH', posting_status: 'NOT_APPLICABLE', approval_status: 'UNAPPROVED' });
    const [book] = await sbGet<{ name: string; is_virtual: boolean }[]>(auth, `accounts?select=name,is_virtual&id=eq.${v1.account_id}`);
    expect(book).toEqual({ name: BOOK, is_virtual: true });
    const meta = await sbRpc(auth, 'salary_commission_meta_v1', { p_voucher_ids: [voucherId] });
    expect(meta.ok, meta.text).toBeTruthy();
    expect((meta.json as unknown as { manager_id: string; on_manager_book: boolean }[])[0])
      .toMatchObject({ manager_id: staffId, on_manager_book: true });

    expect(errs, 'console errors: ' + errs.join(' | ')).toEqual([]);
  } finally {
    console.log('[salary-commission-manager] dọn fixture:', await cleanupDemoCommissionManagerFixture({
      voucherIds: voucherId ? [voucherId] : [], contractId, room,
    }));
  }
});
