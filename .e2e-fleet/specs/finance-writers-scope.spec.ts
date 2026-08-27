import { test, expect, Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Finance V2 — writers SCOPE / idempotency / rollback (org DEMO dddd…0001).
 *
 * Ba lát cắt bổ sung cho finance-v2.spec (KHÔNG đụng file đó):
 *   1) KNOWER không leak: user chỉ-KNOWER trên một sổ chỉ thấy INCOME do CHÍNH
 *      mình tạo trên sổ đó (list_income_expenses_v2); accounts_with_balance_v2 của
 *      sổ đó trả initial (KHÔNG lộ posting lines mà CUSTODIAN cộng được); trang Sổ
 *      quỹ hiện "—" cho sổ KNOWER.
 *   2) Idempotency double-submit posting: post_approved gọi 2 lần song song
 *      (cùng key = replay; khác key = lần thừa lỗi sạch) → đúng 1 POSTING active,
 *      balance chỉ cộng 1 lần.
 *   3) Rollback thiếu điều kiện: post bởi user KHÔNG-CUSTODIAN → 42501 sạch;
 *      post với expected version sai → 55000 (CAS) sạch — phiếu vẫn
 *      APPROVED-UNPOSTED, KHÔNG sinh posting rác.
 *
 * GHI CHÚ RLS (đã khảo sát): bảng `accounts` chỉ cho OWNER(user_id)/shared/super
 * đọc — possession (CUSTODIAN/KNOWER) KHÔNG mở quyền đọc accounts. Vì vậy:
 *   - id sổ lấy qua RPC possession (list_cashbooks_for_expense_v2), KHÔNG đọc
 *     thẳng bảng accounts.
 *   - Lát KNOWER dùng sổ "DEMO Quản Lý Thu" (quanly SỞ HỮU nên đọc được hàng
 *     accounts_with_balance_v2), CHUYỂN quanly custodian→KNOWER để chứng minh mask.
 *
 * BUG SERVER đã phát hiện (KHÔNG tự vá): set_cashbook_access_v2 raise
 *   22P02 "malformed array literal: CUSTODIAN" mỗi khi actor GIỮ NGUYÊN custody
 *   của chính mình (dòng `v_after := v_after || 'CUSTODIAN'`, v_after text[] →
 *   `||` bị chọn nhánh array||array, ép 'CUSTODIAN' thành mảng). Vì đường RPC hỏng,
 *   binding KNOWER TẠM được seed qua Supabase Management API (PAT — CLAUDE.md cho
 *   phép chuẩn bị state test) và HOÀN NGUYÊN chính xác ở cleanup.
 *
 * Fixture tự dọn (huỷ phiếu, KHÔI PHỤC custody gốc). Chỉ ghi org DEMO.
 * Chạy: FLEET_PASS_CHUNHA=… FLEET_PASS_KETOAN=… FLEET_PASS_QUANLY=… \
 *       SUPABASE_MGMT_PAT=… \
 *         cd .e2e-fleet && npx playwright test specs/finance-writers-scope.spec.ts --workers=2
 */

const KNOWER_BOOK = 'DEMO Quản Lý Thu'; // quanly SỞ HỮU + đang custodian → sẽ đổi sang KNOWER
const CUSTODY_BOOK = 'CANARY renamed'; // chunha/ketoan custodian → dùng cho post

// PNG 1×1 — chứng từ tối thiểu cho posting evidence (finalized).
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ── Auth capture + REST helpers (mô phỏng finance-v2.spec) ──────────────────
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

