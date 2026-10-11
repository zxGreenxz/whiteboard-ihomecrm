import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { differenceInMonths } from 'date-fns';

const path='supabase/migrations/20261011074456_commission_reason_audit_flow.sql';
const originalSql=readFileSync(path,'utf8');
const mutation=process.env.COMMISSION_REASON_MUTATION;
const anchor=mutation==='skip_reason'
 ? "IF (p_required AND (r IS NULL OR length(r)<8)) OR length(r)>2000 THEN"
 : mutation==='skip_support_basis' ? "IF NOT FOUND OR saved.baseline IS DISTINCT FROM app_private.commission_baseline_v1(o.contract_id,k,(i->>'gross_amount')::numeric) THEN"
 : "IF auth.uid() IS NULL OR NOT COALESCE(app_private.ie_supplement_can_read_v1(p_voucher_id),false) THEN RAISE EXCEPTION 'Không có quyền xem lịch sử hoa hồng'";
if(mutation&&(!['skip_reason','skip_read_scope','skip_support_basis'].includes(mutation)||originalSql.split(anchor).length!==2))throw new Error('Unknown mutation or changed invariant anchor');
// Opt-in mutation executes the altered real SQL in a disposable DB. CI runs the
// unchanged migration; no source or deployment artifact is edited by this probe.
const sql=!mutation?originalSql:originalSql.replace(anchor,mutation!=='skip_read_scope'?"IF false THEN":"IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Không có quyền xem lịch sử hoa hồng'");
const db=new PGlite();
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),actor=id(2),building=id(3),room=id(4),contract=id(5),type=id(6),other=id(7);
const reason='Điều chỉnh theo thỏa thuận đã xác nhận';
type Event={stage:string;reason:string|null;actor_id:string;actor_name:string;at:string;baseline:Record<string,unknown>|null;before:Record<string,unknown>|null;after:Record<string,unknown>|null};

