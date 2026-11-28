import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

// Dọn hàm máy chủ mồ côi: XOÁ 5 hàm không còn ai gọi, THU QUYỀN gọi thẳng của 3 hàm chỉ còn hàm khác trên máy chủ gọi,
// GIỮ NGUYÊN 6 hàm. Dựng trạng thái «đang sống ngay trước migration» bằng THÂN THẬT (thân trong repo = thân production,
// so md5 prosrc), chạy nguyên tệp migration HAI lượt rồi kiểm: hàm bị xoá biến mất; vai đăng nhập gọi thẳng hàm bị thu
// quyền ⇒ 42501, service_role vẫn gọi được; người gọi bên trong vẫn chạy y như trước (hai hàm thực thi của trợ lý gọi
// approve_*; verify_income_expense_v1 với phiếu đường cũ, cả ba kiểu gọi); hàng rào dừng tệp khi có người gọi mới.
//
// Chủ hàm ở đây là một vai KHÔNG phải superuser (như postgres trên Supabase): nếu để superuser làm chủ, lời gọi bên trong
// hàm SECURITY DEFINER sẽ vượt mọi ACL và phép thử «người gọi bên trong vẫn chạy» thành xanh rỗng.
const MIG_DIR = 'supabase/migrations';
const MIGRATION_FILE = '20261128080342_don_ham_mo_coi.sql';
const migrationSql = readFileSync(join(MIG_DIR, MIGRATION_FILE), 'utf8').replace(/\r\n/g, '\n');
const baselineSql = readFileSync('supabase/baseline/schema.sql', 'utf8').replace(/\r\n/g, '\n');

