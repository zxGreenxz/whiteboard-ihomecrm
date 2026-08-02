import { test, expect, Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Finance V2 — HUỶ phiếu trên TRANG MOBILE (viewport 390×844, org DEMO).
 *
 * Bối cảnh vừa ship (working tree, chưa prod → chạy trên dev server localhost):
 *   - Dialog huỷ POSTED-AWARE: phiếu ĐÃ THU/CHI bấm Huỷ → cảnh báo "HOÀN TÁC
 *     tiền thật" + Textarea lý do + nút "Hoàn tác & Huỷ phiếu" (client tự reverse
 *     rồi cancel). Xem IncomeExpenseMobilePage.tsx (cancelTargetPosted).
 *   - Huỷ phiếu REVERSED: statusMutations.approvedShape đã nới phủ posting REVERSED
 *     → cancel_income_expense_v1 409 → fallback ie_compat_cancel_v2 → CANCELLED.
 *
 * 2 test (fleet CHUNHA — vừa có quyền duyệt vừa CUSTODIAN sổ "CANARY renamed"):
 *   1. Mobile huỷ phiếu ĐÃ CHI  → posted-aware → REVERSED + CANCELLED.
 *   2. Mobile huỷ phiếu REVERSED → dialog thường → CANCELLED.
 *
 * Assert DB thật qua REST (sbGet), KHÔNG dựa UI list. Fixture tự dọn; xác nhận
 * balance sổ CANARY renamed về nguyên trạng (REST accounts_with_balance).
 *
 * Chạy (dev server chứa working tree):
 *   cd .e2e-fleet && FLEET_BASE_URL=http://localhost:8080 \
 *     FLEET_PASS_CHUNHA=... npx playwright test \
 *     specs/finance-v2-mobile-cancel.spec.ts --workers=1
 */

// PNG 1×1 — chứng từ tối thiểu cho posting (evidence bắt buộc §2.2/§6.3).
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Bắt apikey + token user ĐÃ ĐĂNG NHẬP (role authenticated) từ request tới
 *  PostgREST. Trên dev localhost app có thể bắn 1 request anon sớm → phải lọc
 *  tới token có sub + role='authenticated', kẻo RLS ẩn hết dữ liệu. */
async function captureSupabaseAuth(page: Page) {
  const req = await page.waitForRequest(
    (r) => {
      if (!/\/rest\/v1\//.test(r.url())) return false;
      const jwt = (r.headers()['authorization'] ?? '').replace(/^Bearer /, '');
      const parts = jwt.split('.');
      if (parts.length < 2) return false;
      try {
        const claims = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        return claims.role === 'authenticated' && !!claims.sub;
      } catch {
        return false;
      }
    },
    { timeout: 30_000 },
  );
  const h = req.headers();
  const base = new URL(req.url()).origin;
  const jwt = (h['authorization'] ?? '').replace(/^Bearer /, '');
  const sub = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString()).sub as string;
  return { base, apikey: h['apikey'], auth: h['authorization'], userId: sub };
}

type SbAuth = Awaited<ReturnType<typeof captureSupabaseAuth>>;

const jsonHeaders = (a: SbAuth) => ({
  apikey: a.apikey,
  Authorization: a.auth,
  'Content-Type': 'application/json',
  'Content-Profile': 'public',
});

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

