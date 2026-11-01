import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const read = name => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const migration = read('20261031121202_mo_khoa_so_quy_co_ly_do.sql');
const conflictFix = read('20261031124214_mo_khoa_so_quy_xung_dot_http_409.sql');
const original = read('20260730130000_cashbook_lock_hardening.sql');
function body(source, name) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const tag = source.slice(start).match(/AS (\$[a-z_]*\$)/)?.[1];
  const open = tag ? source.indexOf(tag, start) : -1;
  const end = open < 0 ? -1 : source.indexOf(`${tag};`, open + tag.length);
  if (start < 0 || end < 0) throw new Error(`Function not found: ${name}`);
  return source.slice(start, end + tag.length + 1);
}
const org = 'a0000000-0000-4000-8000-000000000001';
const otherOrg = 'a0000000-0000-4000-8000-000000000002';
const owner = 'c0000000-0000-4000-8000-000000000001';
const keeper = 'c0000000-0000-4000-8000-000000000002';
const outsider = 'c0000000-0000-4000-8000-000000000003';
const book = 'b0000000-0000-4000-8000-000000000001';
const otherBook = 'b0000000-0000-4000-8000-000000000002';
const legacyBook = 'b0000000-0000-4000-8000-000000000003';
const key = 'e0000000-0000-4000-8000-000000000001';
const newKey = 'e0000000-0000-4000-8000-000000000002';
const lockDate = '2026-09-30';
const reason = 'Sửa ngày phát sinh bị nhập nhầm';
let db;

