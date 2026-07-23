import { test, expect, Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Finance V2 — smoke E2E trọn vòng đời phiếu trên org DEMO (§21 acceptance):
 *
 *   seed phiếu thu CHỜ DUYỆT (qua ie_compat_insert_v2 — server ép UNAPPROVED,
 *     đúng đường compat mà user không-đủ-capability đi trong đời thật; user
 *     DEMO nào tạo qua form cũng auto-APPROVED nên UI không tạo pending được)
 *   chunha CHỈ DUYỆT       → Đã Duyệt - Chưa Thu (V2: duyệt KHÔNG đổi tồn quỹ)
 *   chunha THU TIỀN VÀO SỔ → Đã Thu (CUSTODIAN + evidence bắt buộc)
 *   chunha HUỶ             → Đã huỷ (bridge reversal trả tiền) — fixture tự dọn.
 *
 * Chạy: FLEET_PASS_CHUNHA=... FLEET_PASS_KETOAN=... \
 *         npx playwright test specs/finance-v2.spec.ts
 * Dữ liệu DEMO cần có: Tòa DEMO A (scope duyệt demo.chunha), sổ "CANARY renamed"
 * (demo.chunha + demo.ketoan CUSTODIAN).
 */

const RPC = (name: string) => new RegExp(`/rest/v1/rpc/${name}\\b`);

// PNG 1×1 — chứng từ tối thiểu cho flow evidence intent→upload→finalize.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Bắt apikey + token user hiện hành từ một request thật của app tới PostgREST. */
async function captureSupabaseAuth(page: Page) {
  const req = await page.waitForRequest((r) => /\/rest\/v1\//.test(r.url()), {
    timeout: 30_000,
  });
  const h = req.headers();
  const base = new URL(req.url()).origin;
  const jwt = (h['authorization'] ?? '').replace(/^Bearer /, '');
  const sub = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString()).sub as string;
  return { base, apikey: h['apikey'], auth: h['authorization'], userId: sub };
}

type SbAuth = Awaited<ReturnType<typeof captureSupabaseAuth>>;

async function sbGet(a: SbAuth, path: string) {
  const r = await fetch(`${a.base}/rest/v1/${path}`, {
    headers: {
      apikey: a.apikey,
      Authorization: a.auth,
      'Accept-Profile': 'public',
    },
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

/** Seed phiếu thu UNAPPROVED qua compat RPC — server ép Chờ duyệt + khai sinh. */
async function seedPendingVoucher(a: SbAuth, name: string) {
  const [b] = await sbGet(a, 'buildings?select=id,organization_id&name=eq.T%C3%B2a%20DEMO%20A&limit=1');
  const [acc] = await sbGet(a, 'accounts?select=id&name=eq.CANARY%20renamed&limit=1');
  const [t] = await sbGet(
    a,
    `income_expense_types?select=id&organization_id=eq.${b.organization_id}&type=eq.income&limit=1`,
  );
  const r = await fetch(`${a.base}/rest/v1/rpc/ie_compat_insert_v2`, {
    method: 'POST',
    headers: {
      apikey: a.apikey,
      Authorization: a.auth,
      'Content-Type': 'application/json',
      'Content-Profile': 'public',
    },
    body: JSON.stringify({
      p_row: {
        user_id: a.userId,
        creator_name: 'E2E Fleet',
        type: 'INCOME',
        name,
        building_id: b.id,
        organization_id: b.organization_id,
        account_id: acc.id,
        attachments: [],
        repeat_cycle: 'NONE',
        repeat_infinity: false,
        repeat_count: 0,
        repeat_auto_approve: true,
        repeat_remaining: 0,
        repeat_next_date: null,
        voucher_date: new Date().toISOString().slice(0, 10),
      },
      p_items: [
        {
          income_expense_type_id: t.id,
          accounting_class: 'PNL',
          description: 'E2E lifecycle',
          quantity: 1,
          unit_price: 45000,
          start_date: null,
          end_date: null,
        },
      ],
    }),
  });
  if (!r.ok) throw new Error(`seed compat → ${r.status} ${await r.text()}`);
}

async function uploadEvidence(page: Page) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Thêm chứng từ' }).click(),
  ]);
  await chooser.setFiles({ name: 'e2e-evidence.png', mimeType: 'image/png', buffer: PNG_1PX });
  await expect(page.getByRole('button', { name: 'Gỡ chứng từ' })).toBeVisible({ timeout: 30_000 });
}

