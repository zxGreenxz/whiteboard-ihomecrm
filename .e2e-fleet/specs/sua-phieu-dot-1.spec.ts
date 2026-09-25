import { test, expect, type Page } from '@playwright/test';
import { laWebTest, login, trackConsoleErrors } from './auth';

/**
 * ĐỢT 1 SỬA PHIẾU THU CHI (25/09/2026) — chạy trên WEB TEST (bản sao production).
 *
 *   1. Phiếu chi Chờ duyệt: sửa tên (không cần lý do) rồi sửa số tiền (bắt lý do)
 *      trên form — mỗi lần là một dòng lịch sử, phiếu vẫn Chờ duyệt.
 *   2. Danh sách hiện "Đã sửa 2 lần"; hộp Duyệt hiện "đã được sửa 2 lần".
 *   3. Sửa chồng bằng phiên bản cũ ⇒ PT409 (HTTP 409) ngay, không ghi, không treo.
 *   4. Đổi Chi → Thu ⇒ cấp mã mới tiền tố PT (sự cố PC2609124).
 *
 * Tài khoản `testchu` (chủ công ty thật, không phải super admin — phiếu lập ra Chờ duyệt). Phiếu tạo ra mang
 * tên "[E2E sửa phiếu]" — chỉ nằm trên project TEST.
 *
 * Chạy:
 *   cd .e2e-fleet && FLEET_BASE_URL=https://ihomecrm-git-test-env-zxgreenxzs-projects.vercel.app \
 *     VERCEL_AUTOMATION_BYPASS_SECRET=… FLEET_PASS_TEST_CHU=… FLEET_WORKERS=1 \
 *     npx playwright test specs/sua-phieu-dot-1.spec.ts
 */

test.skip(!laWebTest(), 'chỉ chạy khi FLEET_BASE_URL là web TEST (nhánh test-env)');

