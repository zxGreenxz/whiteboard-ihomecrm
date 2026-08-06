import { test, expect, type Page, type Browser } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * MA TRẬN QUYỀN TRÊN GIAO DIỆN — org TEST (bản sao dữ liệu công ty thật).
 *
 * Ma trận ở tầng RPC đã chạy 124 ca bằng SQL (4 người × 8 loại phiếu × 3 hành
 * động, cộng trang Thu tiền / tạo phiếu / phiếu chi / cách ly tổ chức). Bài này
 * chốt phần SQL không thấy được: **giao diện có nói đúng thứ server sẽ làm hay
 * không** — nút bật khi được phép, mờ kèm lý do khi không, và mọi cửa chặn đều
 * bằng tiếng Việt.
 *
 * Hai vai đối lập trên CÙNG một phiếu do quản lý toà tạo:
 *   · test.joey            — QUẢN LÝ TOÀ, là NGƯỜI ĐÃ THU  → phải huỷ được.
 *   · test.nguyentamca165  — CHỦ TỔ CHỨC                    → cũng phải huỷ được.
 * và chiều ngược lại: phiếu do CHỦ tạo thì quản lý toà bị chặn NOT_OWNER.
 */

const CANCEL_DOOR = /\/rest\/v1\/rpc\/cancel_income_voucher_v1\b/;

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

/**
 * Tìm dòng phiếu theo tên. Org TEST là bản sao dữ liệu thật (hàng nghìn phiếu)
 * nên phiếu vừa tạo KHÔNG nằm ở trang đầu — phải lọc qua ô tìm kiếm đúng như
 * người dùng thật.
 */
