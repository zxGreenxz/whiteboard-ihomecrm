import { test, expect, Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * HỒI QUY cho lỗi chủ báo 27/08/2026:
 *
 *   "tôi bấm hủy chi rồi bấm chi lại thêm ảnh chứng từ nhưng sau đó không thấy
 *    ảnh đó trong dòng thu chi … có nghĩa là bấm chi lại đã thêm ảnh chi thành
 *    công, nhưng khi ra ngoài màn thu chi thì không có ảnh chứng từ đó"
 *
 * Nguyên nhân: ảnh dán trong hộp thoại Thu/Chi đi vào `finance_evidence_objects`
 * (path `v2/<org>/<mid>/<uuid>`, không đuôi file), còn mọi chỗ hiển thị chỉ đọc
 * `income_expenses.attachments`. Hai kho tách rời ⇒ ảnh chi xong biến mất khỏi
 * mắt người dùng. Đo trên phiếu thật "Cọc giữ phòng MB Toà nhà 158PVC":
 * 6 chứng từ / 0 ảnh đính kèm.
 *
 * Test này khoá hành vi mới: dán ảnh = đính ảnh LÊN PHIẾU rồi nhận chính nó làm
 * chứng từ ⇒ `attachments` phải tăng, và tăng NGAY khi dán (không đợi bấm Thu).
 *
 * Chạy (org DEMO):
 *   FLEET_PASS_CHUNHA=... npx playwright test specs/chung-tu-la-anh-dinh-kem.spec.ts
 * Chạy trên bản đang sửa ở máy:
 *   FLEET_BASE_URL=http://localhost:8080 FLEET_PASS_CHUNHA=... npx playwright test ...
 *
 * ĐANG THIẾU FIXTURE (đo 27/08/2026): org DEMO **không còn binding giữ sổ nào**
 * (`cashbook_possession_bindings` rỗng cho toàn bộ sổ DEMO), nên không ai là
 * CUSTODIAN ⇒ nút "Thu tiền vào sổ" không hiện và `ie_compat_insert_v2` từ chối
 * ngay ở bước seed ("Bạn không phải Người giữ sổ của sổ này"). Mọi spec đụng
 * Posting dialog — kể cả `finance-v2.spec.ts` có sẵn — đều chết từ đó.
 * Không tự cấp được: `set_cashbook_access_v2` đòi quyền `cashbooks.share` (cả
 * demo.quanly lẫn demo.ketoan đều 42501) và server cấm tự đổi vai của chính mình.
 * Muốn chạy lại: cấp CUSTODIAN cho demo.chunha trên "DEMO Quỹ tiền mặt" bằng một
 * tài khoản có `cashbooks.share` trong org DEMO. Tên fixture cũng đã đổi
 * (`Tòa DEMO A` → `DEMO Toà A`, `CANARY renamed` → `DEMO Quỹ tiền mặt`).
 */

const RPC = (name: string) => new RegExp(`/rest/v1/rpc/${name}\\b`);

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function captureSupabaseAuth(page: Page) {
  const req = await page.waitForRequest((r) => /\/rest\/v1\//.test(r.url()), { timeout: 30_000 });
  const h = req.headers();
  const base = new URL(req.url()).origin;
  const jwt = (h['authorization'] ?? '').replace(/^Bearer /, '');
  const sub = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString()).sub as string;
  return { base, apikey: h['apikey'], auth: h['authorization'], userId: sub };
}
type SbAuth = Awaited<ReturnType<typeof captureSupabaseAuth>>;

async function sbGet(a: SbAuth, path: string) {
  const r = await fetch(`${a.base}/rest/v1/${path}`, {
    headers: { apikey: a.apikey, Authorization: a.auth, 'Accept-Profile': 'public' },
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

function rpcHeaders(a: SbAuth) {
  return {
    apikey: a.apikey,
    Authorization: a.auth,
    'Content-Type': 'application/json',
    'Content-Profile': 'public',
  };
}

async function seedPendingVoucher(a: SbAuth, name: string) {
  const [b] = await sbGet(
    a,
    'buildings?select=id,organization_id&name=eq.DEMO%20To%C3%A0%20A&limit=1',
  );
  const [acc] = await sbGet(a, 'accounts?select=id&name=eq.DEMO%20Qu%E1%BB%B9%20ti%E1%BB%81n%20m%E1%BA%B7t&limit=1');
  const [t] = await sbGet(
    a,
    `income_expense_types?select=id&organization_id=eq.${b.organization_id}&type=eq.income&limit=1`,
  );
  const r = await fetch(`${a.base}/rest/v1/rpc/ie_compat_insert_v2`, {
    method: 'POST',
    headers: rpcHeaders(a),
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
          description: 'E2E chung tu = anh dinh kem',
          quantity: 1,
          unit_price: 33000,
          start_date: null,
          end_date: null,
        },
      ],
    }),
  });
  if (!r.ok) throw new Error(`seed compat → ${r.status} ${await r.text()}`);
}

