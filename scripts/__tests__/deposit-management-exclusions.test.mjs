import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, beforeEach, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../../supabase/migrations/20260928161948_hide_resolved_deposit_management.sql', import.meta.url), 'utf8');
const aggregateSource = readFileSync(new URL('../../supabase/migrations/20260710170000_money_aggregate_rpcs.sql', import.meta.url), 'utf8');
// Reproduce the deployed summary: July definition plus the September settlement filter.
const existingSummary = aggregateSource.match(/CREATE OR REPLACE FUNCTION public\.get_reservation_deposit_summary[\s\S]*?\$\$;/)[0]
  .replace('WHERE ie.contract_id IS NULL', 'WHERE ie.contract_id IS NULL\n      AND NOT EXISTS(SELECT 1 FROM public.reservation_deposit_settlements s WHERE s.source_voucher_id=ie.id)');
const voucher = '6196cec6-6c35-4ed5-87c7-e39c12f0f34f';
const org = 'aaaa0000-0000-4000-8000-000000000001';
const otherOrg = 'dddd0000-0000-4000-8000-000000000001';
const sandboxOrg = 'cccc0000-0000-4000-8000-000000000001';
const building = '59c6fc2c-2369-4ec8-b253-1ac64abb2f45';
const room = '46a8f5e8-cc72-4c32-a288-0dafe93f343c';
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const db = new PGlite();

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TYPE income_direction AS ENUM ('INCOME','EXPENSE');
    CREATE TYPE income_approval AS ENUM ('APPROVED','UNAPPROVED','CANCELLED');
    CREATE TYPE income_posting AS ENUM ('POSTED','DRAFT','CANCELLED');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.super',true)='true' $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY['${sandboxOrg}'::uuid] $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY);
    CREATE TABLE contracts(id uuid PRIMARY KEY, organization_id uuid, room_id uuid, deposit_amount numeric);
    CREATE TABLE income_expenses(
      id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations,
      code text, building_id uuid, room_id uuid, type income_direction, approval_status income_approval,
      posting_status income_posting, total_amount numeric, contract_id uuid REFERENCES contracts,
      deleted_at timestamptz, notes text, has_restricted_item boolean NOT NULL DEFAULT false);
    CREATE TABLE income_expense_types(id uuid PRIMARY KEY, is_deposit boolean, name text);
    CREATE TABLE income_expense_items(id uuid PRIMARY KEY, income_expense_id uuid REFERENCES income_expenses,
      income_expense_type_id uuid REFERENCES income_expense_types, amount numeric);
    CREATE TABLE income_expense_postings(id uuid PRIMARY KEY, income_expense_id uuid REFERENCES income_expenses, amount numeric);
    CREATE TABLE reservation_deposit_settlements(id uuid PRIMARY KEY, source_voucher_id uuid REFERENCES income_expenses);
    CREATE FUNCTION public.room_has_holding_deposit(p_room uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER AS $$
      SELECT EXISTS(SELECT 1 FROM public.income_expenses ie WHERE ie.room_id=p_room AND ie.contract_id IS NULL
        AND ie.deleted_at IS NULL AND ie.type='INCOME' AND ie.approval_status='APPROVED'
        AND EXISTS(SELECT 1 FROM public.income_expense_items it JOIN public.income_expense_types t ON t.id=it.income_expense_type_id WHERE it.income_expense_id=ie.id AND t.is_deposit)
        AND NOT EXISTS(SELECT 1 FROM public.reservation_deposit_settlements s WHERE s.source_voucher_id=ie.id))
    $$;
    ALTER TABLE income_expenses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY source_scope ON income_expenses FOR SELECT TO authenticated USING(
      auth.uid() IS NOT NULL AND organization_id::text=current_setting('test.org',true)
      AND building_id::text=current_setting('test.building',true) AND NOT has_restricted_item);
    GRANT USAGE ON SCHEMA public,auth TO authenticated;
    GRANT SELECT ON income_expenses,income_expense_types,income_expense_items,reservation_deposit_settlements TO authenticated;
    INSERT INTO organizations VALUES('${org}'),('${otherOrg}'),('${sandboxOrg}');
    INSERT INTO contracts VALUES('${id(90)}','${org}','${room}',5000000);
    INSERT INTO income_expense_types VALUES('${id(91)}',true,'Deposit'),('${id(92)}',false,'Rent');
    INSERT INTO income_expenses(id,organization_id,code,building_id,room_id,type,approval_status,posting_status,total_amount,notes)
      VALUES('${voucher}','${org}','PT2605043','${building}','${room}','INCOME','APPROVED','POSTED',5000000,'Original immutable receipt');
    INSERT INTO income_expense_items VALUES('${id(93)}','${voucher}','${id(91)}',5000000);
    INSERT INTO income_expense_postings VALUES('${id(94)}','${voucher}',5000000);
    INSERT INTO income_expenses(id,organization_id,code,building_id,room_id,type,approval_status,posting_status,total_amount)
      SELECT '${id(1)}'::uuid,'${org}'::uuid,'PT2605043','${building}'::uuid,'${id(31)}'::uuid,'INCOME'::income_direction,'APPROVED'::income_approval,'POSTED'::income_posting,2000000
      UNION ALL SELECT '${id(2)}','${org}','SETTLED','${building}','${id(32)}','INCOME','APPROVED','POSTED',3000000
      UNION ALL SELECT '${id(3)}','${org}','PENDING','${building}','${id(33)}','INCOME','UNAPPROVED','DRAFT',4000000
      UNION ALL SELECT '${id(4)}','${org}','CANCELLED','${building}','${id(34)}','INCOME','CANCELLED','CANCELLED',6000000
      UNION ALL SELECT '${id(5)}','${otherOrg}','PT2605043','${building}','${id(35)}','INCOME','APPROVED','POSTED',7000000
      UNION ALL SELECT '${id(6)}','${org}','RESTRICTED','${building}','${id(36)}','INCOME','APPROVED','POSTED',8000000
      UNION ALL SELECT '${id(7)}','${org}','OTHER BUILDING','${id(70)}','${id(37)}','INCOME','APPROVED','POSTED',9000000
      UNION ALL SELECT '${id(8)}','${sandboxOrg}','SANDBOX','${building}','${id(38)}','INCOME','APPROVED','POSTED',1000000;
    UPDATE income_expenses SET has_restricted_item=true WHERE id='${id(6)}';
    INSERT INTO income_expense_items SELECT id,id,'${id(91)}',total_amount FROM income_expenses WHERE id<>'${voucher}';
    INSERT INTO reservation_deposit_settlements VALUES('${id(80)}','${id(2)}');
    SELECT set_config('request.jwt.claim.sub','${id(99)}',false),set_config('test.org','${org}',false),set_config('test.building','${building}',false),set_config('test.super','false',false);
  `);
  await db.exec(existingSummary);
}, 30_000);
beforeEach(async () => { await db.exec('BEGIN'); });
afterEach(async () => { await db.exec('ROLLBACK; RESET ROLE'); });
afterAll(async () => { await db.close(); });

async function summary() {
  return (await db.query('SELECT public.get_reservation_deposit_summary() AS value')).rows[0].value;
}

async function sourceSnapshot() {
  const tables = ['income_expenses','income_expense_items','income_expense_types','income_expense_postings','contracts','reservation_deposit_settlements'];
  return Promise.all(tables.map(async table => (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows));
}

test('excludes exactly the authorized voucher, preserves source money and holding guards, and replays without change', async () => {
  const before = await sourceSnapshot();
  const guardBefore = (await db.query("SELECT pg_get_functiondef('public.room_has_holding_deposit(uuid)'::regprocedure) AS def")).rows[0].def;
  const metadataBefore = (await db.query("SELECT proowner,proacl,prosecdef,provolatile,proconfig FROM pg_proc WHERE oid='public.get_reservation_deposit_summary(uuid[])'::regprocedure")).rows[0];
  await db.exec('SET ROLE authenticated');
  assert.deepEqual(await summary(), { holding_amount:7000000, approved_count:2, unapproved_count:1, cancelled_count:1 });
  await db.exec('RESET ROLE');
  await db.exec(migration);
  await db.exec('SET ROLE authenticated');
  assert.deepEqual(await summary(), { holding_amount:2000000, approved_count:1, unapproved_count:1, cancelled_count:1 });
  assert.equal((await db.query('SELECT public.room_has_holding_deposit($1) AS holding',[room])).rows[0].holding, true);
  assert.equal((await db.query('SELECT public.room_has_holding_deposit($1) AS holding',[id(32)])).rows[0].holding, false);
  assert.equal((await db.query('SELECT public.get_reservation_deposit_summary($1) AS value',[[id(70)]])).rows[0].value.holding_amount, 0);
  await db.exec('RESET ROLE');
  assert.deepEqual(await sourceSnapshot(), before);
  await db.exec("UPDATE deposit_management_exclusions SET hidden_at='2026-09-01T00:00:00Z'");
  const exclusion = (await db.query('SELECT * FROM deposit_management_exclusions')).rows;
  assert.equal(exclusion.length,1);
  assert.equal(exclusion[0].voucher_id,voucher);
  assert.equal(exclusion[0].organization_id,org);
  assert.match(exclusion[0].reason,/2026-09-28/);
  assert.match(exclusion[0].reason,/display-only/);
  assert.match(exclusion[0].reason,/user authorization/);
  await db.exec(migration);
  assert.deepEqual((await db.query('SELECT * FROM deposit_management_exclusions')).rows,exclusion);
  assert.deepEqual(await sourceSnapshot(),before);
  assert.deepEqual((await db.query("SELECT proowner,proacl,prosecdef,provolatile,proconfig FROM pg_proc WHERE oid='public.get_reservation_deposit_summary(uuid[])'::regprocedure")).rows[0],metadataBefore);
  assert.equal((await db.query("SELECT pg_get_functiondef('public.room_has_holding_deposit(uuid)'::regprocedure) AS def")).rows[0].def,guardBefore);
});

test('RLS follows source visibility even with another permissive policy and denies every client write', async () => {
  await db.exec(migration);
  await db.exec(`INSERT INTO deposit_management_exclusions(voucher_id,organization_id,reason)
    SELECT id,organization_id,'fixture display-only exclusion' FROM income_expenses WHERE id IN('${id(5)}','${id(6)}','${id(7)}','${id(8)}');
    CREATE POLICY simulated_boundary_allow ON deposit_management_exclusions FOR SELECT TO authenticated USING(true);
    SET ROLE authenticated;`);
  assert.deepEqual((await db.query('SELECT voucher_id FROM deposit_management_exclusions')).rows,[{voucher_id:voucher}]);
  await db.exec(`SELECT set_config('test.org','${otherOrg}',true);`);
  assert.deepEqual((await db.query('SELECT voucher_id FROM deposit_management_exclusions')).rows,[{voucher_id:id(5)}]);
  await db.exec(`SELECT set_config('test.org','${org}',true),set_config('test.building','${id(70)}',true);`);
  assert.deepEqual((await db.query('SELECT voucher_id FROM deposit_management_exclusions')).rows,[{voucher_id:id(7)}]);
  await db.exec(`SELECT set_config('test.org','${sandboxOrg}',true),set_config('test.building','${building}',true),set_config('test.super','true',true);`);
  assert.deepEqual((await db.query('SELECT voucher_id FROM deposit_management_exclusions')).rows,[]);
  await db.exec(`SELECT set_config('test.super','false',true);`);
  assert.deepEqual((await db.query('SELECT voucher_id FROM deposit_management_exclusions')).rows,[{voucher_id:id(8)}]);
  await db.exec('RESET ROLE');
  for (const role of ['anon','authenticated','service_role']) {
    await db.exec(`SET ROLE ${role}`);
    for (const sql of [
      `INSERT INTO deposit_management_exclusions(voucher_id,organization_id,reason) VALUES('${id(1)}','${org}','unauthorized')`,
      "UPDATE deposit_management_exclusions SET reason='unauthorized'",
      'DELETE FROM deposit_management_exclusions',
      'TRUNCATE deposit_management_exclusions',
    ]) {
      await db.exec('SAVEPOINT denied_write');
      await assert.rejects(db.exec(sql),/permission denied/i);
      await db.exec('ROLLBACK TO denied_write');
    }
    await db.exec('RESET ROLE');
  }
});

test('skips seed on an unrelated database and requires matching org, reason and foreign key identity', async () => {
  await db.exec(`DELETE FROM income_expense_postings WHERE income_expense_id='${voucher}'; DELETE FROM income_expense_items WHERE income_expense_id='${voucher}'; DELETE FROM income_expenses WHERE id='${voucher}';`);
  await db.exec(migration);
  await db.exec(migration);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM deposit_management_exclusions')).rows[0].count,0);
  const fk = (await db.query("SELECT confrelid::regclass::text AS target FROM pg_constraint WHERE conrelid='public.deposit_management_exclusions'::regclass AND conname='deposit_management_exclusions_voucher_id_fkey'")).rows;
  assert.deepEqual(fk,[{target:'income_expenses'}]);
  await db.exec('SAVEPOINT bad_reason');
  await assert.rejects(db.exec(`INSERT INTO deposit_management_exclusions(voucher_id,organization_id,reason) VALUES('${id(1)}','${org}','   ')`),/check constraint/i);
  await db.exec('ROLLBACK TO bad_reason');
});

test('rejects identity or financial drift instead of hiding a different receipt', async () => {
  const drifts = [
    `code='OTHER'`, `organization_id='${otherOrg}'`, `building_id='${id(70)}'`, `room_id='${id(70)}'`,
    "type='EXPENSE'", "approval_status='UNAPPROVED'", "posting_status='DRAFT'", 'total_amount=4000000',
    `contract_id='${id(90)}'`, "deleted_at='2026-09-28'",
  ];
  for (const assignment of drifts) {
    await db.exec('SAVEPOINT source_drift');
    await db.exec(`UPDATE income_expenses SET ${assignment} WHERE id='${voucher}'`);
    await assert.rejects(db.exec(migration),/Deposit management exclusion source mismatch/);
    await db.exec('ROLLBACK TO source_drift');
  }
  for (const sql of [
    `UPDATE income_expense_items SET amount=1 WHERE income_expense_id='${voucher}'`,
    `UPDATE income_expense_types SET is_deposit=false WHERE id='${id(91)}'`,
  ]) {
    await db.exec('SAVEPOINT deposit_drift');
    await db.exec(sql);
    await assert.rejects(db.exec(migration),/Deposit management exclusion source mismatch/);
    await db.exec('ROLLBACK TO deposit_drift');
  }
});

test('rejects an existing conflicting exclusion instead of silently accepting it on replay', async () => {
  await db.exec(migration);
  for (const assignment of [`organization_id='${otherOrg}'`,"reason='unrelated request'"]) {
    await db.exec('SAVEPOINT exclusion_drift');
    await db.exec(`UPDATE deposit_management_exclusions SET ${assignment} WHERE voucher_id='${voucher}'`);
    await assert.rejects(db.exec(migration),/Deposit management exclusion metadata mismatch/);
    await db.exec('ROLLBACK TO exclusion_drift');
  }
});

test('preserves additional deployed summary filters and rejects definer or unknown function drift', async () => {
  await db.exec(existingSummary.replace('WHERE ie.contract_id IS NULL',`WHERE ie.contract_id IS NULL AND ie.id <> '${id(1)}'::uuid`));
  await db.exec(migration);
  await db.exec('SET ROLE authenticated');
  assert.deepEqual(await summary(),{holding_amount:0,approved_count:0,unapproved_count:1,cancelled_count:1});
  await db.exec('RESET ROLE');
  for (const [definition, error] of [
    [existingSummary.replace('SECURITY INVOKER','SECURITY DEFINER'),/must remain SECURITY INVOKER/],
    [existingSummary.replace('WHERE ie.contract_id IS NULL','WHERE ie.contract_id IS NOT DISTINCT FROM NULL'),/summary catalog drift/],
  ]) {
    await db.exec('SAVEPOINT function_drift');
    await db.exec(definition);
    await assert.rejects(db.exec(migration),error);
    await db.exec('ROLLBACK TO function_drift');
  }
});
