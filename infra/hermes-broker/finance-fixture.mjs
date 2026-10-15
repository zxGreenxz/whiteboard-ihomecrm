import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fixture, id, USER, ORG, FOREIGN, CONNECTION, SESSION, ASSISTANT } from '../hermes-zalo-router/private-command-fixture.mjs';
import { DOMAIN_READ_CAPABILITIES, DOMAIN_READ_CAPABILITIES_V2 } from './domain-contract.mjs';
export { id, USER, ORG, FOREIGN, CONNECTION, SESSION, ASSISTANT };

// Real Hermes foundation/binding helpers, the real v1 domain file and the
// candidate v2/action/hook files on minimal disposable CRM tables. The CRM
// permission graph (context, authorized_scope_v3, can_v3, can_access_building)
// and the canonical expense writer are fixture ports: they prove Hermes'
// intersection/receipt logic, not the canonical writer, RLS or a live JWT.
export const READS_PATH = 'supabase/migrations/20261015120000_hermes_domain_reads_v2.sql';
export const ACTION_PATH = 'supabase/migrations/20261015120100_hermes_expense_create_action_v1.sql';
export const HOOK_PATH = 'supabase/migrations/20261015120200_hermes_finance_capabilities_hook.sql';
export const BUILDING = id('a'), OTHER_BUILDING = id('b'), ROOM = id('c'), OTHER_ROOM = id('e'), ITEM = id('f'), SCOPE = id('0');
export const CASHBOOK = id('9'), FOREIGN_CASHBOOK = id('8'), CATEGORY = id('7'), RESTRICTED_CATEGORY = id('6'), HIDDEN_CATEGORY = id('5');
// An organization-wide CRM scope that this connection did NOT select.
export const UNSELECTED_ORG_SCOPE = '00000000-0000-4000-8000-0000000000a1';
export const token = 'hc_' + 'A'.repeat(43), digest = createHash('sha256').update(token).digest('hex');
export const binding = { connectionId: CONNECTION, tokenDigest: digest, expectedEpoch: 1, expectedPolicyVersion: 1,
  expectedMembershipId: USER, expectedAuthorizationVersion: 1, expectedSessionRevision: 1 };