async function buildDatabase(includeOriginal = true) {
  const db = new PGlite();
  try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.organizations(id uuid PRIMARY KEY, status text NOT NULL, authorization_version bigint NOT NULL DEFAULT 1);
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, name text,
      deleted_at timestamptz, lock_date date, initial_amount numeric DEFAULT 0, initial_date date,
      is_virtual boolean DEFAULT false, updated_at timestamptz);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
      organization_id uuid, status text, valid_from timestamptz, valid_to timestamptz);
    CREATE TABLE public.organization_roles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
      system_key text, name text, status text);
    CREATE TABLE public.role_bindings(membership_id uuid, organization_id uuid, role_id uuid, valid_from timestamptz, valid_to timestamptz);
    CREATE TABLE app_private.cashbook_closure_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, cashbook_id uuid, status text);
    CREATE TABLE app_private.cashbook_closures(id bigserial PRIMARY KEY, organization_id uuid, cashbook_id uuid,
      closed_through date, counted_balance numeric, confirmed_at timestamptz DEFAULT now());
    CREATE TABLE app_private.ie_flex_writer_xids(income_expense_id uuid, transaction_id xid8, backend_pid integer, scope text);
    CREATE TABLE public.income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid,
      voucher_date date, change_account_id uuid, rounding_account_id uuid, total_amount numeric,
      attachments jsonb, notes text, updated_at timestamptz, building_id uuid, handover_transfer_id uuid,
      handover_id uuid, invoice_id uuid);
    CREATE TABLE public.buildings(id uuid PRIMARY KEY, name text);
    CREATE TABLE public.profit_monthly(building_id uuid, period_month date, locked_at timestamptz);
    CREATE TABLE public.cash_handovers(id uuid PRIMARY KEY, code text, status text);
    CREATE TABLE public.invoices(id uuid PRIMARY KEY, billing_month text, building_id uuid);
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.super', true) = 'true' $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
      SELECT coalesce(array_agg(organization_id), '{}') FROM public.organization_memberships WHERE user_id = auth.uid() AND status = 'ACTIVE' $$;
    CREATE FUNCTION app_private.my_possessed_cashbook_ids_v1() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
      SELECT a.id FROM public.accounts a WHERE a.user_id = auth.uid() $$;
    CREATE FUNCTION public.lock_cashbook_period_v1(uuid,date,boolean) RETURNS json LANGUAGE sql AS $$ SELECT '{}'::json $$;
    GRANT USAGE ON SCHEMA public, auth, app_private TO authenticated, anon, service_role;
    INSERT INTO organizations(id,status) VALUES ('${org}','ACTIVE'), ('${otherOrg}','ACTIVE');
    INSERT INTO accounts(id, organization_id, user_id, name, lock_date) VALUES
      ('${book}', '${org}', '${keeper}', 'Sổ thử', '${lockDate}'),
      ('${otherBook}', '${otherOrg}', '${outsider}', 'Sổ khác', '${lockDate}'),
      ('${legacyBook}', '${org}', '${keeper}', 'Sổ khóa cũ', '${lockDate}');
    INSERT INTO profiles VALUES ('${owner}', 'Chủ thử'), ('${keeper}', 'Thủ quỹ'), ('${outsider}', 'Chủ khác');
    INSERT INTO organization_memberships(user_id, organization_id, status) VALUES
      ('${owner}', '${org}', 'ACTIVE'), ('${keeper}', '${org}', 'ACTIVE'), ('${outsider}', '${otherOrg}', 'ACTIVE');
    INSERT INTO organization_roles(organization_id, system_key, name, status) VALUES
      ('${org}', null, 'Chủ công ty', 'ACTIVE'), ('${otherOrg}', 'TENANT_OWNER', 'Chủ', 'ACTIVE');
    INSERT INTO role_bindings(membership_id, organization_id, role_id)
      SELECT m.id, m.organization_id, r.id FROM organization_memberships m JOIN organization_roles r USING (organization_id)
      WHERE m.user_id IN ('${owner}', '${outsider}');
    INSERT INTO app_private.cashbook_closures(organization_id,cashbook_id,closed_through,counted_balance) VALUES
      ('${org}', '${book}', '2026-08-31', 100), ('${org}', '${book}', '${lockDate}', 200),
      ('${otherOrg}', '${otherBook}', '${lockDate}', 300);
  `);
  await db.exec(body(read('20260731040000_fix_org_lock_upgrade_deadlock.sql'), 'app_private.lock_org_for_decision_v1'));
  await db.exec(body(read('20260827140000_chu_cong_ty_doi_co_kqkd_phieu_bo_coc.sql'), 'app_private.ie_actor_is_company_owner_v1'));
  const visible = read('20260924012853_chu_cong_ty_doc_moi_so_quy.sql');
  await db.exec(body(visible, 'app_private.my_company_owner_org_ids_v1'));
  await db.exec(body(visible, 'app_private.ie_visible_cashbook_ids_v1'));
  await db.exec(body(original, 'app_private.cashbook_closed_through_v1'));
  await db.exec(body(original, 'public.accounts_closed_book_guard'));
  await db.exec(body(original, 'public.income_expenses_check_lock'));
  await db.exec(body(original, 'app_private.guard_cashbook_closures_append_only'));
  const period = read('20260925073251_khoa_thang_loi_nhuan_tuyet_doi.sql');
  await db.exec(body(period, 'app_private.profit_month_locked_v1'));
  await db.exec(body(period, 'app_private.assert_profit_month_open_v2'));
  await db.exec(body(period, 'app_private.assert_period_open_for_edit_v1'));
  await db.exec(`CREATE TRIGGER a00_accounts_closed_book_guard BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION public.accounts_closed_book_guard();
    CREATE TRIGGER cashbook_closures_append_only BEFORE UPDATE OR DELETE ON app_private.cashbook_closures FOR EACH ROW EXECUTE FUNCTION app_private.guard_cashbook_closures_append_only();
    CREATE TRIGGER voucher_lock BEFORE INSERT OR UPDATE OR DELETE ON income_expenses FOR EACH ROW EXECUTE FUNCTION public.income_expenses_check_lock();`);
  if (includeOriginal) await db.exec(migration);
  await db.exec(conflictFix);
  return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
beforeAll(async () => { db = await buildDatabase(); }, 30_000);
afterAll(async () => { await db?.close(); });

async function actor(user = owner) {
  await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [user]);
  await db.exec('SET LOCAL ROLE authenticated');
}
async function state(cashbook = book) {
  const { rows } = await db.query('SELECT public.cashbook_reopening_state_v1($1) AS value', [cashbook]);
  return rows[0].value;
}
async function reopen(before, { cashbook = book, requestKey = key, note = reason } = {}) {
  const { rows } = await db.query('SELECT public.reopen_cashbook_v1($1,$2,$3,$4,$5) AS value',
    [cashbook, note, before.lock_date, requestKey, before.revision]);
  return rows[0].value;
}
async function admin(sql) {
  await db.exec('RESET ROLE');
  const result = await db.exec(sql);
  await db.exec('SET LOCAL ROLE authenticated');
  return result;
}
async function scenario(run, user = owner, mutant = null) {
  await db.exec('BEGIN');
  try {
    if (mutant) await db.exec(mutant);
    await actor(user);
    return await run();
  } finally { await db.exec('ROLLBACK'); }
}
async function rejectStep(run, pattern, expectedCode) {
  await db.exec('SAVEPOINT denied_step');
  try {
    const attempt = run();
    await expect(attempt).rejects.toThrow(pattern);
    if (expectedCode) await expect(attempt).rejects.toMatchObject({ code: expectedCode });
  }
  finally { await db.exec('ROLLBACK TO SAVEPOINT denied_step'); }
}
async function reclose() {
  await admin(`INSERT INTO app_private.cashbook_closures(organization_id,cashbook_id,closed_through,counted_balance)
    VALUES ('${org}','${book}','${lockDate}',250);
    UPDATE accounts SET lock_date='${lockDate}' WHERE id='${book}';`);
}

test('migration chạy hai lượt; RPC volatile/definer, chỉ authenticated; private tables không có DML', async () => {
  await db.exec(migration);
  await db.exec(conflictFix);
  const { rows } = await db.query(`SELECT p.proname, p.provolatile, p.prosecdef,
    has_function_privilege('anon',p.oid,'EXECUTE') anon,
    has_function_privilege('service_role',p.oid,'EXECUTE') service,
    has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated
    FROM pg_proc p WHERE p.oid IN ('public.reopen_cashbook_v1(uuid,text,date,uuid,text)'::regprocedure,'public.cashbook_reopening_state_v1(uuid)'::regprocedure)`);
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(row).toMatchObject({ provolatile: 'v', prosecdef: true, anon: false, service: false, authenticated: true });
  const acl = await db.query(`SELECT has_table_privilege('authenticated','app_private.cashbook_reopenings','INSERT') audit_write,
    has_table_privilege('authenticated','app_private.cashbook_reopen_write_context','INSERT') context_write,
    has_function_privilege('authenticated','public.lock_cashbook_period_v1(uuid,date,boolean)','EXECUTE') legacy_unlock`);
  expect(acl.rows[0]).toEqual({ audit_write: false, context_write: false, legacy_unlock: false });
});

test('forward độc lập trên baseline chưa có tính năng, chạy lại được và trả PT409', async () => {
  const standalone = await buildDatabase(false);
  try {
    await standalone.exec(conflictFix);
    await standalone.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await standalone.exec('SET ROLE authenticated');
    const initial = (await standalone.query('SELECT public.cashbook_reopening_state_v1($1) AS value', [book])).rows[0].value;
    expect(initial).toMatchObject({ can_reopen: true, lock_date: lockDate, history: [] });
    await expect(standalone.query('SELECT public.reopen_cashbook_v1($1,$2,$3,$4,$5)',
      [book, reason, lockDate, key, '0'.repeat(32)])).rejects.toMatchObject({ code: 'PT409' });
    const result = (await standalone.query('SELECT public.reopen_cashbook_v1($1,$2,$3,$4,$5) AS value',
      [book, reason, lockDate, key, initial.revision])).rows[0].value;
    expect(result).toMatchObject({ status: 'REOPENED', lock_date: null, idempotency_key: key });
    const after = (await standalone.query('SELECT public.cashbook_reopening_state_v1($1) AS value', [book])).rows[0].value;
    expect(after.history).toEqual([expect.objectContaining({ id: result.reopening_id, reason })]);
  } finally { await standalone.close(); }
}, 15_000);

test('chuỗi gốc rồi forward giữ nguyên lịch sử và biên nhận idempotency đã ghi', () => scenario(async () => {
  await admin(body(migration, 'public.reopen_cashbook_v1'));
  const before = await state();
  const receipt = await reopen(before);
  const after = await state();
  await admin(conflictFix);
  expect(await state()).toEqual(after);
  expect(await reopen(before)).toEqual({ ...receipt, idempotent_replay: true });
}));

test('chủ vai custom mở sổ; giữ nguyên biên bản, ghi người/lý do/revision; guard phiếu hết khóa đúng sổ', () => scenario(async () => {
  const before = await state();
  expect(before).toMatchObject({ cashbook_id: book, can_reopen: true, lock_date: lockDate, history: [] });
  await rejectStep(() => admin(`INSERT INTO income_expenses(account_id,voucher_date,total_amount) VALUES ('${book}','2026-09-01',10)`), /CASHBOOK_CLOSED/);
  const result = await reopen(before);
  expect(result).toMatchObject({ cashbook_id: book, status: 'REOPENED', lock_date: null, idempotency_key: key, previous_revision: before.revision });
  const after = await state();
  expect(after.lock_date).toBeNull();
  expect(after.can_reopen).toBe(false);
  expect(after.revision).not.toBe(before.revision);
  expect(after.history).toEqual([expect.objectContaining({ id: result.reopening_id, reopened_by_name: 'Chủ thử', reason,
    previous_lock_date: lockDate, previous_revision: before.revision, idempotency_key: key, last_closure_id: 2 })]);
  await admin(`INSERT INTO income_expenses(account_id,voucher_date,total_amount) VALUES ('${book}','2026-09-01',10)`);
  await rejectStep(() => admin(`INSERT INTO income_expenses(account_id,voucher_date,total_amount) VALUES ('${otherBook}','2026-09-01',10)`), /CASHBOOK_CLOSED/);
  const records = await admin('SELECT count(*)::int AS count FROM app_private.cashbook_closures; SELECT count(*)::int AS count FROM app_private.cashbook_reopen_write_context');
  expect(records.map(r => r.rows[0].count)).toEqual([3, 0]);
}));

test('sổ legacy chỉ lock_date, không biên bản, vẫn mở có lịch sử', () => scenario(async () => {
  const before = await state(legacyBook);
  await reopen(before, { cashbook: legacyBook });
  expect(await state(legacyBook)).toMatchObject({ lock_date: null, history: [expect.objectContaining({ last_closure_id: 0 })] });
}));

test('lịch sử mới không thêm FK chặn xóa/tạo lại tài khoản fixture; audit vẫn còn nguyên', () => scenario(async () => {
  await reopen(await state(legacyBook), { cashbook: legacyBook });
  const records = await admin(`DELETE FROM accounts WHERE id='${legacyBook}';
    SELECT count(*)::int AS count FROM app_private.cashbook_reopenings WHERE cashbook_id='${legacyBook}';
    INSERT INTO accounts(id,organization_id,user_id,name) VALUES ('${legacyBook}','${org}','${keeper}','Sổ tạo lại');`);
  expect(records[1].rows[0].count).toBe(1);
  expect((await state(legacyBook)).history).toHaveLength(1);
}));

test('thủ quỹ xem lịch sử nhưng không mở; super admin không tự vượt owner', () => scenario(async () => {
  const before = await state();
  expect(before.can_reopen).toBe(false);
  await rejectStep(() => reopen(before), /REOPEN_FORBIDDEN/);
  await db.query(`SELECT set_config('test.super','true',true)`);
  await rejectStep(() => reopen(before), /REOPEN_FORBIDDEN/);
}, keeper));

test('chủ org khác, thành viên không có scope, membership hết hạn và chưa đăng nhập đều fail closed', async () => {
  await scenario(() => rejectStep(() => state(), /REOPEN_FORBIDDEN/), outsider);
  await scenario(async () => {
    await admin(`INSERT INTO organization_memberships(user_id,organization_id,status) VALUES ('${outsider}','${org}','ACTIVE')`);
    await rejectStep(() => state(), /REOPEN_FORBIDDEN/);
  }, outsider);
  await scenario(async () => {
    const before = await state();
    await admin(`UPDATE organization_memberships SET valid_to=now()-interval '1 day' WHERE user_id='${owner}'`);
    await rejectStep(() => state(), /REOPEN_FORBIDDEN/);
    await rejectStep(() => reopen(before), /REOPEN_FORBIDDEN/);
  });
  await scenario(() => rejectStep(() => state(), /REOPEN_FORBIDDEN/), '');
});

test.each([
  ['inactive', 'read'], ['inactive', 'write'], ['missing', 'read'], ['missing', 'write'],
])('tổ chức %s bị từ chối khi %s dù membership và vai chủ vẫn còn ACTIVE', (status, operation) => scenario(async () => {
  const before = await state();
  await admin(status === 'inactive'
    ? `UPDATE organizations SET status='INACTIVE' WHERE id='${org}'`
    : `DELETE FROM organizations WHERE id='${org}'`);
  await rejectStep(() => operation === 'read' ? state() : reopen(before), /REOPEN_FORBIDDEN/);
}));

test('lý do ngắn/trống, ngày stale, revision stale, sổ mở và pending bị từ chối không tạo history', () => scenario(async () => {
  const before = await state();
  await rejectStep(() => reopen(before, { note: '  ' }), /REOPEN_REASON_REQUIRED/);
  await rejectStep(() => reopen({ ...before, revision: null }), /REOPEN_STALE/, 'PT409');
  await rejectStep(() => reopen({ ...before, lock_date: '2026-09-29' }), /REOPEN_STALE/, 'PT409');
  await rejectStep(() => reopen({ ...before, revision: '0'.repeat(32) }), /REOPEN_STALE/, 'PT409');
  await admin(`INSERT INTO app_private.cashbook_closure_requests(organization_id,cashbook_id,status) VALUES ('${org}','${book}','PENDING')`);
  expect(await state()).toMatchObject({ can_reopen: true, blocked_reason: 'PENDING_CLOSURE' });
  await rejectStep(() => reopen(before), /REOPEN_PENDING_CLOSURE/);
  await admin(`DELETE FROM app_private.cashbook_closure_requests WHERE cashbook_id='${book}'`);
  await reopen(before);
  await rejectStep(() => reopen(before, { requestKey: newKey }), /REOPEN_NOT_LOCKED/);
}));

test.each([' '.repeat(12), '\t'.repeat(12), '\n'.repeat(12), ' \t\r\n'.repeat(4), '\u00a0'.repeat(12)])(
  'lý do chỉ có whitespace %j bị từ chối tại RPC', note => scenario(async () => {
    const before = await state();
    await rejectStep(() => reopen(before, { note }), /REOPEN_REASON_REQUIRED/);
    expect((await state()).history).toHaveLength(0);
  }),
);

test('lý do được trim whitespace ở hai đầu trước khi lưu và tính idempotency', () => scenario(async () => {
  const before = await state();
  const first = await reopen(before, { note: ` \t\n\u00a0${reason}\r\n\t ` });
  expect((await state()).history[0].reason).toBe(reason);
  expect(await reopen(before)).toEqual({ ...first, idempotent_replay: true });
}));

test('CHECK của audit cũng chặn tab/newline-only dù ghi không qua RPC', () => scenario(async () => {
  await reopen(await state());
  await rejectStep(() => admin(`INSERT INTO app_private.cashbook_reopenings
    (id,organization_id,cashbook_id,reopened_by,reason,previous_lock_date,previous_revision,last_closure_id,idempotency_key,request_hash)
    SELECT gen_random_uuid(),organization_id,cashbook_id,reopened_by,repeat(E'\\t\\n',6),previous_lock_date,
      previous_revision,last_closure_id,'${newKey}',request_hash FROM app_private.cashbook_reopenings WHERE idempotency_key='${key}'`), /check constraint/);
}));

test('retry cùng key đúng receipt; dùng key với payload khác bị từ chối', () => scenario(async () => {
  const before = await state();
  const first = await reopen(before);
  const replay = await reopen(before);
  expect(replay).toEqual({ ...first, idempotent_replay: true });
  await rejectStep(() => reopen(before, { note: 'Lý do khác với thao tác ban đầu' }), /REOPEN_KEY_REUSED/);
  expect((await state()).history).toHaveLength(1);
}));

test('chốt lại cùng ngày khóa trở lại; dialog cũ và retry cũ không mở lần chốt mới', () => scenario(async () => {
  const before = await state();
  await reopen(before);
  await reclose();
  const newState = await state();
  expect(newState.lock_date).toBe(lockDate);
  expect(newState.revision).not.toBe(before.revision);
  expect((await reopen(before)).idempotent_replay).toBe(true);
  expect((await state()).lock_date).toBe(lockDate);
  await rejectStep(() => reopen(before, { requestKey: newKey }), /REOPEN_STALE/, 'PT409');
  await rejectStep(() => admin(`INSERT INTO income_expenses(account_id,voucher_date,total_amount) VALUES ('${book}','2026-09-01',10)`), /CASHBOOK_CLOSED/);
  await reopen(newState, { requestKey: newKey });
  expect((await state()).history).toHaveLength(2);
}));

test('không gỡ/lùi lock_date trực tiếp; không sửa tiền cùng transaction mở; context đã tiêu không dùng lại', () => scenario(async () => {
  await rejectStep(() => admin(`UPDATE accounts SET lock_date=NULL WHERE id='${book}'`), /CASHBOOK_CLOSED/);
  await rejectStep(() => admin(`UPDATE accounts SET lock_date='2026-09-01' WHERE id='${book}'`), /CASHBOOK_CLOSED/);
  await rejectStep(() => admin(`UPDATE accounts SET initial_amount=999 WHERE id='${book}'`), /CASHBOOK_CLOSED/);
  await reopen(await state());
  await reclose();
  await rejectStep(() => admin(`UPDATE accounts SET lock_date=NULL WHERE id='${book}'`), /CASHBOOK_CLOSED/);
}));

test('biên bản và lịch sử mở append-only, quyền DML không mở cho người gọi', () => scenario(async () => {
  await reopen(await state());
  await rejectStep(() => admin(`DELETE FROM app_private.cashbook_closures WHERE cashbook_id='${book}'`), /CASHBOOK_CLOSED/);
  await rejectStep(() => admin(`UPDATE app_private.cashbook_reopenings SET reason='Sửa dấu vết sai' WHERE cashbook_id='${book}'`), /REOPEN_HISTORY_IMMUTABLE/);
  await rejectStep(() => admin(`DELETE FROM app_private.cashbook_reopenings WHERE cashbook_id='${book}'`), /REOPEN_HISTORY_IMMUTABLE/);
  await rejectStep(() => admin('TRUNCATE app_private.cashbook_reopenings CASCADE'), /REOPEN_HISTORY_IMMUTABLE/);
  await rejectStep(() => db.exec(`INSERT INTO app_private.cashbook_reopen_write_context VALUES ('${book}',gen_random_uuid(),pg_current_xact_id(),pg_backend_pid())`), /permission denied/);
}));

test('mở sổ không vượt khóa lợi nhuận hoặc bàn giao của cùng phiếu', () => scenario(async () => {
  await reopen(await state());
  await admin(`INSERT INTO buildings VALUES ('${key}', 'Tòa thử');
    INSERT INTO profit_monthly VALUES ('${key}','2026-09-01',now());
    INSERT INTO income_expenses(id,account_id,voucher_date,total_amount,building_id)
      VALUES ('${newKey}','${book}','2026-09-01',10,'${key}');`);
  await rejectStep(() => admin(`SELECT app_private.assert_period_open_for_edit_v1('${newKey}','sửa')`), /PROFIT_LOCKED/);
  await admin(`DELETE FROM profit_monthly; INSERT INTO cash_handovers VALUES ('${key}','BG-TEST','CONFIRMED');
    UPDATE income_expenses SET handover_id='${key}' WHERE id='${newKey}';`);
  await rejectStep(() => admin(`SELECT app_private.assert_period_open_for_edit_v1('${newKey}','sửa')`), /HANDOVER_LOCKED/);
  await admin(`UPDATE cash_handovers SET status='CANCELLED'; SELECT app_private.assert_period_open_for_edit_v1('${newKey}','sửa')`);
}));

test('lỗi lúc cập nhật tài khoản hoàn tác cả biên nhận và context, có thể thử đúng key sau khi sửa lỗi', () => scenario(async () => {
  const before = await state();
  await admin(`CREATE FUNCTION public.test_reopen_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test update failure'; END $$;
    CREATE TRIGGER z99_test_reopen_failure AFTER UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION public.test_reopen_failure();`);
  await rejectStep(() => reopen(before), /test update failure/);
  expect(await state()).toMatchObject({ lock_date: lockDate, revision: before.revision, history: [] });
  const records = await admin('SELECT count(*)::int AS count FROM app_private.cashbook_reopen_write_context');
  expect(records[0].rows[0].count).toBe(0);
  await admin('DROP TRIGGER z99_test_reopen_failure ON accounts');
  expect((await reopen(before)).idempotent_replay).toBe(false);
}));

test('đột biến: owner, org, lý do, revision, pending, phạm vi đọc và ngưỡng closure đều được phép kiểm bắt', async () => {
  const write = body(conflictFix, 'public.reopen_cashbook_v1');
  const readState = body(migration, 'public.cashbook_reopening_state_v1');
  const cutoff = body(migration, 'app_private.cashbook_closed_through_v1');
  const ownerMutant = write.replace('IF NOT COALESCE(app_private.ie_actor_is_company_owner_v1(v_account.organization_id, v_actor), false) THEN', 'IF false THEN');
  expect(ownerMutant).not.toBe(write);
  await scenario(async () => {
    const result = await reopen(await state());
    expect(result.status).toBe('REOPENED'); // owner-denial assertion above would fail.
  }, keeper, ownerMutant);
  const orgWriteMutant = write.replace('IF app_private.lock_org_for_decision_v1(v_account.organization_id) IS NULL THEN', 'IF false THEN');
  expect(orgWriteMutant).not.toBe(write);
  await scenario(async () => {
    const before = await state();
    await admin(`UPDATE organizations SET status='INACTIVE' WHERE id='${org}'`);
    expect((await reopen(before)).status).toBe('REOPENED');
  }, owner, orgWriteMutant);
  const orgReadMutant = readState.replace("SELECT 1 FROM public.organizations o WHERE o.id = v_org AND o.status = 'ACTIVE'", 'SELECT 1');
  expect(orgReadMutant).not.toBe(readState);
  await scenario(async () => {
    await admin(`UPDATE organizations SET status='INACTIVE' WHERE id='${org}'`);
    expect((await state()).can_reopen).toBe(true);
  }, owner, orgReadMutant);
  const normalizer = body(migration, 'app_private.normalize_cashbook_reopening_reason_v1');
  const reasonMutant = normalizer.replace(/SELECT btrim[\s\S]*?;/, "SELECT btrim(COALESCE(p_reason, ''));");
  expect(reasonMutant).not.toBe(normalizer);
  await scenario(async () => {
    expect((await reopen(await state(), { note: '\t'.repeat(12) })).status).toBe('REOPENED');
  }, owner, reasonMutant);
  const revisionMutant = write.replace('OR v_revision IS DISTINCT FROM p_expected_revision', 'OR false');
  expect(revisionMutant).not.toBe(write);
  await scenario(async () => {
    const old = await state(); await reopen(old); await reclose();
    expect((await reopen(old, { requestKey: newKey })).status).toBe('REOPENED');
  }, owner, revisionMutant);
  const pendingMutant = write.replace("IF EXISTS (SELECT 1 FROM app_private.cashbook_closure_requests q WHERE q.cashbook_id = p_cashbook AND q.status = 'PENDING') THEN", 'IF false THEN');
  expect(pendingMutant).not.toBe(write);
  await scenario(async () => {
    const old = await state();
    await admin(`INSERT INTO app_private.cashbook_closure_requests(organization_id,cashbook_id,status) VALUES ('${org}','${book}','PENDING')`);
    expect((await reopen(old)).status).toBe('REOPENED');
  }, owner, pendingMutant);
  const scopeMutant = readState.replace('SELECT 1 FROM app_private.ie_visible_cashbook_ids_v1() v WHERE v.cashbook_id = p_cashbook', 'SELECT 1');
  expect(scopeMutant).not.toBe(readState);
  await scenario(async () => {
    await admin(`INSERT INTO organization_memberships(user_id,organization_id,status) VALUES ('${outsider}','${org}','ACTIVE')`);
    expect((await state()).lock_date).toBe(lockDate);
  }, outsider, scopeMutant);
  const cutoffMutant = cutoff.replace('AND c.id > COALESCE', 'AND c.id >= COALESCE');
  expect(cutoffMutant).not.toBe(cutoff);
  await scenario(async () => {
    const before = await state();
    await rejectStep(() => reopen(before), /REOPEN_STALE/, 'PT409');
  }, owner, cutoffMutant);
});
