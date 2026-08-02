import { test, expect, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * ĐỢT A/B/C (01/08/2026, org DEMO) — vòng đời PHIẾU THU sau khi đơn giản hoá.
 *
 * Bệnh gốc: chủ bấm huỷ một phiếu thu ở trang Thu chi và nhận nguyên văn tiếng
 * Anh của Postgres — "assert_income_expense_flow_owner_v2: voucher … owned by
 * system flow INVOICE_COLLECTION_V5 (manual RPC expects CANONICAL_INCOME_EXPENSE)"
 * — vì mọi bậc trong thang huỷ 6 tầng đều từ chối phiếu do luồng hệ thống sinh.
 *
 * Bài này chốt bốn điều, đi qua UI thật:
 *   1. Tạo phiếu thu → TỰ DUYỆT + TỰ GHI SỔ ngay (Đợt B).
 *   2. Huỷ ngay tại trang Thu chi → phiếu về "Đã huỷ" (Đợt A).
 *   3. Không còn chuỗi lỗi tiếng Anh nào lọt ra console/toast.
 *   4. Reader can_cancel_income_voucher_v1 nói trước được ai huỷ được (Đợt A).
 *
 * Chỉ ghi vào org DEMO; fixture tự dọn ở cuối bài.
 */

const CANONICAL = /\/rest\/v1\/rpc\/create_income_expense_v1\b/;
const CANCEL_DOOR = /\/rest\/v1\/rpc\/cancel_income_voucher_v1\b/;

/** Chuỗi kỹ thuật KHÔNG được phép hiện ra trước mặt người dùng nữa. */
const LEAKY_ENGLISH = [
  'owned by system flow',
  'assert_income_expense_flow_owner',
  'is frozen',
  'CANONICAL_INCOME_EXPENSE',
];

async function captureSupabaseAuth(page: Page) {
  const req = await page.waitForRequest((r) => /\/rest\/v1\//.test(r.url()), { timeout: 30_000 });
  const h = req.headers();
  return {
    base: new URL(req.url()).origin,
    apikey: h['apikey'] as string,
    auth: h['authorization'] as string,
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

async function sbRpc(a: SbAuth, fn: string, body: unknown) {
  const r = await fetch(`${a.base}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: jsonHeaders(a),
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.text() };
}

test('phieu-thu-tao-la-tu-ghi-so-va-huy-duoc-ngay-tai-trang-thu-chi', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  const name = `E2E huy phieu thu ${Date.now()}`;

  await login(page, 'chunha');
  const nav = page.goto('/income-expense');
  const auth = await captureSupabaseAuth(page);
  await nav;

  // ── Tạo phiếu thu qua UI ────────────────────────────────────────────
  await page.getByRole('button', { name: 'Thêm phiếu' }).click();
  await page.getByRole('menuitem', { name: 'Thêm phiếu lẻ' }).click();
  await expect(page.getByRole('heading', { name: /THÊM PHIẾU THU\/CHI/i })).toBeVisible();

  await page.getByRole('combobox', { name: 'Tòa nhà *' }).click();
  await page.getByRole('option', { name: 'Tòa DEMO B' }).click();
  await page.getByRole('combobox', { name: 'Sổ quỹ *' }).click();
  // Phải là sổ THẬT: sổ ảo cho posting_status = NOT_APPLICABLE (đúng thiết kế —
  // không có bút toán tiền mặt), nên chọn bừa option đầu sẽ đo nhầm Đợt B.
  // Danh sách sổ phụ thuộc possession của từng tài khoản nên không ghim tên cứng;
  // chỉ loại sổ nội bộ (sổ ảo duy nhất của DEMO: "Cấn trừ thanh lý (nội bộ)").
  await page
    .getByRole('option')
    .filter({ hasNotText: /nội bộ/i })
    .first()
    .click();
  await page.getByRole('textbox', { name: /Tên phiếu thu/i }).fill(name);

  await page.getByRole('button', { name: 'Thêm hạng mục' }).click();
  await page.getByRole('checkbox', { name: /Tiền cọc/i }).first().click();
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await page.getByRole('textbox', { name: 'Số tiền' }).first().fill('250000');

  const [createResp] = await Promise.all([
    page.waitForResponse((r) => CANONICAL.test(r.url()) && r.status() === 200, { timeout: 30_000 }),
    page.getByRole('button', { name: /^Lưu$/ }).last().click(),
  ]);
  const created = (await createResp.json()) as { id: string; approval_status?: string };
  const voucherId = created.id;

  try {
    // ── (1) Đợt B: tự duyệt + tự ghi sổ, không phải bấm gì thêm ────────
    expect(created.approval_status, 'phiếu thu phải tự duyệt ngay khi tạo').toBe('APPROVED');
    const [afterCreate] = await sbGet(
      auth,
      `income_expenses?select=posting_status,approval_status&id=eq.${voucherId}`,
    );
    expect(afterCreate.posting_status, 'phiếu thu phải tự GHI SỔ ngay khi tạo').toBe('POSTED');

    // ── (4) Reader nói trước là huỷ được ──────────────────────────────
    const gate = await sbRpc(auth, 'can_cancel_income_voucher_v1', { p_ids: [voucherId] });
    expect(gate.status, `reader: ${gate.body}`).toBe(200);
    const rows = JSON.parse(gate.body) as {
      eligible: boolean;
      mode: string;
      reason_code: string | null;
    }[];
    expect(rows[0]?.eligible, `reader phải cho huỷ: ${gate.body}`).toBe(true);
    expect(rows[0]?.mode).toBe('MANUAL');

    // ── (2) Huỷ ngay tại trang Thu chi ────────────────────────────────
    await page.goto('/income-expense');
    const row = page.locator('tr', { hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    // Phiếu vừa tạo phải hiện "Đã Thu" — tự duyệt + tự ghi sổ, không phải bấm
    // thêm bước nào (Đợt B, đo trên chính giao diện).
    await expect(row).toContainText('Đã Thu');

    // Nút icon-only: accessible name lấy từ `title`. Dùng title CHÍNH XÁC để
    // không dính "Huỷ duyệt" của super admin.
    const cancelBtn = row.locator('button[title="Huỷ phiếu"]');
    await expect(cancelBtn).toBeVisible({ timeout: 15_000 });
    await cancelBtn.click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    // Câu quyền phải là luật MỚI của phiếu thu, không nhắc CUSTODIAN nữa.
    await expect(dialog).toContainText('chính người đã thu');
    await dialog.getByRole('textbox').fill('E2E huy phieu thu dot A');

    const [cancelResp] = await Promise.all([
      page.waitForResponse((r) => CANCEL_DOOR.test(r.url()), { timeout: 30_000 }),
      // Nút hành động là nút CUỐI của AlertDialogFooter ("Huỷ phiếu" hoặc
      // "Huỷ phiếu & trừ khỏi sổ quỹ" tuỳ phiếu đã ghi sổ hay chưa).
      dialog.getByRole('button').last().click(),
    ]);
    expect(
      cancelResp.status(),
      `cửa huỷ phiếu thu: ${await cancelResp.text()}`,
    ).toBe(200);

    // ── (3) Trạng thái thật + bút toán đã triệt tiêu ──────────────────
    const [afterCancel] = await sbGet(
      auth,
      `income_expenses?select=approval_status,posting_status,cancellation_kind&id=eq.${voucherId}`,
    );
    expect(afterCancel.approval_status).toBe('CANCELLED');
    expect(afterCancel.posting_status, 'phiếu đã ghi sổ thì huỷ phải để lại bút toán đảo').toBe(
      'REVERSED',
    );
    expect(afterCancel.cancellation_kind).toBe('CANCELLED_AFTER_POSTING');

    await expect(page.getByText(/Phi[ếe]u thu đã được HU[ỶY]|đã được HU[ỶY]/i).first()).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    // Fixture tự dọn: phiếu đã CANCELLED là trạng thái cuối, không cần xoá thêm.
    // (Giữ lại để đối soát; org DEMO có nút reset riêng.)
  }

  // Không chuỗi kỹ thuật nào lọt ra người dùng.
  const joined = errs.join(' | ');
  for (const needle of LEAKY_ENGLISH) {
    expect(joined, `console rò chuỗi kỹ thuật "${needle}": ${joined}`).not.toContain(needle);
  }
  expect(errs, `console: ${joined}`).toEqual([]);
});

test('nguoi-khong-phai-nguoi-thu-bi-chan-voi-cau-tieng-viet', async ({ browser }) => {
  // Luật #8: chỉ chính người đã thu / chủ tổ chức / super admin. demo.ketoan
  // KHÔNG phải người tạo phiếu của chunha ⇒ reader phải nói NOT_OWNER, và
  // writer phải từ chối bằng câu tiếng Việt (không phải chuỗi Postgres).
  //
  // Hai CONTEXT riêng: đăng nhập đè lên nhau trong cùng context không đưa được
  // về màn /login (app đã có phiên), test sẽ treo ở ô "Tài Khoản".
  const ctxChu = await browser.newContext();
  const page = await ctxChu.newPage();
  await login(page, 'chunha');
  const nav = page.goto('/income-expense');
  const authChu = await captureSupabaseAuth(page);
  await nav;

  const [b] = await sbGet(
    authChu,
    'buildings?select=id,organization_id&name=eq.T%C3%B2a%20DEMO%20A&limit=1',
  );
  const [acc] = await sbGet(
    authChu,
    `accounts?select=id&organization_id=eq.${b.organization_id}&deleted_at=is.null&is_virtual=is.false&limit=1`,
  );
  const [ieType] = await sbGet(
    authChu,
    `income_expense_types?select=id&organization_id=eq.${b.organization_id}&type=eq.income&limit=1`,
  );
  const stamp = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const made = await sbRpc(authChu, 'create_income_expense_v1', {
    p_type: 'INCOME',
    p_name: `E2E chan nguoi khac ${stamp}`,
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
    p_items: [
      {
        income_expense_type_id: ieType.id,
        description: 'e2e chan nguoi khac',
        quantity: 1,
        unit_price: 150_000,
        start_date: today,
        end_date: today,
      },
    ],
    p_idempotency_key: `e2e-notowner-${stamp}`,
  });
  expect(made.status, `tạo phiếu: ${made.body}`).toBe(200);
  const voucherId = (JSON.parse(made.body) as { id: string }).id;

  const ctxKt = await browser.newContext();
  const pageKt = await ctxKt.newPage();
  try {
    // Vai kế toán — KHÔNG phải người đã thu khoản này.
    await login(pageKt, 'ketoan');
    const nav2 = pageKt.goto('/income-expense');
    const authKt = await captureSupabaseAuth(pageKt);
    await nav2;

    const gate = await sbRpc(authKt, 'can_cancel_income_voucher_v1', { p_ids: [voucherId] });
    const rows = JSON.parse(gate.body) as { eligible: boolean; reason_code: string }[];
    expect(rows[0]?.eligible, `reader phải chặn: ${gate.body}`).toBe(false);
    expect(rows[0]?.reason_code).toBe('NOT_OWNER');

    const denied = await sbRpc(authKt, 'cancel_income_voucher_v1', {
      p_voucher: voucherId,
      p_reason: 'E2E nguoi khac thu huy',
    });
    expect(denied.status, 'writer phải từ chối').toBe(403);
    expect(denied.body).toContain('Chỉ người đã thu khoản này');
    for (const needle of LEAKY_ENGLISH) {
      expect(denied.body, `lỗi rò chuỗi kỹ thuật "${needle}"`).not.toContain(needle);
    }
  } finally {
    await sbRpc(authChu, 'cancel_income_voucher_v1', {
      p_voucher: voucherId,
      p_reason: 'E2E cleanup fixture',
    }).catch(() => {});
    await ctxKt.close().catch(() => {});
    await ctxChu.close().catch(() => {});
  }
});