/** CREATE FUNCTION cuối cùng của `name` trong một văn bản SQL (nguyên câu, tới dấu chấm phẩy sau thân). */
function lastCreate(text: string, name: string): string | null {
  const head = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name.replace('.', '\\.')}\\s*\\(`, 'gi');
  let found: string | null = null;
  for (const m of text.matchAll(head)) {
    const start = m.index ?? 0;
    const tag = text.slice(start).match(/\bAS\s+(\$[A-Za-z_]*\$)/i);
    if (!tag || tag.index === undefined) continue;
    const bodyStart = start + tag.index + tag[0].length;
    const end = text.indexOf(tag[1], bodyStart);
    const stop = end < 0 ? -1 : text.indexOf(';', end + tag[1].length);
    if (stop > 0) found = text.slice(start, stop + 1);
  }
  return found;
}

/** Định nghĩa đang chạy khi tệp này áp: CREATE cuối ở các migration TRƯỚC tệp này, không có thì ở baseline (dump prod). */
function liveBefore(name: string): string {
  let sql: string | null = null;
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql') && x < MIGRATION_FILE).sort()) {
    sql = lastCreate(readFileSync(join(MIG_DIR, f), 'utf8').replace(/\r\n/g, '\n'), name) ?? sql;
  }
  sql ??= lastCreate(baselineSql, name);
  if (!sql) throw new Error(`Không thấy định nghĩa trước của ${name}`);
  return sql;
}

// md5 prosrc đo trên production 28/11/2026 (chỉ đọc, `md5(replace(prosrc, chr(13), ''))`).
const PROD_MD5: Record<string, string> = {
  'public.bulk_create_meter_readings(jsonb)': 'cc4f1f5d096eb596ae33d4ac38f49718',
  'public.bulk_create_meter_readings_v1(jsonb)': '5fc23a265189cc580b49726791704ac6',
  'public.bulk_approve_meter_readings_v1(uuid[])': '4fb98d3e892b30cc92388af95910e267',
  'public.confirm_reconciliation(uuid)': 'ba98ef471687b3cc3668c03a04987a6c',
  'public.cancel_reconciliation(uuid)': '3c55458446a5c35b34ff99381a838de8',
  'public.approve_invoice_v1(uuid)': '3ead9c52ee446478d6e3f90ecb7f0eab',
  'public.approve_meter_reading_v1(uuid)': 'ecb7bf708540193568e922a9c809f907',
  'public.verify_income_expense(uuid,text)': '39fd56487277e0729900b861152d2c67',
  'public.decide_financial_request_v2(uuid,text,text)': 'de18b25abe4d72a7de5eb9ff6b79e461',
  'public.unapprove_invoice_v1(uuid)': 'a7fbfae5812272a8ad2b0236126f46f5',
  'public.unapprove_meter_reading_v1(uuid)': 'afa86393045e9b270b3c226b99b43d58',
  'public.get_approval_request_detail_compat_v2(uuid)': '733a1e80b9d35dfd60f5e773e4654cfa',
  'public.withdraw_financial_request_v1(uuid,text)': 'e017dc822074b30cb800645d8dadeb48',
  'public.verify_income_expense_v1(uuid,text,boolean)': '5c6cc367eb9324083277f1b72061dbef',
  'public.copilot_execute_invoice_duyet_v1(text,jsonb)': 'f3eeed2430d39e8b54800acb792e267e',
  'public.copilot_execute_meter_reading_duyet_v1(text,jsonb)': 'd9559d0597a79cd358906b00279c602d',
  'public.meter_capture_v1(uuid,text,jsonb)': '2c30a046207ce05f00544e81ea4de227',
};
const XOA = ['public.bulk_create_meter_readings(jsonb)', 'public.bulk_create_meter_readings_v1(jsonb)',
  'public.bulk_approve_meter_readings_v1(uuid[])', 'public.confirm_reconciliation(uuid)', 'public.cancel_reconciliation(uuid)'];
const THU = ['public.approve_invoice_v1(uuid)', 'public.approve_meter_reading_v1(uuid)', 'public.verify_income_expense(uuid,text)'];
const GIU = ['public.decide_financial_request_v2(uuid,text,text)', 'public.unapprove_invoice_v1(uuid)',
  'public.unapprove_meter_reading_v1(uuid)', 'public.get_approval_request_detail_compat_v2(uuid)',
  'public.withdraw_financial_request_v1(uuid,text)', 'public.verify_income_expense_v1(uuid,text,boolean)'];
const NGUOI_GOI = ['public.copilot_execute_invoice_duyet_v1(text,jsonb)', 'public.copilot_execute_meter_reading_duyet_v1(text,jsonb)',
  'public.meter_capture_v1(uuid,text,jsonb)'];
// ACL production (vai khác chủ hàm được EXECUTE).
const ACL: Record<string, string[]> = {
  'public.bulk_create_meter_readings(jsonb)': ['anon', 'authenticated', 'service_role'],
  'public.get_approval_request_detail_compat_v2(uuid)': ['authenticated'],
  'public.copilot_execute_invoice_duyet_v1(text,jsonb)': ['authenticated'],
  'public.copilot_execute_meter_reading_duyet_v1(text,jsonb)': ['authenticated'],
  'public.meter_capture_v1(uuid,text,jsonb)': ['authenticated'],
};

const org = '00000000-0000-4000-8000-000000000001';
const staff = '00000000-0000-4000-8000-000000000002';
const building = '00000000-0000-4000-8000-000000000011';
const meter = '00000000-0000-4000-8000-000000000031';
const R = { viaCopilot: '00000000-0000-4000-8000-000000000041', direct: '00000000-0000-4000-8000-000000000042' } as const;
const I = { viaCopilot: '00000000-0000-4000-8000-000000000051', direct: '00000000-0000-4000-8000-000000000052' } as const;
const L = { open: '00000000-0000-4000-8000-000000000201', mine: '00000000-0000-4000-8000-000000000202' } as const;
// Mã xác nhận một lần của trợ lý (64 ký tự hex) — ghép lúc chạy.
const nonceOf = (c: string) => c.repeat(64);

type Row = Record<string, unknown>;
type Db = PGlite;

async function one(db: Db, sql: string, params: unknown[] = []): Promise<Row> {
  return (await db.query<Row>(sql, params)).rows[0];
}

/** Mỗi ca một transaction, luôn ROLLBACK. */
async function rollback<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN');
  try {
    return await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}

/** Gọi như PostgREST: SET LOCAL ROLE <vai>, auth.uid() = người gọi. Lỗi trả về {error:{code, message}}. */
async function asRole(db: Db, role: string, actor: string | null, sql: string, params: unknown[] = []): Promise<Row> {
  await db.exec('SAVEPOINT goi');
  await db.exec(`SET LOCAL ROLE ${role}; SELECT set_config('test.actor','${actor ?? ''}',true);`);
  try {
    const r = await one(db, sql, params);
    await db.exec('RESET ROLE; RELEASE SAVEPOINT goi');
    return r;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT goi; RESET ROLE; RELEASE SAVEPOINT goi');
    const e = error as { code?: string; message?: string };
    return { error: { code: e.code, message: e.message } };
  }
}
const asUser = (db: Db, sql: string, params: unknown[] = []) => asRole(db, 'authenticated', staff, sql, params);

/** Dựng trạng thái production ngay trước migration trên một PGlite mới. */
async function dungTruoc(): Promise<Db> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE ROLE chu_ham NOSUPERUSER;
    CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE SCHEMA extensions;
    GRANT USAGE ON SCHEMA auth, app_private, extensions TO PUBLIC;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('test.actor', true), '')::uuid $$;
    CREATE FUNCTION extensions.digest(bytea, text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT sha256($1) $$;

    -- Bảng tối thiểu cho thân thật của các hàm được gọi trong phép thử.
    CREATE TABLE public.profiles(id uuid UNIQUE, full_name text, email text);
    CREATE TABLE public.meters(id uuid UNIQUE, building_id uuid);
    CREATE TABLE public.meter_readings(id uuid UNIQUE, organization_id uuid, meter_id uuid, status text,
      approved_by uuid, approved_at timestamptz, deleted_at timestamptz);
    CREATE TABLE public.invoices(id uuid UNIQUE, organization_id uuid, building_id uuid, status text,
      approved_at timestamptz, approved_by uuid, deleted_at timestamptz);
    CREATE TABLE public.income_expenses(id uuid UNIQUE, organization_id uuid, building_id uuid, account_id uuid,
      verified_at timestamptz, verified_by uuid, verified_by_name text, verified_note text);
    CREATE TABLE app_private.income_expense_flow_ownership(income_expense_id uuid UNIQUE, organization_id uuid);
    CREATE TABLE app_private.ie_flex_writer_xids(income_expense_id uuid, scope text, transaction_id xid8, backend_pid integer);
    CREATE TABLE app_private.copilot_write_confirmations(id uuid DEFAULT gen_random_uuid() UNIQUE, nonce_digest bytea,
      user_id uuid, tool text, consumed_at timestamptz, expires_at timestamptz, payload_hash bytea,
      organization_id uuid, permission_key text);
    CREATE TABLE public.ai_write_audit(id uuid DEFAULT gen_random_uuid() UNIQUE, user_id uuid, tool text,
      entity_table text, entity_id uuid, payload jsonb, organization_id uuid, idempotency_key text);
    CREATE TABLE app_private.copilot_action_registry(action_id text UNIQUE, enabled boolean,
      preview_rpc text, execute_rpc text, rollback_rpc text);
    -- Sổ hành động trợ lý như production: đường hoàn tác đã khai là unapprove_* (giữ nguyên), không phải hàm bị đụng.
    INSERT INTO app_private.copilot_action_registry VALUES
      ('invoice.duyet', true, 'copilot_preview_invoice_duyet_v1', 'copilot_execute_invoice_duyet_v1', 'unapprove_invoice_v1'),
      ('invoice.duyet_hang_loat', true, 'copilot_preview_invoice_duyet_hang_loat_v1', 'copilot_execute_invoice_duyet_hang_loat_v1', 'unapprove_invoice_v1'),
      ('meter_reading.duyet', true, 'copilot_preview_meter_reading_duyet_v1', 'copilot_execute_meter_reading_duyet_v1', 'unapprove_meter_reading_v1');

    -- Hàm quyền / trợ lý: thân thật nằm ngoài phạm vi; dựng từ bảng thử.
    CREATE TABLE public.test_perm(user_id uuid, building_id uuid);
    CREATE TABLE public.test_super(user_id uuid);
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT EXISTS (SELECT 1 FROM public.test_super WHERE user_id = auth.uid()) $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.can_access_building(_building_id uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT EXISTS (SELECT 1 FROM public.test_perm WHERE user_id = auth.uid() AND building_id = _building_id) $$;
    CREATE FUNCTION public.can_do_on_building(p_resource text, p_action text, p_building uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT EXISTS (SELECT 1 FROM public.test_perm WHERE user_id = auth.uid() AND building_id = p_building) $$;
    CREATE FUNCTION app_private.can_edit_invoice_building_v1(p_building uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT EXISTS (SELECT 1 FROM public.test_perm WHERE user_id = auth.uid() AND building_id = p_building) $$;
    CREATE FUNCTION app_private.my_possessed_cashbook_ids_v1() RETURNS SETOF uuid LANGUAGE sql STABLE AS
      $$ SELECT NULL::uuid WHERE false $$;
    CREATE FUNCTION app_private.copilot_payload_hash_v1(p jsonb) RETURNS bytea LANGUAGE sql IMMUTABLE AS
      $$ SELECT sha256(convert_to(p::text, 'UTF8')) $$;
    CREATE FUNCTION app_private.copilot_l5_plan_context_ok_v1(p_action_id text, p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT true $$;
    CREATE FUNCTION app_private.copilot_action_gate_v1(p_action_id text, p_org uuid) RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION app_private.copilot_ledger_append_v1(p jsonb) RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;

    GRANT ALL ON ALL TABLES IN SCHEMA public, app_private TO chu_ham;

    INSERT INTO public.profiles VALUES ('${staff}', 'Nhân viên A', NULL);
    INSERT INTO public.test_perm VALUES ('${staff}', '${building}');
    INSERT INTO public.meters VALUES ('${meter}', '${building}');
    INSERT INTO public.meter_readings(id, organization_id, meter_id, status) VALUES
      ('${R.viaCopilot}', '${org}', '${meter}', 'UNAPPROVED'), ('${R.direct}', '${org}', '${meter}', 'UNAPPROVED');
    INSERT INTO public.invoices(id, organization_id, building_id, status) VALUES
      ('${I.viaCopilot}', '${org}', '${building}', 'DRAFT'), ('${I.direct}', '${org}', '${building}', 'DRAFT');
    -- Phiếu đường cũ (không flow-owned): chưa kiểm / đã kiểm bởi chính người gọi.
    INSERT INTO public.income_expenses(id, organization_id, building_id, verified_at, verified_by, verified_by_name, verified_note) VALUES
      ('${L.open}', '${org}', '${building}', NULL, NULL, NULL, NULL),
      ('${L.mine}', '${org}', '${building}', '2026-11-20T03:00:00Z', '${staff}', 'Nhân viên A', 'cũ');
  `);
  // Thân đang sống (repo = production) của mọi hàm bị đụng, giữ nguyên, và người gọi bên trong.
  await db.exec('SET check_function_bodies = off');
  await db.exec(liveBefore('app_private.is_income_expense_flow_owned'));
  for (const fn of [...XOA, ...THU, ...GIU, ...NGUOI_GOI]) await db.exec(liveBefore(fn.slice(0, fn.indexOf('('))));
  await db.exec('RESET check_function_bodies');
  for (const fn of [...XOA, ...THU, ...GIU, ...NGUOI_GOI, 'app_private.is_income_expense_flow_owned(uuid)']) {
    const roles = ACL[fn] ?? ['authenticated', 'service_role'];
    await db.exec(`ALTER FUNCTION ${fn} OWNER TO chu_ham;
      REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION ${fn} TO ${roles.join(', ')};`);
  }
  return db;
}

