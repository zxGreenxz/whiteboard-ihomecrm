import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const org=uuid(100), actor=uuid(101), building=uuid(102), room=uuid(103);
/** Real feature SQL, minimal unrelated domain tables. Canonical legacy voucher
 * boundary is a transactional adapter fixture; actual posting proof is TEST-only. */
export async function setupPayoutDb(db: PGlite, migration: string) {
 await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
 CREATE SCHEMA auth; CREATE SCHEMA app_private;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('${actor}'),('${uuid(104)}');
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT COALESCE(nullif(current_setting('test.actor',true),''),'${actor}')::uuid $$;
 CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${org}'::uuid] $$;
 CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
 CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
 CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${building}'::uuid $$;
 CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql STABLE AS $$ SELECT false,CASE WHEN current_setting('test.deny',true) IS DISTINCT FROM 'yes' THEN ARRAY['${building}'::uuid] ELSE '{}'::uuid[] END,'{}'::uuid[] $$;
 CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN;END $$;
 CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$ SELECT $2='${org}'::uuid AND $4='${building}'::uuid AND current_setting('test.deny',true) IS DISTINCT FROM 'yes' $$;
 CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text);INSERT INTO public.organizations VALUES('${org}','ACTIVE');
 CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz,status text,is_virtual boolean);INSERT INTO public.buildings VALUES('${building}','${org}',NULL,'ACTIVE',false);
 CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,deleted_at timestamptz);INSERT INTO public.rooms VALUES('${room}','${org}','${building}',NULL);
 CREATE TABLE public.contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,start_date date,end_date date,discounts jsonb,status text,deleted_at timestamptz,UNIQUE(organization_id,id));
 CREATE TABLE public.contract_drafts(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,payload jsonb,revision integer);
 CREATE TABLE public.profiles(id uuid PRIMARY KEY,full_name text,is_active boolean);INSERT INTO public.profiles VALUES('${actor}','Operator',true),('${uuid(104)}','Retry operator',true);
 CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,status text,valid_from timestamptz,valid_to timestamptz,revoked_at timestamptz);
 CREATE TABLE public.income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text,organization_id uuid,contract_id uuid,commission_kind text,type text,deleted_at timestamptz,approval_status text,account_id uuid,voucher_date date,total_amount numeric,UNIQUE(organization_id,id));
 CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),income_expense_id uuid,amount numeric);
 CREATE TABLE public.accounts(id uuid PRIMARY KEY,organization_id uuid,is_virtual boolean,deleted_at timestamptz,user_id uuid);
 CREATE TABLE public.income_expense_postings(id uuid PRIMARY KEY,organization_id uuid,voucher_id uuid,posting_subject_kind text,posting_subject_id uuid,event_kind text,reversal_of_id uuid,net_cash_effect numeric,account_id uuid,direction text);
 CREATE TABLE public.income_expense_posting_lines(id uuid PRIMARY KEY,organization_id uuid,posting_id uuid,account_id uuid,signed_amount numeric);
 CREATE TABLE app_private.sale_bonus_claims(id uuid PRIMARY KEY,organization_id uuid,deposit_voucher_id uuid,contract_id uuid,bonus_voucher_id uuid,amount numeric);
 CREATE TABLE app_private.commission_manager_links(voucher_id uuid PRIMARY KEY,organization_id uuid,manager_id uuid);
 CREATE TABLE app_private.salary_commission_inclusions(voucher_id uuid,organization_id uuid,staff_id uuid,period_month date);
 CREATE TABLE public.manager_salary_config(organization_id uuid,staff_id uuid,is_active boolean);
 CREATE TABLE public.salary_monthly(organization_id uuid,staff_id uuid,period_month date,status text);
 CREATE TABLE public.salary_earning_consumptions(organization_id uuid,source_id uuid,consumption_state text);
 CREATE TABLE public.cashbook_possession_bindings(organization_id uuid,cashbook_id uuid,membership_id uuid,valid_to timestamptz,possession_kind text);
 CREATE FUNCTION app_private.ie_supplement_can_read_v1(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.deny',true) IS DISTINCT FROM 'yes' $$;
 CREATE FUNCTION app_private.finance_v2_is_cashbook_period_open(uuid,uuid,date) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
 CREATE FUNCTION app_private.sale_bonus_cap_for_v1(uuid,uuid,date) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT NULL::numeric $$;
 CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql STABLE AS $$ SELECT '2026-09-30'::date $$;
 CREATE FUNCTION app_private.commission_autopay_check_v1(uuid,numeric) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('verdict',CASE WHEN $2=3000000 THEN 'VALID' ELSE 'INVALID' END) $$;
 CREATE FUNCTION app_private.authorize_commission_request_v1(uuid,uuid) RETURNS uuid LANGUAGE plpgsql VOLATILE AS $$ BEGIN
 IF $1 IS DISTINCT FROM '${org}'::uuid OR current_setting('test.deny',true)='yes' OR NOT EXISTS(SELECT 1 FROM public.contracts WHERE id=$2 AND organization_id=$1) THEN RAISE EXCEPTION 'Denied' USING ERRCODE='42501';END IF;RETURN '${building}'::uuid;END $$;
 CREATE TABLE public.contract_commission_requests(organization_id uuid,contract_id uuid,kind text,request_id uuid,payload jsonb,actor_id uuid,created_at timestamptz DEFAULT clock_timestamp(),completed_at timestamptz,result jsonb,PRIMARY KEY(organization_id,contract_id,kind,request_id));
 CREATE TABLE public.contract_commission_events(id uuid DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,building_id uuid,kind text,action text,request_id uuid,amount numeric,reason text,actor_id uuid,actor_name text,created_at timestamptz DEFAULT clock_timestamp(),UNIQUE(organization_id,contract_id,kind,request_id,action));
 CREATE FUNCTION public.create_commission_voucher(p_contract_id uuid,p_kind text,p_amount numeric,p_voucher_date date,p_account_id uuid DEFAULT NULL,p_payer_name text DEFAULT NULL,p_recipient_name text DEFAULT NULL,p_recipient_bank text DEFAULT NULL,p_recipient_account text DEFAULT NULL,p_item_description text DEFAULT NULL,p_attachments jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE v uuid;v_chk jsonb; BEGIN
 IF p_kind='broker' AND current_setting('test.fail_broker',true)='yes' THEN RAISE EXCEPTION 'Forced second source failure';END IF;
 v_chk := app_private.commission_autopay_check_v1(p_contract_id, p_amount);
 INSERT INTO public.income_expenses(organization_id,contract_id,commission_kind,type,approval_status,account_id,voucher_date,total_amount,code) VALUES('${org}',p_contract_id,p_kind,'EXPENSE','UNAPPROVED',p_account_id,p_voucher_date,p_amount,'LOCAL') RETURNING id INTO v;
 INSERT INTO public.income_expense_items(income_expense_id,amount) VALUES(v,p_amount);RETURN jsonb_build_object('id',v,'code','LOCAL');END $$;
 CREATE FUNCTION public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
 CREATE FUNCTION public.prepare_commission_requests_v1(uuid,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '[]'::jsonb $$;
 CREATE FUNCTION public.execute_commission_request_v1(uuid,uuid,text,uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
 ALTER TABLE public.contracts ADD COLUMN contract_number text;
 ALTER TABLE public.buildings ADD COLUMN name text;
 ALTER TABLE public.rooms ADD COLUMN name text;
 ALTER TABLE public.income_expenses ADD COLUMN created_at timestamptz DEFAULT clock_timestamp();
 ALTER TABLE public.income_expenses ADD COLUMN commission_legacy_dup boolean DEFAULT false;
 ALTER TABLE public.contract_commission_events ADD COLUMN event_order bigint GENERATED ALWAYS AS IDENTITY;
 CREATE FUNCTION app_private.contract_commission_latest_event_v1(uuid,uuid,text) RETURNS SETOF public.contract_commission_events LANGUAGE sql STABLE AS $$ SELECT * FROM public.contract_commission_events WHERE organization_id=$1 AND contract_id=$2 AND kind=$3 ORDER BY event_order DESC LIMIT 1 $$;
 CREATE FUNCTION public.ie_all_buildings_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
 CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
 `);
 await db.exec(readFileSync('supabase/migrations/20260929151043_contract_rent_support_plans.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260929154150_contract_rent_support_draft_privacy.sql','utf8').split('-- Private versioned funding input')[0]);
 const task5=readFileSync('supabase/migrations/20260930085304_rent_support_payout_sources.sql','utf8');
 // Install the final Task5 definition directly: historical drift guard expects
 // the live invoice migration, outside this isolated payout fixture's scope.
 await db.exec(task5.split('-- Public quote integration')[0]);
 await db.exec(task5.slice(task5.indexOf('CREATE OR REPLACE FUNCTION public.quote_contract_rent_support_v1')));
 const hotfix=readFileSync('supabase/migrations/20260929154941_commission_failure_retry.sql','utf8');
 await db.exec(hotfix.slice(hotfix.indexOf('CREATE OR REPLACE FUNCTION public.list_contract_commission_followups_v2'),hotfix.indexOf('CREATE OR REPLACE FUNCTION public.list_contract_commission_followups_v1')));
 const bonus=readFileSync('supabase/migrations/20260801020000_sale_bonus_from_deposit.sql','utf8');
 const bonusStart=bonus.indexOf('CREATE OR REPLACE FUNCTION public.sale_bonus_status_v1');
 await db.exec(bonus.slice(bonusStart,bonus.indexOf('$fn$;',bonusStart)+6));
 await db.exec(readFileSync(migration,'utf8'));
 // Local feature proof only. Committed migration leaves the global flag false.
 await db.exec(`CREATE OR REPLACE FUNCTION app_private.rent_support_writers_enabled_v1() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`);
}
