import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const path = 'supabase/migrations/20260928091816_align_voucher_detail_read.sql';
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(1), otherOrg = id(2), actor = id(3), creator = id(4), building = id(5), account = id(6), voucher = id(7), hidden = id(8), type = id(9), item = id(10), zero = id(11), foreign = id(12);
type Detail = { header: { id: string; total_amount: string; updated_at: string }; items: Array<{ id: string; type_name: string | null; amount: string }>; building_name: string | null; expected_item_count: number; items_complete: boolean; issues: string[] };
let parentPolicies: unknown;
const source = readFileSync('supabase/migrations/20260910042229_income_expense_supplements_v1.sql', 'utf8');
const originalFunction = (name: string) => {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const end = source.indexOf('END $$;', start);
  const sqlEnd = source.indexOf('\n$$;', start);
  return source.slice(start, (sqlEnd >= 0 && sqlEnd < end ? sqlEnd + 4 : end + 7));
};
beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE SCHEMA storage;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.admin',true)='yes' $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION public.demo_user_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.building',true),'')='yes' $$;
    CREATE FUNCTION public.has_full_building_scope() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.accessible_building_ids() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$ SELECT '${building}'::uuid WHERE can_access_building('${building}') $$;
    CREATE FUNCTION public.can_view_restricted_ie() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.restricted',true),'')='yes' $$;
    CREATE FUNCTION public.current_profit_manager_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.profit',true),'')::uuid $$;
    CREATE FUNCTION public.current_shareholder_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.shareholder',true),'')::uuid $$;
    CREATE TABLE organization_memberships(id uuid PRIMARY KEY, organization_id uuid,user_id uuid,status text,valid_from timestamptz,valid_to timestamptz);
    INSERT INTO organization_memberships VALUES('${id(20)}','${org}','${actor}','ACTIVE',NULL,NULL);
    CREATE TABLE accounts(id uuid PRIMARY KEY,user_id uuid,organization_id uuid);
    INSERT INTO accounts VALUES('${account}','${actor}','${org}');
    CREATE TABLE possessions(account_id uuid,user_id uuid,active boolean);
    CREATE FUNCTION public.accessible_account_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT id FROM accounts WHERE user_id=auth.uid() UNION SELECT account_id FROM possessions WHERE user_id=auth.uid() AND active $$;
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,name text);
    INSERT INTO buildings VALUES('${building}','${org}','950NK');
    CREATE TABLE income_expense_types(id uuid PRIMARY KEY,organization_id uuid,name text,category text,is_deposit boolean);
    INSERT INTO income_expense_types VALUES('${type}','${org}','Thu chi khác','OTHER',false);
    CREATE TABLE income_expenses(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,user_id uuid,account_id uuid,change_account_id uuid,rounding_account_id uuid,profit_manager_id uuid,salary_staff_id uuid,shareholder_id uuid,deleted_at timestamptz,has_restricted_item boolean DEFAULT false,total_amount numeric DEFAULT 941040,kqkd_amount numeric DEFAULT 941040,updated_at timestamptz DEFAULT now(),approval_version integer DEFAULT 1);
    INSERT INTO income_expenses(id,organization_id,building_id,user_id,account_id) VALUES('${voucher}','${org}','${building}','${creator}','${account}'),('${zero}','${org}','${building}','${creator}','${account}'),('${foreign}','${otherOrg}','${building}','${actor}','${account}');
    INSERT INTO income_expenses(id,organization_id,building_id,user_id,account_id,has_restricted_item) VALUES('${hidden}','${org}','${building}','${creator}','${account}',true);
    CREATE TABLE income_expense_items(id uuid PRIMARY KEY,income_expense_id uuid,organization_id uuid,income_expense_type_id uuid,quantity numeric DEFAULT 1,unit_price numeric DEFAULT 941040,amount numeric DEFAULT 941040,description text,start_date date,end_date date);
    INSERT INTO income_expense_items(id,income_expense_id,organization_id,income_expense_type_id) VALUES('${item}','${voucher}','${org}','${type}'),('${id(13)}','${hidden}','${org}','${type}'),('${id(14)}','${foreign}','${otherOrg}','${type}');
    CREATE TABLE income_expense_supplements(id uuid PRIMARY KEY,organization_id uuid,income_expense_id uuid,note text,attachments jsonb,actor_id uuid,actor_name text);
    INSERT INTO income_expense_supplements VALUES('${id(15)}','${org}','${voucher}','proof','[]','${creator}','Creator');
    CREATE TABLE income_expense_revisions(id uuid PRIMARY KEY,organization_id uuid,income_expense_id uuid);
    INSERT INTO income_expense_revisions VALUES('${id(16)}','${org}','${voucher}');
    CREATE TABLE app_private.ie_supplement_requests(income_expense_id uuid,actor_id uuid,idempotency_key text,request_payload jsonb,supplement_id uuid);
    CREATE TABLE app_private.ie_supplement_objects(supplement_id uuid,object_id uuid,bucket_id text,object_name text);
    INSERT INTO app_private.ie_supplement_objects VALUES('${id(15)}','${id(17)}','proof','visible');
    CREATE TABLE storage.objects(id uuid,bucket_id text,name text,owner_id text,owner uuid,archived_at timestamptz,is_delete_marker boolean);
    CREATE TABLE profiles(id uuid,full_name text,email text);
    CREATE FUNCTION app_private.is_org_owner_v1(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION app_private.ie_can_edit_money_axis_v1(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION app_private.ie_has_cashbook_possession_v1(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.writer',true),'')='yes' $$;
    GRANT USAGE ON SCHEMA public,auth,app_private TO authenticated;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
    ALTER TABLE income_expenses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY parent_routes ON income_expenses FOR SELECT TO authenticated USING(deleted_at IS NULL AND (is_admin() OR can_access_building(building_id) OR account_id IN(SELECT accessible_account_ids()) OR change_account_id IN(SELECT accessible_account_ids()) OR rounding_account_id IN(SELECT accessible_account_ids()) OR salary_staff_id=auth.uid() OR profit_manager_id=current_profit_manager_id() OR shareholder_id=current_shareholder_id()));
    CREATE POLICY parent_org ON income_expenses AS RESTRICTIVE FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM organization_memberships m WHERE m.organization_id=income_expenses.organization_id AND m.user_id=auth.uid() AND m.status='ACTIVE'));
    CREATE POLICY parent_restricted ON income_expenses AS RESTRICTIVE FOR SELECT TO authenticated USING(NOT has_restricted_item OR user_id=auth.uid() OR can_view_restricted_ie());
    ALTER TABLE income_expense_items ENABLE ROW LEVEL SECURITY;
    CREATE POLICY income_expense_items_select_rbac ON income_expense_items FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM income_expenses p WHERE p.id=income_expense_id AND can_access_building(p.building_id)));
    ALTER TABLE buildings ENABLE ROW LEVEL SECURITY;
    CREATE POLICY building_scope ON buildings FOR SELECT TO authenticated USING(can_access_building(id));
    ALTER TABLE income_expense_types ENABLE ROW LEVEL SECURITY;
    CREATE POLICY picker_scope ON income_expense_types FOR SELECT TO authenticated USING(false);
  `);
  await db.exec(originalFunction('app_private.ie_supplement_can_read_v1'));
  await db.exec(originalFunction('public.append_income_expense_supplement_v1'));
  await db.exec(originalFunction('app_private.ie_storage_is_supplement_v1'));
  await db.exec(originalFunction('app_private.ie_supplement_storage_can_read_v1'));
  await db.exec(`ALTER TABLE income_expense_supplements ENABLE ROW LEVEL SECURITY; CREATE POLICY income_expense_supplements_select ON income_expense_supplements FOR SELECT TO authenticated USING(app_private.ie_supplement_can_read_v1(income_expense_id));
    ALTER TABLE income_expense_revisions ENABLE ROW LEVEL SECURITY; CREATE POLICY income_expense_revisions_select ON income_expense_revisions FOR SELECT TO authenticated USING(app_private.ie_supplement_can_read_v1(income_expense_id));`);
  parentPolicies = (await db.query("SELECT * FROM pg_policies WHERE tablename='income_expenses' ORDER BY policyname")).rows;
  if (existsSync(path)) { await db.exec(readFileSync(path, 'utf8')); await db.exec(readFileSync(path, 'utf8')); }
}, 30000);
afterAll(() => db.close());
async function tx(run: () => Promise<void>) { await db.exec(`BEGIN; SET LOCAL test.actor='${actor}'; SET LOCAL ROLE authenticated;`); try { await run(); } finally { await db.exec('ROLLBACK'); } }
async function read(ids: Array<string | null> | null = [voucher], organization: string | null = org) { return (await db.query<{ result: { rows: Detail[] } }>('SELECT public.read_income_expense_details_v1($1,$2::uuid[]) AS result', [organization, ids])).rows[0].result; }
async function count(table: string) { return (await db.query<{ n: number }>(`SELECT count(*)::integer n FROM ${table}`)).rows[0].n; }
async function denied(run: () => Promise<unknown>, code: string) { await db.exec('SAVEPOINT denied'); try { await expect(run()).rejects.toMatchObject({ code }); } finally { await db.exec('ROLLBACK TO SAVEPOINT denied; RELEASE SAVEPOINT denied'); } }

describe('voucher detail SQL parent visibility contract', () => {
  it('applies twice without replacing any parent policy', async () => {
    expect(existsSync(path)).toBe(true);
    expect((await db.query("SELECT * FROM pg_policies WHERE tablename='income_expenses' ORDER BY policyname")).rows).toEqual(parentPolicies);
  });
  it('reads all items and exact labels for cashbook owner while building and picker remain hidden', () => tx(async () => {
    expect(await count('income_expenses')).toBe(2);
    expect(await count('income_expense_items')).toBe(1);
    expect(await count('buildings')).toBe(0); expect(await count('income_expense_types')).toBe(0);
    const result = await read([voucher, voucher, hidden, foreign, id(999)]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ header: { id: voucher, total_amount: '941040' }, building_name: '950NK', expected_item_count: 1, items_complete: true, issues: [], items: [{ id: item, type_name: 'Thu chi khác', amount: '941040' }] });
  }));
  it('allows actual zero items and empty request, rejects null or over-cap IDs', () => tx(async () => {
    expect((await read([zero])).rows[0]).toMatchObject({ items: [], expected_item_count: 0, items_complete: true, issues: [] });
    expect(await read([])).toEqual({ rows: [] });
    for (const ids of [null, [null], Array.from({ length: 201 }, () => voucher)]) await denied(() => read(ids), '22023');
    await denied(() => read([voucher], null), '42501');
    expect(await read([voucher], otherOrg)).toEqual({ rows: [] });
  }));
  it('does not widen creator access and keeps ownership after possession revocation', () => tx(async () => {
    await db.exec(`RESET ROLE; INSERT INTO possessions VALUES('${account}','${actor}',false); SET LOCAL ROLE authenticated;`);
    expect((await read()).rows).toHaveLength(1);
    await db.exec(`RESET ROLE; UPDATE accounts SET user_id='${creator}'; UPDATE income_expenses SET user_id='${actor}' WHERE id='${voucher}'; SET LOCAL ROLE authenticated;`);
    expect(await read()).toEqual({ rows: [] }); expect(await count('income_expense_items')).toBe(0);
    await db.exec(`RESET ROLE; UPDATE possessions SET active=true; SET LOCAL ROLE authenticated;`);
    expect((await read()).rows).toHaveLength(1);
  }));
  it('tracks current parent membership including expired ACTIVE timestamps', () => tx(async () => {
    await db.exec("RESET ROLE; UPDATE organization_memberships SET valid_to=now()-interval '1 day'; SET LOCAL ROLE authenticated;");
    expect((await read()).rows).toHaveLength(1);
    await db.exec("RESET ROLE; UPDATE organization_memberships SET status='INACTIVE'; SET LOCAL ROLE authenticated;");
    expect(await read()).toEqual({ rows: [] }); expect(await count('income_expense_supplements')).toBe(0);
  }));
  it.each(['account_id', 'change_account_id', 'rounding_account_id'])('inherits parent cashbook route %s without requiring creator ownership', (column) => tx(async () => {
    await db.exec(`RESET ROLE; UPDATE income_expenses SET account_id=NULL,change_account_id=NULL,rounding_account_id=NULL WHERE id='${voucher}'; UPDATE income_expenses SET ${column}='${account}' WHERE id='${voucher}'; SET LOCAL ROLE authenticated;`);
    expect((await read()).rows[0]).toMatchObject({ header: { id: voucher }, items_complete: true, expected_item_count: 1 });
  }));
  it.each(['salary_staff_id', 'profit_manager_id', 'shareholder_id'])('inherits recipient route %s without cashbook ownership', (column) => tx(async () => {
    await db.exec(`RESET ROLE; UPDATE accounts SET user_id='${creator}'; UPDATE income_expenses SET ${column}='${actor}' WHERE id='${voucher}'; SET LOCAL ROLE authenticated; SET LOCAL test.profit='${actor}'; SET LOCAL test.shareholder='${actor}';`);
    expect((await read()).rows[0]).toMatchObject({ header: { id: voucher }, items_complete: true, expected_item_count: 1 });
  }));
  it('inherits building/admin routes and restricted parent decisions', () => tx(async () => {
    await db.exec(`RESET ROLE; UPDATE accounts SET user_id='${creator}'; SET LOCAL ROLE authenticated; SET LOCAL test.building='yes';`);
    expect((await read()).rows).toHaveLength(1); expect(await read([hidden])).toEqual({ rows: [] });
    await db.exec("SET LOCAL test.building='no'; SET LOCAL test.admin='yes';");
    expect((await read()).rows).toHaveLength(1); expect(await read([hidden])).toEqual({ rows: [] });
    await db.exec("SET LOCAL test.restricted='yes'"); expect((await read([hidden])).rows).toHaveLength(1);
    await db.exec("RESET ROLE; CREATE POLICY sandbox_fixture ON income_expenses AS RESTRICTIVE FOR SELECT TO authenticated USING(false); SET LOCAL ROLE authenticated;");
    expect(await read()).toEqual({ rows: [] }); expect(await count('income_expense_items')).toBe(0);
  }));
  it('exposes supplements, revisions and proof only through a visible parent without expanding append', () => tx(async () => {
    expect(await count('income_expense_supplements')).toBe(1); expect(await count('income_expense_revisions')).toBe(1);
    expect((await db.query<{ ok: boolean }>("SELECT app_private.ie_supplement_storage_can_read_v1('proof','visible') ok")).rows[0].ok).toBe(true);
    await db.exec("SET LOCAL test.writer='yes'");
    await denied(() => db.query("SELECT append_income_expense_supplement_v1($1,'note','[]','key')", [voucher]), '42501');
    await db.exec(`RESET ROLE; UPDATE accounts SET user_id='${creator}'; SET LOCAL ROLE authenticated;`);
    expect(await count('income_expense_supplements')).toBe(0); expect(await count('income_expense_revisions')).toBe(0);
    expect((await db.query<{ ok: boolean }>("SELECT app_private.ie_supplement_storage_can_read_v1('proof','visible') ok")).rows[0].ok).toBe(false);
  }));
  it('retains the previously allowed append matrix and rejects read-only writer guard', () => tx(async () => {
    await db.exec("SET LOCAL test.building='yes'");
    await denied(() => db.query("SELECT append_income_expense_supplement_v1($1,'note','[]','key')", [voucher]), '42501');
    await db.exec("SET LOCAL test.writer='yes'");
    expect((await db.query<{ result: { changed: boolean } }>("SELECT append_income_expense_supplement_v1($1,'note','[]','key') result", [voucher])).rows[0].result.changed).toBe(true);
  }));
  it('reports withheld items and invalid relations without silently claiming completeness', () => tx(async () => {
    await db.exec('RESET ROLE; CREATE POLICY test_withhold ON income_expense_items AS RESTRICTIVE FOR SELECT TO authenticated USING(false); SET LOCAL ROLE authenticated;');
    expect((await read()).rows[0]).toMatchObject({ items: [], expected_item_count: 1, items_complete: false, issues: ['ITEMS_INCOMPLETE'] });
    await db.exec(`RESET ROLE; DROP POLICY test_withhold ON income_expense_items; UPDATE income_expense_items SET organization_id='${otherOrg}' WHERE id='${item}'; SET LOCAL ROLE authenticated;`);
    expect(await count('income_expense_items')).toBe(0);
    const row = (await read()).rows[0]; expect(row.items).toEqual([]); expect(row.items_complete).toBe(false); expect(row.issues).toContain('SCOPE_MISMATCH');
  }));
  it('does not leak cross-org building/type labels and flags missing related data', () => tx(async () => {
    await db.exec(`RESET ROLE; UPDATE buildings SET organization_id='${otherOrg}'; UPDATE income_expense_types SET organization_id='${otherOrg}'; SET LOCAL ROLE authenticated;`);
    const row = (await read()).rows[0]; expect(row.building_name).toBeNull(); expect(row.items[0].type_name).toBeNull(); expect(row.issues).toContain('RELATED_DATA_UNAVAILABLE');
  }));
  it('rejects cross-org supplement/revision relations and their storage proofs', () => tx(async () => {
    await db.exec(`RESET ROLE; UPDATE income_expense_supplements SET organization_id='${otherOrg}'; UPDATE income_expense_revisions SET organization_id='${otherOrg}'; SET LOCAL ROLE authenticated;`);
    expect(await count('income_expense_supplements')).toBe(0); expect(await count('income_expense_revisions')).toBe(0);
    expect((await db.query<{ ok: boolean }>("SELECT app_private.ie_supplement_storage_can_read_v1('proof','visible') ok")).rows[0].ok).toBe(false);
  }));
  it('supports parent filtering through item EXISTS without policy recursion', () => tx(async () => {
    expect((await db.query<{ id: string }>('SELECT p.id FROM income_expenses p WHERE EXISTS(SELECT 1 FROM income_expense_items i WHERE i.income_expense_id=p.id AND i.income_expense_type_id=$1)', [type])).rows).toEqual([{ id: voucher }]);
  }));
  it('returns over 1000 lines without API row truncation and fresh header with items', () => tx(async () => {
    await db.exec(`RESET ROLE; INSERT INTO income_expense_items(id,income_expense_id,organization_id,income_expense_type_id) SELECT md5(n::text)::uuid,'${voucher}','${org}','${type}' FROM generate_series(1,1005) n; UPDATE income_expenses SET total_amount=123,updated_at='2026-09-29' WHERE id='${voucher}'; SET LOCAL ROLE authenticated;`);
    const row = (await read()).rows[0]; expect(row.items).toHaveLength(1006); expect(row.expected_item_count).toBe(1006); expect(row.items_complete).toBe(true); expect(row.header.total_amount).toBe('123'); expect(row.header.updated_at).toContain('2026-09-29');
  }));
  it('blocks direct metadata bridge, reader impersonation, anonymous RPC and write escalation', () => tx(async () => {
    await denied(() => db.query('SELECT app_private.ie_detail_metadata_v1($1,$2::uuid[])', [org, [hidden]]), '42501');
    await denied(() => db.query('SELECT app_private.ie_supplement_can_append_scope_v1($1)', [voucher]), '42501');
    // PostgreSQL permits SET ROLE via session_user; check API role membership itself.
    expect((await db.query<{ allowed: boolean }>("SELECT pg_has_role('authenticated','ie_detail_reader','MEMBER') allowed")).rows[0].allowed).toBe(false);
    await denied(() => db.query('UPDATE income_expense_items SET amount=0 WHERE id=$1', [item]), '42501');
    await db.exec('RESET ROLE; SET LOCAL ROLE anon'); await denied(() => read(), '42501');
    await db.exec('RESET ROLE; SET LOCAL ROLE service_role'); await denied(() => read(), '42501');
  }));
  it('fails closed if migration finds organization corruption, body drift or privileged reader role', () => tx(async () => {
    await db.exec(`RESET ROLE; UPDATE income_expense_items SET organization_id=NULL WHERE id='${item}';`);
    await denied(() => db.exec(readFileSync(path, 'utf8')), 'P0001');
    await db.exec(`UPDATE income_expense_items SET organization_id='${org}' WHERE id='${item}'; ALTER ROLE ie_detail_reader BYPASSRLS;`);
    await denied(() => db.exec(readFileSync(path, 'utf8')), 'P0001');
    await db.exec('ALTER ROLE ie_detail_reader NOBYPASSRLS; GRANT SELECT ON buildings TO ie_detail_reader;');
    await denied(() => db.exec(readFileSync(path, 'utf8')), 'P0001');
  }));
});