const md5Of = async (db: Db, fn: string) =>
  (await one(db, `SELECT md5(replace(prosrc, chr(13), '')) AS m FROM pg_proc WHERE oid = to_regprocedure($1)`, [fn]))?.m as string | null;
const aclOf = async (db: Db, fn: string) =>
  (await one(db, `SELECT array_to_string(ARRAY(SELECT x FROM unnest(proacl::text[]) x ORDER BY x), ',') AS a
    FROM pg_proc WHERE oid = to_regprocedure($1)`, [fn]))?.a as string | null;
const privs = async (db: Db, fn: string) => one(db, `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
  has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
  has_function_privilege('service_role', $1, 'EXECUTE') AS service_role`, [fn]);

/** Gọi hàm thực thi của trợ lý như phiên đăng nhập: gieo một xác nhận một lần đúng nội dung rồi gọi. */
async function copilotCall(db: Db, kind: 'invoice' | 'meter', id: string, c: string): Promise<Row> {
  const payload = JSON.stringify(kind === 'invoice' ? { organization_id: org, invoice_id: id } : { organization_id: org, meter_reading_id: id });
  await db.query(`INSERT INTO app_private.copilot_write_confirmations(nonce_digest, user_id, tool, expires_at, payload_hash, organization_id, permission_key)
    VALUES (sha256(decode($1, 'hex')), $2, $3, now() + interval '5 minutes', app_private.copilot_payload_hash_v1($4::jsonb), $5, $6)`,
  [nonceOf(c), staff, kind === 'invoice' ? 'invoice.duyet' : 'meter_reading.duyet', payload, org, kind === 'invoice' ? 'invoices.edit' : 'meter_readings.edit']);
  const fn = kind === 'invoice' ? 'copilot_execute_invoice_duyet_v1' : 'copilot_execute_meter_reading_duyet_v1';
  const r = await asUser(db, `SELECT public.${fn}($1, $2::jsonb) AS r`, [nonceOf(c), payload]);
  if ('error' in r) return r;
  const out = r.r as Row;
  const table = kind === 'invoice' ? 'invoices' : 'meter_readings';
  const after = await one(db, `SELECT status, approved_by FROM public.${table} WHERE id = $1`, [id]);
  return { status: out.status, entity_id: out.entity_id, after };
}