async function findVoucherRow(page: Page, name: string) {
  await page.goto('/income-expense');
  await page.getByRole('tab', { name: 'Tất cả' }).click();
  await page.getByRole('textbox', { name: /Tìm mã phòng/ }).fill(name.slice(0, 30));
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

test('finance-v2-lifecycle', async ({ browser }) => {
  const name = `[E2E-V2] lifecycle ${Date.now()}`;

  // ---- 1. Seed phiếu Chờ duyệt bằng phiên ketoan (compat, server ép UNAPPROVED) ----
  const ctxKetoan = await browser.newContext();
  const pk = await ctxKetoan.newPage();
  await login(pk, 'ketoan');
  const nav = pk.goto('/income-expense');
  const auth = await captureSupabaseAuth(pk);
  await nav;
  await seedPendingVoucher(auth, name);
  const rowK = await findVoucherRow(pk, name);
  await expect(rowK.getByText('Chờ duyệt')).toBeVisible({ timeout: 30_000 });
  await ctxKetoan.close();

  // ---- 2. CHUNHA: Chỉ duyệt → Đã Duyệt - Chưa Thu (không đổi tồn quỹ) ----
  const ctxChunha = await browser.newContext();
  const pc = await ctxChunha.newPage();
  const errs = trackConsoleErrors(pc);
  await login(pc, 'chunha');
  const navC = pc.goto('/income-expense');
  const authC = await captureSupabaseAuth(pc);
  await navC;
  const row = await findVoucherRow(pc, name);
  await row.getByRole('button', { name: 'Duyệt phiếu (đã thanh toán)' }).click();
  const [approveResp] = await Promise.all([
    pc.waitForResponse(
      (r) => RPC('approve_income_expense_v2').test(r.url()) && r.status() === 200,
      { timeout: 30_000 },
    ),
    pc.getByRole('button', { name: 'Chỉ duyệt' }).click(),
  ]);
  expect(approveResp.status()).toBe(200);
  await expect(row.getByText(/Đã Duyệt - Chưa (Thu|Chi)/)).toBeVisible({ timeout: 30_000 });

  // ---- 3. CHUNHA: Thu tiền vào sổ (custodian-post, không cần quyền duyệt) ----
  await row.getByRole('button', { name: /Thu tiền vào sổ|Chi tiền từ sổ/ }).click();
  await pc.getByRole('combobox', { name: 'Sổ quỹ *' }).click();
  await pc.getByRole('option', { name: 'CANARY renamed' }).click();
  await uploadEvidence(pc);
  const [postResp] = await Promise.all([
    pc.waitForResponse(
      (r) => RPC('post_approved_income_expense_v2').test(r.url()) && r.status() === 200,
      { timeout: 30_000 },
    ),
    pc.getByRole('dialog').getByRole('button', { name: /^(Thu|Chi)$/ }).click(),
  ]);
  expect(postResp.status()).toBe(200);
  await expect(row.getByText(/^Đã (Thu|Chi)$/)).toBeVisible({ timeout: 30_000 });

  // ---- 4a. Fail-closed §2.2: phiếu ĐÃ GHI SỔ không huỷ thẳng được ----
  await row.getByRole('button', { name: 'Huỷ phiếu' }).click();
  await pc
    .getByRole('alertdialog')
    .getByRole('button', { name: /Huỷ phiếu|Xác nhận/ })
    .click();
  // Server phải TỪ CHỐI (tiền đã vào sổ — muốn huỷ phải reversal): badge giữ nguyên.
  await pc.waitForTimeout(3_000);
  await expect(row.getByText(/^Đã (Thu|Chi)$/)).toBeVisible();

  // ---- 4b. REVERSAL qua RPC v2 (chưa có UI — §21.1) rồi mới huỷ được ----
  // account_id của phiếu = sổ đã chọn khi seed (CANARY) — khỏi query accounts
  // (RLS đọc trực tiếp bảng accounts có thể chặn theo vai).
  const [v] = await sbGet(
    authC,
    `income_expenses?select=id,account_id&name=eq.${encodeURIComponent(name)}&limit=1`,
  );
  const book = { id: v.account_id as string };
  const rev = await fetch(`${authC.base}/rest/v1/rpc/reverse_posted_income_expense_v2`, {
    method: 'POST',
    headers: {
      apikey: authC.apikey,
      Authorization: authC.auth,
      'Content-Type': 'application/json',
      'Content-Profile': 'public',
    },
    body: JSON.stringify({
      p_voucher: v.id,
      p_cashbook: book.id,
      p_posted_on: new Date().toISOString().slice(0, 10),
      p_reason: 'E2E cleanup reversal',
      p_idempotency_key: `e2e-rev-${Date.now()}`,
    }),
  });
  expect(rev.status, `reversal: ${await rev.clone().text()}`).toBe(200);
  await pc.reload();
  const row2 = await findVoucherRow(pc, name);
  await expect(row2.getByText('Đã hoàn tác')).toBeVisible({ timeout: 30_000 });

  // ---- 4c. Huỷ phiếu (giờ không còn tiền treo) — fixture tự dọn ----
  // Huỷ = CANCELLED + soft-delete ⇒ phiếu BIẾN KHỎI danh sách (mọi tab).
  await row2.getByRole('button', { name: 'Huỷ phiếu' }).click();
  await pc
    .getByRole('alertdialog')
    .getByRole('button', { name: /Huỷ phiếu|Xác nhận/ })
    .click();
  await expect(row2).toHaveCount(0, { timeout: 30_000 });

  // Lỗi 55000 "dùng reversal, không hủy trực tiếp" là fail-closed CỐ Ý ở 4a.
  const unexpected = errs.filter((e) => !/dùng reversal, không hủy trực tiếp/.test(e));
  expect(unexpected, `chunha console: ${unexpected.join(' | ')}`).toEqual([]);
  await ctxChunha.close();
});
