import { readFileSync } from 'node:fs';
import { sharedW2, BUILDING, OTHER_BUILDING, ORG, FOREIGN, USER } from './wave2-sql-fixture.mjs';
import { CASHBOOK, FOREIGN_CASHBOOK, CATEGORY, RESTRICTED_CATEGORY } from './finance-fixture.mjs';

// Gói B đợt 2 (sổ quỹ, dòng tiền, KQKD, lợi nhuận cổ đông, ví cá nhân, biến động số dư) — fixture RIÊNG
// của Gói B, chỉ Gói B sửa. Dựng trên sharedW2 (đọc đầy đủ đợt 1 + nền đợt 2 + migration của CHÍNH gói B).
// RPC web nạp ĐỊNH NGHĨA THẬT (bản cuối trong baseline/migration): ba RPC sổ quỹ (+ _v2), phạm vi sổ
// (ie_visible_cashbook_ids_v1, my_possessed/my_company_owner_org_ids), list_cashbook_visibility_v2,
// list_cashbook_closings_v1, sáu fa_*, personal_finance_snapshot, bank_event_admin_v1. Cổng tổng hợp
// cùng chữ ký (KHÔNG chứng minh bản thật): is_super_admin, can_view_restricted_ie, ie_actor_is_company_owner_v1,
// staff_can, org_timezone_v1 và năm RPC Hiệu quả kinh doanh (cổng "tất cả hoặc không" theo fixture_acl, số
// lấy từ fa_* thật). Không chứng minh RLS, JWT thật hay PostgREST. Dữ liệu tổng hợp.
// MỘT PGlite cho cả file test, mỗi ca BEGIN … ROLLBACK (shared.isolated).
const baseline = readFileSync('supabase/baseline/schema.sql', 'utf8');
const migration = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
// Bản định nghĩa CUỐI của một hàm trong file (thẻ $…$ bất kỳ).
export function definitionOf(src, name) {
  const pattern = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name.replaceAll('.', '\\.')}\\(`, 'g');
  const starts = [...src.matchAll(pattern)].map(match => match.index);
  if (!starts.length) throw new Error(`missing definition ${name}`);
  const start = starts.at(-1), open = /AS\s+(\$[A-Za-z_]*\$)/.exec(src.slice(start));
  if (!open) throw new Error(`missing body ${name}`);
  const bodyAt = start + open.index + open[0].length, close = src.indexOf(open[1], bodyAt);
  const end = src.indexOf(';', close + open[1].length);
  return src.slice(start, end + 1);
}

const u = n => `0b0b0b0b-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const FOREIGN_ORG_BOOK = u(1), OWNER_BOOK = u(2), SH_ME = u(3), SH_OTHER = u(4), SH_FOREIGN = u(5);
export const PM_A9 = u(6), PM_B9 = u(7), PM_A10 = u(8), PM_F = u(9), WALLET = u(10), WALLET_HIDDEN = u(11), FOREIGN_WALLET = u(12);
export const CAT_FOOD = u(13), SOURCE = u(14), EVENT_1 = u(15), EVENT_2 = u(16), OTHER_USER = u(17), VIRTUAL = u(18);

const TABLES = `
  CREATE TABLE IF NOT EXISTS public.profiles(id uuid PRIMARY KEY,full_name text);
  ALTER TABLE public.accounts ADD COLUMN code text,ADD COLUMN description text,ADD COLUMN bank_name text,
    ADD COLUMN initial_amount numeric(18,2) NOT NULL DEFAULT 0,ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
  ALTER TABLE public.cashbook_possession_bindings ADD COLUMN valid_from timestamptz NOT NULL DEFAULT '2020-01-01';
  CREATE TABLE public.income_expense_postings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,voucher_id uuid,event_kind text,posted_on date);
  CREATE TABLE public.income_expense_posting_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,posting_id uuid,account_id uuid,signed_amount numeric(15,2));
  CREATE TABLE app_private.server_feature_flags(feature_key text PRIMARY KEY,mode text,force_freeze boolean NOT NULL DEFAULT false,starts_at timestamptz,ends_at timestamptz);
  CREATE TABLE app_private.server_feature_flag_canary_orgs(feature_key text,organization_id uuid);
  CREATE TABLE app_private.cashbook_closures(id bigserial PRIMARY KEY,organization_id uuid NOT NULL,cashbook_id uuid NOT NULL,closed_through date NOT NULL,
    counted_balance numeric(15,2),system_balance numeric(15,2),basis text NOT NULL DEFAULT 'POSTING_TRUTH_BY_POSTED_ON',proposed_by uuid,confirmed_by uuid,
    confirmed_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE app_private.cashbook_closure_requests(id uuid PRIMARY KEY,organization_id uuid,cashbook_id uuid,closed_through date,counted_balance numeric(15,2),
    system_balance numeric(15,2),note text,proposed_by uuid,confirmer_user_id uuid NOT NULL,status text,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  ALTER TABLE public.income_expense_types ADD COLUMN merged_into_id uuid;
  ALTER TABLE public.contract_extensions ADD COLUMN extension_date date;
  CREATE TABLE public.contract_terminations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid,status text,termination_date date);
  CREATE TABLE public.shareholders(id uuid PRIMARY KEY,user_id uuid,auth_user_id uuid,name text,is_active boolean DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),deleted_at timestamptz,organization_id uuid);
  CREATE TABLE public.profit_monthly(id uuid PRIMARY KEY,user_id uuid,building_id uuid,period_month date,adjusted_profit numeric,status text,organization_id uuid);
  CREATE TABLE public.profit_allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,profit_monthly_id uuid,shareholder_id uuid,percent numeric,
    amount numeric,organization_id uuid);
  CREATE TABLE public.personal_wallets(id uuid PRIMARY KEY,user_id uuid,version integer DEFAULT 1,name text,kind text,icon text,opening_balance numeric DEFAULT 0,
    hidden boolean DEFAULT false,is_default boolean DEFAULT false,is_preferred boolean DEFAULT false);
  CREATE TABLE public.personal_categories(id uuid PRIMARY KEY,user_id uuid,type text,name text,icon text,color text,hidden boolean DEFAULT false,seed_key text,legacy_name text);
  CREATE TABLE public.personal_legacy_category_map(user_id uuid,type text,legacy_name text,category_id uuid);
  CREATE TABLE public.personal_transactions(id uuid PRIMARY KEY,user_id uuid,type text,amount numeric,description text,txn_date date,category text,
    wallet_id uuid,category_id uuid,deleted_at timestamptz,organization_id uuid,version integer DEFAULT 1,created_at timestamptz DEFAULT clock_timestamp(),
    updated_at timestamptz DEFAULT clock_timestamp());
  CREATE TABLE public.personal_wallet_transfers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,source_wallet_id uuid,target_wallet_id uuid,amount numeric,
    txn_date date,note text,goal_id uuid,deleted_at timestamptz);
  CREATE TABLE public.personal_budget_limits(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,category_id uuid,amount numeric,type text);
  CREATE TABLE public.personal_goals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,name text,target numeric);
  CREATE TABLE app_private.bank_event_sources(id uuid PRIMARY KEY,name text,kind text,enabled boolean,revoked_at timestamptz,device_id uuid,organization_id uuid,
    created_at timestamptz DEFAULT clock_timestamp(),created_by uuid,last_seen_at timestamptz,last_event_at timestamptz,heartbeat jsonb);
  CREATE TABLE app_private.bank_inbound_events(id uuid PRIMARY KEY,source_id uuid,external_id text,device_id uuid,event_type text,occurred_at timestamptz,
    received_at timestamptz,duplicate_count bigint DEFAULT 0,ciphertext text,nonce text,key_id text,payload_hash text);
  CREATE TABLE app_private.bank_event_audit(id bigserial PRIMARY KEY,actor_id uuid,action text,source_id uuid,event_id uuid,detail jsonb,created_at timestamptz DEFAULT clock_timestamp());
  CREATE TABLE public.fixture_company_owners(organization_id uuid,user_id uuid);
  CREATE TABLE public.fixture_bp(building_id uuid PRIMARY KEY,cohort_billed numeric,cash_received numeric);`;

// Cổng tổng hợp cùng chữ ký.
const PORTS = `
  CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=auth.uid())$$;
  CREATE OR REPLACE FUNCTION public.can_view_restricted_ie() RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT public.is_super_admin() OR EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission='income_expenses.restricted_view' AND allowed
      AND (org_wide OR cardinality(building_ids)>0))$$;
  CREATE OR REPLACE FUNCTION app_private.ie_actor_is_company_owner_v1(p_org uuid,p_user uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS(SELECT 1 FROM public.fixture_company_owners WHERE organization_id=p_org AND user_id=p_user)$$;
  CREATE OR REPLACE FUNCTION public.staff_can(_table text,_action text,_owner uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
  CREATE OR REPLACE FUNCTION app_private.org_timezone_v1(p_organization_id uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'Asia/Ho_Chi_Minh'::text$$;
  -- Hiệu quả kinh doanh: danh sách toà = reports_finance.analysis (fixture_acl) ∩ can_access_building, toà thật của công ty;
  -- restricted_allowed = income_expenses.restricted_view phủ toà. RPC: "tất cả hoặc không" (42501) như exact_scope_v1.
  CREATE OR REPLACE FUNCTION public.business_performance_organizations_v1() RETURNS TABLE(organization_id uuid,organization_name text,
    authorized_buildings jsonb,authorized_physical_building_count bigint,authorization_version bigint) LANGUAGE sql AS $$
    SELECT b.organization_id,'Công ty',jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'restricted_allowed',EXISTS(SELECT 1 FROM public.fixture_acl r
        WHERE r.permission='income_expenses.restricted_view' AND r.allowed AND (r.org_wide OR b.id=ANY(r.building_ids))),'analysis_provenance','CANONICAL') ORDER BY b.id),
      count(*),1::bigint
    FROM public.buildings b JOIN public.organization_memberships m ON m.organization_id=b.organization_id AND m.user_id=auth.uid() AND m.status='ACTIVE'
    WHERE b.deleted_at IS NULL AND NOT COALESCE(b.is_virtual,false) AND public.can_access_building(b.id)
      AND EXISTS(SELECT 1 FROM public.fixture_acl a WHERE a.permission='reports_finance.analysis' AND a.allowed AND (a.org_wide OR b.id=ANY(a.building_ids)))
    GROUP BY b.organization_id$$;
  CREATE OR REPLACE FUNCTION public.fixture_bp_gate(p_org uuid,p_buildings uuid[],p_restricted boolean) RETURNS uuid[] LANGUAGE plpgsql AS $$
  DECLARE v_roster jsonb; v_id uuid;
  BEGIN
    SELECT authorized_buildings INTO v_roster FROM public.business_performance_organizations_v1() WHERE organization_id=p_org;
    IF v_roster IS NULL OR p_buildings IS NULL OR cardinality(p_buildings)=0 THEN RAISE EXCEPTION 'Business performance access denied' USING ERRCODE='42501'; END IF;
    FOREACH v_id IN ARRAY p_buildings LOOP
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_roster) e WHERE (e->>'id')::uuid=v_id AND (NOT p_restricted OR (e->>'restricted_allowed')::boolean)) THEN
        RAISE EXCEPTION 'Business performance access denied' USING ERRCODE='42501'; END IF;
    END LOOP;
    RETURN p_buildings;
  END $$;
  CREATE OR REPLACE FUNCTION public.business_performance_pnl_v1(p_organization_id uuid,p_basis text,p_start_date date,p_end_date date,p_building_ids uuid[])
  RETURNS TABLE(month date,building_id uuid,building_name text,is_virtual boolean,revenue numeric,expense numeric,net numeric) LANGUAGE plpgsql AS $$
  DECLARE v uuid[]:=public.fixture_bp_gate(p_organization_id,p_building_ids,true);
  BEGIN
    IF p_basis NOT IN ('ACCRUAL','VOUCHER_DATE') THEN RAISE EXCEPTION 'Unsupported business performance basis' USING ERRCODE='22023'; END IF;
    IF p_basis='ACCRUAL' THEN RETURN QUERY SELECT * FROM public.fa_monthly_pnl_accrual(p_start_date,p_end_date,v);
    ELSE RETURN QUERY SELECT * FROM public.fa_monthly_pnl(p_start_date,p_end_date,v); END IF;
  END $$;
  CREATE OR REPLACE FUNCTION public.business_performance_category_breakdown_v1(p_organization_id uuid,p_basis text,p_start_date date,p_end_date date,p_building_ids uuid[])
  RETURNS TABLE(month date,side text,type_id uuid,type_name text,category text,total_amount numeric,voucher_count bigint) LANGUAGE plpgsql AS $$
  DECLARE v uuid[]:=public.fixture_bp_gate(p_organization_id,p_building_ids,true);
  BEGIN
    IF p_basis='ACCRUAL' THEN RETURN QUERY SELECT * FROM public.fa_type_breakdown_accrual(p_start_date,p_end_date,v);
    ELSE RETURN QUERY SELECT * FROM public.fa_type_breakdown(p_start_date,p_end_date,v); END IF;
  END $$;
  CREATE OR REPLACE FUNCTION public.business_performance_invoice_cohort_v1(p_organization_id uuid,p_cohort_month date,p_building_ids uuid[])
  RETURNS TABLE(building_id uuid,building_name text,cohort_month date,cohort_available boolean,billed_current_charge numeric,collected_current_charge numeric,
    remaining_current_charge numeric,collection_rate_pct numeric,invoice_count integer,allocation_unknown_count integer,allocation_unknown_amount numeric,
    component_anomaly_count integer,carried_invoice_debt numeric,carried_deposit_debt numeric,current_deposit numeric,draft_pending_count integer,
    draft_pending_amount numeric,settlement_count integer,settlement_amount numeric,generated_at timestamptz) LANGUAGE plpgsql AS $$
  DECLARE v uuid[]:=public.fixture_bp_gate(p_organization_id,p_building_ids,true);
  BEGIN
    RETURN QUERY SELECT b.id,b.name,p_cohort_month,true,COALESCE(f.cohort_billed,0),COALESCE(f.cohort_billed,0)/2,COALESCE(f.cohort_billed,0)/2,50.0::numeric,
      2,0,0::numeric,0,0::numeric,0::numeric,0::numeric,0,0::numeric,0,0::numeric,clock_timestamp()
      FROM public.buildings b LEFT JOIN public.fixture_bp f ON f.building_id=b.id WHERE b.id=ANY(v) ORDER BY b.name;
  END $$;
  CREATE OR REPLACE FUNCTION public.business_performance_cash_received_v1(p_organization_id uuid,p_month date,p_building_ids uuid[])
  RETURNS TABLE(building_id uuid,building_name text,cash_month date,cash_received numeric,payment_event_count integer,first_payment_date date,
    last_payment_date date,generated_at timestamptz) LANGUAGE plpgsql AS $$
  DECLARE v uuid[]:=public.fixture_bp_gate(p_organization_id,p_building_ids,true);
  BEGIN
    RETURN QUERY SELECT b.id,b.name,p_month,COALESCE(f.cash_received,0),1,p_month,p_month,clock_timestamp()
      FROM public.buildings b LEFT JOIN public.fixture_bp f ON f.building_id=b.id WHERE b.id=ANY(v) ORDER BY b.name;
  END $$;`;

// Định nghĩa THẬT (bản cuối) của RPC web và hàm phạm vi mà báo cáo gọi.
const REAL = [
  [baseline, 'app_private.my_possessed_cashbook_ids_v1'], [baseline, 'app_private.finance_v2_route_pure_v1'],
  [baseline, 'app_private.finance_v2_can_read_posting_v1'],
  [migration('20260924012853_chu_cong_ty_doc_moi_so_quy'), 'app_private.my_company_owner_org_ids_v1'],
  [migration('20260924012853_chu_cong_ty_doc_moi_so_quy'), 'app_private.ie_visible_cashbook_ids_v1'],
  [migration('20260730101000_cashbook_aggregate_possession'), 'app_private.assert_cashbook_readable_v1'],
  [migration('20260730101000_cashbook_aggregate_possession'), 'public.cashbook_period_totals_v2'],
  [migration('20260730101000_cashbook_aggregate_possession'), 'public.cashbook_opening_balance_v2'],
  [migration('20260730101000_cashbook_aggregate_possession'), 'public.cashflow_by_day_v2'],
  [baseline, 'public.cashbook_period_totals'], [baseline, 'public.cashbook_opening_balance'], [baseline, 'public.cashflow_by_day'],
  [migration('20260724160000_finance_v2_cashbook_visibility_flags'), 'public.list_cashbook_visibility_v2'],
  [baseline, 'public.list_cashbook_closings_v1'],
  [migration('20261003152559_danh_muc_chi_bao_cao_cong_gop'), 'public.fa_type_breakdown'],
  [migration('20260626000000_fa_accrual_pnl'), 'public.fa_type_breakdown_accrual'],
  [migration('20260731070000_current_date_to_org_today'), 'public.fa_snapshot_kpis'],
  [migration('20260611140000_financial_analysis_rpcs'), 'public.fa_occupancy_monthly'],
  [migration('20260611140000_financial_analysis_rpcs'), 'public.fa_lease_events'],
  [migration('20260611140000_financial_analysis_rpcs'), 'public.fa_invoice_collection'],
  [migration('20261004212309_personal_finance_wallets'), 'public.personal_finance_snapshot'],
  [migration('20261009042140_bank_event_raw_inbox'), 'app_private.bank_event_metadata_v1'],
  [migration('20261009103855_bank_event_gmail_nguon_va_tom_tat'), 'public.bank_event_admin_v1'],
];
export const REAL_FUNCTIONS = REAL.map(([, name]) => name);

async function before(db) {
  await db.exec(TABLES);
  await db.exec(PORTS);
  await db.exec('SET check_function_bodies=off');
  try { for (const [src, name] of REAL) await db.exec(definitionOf(src, name)); }
  finally { await db.exec('RESET check_function_bodies'); }
}

// Dữ liệu tổng hợp nền (mỗi ca thêm/đổi trong BEGIN … ROLLBACK).
async function seed(db) {
  await db.exec(`
    INSERT INTO public.profiles VALUES('${USER}','Chủ Sổ'),('${FOREIGN}','Người Khác'),('${OTHER_USER}','Kế toán B');
    UPDATE public.accounts SET code='TM01',initial_amount=1000000,description='Quỹ tiền mặt',bank_name='VCB',created_at='2026-01-01' WHERE id='${CASHBOOK}';
    UPDATE public.accounts SET code='TM02',initial_amount=50000,description='Sổ người khác',created_at='2026-01-02' WHERE id='${FOREIGN_CASHBOOK}';
    INSERT INTO public.accounts(id,organization_id,user_id,name,account_number,is_virtual,code,initial_amount,created_at) VALUES
      ('${FOREIGN_ORG_BOOK}','${FOREIGN}','${USER}','Sổ công ty khác','111',false,'TMX',0,'2026-01-03'),
      ('${OWNER_BOOK}','${ORG}','${OTHER_USER}','Quỹ ngân hàng','222',false,'NH01',0,'2026-01-04');
    INSERT INTO public.buildings(id,organization_id,name,is_virtual) VALUES('${VIRTUAL}','${ORG}','Chung',true);
    INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${OTHER_USER}','${OTHER_USER}','${ORG}','ACTIVE');`);
  // Bút toán (posting truth): sổ của người hỏi ở toà A/B/không toà; sổ người khác; sổ công ty khác.
  const post = (n, voucher, kind, on, book, amount, org = ORG) => `('${u(100 + n)}','${org}',${voucher ? `'${voucher}'` : 'null'},'${kind}','${on}')|('${u(100 + n)}','${org}','${book}',${amount})`;
  const vouchers = [[u(201), BUILDING], [u(202), OTHER_BUILDING], [u(203), BUILDING], [u(204), BUILDING], [u(205), BUILDING], [u(206), BUILDING]];
  await db.exec(`INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,voucher_date,total_amount,approval_status,kqkd_amount,business_result_accounting) VALUES
    ${vouchers.map(([v, b], i) => `('${v}','${ORG}','${USER}','PX-${i}','INCOME','Bút toán ${i}','${b}','2026-10-01',0,'APPROVED',0,false)`).join(',')}`);
  const rows = [post(1, u(201), 'POSTING', '2026-09-20', CASHBOOK, 500000), post(2, u(201), 'POSTING', '2026-10-02', CASHBOOK, 1200000),
    post(3, u(202), 'POSTING', '2026-10-05', CASHBOOK, -300000), post(4, null, 'POSTING', '2026-10-05', CASHBOOK, 100000),
    post(5, u(203), 'REVERSAL', '2026-10-10', CASHBOOK, -50000), post(6, u(204), 'OTHER', '2026-10-11', CASHBOOK, 999),
    post(7, u(205), 'POSTING', '2026-10-03', FOREIGN_CASHBOOK, 700000), post(8, null, 'POSTING', '2026-10-04', FOREIGN_ORG_BOOK, 9999, FOREIGN),
    post(9, u(206), 'POSTING', '2026-03-15', CASHBOOK, 40000)];
  await db.exec(`INSERT INTO public.income_expense_postings(id,organization_id,voucher_id,event_kind,posted_on) VALUES ${rows.map(r => r.split('|')[0]).join(',')};
    INSERT INTO public.income_expense_posting_lines(posting_id,organization_id,account_id,signed_amount) VALUES ${rows.map(r => r.split('|')[1]).join(',')};`);
  // Chốt sổ: một biên bản + một đề nghị cho sổ của người hỏi; một biên bản sổ người khác (web lộ cho mọi thành viên).
  await db.exec(`INSERT INTO app_private.cashbook_closures(organization_id,cashbook_id,closed_through,counted_balance,system_balance,proposed_by,confirmed_by,confirmed_at) VALUES
      ('${ORG}','${CASHBOOK}','2026-09-30',1490000,1500000,'${USER}','${OTHER_USER}','2026-10-01T02:00:00Z'),
      ('${ORG}','${FOREIGN_CASHBOOK}','2026-09-30',40000,50000,'${FOREIGN}','${USER}','2026-10-01T03:00:00Z');
    INSERT INTO app_private.cashbook_closure_requests(id,organization_id,cashbook_id,closed_through,counted_balance,system_balance,note,proposed_by,confirmer_user_id,status,created_at)
      VALUES('${u(301)}','${ORG}','${CASHBOOK}','2026-10-10',2440000,2450000,'thiếu 10k','${OTHER_USER}','${USER}','PENDING','2026-10-11T01:00:00Z'),
      ('${u(302)}','${ORG}','${FOREIGN_CASHBOOK}','2026-10-10',1,2,'sổ người khác','${FOREIGN}','${OTHER_USER}','PENDING','2026-10-11T02:00:00Z');`);
  // Thu chi theo hạng mục (Phân tích tài chính): Lương là hạng mục HẠN CHẾ.
  await db.exec(`INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,voucher_date,total_amount,approval_status,kqkd_amount,has_restricted_item) VALUES
      ('${u(401)}','${ORG}','${OTHER_USER}','PC-401','EXPENSE','Sửa máy bơm','${BUILDING}','2026-10-03',800000,'APPROVED',800000,false),
      ('${u(402)}','${ORG}','${OTHER_USER}','PC-402','EXPENSE','Lương quản lý T10','${BUILDING}','2026-10-04',5000000,'APPROVED',5000000,true),
      ('${u(403)}','${ORG}','${OTHER_USER}','PC-403','EXPENSE','Sơn toà B','${OTHER_BUILDING}','2026-10-06',600000,'APPROVED',600000,false),
      ('${u(404)}','${ORG}','${USER}','PC-404','EXPENSE','Lương tự chi','${BUILDING}','2026-10-07',300000,'APPROVED',300000,true),
      ('${u(405)}','${ORG}','${OTHER_USER}','PC-405','EXPENSE','Chưa duyệt','${BUILDING}','2026-10-08',9000000,'UNAPPROVED',9000000,false);
    INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount,accounting_class) VALUES
      ('${u(401)}','${CATEGORY}',800000,'PNL'),('${u(402)}','${RESTRICTED_CATEGORY}',5000000,'PNL'),('${u(403)}','${CATEGORY}',600000,'PNL'),
      ('${u(404)}','${RESTRICTED_CATEGORY}',300000,'PNL'),('${u(405)}','${CATEGORY}',9000000,'PNL');
    INSERT INTO public.fixture_bp VALUES('${BUILDING}',1000000,700000),('${OTHER_BUILDING}',2000000,1500000);`);
  // Cổ đông: người hỏi là cổ đông (toà A + B); một cổ đông khác; cổ đông công ty khác.
  await db.exec(`INSERT INTO public.shareholders(id,user_id,auth_user_id,name,organization_id) VALUES
      ('${SH_ME}','${OTHER_USER}','${USER}','Cổ đông Tôi','${ORG}'),('${SH_OTHER}','${OTHER_USER}',null,'Cổ đông Khác','${ORG}'),
      ('${SH_FOREIGN}','${USER}','${USER}','Cổ đông ngoài','${FOREIGN}');
    INSERT INTO public.profit_monthly(id,user_id,building_id,period_month,adjusted_profit,status,organization_id) VALUES
      ('${PM_A9}','${OTHER_USER}','${BUILDING}','2026-09-01',10000000,'LOCKED','${ORG}'),('${PM_B9}','${OTHER_USER}','${OTHER_BUILDING}','2026-09-01',4000000,'LOCKED','${ORG}'),
      ('${PM_A10}','${OTHER_USER}','${BUILDING}','2025-10-01',2000000,'LOCKED','${ORG}'),('${PM_F}','${USER}','${FOREIGN}','2026-09-01',99,'LOCKED','${FOREIGN}');
    INSERT INTO public.profit_allocations(user_id,profit_monthly_id,shareholder_id,percent,amount,organization_id) VALUES
      ('${OTHER_USER}','${PM_A9}','${SH_ME}',30,3000000,'${ORG}'),('${OTHER_USER}','${PM_B9}','${SH_ME}',30,1200000,'${ORG}'),
      ('${OTHER_USER}','${PM_A10}','${SH_ME}',30,600000,'${ORG}'),('${OTHER_USER}','${PM_A9}','${SH_OTHER}',70,7000000,'${ORG}'),
      ('${USER}','${PM_F}','${SH_FOREIGN}',100,99,'${FOREIGN}');
    INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,voucher_date,total_amount,approval_status,kqkd_amount,shareholder_id,business_result_accounting) VALUES
      ('${u(501)}','${ORG}','${OTHER_USER}','PC-501','EXPENSE','Chia LN T9','${BUILDING}','2026-10-09',1000000,'APPROVED',0,'${SH_ME}',false),
      ('${u(502)}','${ORG}','${OTHER_USER}','PC-502','EXPENSE','Chia LN toà B','${OTHER_BUILDING}','2026-10-09',200000,'APPROVED',0,'${SH_ME}',false),
      ('${u(503)}','${ORG}','${OTHER_USER}','PC-503','EXPENSE','Chia LN khác','${BUILDING}','2026-10-09',2500000,'APPROVED',0,'${SH_OTHER}',false);`);
  // Ví cá nhân: của người hỏi và của người khác (không bao giờ lộ).
  await db.exec(`INSERT INTO public.personal_wallets(id,user_id,name,kind,opening_balance,hidden,is_default) VALUES
      ('${WALLET}','${USER}','Ví chính','cash',100000,false,true),('${WALLET_HIDDEN}','${USER}','Ví ẩn','bank',5000,true,false),
      ('${FOREIGN_WALLET}','${OTHER_USER}','Ví người khác','cash',777777,false,true);
    INSERT INTO public.personal_categories(id,user_id,type,name) VALUES('${CAT_FOOD}','${USER}','EXPENSE','Ăn uống');
    INSERT INTO public.personal_transactions(id,user_id,type,amount,description,txn_date,category,wallet_id,category_id) VALUES
      ('${u(601)}','${USER}','INCOME',2000000,'Lương tháng 10','2026-10-05',null,'${WALLET}',null),
      ('${u(602)}','${USER}','EXPENSE',150000,'Cơm trưa','2026-10-06',null,null,'${CAT_FOOD}'),
      ('${u(603)}','${USER}','EXPENSE',50000,'Cà phê','2026-09-30','Ăn uống',null,null),
      ('${u(604)}','${OTHER_USER}','EXPENSE',123456,'Của người khác','2026-10-06',null,'${FOREIGN_WALLET}',null);
    INSERT INTO public.personal_legacy_category_map VALUES('${USER}','EXPENSE','Ăn uống','${CAT_FOOD}');`);
  // Biến động số dư: hai tin (bản mã giả — Hermes không bao giờ đọc).
  await db.exec(`INSERT INTO app_private.bank_event_sources(id,name,kind,enabled) VALUES('${SOURCE}','Điện thoại kế toán','android',true);
    INSERT INTO app_private.bank_inbound_events(id,source_id,external_id,event_type,occurred_at,received_at,duplicate_count,ciphertext,nonce,key_id,payload_hash) VALUES
      ('${EVENT_1}','${SOURCE}','${'a'.repeat(64)}','sms.received','2026-10-15T01:00:00Z','2026-10-15T01:00:05Z',0,'CIPHERTEXT-SECRET','n','k1','${'b'.repeat(64)}'),
      ('${EVENT_2}','${SOURCE}','${'c'.repeat(64)}','notification.received','2026-10-16T02:00:00Z','2026-10-16T02:00:03Z',2,'CIPHERTEXT-SECRET','n','k1','${'d'.repeat(64)}');`);
}

export async function sharedW2b(options = {}) {
  return sharedW2({ packages: ['b'], before, seed, ...options });
}