/** «Đã kiểm» phiếu đường cũ qua verify_income_expense_v1 — ba kiểu gọi. */
async function verifyCall(db: Db, id: string, verified: boolean | null): Promise<Row> {
  const r = verified === null
    ? await asUser(db, 'SELECT public.verify_income_expense_v1(p_id => $1::uuid, p_note => $2) AS r', [id, 'ghi chú'])
    : await asUser(db, 'SELECT public.verify_income_expense_v1(p_id => $1::uuid, p_note => $2, p_verified => $3) AS r', [id, 'ghi chú', verified]);
  const after = await one(db, `SELECT verified_at IS NOT NULL AS verified, verified_by, verified_note FROM public.income_expenses WHERE id = $1`, [id]);
  if ('error' in r) return { error: r.error, after };
  const out = r.r as Row;
  return { changed: out.changed, verified: out.verified, after };
}

/** Ma trận người gọi bên trong máy chủ — chạy trước và sau migration, phải ra y hệt. */
async function innerMatrix(db: Db): Promise<Record<string, unknown>> {
  return {
    'trợ lý duyệt chỉ số → approve_meter_reading_v1': await rollback(db, () => copilotCall(db, 'meter', R.viaCopilot, 'a')),
    'trợ lý duyệt hoá đơn → approve_invoice_v1': await rollback(db, () => copilotCall(db, 'invoice', I.viaCopilot, 'b')),
    'Đã kiểm phiếu đường cũ, p_verified true → verify_income_expense': await rollback(db, () => verifyCall(db, L.open, true)),
    'Bỏ kiểm phiếu đường cũ, p_verified false → verify_income_expense': await rollback(db, () => verifyCall(db, L.mine, false)),
    'phiếu đường cũ, không truyền p_verified ⇒ 55000 (nhánh này không gọi hàm cũ)': await rollback(db, () => verifyCall(db, L.open, null)),
    'đặt đúng giá trị đang có ⇒ không đổi': await rollback(db, () => verifyCall(db, L.mine, true)),
  };
}

