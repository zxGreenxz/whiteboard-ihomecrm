import { test, expect, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Chốt hai hành vi vừa sửa 27/07/2026 (org DEMO):
 *
 *   1. MỌI phiếu THU tự duyệt ngay khi tạo — KỂ CẢ hạng mục Tiền cọc. Trước đây
 *      "Tiền cọc" mang system_only + force_approval nên phiếu thu cọc luôn nằm
 *      "Chờ duyệt" bất kể số tiền (phiếu cọc 1đ cũng phải chờ). Bài này đi UI thật.
 *
 *   2. (đổi 03/10/2026 — danh mục chi chuẩn) Quản lý KHÔNG tạo được hạng mục
 *      mới — chỉ superadmin và chủ công ty. Bài này đi thẳng PostgREST với ĐÚNG
 *      payload useCreateIncomeExpenseType gửi và đòi 403; rồi dựng phiếu chi dưới
 *      ngưỡng bằng hạng mục có sẵn: phải tự duyệt (không rơi sang compat "Chờ
 *      duyệt").
 */

const CANONICAL = /\/rest\/v1\/rpc\/create_income_expense_v1\b/;

async function openVoucherForm(page: Page) {
  await page.goto('/income-expense');
  await page.getByRole('button', { name: 'Thêm phiếu' }).click();
  await page.getByRole('menuitem', { name: 'Thêm phiếu lẻ' }).click();
  await expect(page.getByRole('heading', { name: /THÊM PHIẾU THU\/CHI/i })).toBeVisible();
}

/** Bắt apikey + token user hiện hành từ một request thật của app tới PostgREST. */
async function captureSupabaseAuth(page: Page) {
  const req = await page.waitForRequest((r) => /\/rest\/v1\//.test(r.url()), { timeout: 30_000 });
  const h = req.headers();
  const jwt = (h['authorization'] ?? '').replace(/^Bearer /, '');
  const sub = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString()).sub as string;
  return {
    base: new URL(req.url()).origin,
    apikey: h['apikey'] as string,
    auth: h['authorization'] as string,
    userId: sub,
  };
}

type SbAuth = Awaited<ReturnType<typeof captureSupabaseAuth>>;

const jsonHeaders = (a: SbAuth) => ({
  apikey: a.apikey,
  Authorization: a.auth,
  'Content-Type': 'application/json',
  'Content-Profile': 'public',
  'Accept-Profile': 'public',
});

async function sbGet(a: SbAuth, path: string) {
  const r = await fetch(`${a.base}/rest/v1/${path}`, {
    headers: { apikey: a.apikey, Authorization: a.auth, 'Accept-Profile': 'public' },
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

test('thu-tien-coc-tu-duyet-ngay', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  const name = `E2E thu coc ${Date.now()}`;

  await login(page, 'chunha');
  await openVoucherForm(page);
  await page.getByRole('combobox', { name: 'Tòa nhà *' }).click();
  await page.getByRole('option', { name: 'Tòa DEMO B' }).click();
  await page.getByRole('combobox', { name: 'Sổ quỹ *' }).click();
  await page.getByRole('option').first().click();
  await page.getByRole('textbox', { name: /Tên phiếu thu/i }).fill(name);

  await page.getByRole('button', { name: 'Thêm hạng mục' }).click();
  await page.getByRole('checkbox', { name: /Tiền cọc/i }).first().click();
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await page.getByRole('textbox', { name: 'Số tiền' }).first().fill('1000000');

  const [resp] = await Promise.all([
    page.waitForResponse((r) => CANONICAL.test(r.url()) && r.status() === 200, { timeout: 30_000 }),
    page.getByRole('button', { name: /^Lưu$/ }).last().click(),
  ]);
  const row = (await resp.json()) as { approval_status?: string };
  expect(row.approval_status, 'phiếu thu cọc phải tự duyệt ngay').toBe('APPROVED');
  expect(errs, `console: ${errs.join(' | ')}`).toEqual([]);
});

// Danh mục chi chuẩn 03/10/2026 (migration 20261003151606): chỉ superadmin + chủ công ty tạo/sửa/xoá hạng
// mục (policy RESTRICTIVE income_expense_types_editor_*). demo.chunha KHÔNG phải chủ công ty của org DEMO
// (đo trên TEST 03/10) ⇒ tạo hạng mục phải bị từ chối. Phần "hạng mục mới được gắn tổ chức" (trigger
// trg_autofill_org) không còn kiểm được bằng tài khoản DEMO — kiểm ở bộ thử RLS trên TEST bằng chủ công ty.
test('quan-ly-khong-tao-duoc-hang-muc-va-chi-duoi-nguong-tu-duyet', async ({ page }) => {
  const stamp = Date.now();
  const typeName = `E2E phao bom ${stamp}`;
  let typeId: string | null = null;
  let voucherId: string | null = null;

  await login(page, 'chunha');
  const nav = page.goto('/income-expense');
  const auth = await captureSupabaseAuth(page);
  await nav;

  try {
    // ĐÚNG payload useCreateIncomeExpenseType gửi — KHÔNG có organization_id.
    const created = await fetch(`${auth.base}/rest/v1/income_expense_types`, {
      method: 'POST',
      headers: { ...jsonHeaders(auth), Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: auth.userId,
        name: typeName,
        type: 'expense',
        category: 'Bảo Trì Tòa Nhà',
        description: null,
        is_default: false,
        is_restricted: false,
        hide_in_report: false,
      }),
    });
    if (created.ok) typeId = ((await created.clone().json()) as { id: string }[])[0]?.id ?? null;
    expect(created.status, `quản lý tạo hạng mục phải bị chặn: ${await created.clone().text()}`).toBe(403);
    expect(await sbGet(auth, `income_expense_types?select=id&name=eq.${encodeURIComponent(typeName)}`)).toEqual([]);

    const [b] = await sbGet(
      auth,
      'buildings?select=id,organization_id&name=eq.T%C3%B2a%20DEMO%20A&limit=1',
    );
    // Hạng mục chi có sẵn mà quản lý được chọn tay (ô chọn Thu chi lọc y như vậy).
    const [t] = await sbGet(
      auth,
      `income_expense_types?select=id&organization_id=eq.${b.organization_id}&type=eq.expense` +
        '&system_only=is.false&is_restricted=is.false&archived_at=is.null&manual_hidden=is.false' +
        '&internal_transfer=is.false&order=name&limit=1',
    );
    expect(t, 'DEMO phải có hạng mục chi lập tay được').toBeTruthy();

    // Sổ quỹ nào cũng được, miễn thuộc org DEMO và chunha đọc được qua RLS.
    const [acc] = await sbGet(
      auth,
      `accounts?select=id&organization_id=eq.${b.organization_id}&deleted_at=is.null&limit=1`,
    );
    expect(acc, 'DEMO phải có ít nhất một sổ quỹ chunha đọc được').toBeTruthy();
    const today = new Date().toISOString().slice(0, 10);
    const r = await fetch(`${auth.base}/rest/v1/rpc/create_income_expense_v1`, {
      method: 'POST',
      headers: jsonHeaders(auth),
      body: JSON.stringify({
        p_type: 'EXPENSE',
        p_name: `E2E chi hang muc moi ${stamp}`,
        p_building_id: b.id,
        p_room_id: null,
        p_tenant_id: null,
        p_contract_id: null,
        p_payer_name: null,
        p_receive_bank_account: null,
        p_receive_bank_name: null,
        p_account_id: acc.id,
        p_attachments: [],
        p_business_result_accounting: null,
        p_notes: null,
        p_voucher_date: today,
        // 100.000đ — dưới ngưỡng tự duyệt của org DEMO (5.000.000đ).
        p_items: [
          {
            income_expense_type_id: t.id,
            description: 'e2e duoi nguong',
            quantity: 1,
            unit_price: 100_000,
            start_date: today,
            end_date: today,
          },
        ],
        p_idempotency_key: `e2e-orgfix-${stamp}`,
      }),
    });
    expect(r.status, `writer canonical: ${await r.clone().text()}`).toBe(200);
    const v = (await r.json()) as { id: string; approval_status: string };
    voucherId = v.id;
    expect(v.approval_status, 'phiếu chi dưới ngưỡng phải tự duyệt').toBe('APPROVED');
  } finally {
    // Fixture tự dọn (best-effort — RLS có thể chặn xoá, khi đó dọn tay ở DEMO).
    if (voucherId) {
      await fetch(`${auth.base}/rest/v1/rpc/cancel_income_expense_v1`, {
        method: 'POST',
        headers: jsonHeaders(auth),
        body: JSON.stringify({ p_voucher_id: voucherId, p_reason: 'E2E cleanup' }),
      }).catch(() => {});
    }
    if (typeId) {
      await fetch(`${auth.base}/rest/v1/income_expense_types?id=eq.${typeId}`, {
        method: 'DELETE',
        headers: jsonHeaders(auth),
      }).catch(() => {});
    }
  }
});