/** Gọi RPC PostgREST, KHÔNG throw — trả {status, ok, json, text} để assert lỗi sạch. */
async function sbRpc(a: SbAuth, name: string, body: unknown) {
  const r = await fetch(`${a.base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: a.apikey,
      Authorization: a.auth,
      'Content-Type': 'application/json',
      'Content-Profile': 'public',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: r.status, ok: r.ok, json, text };
}

async function sbRpcOk(a: SbAuth, name: string, body: unknown) {
  const r = await sbRpc(a, name, body);
  if (!r.ok) throw new Error(`RPC ${name} → ${r.status} ${r.text}`);
  return r.json;
}

const rnd = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ── Fixtures dùng chung ──────────────────────────────────────────────────────
type Refs = { buildingId: string; orgId: string; cashbookId: string; incomeTypeId: string };

/** id sổ theo tên qua RPC possession (bypass accounts-RLS) — actor phải CUSTODIAN. */
async function cashbookIdByName(a: SbAuth, name: string): Promise<string> {
  const list = (await sbRpcOk(a, 'list_cashbooks_for_expense_v2', {})) as { id: string; name: string }[];
  const hit = list.find((c) => c.name === name);
  if (!hit) throw new Error(`Sổ '${name}' không có trong list_cashbooks_for_expense_v2 (actor phải là CUSTODIAN)`);
  return hit.id;
}

async function resolveRefs(a: SbAuth, cashbookName: string): Promise<Refs> {
  const [b] = await sbGet(a, 'buildings?select=id,organization_id&name=eq.T%C3%B2a%20DEMO%20A&limit=1');
  const [t] = await sbGet(
    a,
    `income_expense_types?select=id&organization_id=eq.${b.organization_id}&type=eq.income&limit=1`,
  );
  const cashbookId = await cashbookIdByName(a, cashbookName);
  return { buildingId: b.id, orgId: b.organization_id, cashbookId, incomeTypeId: t.id };
}

/** Seed phiếu thu UNAPPROVED qua compat RPC — server ép Chờ duyệt + khai sinh. Trả id. */
async function seedPendingVoucher(a: SbAuth, name: string, refs: Refs): Promise<string> {
  const r = await sbRpc(a, 'ie_compat_insert_v2', {
    p_row: {
      user_id: a.userId,
      creator_name: 'E2E Fleet',
      type: 'INCOME',
      name,
      building_id: refs.buildingId,
      organization_id: refs.orgId,
      account_id: refs.cashbookId,
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
        income_expense_type_id: refs.incomeTypeId,
        accounting_class: 'PNL',
        description: 'E2E writers-scope',
        quantity: 1,
        unit_price: 45000,
        start_date: null,
        end_date: null,
      },
    ],
  });
  if (!r.ok) throw new Error(`seed compat → ${r.status} ${r.text}`);
  return (r.json?.id as string) ?? (await getVoucherId(a, name));
}

/** Tạo phiếu INCOME canonical (maker = actor) — dùng cho lát KNOWER own-visibility. */
async function createIncomeVoucher(a: SbAuth, name: string, refs: Refs): Promise<string> {
  const res = await sbRpc(a, 'create_income_expense_v2', {
    payload: {
      type: 'INCOME',
      name,
      buildingId: refs.buildingId,
      voucherDate: new Date().toISOString().slice(0, 10),
      totalAmount: 45000,
      postingMode: 'CASHBOOK',
      cashbookId: refs.cashbookId,
      idempotencyKey: `e2e-create-${rnd()}`,
      items: [
        { typeId: refs.incomeTypeId, accountingClass: 'PNL', description: 'E2E own income', quantity: 1, unitPrice: 45000, amount: 45000 },
      ],
    },
  });
  if (!res.ok) throw new Error(`create_income_expense_v2 → ${res.status} ${res.text}`);
  return res.json.voucherId as string;
}

async function getVoucherId(a: SbAuth, name: string): Promise<string> {
  const [v] = await sbGet(a, `income_expenses?select=id&name=eq.${encodeURIComponent(name)}&limit=1`);
  if (!v) throw new Error(`Không tìm thấy phiếu seed: ${name}`);
  return v.id as string;
}

async function readVoucher(a: SbAuth, id: string) {
  const [v] = await sbGet(
    a,
    `income_expenses?select=approval_status,posting_status,approval_version,posting_version,account_id&id=eq.${id}`,
  );
  return v as {
    approval_status: string;
    posting_status: string | null;
    approval_version: number;
    posting_version: number;
    account_id: string | null;
  };
}

async function approveVoucherRest(a: SbAuth, voucherId: string) {
  const r = await sbRpc(a, 'approve_income_expense_v2', {
    p_voucher: voucherId,
    p_expected_approval_version: 1,
    p_idempotency_key: `e2e-approve-${rnd()}`,
  });
  if (!r.ok) throw new Error(`approve v2 → ${r.status} ${r.text}`);
}

/** intent → upload storage → finalize; trả evidence_id FINALIZED. */
async function createFinalizedEvidence(a: SbAuth, orgId: string): Promise<string> {
  const intent = await sbRpcOk(a, 'create_finance_evidence_upload_intent_v2', { p_organization_id: orgId });
  const { evidence_id, bucket_id, object_name } = intent as {
    evidence_id: string;
    bucket_id: string;
    object_name: string;
  };
  const up = await fetch(`${a.base}/storage/v1/object/${bucket_id}/${object_name}`, {
    method: 'POST',
    headers: { apikey: a.apikey, Authorization: a.auth, 'Content-Type': 'image/png' },
    body: PNG_1PX,
  });
  if (!up.ok) throw new Error(`storage upload → ${up.status} ${await up.text()}`);
  await sbRpcOk(a, 'finalize_finance_evidence_v2', { p_evidence_id: evidence_id });
  return evidence_id;
}

function postInput(opts: {
  voucher: string;
  cashbook: string;
  evidence: string[];
  apprVer: number;
  postVer: number;
  key: string;
}) {
  return {
    input: {
      subjectKind: 'VOUCHER',
      subjectId: opts.voucher,
      cashbookId: opts.cashbook,
      postedOn: new Date().toISOString().slice(0, 10),
      evidenceIds: opts.evidence,
      expectedApprovalVersion: opts.apprVer,
      expectedPostingVersion: opts.postVer,
      idempotencyKey: opts.key,
    },
  };
}

/** Dọn phiếu best-effort: POSTED → reverse trước, rồi compat-cancel. */
async function cleanupVoucher(a: SbAuth, voucherId: string) {
  try {
    const st = await readVoucher(a, voucherId);
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
    /* best-effort */
  }
}

// ── access-admin đọc (RPC lành) + seed KNOWER binding qua Management API ─────
type AccessAdmin = {
  revision: number;
  custodians: { membership_id: string; user_id: string }[];
  knowers: { membership_id: string; user_id: string }[];
  eligible_memberships: { membership_id: string; user_id: string }[];
};
async function readAccessAdmin(a: SbAuth, cashbookId: string): Promise<AccessAdmin> {
  return (await sbRpcOk(a, 'get_cashbook_access_admin_v2', { p_cashbook_id: cashbookId })) as AccessAdmin;
}

/** Chạy SQL qua Supabase Management API (PAT) — chỉ để seed/hoàn nguyên state test. */
async function mgmtQuery(sql: string): Promise<any[]> {
  const pat = process.env.SUPABASE_MGMT_PAT;
  const ref = process.env.SUPABASE_PROJECT_REF || 'tryymsxyyckgbrmmvozx';
  if (!pat) {
    throw new Error(
      'Thiếu SUPABASE_MGMT_PAT — cần để seed binding KNOWER tạm (đường RPC set_cashbook_access_v2 đang lỗi 22P02). ' +
        'PAT nằm ở CLAUDE.local.md, KHÔNG commit.',
    );
  }
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`mgmt query → ${r.status} ${await r.text()}`);
  return r.json();
}

/** Chuyển membership từ CUSTODIAN→KNOWER trên sổ (reversible). Trả token hoàn nguyên. */
async function seedKnowerBinding(orgId: string, cashbookId: string, membershipId: string) {
  const closed = await mgmtQuery(
    `UPDATE public.cashbook_possession_bindings SET valid_to = now()
     WHERE cashbook_id = '${cashbookId}' AND membership_id = '${membershipId}'
       AND possession_kind = 'CUSTODIAN' AND valid_to IS NULL
     RETURNING id;`,
  );
  const inserted = await mgmtQuery(
    `INSERT INTO public.cashbook_possession_bindings
       (organization_id, cashbook_id, membership_id, possession_kind, reason)
     VALUES ('${orgId}', '${cashbookId}', '${membershipId}', 'KNOWER', 'e2e writers-scope KNOWER temp')
     RETURNING id;`,
  );
  return { closedCustodianIds: closed.map((r) => r.id as string), knowerId: inserted[0].id as string };
}

/** Hoàn nguyên chính xác: xoá KNOWER tạm, mở lại custodian đã đóng. */
async function restoreKnowerBinding(token: { closedCustodianIds: string[]; knowerId: string }) {
  await mgmtQuery(`DELETE FROM public.cashbook_possession_bindings WHERE id = '${token.knowerId}';`);
  if (token.closedCustodianIds.length) {
    const ids = token.closedCustodianIds.map((i) => `'${i}'`).join(',');
    await mgmtQuery(`UPDATE public.cashbook_possession_bindings SET valid_to = NULL WHERE id IN (${ids});`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST 1 — KNOWER không leak
// ═══════════════════════════════════════════════════════════════════════════
test('finance-writers-scope: KNOWER không leak', async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = rnd();
  const ownName = `[E2E-WS] knower own ${tag}`;
  const otherName = `[E2E-WS] other income ${tag}`;

  const ctxC = await browser.newContext();
  const pc = await ctxC.newPage();
  const ctxQ = await browser.newContext();
  const pq = await ctxQ.newPage();
  const errsQ = trackConsoleErrors(pq);

  let authC: SbAuth | null = null;
  let authQ: SbAuth | null = null;
  let refs: Refs | null = null;
  let restoreToken: { closedCustodianIds: string[]; knowerId: string } | null = null;
  let ownId: string | null = null;
  let otherId: string | null = null;

  try {
    // chunha (custodian KNOWER_BOOK) — seed phiếu "người khác" + dọn.
    await login(pc, 'chunha');
    const navC = pc.goto('/income-expense');
    authC = await captureSupabaseAuth(pc);
    await navC;
    refs = await resolveRefs(authC, KNOWER_BOOK);

    // quanly — SỞ HỮU KNOWER_BOOK, hiện là custodian; sẽ chuyển sang KNOWER.
    await login(pq, 'quanly');
    const navQ = pq.goto('/income-expense');
    authQ = await captureSupabaseAuth(pq);
    await navQ;

    // Xác định membership quanly qua RPC lành (get_cashbook_access_admin_v2).
    // (typecheck:e2e 28/08 bắt được: authQ khai `| null`, TS đúng — dòng gán
    // ngay trên bảo đảm nó không null tại đây, nhưng nói ra tường minh.)
    const admin0 = await readAccessAdmin(authC, refs.cashbookId);
    const quanlyMid = admin0.eligible_memberships.find((m) => m.user_id === authQ!.userId)?.membership_id;
    expect(quanlyMid, 'phải thấy membership của quanly').toBeTruthy();

    // Chuyển quanly custodian→KNOWER qua Management API (đường RPC lỗi 22P02).
    restoreToken = await seedKnowerBinding(refs.orgId, refs.cashbookId, quanlyMid!);

    // Số dư đầu kỳ của sổ (quanly SỞ HỮU nên đọc được hàng accounts_with_balance_v2).
    const [balQ0] = await sbGet(
      authQ,
      `accounts_with_balance_v2?select=id,initial_amount,current_amount&id=eq.${refs.cashbookId}`,
    );
    expect(balQ0, 'quanly phải đọc được hàng sổ (owner)').toBeTruthy();

    // Seed phiếu INCOME của NGƯỜI KHÁC (chunha) trên sổ — KNOWER KHÔNG được thấy.
    otherId = await seedPendingVoucher(authC, otherName, refs);

    // quanly (KNOWER) tạo phiếu INCOME của CHÍNH MÌNH (maker = quanly).
    ownId = await createIncomeVoucher(authQ, ownName, refs);

    // (a) list_income_expenses_v2 (quanly, lọc sổ): thấy phiếu MÌNH, KHÔNG thấy phiếu người khác.
    const list = (await sbRpcOk(authQ, 'list_income_expenses_v2', {
      p_filters: { accountId: refs.cashbookId, limit: 200 },
    })) as { id: string; maker_user_id: string; type: string }[];
    const ids = new Set(list.map((r) => r.id));
    expect(ids.has(ownId), 'KNOWER phải thấy phiếu INCOME của chính mình').toBeTruthy();
    expect(ids.has(otherId!), 'KNOWER KHÔNG được thấy phiếu người khác trên sổ').toBeFalsy();
    for (const row of list) {
      expect(row.type, 'KNOWER chỉ thấy INCOME').toBe('INCOME');
      expect(row.maker_user_id, 'KNOWER chỉ thấy phiếu do chính mình tạo').toBe(authQ.userId);
    }

    // (b) accounts_with_balance_v2: quanly (KNOWER, không custodian) → current = initial (không lộ);
    //     chunha (custodian) qua list_cashbooks_with_balance_v2 → thấy số THẬT khác initial.
    const [balQ] = await sbGet(
      authQ,
      `accounts_with_balance_v2?select=id,initial_amount,current_amount&id=eq.${refs.cashbookId}`,
    );
    expect(Number(balQ.current_amount), 'KNOWER: current_amount = initial (không lộ posting lines)').toBe(
      Number(balQ.initial_amount),
    );
    const custBal = (await sbRpcOk(authC, 'list_cashbooks_with_balance_v2', {})) as {
      id: string;
      current_amount: string;
    }[];
    const custRow = custBal.find((c) => c.id === refs!.cashbookId);
    expect(custRow, 'CUSTODIAN phải thấy sổ trong list_cashbooks_with_balance_v2').toBeTruthy();
    expect(
      Number(custRow!.current_amount),
      'CUSTODIAN thấy tồn quỹ THẬT khác con số KNOWER thấy → chứng minh mask là thật',
    ).not.toBe(Number(balQ.current_amount));

    // (c) Trang Sổ quỹ (browser, quanly): sổ KNOWER hiện "—" cho tồn quỹ.
    await pq.goto('/finance/cashbooks');
    const search = pq.getByPlaceholder(/Tìm theo mã hoặc tên sổ quỹ/);
    await search.waitFor({ timeout: 30_000 });
    await search.fill(KNOWER_BOOK);
    await search.press('Enter');
    const row = pq.getByRole('row').filter({ hasText: KNOWER_BOOK });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(
      row.locator('span[title*="Người biết sổ"], span[title*="không xem tồn quỹ"]'),
      'ô Tồn quỹ phải mask "—" (title KNOWER)',
    ).toBeVisible({ timeout: 15_000 });

    expect(errsQ, `quanly console: ${errsQ.join(' | ')}`).toEqual([]);
  } finally {
    if (authC && ownId) await cleanupVoucher(authC, ownId);
    if (authC && otherId) await cleanupVoucher(authC, otherId);
    // KHÔI PHỤC custody gốc (xoá KNOWER tạm, mở lại custodian quanly).
    if (restoreToken) {
      try {
        await restoreKnowerBinding(restoreToken);
      } catch {
        /* best-effort */
      }
    }
    await ctxQ.close();
    await ctxC.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 2 — Idempotency double-submit posting (đúng 1 posting, cộng 1 lần)
// ═══════════════════════════════════════════════════════════════════════════
test('finance-writers-scope: idempotency double-submit posting', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext();
  const pc = await ctx.newPage();
  let auth: SbAuth | null = null;
  let refs: Refs | null = null;
  const toClean: string[] = [];

  try {
    await login(pc, 'chunha'); // custodian CUSTODY_BOOK
    const nav = pc.goto('/income-expense');
    auth = await captureSupabaseAuth(pc);
    await nav;
    refs = await resolveRefs(auth, CUSTODY_BOOK);

    // ── Kịch bản A: CÙNG idempotency_key (replay) ──────────────────────────
    const nameA = `[E2E-WS] idem-same ${rnd()}`;
    const vA = await seedPendingVoucher(auth, nameA, refs);
    toClean.push(vA);
    await approveVoucherRest(auth, vA);
    const stA = await readVoucher(auth, vA);
    const evA = await createFinalizedEvidence(auth, refs.orgId);
    const inputA = postInput({
      voucher: vA,
      cashbook: refs.cashbookId,
      evidence: [evA],
      apprVer: stA.approval_version,
      postVer: stA.posting_version,
      key: `e2e-post-same-${rnd()}`,
    });
    const [a1, a2] = await Promise.all([
      sbRpc(auth, 'post_approved_income_expense_v2', inputA),
      sbRpc(auth, 'post_approved_income_expense_v2', inputA),
    ]);
    // Cùng key → cả hai đều 200 (một thật, một replay stored response).
    expect(
      a1.ok && a2.ok,
      `same-key: cả hai phải OK (replay). a1=${a1.status} a2=${a2.status} ${a1.text}${a2.text}`,
    ).toBeTruthy();
    const postingsA = (await sbGet(
      auth,
      `income_expense_postings?select=id,event_kind,posting_generation&voucher_id=eq.${vA}&account_id=eq.${refs.cashbookId}`,
    )) as { id: string; event_kind: string; posting_generation: number }[];
    const postA = postingsA.filter((p) => p.event_kind === 'POSTING');
    expect(postA.length, 'same-key: đúng 1 POSTING active').toBe(1);
    // Balance chỉ cộng 1 lần: tổng signed_amount của các line thuộc phiếu = +45000.
    const linesA = (await sbGet(
      auth,
      `income_expense_posting_lines?select=signed_amount&posting_id=eq.${postA[0].id}`,
    )) as { signed_amount: string }[];
    const sumA = linesA.reduce((s, l) => s + Number(l.signed_amount), 0);
    expect(sumA, 'same-key: net cash effect = +45000 (cộng 1 lần)').toBe(45000);

    // ── Kịch bản B: KHÁC idempotency_key (lần thừa lỗi sạch) ────────────────
    const nameB = `[E2E-WS] idem-diff ${rnd()}`;
    const vB = await seedPendingVoucher(auth, nameB, refs);
    toClean.push(vB);
    await approveVoucherRest(auth, vB);
    const stB = await readVoucher(auth, vB);
    const evB = await createFinalizedEvidence(auth, refs.orgId);
    const mk = (key: string) =>
      postInput({
        voucher: vB,
        cashbook: refs!.cashbookId,
        evidence: [evB],
        apprVer: stB.approval_version,
        postVer: stB.posting_version,
        key,
      });
    const [b1, b2] = await Promise.all([
      sbRpc(auth, 'post_approved_income_expense_v2', mk(`e2e-post-diff-1-${rnd()}`)),
      sbRpc(auth, 'post_approved_income_expense_v2', mk(`e2e-post-diff-2-${rnd()}`)),
    ]);
    // Đúng một cái thành công; cái thừa lỗi sạch (55000 — phiếu đã POSTED).
    const okCount = [b1, b2].filter((r) => r.ok).length;
    expect(okCount, `diff-key: đúng 1 lần OK (a=${b1.status} b=${b2.status} ${b1.text}${b2.text})`).toBe(1);
    const loser = b1.ok ? b2 : b1;
    expect(
      loser.json?.code === '55000' || /APPROVED \+ UNPOSTED|version mismatch|POSTED/i.test(loser.text),
      `diff-key: lỗi phải sạch (trạng thái/CAS), nhận: ${loser.status} ${loser.text}`,
    ).toBeTruthy();
    const postingsB = (await sbGet(
      auth,
      `income_expense_postings?select=id,event_kind&voucher_id=eq.${vB}&account_id=eq.${refs.cashbookId}`,
    )) as { id: string; event_kind: string }[];
    expect(postingsB.filter((p) => p.event_kind === 'POSTING').length, 'diff-key: đúng 1 POSTING active').toBe(1);
  } finally {
    if (auth) for (const v of toClean) await cleanupVoucher(auth, v);
    await ctx.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 3 — Rollback khi thiếu điều kiện (không sinh posting rác)
// ═══════════════════════════════════════════════════════════════════════════
test('finance-writers-scope: rollback thiếu điều kiện', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctxC = await browser.newContext();
  const pc = await ctxC.newPage();
  const ctxQ = await browser.newContext();
  const pq = await ctxQ.newPage();

  let authC: SbAuth | null = null;
  let authQ: SbAuth | null = null;
  let refs: Refs | null = null;
  let vId: string | null = null;

  try {
    await login(pc, 'chunha'); // custodian CUSTODY_BOOK — seed + approve + read + cleanup
    const navC = pc.goto('/income-expense');
    authC = await captureSupabaseAuth(pc);
    await navC;
    refs = await resolveRefs(authC, CUSTODY_BOOK);

    await login(pq, 'quanly'); // KHÔNG custodian CUSTODY_BOOK → post phải 42501
    const navQ = pq.goto('/income-expense');
    authQ = await captureSupabaseAuth(pq);
    await navQ;

    // Seed + duyệt → APPROVED-UNPOSTED (điểm neo cho cả hai nhánh rollback).
    const name = `[E2E-WS] rollback ${rnd()}`;
    vId = await seedPendingVoucher(authC, name, refs);
    await approveVoucherRest(authC, vId);
    const st0 = await readVoucher(authC, vId);
    expect(st0.approval_status).toBe('APPROVED');
    expect(['UNPOSTED', null]).toContain(st0.posting_status);

    // ── (a) post bởi user KHÔNG-CUSTODIAN (quanly) → 42501 sạch ─────────────
    const denied = await sbRpc(
      authQ,
      'post_approved_income_expense_v2',
      postInput({
        voucher: vId,
        cashbook: refs.cashbookId,
        evidence: [], // fail ở custodian-check TRƯỚC khi cần evidence
        apprVer: st0.approval_version,
        postVer: st0.posting_version,
        key: `e2e-rb-noncust-${rnd()}`,
      }),
    );
    expect(denied.ok, 'non-custodian post phải bị từ chối').toBeFalsy();
    expect(
      denied.json?.code === '42501' || /possession|CUSTODIAN|denied/i.test(denied.text),
      `non-custodian: phải 42501 sạch, nhận ${denied.status} ${denied.text}`,
    ).toBeTruthy();

    // ── (b) post với expected version SAI (chunha custodian) → 55000 CAS ────
    const evReal = await createFinalizedEvidence(authC, refs.orgId);
    const casErr = await sbRpc(
      authC,
      'post_approved_income_expense_v2',
      postInput({
        voucher: vId,
        cashbook: refs.cashbookId,
        evidence: [evReal],
        apprVer: st0.approval_version,
        postVer: st0.posting_version + 999, // sai → version mismatch
        key: `e2e-rb-cas-${rnd()}`,
      }),
    );
    expect(casErr.ok, 'post version sai phải bị từ chối').toBeFalsy();
    expect(
      casErr.json?.code === '55000' || /version mismatch/i.test(casErr.text),
      `CAS: phải 55000 sạch, nhận ${casErr.status} ${casErr.text}`,
    ).toBeTruthy();

    // ── Bất biến: phiếu vẫn APPROVED-UNPOSTED, KHÔNG có posting rác ─────────
    const st1 = await readVoucher(authC, vId);
    expect(st1.approval_status).toBe('APPROVED');
    expect(['UNPOSTED', null]).toContain(st1.posting_status);
    expect(st1.posting_version, 'posting_version không đổi (không có bút toán)').toBe(st0.posting_version);
    const postings = (await sbGet(authC, `income_expense_postings?select=id&voucher_id=eq.${vId}`)) as {
      id: string;
    }[];
    expect(postings.length, 'KHÔNG được sinh posting rác').toBe(0);
  } finally {
    if (authC && vId) await cleanupVoucher(authC, vId);
    await ctxQ.close();
    await ctxC.close();
  }
});