async function findVoucherRow(page: Page, name: string) {
  await page.goto('/income-expense');
  const search = page.getByPlaceholder(/mã phi[ếe]u|mã phòng/i).first();
  await expect(search).toBeVisible({ timeout: 30_000 });
  await search.fill(name);
  const row = page.locator('tr', { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

async function openAs(browser: Browser, who: 'testchu' | 'testketoan') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = trackConsoleErrors(page);
  await login(page, who);
  const nav = page.goto('/income-expense');
  const auth = await captureSupabaseAuth(page);
  await nav;
  return { ctx, page, auth, errs };
}

/** Tạo phiếu THU bằng chính tài khoản đang mở; trả id (hoặc '' nếu bị chặn). */
async function createIncomeAs(a: SbAuth, name: string, stamp: number): Promise<string> {
  // Lấy toà + hạng mục trong TẦM NHÌN của chính tài khoản đó.
  const seen = (await sbGet(
    a,
    `income_expenses?select=building_id,organization_id&type=eq.INCOME&deleted_at=is.null` +
      `&building_id=not.is.null&order=voucher_date.desc&limit=1`,
  )) as { building_id: string; organization_id: string }[];
  if (!seen.length) return '';
  const [t] = await sbGet(
    a,
    `income_expense_types?select=id&organization_id=eq.${seen[0].organization_id}&type=eq.income&limit=1`,
  );
  const access = JSON.parse((await sbRpc(a, 'list_my_cashbook_access_v2', {})).body) as {
    cashbook_id: string;
    possession_kind: string;
  }[];
  const today = new Date().toISOString().slice(0, 10);

  // Writer TẠO còn dùng mô hình sổ quỹ LEGACY (accounts.user_id +
  // account_shared_users), khác possession — giữ CUSTODIAN chưa chắc tạo được.
  for (const bk of access.filter((r) => r.possession_kind === 'CUSTODIAN')) {
    const made = await sbRpc(a, 'create_income_expense_v1', {
      p_type: 'INCOME',
      p_name: name,
      p_building_id: seen[0].building_id,
      p_room_id: null,
      p_tenant_id: null,
      p_contract_id: null,
      p_payer_name: null,
      p_receive_bank_account: null,
      p_receive_bank_name: null,
      p_account_id: bk.cashbook_id,
      p_attachments: [],
      p_business_result_accounting: null,
      p_notes: null,
      p_voucher_date: today,
      p_items: [
        {
          income_expense_type_id: t.id,
          description: 'e2e ma tran quyen',
          quantity: 1,
          unit_price: 190_000,
          start_date: today,
          end_date: today,
        },
      ],
      p_idempotency_key: `e2e-matrix-${stamp}-${bk.cashbook_id.slice(0, 8)}`,
    });
    if (made.status === 200) return (JSON.parse(made.body) as { id: string }).id;
  }
  return '';
}

test('nguoi-da-thu-huy-duoc-tren-giao-dien; nguoi-khac-bi-chan', async ({ browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const nameQl = `E2E matran QL ${stamp}`;
  const nameChu = `E2E matran CHU ${stamp}`;

  const ql = await openAs(browser, 'testketoan');
  const chu = await openAs(browser, 'testchu');
  let idQl = '';
  let idChu = '';

  try {
    // ══ Fixture 1: phiếu do QUẢN LÝ TOÀ tự thu ═══════════════════════
    idQl = await createIncomeAs(ql.auth, nameQl, stamp);
    expect(idQl, 'quản lý toà phải tạo được phiếu thu').toBeTruthy();

    // Đợt B: tạo là tự duyệt + tự ghi sổ, không bấm thêm bước nào.
    const [fresh] = await sbGet(
      ql.auth,
      `income_expenses?select=approval_status,posting_status&id=eq.${idQl}`,
    );
    expect(fresh.approval_status, 'phiếu thu phải tự duyệt').toBe('APPROVED');
    expect(fresh.posting_status, 'phiếu thu phải tự ghi sổ').toBe('POSTED');

    // ── Chiều ĐƯỢC PHÉP: người đã thu thấy nút BẬT và huỷ được ───────
    const rowQl = await findVoucherRow(ql.page, nameQl);
    const btnQl = rowQl.locator('button[title="Huỷ phiếu"]');
    await expect(btnQl, 'người đã thu phải thấy nút Huỷ bật').toBeEnabled();
    await btnQl.click();

    const dlg = ql.page.getByRole('alertdialog');
    await expect(dlg).toBeVisible();
    // Câu quyền phải là luật MỚI của phiếu thu.
    await expect(dlg).toContainText('chính người đã thu');
    await dlg.getByRole('textbox').fill('E2E quan ly toa huy phieu cua minh');
    const [resp] = await Promise.all([
      ql.page.waitForResponse((r) => CANCEL_DOOR.test(r.url()), { timeout: 30_000 }),
      dlg.getByRole('button').last().click(),
    ]);
    expect(resp.status(), `người đã thu phải huỷ được: ${await resp.text()}`).toBe(200);

    const [afterQl] = await sbGet(
      ql.auth,
      `income_expenses?select=approval_status,posting_status&id=eq.${idQl}`,
    );
    expect(afterQl.approval_status).toBe('CANCELLED');
    expect(afterQl.posting_status, 'phiếu đã ghi sổ thì huỷ phải để lại bút toán đảo').toBe(
      'REVERSED',
    );

    // ══ Fixture 2: phiếu do CHỦ TỔ CHỨC thu ══════════════════════════
    idChu = await createIncomeAs(chu.auth, nameChu, stamp + 1);
    expect(idChu, 'chủ tổ chức phải tạo được phiếu thu').toBeTruthy();

    // ── Chiều BỊ CHẶN: quản lý toà KHÔNG phải người thu ──────────────
    const gate = JSON.parse(
      (await sbRpc(ql.auth, 'can_cancel_income_voucher_v1', { p_ids: [idChu] })).body,
    ) as { eligible: boolean; reason_code: string }[];
    // Reader bỏ qua im lặng phiếu ngoài tầm nhìn; nếu có trả dòng thì phải chặn.
    //
    // Nhánh rỗng là HỢP LỆ nhưng phải NHÌN THẤY ĐƯỢC: khi reader không trả dòng
    // nào, hai khẳng định dưới đây không chạy, và nếu điều đó xảy ra mãi thì phần
    // kiểm reason_code của reader im lặng ngừng được kiểm. Ghi annotation để đọc
    // được từ báo cáo Playwright thay vì biến mất.
    // (Bảo đảm an ninh CỐT LÕI — writer từ chối 403 — nằm NGOÀI if, luôn chạy.)
    if (gate.length) {
      expect(gate[0].eligible, 'quản lý toà KHÔNG được huỷ phiếu người khác').toBe(false);
      expect(gate[0].reason_code).toBe('NOT_OWNER');
    } else {
      test.info().annotations.push({
        type: 'khong-kiem-duoc',
        description:
          'can_cancel_income_voucher_v1 trả 0 dòng cho quản lý toà — bỏ qua kiểm reason_code của reader lần này',
      });
    }
    const denied = await sbRpc(ql.auth, 'cancel_income_voucher_v1', {
      p_voucher: idChu,
      p_reason: 'E2E quan ly toa thu huy phieu nguoi khac',
    });
    expect(denied.status, 'writer phải từ chối người không phải người thu').toBe(403);
    expect(denied.body).toContain('Chỉ người đã thu khoản này');
    for (const leak of ['owned by system flow', 'is frozen', 'CANONICAL_INCOME_EXPENSE']) {
      expect(denied.body, `lỗi rò chuỗi kỹ thuật "${leak}"`).not.toContain(leak);
    }

    // ── Chủ tổ chức huỷ được chính phiếu đó ─────────────────────────
    const rowChu = await findVoucherRow(chu.page, nameChu);
    const btnChu = rowChu.locator('button[title="Huỷ phiếu"]');
    await expect(btnChu, 'chủ tổ chức phải thấy nút Huỷ bật').toBeEnabled();
    await btnChu.click();
    const dlg2 = chu.page.getByRole('alertdialog');
    await expect(dlg2).toBeVisible();
    await dlg2.getByRole('textbox').fill('E2E chu to chuc huy phieu thu');
    const [resp2] = await Promise.all([
      chu.page.waitForResponse((r) => CANCEL_DOOR.test(r.url()), { timeout: 30_000 }),
      dlg2.getByRole('button').last().click(),
    ]);
    expect(resp2.status(), `chủ tổ chức phải huỷ được: ${await resp2.text()}`).toBe(200);
  } finally {
    for (const [a, id] of [
      [chu.auth, idQl],
      [chu.auth, idChu],
    ] as const) {
      if (id) {
        await sbRpc(a, 'cancel_income_voucher_v1', {
          p_voucher: id,
          p_reason: 'E2E cleanup ma tran quyen',
        }).catch(() => {});
      }
    }
    await ql.ctx.close().catch(() => {});
    await chu.ctx.close().catch(() => {});
  }
});