async function batAuth(page: Page) {
  const req = await page.waitForRequest((r) => /\.supabase\.co\/rest\/v1\//.test(r.url()), { timeout: 30_000 });
  const h = req.headers();
  return { base: new URL(req.url()).origin, apikey: h['apikey'], auth: h['authorization'] };
}
type SbAuth = Awaited<ReturnType<typeof batAuth>>;

async function sbGet(a: SbAuth, path: string) {
  const r = await fetch(`${a.base}/rest/v1/${path}`, {
    headers: { apikey: a.apikey, Authorization: a.auth, 'Accept-Profile': 'public' },
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbRpc(a: SbAuth, name: string, body: unknown) {
  const r = await fetch(`${a.base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: a.apikey, Authorization: a.auth, 'Content-Type': 'application/json', 'Content-Profile': 'public' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, ok: r.ok, json, text };
}

const rnd = () => Math.random().toString(36).slice(2, 8);
const homNay = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

test('sửa phiếu chờ duyệt có vết, duyệt thấy đã sửa gì, chặn sửa chồng, đổi loại cấp mã mới', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = trackConsoleErrors(page);
  // Nhật ký mọi lệnh sửa trình duyệt gửi đi — soi khi bấm Lưu mà treo.
  const t0 = Date.now();
  const nhatKy: string[] = [];
  page.on('request', (r) => {
    if (/rpc\/revise_pending_income_expense_v1/.test(r.url())) nhatKy.push(`${Date.now() - t0}ms GUI ${r.postData()?.slice(0, 160)}`);
  });
  page.on('response', async (r) => {
    if (/rpc\/revise_pending_income_expense_v1/.test(r.url())) nhatKy.push(`${Date.now() - t0}ms VE ${r.status()}`);
    if (/\/rest\/v1\/income_expenses\?/.test(r.url()) && r.request().method() === 'GET') {
      const timing = r.request().timing();
      const than = await r.text().catch(() => '');
      const m = /"approval_version":(\d+)/.exec(than.slice(Math.max(0, than.indexOf('51c7f7a0') - 5)));
      nhatKy.push(`${Date.now() - t0}ms DS ${r.status()} ${Math.round(timing.responseEnd)}ms v=${m?.[1] ?? '-'} ${decodeURIComponent(r.url()).slice(0, 140)}`);
    }
  });
  page.on('requestfailed', (r) => {
    if (/rpc\/revise_pending_income_expense_v1/.test(r.url())) nhatKy.push(`${Date.now() - t0}ms HONG ${r.failure()?.errorText}`);
  });
  test.info().annotations.push({ type: 'nhat-ky', description: '' });
  page.on('close', () => console.log('NHAT KY SUA:\n' + nhatKy.join('\n')));
  const authPromise = batAuth(page);
  await login(page, 'testchu');
  await page.goto('/income-expense');
  const a = await authPromise;

  // ── Chuẩn bị: một phiếu chi LẬP TAY đang Chờ duyệt trong tháng này (bản sao dữ liệu
  // thật trên TEST). Chủ công ty không lập phiếu thẳng qua API ở toà này được, và
  // super admin lập phiếu thì được tự duyệt — nên dùng phiếu có sẵn.
  const thangNay = `${homNay().slice(0, 8)}01`;
  const [p0] = (await sbGet(
    a,
    'income_expenses?select=id,code,name,organization_id,approval_status,approval_version' +
      '&approval_status=eq.UNAPPROVED&type=eq.EXPENSE&system_source=is.null&invoice_id=is.null' +
      `&shareholder_id=is.null&deleted_at=is.null&has_restricted_item=is.false&voucher_date=gte.${thangNay}` +
      '&order=created_at.desc&limit=1',
  )) as { id: string; code: string; name: string; organization_id: string; approval_status: string; approval_version: number }[];
  expect(p0, 'TEST phải có phiếu chi lập tay Chờ duyệt trong tháng này').toBeTruthy();
  const id = p0.id;
  const ten = p0.name;
  const ngay = homNay();
  const hangMucThu = (await sbGet(
    a,
    `income_expense_types?select=id,name&organization_id=eq.${p0.organization_id}&type=eq.income` +
      '&is_restricted=is.false&system_only=is.false&is_deposit=is.false&order=name&limit=1',
  )) as { id: string }[];
  const daSuaTruoc = ((await sbGet(
    a,
    `income_expense_revisions?select=id&income_expense_id=eq.${id}&kind=eq.EDIT_PENDING`,
  )) as unknown[]).length;
  expect(p0.code).toMatch(/^PC\d{4}\d{3,}$/);

  // ── 1a. Sửa tên trên form — không cần lý do ─────────────────────────────────
  // Phiếu chưa có sổ nằm ở lớp "chờ xử lý" — mở thẳng lớp đó (bộ lọc giữ qua F5).
  await page.goto('/income-expense?layer=PENDING&approval_status=UNAPPROVED');
  const timKiem = page.getByPlaceholder('Tìm mã phòng, tên/mã phiếu hoặc số tiền (±5.000đ)...');
  await timKiem.fill(p0.code);
  // Ô tìm kiếm đã lọc còn đúng phiếu này (dòng không in mã phiếu).
  const dong = page.getByRole('row').filter({ has: page.getByTitle('Sửa phiếu chờ duyệt') }).first();
  await expect(dong).toBeVisible({ timeout: 60_000 });
  await dong.getByTitle('Sửa phiếu chờ duyệt').click();
  await expect(page.getByRole('heading', { name: 'SỬA PHIẾU CHỜ DUYỆT' })).toBeVisible();
  const oTen = page.getByRole('dialog').locator('textarea[name="name"]');
  await expect(oTen).toHaveValue(ten);
  // Tên mới có đuôi ngẫu nhiên, bỏ đuôi của lượt chạy trước (tên không dài mãi).
  const tenMoi = `${ten.replace(/ \(đã sửa tên[^)]*\)/g, '')} (đã sửa tên ${rnd()})`;
  await oTen.fill(tenMoi);
  const lan1 = page.waitForResponse((r) => /rpc\/revise_pending_income_expense_v1/.test(r.url()), { timeout: 60_000 });
  await page.getByTestId('ie-form-save').click();
  expect((await lan1).status()).toBe(200);
  await expect(page.getByText(`Đã lưu thay đổi phiếu (lần sửa ${daSuaTruoc + 1}). Phiếu vẫn Chờ duyệt.`)).toBeVisible();

  // ── 1b. Sửa số tiền — phải có lý do ─────────────────────────────────────────
  // Như người dùng thật: bảng đã hiện tên mới rồi mới mở sửa lần hai.
  await expect(dong).toContainText(tenMoi, { timeout: 60_000 });
  await dong.getByTitle('Sửa phiếu chờ duyệt').click();
  const tien = page.getByRole('dialog').getByPlaceholder('Số tiền').first();
  await tien.click();
  // Số mới = số hiện có của hạng mục đầu + 1.000 (chạy lại nhiều lần vẫn là một lần đổi tiền).
  const soHienCo = Number((await tien.inputValue()).replace(/\D/g, '')) || 0;
  await tien.fill(String(soHienCo + 1000));
  const nutLuu = page.getByTestId('ie-form-save');
  await expect(page.getByTestId('revision-reason')).toBeVisible();
  await expect(nutLuu).toBeDisabled();
  await page.getByTestId('revision-reason').fill('Thợ báo giá lại (E2E)');
  const lan2 = page.waitForResponse((r) => /rpc\/revise_pending_income_expense_v1/.test(r.url()), { timeout: 60_000 });
  await nutLuu.click();
  expect((await lan2).status()).toBe(200);

  const lichSu = (await sbGet(
    a,
    `income_expense_revisions?select=revision_no,reason,changed_fields&income_expense_id=eq.${id}&order=revision_no`,
  )) as { revision_no: number; reason: string | null; changed_fields: string[] }[];
  expect(lichSu.slice(-2).map((r) => r.changed_fields)).toEqual([['name'], ['items']]);
  expect(lichSu[lichSu.length - 1].reason).toBe('Thợ báo giá lại (E2E)');

  // ── 2. Danh sách + hộp Duyệt thấy đã sửa ─────────────────────────────────────
  await page.reload();
  await timKiem.fill(p0.code);
  await expect(dong.getByText(`Đã sửa ${daSuaTruoc + 2} lần`)).toBeVisible({ timeout: 60_000 });
  await dong.getByTitle('Duyệt phiếu (đã thanh toán)').click();
  const hopDuyet = page.getByRole('alertdialog');
  await expect(hopDuyet.getByText(`Phiếu đã được sửa ${daSuaTruoc + 2} lần khi đang Chờ duyệt`)).toBeVisible();
  await expect(hopDuyet.getByText('Lý do: Thợ báo giá lại (E2E)').last()).toBeVisible();
  await hopDuyet.getByRole('button', { name: 'Đóng' }).click();

  // ── 3. Sửa chồng bằng phiên bản cũ ⇒ PT409 ─────────────────────────────────
  const chong = await sbRpc(a, 'revise_pending_income_expense_v1', {
    p_voucher: id, p_expected_approval_version: p0.approval_version, p_patch: { name: 'ghi đè' },
  });
  expect(chong.status).not.toBe(200);
  expect(chong.status, `sửa chồng → ${chong.status} ${chong.text}`).toBe(409);
  expect(chong.json?.code).toBe('PT409');

  // ── 4. Đổi Chi → Thu ⇒ mã mới PT ─────────────────────────────────────────
  const [p2] = (await sbGet(a, `income_expenses?select=approval_version&id=eq.${id}`)) as { approval_version: number }[];
  const doiLoai = await sbRpc(a, 'revise_pending_income_expense_v1', {
    p_voucher: id,
    p_expected_approval_version: p2.approval_version,
    // Chủ công ty không giữ sổ nào: bỏ sổ (người duyệt chọn lại) để đổi loại không vướng quyền sổ.
    p_patch: { type: 'INCOME', account_id: null },
    p_items: [{ income_expense_type_id: hangMucThu[0].id, quantity: 1, unit_price: 2_400_000, start_date: ngay, end_date: ngay }],
    p_reason: 'Lập nhầm phiếu chi, đổi thành phiếu thu (E2E)',
  });
  expect(doiLoai.ok, `đổi loại → ${doiLoai.status} ${doiLoai.text}`).toBeTruthy();
  const [p3] = (await sbGet(a, `income_expenses?select=code,type,approval_status&id=eq.${id}`)) as {
    code: string; type: string; approval_status: string;
  }[];
  expect(p3.type).toBe('INCOME');
  expect(p3.approval_status).toBe('UNAPPROVED');
  expect(p3.code).toMatch(/^PT\d{4}\d{3,}$/);
  expect(p3.code).not.toBe(p0.code);

  expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
});