async function getVoucher(a: SbAuth, name: string) {
  const [v] = await sbGet(
    a,
    `income_expenses?select=id,attachments,posting_status&name=eq.${encodeURIComponent(name)}&limit=1`,
  );
  if (!v) throw new Error(`Không tìm thấy phiếu seed: ${name}`);
  return v as { id: string; attachments: string[] | null; posting_status: string | null };
}

async function countAttachments(a: SbAuth, id: string): Promise<number> {
  const [v] = await sbGet(a, `income_expenses?select=attachments&id=eq.${id}`);
  return ((v?.attachments ?? []) as string[]).length;
}

async function approveVoucherRest(a: SbAuth, voucherId: string) {
  const r = await fetch(`${a.base}/rest/v1/rpc/approve_income_expense_v2`, {
    method: 'POST',
    headers: rpcHeaders(a),
    body: JSON.stringify({
      p_voucher: voucherId,
      p_expected_approval_version: 1,
      p_idempotency_key: `e2e-approve-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  if (!r.ok) throw new Error(`approve v2 → ${r.status} ${await r.text()}`);
}

async function cleanupVoucher(a: SbAuth, voucherId: string) {
  try {
    const [st] = await sbGet(
      a,
      `income_expenses?select=approval_status,posting_status,account_id&id=eq.${voucherId}`,
    );
    if (!st || st.approval_status === 'CANCELLED') return;
    if (st.posting_status === 'POSTED') {
      await fetch(`${a.base}/rest/v1/rpc/reverse_posted_income_expense_v2`, {
        method: 'POST',
        headers: rpcHeaders(a),
        body: JSON.stringify({
          p_voucher: voucherId,
          p_cashbook: st.account_id,
          p_posted_on: new Date().toISOString().slice(0, 10),
          p_reason: 'e2e cleanup reverse',
          p_idempotency_key: `e2e-clean-rev-${voucherId}-${Date.now()}`,
        }),
      });
    }
    await fetch(`${a.base}/rest/v1/rpc/ie_compat_cancel_v2`, {
      method: 'POST',
      headers: rpcHeaders(a),
      body: JSON.stringify({ p_ids: [voucherId], p_reason: 'e2e cleanup' }),
    });
  } catch {
    // best-effort — không chặn kết thúc test.
  }
}

async function findVoucherRow(page: Page, name: string) {
  await page.goto('/income-expense');
  await page.getByRole('tab', { name: 'Tất cả' }).click();
  await page.getByRole('textbox', { name: /Tìm mã phòng/ }).fill(name.slice(0, 30));
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

/** Dán một ảnh vào ô chứng từ và đợi nó được đính LÊN PHIẾU. */
async function addEvidence(page: Page, fileName: string) {
  const dialog = page.getByRole('dialog');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    dialog.getByRole('button', { name: 'Thêm chứng từ' }).click(),
  ]);
  await Promise.all([
    page.waitForResponse(
      (r) => RPC('annotate_income_expense_v1').test(r.url()) && r.status() === 200,
      { timeout: 30_000 },
    ),
    chooser.setFiles({ name: fileName, mimeType: 'image/png', buffer: PNG_1PX }),
  ]);
}

async function chonSoQuy(page: Page) {
  await page.getByRole('dialog').getByRole('combobox', { name: 'Sổ quỹ *' }).click();
  await page.getByRole('option', { name: 'DEMO Quỹ tiền mặt' }).click();
}

test('chứng từ dán lúc Thu/Chi là ảnh đính kèm của phiếu — hiện ở dòng thu chi', async ({
  browser,
}) => {
  const name = `[E2E-CT] anh chung tu ${Date.now()}`;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = trackConsoleErrors(page);
  let auth: SbAuth | null = null;
  let voucherId: string | null = null;

  try {
    await login(page, 'chunha');
    const nav = page.goto('/income-expense');
    auth = await captureSupabaseAuth(page);
    await nav;

    await seedPendingVoucher(auth, name);
    const v = await getVoucher(auth, name);
    voucherId = v.id;
    expect(v.attachments ?? []).toHaveLength(0); // xuất phát: phiếu chưa có ảnh nào
    await approveVoucherRest(auth, voucherId);

    // ---- 1. Mở hộp thoại Thu, dán ảnh: phải thấy THUMBNAIL, không phải dòng chữ ----
    let row = await findVoucherRow(page, name);
    await row.getByRole('button', { name: /Thu tiền vào sổ|Chi tiền từ sổ/ }).click();
    const dialog = page.getByRole('dialog');
    await chonSoQuy(page);

    await addEvidence(page, 'e2e-chung-tu-1.png');
    // Ảnh thu nhỏ thật (thẻ <img>), không phải dòng chữ "Chứng từ 1" như bản cũ.
    await expect(dialog.getByRole('img', { name: 'Chứng từ' }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog.getByText(/1 ảnh tính là chứng từ/)).toBeVisible();

    // ---- 2. Ảnh vào phiếu NGAY, không đợi bấm Thu (bấm Huỷ bỏ vẫn còn) ----
    expect(await countAttachments(auth, voucherId)).toBe(1);
    await dialog.getByRole('button', { name: 'Huỷ bỏ' }).click();
    row = await findVoucherRow(page, name);
    await expect(row.getByRole('img', { name: 'Đính kèm' })).toBeVisible({ timeout: 30_000 });

    // ---- 3. Thu thật ----
    await row.getByRole('button', { name: /Thu tiền vào sổ|Chi tiền từ sổ/ }).click();
    await chonSoQuy(page);
    await Promise.all([
      page.waitForResponse(
        (r) => RPC('post_approved_income_expense_v2').test(r.url()) && r.status() === 200,
        { timeout: 30_000 },
      ),
      page.getByRole('dialog').getByRole('button', { name: /^(Thu|Chi)$/ }).click(),
    ]);
    await expect(row.getByText(/^Đã (Thu|Chi)$/)).toBeVisible({ timeout: 30_000 });

    // ---- 4. HOÀN TÁC rồi THU LẠI — đúng luồng chủ báo ----
    await row.getByRole('button', { name: /Mở lại \(tiền (rời|về) sổ/ }).click();
    await page.getByRole('alertdialog').getByRole('textbox').fill('E2E hoàn tác để thu lại');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Hoàn tác' }).click();
    await expect
      .poll(async () => (await getVoucher(auth!, name)).posting_status, { timeout: 30_000 })
      .toBe('REVERSED');

    await page.reload();
    row = await findVoucherRow(page, name);
    await row.getByRole('button', { name: /Thu tiền vào sổ|Chi tiền từ sổ/ }).click();
    const dialog2 = page.getByRole('dialog');
    await chonSoQuy(page);

    // Ảnh của lần thu trước phải NÓI RÕ vì sao không dùng lại được (luật one-shot).
    await expect(dialog2.getByText(/Đã dùng cho lần ghi sổ trước/)).toBeVisible({
      timeout: 30_000,
    });

    await addEvidence(page, 'e2e-chung-tu-2.png');
    await Promise.all([
      page.waitForResponse(
        (r) => RPC('post_approved_income_expense_v2').test(r.url()) && r.status() === 200,
        { timeout: 30_000 },
      ),
      dialog2.getByRole('button', { name: /^(Thu|Chi)$/ }).click(),
    ]);
    await expect(row.getByText(/^Đã (Thu|Chi)$/)).toBeVisible({ timeout: 30_000 });

    // ---- 5. ĐÍCH: ảnh của lần thu lại có mặt trên phiếu (dòng thu chi thấy được) ----
    expect(await countAttachments(auth, voucherId)).toBe(2);
    await page.reload();
    row = await findVoucherRow(page, name);
    await expect(row.getByRole('img', { name: 'Đính kèm' })).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText('+1')).toBeVisible();

    expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
  } finally {
    if (auth && voucherId) await cleanupVoucher(auth, voucherId);
    await ctx.close();
  }
});
