// Câu 26 (chủ chốt 21/10/2026): kiểm quyền ở MÁY CHỦ khớp đúng quyền web cho huỷ / khôi phục hoá đơn
// và hoàn tiền hoá đơn. Trước vá: web gác Huỷ/Khôi phục bằng invoices.cancel HOẶC invoices.delete và
// Hoàn trả khách bằng invoices.record_payment, nhưng RPC chỉ hỏi invoices.edit (huỷ) hoặc chỉ hỏi là
// thành viên (hoàn tiền); PATCH thẳng invoices.status sang CANCELLED chỉ cần invoices.edit (RLS).
//
// Chạy logic THẬT trên PGlite: thân production của 5 hàm (= thân trong migration bỏ đúng dòng mang
// dấu [q26]; md5 phải khớp md5 production ghim ở tiền kiểm) + helper require_building_perm_v1 theo
// định nghĩa SỐNG (câu 25 chuyển phép kiểm của nó sang has_building_perm_v1). Quyền giả lập bằng
// test.perms; đường REST = SET LOCAL ROLE authenticated; writer SECURITY DEFINER chạy dưới chủ hàm
// như production. Credit/rent support/sổ là stub.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PATCH = 'supabase/migrations/20261021181209_invoice_cancel_refund_permission_guard_v1.sql';
const MARK = '-- [q26] kiểm quyền máy chủ khớp web';

const org = '00000000-0000-4000-8000-000000000001';
const actor = '00000000-0000-4000-8000-000000000002';
const building = '00000000-0000-4000-8000-000000000003';
const otherBuilding = '00000000-0000-4000-8000-000000000013';
const invoice = '00000000-0000-4000-8000-000000000021';
const paidInvoice = '00000000-0000-4000-8000-000000000022';
const cancelled = '00000000-0000-4000-8000-000000000023';
const otherInvoice = '00000000-0000-4000-8000-000000000024';
const draftInvoice = '00000000-0000-4000-8000-000000000025';
const EDIT_ONLY = 'invoices.view,invoices.edit';
const EDIT_CANCEL = 'invoices.view,invoices.edit,invoices.cancel';
const EDIT_DELETE = 'invoices.view,invoices.edit,invoices.delete';
const CANCEL_NO_EDIT = 'invoices.view,invoices.cancel,invoices.delete';
const VIEW_ONLY = 'invoices.view';
const PAYMENT = 'invoices.view,invoices.record_payment';

const patchSql = readFileSync(PATCH, 'utf8');

// Định nghĩa SỐNG = lần CREATE cuối theo timestamp migration (khuôn liveDefinitionOf ở
// salaryCompletionDate.test.ts), cắt từ CREATE tới hết thân dollar-quoted. Đọc thư mục một lần.
let migrationCorpus: string[] | null = null;
function liveFunctionSql(schema: string, fnName: string): string {
  migrationCorpus ??= readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()
    .map((f) => readFileSync(join('supabase/migrations', f), 'utf8').replace(/--[^\n]*/g, ''));
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${fnName}\\s*\\(`, 'gi');
  let hit: string | null = null;
  for (const sql of migrationCorpus) {
    for (const m of sql.matchAll(re)) hit = sql.slice(m.index);
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của ${schema}.${fnName}`);
  const tag = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(hit);
  if (!tag) throw new Error(`Không thấy thân hàm ${schema}.${fnName}`);
  return `${hit.slice(0, hit.indexOf(tag[1], tag.index + tag[0].length) + tag[1].length)};`;
}

