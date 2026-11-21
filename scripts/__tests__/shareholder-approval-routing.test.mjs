// @vitest-environment node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const sql = path => readFileSync(new URL('../../supabase/' + path, import.meta.url), 'utf8');
const baseline = sql('baseline/schema.sql');
const allocator = baseline.match(/CREATE FUNCTION app_private\.materialize_step_candidates_v1\(p_request_step_id uuid\)[\s\S]+?\n\$\$;/)[0];
const guard = sql('migrations/20261119032905_so_tong_loi_nhuan_chu_tu_duyet_chi.sql')
  .match(/CREATE OR REPLACE FUNCTION app_private\.guard_profit_ledger_payout_v1\(\)[\s\S]+?\n\$fn\$;/)[0];
const id = n => '20000000-0000-4000-8000-' + String(n).padStart(12, '0');
const [org, maker, checker, member, otherMember, req, step, rule, ruleStep, voucher] =
  Array.from({length:10}, (_, i) => id(i + 1));

test('a single permission-based shareholder approval includes the qualified maker and the independent checker', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA app_private; CREATE SCHEMA auth; SET check_function_bodies=off;
      CREATE TABLE approval_request_steps(id uuid, organization_id uuid, request_id uuid, step_no int, status text, mode text, min_approvals int, current_generation int, rule_step_snapshot jsonb, candidate_count int);
      CREATE TABLE approval_requests(id uuid, organization_id uuid, subject_type text, subject_id uuid, system_source text, state text, rule_effect text, maker_membership_id uuid, maker_user_id uuid, matched_rule_id uuid, building_id uuid, cashbook_id uuid);
      CREATE TABLE approval_rule_steps(id uuid, organization_id uuid, rule_id uuid);
      CREATE TABLE approval_step_approvers(id uuid, organization_id uuid, step_id uuid, approver_type text, permission_key text, membership_id uuid, role_id uuid);
      CREATE TABLE approval_request_step_candidates(organization_id uuid,request_step_id uuid,membership_id uuid,generation int,source_kind text,source_id uuid,eligible_at_submit bool,valid_from timestamptz,valid_to timestamptz);
      CREATE TABLE organization_memberships(id uuid,organization_id uuid,user_id uuid,status text,valid_from timestamptz,valid_to timestamptz);
      CREATE TABLE role_bindings(membership_id uuid, organization_id uuid, role_id uuid, id uuid, valid_from timestamptz,valid_to timestamptz);
      CREATE TABLE role_binding_scopes(role_binding_id uuid, organization_id uuid, scope_id uuid);
      CREATE TABLE authorization_scopes(id uuid,organization_id uuid,scope_type text,building_id uuid,area_id uuid);
      CREATE TABLE area_buildings(organization_id uuid,area_id uuid,building_id uuid);
      CREATE TABLE cashbook_possession_bindings(organization_id uuid,cashbook_id uuid,membership_id uuid,valid_from timestamptz,valid_to timestamptz);
      CREATE TABLE app_private.profit_ledger_payouts(voucher_id uuid,organization_id uuid,maker_kind text,subject_kind text,maker_user_id uuid,maker_membership_id uuid);
      CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE sql AS 'SELECT';
      CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS 'SELECT true';
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT current_setting(''test.actor'')::uuid';
      CREATE FUNCTION app_private.profit_advance_maker_kind_v1(uuid,boolean) RETURNS text LANGUAGE sql AS 'SELECT current_setting(''test.kind'')';
      SET test.kind='OWNER'; SET test.actor='${maker}';
      INSERT INTO approval_requests VALUES ('${req}','${org}','FINANCIAL_VOUCHER','${voucher}','profit.ledger_payout','PENDING_APPROVAL','REQUIRE_APPROVAL','${member}','${maker}','${rule}',NULL,NULL);
      INSERT INTO approval_rule_steps VALUES ('${ruleStep}','${org}','${rule}');
      INSERT INTO approval_request_steps VALUES ('${step}','${org}','${req}',1,'PENDING','ANY',1,1,'{"rule_step_id":"${ruleStep}"}',0);
      INSERT INTO approval_step_approvers VALUES (gen_random_uuid(),'${org}','${ruleStep}','PERMISSION','income_expenses.approve',NULL,NULL);
      INSERT INTO organization_memberships VALUES ('${member}','${org}','${maker}','ACTIVE',NULL,NULL),('${otherMember}','${org}','${checker}','ACTIVE',NULL,NULL);
      INSERT INTO app_private.profit_ledger_payouts VALUES ('${voucher}','${org}','OWNER','SHAREHOLDER','${maker}','${member}');`);
    await db.exec(allocator.replace(/\r?\n/g, '\r\n'));
    await db.exec(guard);
    const reader = sql('migrations/20261115083533_so_tong_loi_nhuan_doc.sql')
      .match(/CREATE OR REPLACE FUNCTION public\.profit_ledger_payout_detail_v1\([\s\S]+?\n\$fn\$;/)[0];
    await db.exec(reader);
    const inbox = sql('migrations/20260723250000_finance_v2_inbox_org.sql')
      .match(/CREATE FUNCTION public\.list_my_pending_approvals_v1\(\)[\s\S]+?\n\$function\$;/)[0];
    await db.exec(inbox);
    const migration = sql('migrations/20261121014008_duyet_phieu_co_dong_theo_vai_tro.sql');
    await db.exec(migration);
    await db.exec(migration);
    async function candidates() {
      await db.query('SELECT app_private.materialize_step_candidates_v1($1)', [step]);
      const result = await db.query('SELECT membership_id FROM approval_request_step_candidates WHERE valid_to IS NULL ORDER BY membership_id');
      return result.rows.map(row => row.membership_id);
    }
    assert.deepEqual(await candidates(), [member, otherMember]);
    await db.exec(`ALTER TABLE approval_requests ADD submission_no bigint DEFAULT 1, ADD submitted_at timestamptz DEFAULT now(), ADD amount numeric DEFAULT 90, ADD version bigint DEFAULT 1;
      CREATE TABLE income_expenses(id uuid, code text, name text, type text, creator_name text, approval_version bigint, posting_version bigint);
      INSERT INTO income_expenses VALUES ('${voucher}','TEST-1','Advance','EXPENSE','Maker',1,1)`);
    async function ownRow() {
      const result = await db.query('SELECT is_maker FROM public.list_my_pending_approvals_v1() WHERE voucher_id=$1', [voucher]);
      return result.rows.map(row => row.is_maker);
    }
    assert.deepEqual(await ownRow(), [true]);
    await db.exec(`SET test.actor='${checker}'`);
    assert.deepEqual(await ownRow(), [false]);
    await db.exec(`SET test.actor='${maker}'`);
    await db.exec("UPDATE organization_memberships SET valid_to=now()-interval '1 day' WHERE id='"+member+"'");
    assert.deepEqual(await candidates(), [otherMember]);
    await db.exec("UPDATE organization_memberships SET valid_to=NULL");
    await db.exec("SET test.kind='CUSTODIAN_FOR_PAYEE'");
    assert.deepEqual(await candidates(), [otherMember]);
    await db.exec(`SET test.kind='OWNER'; INSERT INTO approval_rule_steps VALUES (gen_random_uuid(),'${org}','${rule}')`);
    assert.deepEqual(await candidates(), [otherMember]);
    await db.query('DELETE FROM approval_rule_steps WHERE id<>$1', [ruleStep]);
    await db.exec("UPDATE app_private.profit_ledger_payouts SET maker_kind='CUSTODIAN_FOR_PAYEE'");
    assert.deepEqual(await candidates(), [otherMember]);
    await db.exec("UPDATE app_private.profit_ledger_payouts SET maker_kind='OWNER'; UPDATE approval_requests SET system_source=NULL");
    assert.deepEqual(await candidates(), [otherMember]);
  } finally { await db.close(); }
});
