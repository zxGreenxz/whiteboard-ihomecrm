import { test, expect, Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Hợp đồng ký trên phòng "Đã cọc" — cửa hẹp LINK_CONTRACT của guard canonical.
 *
 * BUG PROD (05/08/2026): create_contract_v2 trả 500 / errcode 55000
 *   "canonical income expense <id> is frozen (update rejected)"
 * cho MỌI hợp đồng ký trên phòng đang có phiếu thu cọc. Nguyên nhân: writer mở
 * scope flex 'LINK_CONTRACT' rồi UPDATE income_expenses SET contract_id = <hđ>,
 * nhưng app_private.guard_income_expense_owned_payload (trigger
 * a00_ie_owned_payload_freeze) MẤT nhánh 'LINK_CONTRACT' (bị ghi đè khi hàm được
 * vá ngoài migration) ⇒ rơi xuống nhánh canonical ⇒ đòi token lifecycle mà writer
 * không cấp ⇒ rollback cả giao dịch tạo hợp đồng.
 * FIX: migration 20260805120000_ie_guard_link_contract_scope.sql (đã apply prod).
 *
 * Bài này chứng minh END-TO-END qua HTTP thật (PostgREST, JWT của user DEMO):
 *   1. Seed phiếu THU CỌC đi ĐÚNG đường writer canonical create_income_expense_v1
 *      (hạng mục is_deposit ⇒ item.accounting_class = 'DEPOSIT', contract_id NULL).
 *   2. BẮT BUỘC assert phiếu FLOW-OWNED (app_private.is_income_expense_flow_owned
 *      = true, đọc qua Management API). Không flow-owned = không đi qua nhánh
 *      guard đang sửa ⇒ bài test vô nghĩa, phải fail ngay chứ không xanh giả.
 *   3. Gọi create_contract_v2 với existing_deposit_voucher_ids = [phiếu đó].
 *   4. Assert: 200, HĐ tạo được, phiếu cọc mang contract_id mới, phòng OCCUPIED,
 *      link cọc EXPLICIT_V2 tồn tại, deposit_paid = số tiền cọc.
 *   5. Replay đúng idempotency key → cùng một HĐ, KHÔNG sinh HĐ thứ hai.
 *
 * CHỈ ghi org DEMO dddd0000-…0001. Fixture tự dọn (huỷ phiếu cọc, soft-delete HĐ,
 * trả phòng về trạng thái cũ) nên chạy lại liên tiếp vẫn xanh.
 *
 * Chạy:
 *   cd .e2e-fleet && FLEET_PASS_CHUNHA=… SUPABASE_MGMT_PAT=… \
 *     npx playwright test specs/contract-create-linked-deposit.spec.ts
 */

const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
const DEPOSIT_AMOUNT = 3_000_000;
const RENT_PRICE = 5_000_000;

// ── Auth capture + REST helpers (mẫu finance-writers-scope.spec) ─────────────
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

/**
 * SQL qua Supabase Management API (PAT) — CHỈ để (a) đọc predicate app_private
 * không expose ra PostgREST, (b) dọn fixture. Không dùng để lách writer.
 */
async function mgmtQuery(sql: string): Promise<any[]> {
  const pat = process.env.SUPABASE_MGMT_PAT;
  const ref = process.env.SUPABASE_PROJECT_REF || 'tryymsxyyckgbrmmvozx';
  if (!pat) {
    throw new Error(
      'Thiếu SUPABASE_MGMT_PAT — cần để đọc app_private.is_income_expense_flow_owned ' +
        '(assert bắt buộc) và dọn fixture. PAT nằm ở CLAUDE.local.md, KHÔNG commit.',
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

const rnd = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (base: string, days: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};

test('contract-create-linked-deposit: ký HĐ trên phòng đã cọc (canonical) không còn 55000 frozen', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = trackConsoleErrors(page);

  let auth: SbAuth | null = null;
  let voucherId: string | null = null;
  let contractId: string | null = null;
  let roomId: string | null = null;
  let roomStatus0: string | null = null;

  try {
    await login(page, 'chunha');
    const nav = page.goto('/income-expense');
    auth = await captureSupabaseAuth(page);
    await nav;

    // ── 1. Phòng DEMO trống: không HĐ ACTIVE, không phiếu cọc mồ côi ─────────
    const buildings = (await sbGet(
      auth,
      `buildings?select=id,name&organization_id=eq.${DEMO_ORG}&deleted_at=is.null`,
    )) as { id: string; name: string }[];
    expect(buildings.length, 'org DEMO phải có toà nhà').toBeGreaterThan(0);
    const buildingIds = buildings.map((b) => b.id);

    const rooms = (await sbGet(
      auth,
      `rooms?select=id,name,status,building_id&building_id=in.(${buildingIds.join(',')})` +
        `&status=eq.AVAILABLE&deleted_at=is.null`,
    )) as { id: string; name: string; status: string; building_id: string }[];
    const activeContracts = (await sbGet(
      auth,
      `contracts?select=room_id&status=eq.ACTIVE&deleted_at=is.null&organization_id=eq.${DEMO_ORG}`,
    )) as { room_id: string }[];
    const orphanDeposits = (await sbGet(
      auth,
      `income_expenses?select=room_id&organization_id=eq.${DEMO_ORG}&type=eq.INCOME` +
        `&approval_status=eq.APPROVED&contract_id=is.null&deleted_at=is.null&room_id=not.is.null`,
    )) as { room_id: string }[];
    const busy = new Set([
      ...activeContracts.map((c) => c.room_id),
      ...orphanDeposits.map((v) => v.room_id),
    ]);
    const candidates = rooms.filter((r) => !busy.has(r.id));
    expect(candidates.length, 'cần ít nhất 1 phòng DEMO trống sạch để ký HĐ').toBeGreaterThan(0);
    const room = candidates[Math.floor(Math.random() * candidates.length)];
    roomId = room.id;
    roomStatus0 = room.status;

    // ── 2. Hạng mục thu cọc (is_deposit) + khách hàng DEMO ───────────────────
    const [depositType] = (await sbGet(
      auth,
      `income_expense_types?select=id,name&organization_id=eq.${DEMO_ORG}` +
        `&type=eq.income&is_deposit=is.true&limit=1`,
    )) as { id: string; name: string }[];
    expect(depositType, 'org DEMO phải có hạng mục THU is_deposit').toBeTruthy();

    const [customer] = (await sbGet(
      auth,
      `customers?select=id,full_name&organization_id=eq.${DEMO_ORG}&deleted_at=is.null&limit=1`,
    )) as { id: string; full_name: string }[];
    expect(customer, 'org DEMO phải có khách hàng').toBeTruthy();

    // ── 3. Seed phiếu THU CỌC canonical (đường writer create_income_expense_v1)
    // Đúng đường màn "Tạo phiếu cọc giữ chỗ" (CreateDepositDialog): type INCOME,
    // room_id gắn phòng, contract_id NULL, item hạng mục cọc ⇒ trigger
    // set_ie_item_accounting_class gán accounting_class='DEPOSIT', trigger
    // recompute_room_reservation đẩy phòng sang RESERVED ("Đã cọc").
    const today = iso(new Date());
    const seed = await sbRpc(auth, 'create_income_expense_v1', {
      p_type: 'INCOME',
      p_name: `[E2E-LINK] Cọc giữ chỗ ${room.name} ${rnd()}`,
      p_building_id: room.building_id,
      p_room_id: room.id,
      p_tenant_id: null,
      p_contract_id: null,
      p_payer_name: customer.full_name,
      p_receive_bank_account: null,
      p_receive_bank_name: null,
      p_account_id: null, // phi tiền mặt → không sinh bút toán, dọn fixture gọn
      p_attachments: [],
      p_business_result_accounting: null,
      p_notes: null,
      p_voucher_date: today,
      p_items: [
        {
          income_expense_type_id: depositType.id,
          description: 'E2E link-contract deposit',
          quantity: 1,
          unit_price: DEPOSIT_AMOUNT,
          start_date: today,
          end_date: today,
        },
      ],
      p_idempotency_key: `e2e-link-seed-${rnd()}`,
    });
    expect(seed.ok, `seed create_income_expense_v1 → ${seed.status} ${seed.text}`).toBeTruthy();
    voucherId = (seed.json?.id ?? seed.json?.[0]?.id) as string;
    expect(voucherId, `writer phải trả phiếu: ${seed.text}`).toBeTruthy();

    const [voucher0] = (await sbGet(
      auth,
      `income_expenses?select=id,type,approval_status,contract_id,room_id,total_amount&id=eq.${voucherId}`,
    )) as { approval_status: string; contract_id: string | null; room_id: string; total_amount: string }[];
    expect(voucher0.approval_status, 'phiếu thu cọc phải APPROVED').toBe('APPROVED');
    expect(voucher0.contract_id, 'phiếu cọc phải đang mồ côi (contract_id NULL)').toBeNull();
    expect(voucher0.room_id).toBe(room.id);
    expect(Number(voucher0.total_amount)).toBe(DEPOSIT_AMOUNT);

    const items = (await sbGet(
      auth,
      `income_expense_items?select=accounting_class&income_expense_id=eq.${voucherId}`,
    )) as { accounting_class: string }[];
    expect(
      items.map((i) => i.accounting_class),
      'item phải mang accounting_class=DEPOSIT (điều kiện create_contract_v2 nhận phiếu)',
    ).toContain('DEPOSIT');

    // ── 4. ASSERT BẮT BUỘC: phiếu FLOW-OWNED (canonical) ────────────────────
    // Không flow-owned ⇒ guard early-return "legacy row" ⇒ bài test KHÔNG chạm
    // nhánh LINK_CONTRACT ⇒ xanh giả. Fail ngay tại đây thay vì báo cáo nhầm.
    const owned = await mgmtQuery(
      `select app_private.is_income_expense_flow_owned('${voucherId}') as owned;`,
    );
    expect(
      owned[0]?.owned,
      'phiếu cọc seed PHẢI flow-owned (canonical) — nếu false thì phải đổi cách seed, ' +
        'vì guard sẽ early-return và bài test không chứng minh được gì',
    ).toBe(true);

    // Phòng chuyển "Đã cọc" (RESERVED) — đúng bối cảnh bug production.
    const [roomAfterDeposit] = (await sbGet(auth, `rooms?select=status&id=eq.${room.id}`)) as {
      status: string;
    }[];
    expect(
      roomAfterDeposit.status,
      'phiếu cọc mồ côi phải đẩy phòng sang RESERVED (Đã cọc)',
    ).toBe('RESERVED');

    // ── 5. create_contract_v2 với existing_deposit_voucher_ids ──────────────
    const startDate = today;
    const endDate = addDays(today, 365);
    const endBilling = addDays(today, 29);
    const idemKey = `e2e-contract-link-${rnd()}`;
    const rpcArgs = {
      p_payload: {
        contract: {
          room_id: room.id,
          signed_date: startDate,
          start_date: startDate,
          end_date: endDate,
          rent_price: RENT_PRICE,
          total_deposit: DEPOSIT_AMOUNT, // = cọc đã thu ⇒ không thiếu cọc
          payment_cycle: 'MONTHLY',
          start_billing_date: startDate,
          end_billing_date: endBilling,
          contract_template_id: null,
          invoice_template_id: null,
          notes: '[E2E] link deposit canonical',
          discounts: [],
          deposit_debt_mode: null,
          deposit_debt_reason: null,
          deposit_topup_due_date: null,
        },
        customers: [{ customer_id: customer.id, is_representative: true, notes: null }],
        services: [],
        deposit_receipts: [],
        existing_deposit_voucher_ids: [voucherId],
      },
      p_idempotency_key: idemKey,
    };

    const created = await sbRpc(auth, 'create_contract_v2', rpcArgs);
    expect(
      created.json?.code === '55000' && /frozen/i.test(created.text),
      `REGRESSION cửa LINK_CONTRACT: guard vẫn đóng băng phiếu cọc canonical → ${created.status} ${created.text}`,
    ).toBeFalsy();
    expect(created.ok, `create_contract_v2 → ${created.status} ${created.text}`).toBeTruthy();

    contractId = created.json?.contract?.id as string;
    expect(contractId, `RPC phải trả hợp đồng: ${created.text}`).toBeTruthy();
    expect(created.json.contract.status).toBe('ACTIVE');
    expect(created.json.contract.room_id).toBe(room.id);
    expect(Number(created.json.deposit_paid), 'deposit_paid = cọc đã thu qua phiếu link').toBe(
      DEPOSIT_AMOUNT,
    );
    expect(Number(created.json.deposit_shortfall), 'không thiếu cọc').toBe(0);

    // ── 6. Bất biến sau khi ký ──────────────────────────────────────────────
    const [voucher1] = (await sbGet(
      auth,
      `income_expenses?select=contract_id,approval_status,total_amount,room_id&id=eq.${voucherId}`,
    )) as { contract_id: string | null; approval_status: string; total_amount: string; room_id: string }[];
    expect(voucher1.contract_id, 'phiếu cọc phải được gắn vào HĐ mới').toBe(contractId);
    expect(voucher1.approval_status, 'cửa hẹp không được đụng lifecycle').toBe('APPROVED');
    expect(Number(voucher1.total_amount), 'cửa hẹp không được đụng số tiền').toBe(DEPOSIT_AMOUNT);
    expect(voucher1.room_id, 'cửa hẹp không được đụng phòng').toBe(room.id);

    const links = (await sbGet(
      auth,
      `contract_deposit_links?select=contract_id,income_expense_id,link_source&contract_id=eq.${contractId}`,
    )) as { income_expense_id: string; link_source: string }[];
    expect(links.length, 'phải có đúng 1 link cọc').toBe(1);
    expect(links[0].income_expense_id).toBe(voucherId);
    expect(links[0].link_source).toBe('EXPLICIT_V2');

    const [roomAfter] = (await sbGet(auth, `rooms?select=status&id=eq.${room.id}`)) as {
      status: string;
    }[];
    expect(roomAfter.status, 'phòng phải chuyển sang đã thuê').toBe('OCCUPIED');

    // ── 7. Replay đúng idempotency key → KHÔNG sinh HĐ thứ hai ──────────────
    const replay = await sbRpc(auth, 'create_contract_v2', rpcArgs);
    expect(replay.ok, `replay create_contract_v2 → ${replay.status} ${replay.text}`).toBeTruthy();
    expect(replay.json?.contract?.id, 'replay phải trả đúng HĐ cũ').toBe(contractId);
    const contractsForRoom = (await sbGet(
      auth,
      `contracts?select=id&room_id=eq.${room.id}&deleted_at=is.null&status=eq.ACTIVE`,
    )) as { id: string }[];
    expect(contractsForRoom.length, 'replay KHÔNG được tạo HĐ thứ hai').toBe(1);

    // ── 8. Không có lỗi console app-level ───────────────────────────────────
    expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
  } finally {
    // ── Dọn fixture: huỷ phiếu cọc, soft-delete HĐ, trả phòng trạng thái cũ ──
    if (auth && voucherId) {
      await sbRpc(auth, 'ie_compat_cancel_v2', {
        p_ids: [voucherId],
        p_reason: 'e2e contract-create-linked-deposit cleanup',
      }).catch(() => undefined);
    }
    const sql: string[] = [];
    if (contractId) {
      sql.push(`update public.invoices set deleted_at = now() where contract_id = '${contractId}';`);
      sql.push(
        `update public.contracts set deleted_at = now(), status = 'TERMINATED' where id = '${contractId}';`,
      );
    }
    if (voucherId) {
      // Phiếu canonical: cấp token lifecycle trong CÙNG transaction (DO block)
      // rồi soft-delete — đúng allowlist của guard, không tắt trigger nào.
      sql.push(
        `do $cleanup$ begin
           insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
           values ('${voucherId}', pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
           on conflict (income_expense_id) do update
             set xid = excluded.xid, purpose = excluded.purpose, granted_at = now();
           update public.income_expenses
              set approval_status = 'CANCELLED',
                  review_state = 'RESOLVED',
                  cancellation_kind = coalesce(cancellation_kind, 'COMPAT_BATCH_CANCEL'),
                  deleted_at = now()
            where id = '${voucherId}' and deleted_at is null;
         end $cleanup$;`,
      );
    }
    // KHÔNG dọn app_private.canonical_write_operations: sổ writer là append-only
    // (guard_canonical_write_operation raise 55000). Vô hại — mỗi lần chạy sinh
    // idempotency key mới nên không kẹt lần sau.
    if (roomId && roomStatus0) {
      sql.push(`update public.rooms set status = '${roomStatus0}' where id = '${roomId}';`);
    }
    for (const stmt of sql) {
      try {
        await mgmtQuery(stmt);
      } catch (e) {
        console.error('[cleanup] bỏ qua lỗi:', (e as Error).message.slice(0, 300));
      }
    }
    await ctx.close();
  }
});