let db: Db;
const before: { md5: Record<string, string | null>; acl: Record<string, string | null>; inner: Record<string, unknown>; direct: Record<string, unknown> } =
  { md5: {}, acl: {}, inner: {}, direct: {} };
let firstApply: unknown;
let secondApply: unknown;
const afterFirst: Record<string, unknown> = {};
const afterSecond: Record<string, unknown> = {};

const catalogSnapshot = async (d: Db) => (await d.query<Row>(`SELECT p.oid::regprocedure::text AS fn, md5(replace(p.prosrc, chr(13), '')) AS m,
    array_to_string(ARRAY(SELECT x FROM unnest(p.proacl::text[]) x ORDER BY x), ',') AS acl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'app_private') ORDER BY 1`)).rows;

beforeAll(async () => {
  db = await dungTruoc();
  for (const fn of Object.keys(PROD_MD5)) before.md5[fn] = await md5Of(db, fn);
  for (const fn of [...XOA, ...THU, ...GIU, ...NGUOI_GOI]) before.acl[fn] = await aclOf(db, fn);
  before.inner = await innerMatrix(db);
  before.direct = {
    approve_meter: await rollback(db, async () => ('error' in await asUser(db, `SELECT public.approve_meter_reading_v1('${R.direct}') AS r`)) ? 'lỗi' : 'được'),
    approve_invoice: await rollback(db, async () => ('error' in await asUser(db, `SELECT public.approve_invoice_v1('${I.direct}') AS r`)) ? 'lỗi' : 'được'),
    verify_cu: await rollback(db, async () => ('error' in await asUser(db, `SELECT public.verify_income_expense('${L.open}', 'x') AS r`)) ? 'lỗi' : 'được'),
  };
  firstApply = await db.exec(migrationSql).then(() => 'ok', (e: Error) => e.message);
  Object.assign(afterFirst, { snap: await catalogSnapshot(db) });
  secondApply = await db.exec(migrationSql).then(() => 'ok', (e: Error) => e.message);
  Object.assign(afterSecond, { snap: await catalogSnapshot(db) });
}, 120_000);

describe('migration dọn hàm mồ côi: trạng thái trước', () => {
  it('thân đang sống dựng từ repo đúng thân production (md5 prosrc) và đúng md5 ghim trong migration', () => {
    for (const [fn, m] of Object.entries(PROD_MD5)) expect(before.md5[fn], fn).toBe(m);
    for (const fn of [...XOA, ...THU, ...GIU]) expect(migrationSql, fn).toContain(`'${PROD_MD5[fn]}'`);
  });
  it('chủ hàm không phải superuser; trước migration vai đăng nhập gọi thẳng được ba hàm sắp thu quyền', async () => {
    expect((await one(db, `SELECT rolsuper FROM pg_roles WHERE rolname = 'chu_ham'`)).rolsuper).toBe(false);
    expect(before.direct).toEqual({ approve_meter: 'được', approve_invoice: 'được', verify_cu: 'được' });
  });
  it('trước migration người gọi bên trong chạy được (để ma trận sau so có nghĩa)', () => {
    expect(before.inner['trợ lý duyệt chỉ số → approve_meter_reading_v1']).toMatchObject({ status: 'da_thuc_hien', after: { status: 'APPROVED', approved_by: staff } });
    expect(before.inner['trợ lý duyệt hoá đơn → approve_invoice_v1']).toMatchObject({ status: 'da_thuc_hien', after: { status: 'APPROVED', approved_by: staff } });
    expect(before.inner['Đã kiểm phiếu đường cũ, p_verified true → verify_income_expense']).toMatchObject({ changed: true, verified: true, after: { verified: true, verified_by: staff, verified_note: 'ghi chú' } });
    expect(before.inner['Bỏ kiểm phiếu đường cũ, p_verified false → verify_income_expense']).toMatchObject({ changed: true, verified: false, after: { verified: false } });
    expect(before.inner['phiếu đường cũ, không truyền p_verified ⇒ 55000 (nhánh này không gọi hàm cũ)']).toMatchObject({ error: { code: '55000' }, after: { verified: false } });
    expect(before.inner['đặt đúng giá trị đang có ⇒ không đổi']).toMatchObject({ changed: false, verified: true });
  });
});

