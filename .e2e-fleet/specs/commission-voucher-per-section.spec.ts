import { test, expect, Page } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';

/**
 * Phiếu chi hoa hồng sau tạo HĐ — sổ quỹ RIÊNG cho thưởng nóng Sale + ảnh
 * chứng từ RIÊNG cho từng phiếu (broker/sale).
 *
 * Feature 06/08/2026: modal "Tạo phiếu chi hoa hồng" thêm
 *   - ô upload ảnh riêng mục 2 (Hoa hồng MG) và mục 3 (Thưởng nóng Sale)
 *   - dòng chọn sổ quỹ riêng cho thưởng nóng Sale (trước đây dùng chung mục 1)
 * RPC create_commission_voucher nhận thêm p_attachments (migration
 * 20260806090000, thân hàm chép từ bản prod ĐANG CHẠY — có organization_id,
 * SALE_BONUS_SEES_DEPOSIT_CLAIM, COMMISSION_AUTOPAY_V1).
 *
 * Bài này chứng minh qua HTTP thật (PostgREST + JWT user DEMO — đúng đường
 * hook useCreateCommissionVoucher gọi):
 *   1. Tạo HĐ DEMO qua create_contract_v2 (phòng trống, không cọc).
 *   2. Gọi create_commission_voucher kind=broker: sổ quỹ A + 2 ảnh.
 *      (amount cố ý KHÔNG khớp bậc hoa hồng → autopay verdict != VALID →
 *       phiếu ở UNAPPROVED, không ghi sổ — fixture dọn gọn.)
 *   3. Gọi kind=sale: sổ quỹ B KHÁC A + 1 ảnh khác.
 *   4. Assert từng phiếu mang đúng account_id + attachments của riêng nó.
 *   5. Edge: p_attachments không phải mảng → lỗi 23514, không tạo phiếu.
 *   6. Edge: gọi lại broker → P0001 "đã có phiếu" (chống chi trùng còn nguyên).
 *
 * CHỈ ghi org DEMO dddd0000-…0001. Fixture tự dọn (huỷ phiếu + HĐ, trả phòng).
 *
 * Chạy:
 *   cd .e2e-fleet && FLEET_PASS_CHUNHA=… SUPABASE_MGMT_PAT=… \
 *     npx playwright test specs/commission-voucher-per-section.spec.ts
 */

const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
const RENT_PRICE = 5_000_000;
// Cố ý lệch mọi bậc % hoa hồng để COMMISSION_AUTOPAY_V1 không tự duyệt
const BROKER_AMOUNT = 1_234_567;
const SALE_AMOUNT = 300_000;