const source = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
const baseline = readFileSync('supabase/baseline/schema.sql', 'utf8');
const fn = (src, name) => {
  const match = src.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?\\$(?:fn|function)?\\$;`, 'i'));
  assert.ok(match, `function ${name} exists`); return match[0];
};
export const ACTION_KEYS = ['income_expenses.create', 'income_expenses.approve'];
export async function setup(t, { reads = readFileSync(READS_PATH, 'utf8'), action = readFileSync(ACTION_PATH, 'utf8'), hook = null } = {}) {
  const f = await fixture(t, { migrations: ['20261013084000_hermes_private_command_dispatch_v1'] }), { db } = f;
  await db.exec(`CREATE SCHEMA extensions;
    CREATE FUNCTION extensions.digest(value text,algorithm text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$SELECT decode(md5(value)||md5(value),'hex')$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('session_id',current_setting('request.jwt.claim.session',true))$$;
    CREATE TABLE public.fixture_offboarded(user_id uuid PRIMARY KEY);
    CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM public.fixture_offboarded WHERE user_id=auth.uid())$$;
    CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY,organization_id uuid,scope_type text,building_id uuid,area_id uuid,cashbook_id uuid);
    CREATE TABLE public.areas(id uuid PRIMARY KEY,organization_id uuid,name text,deleted_at timestamptz);
    CREATE TABLE public.area_buildings(organization_id uuid,area_id uuid,building_id uuid);
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,name text,is_virtual boolean DEFAULT false,deleted_at timestamptz);
    CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,name text,status text,deleted_at timestamptz);
    CREATE TABLE public.income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,user_id uuid NOT NULL,code text,type text NOT NULL,
      name text NOT NULL,building_id uuid NOT NULL,room_id uuid,account_id uuid,voucher_date date NOT NULL,total_amount numeric(15,2) NOT NULL DEFAULT 0,
      approval_status text NOT NULL DEFAULT 'APPROVED',has_restricted_item boolean NOT NULL DEFAULT false,salary_staff_id uuid,shareholder_id uuid,
      profit_manager_id uuid,payer_name text,receive_bank_account text,notes text,kqkd_amount numeric(15,2) NOT NULL DEFAULT 0,deleted_at timestamptz);
    CREATE TABLE public.invoices(id uuid PRIMARY KEY,organization_id uuid,invoice_number text,status text,building_id uuid,room_id uuid,billing_month text,
      due_date date,total_amount numeric(15,2),paid_amount numeric(15,2) DEFAULT 0,remaining_amount numeric(15,2) GENERATED ALWAYS AS (total_amount-COALESCE(paid_amount,0)) STORED,
      notes text,deleted_at timestamptz);
    CREATE TABLE public.meter_readings(id uuid PRIMARY KEY,organization_id uuid,reading_code text,building_id uuid,room_id uuid,meter_type text,settlement_month text,
      reading_date date,previous_reading numeric(10,2) DEFAULT 0,current_reading numeric(10,2),consumption numeric(10,2) GENERATED ALWAYS AS (current_reading-previous_reading) STORED,
      status text,notes text,meter_image_url text,deleted_at timestamptz);
    CREATE TABLE public.contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,status text,total_deposit numeric,deposit_paid numeric,
      deposit_remaining numeric,deposit_debt_mode text,deleted_at timestamptz);
    CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY,organization_id uuid,type text,name text,archived_at timestamptz,system_only boolean DEFAULT false,
      manual_hidden boolean DEFAULT false,quick_entry_hidden boolean DEFAULT false,is_restricted boolean DEFAULT false,is_deposit boolean DEFAULT false,internal_transfer boolean DEFAULT false);
    CREATE TABLE public.accounts(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,name text,account_number text,is_virtual boolean DEFAULT false,deleted_at timestamptz);
    CREATE TABLE public.cashbook_possession_bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,cashbook_id uuid,membership_id uuid,possession_kind text,valid_to timestamptz);
    CREATE TABLE public.authorization_audit_events(id uuid,organization_id uuid,occurred_at timestamptz,actor_user_id uuid,actor_membership_id uuid,event_type text,
      resource_type text,resource_id uuid,old_state jsonb,new_state jsonb,reason text,prev_hash text,event_hash text);
    CREATE TABLE public.fixture_acl(permission text PRIMARY KEY,allowed boolean DEFAULT true,org_wide boolean DEFAULT false,building_ids uuid[]);
    CREATE TABLE public.fixture_building_access(building_id uuid PRIMARY KEY);
    CREATE TABLE public.fixture_approvers(building_id uuid PRIMARY KEY);
    CREATE TABLE public.fixture_writer(threshold numeric,rejected_message text);
    CREATE TABLE public.fixture_canonical_ops(idempotency_key text PRIMARY KEY,actor uuid,payload_hash text,voucher_id uuid);
    INSERT INTO public.fixture_writer VALUES(null,null);
    CREATE FUNCTION app_private.authorized_scope_v3(p_permission text,p_org uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[])
      LANGUAGE sql AS $$SELECT org_wide,building_ids,'{}'::uuid[] FROM public.fixture_acl WHERE permission=p_permission AND allowed AND p_org='${ORG}'::uuid$$;
    CREATE FUNCTION public.get_authorization_context_v1(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object(
      'organizationId',p_org,'isOffboarded',false,'membershipId','${USER}','authorizationVersion',o.authorization_version,
      'permissions',(SELECT jsonb_object_agg(permission,allowed) FROM public.fixture_acl)) FROM public.organizations o WHERE o.id=p_org$$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM public.fixture_building_access WHERE building_id=$1)$$;
    CREATE FUNCTION app_private.can_v3(p_permission_key text,p_building uuid DEFAULT NULL,p_cashbook uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql
      AS $$SELECT p_permission_key='income_expenses.approve' AND EXISTS(SELECT 1 FROM public.fixture_approvers WHERE building_id=p_building)$$;`);
  // Canonical writer port: same signature/return type, the writer's own building,
  // cashbook possession, idempotency (23505 on changed payload) and birth ladder
  // (maker approve permission -> APPROVED, threshold -> UNAPPROVED). Spend engine,
  // canary, lock date, triggers and postings are NOT represented here.
  await db.exec(`CREATE FUNCTION public.create_income_expense_v1(p_type text,p_name text,p_building_id uuid,p_room_id uuid,p_tenant_id uuid,p_contract_id uuid,
    p_payer_name text,p_receive_bank_account text,p_receive_bank_name text,p_account_id uuid,p_attachments jsonb,p_business_result_accounting boolean,p_notes text,
    p_voucher_date date,p_items jsonb,p_idempotency_key text) RETURNS public.income_expenses LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $w$
    DECLARE v_org uuid; v_row public.income_expenses; v_total numeric; v_hash text; v_op public.fixture_canonical_ops; v_threshold numeric; v_reject text;
    BEGIN
      IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
      SELECT organization_id INTO v_org FROM public.buildings WHERE id=p_building_id AND deleted_at IS NULL;
      IF v_org IS NULL OR NOT EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission='income_expenses.create' AND allowed AND (org_wide OR p_building_id=ANY(building_ids)))
        THEN RAISE EXCEPTION 'Không có quyền tạo phiếu thu/chi cho toà này' USING ERRCODE='42501'; END IF;
      IF p_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=p_account_id AND a.organization_id=v_org AND (a.user_id=auth.uid()
        OR EXISTS(SELECT 1 FROM public.cashbook_possession_bindings b WHERE b.cashbook_id=a.id AND b.valid_to IS NULL AND b.possession_kind IN ('CUSTODIAN','OPERATOR'))))
        THEN RAISE EXCEPTION 'Không có quyền sử dụng sổ quỹ này' USING ERRCODE='42501'; END IF;
      SELECT rejected_message,threshold INTO v_reject,v_threshold FROM public.fixture_writer;
      IF v_reject IS NOT NULL THEN RAISE EXCEPTION '%',v_reject; END IF;
      SELECT COALESCE(sum((it->>'quantity')::numeric*(it->>'unit_price')::numeric),0) INTO v_total FROM jsonb_array_elements(p_items) it;
      v_hash:=md5(jsonb_build_array(p_type,p_name,p_building_id,p_room_id,p_account_id,p_voucher_date,p_items,p_payer_name)::text);
      SELECT * INTO v_op FROM public.fixture_canonical_ops WHERE idempotency_key=p_idempotency_key AND actor=auth.uid();
      IF FOUND THEN
        IF v_op.payload_hash<>v_hash THEN RAISE EXCEPTION 'idempotency_key đã được dùng với payload khác' USING ERRCODE='23505'; END IF;
        SELECT * INTO v_row FROM public.income_expenses WHERE id=v_op.voucher_id; RETURN v_row;
      END IF;
      INSERT INTO public.income_expenses(organization_id,user_id,code,type,name,building_id,room_id,account_id,voucher_date,total_amount,approval_status,payer_name,kqkd_amount)
        VALUES(v_org,auth.uid(),'PC-'||substr(md5(p_idempotency_key),1,6),p_type,p_name,p_building_id,p_room_id,p_account_id,p_voucher_date,v_total,
          CASE WHEN app_private.can_v3('income_expenses.approve',p_building_id) THEN 'APPROVED'
            WHEN v_threshold IS NOT NULL AND v_total>=v_threshold THEN 'UNAPPROVED' ELSE 'APPROVED' END,p_payer_name,v_total) RETURNING * INTO v_row;
      INSERT INTO public.fixture_canonical_ops VALUES(p_idempotency_key,auth.uid(),v_hash,v_row.id);
      RETURN v_row;
    END $w$;`);
  await db.exec(fn(baseline, 'public.get_held_deposit_summary'));
  await db.exec(fn(baseline, 'public.fa_monthly_pnl'));
  await db.exec(fn(source('20260725180000_authz_audit_append_helper'), 'app_private.append_authz_audit_v1'));
  const forward = source('20261014000503_hermes_optional_org_policy_v1');
  for (const name of ['app_private.hermes_effective_org_policy_v1', 'app_private.hermes_private_command_connection_v1', 'app_private.hermes_session_gate_v1', 'app_private.hermes_store_read_connection_v1'])
    await db.exec(fn(forward, name));
  await db.exec(source('20261014081902_hermes_domain_reads_v1'));
  // Each candidate file runs twice: forward files must be idempotent.
  for (const sql of [reads, action, ...(hook ? [hook] : [])]) { await db.exec(sql); await db.exec(sql); }
  const disabled = (await db.query("SELECT count(*)::int n FROM app_private.hermes_capabilities WHERE capability=ANY($1) AND enabled", [[...DOMAIN_READ_CAPABILITIES_V2, ...ACTION_KEYS]])).rows[0].n;
  assert.equal(disabled, 0, 'new capabilities start disabled');
  await db.exec(`INSERT INTO public.buildings VALUES('${BUILDING}','${ORG}','Toà A',false,null),('${OTHER_BUILDING}','${ORG}','Toà B',false,null),('${FOREIGN}','${FOREIGN}','Ngoài',false,null);
    INSERT INTO public.rooms VALUES('${ROOM}','${ORG}','${BUILDING}','P101','OCCUPIED',null),('${OTHER_ROOM}','${ORG}','${OTHER_BUILDING}','P201','AVAILABLE',null);
    INSERT INTO public.authorization_scopes VALUES('${SCOPE}','${ORG}','BUILDING','${BUILDING}',null,null),
      ('${UNSELECTED_ORG_SCOPE}','${ORG}','ORGANIZATION',null,null,null);
    INSERT INTO public.fixture_building_access VALUES('${BUILDING}'),('${OTHER_BUILDING}');
    INSERT INTO public.income_expense_types(id,organization_id,type,name,is_restricted,quick_entry_hidden) VALUES
      ('${CATEGORY}','${ORG}','expense','Sửa chữa',false,false),('${RESTRICTED_CATEGORY}','${ORG}','expense','Lương',true,false),('${HIDDEN_CATEGORY}','${ORG}','expense','Ẩn',false,true);
    INSERT INTO public.accounts VALUES('${CASHBOOK}','${ORG}','${USER}','Quỹ VCB 0123456789','0123456789',false,null),
      ('${FOREIGN_CASHBOOK}','${ORG}','${FOREIGN}','Quỹ người khác','999',false,null);`);
  for (const key of [...DOMAIN_READ_CAPABILITIES, ...DOMAIN_READ_CAPABILITIES_V2, ...ACTION_KEYS])
    await db.query('INSERT INTO public.fixture_acl(permission,building_ids) VALUES($1,$2) ON CONFLICT DO NOTHING', [key, [BUILDING, OTHER_BUILDING]]);
  const reads2 = ['invoices.view', ...DOMAIN_READ_CAPABILITIES_V2];
  await db.query('UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability=ANY($1)', [[...reads2, 'income_expenses.create']]);
  await db.query('UPDATE app_private.hermes_org_policies SET read_capabilities=$1,action_capabilities=$2,scope_ids=$3', [reads2, ['income_expenses.create'], [SCOPE]]);
  await db.query('UPDATE app_private.hermes_connections SET read_capabilities=$1,action_capabilities=$2,scope_ids=$3', [reads2, ['income_expenses.create'], [SCOPE]]);
  await db.query('UPDATE app_private.hermes_connection_tokens SET token_digest=$1', [digest]);
  async function call(sql, args, { role = 'authenticated', actor = USER, session = SESSION } = {}) {
    await db.exec('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.session',$3,true)",
      [role === 'postgres' ? 'authenticated' : role, actor, session]);
    if (role !== 'postgres') await db.exec(`SET LOCAL ROLE ${role}`);
    try { const result = (await db.query(sql, args)).rows[0].result; await db.exec('COMMIT'); return result; }
    catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); }
  }
  const read = (domain, input, b = binding, options) => call('SELECT public.hermes_domain_read_v2($1::jsonb,$2::text,$3::jsonb) result', [JSON.stringify(b), domain, JSON.stringify(input)], options);
  const expense = (operation, input, b = binding, options) => call('SELECT public.hermes_expense_action_v1($1::jsonb,$2::text,$3::jsonb) result', [JSON.stringify(b), operation, JSON.stringify(input)], options);
  const counts = async () => (await db.query(`SELECT (SELECT count(*)::int FROM public.income_expenses WHERE code LIKE 'PC-%') vouchers,
    (SELECT count(*)::int FROM app_private.hermes_expense_create_receipts) receipts,(SELECT count(*)::int FROM public.authorization_audit_events) audits`)).rows[0];
  return { ...f, db, call, read, expense, counts };
}