describe('migration dọn hàm mồ côi: sau khi áp', () => {
  it('áp hai lượt liền đều đạt, lượt hai không đổi gì', () => {
    expect(firstApply).toBe('ok');
    expect(secondApply).toBe('ok');
    expect(afterSecond.snap).toEqual(afterFirst.snap);
  });

  it('năm hàm bị xoá biến mất; vai đăng nhập gọi thì «không có hàm» (42883)', async () => {
    for (const fn of XOA) expect(await one(db, 'SELECT to_regprocedure($1) AS o', [fn]), fn).toEqual({ o: null });
    const calls = [
      `SELECT public.bulk_create_meter_readings('[]'::jsonb) AS r`, `SELECT public.bulk_create_meter_readings_v1('[]'::jsonb) AS r`,
      `SELECT public.bulk_approve_meter_readings_v1(ARRAY['${R.direct}']::uuid[]) AS r`,
      `SELECT public.confirm_reconciliation('${R.direct}') AS r`, `SELECT public.cancel_reconciliation('${R.direct}') AS r`];
    for (const sql of calls) expect(await rollback(db, () => asUser(db, sql)), sql).toMatchObject({ error: { code: '42883' } });
  });

  it('ba hàm bị thu quyền: vai đăng nhập và chưa đăng nhập gọi thẳng ⇒ 42501; service_role vẫn gọi được', async () => {
    const calls: Record<string, string> = {
      'public.approve_meter_reading_v1(uuid)': `SELECT (public.approve_meter_reading_v1('${R.direct}')).status AS r`,
      'public.approve_invoice_v1(uuid)': `SELECT (public.approve_invoice_v1('${I.direct}')).status AS r`,
      'public.verify_income_expense(uuid,text)': `SELECT public.verify_income_expense('${L.open}', 'x')::text AS r`,
    };
    for (const [fn, sql] of Object.entries(calls)) {
      expect(await privs(db, fn), fn).toEqual({ anon: false, authenticated: false, service_role: true });
      expect(await rollback(db, () => asRole(db, 'authenticated', staff, sql)), fn).toMatchObject({ error: { code: '42501' } });
      expect(await rollback(db, () => asRole(db, 'anon', null, sql)), fn).toMatchObject({ error: { code: '42501' } });
      expect(await rollback(db, () => asRole(db, 'service_role', staff, sql)), fn).not.toHaveProperty('error');
    }
    // Không còn dòng PUBLIC / anon / authenticated; còn chủ hàm và service_role.
    for (const fn of THU) expect(await aclOf(db, fn), fn).toBe('chu_ham=X/chu_ham,service_role=X/chu_ham');
  });

  it('người gọi bên trong máy chủ chạy y như trước (trợ lý duyệt chỉ số / hoá đơn; «Đã kiểm» phiếu đường cũ cả ba kiểu gọi)', async () => {
    expect(await innerMatrix(db)).toEqual(before.inner);
  });

  it('thân không đổi; hàm giữ nguyên và người gọi bên trong còn nguyên ACL', async () => {
    for (const fn of [...THU, ...GIU, ...NGUOI_GOI]) expect(await md5Of(db, fn), fn).toBe(PROD_MD5[fn]);
    for (const fn of [...GIU, ...NGUOI_GOI]) expect(await aclOf(db, fn), fn).toBe(before.acl[fn]);
  });
});

describe('migration dọn hàm mồ côi: chỉ có DROP FUNCTION và REVOKE, hàng rào đứng trước', () => {
  const code = migrationSql.replace(/--[^\n]*/g, '');
  const doBlocks = [...code.matchAll(/DO\s+(\$[a-z_]+\$)[\s\S]*?\1\s*;/g)];
  const outside = doBlocks.reduce((s, m) => s.replace(m[0], ''), code);
  const statements = outside.split(';').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);

  it('ngoài khối DO chỉ có DROP FUNCTION IF EXISTS (không CASCADE) và REVOKE ALL … FROM PUBLIC, anon, authenticated', () => {
    expect(statements).toEqual([
      ...XOA.map((fn) => `DROP FUNCTION IF EXISTS ${fn.replace(',', ', ')}`),
      'REVOKE ALL ON FUNCTION public.approve_invoice_v1(uuid) FROM PUBLIC, anon, authenticated',
      'REVOKE ALL ON FUNCTION public.approve_meter_reading_v1(uuid) FROM PUBLIC, anon, authenticated',
      'REVOKE ALL ON FUNCTION public.verify_income_expense(uuid, text) FROM PUBLIC, anon, authenticated',
    ]);
    const noStrings = code.replace(/'(?:[^']|'')*'/g, "''");
    expect(noStrings).not.toMatch(/\b(CREATE|ALTER|GRANT|INSERT|UPDATE|DELETE|TRUNCATE|CASCADE|COMMENT\s+ON|SET\s+ROLE)\b/i);
  });
  it('hai khối hàng rào ($requires$, $hang_rao$) đứng trước lệnh DROP đầu tiên, hậu kiểm đứng cuối', () => {
    expect(doBlocks.map((m) => m[1])).toEqual(['$requires$', '$hang_rao$', '$hau_kiem$']);
    const firstDrop = code.indexOf('DROP FUNCTION');
    expect(code.indexOf('$hang_rao$;')).toBeLessThan(firstDrop);
    expect(code.indexOf('DO $hau_kiem$')).toBeGreaterThan(code.lastIndexOf('REVOKE ALL'));
  });
});