/** Khối chép nguyên từ pg_get_functiondef (dòng 2 " RETURNS …", thân $function$) — đúng các hàm được vá. */
function patchedBlocks(): string[] {
  return [...patchSql.matchAll(/CREATE OR REPLACE FUNCTION [^\n]*\n RETURNS [\s\S]*?\$function\$;\n/g)].map((m) => m[0]);
}
const prodBlock = (block: string) => block.split('\n').filter((line) => !line.includes(MARK)).join('\n');
function pinnedMd5(): Array<[string, string]> {
  const values = patchSql.slice(patchSql.indexOf('FOR r IN SELECT * FROM (VALUES'), patchSql.indexOf(') AS t(sig, md5)'));
  return [...values.matchAll(/\('([^']+)', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]);
}

async function build(db: PGlite, { patch, helper = true }: { patch: boolean; helper?: boolean }) {
  await db.exec(`SET check_function_bodies = off;
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT coalesce(nullif(current_setting('test.actor',true),''),'${actor}')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
    CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid);
    CREATE TABLE invoices(id uuid PRIMARY KEY,invoice_number text,contract_id uuid,building_id uuid,organization_id uuid,status text,
      paid_amount numeric DEFAULT 0,notes text,deleted_at timestamptz,approved_at timestamptz,approved_by uuid,updated_at timestamptz DEFAULT now());
    GRANT SELECT, UPDATE ON invoices TO authenticated, service_role;
    CREATE TABLE customer_credit_applications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),invoice_id uuid,amount numeric,
      reversed_at timestamptz,restored_at timestamptz,restored_by uuid,restoration_idempotency_key text);
    CREATE TABLE income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),notes text);
    CREATE TABLE refund_calls(invoice_id uuid,amount numeric,refund_class text,actor uuid,building uuid);
    CREATE TABLE app_private.accounting_chain_writer_xids(transaction_id bigint,backend_pid int);
    -- Quyền giả lập: test.perms = khoá người gọi có ở toà A; test.super = super admin; test.member = còn là thành viên.
    CREATE FUNCTION public.test_perms() RETURNS text[] LANGUAGE sql AS $$
      SELECT string_to_array(coalesce(nullif(current_setting('test.perms',true),''),'${EDIT_CANCEL}'),',') $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.super',true),'')='yes' $$;
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT public.is_super_admin() OR ($3='${building}' AND ($1||'.'||$2)=ANY(public.test_perms())) $$;
    CREATE FUNCTION app_private.can_edit_invoice_building_v1(uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT public.can_do_on_building('invoices','edit',$1) $$;
    CREATE FUNCTION app_private.ie_compat_actor_v2(uuid) RETURNS TABLE(user_id uuid, membership_id uuid) LANGUAGE sql AS $$
      SELECT auth.uid(), '00000000-0000-4000-8000-0000000000b1'::uuid
       WHERE $1='${org}' AND coalesce(current_setting('test.member',true),'')<>'no' $$;
    CREATE FUNCTION app_private.reserve_invoice_refund_obligation_v2(p_org uuid,p_invoice_id uuid,p_building_id uuid,p_amount numeric,p_refund_class text,
      p_system_source text,p_actor_user uuid,p_actor_membership uuid,p_idempotency_key text) RETURNS jsonb LANGUAGE plpgsql AS $fn$ BEGIN
      INSERT INTO refund_calls VALUES(p_invoice_id,p_amount,p_refund_class,p_actor_user,p_building_id);
      RETURN jsonb_build_object('refundVoucherId',gen_random_uuid(),'reservationState','HELD','replayed',false); END $fn$;
    CREATE FUNCTION app_private.invoice_rent_support_lock_v1(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION app_private.assert_invoice_credit_cancellable_v1(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION app_private.reverse_invoice_customer_credit_v1(uuid,uuid,text,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
    CREATE FUNCTION app_private.apply_customer_credit_fifo_v1(uuid,uuid,numeric,uuid,text,text,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
    CREATE FUNCTION app_private.begin_accounting_chain_write_v1() RETURNS void LANGUAGE sql AS $$
      INSERT INTO app_private.accounting_chain_writer_xids VALUES(txid_current(),pg_backend_pid()) $$;
    CREATE FUNCTION app_private.end_accounting_chain_write_v1() RETURNS void LANGUAGE sql AS $$
      DELETE FROM app_private.accounting_chain_writer_xids WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid() $$;
    -- Writer nội bộ (như thanh lý bỏ cọc huỷ hoá đơn còn nợ): SECURITY DEFINER, chạy dưới chủ hàm.
    CREATE FUNCTION public.test_internal_cancel(uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
      UPDATE invoices SET status='CANCELLED' WHERE id=$1 $$;
  `);
  if (helper) {
    await db.exec(liveFunctionSql('app_private', 'has_building_perm_v1'));
    await db.exec(liveFunctionSql('app_private', 'require_building_perm_v1'));
  }
  for (const block of patchedBlocks()) await db.exec(prodBlock(block));
  await db.exec('RESET check_function_bodies');
  if (patch) {
    await db.exec(patchSql);
    await db.exec(patchSql);
  }
}

const before = new PGlite();
const after = new PGlite();

beforeAll(async () => {
  await Promise.all([build(before, { patch: false }), build(after, { patch: true })]);
}, 60000);
afterAll(async () => {
  await Promise.all([before.close(), after.close()]);
});

type Row = Record<string, unknown>;
type DbError = { code?: string; message?: string };

async function scenario(db: PGlite, fn: () => Promise<void>) {
  await db.exec(`BEGIN;
    INSERT INTO invoices(id,invoice_number,building_id,organization_id,status,paid_amount) VALUES
      ('${invoice}','HD-001','${building}','${org}','APPROVED',0),
      ('${paidInvoice}','HD-002','${building}','${org}','PARTIAL_PAID',500000),
      ('${cancelled}','HD-003','${building}','${org}','CANCELLED',0),
      ('${otherInvoice}','HD-004','${otherBuilding}','${org}','PAID',2000000),
      ('${draftInvoice}','HD-005','${building}','${org}','DRAFT',0);`);
  try {
    await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}

const grantPerms = (db: PGlite, perms: string) => db.exec(`SELECT set_config('test.perms','${perms}',true)`);

async function asUser<T extends Row>(db: PGlite, sql: string, params: unknown[] = [], role = 'authenticated') {
  await db.exec(`SET LOCAL ROLE ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function rejectedAsUser(db: PGlite, sql: string, params: unknown[], code: string, message?: RegExp) {
  await db.exec('SAVEPOINT expected_failure; SET LOCAL ROLE authenticated');
  try {
    const err = await db.query(sql, params).then(() => null, (e: unknown) => e as DbError);
    expect(err, `phải lỗi ${code}: ${sql}`).not.toBeNull();
    expect(err?.code).toBe(code);
    if (message) expect(err?.message).toMatch(message);
  } finally {
    await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure');
  }
}

const status = async (db: PGlite, id: string) =>
  (await db.query<{ status: string }>('SELECT status FROM invoices WHERE id=$1', [id])).rows[0].status;
const refunds = async (db: PGlite) => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM refund_calls')).rows[0].n;

const CANCEL_CREDIT = "SELECT cancel_invoice_with_credit_v1($1,'cancel-key-0001') AS result";
const CANCEL_V1 = 'SELECT (cancel_invoice_v1($1)).status AS result';
const RESTORE_CREDIT = "SELECT restore_invoice_with_credit_v1($1,'restore-key-0001') AS result";
const RESTORE_V1 = 'SELECT (restore_invoice_v1($1)).status AS result';
const REFUND = "SELECT create_invoice_refund_obligation_v2($1,200000,'Khách trả thừa','REFUND_CONTRA_REVENUE','refund-key-0001') AS result";
const CANCEL_DENIED = /\[THIEU_QUYEN:invoices\.cancel\|invoices\.delete\]/;
const REFUND_DENIED = /\[THIEU_QUYEN:invoices\.record_payment\]/;
const VIA_RPC = /\[HOA_DON_HUY_QUA_RPC\]/;

describe('migration — ghim thân production và tự kiểm catalog', () => {
  it('5 thân nạp từ migration (bỏ dòng [q26]) có đúng md5 production đã ghim', async () => {
    const pins = pinnedMd5();
    expect(pins).toHaveLength(5);
    expect(patchedBlocks()).toHaveLength(5);
    for (const [sig, md5] of pins) {
      const got = (await before.query<{ md5: string }>('SELECT md5(pg_get_functiondef($1::regprocedure)) AS md5', [sig])).rows[0].md5;
      expect(got, sig).toBe(md5);
    }
  });

  it('mỗi hàm vá chỉ thêm đúng một dòng kiểm quyền; ACL và SECURITY DEFINER giữ nguyên', async () => {
    for (const [sig] of pinnedMd5()) {
      const [b, a] = await Promise.all([before, after].map(async (db) =>
        (await db.query<{ def: string; acl: string | null; definer: boolean }>(
          'SELECT pg_get_functiondef(oid) AS def, proacl::text AS acl, prosecdef AS definer FROM pg_proc WHERE oid=$1::regprocedure', [sig])).rows[0]));
      const added = a.def.split('\n').filter((line) => !b.def.split('\n').includes(line));
      expect(added, sig).toHaveLength(1);
      expect(added[0]).toContain('app_private.require_building_perm_v1(');
      expect(prodBlock(a.def)).toBe(b.def);
      expect({ acl: a.acl, definer: a.definer }).toEqual({ acl: b.acl, definer: true });
    }
  });

  it('dừng 55000 khi thân đang chạy khác bản đã đối chiếu', async () => {
    await before.exec('BEGIN');
    try {
      await before.exec(prodBlock(patchedBlocks()[0]).replace("'Invalid idempotency_key'", "'Invalid idempotency key'"));
      await expect(before.exec(patchSql)).rejects.toMatchObject({ code: '55000' });
    } finally {
      await before.exec('ROLLBACK');
    }
  });

  it('dừng 55000 khi chưa áp migration hợp đồng (thiếu helper dùng chung)', async () => {
    const bare = new PGlite();
    try {
      await build(bare, { patch: false, helper: false });
      await expect(bare.exec(patchSql)).rejects.toMatchObject({ code: '55000' });
    } finally {
      await bare.close();
    }
  });

  it('trigger chỉ chạy trên đường REST và hàm trigger không ai gọi trực tiếp được', async () => {
    const trg = (await after.query<Row>(`SELECT pg_get_triggerdef(t.oid) AS def,
        has_function_privilege('authenticated', t.tgfoid, 'EXECUTE') AS auth_exec
      FROM pg_trigger t WHERE t.tgname = 'a01_invoice_cancel_status_guard'`)).rows;
    expect(trg).toHaveLength(1);
    expect(trg[0].def).toMatch(/BEFORE UPDATE OF status ON public\.invoices/);
    expect(trg[0].def).toMatch(/WHEN \(\(CURRENT_USER = ANY \(ARRAY\['authenticated'::name, 'anon'::name\]\)\)\)/);
    expect(trg[0].auth_exec).toBe(false);
  });
});

describe('trước vá — tái hiện lỗ trên định nghĩa đang chạy', () => {
  it('chỉ có invoices.edit (web giấu nút Huỷ) vẫn huỷ được qua RPC', () => scenario(before, async () => {
    await grantPerms(before, EDIT_ONLY);
    await asUser(before, CANCEL_CREDIT, [invoice]);
    expect(await status(before, invoice)).toBe('CANCELLED');
  }));

  // Hoá đơn đã phát hành trên production còn bị guard_paid_invoice_direct_adjustment chặn mọi PATCH
  // (hệ quả phụ của cột sinh remaining_amount — đo TEST 22/10); hoá đơn NHÁP thì không.
  it('PATCH thẳng hoá đơn NHÁP sang CANCELLED chỉ cần invoices.edit (lách invoices.cancel)', () => scenario(before, async () => {
    await grantPerms(before, EDIT_ONLY);
    await asUser(before, "UPDATE invoices SET status='CANCELLED' WHERE id=$1", [draftInvoice]);
    expect(await status(before, draftInvoice)).toBe('CANCELLED');
  }));

  it('vai chỉ xem vẫn sinh được phiếu chi hoàn tiền', () => scenario(before, async () => {
    await grantPerms(before, VIEW_ONLY);
    await asUser(before, REFUND, [paidInvoice]);
    expect(await refunds(before)).toBe(1);
  }));
});

describe('sau vá — huỷ / khôi phục đòi invoices.cancel hoặc invoices.delete', () => {
  it.each([
    ['cancel_invoice_with_credit_v1 (web)', CANCEL_CREDIT, invoice],
    ['cancel_invoice_v1 (gọi thẳng)', CANCEL_V1, invoice],
    ['restore_invoice_with_credit_v1 (web)', RESTORE_CREDIT, cancelled],
    ['restore_invoice_v1 (gọi thẳng)', RESTORE_V1, cancelled],
  ])('%s chỉ có invoices.edit ⇒ 42501, trạng thái không đổi', (_label, sql, id) => scenario(after, async () => {
    const was = await status(after, id);
    await grantPerms(after, EDIT_ONLY);
    await rejectedAsUser(after, sql, [id], '42501', CANCEL_DENIED);
    expect(await status(after, id)).toBe(was);
  }));

  it.each([
    ['invoices.cancel', EDIT_CANCEL],
    ['invoices.delete (web cũng cho)', EDIT_DELETE],
  ])('có %s ⇒ huỷ rồi khôi phục được như cũ', (_label, perms) => scenario(after, async () => {
    await grantPerms(after, perms);
    await asUser(after, CANCEL_CREDIT, [invoice]);
    expect(await status(after, invoice)).toBe('CANCELLED');
    await asUser(after, RESTORE_CREDIT, [invoice]);
    expect(await status(after, invoice)).toBe('APPROVED');
    await asUser(after, CANCEL_V1, [invoice]);
    await asUser(after, RESTORE_V1, [invoice]);
    expect(await status(after, invoice)).toBe('APPROVED');
  }));

  it('thiếu invoices.edit thì rào cũ vẫn chặn (không nới quyền): 42501 không phải [THIEU_QUYEN]', () => scenario(after, async () => {
    await grantPerms(after, CANCEL_NO_EDIT);
    await rejectedAsUser(after, CANCEL_CREDIT, [invoice], '42501', /Missing permission to cancel invoice/);
    await rejectedAsUser(after, RESTORE_CREDIT, [cancelled], '42501', /Missing permission to restore invoice/);
  }));

  it('hoá đơn ở toà không được giao ⇒ 42501', () => scenario(after, async () => {
    await grantPerms(after, EDIT_CANCEL);
    await rejectedAsUser(after, CANCEL_CREDIT, [otherInvoice], '42501');
  }));

  it('rào nghiệp vụ cũ giữ nguyên: hoá đơn đã thu tiền vẫn không huỷ được dù đủ quyền', () => scenario(after, async () => {
    await grantPerms(after, EDIT_CANCEL);
    await rejectedAsUser(after, CANCEL_CREDIT, [paidInvoice], 'P0001', /Không thể huỷ hoá đơn/);
  }));

  it('super admin (web cho mọi nút) vẫn huỷ / khôi phục được', () => scenario(after, async () => {
    await grantPerms(after, 'none.none');
    await after.exec("SELECT set_config('test.super','yes',true)");
    await asUser(after, CANCEL_CREDIT, [invoice]);
    await asUser(after, RESTORE_CREDIT, [cancelled]);
    expect([await status(after, invoice), await status(after, cancelled)]).toEqual(['CANCELLED', 'APPROVED']);
  }));
});

describe('sau vá — hoàn tiền hoá đơn đòi invoices.record_payment ở đúng toà', () => {
  it.each([
    ['vai chỉ xem', VIEW_ONLY],
    ['chỉ có invoices.edit', EDIT_ONLY],
  ])('%s ⇒ 42501, không sinh phiếu', (_label, perms) => scenario(after, async () => {
    await grantPerms(after, perms);
    await rejectedAsUser(after, REFUND, [paidInvoice], '42501', REFUND_DENIED);
    expect(await refunds(after)).toBe(0);
  }));

  it('có invoices.record_payment ở toà của hoá đơn ⇒ sinh phiếu như cũ', () => scenario(after, async () => {
    await grantPerms(after, PAYMENT);
    const [{ result }] = await asUser<{ result: Row }>(after, REFUND, [paidInvoice]);
    expect(result).toMatchObject({ reservationState: 'HELD' });
    expect(await refunds(after)).toBe(1);
  }));

  it('có invoices.record_payment nhưng hoá đơn ở toà khác ⇒ 42501', () => scenario(after, async () => {
    await grantPerms(after, PAYMENT);
    await rejectedAsUser(after, REFUND, [otherInvoice], '42501', REFUND_DENIED);
    expect(await refunds(after)).toBe(0);
  }));

  it('không còn là thành viên thì vẫn bị rào cũ chặn trước', () => scenario(after, async () => {
    await grantPerms(after, PAYMENT);
    await after.exec("SELECT set_config('test.member','no',true)");
    await rejectedAsUser(after, REFUND, [paidInvoice], '42501', /membership/);
  }));
});

describe('sau vá — đổi trạng thái hoá đơn vào/ra CANCELLED qua REST bị chặn', () => {
  it.each([
    ['NHÁP → CANCELLED', draftInvoice, 'CANCELLED'],
    ['APPROVED → CANCELLED', invoice, 'CANCELLED'],
    ['PARTIAL_PAID (đã thu) → CANCELLED', paidInvoice, 'CANCELLED'],
    ['CANCELLED → APPROVED (khôi phục chay)', cancelled, 'APPROVED'],
  ])('%s ⇒ 42501', (_label, id, to) => scenario(after, async () => {
    const was = await status(after, id);
    await grantPerms(after, EDIT_CANCEL);
    await rejectedAsUser(after, 'UPDATE invoices SET status=$2 WHERE id=$1', [id, to], '42501', VIA_RPC);
    expect(await status(after, id)).toBe(was);
  }));

  it('trigger chỉ canh vào/ra CANCELLED: đổi trạng thái khác và sửa ghi chú hoá đơn nháp vẫn được', () => scenario(after, async () => {
    await asUser(after, "UPDATE invoices SET status='OVERDUE', notes='nhắc' WHERE id=$1", [invoice]);
    await asUser(after, "UPDATE invoices SET status='CANCELLED', notes='giữ' WHERE id=$1", [cancelled]);
    await asUser(after, "UPDATE invoices SET notes='ghi chú nháp' WHERE id=$1", [draftInvoice]);
    expect([await status(after, invoice), await status(after, cancelled), await status(after, draftInvoice)])
      .toEqual(['OVERDUE', 'CANCELLED', 'DRAFT']);
  }));

  it('writer SECURITY DEFINER nội bộ (thanh lý bỏ cọc huỷ hoá đơn) và service_role đi thẳng như cũ', () => scenario(after, async () => {
    await asUser(after, 'SELECT test_internal_cancel($1)', [invoice]);
    await asUser(after, "UPDATE invoices SET status='CANCELLED' WHERE id=$1", [paidInvoice], 'service_role');
    expect([await status(after, invoice), await status(after, paidInvoice)]).toEqual(['CANCELLED', 'CANCELLED']);
  }));
});