beforeAll(async()=>{
 await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA app_private;CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
 CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.super',true)='yes' $$;
 CREATE TABLE profiles(id uuid PRIMARY KEY,full_name text);INSERT INTO profiles VALUES('${actor}','Người nhập'),('${other}','Người khác');
 CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,commission_tiers jsonb,deleted_at timestamptz);
 INSERT INTO buildings VALUES('${building}','${org}','[{"min_months":5,"max_months":6,"rate_percent":50},{"min_months":10,"max_months":12,"rate_percent":60}]',NULL);
 CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid);INSERT INTO rooms VALUES('${room}','${org}','${building}');
 CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,start_date date,end_date date,rent_price numeric,deleted_at timestamptz);
 INSERT INTO contracts VALUES('${contract}','${org}','${room}','2026-01-01','2026-11-30',2000000,NULL);
 ALTER TABLE buildings ADD COLUMN name text DEFAULT 'Tòa nhà kiểm tra';ALTER TABLE rooms ADD COLUMN name text DEFAULT 'Phòng kiểm tra';
 ALTER TABLE contracts ADD COLUMN contract_number text DEFAULT 'HĐ kiểm tra';CREATE TABLE accounts(id uuid PRIMARY KEY,name text);
 CREATE TABLE income_expense_types(id uuid PRIMARY KEY,category text,name text);INSERT INTO income_expense_types VALUES('${type}','commission','Hoa hồng môi giới');
 CREATE TABLE income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,building_id uuid,commission_kind text,system_source text,
 total_amount numeric DEFAULT 0,approval_status text DEFAULT 'UNAPPROVED',posting_status text DEFAULT 'UNPOSTED',account_id uuid,notes text,attachments jsonb DEFAULT '[]',
 deleted_at timestamptz,approval_version bigint DEFAULT 1,code text DEFAULT 'FIXTURE',user_id uuid,payer_name text,review_reason text);
 CREATE TABLE income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),income_expense_id uuid,income_expense_type_id uuid,organization_id uuid,unit_price numeric,quantity numeric,description text);
 CREATE TABLE contract_commission_requests(organization_id uuid,contract_id uuid,kind text,request_id uuid,payload jsonb,actor_id uuid,created_at timestamptz DEFAULT clock_timestamp(),completed_at timestamptz,result jsonb,PRIMARY KEY(organization_id,contract_id,kind,request_id));
 CREATE TABLE contract_commission_events(organization_id uuid,contract_id uuid,building_id uuid,kind text,action text,request_id uuid,amount numeric,reason text,actor_id uuid,actor_name text,UNIQUE(organization_id,contract_id,kind,request_id,action));
 CREATE TABLE app_private.commission_manager_links(voucher_id uuid PRIMARY KEY,organization_id uuid,manager_id uuid,request_key text,updated_by uuid);
 CREATE TABLE app_private.rent_support_payout_authorizations(organization_id uuid,contract_id uuid,kind text,operation_id uuid,gross numeric,net numeric,xid xid8,backend_pid integer);
 CREATE TABLE app_private.rent_support_funding_operations(id uuid,organization_id uuid,payload jsonb,contract_id uuid,state text DEFAULT 'READY',result jsonb,net_amount numeric DEFAULT 0);
 CREATE TABLE app_private.rent_support_payout_request_links(organization_id uuid,operation_id uuid,contract_id uuid,kind text,request_id uuid);
 CREATE TABLE app_private.rent_support_payout_executions(organization_id uuid,operation_id uuid,executor_id uuid,outcome text,reason text);
 CREATE TABLE app_private.rent_support_payout_sources(id uuid,organization_id uuid,kind text);
 CREATE TABLE app_private.rent_support_payout_results(organization_id uuid,operation_id uuid,source_id uuid,gross numeric,withheld numeric,net numeric,voucher_id uuid,status text);
 CREATE TABLE app_private.commission_tier_versions(id uuid DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,effective_from_month date,note text,status text,retired_at timestamptz,rate_percent numeric);
 CREATE TABLE app_private.sale_bonus_cap_versions(LIKE app_private.commission_tier_versions INCLUDING DEFAULTS);
 CREATE FUNCTION app_private.ie_has_commission_item_v1(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM income_expense_items i JOIN income_expense_types t ON t.id=i.income_expense_type_id WHERE i.income_expense_id=$1 AND t.category='commission')$$;
 CREATE FUNCTION app_private.ie_supplement_can_read_v1(uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT auth.uid()='${actor}' AND EXISTS(SELECT 1 FROM income_expenses WHERE id=$1 AND organization_id='${org}' AND building_id='${building}')$$;
 CREATE FUNCTION app_private.authorize_commission_request_v1(uuid,uuid) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$BEGIN IF auth.uid() IS DISTINCT FROM '${actor}'::uuid OR $1<>'${org}' OR $2<>'${contract}' THEN RAISE EXCEPTION 'Denied' USING ERRCODE='42501';END IF;RETURN '${building}';END$$;
 CREATE FUNCTION app_private.rent_support_payout_lock_v1(uuid,uuid) RETURNS uuid LANGUAGE sql AS $$SELECT app_private.authorize_commission_request_v1($1,$2)$$;
 CREATE FUNCTION app_private.contract_commission_live_voucher_v1(uuid,uuid,text) RETURNS TABLE(id uuid,code text) LANGUAGE sql STABLE AS $$SELECT id,code FROM income_expenses WHERE organization_id=$1 AND contract_id=$2 AND commission_kind=$3 AND approval_status<>'CANCELLED' AND deleted_at IS NULL LIMIT 1$$;
 CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[]) LANGUAGE sql STABLE AS $$SELECT current_setting('test.finance_wide',true)='yes',CASE WHEN current_setting('test.finance_read',true)='no' THEN ARRAY[]::uuid[] ELSE ARRAY['${building}'::uuid] END$$;
 CREATE FUNCTION public.list_contract_commission_followups_v2(p_organization_id uuid,p_contract_ids uuid[] DEFAULT NULL,p_building_ids uuid[] DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 50,p_unresolved_only boolean DEFAULT false,p_kind text DEFAULT NULL,p_search text DEFAULT NULL,p_period_from date DEFAULT NULL,p_period_to date DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$BEGIN
 IF p_organization_id<>'${org}' THEN RAISE EXCEPTION 'Denied' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(jsonb_build_object('contract_id',contract_id,'building_id','${building}','kind',kind,'request_id',request_id,'can_manage',true,'state','PENDING','voucher_id',NULL)) FROM contract_commission_requests WHERE organization_id=p_organization_id),'[]'::jsonb),'total',1);END$$;
 CREATE FUNCTION public.create_commission_voucher(p_contract_id uuid,p_kind text,p_amount numeric,p_voucher_date date,p_account_id uuid DEFAULT NULL,p_payer_name text DEFAULT NULL,p_recipient_name text DEFAULT NULL,p_recipient_bank text DEFAULT NULL,p_recipient_account text DEFAULT NULL,p_item_description text DEFAULT NULL,p_attachments jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
 DECLARE v uuid;BEGIN PERFORM app_private.authorize_commission_request_v1('${org}',p_contract_id);
 INSERT INTO income_expenses(organization_id,contract_id,building_id,commission_kind,system_source,total_amount,user_id,attachments) VALUES('${org}',p_contract_id,'${building}',p_kind,'contract.commission',p_amount,auth.uid(),p_attachments) RETURNING id INTO v;
 INSERT INTO income_expense_items(income_expense_id,income_expense_type_id,organization_id,unit_price,quantity) VALUES(v,'${type}','${org}',p_amount,1);
 RETURN jsonb_build_object('id',v,'code','FIXTURE');END$$;
 CREATE FUNCTION public.prepare_commission_requests_v1(p_organization_id uuid,p_intents jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$DECLARE i jsonb;old contract_commission_requests;BEGIN
 FOR i IN SELECT value FROM jsonb_array_elements(p_intents) LOOP
 IF i?'commission_reason' THEN RAISE EXCEPTION 'Old parser rejects unknown field';END IF;
 PERFORM app_private.authorize_commission_request_v1(p_organization_id,(i->>'contract_id')::uuid);
 SELECT * INTO old FROM contract_commission_requests WHERE request_id=(i->>'request_id')::uuid;
 IF FOUND THEN IF old.payload IS DISTINCT FROM (i-'request_id') THEN RAISE EXCEPTION 'Intent conflict' USING ERRCODE='PT409';END IF;
 ELSE INSERT INTO contract_commission_requests VALUES(p_organization_id,(i->>'contract_id')::uuid,i->>'kind',(i->>'request_id')::uuid,i-'request_id',auth.uid(),clock_timestamp(),NULL,NULL);END IF;END LOOP;RETURN p_intents;END$$;
 CREATE FUNCTION public.execute_commission_request_v1(p_organization_id uuid,p_contract_id uuid,p_kind text,p_request_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$DECLARE q contract_commission_requests;r jsonb;op uuid;BEGIN
 SELECT operation_id INTO op FROM app_private.rent_support_payout_request_links WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind=p_kind AND request_id=p_request_id;
 IF op IS NOT NULL THEN r:=public.execute_contract_payout_operation_v1(p_organization_id,op);IF r->>'status'='FAILED' THEN RETURN r;END IF;RETURN(SELECT value FROM jsonb_array_elements(r->'sources') WHERE value->>'kind'=p_kind);END IF;
 SELECT * INTO q FROM contract_commission_requests WHERE request_id=p_request_id FOR UPDATE;IF q.completed_at IS NOT NULL THEN RETURN q.result;END IF;
 r:=public.create_commission_voucher(p_contract_id,p_kind,(q.payload->>'amount')::numeric,'2026-01-01')||'{"status":"COMPLETED"}'::jsonb;
 UPDATE contract_commission_requests SET completed_at=clock_timestamp(),result=r WHERE request_id=p_request_id;RETURN r;END$$;
 CREATE FUNCTION public.revise_pending_income_expense_v1(p_voucher uuid,p_expected_approval_version bigint,p_patch jsonb,p_items jsonb DEFAULT NULL,p_reason text DEFAULT NULL,p_idempotency_key text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN
 IF NOT app_private.ie_supplement_can_read_v1(p_voucher) THEN RAISE EXCEPTION 'Denied' USING ERRCODE='42501';END IF;
 UPDATE income_expenses SET payer_name=COALESCE(p_patch->>'payer_name',payer_name),account_id=COALESCE((p_patch->>'account_id')::uuid,account_id),total_amount=COALESCE((p_patch->>'total_amount')::numeric,total_amount),approval_version=approval_version+1 WHERE id=p_voucher AND approval_version=p_expected_approval_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'Stale' USING ERRCODE='PT409';END IF;RETURN jsonb_build_object('id',p_voucher);END$$;
 CREATE FUNCTION public.cancel_income_expense_flex_v1(p_voucher uuid,p_reason text,p_expected_approval_version bigint DEFAULT NULL,p_expected_posting_version bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN UPDATE income_expenses SET approval_status='CANCELLED' WHERE id=p_voucher;RETURN jsonb_build_object('id',p_voucher);END$$;
 CREATE FUNCTION public.cancel_income_expense_v1(p_voucher_id uuid,p_reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN UPDATE income_expenses SET approval_status='CANCELLED' WHERE id=p_voucher_id;END$$;
 CREATE FUNCTION public.cancel_unposted_income_expense_v2(p_voucher uuid,p_expected_review_version bigint,p_expected_approval_version bigint,p_reason text,p_idempotency_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN RETURN public.cancel_income_expense_flex_v1(p_voucher,p_reason);END$$;
 CREATE FUNCTION public.ie_compat_cancel_v2(p_ids uuid[],p_reason text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN UPDATE income_expenses SET approval_status='CANCELLED' WHERE id=ANY(p_ids);RETURN '{}'::jsonb;END$$;
 CREATE FUNCTION public.reverse_posted_income_expense_v2(p_voucher uuid,p_cashbook uuid,p_posted_on date,p_reason text,p_idempotency_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN UPDATE income_expenses SET posting_status='REVERSED' WHERE id=p_voucher;RETURN '{}'::jsonb;END$$;
 CREATE FUNCTION public.renew_contract(p_contract_id uuid,p_new_end_date date,p_new_rent_price numeric DEFAULT NULL,p_new_deposit numeric DEFAULT NULL,p_notes text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN UPDATE contracts SET end_date=p_new_end_date WHERE id=p_contract_id;RETURN p_contract_id;END$$;
 CREATE FUNCTION public.transfer_room(p_contract_id uuid,p_new_room_id uuid,p_new_rent_price numeric DEFAULT NULL,p_transfer_date date DEFAULT CURRENT_DATE,p_notes text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN UPDATE contracts SET room_id=p_new_room_id,rent_price=COALESCE(p_new_rent_price,rent_price) WHERE id=p_contract_id;RETURN p_contract_id;END$$;
 CREATE FUNCTION public.record_contract_commission_event_v1(p_organization_id uuid,p_contract_id uuid,p_kind text,p_action text,p_request_id uuid,p_amount numeric DEFAULT NULL,p_reason text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('reason',p_reason)$$;
 CREATE FUNCTION public.assign_commission_manager_v1(p_voucher_id uuid,p_manager_id uuid,p_expected_approval_version bigint,p_idempotency_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN INSERT INTO app_private.commission_manager_links VALUES(p_voucher_id,'${org}',p_manager_id,p_idempotency_key,auth.uid()) ON CONFLICT(voucher_id) DO UPDATE SET manager_id=p_manager_id,request_key=p_idempotency_key;RETURN jsonb_build_object('voucher_id',p_voucher_id);END$$;
 CREATE FUNCTION public.annotate_income_expense_v1(p_voucher uuid,p_add_attachments jsonb DEFAULT NULL,p_remove_attachments jsonb DEFAULT NULL,p_notes text DEFAULT NULL,p_note_mode text DEFAULT 'REPLACE',p_idempotency_key text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN UPDATE income_expenses SET notes=p_notes WHERE id=p_voucher;RETURN jsonb_build_object('id',p_voucher,'changed',true);END$$;
 CREATE FUNCTION public.unapprove_voucher(voucher_id uuid,p_expected_approval_version bigint DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN UPDATE income_expenses SET approval_status='UNAPPROVED' WHERE id=voucher_id;END$$;
 CREATE FUNCTION public.restore_income_expense(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN UPDATE income_expenses SET approval_status='APPROVED' WHERE id=p_id;RETURN jsonb_build_object('id',p_id);END$$;
 CREATE FUNCTION app_private.rent_support_payout_context_v1(p jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$BEGIN IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'intents') i WHERE i?'commission_reason') THEN RAISE EXCEPTION 'Unknown field';END IF;RETURN p;END$$;
 CREATE FUNCTION app_private.rent_support_adopt_deposit_v1(p_org uuid,p_operation uuid,p_intent jsonb,p_net numeric,p_before jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN
 IF p_org<>'${org}' OR p_intent->>'proof'<>'verified' THEN RAISE EXCEPTION 'Invalid claim' USING ERRCODE='PT409';END IF;
 UPDATE income_expenses SET contract_id='${contract}',total_amount=p_net WHERE id=(p_intent->>'bonus_voucher_id')::uuid;
 RETURN jsonb_build_object('id',p_intent->>'bonus_voucher_id');END$$;
 CREATE FUNCTION public.prepare_contract_payouts_with_support_v1(p_organization_id uuid,p_contract_id uuid,p_plan_revision bigint,p_quote_hash text,p_payload jsonb,p_request_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN RETURN app_private.rent_support_payout_context_v1(p_payload);END$$;
 CREATE FUNCTION public.execute_contract_payout_operation_v1(p_organization_id uuid,p_operation_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$DECLARE o app_private.rent_support_funding_operations;i jsonb;r jsonb;v jsonb;k text;rows jsonb:='[]';BEGIN
 SELECT * INTO o FROM app_private.rent_support_funding_operations WHERE id=p_operation_id AND organization_id=p_organization_id;
 IF o.state='COMPLETED' THEN RETURN o.result;END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(o.payload->'intents') LOOP
 k:=CASE WHEN i->>'kind'='COMMISSION' THEN 'broker' ELSE 'sale' END;v:=NULL;
 IF COALESCE(i->>'action','ISSUE_NEW')='ISSUE_NEW' THEN
 INSERT INTO app_private.rent_support_payout_sources VALUES((i->>'intent_id')::uuid,p_organization_id,i->>'kind');
 IF o.net_amount>0 THEN INSERT INTO app_private.rent_support_payout_authorizations VALUES(p_organization_id,o.contract_id,k,o.id,(i->>'gross_amount')::numeric,o.net_amount,pg_current_xact_id(),pg_backend_pid());
 v:=public.create_commission_voucher(o.contract_id,k,o.net_amount,'2026-01-01');DELETE FROM app_private.rent_support_payout_authorizations WHERE operation_id=o.id;END IF;
 INSERT INTO app_private.rent_support_payout_results VALUES(p_organization_id,o.id,(i->>'intent_id')::uuid,(i->>'gross_amount')::numeric,(i->>'gross_amount')::numeric-o.net_amount,o.net_amount,(v->>'id')::uuid,CASE WHEN o.net_amount=0 THEN 'SETTLED_BY_SUPPORT' ELSE 'COMPLETED' END);END IF;
 rows:=rows||jsonb_build_array(jsonb_build_object('kind',k,'id',v->>'id','status','COMPLETED'));END LOOP;
 r:=jsonb_build_object('operation_id',o.id,'status','COMPLETED','sources',rows);
 UPDATE app_private.rent_support_funding_operations SET state='COMPLETED',result=r WHERE id=o.id;RETURN r;END$$;
 CREATE FUNCTION public.create_sale_bonus_from_deposit_v1(p_deposit_voucher_id uuid,p_amount numeric,p_recipient text DEFAULT NULL,p_account_number text DEFAULT NULL,p_bank text DEFAULT NULL,p_voucher_date date DEFAULT NULL,p_account_id uuid DEFAULT NULL,p_attachments jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$DECLARE v uuid;BEGIN INSERT INTO income_expenses(organization_id,building_id,commission_kind,system_source,total_amount) VALUES('${org}','${building}','sale','contract.commission',p_amount) RETURNING id INTO v;RETURN jsonb_build_object('voucherId',v);END$$;
 CREATE TABLE contract_transfer_links(new_contract_id uuid,reason text,organization_id uuid,building_id uuid,broker_fee numeric,deposit_base numeric,id uuid);
 CREATE FUNCTION public.create_contract_transfer_commission_v1(p_organization_id uuid,p_link_id uuid,p_expected_version bigint,p_request_id uuid,p_account_id uuid DEFAULT NULL,p_recipient_bank text DEFAULT NULL,p_recipient_account text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$DECLARE l contract_transfer_links;v_result jsonb;BEGIN SELECT * INTO l FROM contract_transfer_links WHERE id=p_link_id;v_result:=public.create_commission_voucher(l.new_contract_id,'broker',l.broker_fee,'2026-01-01');RETURN v_result;END$$;
 GRANT USAGE ON SCHEMA public,app_private,auth TO authenticated,anon,service_role;
 GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
 DO $$DECLARE f record;BEGIN FOR f IN SELECT p.oid::regprocedure sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','app_private') LOOP
 EXECUTE 'ALTER FUNCTION '||f.sig||' SET search_path TO pg_catalog,public,app_private';END LOOP;END$$;
 `);
 // Dependency writers above model only their API boundaries. The entire new
 // migration, triggers, role ACLs, snapshots and adapters execute unmodified twice.
 await db.exec(sql);await db.exec(sql);
},60000);
afterAll(()=>db.close());
async function tx(run:()=>Promise<void>){await db.exec(`BEGIN;SET LOCAL test.actor='${actor}';SET LOCAL ROLE authenticated;`);try{await run();}finally{await db.exec('ROLLBACK');}}
async function denied(run:()=>Promise<unknown>,code='22023'){await db.exec('SAVEPOINT deny');try{await expect(run()).rejects.toMatchObject({code});}finally{await db.exec('ROLLBACK TO SAVEPOINT deny;RELEASE SAVEPOINT deny');}}
async function owner(q:string){await db.exec(`RESET ROLE;${q};SET LOCAL ROLE authenticated;`);}
const intent=(amount=1200000,why:string|null=null,request=id(10),kind='broker')=>({contract_id:contract,request_id:request,kind,amount,voucher_date:'2026-01-01',commission_reason:why});
async function prepare(i= intent()){return db.query('SELECT public.prepare_commission_requests_v1($1,$2)',[org,JSON.stringify([i])]);}
async function execute(request=id(10),kind='broker'){return (await db.query<{r:{id:string;status:string}}>('SELECT public.execute_commission_request_v1($1,$2,$3,$4) r',[org,contract,kind,request])).rows[0].r;}
async function history(v:string){return (await db.query<{r:Event[]}>('SELECT public.read_commission_interventions_v1($1) r',[v])).rows[0].r;}
async function dispatch(v:string,stage:string,why:string|null,payload:Record<string,unknown>){return db.query('SELECT public.intervene_commission_v1($1,$2,$3,$4)',[v,stage,why,JSON.stringify(payload)]);}

describe('server-enforced commission explanations and evidence',()=>{
 it('allows the default and records authoritative configuration, actor, time and creation item',()=>tx(async()=>{
  await prepare();const v=await execute();const events=await history(v.id);
  expect(events.some(e=>e.stage==='CREATE'&&e.baseline?.default_amount===1200000&&e.baseline?.months===10)).toBe(true);
  expect(events.every(e=>e.actor_id===actor&&e.actor_name==='Người nhập'&&Boolean(e.at))).toBe(true);
  expect(events.some(e=>e.after?.unit_price===1200000)).toBe(true);
 }));
 it('requires explicit override reason at prepare and blocks direct writer and direct item bypass',()=>tx(async()=>{
  await denied(()=>prepare(intent(1100000)));
  await denied(()=>db.query("SELECT create_commission_voucher($1,'broker',1100000,'2026-01-01')",[contract]));
  const plain=(await db.query<{id:string}>('INSERT INTO income_expenses(organization_id,building_id) VALUES($1,$2) RETURNING id',[org,building])).rows[0].id;
  await denied(()=>db.query('INSERT INTO income_expense_items(income_expense_id,income_expense_type_id) VALUES($1,$2)',[plain,type]));
  expect(await history(plain)).toEqual([]);
 }));
 it('persists nondefault reason and refuses replay with a changed reason, returns completed receipt unchanged',()=>tx(async()=>{
  await prepare(intent(1100000,reason));await denied(()=>prepare(intent(1100000,'Nội dung khác đã xác nhận')),'PT409');
  const first=await execute();expect((await history(first.id))[0].reason).toBe(reason);
  await db.query("UPDATE buildings SET commission_tiers='[]',commission_change_reason=$1 WHERE id=$2",[reason,building]);
  expect(await execute()).toEqual(first);
 }));
 it('rejects config drift at execution and accepts a fresh explained request without mutating the old',()=>tx(async()=>{
  await prepare();await db.query("UPDATE buildings SET commission_tiers='[]',commission_change_reason=$1 WHERE id=$2",[reason,building]);
  expect(await execute()).toEqual({status:'FAILED',id:null,code:null});
  expect((await db.query<{reason:string}>('SELECT reason FROM contract_commission_events WHERE request_id=$1 AND action=$2',[id(10),'FAILED'])).rows[0].reason).toContain('Cơ sở hoa hồng đã thay đổi');
  expect(await execute()).toEqual({status:'FAILED',id:null,code:null});
  await prepare(intent(1100000,reason,id(11)));const v=await execute(id(11));
  expect((await history(v.id)).some(e=>e.stage==='REPREPARE'&&e.before?.request_id===id(10))).toBe(true);
 }));
 it('requires reason for Sale and no matching broker tier, including old missing-basis requests',()=>tx(async()=>{
  await denied(()=>prepare(intent(400000,null,id(11),'sale')));
  await owner(`UPDATE contracts SET end_date='2026-02-01',commission_change_reason='${reason}' WHERE id='${contract}'`);await denied(()=>prepare(intent()));
  await db.query('INSERT INTO contract_commission_requests(organization_id,contract_id,kind,request_id,payload,actor_id) VALUES($1,$2,$3,$4,$5,$6)',[org,contract,'broker',id(12),'{}',actor]);
  expect(await execute(id(12))).toEqual({status:'FAILED',id:null,code:null});
 }));
 it('requires reason for non-money edits, annotation, manager reroute, cancel and restore; records stage',()=>tx(async()=>{
  await prepare();const v=await execute();
  await denied(()=>db.query("UPDATE income_expenses SET payer_name='Changed' WHERE id=$1",[v.id]));
  await denied(()=>db.query("SELECT public.revise_pending_income_expense_v1($1,1,'{\"payer_name\":\"Changed\"}')",[v.id]));
  await dispatch(v.id,'EDIT_PENDING',reason,{expected_approval_version:1,patch:{payer_name:'Changed'},idempotency_key:'revision'});
  await denied(()=>db.query("SELECT public.annotate_income_expense_v1($1,NULL,NULL,'New note')",[v.id]));
  await dispatch(v.id,'ANNOTATE',reason,{notes:'New note'});
  await denied(()=>db.query('SELECT public.assign_commission_manager_v1($1,$2,NULL,$3)',[v.id,other,'manager-direct']));
  await dispatch(v.id,'ASSIGN_MANAGER',reason,{manager_id:other,idempotency_key:'manager'});
  await denied(()=>db.query('SELECT public.cancel_income_expense_v1($1)',[v.id]));
  await db.query('SELECT public.cancel_income_expense_v1($1,$2)',[v.id,reason]);
  await denied(()=>db.query('SELECT public.restore_income_expense($1)',[v.id]));
  await dispatch(v.id,'RESTORE',reason,{});
  const stages=(await history(v.id)).map(e=>e.stage);expect(stages).toEqual(expect.arrayContaining(['EDIT_PENDING','ANNOTATE','ASSIGN_MANAGER','CANCEL','RESTORE']));
 }));
 it('audits normal approve/post without demanding a fabricated human reason',()=>tx(async()=>{
  await prepare();const v=await execute();await db.query("UPDATE income_expenses SET approval_status='APPROVED' WHERE id=$1",[v.id]);
  await db.query("UPDATE income_expenses SET posting_status='POSTED' WHERE id=$1",[v.id]);
  expect((await history(v.id)).map(e=>e.stage)).toEqual(expect.arrayContaining(['APPROVE','POST']));
  await denied(()=>db.query('SELECT public.unapprove_voucher($1)',[v.id]));await dispatch(v.id,'UNAPPROVE',reason,{});
 }));
 it('records contract basis edits and renewal with entered notes and clears transient reason',()=>tx(async()=>{
  await prepare();const v=await execute();await denied(()=>db.query('UPDATE contracts SET rent_price=2100000 WHERE id=$1',[contract]));
  await db.query('UPDATE contracts SET rent_price=2100000,commission_change_reason=$1 WHERE id=$2',[reason,contract]);
  expect((await db.query<{reason:string|null}>('SELECT commission_change_reason reason FROM contracts WHERE id=$1',[contract])).rows[0].reason).toBeNull();
  await denied(()=>db.query("SELECT renew_contract($1,'2027-01-01')",[contract]));await db.query("SELECT renew_contract($1,'2027-01-01',NULL,NULL,$2)",[contract,reason]);
  expect((await history(v.id)).filter(e=>e.stage==='CONTRACT_CHANGED')).toHaveLength(2);
 }));
 it('keeps all evidence immutable and cannot forge private context or read other actor scope',()=>tx(async()=>{
  await prepare();const v=await execute();await denied(()=>db.query("SELECT app_private.begin_commission_reason_v1($1,NULL,NULL,'EDIT_PENDING','Forged reason')",[v.id]),'42501');
  await denied(()=>db.exec('DELETE FROM app_private.commission_intervention_events'),'42501');
  await owner("SET LOCAL test.actor='"+other+"'");await denied(()=>history(v.id),'42501');await denied(()=>dispatch(v.id,'ANNOTATE',reason,{notes:'hack'}),'42501');
 }));
 it('preserves support v2/v3 reason in hashing payload and enforces publication note',()=>tx(async()=>{
  for(const version of [2,3]){const payload={version,intents:[{intent_id:id(30+version),kind:'COMMISSION',gross_amount:'1200000',commission_reason:reason}]};
   const result=(await db.query<{r:unknown}>('SELECT prepare_contract_payouts_with_support_v1($1,$2,1,$3,$4,$5) r',[org,contract,'hash',JSON.stringify(payload),id(40+version)])).rows[0].r;expect(result).toEqual(payload);}
  await owner('GRANT INSERT ON app_private.commission_tier_versions TO authenticated');
  await denied(()=>db.query("INSERT INTO app_private.commission_tier_versions(organization_id,building_id,effective_from_month,status,rate_percent) VALUES($1,$2,'2026-01-01','PUBLISHED',70)",[org,building]));
  await db.query("INSERT INTO app_private.commission_tier_versions(organization_id,building_id,effective_from_month,status,rate_percent,note) VALUES($1,$2,'2026-01-01','PUBLISHED',70,$3)",[org,building,reason]);
 }));
 it('compares support gross with default, records net withholding separately and accepts deposit Sale only with reason',()=>tx(async()=>{
  await prepare();
  await owner(`INSERT INTO app_private.rent_support_funding_operations(id,organization_id,payload) VALUES('${id(50)}','${org}','{"intents":[{"kind":"COMMISSION","intent_id":"${id(10)}"}]}');
   INSERT INTO app_private.rent_support_payout_authorizations VALUES('${org}','${contract}','broker','${id(50)}',1200000,800000,pg_current_xact_id(),pg_backend_pid())`);
  const v=(await db.query<{r:{id:string}}>("SELECT create_commission_voucher($1,'broker',800000,'2026-01-01') r",[contract])).rows[0].r;
  expect((await history(v.id)).find(e=>e.stage==='CREATE_WITH_SUPPORT')?.baseline).toMatchObject({gross_amount:1200000,withheld_amount:400000,submitted_amount:800000,requires_reason:false});
  const dep=(await db.query<{id:string}>('INSERT INTO income_expenses(organization_id,building_id) VALUES($1,$2) RETURNING id',[org,building])).rows[0].id;
  await denied(()=>db.query('SELECT public.create_sale_bonus_from_deposit_v1($1,300000)',[dep]));
  const sale=(await db.query<{r:{voucherId:string}}>('SELECT public.create_sale_bonus_from_deposit_with_reason_v1($1,300000,$2) r',[dep,reason])).rows[0].r;
  expect((await history(sale.voucherId)).some(e=>e.stage==='CREATE_FROM_DEPOSIT'&&e.reason===reason)).toBe(true);
 }));
 it('cannot remove commission classification or move its item to an ordinary voucher',()=>tx(async()=>{
  await prepare();const v=await execute();
  await denied(()=>db.query('UPDATE income_expenses SET commission_kind=NULL,system_source=NULL WHERE id=$1',[v.id]));
  const plain=(await db.query<{id:string}>('INSERT INTO income_expenses(organization_id,building_id) VALUES($1,$2) RETURNING id',[org,building])).rows[0].id;
  await denied(()=>db.query('UPDATE income_expense_items SET income_expense_id=$1,income_expense_type_id=NULL WHERE income_expense_id=$2',[plain,v.id]));
 }));
 it('cleans all nested contexts before commit and permits the existing restore super-admin scope',()=>tx(async()=>{
  await prepare();const v=await execute();
  await db.exec('SET CONSTRAINTS app_private.commission_reason_context_cleanup IMMEDIATE');
  await owner('GRANT SELECT ON app_private.commission_reason_contexts TO authenticated');
  expect((await db.query('SELECT * FROM app_private.commission_reason_contexts')).rows).toEqual([]);
  await db.exec('SET CONSTRAINTS app_private.commission_reason_context_cleanup DEFERRED');
  await db.query('SELECT public.cancel_income_expense_v1($1,$2)',[v.id,reason]);
  await owner(`SET LOCAL test.actor='${other}';SET LOCAL test.super='yes'`);
  await dispatch(v.id,'RESTORE',reason,{});
  await owner(`SET LOCAL test.actor='${actor}'`);
  expect((await history(v.id)).some(e=>e.stage==='RESTORE'&&e.actor_id===other)).toBe(true);
 }));
 it('requires the human decision reason for marking non-applicable and reopening',()=>tx(async()=>{
  for(const action of ['NOT_APPLICABLE','REOPENED']) await denied(()=>db.query('SELECT record_contract_commission_event_v1($1,$2,$3,$4,$5)',[org,contract,'broker',action,id(99)]));
 }));
 it('shows immutable prepared reason before voucher only in the canonical financial scope',()=>tx(async()=>{
  await prepare(intent(1100000,reason));
  const read=async()=> (await db.query<{r:{rows:Array<{preparation:Record<string,unknown>|null}>}}>('SELECT list_contract_commission_followups_v2($1) r',[org])).rows[0].r.rows[0].preparation;
  expect(await read()).toMatchObject({request_id:id(10),reason,actor_name:'Người nhập',stage:'PREPARE'});
  await owner("SET LOCAL test.finance_read='no'");expect(await read()).toBeNull();
  await owner(`SET LOCAL test.finance_read='yes';SET LOCAL test.actor='${other}'`);expect(await read()).toBeNull();
  await owner("SET LOCAL test.finance_wide='yes'");expect(await read()).toMatchObject({reason});
 }));
 it('validates a fully withheld gross baseline before settlement and preserves completed replay',()=>tx(async()=>{
  await prepare();
  await owner(`INSERT INTO app_private.rent_support_funding_operations(id,organization_id,contract_id,payload) VALUES('${id(60)}','${org}','${contract}','{"intents":[{"kind":"COMMISSION","intent_id":"${id(10)}","gross_amount":"1200000"}]}')`);
  const run=async()=> (await db.query<{r:{status:string}}>('SELECT execute_contract_payout_operation_v1($1,$2) r',[org,id(60)])).rows[0].r;
  await db.query("UPDATE buildings SET commission_tiers='[]',commission_change_reason=$1 WHERE id=$2",[reason,building]);
  expect((await run()).status).toBe('FAILED');
  await owner('GRANT SELECT ON app_private.rent_support_payout_results,app_private.commission_intervention_events TO authenticated');
  expect((await db.query('SELECT * FROM app_private.rent_support_payout_results')).rows).toEqual([]);
  await db.query("UPDATE buildings SET commission_tiers=$1,commission_change_reason=$2 WHERE id=$3",[JSON.stringify([{min_months:5,max_months:6,rate_percent:50},{min_months:10,max_months:12,rate_percent:60}]),reason,building]);
  const result=await run();expect(result.status).toBe('COMPLETED');
  await db.query("UPDATE buildings SET commission_tiers='[]',commission_change_reason=$1 WHERE id=$2",[reason,building]);
  expect(await run()).toEqual(result);
  await db.exec('RESET ROLE');
  expect((await db.query("SELECT after_snapshot,baseline FROM app_private.commission_intervention_events WHERE stage='SETTLED_BY_SUPPORT'")).rows).toMatchObject([{after_snapshot:{gross_amount:1200000,withheld_amount:1200000,net_amount:0},baseline:{default_amount:1200000}}]);
 }));
 it('routes support adoption retries through the bundle without demanding an ISSUE_NEW baseline',()=>tx(async()=>{
  await owner(`INSERT INTO app_private.rent_support_funding_operations(id,organization_id,contract_id,payload) VALUES('${id(61)}','${org}','${contract}','{"intents":[{"kind":"BONUS","action":"ADOPT_DEPOSIT_BONUS","intent_id":"${id(62)}","gross_amount":"300000","reason":"${reason}"}]}');
   INSERT INTO app_private.rent_support_payout_request_links VALUES('${org}','${id(61)}','${contract}','sale','${id(62)}')`);
  expect((await execute(id(62),'sale')).status).toBe('COMPLETED');
 }));
 it('retries a deducted ISSUE_NEW through the legacy request API using gross default and net voucher',()=>tx(async()=>{
  await prepare();
  await owner(`INSERT INTO app_private.rent_support_funding_operations(id,organization_id,contract_id,payload,net_amount) VALUES('${id(63)}','${org}','${contract}','{"intents":[{"kind":"COMMISSION","intent_id":"${id(10)}","gross_amount":"1200000"}]}',800000);
   INSERT INTO app_private.rent_support_payout_request_links VALUES('${org}','${id(63)}','${contract}','broker','${id(10)}')`);
  const result=await execute();expect(result.status).toBe('COMPLETED');
  expect((await history(result.id)).find(e=>e.stage==='CREATE_WITH_SUPPORT')?.baseline).toMatchObject({gross_amount:1200000,withheld_amount:400000,submitted_amount:800000});
 }));
 it('retains readable account and room names as they were when changed',()=>tx(async()=>{
  await prepare();const v=await execute();
  await db.query('INSERT INTO accounts VALUES($1,$2)',[id(70),'Sổ quỹ tại thời điểm đổi']);
  await dispatch(v.id,'EDIT_PENDING',reason,{expected_approval_version:1,patch:{account_id:id(70)},idempotency_key:'book-change'});
  await db.query("UPDATE accounts SET name='Tên mới về sau' WHERE id=$1",[id(70)]);
  expect((await history(v.id)).find(e=>e.stage==='EDIT_PENDING')?.after?.account_name).toBe('Sổ quỹ tại thời điểm đổi');
  await db.query('INSERT INTO rooms(id,organization_id,building_id,name) VALUES($1,$2,$3,$4)',[id(71),org,building,'Phòng nhận']);
  await db.query('UPDATE contracts SET room_id=$1,commission_change_reason=$2 WHERE id=$3',[id(71),reason,contract]);
  const event=(await history(v.id)).find(e=>e.stage==='CONTRACT_CHANGED');
  expect(event?.before).toMatchObject({room_name:'Phòng kiểm tra',building_name:'Tòa nhà kiểm tra',contract_number:'HĐ kiểm tra'});
  expect(event?.after).toMatchObject({room_name:'Phòng nhận',building_name:'Tòa nhà kiểm tra'});
 }));
 it('matches calendar-month arithmetic at month ends, leap years and partial months',async()=>{
  for(const [s,e] of [['2026-01-31','2026-02-28'],['2025-01-31','2026-02-28'],['2024-01-31','2024-02-29'],['2026-01-30','2026-03-29'],['2026-01-01','2026-11-30'],['2026-04-30','2026-05-31']]){
   const result=(await db.query<{n:number}>('SELECT app_private.commission_months_v1($1,$2) n',[s,e])).rows[0].n;expect(result).toBe(differenceInMonths(new Date(e),new Date(s)));}
 });
});
