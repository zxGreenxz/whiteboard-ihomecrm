import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const path = 'supabase/migrations/20260929130117_contract_commission_followups.sql';
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(1), otherOrg = id(2), actor = id(3), otherActor = id(4), building = id(5), hiddenBuilding = id(6);
const room = id(7), hiddenRoom = id(8), contract = id(9), hiddenContract = id(10), foreignContract = id(11), voucher = id(12), deposit = id(13);
type Event = { action: string; reason: string | null; amount: number | null; actor_name: string | null; created_at: string };
type Row = { contract_id: string; kind: string; state: string; last_reason: string | null; last_actor: string | null; attempted_amount: number | null; voucher_id: string | null; voucher_code: string | null; voucher_status: string | null; can_manage: boolean; events: Event[] };
type Page = { rows: Row[]; total: number };

beforeAll(async () => {
  // Real PostgreSQL roles/RLS and transaction-local JWT claims. The permission
  // catalog boundary is represented by explicit grants, not a blanket allow.
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES('${actor}'),('${otherActor}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY); INSERT INTO organizations VALUES('${org}'),('${otherOrg}');
    CREATE TABLE memberships(organization_id uuid,user_id uuid); INSERT INTO memberships VALUES('${org}','${actor}'),('${org}','${otherActor}');
    CREATE TABLE grants(user_id uuid,organization_id uuid,building_id uuid,permission text,org_wide boolean DEFAULT false);
    INSERT INTO grants SELECT '${actor}','${org}','${building}',p FROM unnest(ARRAY['contracts.view','contracts.edit','income_expenses.view','income_expenses.create']) p;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT coalesce(array_agg(organization_id),'{}') FROM memberships WHERE user_id=auth.uid() $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM grants WHERE user_id=auth.uid() AND building_id=$1) $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.super_admin',true),'')='yes' $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT CASE WHEN coalesce(current_setting('test.sandbox',true),'')='yes' THEN ARRAY['${org}'::uuid] ELSE '{}'::uuid[] END $$;
    CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT bool_or(org_wide),array_agg(building_id),'{}'::uuid[] FROM grants WHERE user_id=auth.uid() AND permission=$1 AND organization_id=$2 HAVING count(*)>0 $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM grants WHERE user_id=$1 AND organization_id=$2 AND permission=$3 AND building_id=$4) $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid NOT NULL,name text,deleted_at timestamptz);
    INSERT INTO buildings VALUES('${building}','${org}','Visible',NULL),('${hiddenBuilding}','${org}','Hidden',NULL);
    CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid NOT NULL,building_id uuid,name text,deleted_at timestamptz);
    INSERT INTO rooms VALUES('${room}','${org}','${building}','101',NULL),('${hiddenRoom}','${org}','${hiddenBuilding}','102',NULL);
    CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid NOT NULL,room_id uuid,contract_number text,status text,signed_date date DEFAULT '2026-09-29',created_at timestamptz DEFAULT now(),deleted_at timestamptz,UNIQUE(organization_id,id));
    INSERT INTO contracts(id,organization_id,room_id,contract_number,status) VALUES('${contract}','${org}','${room}','OLD-01','TERMINATED'),('${hiddenContract}','${org}','${hiddenRoom}','HIDDEN','ACTIVE'),('${foreignContract}','${otherOrg}','${room}','FOREIGN','ACTIVE');
    CREATE TABLE profiles(id uuid PRIMARY KEY,full_name text); INSERT INTO profiles VALUES('${actor}','Người xử lý'),('${otherActor}','Khác');
    CREATE TABLE income_expenses(id uuid PRIMARY KEY,organization_id uuid NOT NULL,contract_id uuid,building_id uuid,commission_kind text,code text,approval_status text,deleted_at timestamptz,created_at timestamptz DEFAULT now(),visible boolean DEFAULT true);
    CREATE TABLE app_private.sale_bonus_claims(organization_id uuid,deposit_voucher_id uuid,bonus_voucher_id uuid);
    CREATE FUNCTION app_private.ie_supplement_can_read_v1(uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM income_expenses v JOIN grants g ON g.organization_id=v.organization_id AND g.building_id=v.building_id WHERE v.id=$1 AND v.visible AND g.user_id=auth.uid() AND g.permission='income_expenses.view') $$;
    GRANT USAGE ON SCHEMA public,auth,app_private TO authenticated,anon,service_role;
  `);
  if (existsSync(path)) { await db.exec(readFileSync(path, 'utf8')); await db.exec(readFileSync(path, 'utf8')); }
}, 30_000);
afterAll(() => db.close());

async function tx(run: () => Promise<void>) {
  await db.exec(`BEGIN; SET LOCAL request.jwt.claims='{"sub":"${actor}","role":"authenticated"}'; SET LOCAL ROLE authenticated;`);
  try { await run(); } finally { await db.exec('ROLLBACK'); }
}
async function denied(run: () => Promise<unknown>, code: string) {
  await db.exec('SAVEPOINT denied');
  try { await expect(run()).rejects.toMatchObject({ code }); } finally { await db.exec('ROLLBACK TO SAVEPOINT denied; RELEASE SAVEPOINT denied'); }
}
async function owner(sql: string) { await db.exec(`RESET ROLE; ${sql}; SET LOCAL ROLE authenticated;`); }
async function list(options: { org?: string | null; ids?: string[] | null; buildings?: string[] | null; offset?: number; limit?: number; unresolved?: boolean } = {}) {
  return (await db.query<{ result: Page }>('SELECT public.list_contract_commission_followups_v1($1,$2::uuid[],$3::uuid[],$4,$5,$6) result', [options.org === undefined ? org : options.org, options.ids ?? null, options.buildings ?? null, options.offset ?? 0, options.limit ?? 50, options.unresolved ?? false])).rows[0].result;
}
async function record(action: string, request = id(100), amount: number | string | null = 100, reason: string | null = null, kind = 'broker', contractId = contract, organization = org) {
  return (await db.query<{ result: { id: string; action: string } }>('SELECT public.record_contract_commission_event_v1($1,$2,$3,$4,$5,$6::numeric,$7) result', [organization, contractId, kind, action, request, amount, reason])).rows[0].result;
}
async function broker() { return (await list()).rows.find(row => row.contract_id === contract && row.kind === 'broker')!; }
async function liveVoucher(kind = 'broker', linkedContract: string | null = contract) {
  await owner(`INSERT INTO income_expenses(id,organization_id,contract_id,building_id,commission_kind,code,approval_status) VALUES('${voucher}','${org}',${linkedContract ? `'${linkedContract}'` : 'NULL'},'${building}','${kind}','PC-01','APPROVED')`);
}

describe('durable contract commission SQL follow-up', () => {
  it('makes historical contracts without flags/events pending, never assumes non-applicable', () => tx(async () => {
    const result = await list();
    expect(result.total).toBe(2);
    expect(result.rows).toMatchObject([{ contract_id: contract, kind: 'broker', state: 'PENDING', can_manage: true, attempted_amount: null, events: [] }, { contract_id: contract, kind: 'sale', state: 'PENDING', events: [] }]);
  }));
  it('persists attempted then failed with reason/actor and retries without duplicating the audit', () => tx(async () => {
    const a = await record('ATTEMPTED');
    expect(await record('ATTEMPTED')).toEqual(a);
    expect(await broker()).toMatchObject({ state: 'UNKNOWN', attempted_amount: 100, last_actor: 'Người xử lý' });
    const f = await record('FAILED', id(100), 100, 'Mất phản hồi');
    expect(await record('FAILED', id(100), 100, 'Mất phản hồi')).toEqual(f);
    expect(await broker()).toMatchObject({ state: 'FAILED', last_reason: 'Mất phản hồi', events: [{ action: 'ATTEMPTED' }, { action: 'FAILED', reason: 'Mất phản hồi' }] });
    await denied(() => record('ATTEMPTED', id(100), 200), 'PT409');
    await record('ATTEMPTED', id(101), 200);
    expect(await broker()).toMatchObject({ state: 'UNKNOWN', attempted_amount: 200 });
  }));
  it('requires failure to match its recorded attempt and does not let a stale failure override a newer decision', () => tx(async () => {
    await denied(() => record('FAILED', id(100), 100, 'Lỗi'), 'PT409');
    await record('ATTEMPTED');
    await denied(() => record('FAILED', id(100), 200, 'Lỗi'), 'PT409');
    await record('NOT_APPLICABLE', id(101), null, 'Không dùng môi giới');
    await record('FAILED', id(100), 100, 'Lỗi trả về muộn');
    expect(await broker()).toMatchObject({ state: 'NOT_APPLICABLE', last_reason: 'Không dùng môi giới' });
    await denied(() => record('ATTEMPTED', id(102)), 'PT409');
    await record('REOPENED', id(103), null);
    expect(await broker()).toMatchObject({ state: 'PENDING' });
    await record('ATTEMPTED', id(104), 200);
    expect(await broker()).toMatchObject({ state: 'UNKNOWN', attempted_amount: 200 });
  }));
  it('ignores a stale failure after a newer attempt but keeps it in the audit', () => tx(async () => {
    await record('ATTEMPTED'); await record('ATTEMPTED', id(101), 200);
    await record('FAILED', id(100), 100, 'Lỗi cũ');
    expect(await broker()).toMatchObject({ state: 'UNKNOWN', attempted_amount: 200 });
    expect((await broker()).events).toHaveLength(3);
  }));
  it('live voucher wins lost response or failure; approved remains a voucher status, not payment', () => tx(async () => {
    await record('ATTEMPTED'); await record('FAILED', id(100), 100, 'Mất phản hồi'); await liveVoucher();
    expect(await broker()).toMatchObject({ state: 'VOUCHER_CREATED', voucher_id: voucher, voucher_code: 'PC-01', voucher_status: 'APPROVED' });
    await denied(() => record('NOT_APPLICABLE', id(101), null, 'Không phát sinh'), 'PT409');
    await denied(() => record('ATTEMPTED', id(102)), 'PT409');
    expect((await list({ unresolved: true })).rows.map(row => row.kind)).toEqual(['sale']);
    await owner(`UPDATE income_expenses SET approval_status='CANCELLED' WHERE id='${voucher}'`);
    expect(await broker()).toMatchObject({ state: 'FAILED', voucher_id: null });
    await record('ATTEMPTED', id(102));
    expect(await broker()).toMatchObject({ state: 'UNKNOWN' });
  }));
  it('detects Sale linked through a deposit claim; cancelled/deleted bonus does not resolve it', () => tx(async () => {
    await liveVoucher('sale', null);
    await owner(`INSERT INTO income_expenses(id,organization_id,contract_id,building_id,code,approval_status) VALUES('${deposit}','${org}','${contract}','${building}','COC-01','APPROVED'); INSERT INTO app_private.sale_bonus_claims VALUES('${org}','${deposit}','${voucher}')`);
    expect((await list()).rows.find(row => row.kind === 'sale')).toMatchObject({ state: 'VOUCHER_CREATED', voucher_id: voucher });
    await denied(() => record('NOT_APPLICABLE', id(101), null, 'Không phát sinh', 'sale'), 'PT409');
    await owner(`UPDATE income_expenses SET deleted_at=now() WHERE id='${voucher}'`);
    expect((await list()).rows.find(row => row.kind === 'sale')).toMatchObject({ state: 'PENDING', voucher_id: null });
  }));
  it('does not borrow a bonus from another organization via corrupted source links', () => tx(async () => {
    await liveVoucher('sale', null);
    await owner(`INSERT INTO income_expenses(id,organization_id,contract_id,building_id,code,approval_status) VALUES('${deposit}','${org}','${contract}','${building}','COC-01','APPROVED'); INSERT INTO app_private.sale_bonus_claims VALUES('${otherOrg}','${deposit}','${voucher}')`);
    expect((await list()).rows.find(row => row.kind === 'sale')).toMatchObject({ state: 'PENDING' });
  }));
  it('keeps financial amounts and voucher detail behind their own readable scope', () => tx(async () => {
    await record('ATTEMPTED'); await liveVoucher();
    await owner(`DELETE FROM grants WHERE permission='income_expenses.view'`);
    expect(await broker()).toMatchObject({ state: 'VOUCHER_CREATED', attempted_amount: null, voucher_id: null, voucher_code: null, voucher_status: null, events: [{ amount: null }] });
    await denied(() => db.query('SELECT * FROM contract_commission_events'), '42501');
  }));
  it('redacts amounts and free-text reasons with hidden parent cashbook despite a finance building grant', () => tx(async () => {
    await record('ATTEMPTED'); await record('FAILED', id(100), 100, 'Phiếu 100 đồng mất phản hồi');
    await liveVoucher(); await owner('UPDATE income_expenses SET visible=false');
    expect(await broker()).toMatchObject({ state: 'VOUCHER_CREATED', voucher_id: null, voucher_code: null, voucher_status: null,
      attempted_amount: null, last_reason: null, events: [{ amount: null, reason: null }, { amount: null, reason: null }] });
    await owner("UPDATE grants SET org_wide=true WHERE permission='income_expenses.view'");
    expect(await broker()).toMatchObject({ attempted_amount: null, last_reason: null, events: [{ amount: null }, { amount: null, reason: null }] });
    await denied(() => db.query('SELECT amount,reason FROM contract_commission_events'), '42501');
  }));
  it('without a live voucher only exposes financial text and amount to its author or organization-wide financial readers', () => tx(async () => {
    await owner(`INSERT INTO grants(user_id,organization_id,building_id,permission) SELECT '${otherActor}',organization_id,building_id,permission FROM grants WHERE user_id='${actor}'`);
    await db.exec(`SET LOCAL request.jwt.claims='{"sub":"${otherActor}"}'`);
    await record('ATTEMPTED'); await record('FAILED', id(100), 100, 'Số tiền nhạy cảm 100');
    expect(await broker()).toMatchObject({ attempted_amount: 100, last_reason: 'Số tiền nhạy cảm 100' });
    await db.exec(`SET LOCAL request.jwt.claims='{"sub":"${actor}"}'`);
    expect(await broker()).toMatchObject({ state: 'FAILED', attempted_amount: null, last_reason: null,
      events: [{ amount: null, reason: null }, { amount: null, reason: null }] });
    await record('NOT_APPLICABLE', id(101), null, 'Tự xử lý');
    expect(await broker()).toMatchObject({ last_reason: 'Tự xử lý', events: [{ reason: null }, { reason: null }, { reason: 'Tự xử lý' }] });
    await owner(`UPDATE grants SET org_wide=true WHERE permission='income_expenses.view' AND user_id='${actor}'`);
    expect((await broker()).events).toMatchObject([{ amount: 100 }, { amount: 100, reason: 'Số tiền nhạy cảm 100' }, { reason: 'Tự xử lý' }]);
    await owner(`DELETE FROM grants WHERE permission='income_expenses.view' AND user_id='${actor}'`);
    expect(await broker()).toMatchObject({ last_reason: null, events: [{ amount: null }, { amount: null, reason: null }, { reason: null }] });
  }));
  it('enforces organization and building boundaries for mutations and reads, including admin', () => tx(async () => {
    await denied(() => list({ org: otherOrg }), '42501');
    await denied(() => record('ATTEMPTED', id(100), 100, null, 'broker', foreignContract), '42501');
    await denied(() => record('ATTEMPTED', id(100), 100, null, 'broker', hiddenContract), '42501');
    expect(await list({ buildings: [hiddenBuilding] })).toEqual({ rows: [], total: 0 });
    expect(await list({ ids: [foreignContract] })).toEqual({ rows: [], total: 0 });
    await db.exec("SET LOCAL test.super_admin='yes'");
    await denied(() => record('ATTEMPTED', id(100), 100, null, 'broker', hiddenContract), '42501');
    await db.exec("SET LOCAL test.sandbox='yes'");
    expect((await list()).total).toBe(0);
    await denied(() => record('ATTEMPTED'), '42501');
  }));
  it('does not reuse a permission granted on a different building just because general building access exists', () => tx(async () => {
    // Staff can access the second building's rooms while contracts/finance are
    // granted only on the first; those grants must not become org-wide.
    await owner(`INSERT INTO grants VALUES('${actor}','${org}','${hiddenBuilding}','rooms.view')`);
    expect((await list()).total).toBe(2);
    expect((await list({ buildings: [hiddenBuilding] })).rows).toEqual([]);
    await denied(() => record('ATTEMPTED', id(100), 100, null, 'broker', hiddenContract), '42501');
  }));
  it('requires contract view plus a scoped signing/editing and finance writer permission', () => tx(async () => {
    await owner("DELETE FROM grants WHERE permission='contracts.edit'");
    expect((await broker()).can_manage).toBe(false); await denied(() => record('ATTEMPTED'), '42501');
    await owner(`INSERT INTO grants VALUES('${actor}','${org}','${building}','contracts.create')`);
    expect((await broker()).can_manage).toBe(true); await record('ATTEMPTED');
    await owner("DELETE FROM grants WHERE permission='income_expenses.create'");
    expect((await broker()).can_manage).toBe(false); await denied(() => record('NOT_APPLICABLE', id(101), null, 'Lý do'), '42501');
    await owner("DELETE FROM grants WHERE permission='contracts.view'");
    expect((await list()).total).toBe(0);
  }));
  it('never exposes events directly across scope and blocks direct writes, owner updates and deletes', () => tx(async () => {
    await record('ATTEMPTED');
    await denied(() => db.query('SELECT * FROM contract_commission_events'), '42501');
    await denied(() => db.query('UPDATE contract_commission_events SET amount=0'), '42501');
    await denied(() => db.query('DELETE FROM contract_commission_events'), '42501');
    await denied(() => db.query('INSERT INTO contract_commission_events DEFAULT VALUES'), '42501');
    await db.exec('RESET ROLE');
    await denied(() => db.query('UPDATE contract_commission_events SET amount=0'), '42501');
    await denied(() => db.query('DELETE FROM contract_commission_events'), '42501');
    await db.exec(`SET LOCAL request.jwt.claims='{"sub":"${otherActor}"}'; SET LOCAL ROLE authenticated`);
    await denied(() => db.query('SELECT * FROM contract_commission_events'), '42501');
    expect((await list()).rows).toEqual([]);
  }));
  it('revokes historical event reads after the contract moves outside the current building scope', () => tx(async () => {
    await record('ATTEMPTED');
    await owner(`UPDATE contracts SET room_id='${hiddenRoom}' WHERE id='${contract}'`);
    expect((await list()).rows).toEqual([]);
    await denied(() => db.query('SELECT * FROM contract_commission_events'), '42501');
  }));
  it('rejects audit truncation and direct access to private financial/status bridges', () => tx(async () => {
    await denied(() => db.query('SELECT app_private.contract_commission_live_voucher_v1($1,$2,$3)', [org, contract, 'broker']), '42501');
    await denied(() => db.query('SELECT app_private.contract_commission_latest_event_v1($1,$2,$3)', [org, contract, 'broker']), '42501');
    await record('ATTEMPTED');
    await db.exec('RESET ROLE');
    await denied(() => db.query('TRUNCATE contract_commission_events'), '42501');
  }));
  it('rejects missing/invalid values and anonymous or service-role invocation', () => tx(async () => {
    for (const action of ['NOPE', '']) await denied(() => record(action), '22023');
    for (const kind of ['other', '']) await denied(() => record('ATTEMPTED', id(100), 100, null, kind), '22023');
    for (const amount of [0, -1, 'NaN', 'Infinity', '-Infinity']) await denied(() => record('ATTEMPTED', id(100), amount), '22023');
    for (const action of ['FAILED', 'NOT_APPLICABLE']) await denied(() => record(action, id(100), null, '  '), '22023');
    await denied(() => list({ limit: 101 }), '22023'); await denied(() => list({ limit: 0 }), '22023'); await denied(() => list({ offset: -1 }), '22023');
    await denied(() => list({ ids: Array.from({ length: 201 }, () => contract) }), '22023');
    for (const role of ['anon', 'service_role']) { await db.exec(`RESET ROLE; SET LOCAL ROLE ${role}`); await denied(() => list(), '42501'); await denied(() => record('ATTEMPTED'), '42501'); }
  }));
  it('counts all unresolved rows beyond API cap and returns deterministic bounded pages', () => tx(async () => {
    await owner(`INSERT INTO contracts(id,organization_id,room_id,contract_number,status) SELECT md5(n::text)::uuid,'${org}','${room}','OLD-'||n,'ACTIVE' FROM generate_series(1,1005) n`);
    await record('NOT_APPLICABLE', id(100), null, 'Không phát sinh');
    const first = await list({ limit: 10, unresolved: true });
    expect(first.total).toBe(2011); expect(first.rows).toHaveLength(10);
    const second = await list({ offset: 10, limit: 10, unresolved: true });
    expect(second.total).toBe(2011); expect(second.rows).toHaveLength(10);
    expect(new Set([...first.rows, ...second.rows].map(row => row.contract_id + row.kind)).size).toBe(20);
    expect(await list({ offset: 2011, limit: 10, unresolved: true })).toEqual({ rows: [], total: 2011 });
    expect(await list({ ids: [] })).toEqual({ rows: [], total: 0 });
  }));
  it('bounds authorization work independently of contract count to avoid the PostgREST timeout', () => tx(async () => {
    await owner(`CREATE SEQUENCE test_scope_calls;
      CREATE OR REPLACE FUNCTION app_private.authorized_scope_v3(text,uuid)
      RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[])
      LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$ BEGIN
        PERFORM nextval('test_scope_calls');
        RETURN QUERY SELECT bool_or(g.org_wide),array_agg(g.building_id),'{}'::uuid[] FROM grants g
          WHERE g.user_id=auth.uid() AND g.permission=$1 AND g.organization_id=$2 HAVING count(*)>0;
      END $$;
      INSERT INTO contracts(id,organization_id,room_id,contract_number,status)
        SELECT md5(n::text)::uuid,'${org}','${room}','LOAD-'||n,'ACTIVE' FROM generate_series(1,1005) n`);
    expect((await list()).total).toBe(2012);
    await db.exec('RESET ROLE');
    expect((await db.query<{ last_value: number }>('SELECT last_value FROM test_scope_calls')).rows[0].last_value).toBe(5);
  }));
  it('surfaces new failed and unknown attempts before a backlog of untouched historical contracts', () => tx(async () => {
    const recentContract = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await owner(`INSERT INTO contracts(id,organization_id,room_id,contract_number,status)
      SELECT md5(n::text)::uuid,'${org}','${room}','OLD-'||n,'ACTIVE' FROM generate_series(1,100) n;
      INSERT INTO contracts(id,organization_id,room_id,contract_number,status)
      VALUES('${recentContract}','${org}','${room}','RECENT','ACTIVE')`);
    await record('ATTEMPTED', id(300), 100, null, 'broker', recentContract);
    await record('FAILED', id(300), 100, 'Lỗi cần xử lý', 'broker', recentContract);
    expect((await list({ limit: 1, unresolved: true })).rows).toMatchObject([{ contract_id: recentContract, state: 'FAILED' }]);
    await record('ATTEMPTED', id(301), 200, null, 'sale', recentContract);
    expect((await list({ limit: 2, unresolved: true })).rows).toMatchObject([
      { contract_id: recentContract, kind: 'sale', state: 'UNKNOWN' },
      { contract_id: recentContract, kind: 'broker', state: 'FAILED' },
    ]);
    expect((await list({ offset: 2, limit: 1, unresolved: true })).rows[0].state).toBe('PENDING');
  }));
});
