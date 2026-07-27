import { test, expect, Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

const RPC = (name: string) => new RegExp(`/rest/v1/rpc/${name}\\b`);

// Regression: phiếu CỌC (hạng mục `system_only`) trên toà mà user CHỈ thấy nhờ
// quyền `income_expenses.all_buildings` (KHÔNG có scope `buildings.view`).
//
// Đường đi: create_income_expense_v1 từ chối (0A000 lớp phiếu cọc / 42501) →
// client rơi về ie_compat_insert_v2. Trước fix, client còn đọc
// `buildings.organization_id` trực tiếp; RLS `buildings_select_rbac` trả 0 dòng
// → văng "Tòa nhà chưa được gắn tổ chức" và KHÔNG hề gọi compat, dù server cho
// phép tạo. Sau fix: client không đọc buildings nữa, ie_compat_insert_v2
// (SECURITY DEFINER) tự suy organization_id → tạo được.
//
// Fixture DEMO cần có: demo.quanly có `income_expenses.all_buildings`
// (override ORGANIZATION + legacy `staff_assignments.permissions`) nhưng KHÔNG
// có scope toà "Chung (Demo)"; sổ "DEMO Quản Lý Thu" (quanly CUSTODIAN);
// hạng mục thu "Tiền cọc" (`system_only = true`).

/** Bắt apikey + token user hiện hành từ một request thật của app tới PostgREST. */
async function captureSupabaseAuth(page: Page) {
  const req = await page.waitForRequest((r) => /\/rest\/v1\//.test(r.url()), { timeout: 30_000 });
  const h = req.headers();
  return {
    base: new URL(req.url()).origin,
    apikey: h['apikey'],
    auth: h['authorization'],
  };
}

test('ie-deposit-on-all-buildings-only-building', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  await login(page, 'quanly');
  const nav = page.goto('/income-expense');
  const sb = await captureSupabaseAuth(page);
  await nav;

  await page.getByRole('button', { name: 'Thêm phiếu' }).click();
  await page.getByRole('menuitem', { name: 'Thêm phiếu lẻ' }).click();
  await expect(page.getByRole('heading', { name: /THÊM PHIẾU THU\/CHI/i })).toBeVisible();

  await page.getByRole('combobox', { name: 'Tòa nhà *' }).click();
  await page.getByRole('option', { name: 'Chung (Demo)' }).click();
  await page.getByRole('combobox', { name: 'Sổ quỹ *' }).click();
  await page.getByRole('option', { name: /DEMO Quản Lý Thu/i }).click();

  const voucherName = `E2E deposit allbuildings ${Date.now()}`;
  await page.getByRole('textbox', { name: /Tên phiếu thu/i }).fill(voucherName);

  await page.getByRole('button', { name: 'Thêm hạng mục' }).click();
  await page.getByRole('checkbox', { name: /^Tiền cọc$/i }).first().click();
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await page.getByRole('textbox', { name: 'Số tiền' }).first().fill('150000');

  const seen: string[] = [];
  page.on('response', (r) => {
    const u = r.url();
    if (RPC('create_income_expense_v1').test(u)) seen.push(`v1=${r.status()}`);
    if (RPC('ie_compat_insert_v2').test(u)) seen.push(`compat=${r.status()}`);
  });

  const waitCompat = page
    .waitForResponse((r) => RPC('ie_compat_insert_v2').test(r.url()), { timeout: 30_000 })
    .catch(() => null);
  await page.getByRole('button', { name: /^Lưu$/ }).click();
  const compatResp = await waitCompat;
  console.log(`[quanly] ${voucherName} → ${seen.join(' , ')}`);

  let voucherId: string | null = null;
  try {
    // Không có call compat = client tự chặn trước khi tới server (bug cũ).
    expect(
      compatResp,
      `Không gọi tới ie_compat_insert_v2. seen=[${seen.join(', ')}] console=[${errs.join(' | ')}]`,
    ).not.toBeNull();
    expect(compatResp!.status(), 'ie_compat_insert_v2 phải 200').toBe(200);
    voucherId = ((await compatResp!.json()) as { id?: string } | null)?.id ?? null;
    await expect(page.getByText('Dữ liệu đã được TẠO thành công')).toBeVisible();
    expect(errs, `console: ${errs.join(' | ')}`).toEqual([]);
  } finally {
    // Fixture tự dọn: phiếu sinh ra là UNAPPROVED → huỷ luôn.
    if (voucherId) {
      await fetch(`${sb.base}/rest/v1/rpc/ie_compat_cancel_v2`, {
        method: 'POST',
        headers: {
          apikey: sb.apikey,
          Authorization: sb.auth,
          'Content-Type': 'application/json',
          'Content-Profile': 'public',
        },
        body: JSON.stringify({ p_ids: [voucherId], p_reason: 'E2E cleanup' }),
      });
    }
  }
});
