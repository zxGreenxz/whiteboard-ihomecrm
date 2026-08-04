import { test, expect, type Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * ĐỢT C (01/08/2026, org DEMO) — ĐỔI SỔ QUỸ của phiếu THU ĐÃ GHI SỔ.
 *
 * Trước đợt này không có đường nào: ô "Sổ quỹ" đã bị gỡ khỏi hộp thoại sửa
 * nhanh (Đợt 2) vì đường cũ UPDATE thẳng account_id không kiểm gì — cầu a85 sẽ
 * đảo bút toán sổ cũ và ghi sổ mới, tiền rời két người khác mà không ai duyệt.
 *
 * Nay có RPC riêng move_income_voucher_cashbook_v1: sổ ĐI phải đang GIỮ, sổ ĐẾN
 * chỉ cần GIỮ hoặc BIẾT, bắt buộc lý do ≥8 ký tự, ba khoá thời gian vẫn chặn,
 * và server tự kiểm tiền đã rời hẳn sổ cũ.
 *
 * Bài này chốt, đi qua UI thật:
 *   1. Ô "Sổ quỹ" HIỆN LẠI trong hộp thoại sửa nhanh của phiếu THU.
 *   2. Đổi sổ xong: tiền rời hẳn sổ cũ (số dư dòng bút toán = 0) và có đủ ở sổ mới.
 *   3. Phiếu vẫn ở trạng thái đã ghi sổ, không sinh phiếu đối ứng nào.
 *   4. Nhật ký before/after ghi lại được thay đổi (yêu cầu "chỉ cần ghi log").
 *   5. Phiếu CHI KHÔNG có ô sổ quỹ ở màn này (hai đường tách hẳn).
 */

const MOVE_RPC = /\/rest\/v1\/rpc\/move_income_voucher_cashbook_v1\b/;

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

/** Tổng số dư bút toán của phiếu trên MỘT sổ quỹ. */
async function bookNet(a: SbAuth, voucherId: string, accountId: string): Promise<number> {
  const rows = (await sbGet(
    a,
    `income_expense_posting_lines?select=signed_amount,posting_id!inner(posting_subject_kind,posting_subject_id)` +
      `&account_id=eq.${accountId}` +
      `&posting_id.posting_subject_kind=eq.VOUCHER&posting_id.posting_subject_id=eq.${voucherId}`,
  )) as { signed_amount: string }[];
  return rows.reduce((s, r) => s + Number(r.signed_amount), 0);
}

test('doi-so-quy-phieu-thu-da-ghi-so-tien-roi-han-so-cu', async ({ page }) => {
  const errs = trackConsoleErrors(page);
  const stamp = Date.now();
  const name = `E2E doi so quy ${stamp}`;

  await login(page, 'chunha');
  const nav = page.goto('/income-expense');
  const auth = await captureSupabaseAuth(page);
  await nav;

  // ── Fixture: phiếu thu đã ghi sổ, tạo bằng writer canonical ─────────
  const [b] = await sbGet(
    auth,
    'buildings?select=id,organization_id&name=eq.T%C3%B2a%20DEMO%20A&limit=1',
  );
  // Đúng RPC mà giao diện dùng để dựng dropdown (useMyCashbookAccess):
  // sổ ĐI cần CUSTODIAN, sổ ĐẾN chỉ cần CUSTODIAN hoặc KNOWER.
  const accessRes = await sbRpc(auth, 'list_my_cashbook_access_v2', {});
  expect(accessRes.status, `list_my_cashbook_access_v2: ${accessRes.body}`).toBe(200);
  const access = JSON.parse(accessRes.body) as {
    cashbook_id: string;
    possession_kind: string;
  }[];
  const custodianIds = access
    .filter((r) => r.possession_kind === 'CUSTODIAN')
    .map((r) => r.cashbook_id);

  // GOTCHA đã cắn khi viết bài này: KHÔNG lọc qua bảng `accounts` — RLS của nó
  // hẹp hơn possession rất nhiều (chunha giữ 5 sổ DEMO nhưng chỉ NHÌN được 1),
  // lọc như vậy sẽ bỏ sót gần hết sổ hợp lệ. Dùng thẳng cashbook_name của RPC.
  // Chỉ loại sổ ẢO, và chỉ khi bảng accounts cho biết được.
  const visible = (await sbGet(
    auth,
    `accounts?select=id,is_virtual&organization_id=eq.${b.organization_id}`,
  )) as { id: string; is_virtual: boolean }[];
  const virtualIds = visible.filter((a) => a.is_virtual).map((a) => a.id);

  const byName = new Map<string, { id: string; name: string }>();
  for (const r of access) {
    if (r.possession_kind !== 'CUSTODIAN') continue;
    if (virtualIds.includes(r.cashbook_id)) continue;
    const nm = (r as { cashbook_name?: string }).cashbook_name;
    // Sổ rác của các phiên E2E cũ có tên trùng lặp / vô nghĩa — bỏ để dropdown
    // không dính strict-mode violation của Playwright.
    if (!nm || /E2E|CANARY|tmp/i.test(nm)) continue;
    if (!byName.has(nm)) byName.set(nm, { id: r.cashbook_id, name: nm });
  }
  const distinct = [...byName.values()];
  expect(
    distinct.length,
    `cần ≥2 sổ quỹ chunha đang GIỮ có tên phân biệt, có ${distinct.length} (access=${access.length}, custodian=${custodianIds.length})`,
  ).toBeGreaterThanOrEqual(2);



  const [ieType] = await sbGet(
    auth,
    `income_expense_types?select=id&organization_id=eq.${b.organization_id}&type=eq.income&limit=1`,
  );
  const today = new Date().toISOString().slice(0, 10);

  // GOTCHA THỨ HAI (đo prod 01/08/2026): writer TẠO phiếu (create_income_expense_v1)
  // còn dùng mô hình sổ quỹ LEGACY (accounts.user_id + account_shared_users),
  // KHÁC mô hình possession mà đường đổi sổ dùng. Giữ CUSTODIAN chưa chắc tạo
  // được phiếu vào sổ đó. Nên thử lần lượt tới khi có sổ tạo được, thay vì ghim
  // cứng — bám đúng thực tế thay vì giả định hai mô hình đã thống nhất.
  let voucherId = '';
  let from = distinct[0];
  for (const candidate of distinct) {
    const made = await sbRpc(auth, 'create_income_expense_v1', {
      p_type: 'INCOME',
      p_name: name,
      p_building_id: b.id,
      p_room_id: null,
      p_tenant_id: null,
      p_contract_id: null,
      p_payer_name: null,
      p_receive_bank_account: null,
      p_receive_bank_name: null,
      p_account_id: candidate.id,
      p_attachments: [],
      p_business_result_accounting: null,
      p_notes: null,
      p_voucher_date: today,
      p_items: [
        {
          income_expense_type_id: ieType.id,
          description: 'e2e doi so quy',
          quantity: 1,
          unit_price: 320_000,
          start_date: today,
          end_date: today,
        },
      ],
      p_idempotency_key: `e2e-movebook-${stamp}-${candidate.id.slice(0, 8)}`,
    });
    if (made.status === 200) {
      voucherId = (JSON.parse(made.body) as { id: string }).id;
      from = candidate;
      break;
    }
  }
  expect(voucherId, 'không tạo được phiếu thu ở bất kỳ sổ nào chunha đang giữ').toBeTruthy();
  const to = distinct.find((d) => d.id !== from.id)!;

  try {
    expect(await bookNet(auth, voucherId, from.id), 'tiền phải nằm ở sổ ban đầu').toBe(320_000);

    // ── Đổi sổ qua UI: hộp thoại sửa nhanh ────────────────────────────
    await page.goto('/income-expense');
    const row = page.locator('tr', { hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.locator('button[title*="Sửa sổ quỹ"]').first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // (1) Ô sổ quỹ phải hiện lại cho phiếu THU.
    await expect(dialog).toContainText('SỬA SỔ QUỸ');
    const bookSelect = dialog.getByRole('combobox').first();
    await expect(bookSelect).toBeVisible();
    await bookSelect.click();
    await page.getByRole('option', { name: to.name, exact: true }).click();

    // Lý do bắt buộc — nút Lưu phải khoá khi chưa đủ 8 ký tự.
    const saveBtn = dialog.getByRole('button', { name: /^Lưu$/ });
    await expect(saveBtn).toBeDisabled();
    await dialog.getByRole('textbox').first().fill('E2E doi so quy dot C');

    const [moveResp] = await Promise.all([
      page.waitForResponse((r) => MOVE_RPC.test(r.url()), { timeout: 30_000 }),
      saveBtn.click(),
    ]);
    expect(moveResp.status(), `RPC đổi sổ: ${await moveResp.text()}`).toBe(200);

    // ── (2)(3) Tiền rời hẳn sổ cũ, đủ ở sổ mới, phiếu vẫn đã ghi sổ ───
    expect(await bookNet(auth, voucherId, from.id), 'sổ CŨ phải sạch').toBe(0);
    expect(await bookNet(auth, voucherId, to.id), 'sổ MỚI phải nhận đủ').toBe(320_000);

    const [after] = await sbGet(
      auth,
      `income_expenses?select=account_id,posting_status,approval_status&id=eq.${voucherId}`,
    );
    expect(after.account_id, 'header phải trỏ sổ mới').toBe(to.id);
    expect(after.posting_status, 'phiếu vẫn phải ở trạng thái đã ghi sổ').toBe('POSTED');
    expect(after.approval_status).toBe('APPROVED');

    // Không sinh phiếu đối ứng nào trong danh sách.
    const counter = (await sbGet(
      auth,
      `income_expenses?select=id&reversal_of_income_expense_id=eq.${voucherId}`,
    )) as unknown[];
    expect(counter.length, 'đổi sổ KHÔNG được sinh phiếu đối ứng').toBe(0);

    // ── (4) Nhật ký ghi lại được thay đổi ─────────────────────────────
    const logRes = await sbRpc(auth, 'get_voucher_change_log_v1', { p_voucher: voucherId });
    expect(logRes.status).toBe(200);
    expect(logRes.body, 'nhật ký phải ghi lại việc đổi account_id').toContain('account_id');
  } finally {
    await sbRpc(auth, 'cancel_income_voucher_v1', {
      p_voucher: voucherId,
      p_reason: 'E2E cleanup doi so quy',
    }).catch(() => {});
  }

  expect(errs, `console: ${errs.join(' | ')}`).toEqual([]);
});

test('phieu-chi-khong-co-o-so-quy-o-man-sua-nhanh', async ({ page }) => {
  // Hai đường tách hẳn: đổi sổ quỹ CHỈ dành cho phiếu THU.
  await login(page, 'chunha');
  await page.goto('/income-expense');

  // Lọc sang phiếu chi: tìm dòng có số tiền âm (phiếu chi hiển thị dấu trừ).
  const expenseRow = page.locator('tr', { hasText: /-[\d.]+ đ/ }).first();
  await expect(expenseRow).toBeVisible({ timeout: 30_000 });

  const quickEdit = expenseRow.locator('button[title*="Sửa"]').first();
  await expect(quickEdit).toBeVisible();
  // Title của phiếu chi KHÔNG được hứa sửa sổ quỹ.
  await expect(quickEdit).toHaveAttribute('title', /^Sửa hình ảnh/);

  await quickEdit.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('BỔ SUNG CHỨNG TỪ');
  await expect(dialog).not.toContainText('SỬA SỔ QUỸ');
});