async function captureSupabaseAuth(page: Page) {
  const req = await page.waitForRequest((r) => /\/rest\/v1\//.test(r.url()), { timeout: 30_000 });
  const h = req.headers();
  const base = new URL(req.url()).origin;
  return { base, apikey: h['apikey'], auth: h['authorization'] };
}
type SbAuth = Awaited<ReturnType<typeof captureSupabaseAuth>>;

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

async function mgmtQuery(sql: string): Promise<any[]> {
  const pat = process.env.SUPABASE_MGMT_PAT;
  const ref = process.env.SUPABASE_PROJECT_REF || 'tryymsxyyckgbrmmvozx';
  if (!pat) {
    throw new Error('Thiếu SUPABASE_MGMT_PAT — cần để dọn fixture. PAT ở CLAUDE.local.md, KHÔNG commit.');
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

test('commission-voucher-per-section: sổ quỹ riêng cho Sale + attachments riêng từng phiếu', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = trackConsoleErrors(page);

  let auth: SbAuth | null = null;
  let contractId: string | null = null;
  let brokerVoucherId: string | null = null;
  let saleVoucherId: string | null = null;
  let roomId: string | null = null;
  let roomStatus0: string | null = null;

  try {
    await login(page, 'chunha');
    const nav = page.goto('/income-expense');
    auth = await captureSupabaseAuth(page);
    await nav;

    // ── 1. Chọn phòng DEMO trống sạch + khách hàng + 2 sổ quỹ khác nhau ─────
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
    const busy = new Set(activeContracts.map((c) => c.room_id));
    const candidates = rooms.filter((r) => !busy.has(r.id));
    expect(candidates.length, 'cần ít nhất 1 phòng DEMO trống').toBeGreaterThan(0);
    const room = candidates[Math.floor(Math.random() * candidates.length)];
    roomId = room.id;
    roomStatus0 = room.status;

    const [customer] = (await sbGet(
      auth,
      `customers?select=id,full_name&organization_id=eq.${DEMO_ORG}&deleted_at=is.null&limit=1`,
    )) as { id: string; full_name: string }[];
    expect(customer, 'org DEMO phải có khách hàng').toBeTruthy();

    const accounts = (await sbGet(
      auth,
      `accounts?select=id,name&organization_id=eq.${DEMO_ORG}&deleted_at=is.null&limit=5`,
    )) as { id: string; name: string }[];
    expect(accounts.length, 'cần ≥2 sổ quỹ DEMO để chứng minh chọn riêng').toBeGreaterThan(1);
    const brokerAccount = accounts[0];
    const saleAccount = accounts[1];
    expect(brokerAccount.id).not.toBe(saleAccount.id);

    // ── 2. Tạo HĐ (không cọc — chỉ làm nền cho phiếu HH) ────────────────────
    const today = iso(new Date());
    const created = await sbRpc(auth, 'create_contract_v2', {
      p_payload: {
        contract: {
          room_id: room.id,
          signed_date: today,
          start_date: today,
          end_date: addDays(today, 365),
          rent_price: RENT_PRICE,
          total_deposit: 0,
          payment_cycle: 'MONTHLY',
          start_billing_date: today,
          end_billing_date: addDays(today, 29),
          contract_template_id: null,
          invoice_template_id: null,
          notes: '[E2E] commission per-section fixture',
          discounts: [],
          deposit_debt_mode: null,
          deposit_debt_reason: null,
          deposit_topup_due_date: null,
        },
        customers: [{ customer_id: customer.id, is_representative: true, notes: null }],
        services: [],
        deposit_receipts: [],
        existing_deposit_voucher_ids: [],
      },
      p_idempotency_key: `e2e-comm-section-${rnd()}`,
    });
    expect(created.ok, `create_contract_v2 → ${created.status} ${created.text}`).toBeTruthy();
    contractId = created.json?.contract?.id as string;
    expect(contractId, `RPC phải trả hợp đồng: ${created.text}`).toBeTruthy();

    // ── 3. Phiếu BROKER: sổ quỹ A + 2 ảnh riêng ─────────────────────────────
    const brokerImgs = [
      `https://example.test/storage/v1/object/public/income-expense-attachments/e2e/broker-${rnd()}.png`,
      `https://example.test/storage/v1/object/public/income-expense-attachments/e2e/broker-${rnd()}.pdf`,
    ];
    const broker = await sbRpc(auth, 'create_commission_voucher', {
      p_contract_id: contractId,
      p_kind: 'broker',
      p_amount: BROKER_AMOUNT,
      p_voucher_date: today,
      p_account_id: brokerAccount.id,
      p_payer_name: 'E2E Đơn vị MG',
      p_recipient_name: 'E2E Người nhận MG',
      p_recipient_bank: null,
      p_recipient_account: null,
      p_item_description: '[E2E] hoa hồng MG per-section',
      p_attachments: brokerImgs,
    });
    expect(broker.ok, `create_commission_voucher broker → ${broker.status} ${broker.text}`).toBeTruthy();
    brokerVoucherId = broker.json?.id as string;
    expect(brokerVoucherId).toBeTruthy();

    // ── 4. Phiếu SALE: sổ quỹ B (khác A) + 1 ảnh khác ───────────────────────
    const saleImgs = [
      `https://example.test/storage/v1/object/public/income-expense-attachments/e2e/sale-${rnd()}.jpg`,
    ];
    const sale = await sbRpc(auth, 'create_commission_voucher', {
      p_contract_id: contractId,
      p_kind: 'sale',
      p_amount: SALE_AMOUNT,
      p_voucher_date: today,
      p_account_id: saleAccount.id,
      p_payer_name: 'E2E Sale',
      p_recipient_name: 'E2E Người nhận Sale',
      p_recipient_bank: null,
      p_recipient_account: null,
      p_item_description: '[E2E] thưởng nóng Sale per-section',
      p_attachments: saleImgs,
    });
    expect(sale.ok, `create_commission_voucher sale → ${sale.status} ${sale.text}`).toBeTruthy();
    saleVoucherId = sale.json?.id as string;
    expect(saleVoucherId).toBeTruthy();

    // ── 5. Bất biến: mỗi phiếu mang đúng sổ quỹ + ảnh CỦA RIÊNG NÓ ─────────
    const vouchers = (await sbGet(
      auth,
      `income_expenses?select=id,commission_kind,account_id,attachments,approval_status,total_amount` +
        `&id=in.(${brokerVoucherId},${saleVoucherId})`,
    )) as {
      id: string;
      commission_kind: string;
      account_id: string | null;
      attachments: string[] | null;
      approval_status: string;
      total_amount: string;
    }[];
    expect(vouchers.length).toBe(2);

    const vBroker = vouchers.find((v) => v.commission_kind === 'broker')!;
    const vSale = vouchers.find((v) => v.commission_kind === 'sale')!;
    expect(vBroker, 'phải có phiếu broker').toBeTruthy();
    expect(vSale, 'phải có phiếu sale').toBeTruthy();

    expect(vBroker.account_id, 'broker phải mang sổ quỹ A').toBe(brokerAccount.id);
    expect(vSale.account_id, 'sale phải mang sổ quỹ B riêng — không dính sổ quỹ chung').toBe(
      saleAccount.id,
    );
    expect(vBroker.attachments, 'ảnh của broker phải đúng bộ 2 ảnh riêng').toEqual(brokerImgs);
    expect(vSale.attachments, 'ảnh của sale phải đúng 1 ảnh riêng — không lẫn ảnh broker').toEqual(
      saleImgs,
    );
    expect(Number(vBroker.total_amount)).toBe(BROKER_AMOUNT);
    expect(Number(vSale.total_amount)).toBe(SALE_AMOUNT);
    // Amount lệch bậc ⇒ autopay không tự duyệt (fixture phải còn UNAPPROVED để dọn sạch)
    expect(vBroker.approval_status, 'broker lệch bậc phải còn chờ duyệt').toBe('UNAPPROVED');
    expect(vSale.approval_status).toBe('UNAPPROVED');

    // ── 6. Edge: p_attachments không phải mảng → 23514, không sinh phiếu ────
    const badReq = await sbRpc(auth, 'create_commission_voucher', {
      p_contract_id: contractId,
      p_kind: 'sale',
      p_amount: 1000,
      p_voucher_date: today,
      p_attachments: { url: 'x' },
    });
    expect(badReq.ok, 'attachments dạng object phải bị từ chối').toBeFalsy();
    expect(badReq.text).toContain('Ảnh chứng từ không hợp lệ');

    // ── 7. Edge: chi trùng broker → P0001 "đã có phiếu" ─────────────────────
    const dup = await sbRpc(auth, 'create_commission_voucher', {
      p_contract_id: contractId,
      p_kind: 'broker',
      p_amount: 999,
      p_voucher_date: today,
      p_attachments: [],
    });
    expect(dup.ok, 'chi trùng phải bị chặn').toBeFalsy();
    expect(dup.text).toContain('đã có phiếu');

    // ── 8. Không có lỗi console app-level ───────────────────────────────────
    expect(errs, `console errors: ${errs.join(' | ')}`).toEqual([]);
  } finally {
    // ── Dọn fixture: huỷ 2 phiếu HH (UNAPPROVED), soft-delete HĐ, trả phòng ──
    const sql: string[] = [];
    for (const vid of [brokerVoucherId, saleVoucherId]) {
      if (!vid) continue;
      sql.push(
        `do $cleanup$ begin
           insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
           values ('${vid}', pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
           on conflict (income_expense_id) do update
             set xid = excluded.xid, purpose = excluded.purpose, granted_at = now();
           update public.income_expenses
              set approval_status = 'CANCELLED',
                  review_state = 'RESOLVED',
                  cancellation_kind = coalesce(cancellation_kind, 'COMPAT_BATCH_CANCEL'),
                  deleted_at = now()
            where id = '${vid}' and deleted_at is null;
         end $cleanup$;`,
      );
    }
    if (contractId) {
      sql.push(`update public.invoices set deleted_at = now() where contract_id = '${contractId}';`);
      sql.push(
        `update public.contracts set deleted_at = now(), status = 'TERMINATED' where id = '${contractId}';`,
      );
    }
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