describe('migration dọn hàm mồ côi: hàng rào dừng cả tệp khi có người gọi mới', () => {
  let fresh: Db;
  beforeAll(async () => { fresh = await dungTruoc(); }, 120_000);

  /** Thêm `setup` rồi áp migration trong MỘT giao dịch ROLLBACK: trả câu lỗi (hoặc 'ok'); `after` đọc trạng thái sau áp. */
  async function applyWith(setup: string, after?: string): Promise<string> {
    await fresh.exec('BEGIN');
    try {
      await fresh.exec(setup);
      const res = await fresh.exec(migrationSql).then(() => 'ok', (e: Error) => e.message);
      if (res !== 'ok' || !after) return res;
      return JSON.stringify(await one(fresh, after));
    } finally {
      await fresh.exec('ROLLBACK');
    }
  }

  it('đối chứng: trạng thái production y nguyên ⇒ áp được', async () => {
    expect(await applyWith('SELECT 1')).toBe('ok');
  });
  it('một hàm mới (kể cả SECURITY DEFINER) nhắc tên hàm sắp xoá ⇒ dừng', async () => {
    expect(await applyWith(`CREATE FUNCTION public.nguoi_goi_moi(p jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS
      $$ SELECT public.bulk_create_meter_readings(p) $$`)).toMatch(/bulk_create_meter_readings còn được nhắc trong thân hàm: public\.nguoi_goi_moi/);
  });
  it('tên viết HOA không nháy (Postgres tự hạ chữ) vẫn bị bắt', async () => {
    expect(await applyWith(`CREATE FUNCTION public.nguoi_goi_moi(p jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS
      $$ SELECT PUBLIC.BULK_CREATE_METER_READINGS(p) $$`)).toMatch(/bulk_create_meter_readings còn được nhắc trong thân hàm: public\.nguoi_goi_moi/);
  });
  it('hàm SECURITY DEFINER mới gọi hàm sắp thu quyền nhưng CHỦ của nó không có EXECUTE ⇒ hậu kiểm dừng', async () => {
    expect(await applyWith(`CREATE ROLE chu_khac NOSUPERUSER;
      CREATE FUNCTION public.nguoi_goi_khac(p uuid) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$ SELECT (public.approve_invoice_v1(p)).status $$;
      ALTER FUNCTION public.nguoi_goi_khac(uuid) OWNER TO chu_khac;`))
      .toMatch(/chủ của public\.nguoi_goi_khac không còn gọi được public\.approve_invoice_v1\(uuid\)/);
  });
  it('một hàm INVOKER mới gọi hàm sắp thu quyền ⇒ dừng; hàm SECURITY DEFINER gọi thì vẫn áp được', async () => {
    expect(await applyWith(`CREATE FUNCTION public.nguoi_goi_moi(p uuid) RETURNS text LANGUAGE sql AS
      $$ SELECT (public.approve_invoice_v1(p)).status $$`)).toMatch(/approve_invoice_v1 còn được nhắc trong thân hàm: public\.nguoi_goi_moi \(INVOKER\)/);
    expect(await applyWith(`CREATE FUNCTION public.nguoi_goi_moi(p uuid) RETURNS text LANGUAGE sql SECURITY DEFINER AS
      $$ SELECT (public.approve_invoice_v1(p)).status $$`)).toBe('ok');
  });
  it('sổ hành động trợ lý khai hàm sắp xoá (người gọi nằm trong DỮ LIỆU) ⇒ dừng', async () => {
    expect(await applyWith(`INSERT INTO app_private.copilot_action_registry VALUES
      ('reconciliation.huy', true, NULL, 'copilot_execute_reconciliation_huy_v1', 'cancel_reconciliation')`))
      .toMatch(/sổ hành động trợ lý còn khai cancel_reconciliation ở: reconciliation\.huy/);
  });
  it('view hoặc policy nhắc tên ⇒ dừng', async () => {
    expect(await applyWith(`CREATE VIEW public.v_moi AS SELECT public.confirm_reconciliation(NULL::uuid) AS r`))
      .toMatch(/confirm_reconciliation còn được dùng ở: .*view public\.v_moi/);
    expect(await applyWith(`ALTER TABLE public.meter_readings ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p_moi ON public.meter_readings USING ((public.approve_meter_reading_v1(id)).status IS NOT NULL)`))
      .toMatch(/approve_meter_reading_v1 còn được dùng ở: .*policy public\.meter_readings\.p_moi/);
  });
  it('việc cron gọi hàm sắp xoá ⇒ dừng', async () => {
    expect(await applyWith(`CREATE SCHEMA cron; CREATE TABLE cron.job(jobname text, command text);
      INSERT INTO cron.job VALUES ('duyet-dem', 'SELECT public.bulk_approve_meter_readings_v1(ARRAY[]::uuid[])')`))
      .toMatch(/việc cron còn gọi bulk_approve_meter_readings_v1: duyet-dem/);
  });
  it('đổi một ký tự thân hàm bị ghim ⇒ dừng', async () => {
    const changed = liveBefore('public.cancel_reconciliation').replace("'status', 'CANCELLED')", "'status', 'CANCELLED ')");
    expect(changed).not.toBe(liveBefore('public.cancel_reconciliation'));
    expect(await applyWith(`SET LOCAL check_function_bodies = off; ${changed}`)).toMatch(/cancel_reconciliation\(uuid\) KHÁC thân đã rà/);
  });
  it('hàm giữ nguyên HẸP quyền hơn production, hoặc đổi thân ⇒ dừng; service_role mất quyền hàm sắp thu ⇒ dừng', async () => {
    expect(await applyWith('REVOKE EXECUTE ON FUNCTION public.unapprove_invoice_v1(uuid) FROM authenticated'))
      .toMatch(/unapprove_invoice_v1\(uuid\) \(giữ nguyên\) hẹp quyền hơn production — authenticated không gọi được/);
    expect(await applyWith('REVOKE EXECUTE ON FUNCTION public.get_approval_request_detail_compat_v2(uuid) FROM authenticated'))
      .toMatch(/get_approval_request_detail_compat_v2\(uuid\) \(giữ nguyên\) hẹp quyền hơn production/);
    const changed = liveBefore('public.verify_income_expense_v1').replace("raise exception 'Không tìm thấy phiếu';", "raise exception 'Không tìm thấy phiếu!';");
    expect(changed).not.toBe(liveBefore('public.verify_income_expense_v1'));
    expect(await applyWith(`SET LOCAL check_function_bodies = off; ${changed}`))
      .toMatch(/verify_income_expense_v1\(uuid,text,boolean\) \(giữ nguyên\) KHÁC thân đã rà/);
    expect(await applyWith('REVOKE EXECUTE ON FUNCTION public.approve_invoice_v1(uuid) FROM service_role'))
      .toMatch(/service_role đang không gọi được public\.approve_invoice_v1\(uuid\)/);
  });
  it('quyền RỘNG hơn production (như bản dựng lại của Restore Drill: mọi hàm public cấp cho anon) ⇒ vẫn áp được; quyền của hàm giữ nguyên không bị đụng, hàm thu quyền về đúng tập', async () => {
    const grants = [...XOA, ...THU, ...GIU].map((fn) => `GRANT EXECUTE ON FUNCTION ${fn} TO service_role, anon, authenticated;`).join('\n');
    expect(JSON.parse(await applyWith(grants, `SELECT
        has_function_privilege('anon', 'public.unapprove_invoice_v1(uuid)', 'EXECUTE') AS giu_anon,
        has_function_privilege('anon', 'public.get_approval_request_detail_compat_v2(uuid)', 'EXECUTE') AS giu2_anon,
        has_function_privilege('service_role', 'public.get_approval_request_detail_compat_v2(uuid)', 'EXECUTE') AS giu2_svc,
        has_function_privilege('anon', 'public.approve_invoice_v1(uuid)', 'EXECUTE') AS thu_anon,
        has_function_privilege('authenticated', 'public.verify_income_expense(uuid,text)', 'EXECUTE') AS thu_auth,
        has_function_privilege('service_role', 'public.approve_meter_reading_v1(uuid)', 'EXECUTE') AS thu_svc,
        to_regprocedure('public.bulk_create_meter_readings(jsonb)') IS NULL AS xoa`)))
      .toEqual({ giu_anon: true, giu2_anon: true, giu2_svc: true, thu_anon: false, thu_auth: false, thu_svc: true, xoa: true });
  });
  it('có bản trùng tên chưa rà, hoặc hàm sắp thu quyền đã vắng ⇒ dừng', async () => {
    expect(await applyWith(`CREATE FUNCTION public.approve_invoice_v1(p uuid, q text) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$`))
      .toMatch(/bản trùng tên chưa rà của approve_invoice_v1/);
    expect(await applyWith('DROP FUNCTION public.verify_income_expense(uuid, text)'))
      .toMatch(/thiếu public\.verify_income_expense\(uuid,text\)/);
  });
});