async function sbRpc(a: SbAuth, fn: string, body: Record<string, unknown>) {
  const r = await fetch(`${a.base}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: jsonHeaders(a),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`RPC ${fn} → ${r.status} ${await r.text()}`);
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

const CANARY = 'CANARY renamed';

/**
 * Id sổ CANARY renamed qua RPC SECURITY DEFINER `list_cashbooks_for_expense_v2`
 * (sổ actor đang CUSTODIAN). KHÔNG đọc bảng `accounts` trực tiếp: RLS SELECT chỉ
 * cho owner/shared — chunha là CUSTODIAN nhưng KHÔNG owner nên bảng ẩn sổ; đúng
 * đường app đi (posting selector cũng dùng RPC này, §12.6).
 */
async function getCanaryCashbookId(a: SbAuth): Promise<string> {
  const books = (await sbRpc(a, 'list_cashbooks_for_expense_v2', {})) as {
    id: string; name: string;
  }[];
  const book = books.find((x) => x.name === CANARY);
  if (!book) throw new Error(`chunha không CUSTODIAN sổ "${CANARY}" — fixture DEMO drift`);
  return book.id;
}

/**
 * Seed phiếu thu qua compat RPC.
 *
 * ⚠ ĐỢT B (01/08/2026): tên hàm này nay chỉ còn đúng với phiếu CHI. Theo quyết
 * định của chủ ("sau khi tạo thì đã tự duyệt và chi luôn"), phiếu THU đi đường
 * compat ra thẳng APPROVED và cầu a85b ghi sổ ngay trong cùng transaction.
 * Dùng `ensurePosted()` bên dưới thay vì gọi thẳng approve+post, nếu không sẽ
 * ăn 55000 "assert_committed_birth_boundary_v2 … has no birth provenance" —
 * đúng lỗi bài này từng đỏ.
 */
async function seedPendingVoucher(a: SbAuth, name: string, accountId: string) {
  const [b] = await sbGet(a, 'buildings?select=id,organization_id&name=eq.T%C3%B2a%20DEMO%20A&limit=1');
  const acc = { id: accountId };
  const [t] = await sbGet(
    a,
    `income_expense_types?select=id&organization_id=eq.${b.organization_id}&type=eq.income&limit=1`,
  );
  await sbRpc(a, 'ie_compat_insert_v2', {
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
        description: 'E2E mobile cancel',
        quantity: 1,
        unit_price: 45000,
        start_date: null,
        end_date: null,
      },
    ],
  });
}

/** Đọc id + state phiếu theo tên. */
async function getVoucher(a: SbAuth, name: string) {
  const [v] = await sbGet(
    a,
    `income_expenses?select=id,account_id,organization_id,approval_status,posting_status,approval_version,posting_version&name=eq.${encodeURIComponent(name)}&limit=1`,
  );
  if (!v) throw new Error(`Không tìm thấy phiếu seed: ${name}`);
  return v as {
    id: string;
    account_id: string | null;
    organization_id: string | null;
    approval_status: string;
    posting_status: string | null;
    approval_version: number | null;
    posting_version: number | null;
  };
}

/**
 * Đưa phiếu vừa seed về trạng thái ĐÃ GHI SỔ, bất kể writer sinh ra nó ở trạng
 * thái nào. Phiếu THU nay tự duyệt + tự ghi sổ (Đợt B) nên hai bước cũ trở
 * thành thừa — và gọi thừa thì hỏng, vì approve_income_expense_v2 assert ranh
 * giới khai sinh trên một phiếu đã APPROVED sẵn.
 */
async function ensurePosted(a: SbAuth, name: string, voucherId: string) {
  const cur = await getVoucher(a, name);
  if (cur.approval_status !== 'APPROVED') await approveVoucherRest(a, voucherId);
  if (cur.posting_status !== 'POSTED') await postApprovedRest(a, name);
}

/** Duyệt-only V2 qua REST → APPROVED-UNPOSTED. */
async function approveVoucherRest(a: SbAuth, voucherId: string) {
  await sbRpc(a, 'approve_income_expense_v2', {
    p_voucher: voucherId,
    p_expected_approval_version: 1,
    p_idempotency_key: `e2e-approve-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
}

/**
 * Upload chứng từ theo flow §6.3 qua REST: intent → upload storage → finalize.
 * Trả evidence_id (đã FINALIZED, dùng cho posting).
 */
async function uploadEvidenceRest(a: SbAuth, organizationId: string | null): Promise<string> {
  const intent = (await sbRpc(a, 'create_finance_evidence_upload_intent_v2', {
    p_organization_id: organizationId,
  })) as { evidence_id: string; bucket_id: string; object_name: string };
  const up = await fetch(
    `${a.base}/storage/v1/object/${intent.bucket_id}/${intent.object_name}`,
    {
      method: 'POST',
      headers: {
        apikey: a.apikey,
        Authorization: a.auth,
        'Content-Type': 'image/png',
        'x-upsert': 'false',
      },
      body: PNG_1PX,
    },
  );
  if (!up.ok) throw new Error(`upload evidence → ${up.status} ${await up.text()}`);
  await sbRpc(a, 'finalize_finance_evidence_v2', { p_evidence_id: intent.evidence_id });
  return intent.evidence_id;
}

/**
 * Thu/Chi phiếu ĐÃ DUYỆT vào sổ CUSTODIAN qua REST (post_approved_income_expense_v2)
 * — nhanh hơn bấm dialog UI cho phần SEED, evidence bắt buộc như flow thật.
 */
async function postApprovedRest(a: SbAuth, name: string) {
  const v = await getVoucher(a, name);
  const evidenceId = await uploadEvidenceRest(a, v.organization_id);
  await sbRpc(a, 'post_approved_income_expense_v2', {
    input: {
      subjectKind: 'VOUCHER',
      subjectId: v.id,
      cashbookId: v.account_id,
      postedOn: new Date().toISOString().slice(0, 10),
      evidenceIds: [evidenceId],
      expectedExecutionRevision: 0,
      expectedApprovalVersion: Number(v.approval_version ?? 1),
      expectedPostingVersion: Number(v.posting_version ?? 1),
      idempotencyKey: `e2e-post-${v.id}-${Date.now()}`,
    },
  });
}

/** Hoàn tác phiếu ĐÃ GHI SỔ qua REST → posting_status=REVERSED. */
async function reversePostedRest(a: SbAuth, voucherId: string, cashbookId: string) {
  await sbRpc(a, 'reverse_posted_income_expense_v2', {
    p_voucher: voucherId,
    p_cashbook: cashbookId,
    p_posted_on: new Date().toISOString().slice(0, 10),
    p_reason: 'e2e reverse trước khi huỷ',
    p_idempotency_key: `e2e-rev-${voucherId}-${Date.now()}`,
  });
}

/**
 * Tồn quỹ (current_amount) sổ CANARY renamed qua RPC SECURITY DEFINER
 * `list_cashbooks_with_balance_v2` — read model V2 mà CUSTODIAN đọc được (view
 * accounts_with_balance bám RLS accounts → ẩn với chunha không-owner).
 */
async function canaryBalance(a: SbAuth, cashbookId: string): Promise<number> {
  const rows = (await sbRpc(a, 'list_cashbooks_with_balance_v2', {})) as {
    id: string; current_amount: string | number;
  }[];
  const row = rows.find((x) => x.id === cashbookId);
  return Number(row?.current_amount ?? NaN);
}

/** Dọn fixture best-effort: POSTED thì hoàn tác trước, rồi compat-cancel. */
async function cleanupVoucher(a: SbAuth, voucherId: string) {
  try {
    const [st] = await sbGet(
      a,
      `income_expenses?select=approval_status,posting_status,account_id&id=eq.${voucherId}`,
    );
    if (!st || st.approval_status === 'CANCELLED') return;
    if (st.posting_status === 'POSTED') {
      await sbRpc(a, 'reverse_posted_income_expense_v2', {
        p_voucher: voucherId,
        p_cashbook: st.account_id,
        p_posted_on: new Date().toISOString().slice(0, 10),
        p_reason: 'e2e cleanup reverse',
        p_idempotency_key: `e2e-clean-rev-${voucherId}-${Date.now()}`,
      });
    }
    await sbRpc(a, 'ie_compat_cancel_v2', { p_ids: [voucherId], p_reason: 'e2e cleanup' });
  } catch {
    // best-effort — không chặn kết thúc test.
  }
}

/** Mở sheet chi tiết một phiếu trên TRANG MOBILE (viewport ≤767px). */
async function openMobileDetail(page: Page, name: string) {
  await page.goto('/income-expense');
  // Lớp "Tất cả" để thấy phiếu bất kể trạng thái/lớp (mặc định lọc Tiền thật).
  await page.getByRole('button', { name: 'Tất cả', exact: true }).click();
  await page.getByPlaceholder(/Theo mã phòng/).fill(name);
  const card = page.locator('.vch', { hasText: name });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(page.getByText('THÔNG TIN THU/CHI')).toBeVisible({ timeout: 15_000 });
}

// ---- TEST 1: MOBILE huỷ phiếu ĐÃ CHI (posted-aware) -------------------------
// seed → duyệt+chi (REST) → mobile sheet → Huỷ → dialog CẢNH BÁO hoàn tác + ô lý
// do → "Hoàn tác & Huỷ phiếu" → REST: posting_status=REVERSED & approval=CANCELLED.
test('finance-v2 mobile huỷ phiếu ĐÃ CHI (posted-aware)', async ({ browser }) => {
  test.setTimeout(120_000);
  const name = `[E2E-V2] mb cancel posted ${Date.now()}`;

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pc = await ctx.newPage();
  const errs = trackConsoleErrors(pc);
  let auth: SbAuth | null = null;
  let voucherId: string | null = null;
  let balanceBefore = NaN;
  try {
    await login(pc, 'chunha');
    const nav = pc.goto('/income-expense');
    auth = await captureSupabaseAuth(pc);
    await nav;

    const cashbookId = await getCanaryCashbookId(auth);
    balanceBefore = await canaryBalance(auth, cashbookId);

    // Seed pending → duyệt REST → chi vào sổ CUSTODIAN (REST) → POSTED.
    await seedPendingVoucher(auth, name, cashbookId);
    const seeded = await getVoucher(auth, name);
    voucherId = seeded.id;
    await ensurePosted(auth, name, voucherId);
    await expect
      .poll(
        async () => (await getVoucher(auth!, name)).posting_status,
        { timeout: 15_000 },
      )
      .toBe('POSTED');

    // Mở sheet chi tiết → nút Huỷ (aria-label "Huỷ").
    await openMobileDetail(pc, name);
    await pc.getByRole('button', { name: 'Huỷ', exact: true }).click();

    // Dialog POSTED-AWARE + ô lý do (Textarea).
    // ⚠ Spec này từng chờ chữ "hoàn tác". Đợt 5 đổi sang HUỶ TẠI CHỖ: dialog nay
    // nói "trừ thẳng khoản này khỏi tồn quỹ ngay, KHÔNG sinh thêm phiếu đối ứng".
    // Chờ chữ cũ là bắt spec nói dối về hành vi đang chạy.
    const dialog = pc.getByRole('alertdialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toContainText(/trừ thẳng khoản này khỏi tồn quỹ/i);
    const reason = dialog.getByRole('textbox');
    await expect(reason).toBeVisible();
    await reason.fill('E2E mobile huỷ phiếu đã chi');

    // Nút posted-aware nay là "Huỷ phiếu & trừ khỏi sổ quỹ" (Đợt 5 huỷ tại chỗ).
    await dialog.getByRole('button', { name: 'Huỷ phiếu & trừ khỏi sổ quỹ' }).click();

    // Assert DB thật: reverse (REVERSED) + cancel (CANCELLED). Poll ≤15s.
    await expect
      .poll(
        async () => {
          const st = await getVoucher(auth!, name);
          return `${st.approval_status}/${st.posting_status}`;
        },
        { timeout: 15_000 },
      )
      .toBe('CANCELLED/REVERSED');

    // Balance sổ về nguyên trạng (chi rồi hoàn tác → net 0).
    await expect
      .poll(async () => await canaryBalance(auth!, cashbookId), { timeout: 10_000 })
      .toBe(balanceBefore);

    expect(errs, `mobile console: ${errs.join(' | ')}`).toEqual([]);
  } finally {
    if (auth && voucherId) await cleanupVoucher(auth, voucherId);
    await ctx.close();
  }
});

// ---- TEST 2: MOBILE huỷ phiếu REVERSED (dialog thường) ----------------------
// seed → duyệt+chi (REST) → reverse (REST) → mobile sheet phiếu REVERSED → Huỷ →
// dialog THƯỜNG (không posted-warning) → "Huỷ phiếu" → REST: approval=CANCELLED.
test('finance-v2 mobile huỷ phiếu REVERSED (dialog thường)', async ({ browser }) => {
  test.setTimeout(120_000);
  const name = `[E2E-V2] mb cancel reversed ${Date.now()}`;

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pc = await ctx.newPage();
  const errs = trackConsoleErrors(pc);
  let auth: SbAuth | null = null;
  let voucherId: string | null = null;
  let balanceBefore = NaN;
  try {
    await login(pc, 'chunha');
    const nav = pc.goto('/income-expense');
    auth = await captureSupabaseAuth(pc);
    await nav;

    const cashbookId = await getCanaryCashbookId(auth);
    balanceBefore = await canaryBalance(auth, cashbookId);

    // Seed → duyệt → chi → hoàn tác (REST) → REVERSED.
    await seedPendingVoucher(auth, name, cashbookId);
    const seeded = await getVoucher(auth, name);
    voucherId = seeded.id;
    await ensurePosted(auth, name, voucherId);
    await expect
      .poll(async () => (await getVoucher(auth!, name)).posting_status, { timeout: 15_000 })
      .toBe('POSTED');
    await reversePostedRest(auth, voucherId, seeded.account_id!);
    await expect
      .poll(async () => (await getVoucher(auth!, name)).posting_status, { timeout: 15_000 })
      .toBe('REVERSED');

    // Mở sheet chi tiết phiếu (đã REVERSED) → nút Huỷ.
    await openMobileDetail(pc, name);
    await pc.getByRole('button', { name: 'Huỷ', exact: true }).click();

    // Dialog THƯỜNG: KHÔNG có nút posted-aware "Hoàn tác & Huỷ phiếu".
    const dialog = pc.getByRole('alertdialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole('button', { name: 'Hoàn tác & Huỷ phiếu' })).toHaveCount(0);
    // Lý do huỷ là BẮT BUỘC ở MỌI trạng thái (Đợt 4) — kể cả phiếu đã REVERSED,
    // dialog "thường" vẫn khoá nút cho tới khi có ≥8 ký tự. Bài này trước đây
    // bấm thẳng nên đỏ vì nút disabled, không phải vì luồng huỷ hỏng.
    const reasonReversed = dialog.getByRole('textbox');
    await expect(reasonReversed).toBeVisible();
    await reasonReversed.fill('E2E mobile huỷ phiếu đã hoàn tác');
    await dialog.getByRole('button', { name: 'Huỷ phiếu' }).click();

    // Assert DB thật: approval_status=CANCELLED (poll ≤15s).
    await expect
      .poll(async () => (await getVoucher(auth!, name)).approval_status, { timeout: 15_000 })
      .toBe('CANCELLED');

    // Balance sổ về nguyên trạng (chi rồi hoàn tác → net 0; huỷ không đụng tiền nữa).
    await expect
      .poll(async () => await canaryBalance(auth!, cashbookId), { timeout: 10_000 })
      .toBe(balanceBefore);

    expect(errs, `mobile console: ${errs.join(' | ')}`).toEqual([]);
  } finally {
    if (auth && voucherId) await cleanupVoucher(auth, voucherId);
    await ctx.close();
  }
});
