import { test, expect, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Chốt hai hành vi vừa sửa 27/07/2026 (org DEMO):
 *
 *   1. MỌI phiếu THU tự duyệt ngay khi tạo — KỂ CẢ hạng mục Tiền cọc. Trước đây
 *      "Tiền cọc" mang system_only + force_approval nên phiếu thu cọc luôn nằm
 *      "Chờ duyệt" bất kể số tiền (phiếu cọc 1đ cũng phải chờ). Bài này đi UI thật.
 *
 *   2. Hạng mục tạo mới phải được gắn tổ chức. Trước đây nó sinh ra với
 *      organization_id = NULL → create_income_expense_v1 raise 42501 "Loại hạng
 *      mục 1 không thuộc tổ chức hoặc sai chiều thu/chi" → FE nuốt lỗi, rơi sang
 *      ie_compat_insert_v2 (ép "Chờ duyệt", KHÔNG chạy thang ngưỡng). Bài này đi
 *      thẳng PostgREST với ĐÚNG payload mà useCreateIncomeExpenseType gửi (không
 *      có organization_id) rồi dựng phiếu chi dưới ngưỡng — nếu trigger
 *      trg_autofill_org mất, hạng mục lại mồ côi và writer sẽ từ chối ngay.
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

test('hang-muc-moi-duoc-gan-to-chuc-va-chi-duoi-nguong-tu-duyet', async ({ page }) => {
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
    expect(created.status, `tạo hạng mục: ${await created.clone().text()}`).toBe(201);
    const [typeRow] = (await created.json()) as { id: string; organization_id: string | null }[];
    typeId = typeRow.id;
    expect(typeRow.organization_id, 'hạng mục mới phải được gắn tổ chức').not.toBeNull();

    const [b] = await sbGet(
      auth,
      'buildings?select=id,organization_id&name=eq.T%C3%B2a%20DEMO%20A&limit=1',
    );
    expect(typeRow.organization_id, 'phải gắn đúng tổ chức đang làm việc').toBe(b.organization_id);

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
            income_expense_type_id: typeId,
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
