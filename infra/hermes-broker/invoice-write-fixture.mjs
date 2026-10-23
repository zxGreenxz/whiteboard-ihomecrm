import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setup, binding, ACTION_PATH, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, CASHBOOK, ORG, USER } from './finance-fixture.mjs';
export { binding, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, CASHBOOK, ORG, USER };

// RPC trang Hoá đơn (Đợt 3 Mốc 3, HOA-DON-THAO-TAC-GHI.md mục 2–5, 4.1) trên PGlite với fixture Hermes của thu chi (binding/phiên/chính
// sách thật của các migration Hermes; quyền CRM giả qua fixture_acl). Hai migration của mốc chạy THẬT (mỗi file hai lượt), hàm kế hoạch dùng
// chung thật, invoice_room_invoices_v1 thật (Mốc 2), nợ thực #267 thật. Hàm ghi web record_invoice_collection_v5 ở đây là BẢN PORT (cùng
// chữ ký, cùng câu lỗi đã liệt kê ở mục 5, idempotency theo khoá + băm, khoá lạc quan p_expected_paid_amount) — nó chứng minh logic của
// bước ghi Hermes (chạy thử không để lại dấu vết, lô cả-hoặc-không, basis, lý do, phạm vi), KHÔNG chứng minh v5 thật: phần đó đo ở tầng 2.
// Dùng chung cho invoice-write-sql.test.mjs (PGlite) và invoice-write-race-sql.test.mjs (PG17 hai kết nối: database = adapter pg).
const file = slug => { const found = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name)); assert.equal(found.length, 1, slug);
  return readFileSync(`supabase/migrations/${found[0]}`, 'utf8').replaceAll('\r\n', '\n'); };
const statement = (sql, name) => { const match = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?\\$fn\\$;`));
  assert.ok(match, name); return match[0]; };
const RESOLVE = file('hermes_write_name_resolve_v1'), FOUNDATION = file('hermes_action_foundation_v1');
const EXPENSE = file('hermes_expense_write_v1'), SHARED = file('hermes_w2a_invoice_shared_v1');
const PLAN = file('invoice_collection_plan_v1'), PAGE = file('hermes_invoice_action_v1');
export const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const rid = n => uid(900 + n);

export const [ROOM2, ROOM3, ROOM4, ROOM5] = [811, 812, 813, 814].map(uid);
export const [INV_A, INV_A9, INV_B, INV_C, INV_D9, INV_D10, INV_E] = [821, 822, 823, 824, 825, 826, 827].map(uid);
export const [TK1, TK2, TT1, TM1, ROUNDING, CONTRACT, STRANGER] = [831, 832, 833, 834, 835, 836, 877].map(uid);
// Bảng/hàm web mà hai migration đòi, bản fixture (như Thu chi). Quyền thu theo toà của v5 (authorize_tenant_action_v3) là bảng RIÊNG
// fixture_collect_acl — tách khỏi quyền v3 của guard (fixture_acl) như production.
const SUPPORT = `CREATE TABLE IF NOT EXISTS public.building_common_names(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,name text);
  CREATE TABLE IF NOT EXISTS public.job_types(id uuid PRIMARY KEY,organization_id uuid,name text,is_active boolean);
  CREATE TABLE IF NOT EXISTS public.profiles(id uuid PRIMARY KEY,full_name text);
  ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS code text;
  REVOKE USAGE ON SCHEMA app_private FROM authenticated, PUBLIC;
  GRANT SELECT ON public.building_common_names,public.job_types,public.profiles,public.buildings,public.rooms TO authenticated;
  CREATE OR REPLACE FUNCTION app_private.hermes_task_assignee_member_v1(p_user uuid,p_org uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$ SELECT p_user=auth.uid() $f$;
  GRANT EXECUTE ON FUNCTION app_private.hermes_task_assignee_member_v1(uuid,uuid) TO authenticated;
  CREATE OR REPLACE FUNCTION app_private.hermes_web_building_ids_v1(p_org uuid) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public,app_private AS $f$
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) FROM public.buildings b
      CROSS JOIN LATERAL (SELECT COALESCE(bool_or(s.org_wide),false) org_wide,COALESCE(array_agg(x),'{}'::uuid[]) ids
        FROM app_private.authorized_scope_v3('buildings.view',p_org) s LEFT JOIN LATERAL unnest(s.building_ids) x ON true) scope
      WHERE p_org IS NOT NULL AND auth.uid() IS NOT NULL AND b.organization_id=p_org AND b.deleted_at IS NULL AND (scope.org_wide OR b.id=ANY(scope.ids)) $f$;
  REVOKE ALL ON FUNCTION app_private.hermes_web_building_ids_v1(uuid) FROM PUBLIC,authenticated;`;
const WEB = `ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS contract_id uuid,ADD COLUMN IF NOT EXISTS kind text DEFAULT 'MONTHLY',ADD COLUMN IF NOT EXISTS issue_date date,
    ADD COLUMN IF NOT EXISTS paid_date date,ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN IF NOT EXISTS adjustment_revision bigint NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS public.invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS invoice_id uuid,ADD COLUMN IF NOT EXISTS type text,ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS amount numeric,ADD COLUMN IF NOT EXISTS accounting_class text DEFAULT 'PNL';
  CREATE TABLE IF NOT EXISTS public.invoice_payment_collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  ALTER TABLE public.invoice_payment_collections ADD COLUMN IF NOT EXISTS organization_id uuid,ADD COLUMN IF NOT EXISTS invoice_id uuid,
    ADD COLUMN IF NOT EXISTS status text DEFAULT 'ACTIVE',ADD COLUMN IF NOT EXISTS gross_amount numeric,ADD COLUMN IF NOT EXISTS applied_amount numeric,
    ADD COLUMN IF NOT EXISTS credit_amount numeric,ADD COLUMN IF NOT EXISTS rounding_amount numeric,ADD COLUMN IF NOT EXISTS actor_id uuid,
    ADD COLUMN IF NOT EXISTS idempotency_key text,ADD COLUMN IF NOT EXISTS tenders jsonb,ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT clock_timestamp();
  CREATE TABLE public.fixture_v5_ops(idempotency_key text,actor uuid,payload_hash text,response jsonb,PRIMARY KEY(idempotency_key,actor));
  CREATE TABLE public.fixture_v5(rejected_message text,reject_state text,reject_invoice uuid);
  INSERT INTO public.fixture_v5 VALUES(null,null,null);
  CREATE TABLE public.fixture_today(d date);
  INSERT INTO public.fixture_today VALUES('2026-10-22');
  CREATE TABLE public.fixture_receiving(building_id uuid,method text,account_id uuid,ord int);
  CREATE TABLE public.fixture_possession(user_id uuid,account_id uuid);
  CREATE TABLE public.fixture_collect_acl(user_id uuid,building_id uuid);
  GRANT SELECT ON public.invoices,public.invoice_items,public.invoice_payment_collections,public.accounts,public.fixture_today TO authenticated;
  CREATE FUNCTION public.org_today_v1(p_org uuid) RETURNS date LANGUAGE sql STABLE AS $f$ SELECT d FROM public.fixture_today $f$;
  CREATE FUNCTION public.is_overdue(i public.invoices) RETURNS boolean LANGUAGE sql STABLE AS $f$
    SELECT i.due_date<(SELECT d FROM public.fixture_today) AND i.status NOT IN ('PAID','CANCELLED','DRAFT') $f$;
  CREATE FUNCTION public.can_do_on_building(_table text,_action text,_building_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$ SELECT EXISTS(SELECT 1 FROM public.fixture_building_access WHERE building_id=_building_id) $f$;
  CREATE FUNCTION app_private.current_uid_v1() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT auth.uid() $f$;
  CREATE FUNCTION app_private.authorize_tenant_action_v3(p_actor uuid,p_organization_id uuid,p_permission_key text,p_building_id uuid DEFAULT NULL,p_cashbook_id uuid DEFAULT NULL)
    RETURNS TABLE(allowed boolean) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    SELECT p_permission_key='thu_tien.collect' AND EXISTS(SELECT 1 FROM public.fixture_collect_acl a WHERE a.user_id=p_actor AND a.building_id=p_building_id) $f$;
  REVOKE ALL ON FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) FROM PUBLIC;
  CREATE FUNCTION public.list_cashbooks_for_income_v2() RETURNS TABLE(id uuid,name text,possession_kind text) LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$ SELECT a.id,a.name,'CUSTODIAN' FROM public.fixture_possession p JOIN public.accounts a ON a.id=p.account_id WHERE p.user_id=auth.uid() $f$;
  GRANT EXECUTE ON FUNCTION public.list_cashbooks_for_income_v2() TO authenticated;
  CREATE FUNCTION public.get_receiving_cashbooks_v1(p_organization_id uuid,p_building_id uuid DEFAULT NULL,p_collector_user_id uuid DEFAULT NULL) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    SELECT jsonb_build_object('collectorUserId',auth.uid(),
      'personalCashBook',(SELECT jsonb_build_object('id',a.id,'name',a.name) FROM public.fixture_receiving r JOIN public.accounts a ON a.id=r.account_id
        WHERE r.method='TM' AND r.building_id IS NULL AND EXISTS(SELECT 1 FROM public.fixture_possession p WHERE p.user_id=auth.uid() AND p.account_id=a.id) LIMIT 1),
      'TK',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'isDefault',r.ord=0) ORDER BY r.ord),'[]'::jsonb) FROM public.fixture_receiving r
        JOIN public.accounts a ON a.id=r.account_id WHERE r.method='TK' AND r.building_id=p_building_id
          AND EXISTS(SELECT 1 FROM public.fixture_possession p WHERE p.user_id=auth.uid() AND p.account_id=a.id)),
      'TT',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'isDefault',r.ord=0) ORDER BY r.ord),'[]'::jsonb) FROM public.fixture_receiving r
        JOIN public.accounts a ON a.id=r.account_id WHERE r.method='TT' AND r.building_id=p_building_id
          AND EXISTS(SELECT 1 FROM public.fixture_possession p WHERE p.user_id=auth.uid() AND p.account_id=a.id))) $f$;
  GRANT EXECUTE ON FUNCTION public.get_receiving_cashbooks_v1(uuid,uuid,uuid) TO authenticated;
  -- Bản port record_invoice_collection_v5 (20260925083655): cùng chữ ký; câu lỗi như mục 5; quyền thu theo toà + sổ phải giữ/biết + sổ trong
  -- danh sách sổ nhận; khoá lạc quan; idempotency theo (khoá, người) + băm; làm tròn < 10.000đ cần sổ ảo; dòng NON_PNL/cọc chặn làm tròn.
  CREATE FUNCTION public.record_invoice_collection_v5(p_invoice_id uuid,p_collection_date date,p_tenders jsonb,p_overpay_action text,p_allow_rounding boolean,
    p_notes text,p_receipt_image_url text,p_expected_paid_amount numeric,p_idempotency_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog,public,app_private AS $w$
    DECLARE v_inv public.invoices; v_t jsonb; v_gross numeric:=0; v_tm numeric:=0; v_rem numeric; v_applied numeric; v_change numeric:=0; v_credit numeric:=0;
      v_round numeric:=0; v_hash text; v_op public.fixture_v5_ops; v_id uuid; v_resp jsonb; f public.fixture_v5;
    BEGIN
      IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
      IF btrim(COALESCE(p_idempotency_key,'')) !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn' USING ERRCODE='22023'; END IF;
      SELECT * INTO v_inv FROM public.invoices WHERE id=p_invoice_id AND deleted_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hóa đơn' USING ERRCODE='42501'; END IF;
      IF p_collection_date>public.org_today_v1(v_inv.organization_id) THEN RAISE EXCEPTION 'Ngày thu không được ở tương lai (hôm nay là %)',public.org_today_v1(v_inv.organization_id) USING ERRCODE='22023'; END IF;
      -- Thứ tự khoá của v5 thật: dòng hoá đơn FOR UPDATE → toà/công ty FOR SHARE → công ty NO KEY UPDATE (lock_org).
      PERFORM 1 FROM public.organizations o WHERE o.id=v_inv.organization_id FOR SHARE;
      PERFORM app_private.lock_org_for_decision_v1(v_inv.organization_id);
      IF NOT COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),v_inv.organization_id,'thu_tien.collect',v_inv.building_id,NULL) a),false) THEN
        RAISE EXCEPTION 'Không có quyền thu tiền hóa đơn' USING ERRCODE='42501'; END IF;
      v_hash:=md5(jsonb_build_array(p_invoice_id,p_collection_date,p_tenders,upper(COALESCE(p_overpay_action,'REJECT')),COALESCE(p_allow_rounding,false),p_notes)::text);
      SELECT * INTO v_op FROM public.fixture_v5_ops WHERE idempotency_key=p_idempotency_key AND actor=auth.uid();
      IF FOUND THEN
        IF v_op.payload_hash<>v_hash THEN RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE='23505'; END IF;
        RETURN v_op.response;
      END IF;
      SELECT * INTO f FROM public.fixture_v5;
      IF f.rejected_message IS NOT NULL AND (f.reject_invoice IS NULL OR f.reject_invoice=p_invoice_id) THEN
        RAISE EXCEPTION '%',f.rejected_message USING ERRCODE=COALESCE(f.reject_state,'P0001'); END IF;
      IF v_inv.status NOT IN ('APPROVED','PARTIAL_PAID','OVERDUE') THEN RAISE EXCEPTION 'Trạng thái hóa đơn không cho phép thu tiền: %',v_inv.status USING ERRCODE='55000'; END IF;
      IF p_expected_paid_amount IS NULL OR abs(COALESCE(v_inv.paid_amount,0)-p_expected_paid_amount)>=0.01 THEN
        RAISE EXCEPTION 'Số đã thu vừa thay đổi; vui lòng tải lại hóa đơn' USING ERRCODE='PT409'; END IF;
      FOR v_t IN SELECT value FROM jsonb_array_elements(p_tenders) LOOP
        IF NOT EXISTS(SELECT 1 FROM public.fixture_possession p WHERE p.user_id=auth.uid() AND p.account_id=(v_t->>'account_id')::uuid) THEN
          RAISE EXCEPTION 'Bạn không được giao sổ quỹ này (cần là Người giữ sổ hoặc Người biết sổ). Chọn sổ khác.' USING ERRCODE='42501'; END IF;
        IF NOT EXISTS(SELECT 1 FROM public.fixture_receiving r WHERE r.account_id=(v_t->>'account_id')::uuid AND r.method=v_t->>'payment_method'
            AND (r.building_id=v_inv.building_id OR (r.method='TM' AND r.building_id IS NULL))) THEN
          RAISE EXCEPTION 'Sổ "x" không nằm trong danh sách sổ nhận tiền Chuyển khoản của toà y.' USING ERRCODE='42501'; END IF;
        v_gross:=v_gross+(v_t->>'gross_amount')::numeric;
        IF v_t->>'payment_method'='TM' THEN v_tm:=v_tm+(v_t->>'gross_amount')::numeric; END IF;
      END LOOP;
      v_rem:=GREATEST(v_inv.total_amount-COALESCE(v_inv.paid_amount,0),0); v_applied:=LEAST(v_gross,v_rem);
      IF v_gross>v_rem THEN
        CASE upper(COALESCE(p_overpay_action,'REJECT'))
          WHEN 'REFUND' THEN v_change:=v_gross-v_rem;
          WHEN 'CREDIT' THEN IF v_inv.contract_id IS NULL THEN RAISE EXCEPTION 'Không thể giữ credit cho hóa đơn không có hợp đồng' USING ERRCODE='22023'; END IF;
            v_credit:=v_gross-v_rem;
          ELSE RAISE EXCEPTION 'Số thu vượt còn phải thu; chọn thối lại hoặc giữ credit' USING ERRCODE='22023';
        END CASE;
      END IF;
      IF v_applied<=0 THEN RAISE EXCEPTION 'Hóa đơn không còn số tiền có thể thu' USING ERRCODE='55000'; END IF;
      IF COALESCE(p_allow_rounding,false) AND v_rem-v_applied>0 AND v_rem-v_applied<10000 THEN v_round:=v_rem-v_applied; END IF;
      IF v_round>0 AND EXISTS(SELECT 1 FROM public.invoice_items it WHERE it.invoice_id=p_invoice_id AND it.accounting_class IN ('DEPOSIT','NON_PNL')) THEN
        RAISE EXCEPTION 'Không được làm tròn bỏ qua cọc hoặc khoản NON_PNL còn thiếu' USING ERRCODE='22023'; END IF;
      IF v_round>0 AND NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=(p_tenders->-1->>'rounding_account_id')::uuid AND a.is_virtual) THEN
        RAISE EXCEPTION 'Thiếu sổ quỹ làm tròn' USING ERRCODE='22023'; END IF;
      INSERT INTO public.invoice_payment_collections(organization_id,invoice_id,gross_amount,applied_amount,credit_amount,rounding_amount,actor_id,idempotency_key,tenders)
        VALUES(v_inv.organization_id,p_invoice_id,v_gross,v_applied,v_credit,v_round,auth.uid(),p_idempotency_key,p_tenders) RETURNING id INTO v_id;
      UPDATE public.invoices SET paid_amount=COALESCE(paid_amount,0)+v_applied,updated_at=clock_timestamp(),
        status=CASE WHEN total_amount-COALESCE(paid_amount,0)-v_applied-v_round<=0 THEN 'PAID' ELSE 'PARTIAL_PAID' END WHERE id=p_invoice_id;
      SELECT jsonb_build_object('collection_id',v_id,'invoice_id',p_invoice_id,'gross_amount',v_gross,'applied_amount',v_applied,'change_amount',v_change,
        'credit_amount',v_credit,'rounding_amount',v_round,'tenders',p_tenders,'invoice',to_jsonb(i)) INTO v_resp FROM public.invoices i WHERE i.id=p_invoice_id;
      INSERT INTO public.fixture_v5_ops VALUES(p_idempotency_key,auth.uid(),v_hash,v_resp);
      RETURN v_resp;
    END $w$;
  GRANT EXECUTE ON FUNCTION public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text) TO authenticated;`;
const SEED = `INSERT INTO public.rooms VALUES('${ROOM2}','${ORG}','${BUILDING}','P102','OCCUPIED',null),('${ROOM3}','${ORG}','${BUILDING}','P103','OCCUPIED',null),
    ('${ROOM4}','${ORG}','${BUILDING}','P104','OCCUPIED',null),('${ROOM5}','${ORG}','${BUILDING}','P105','OCCUPIED',null);
  INSERT INTO public.accounts(id,organization_id,user_id,name,account_number,is_virtual) VALUES('${TK1}','${ORG}','${USER}','VCB toà A 0123456789','0123456789',false),
    ('${TK2}','${ORG}','${USER}','MB toà A','',false),('${TT1}','${ORG}','${USER}','POS toà A','',false),('${TM1}','${ORG}','${USER}','Tiền mặt người thu','',false),
    ('${ROUNDING}','${ORG}','${USER}','Làm tròn tiền thiếu','',true);
  INSERT INTO public.fixture_receiving VALUES('${BUILDING}','TK','${TK1}',0),('${BUILDING}','TK','${TK2}',1),('${BUILDING}','TT','${TT1}',0),(null,'TM','${TM1}',0),
    ('${OTHER_BUILDING}','TK','${TK1}',0);
  INSERT INTO public.fixture_possession VALUES('${USER}','${TK1}'),('${USER}','${TK2}'),('${USER}','${TT1}'),('${USER}','${TM1}');
  INSERT INTO public.fixture_collect_acl VALUES('${USER}','${BUILDING}'),('${USER}','${OTHER_BUILDING}');
  INSERT INTO public.profiles VALUES('${USER}','Kế toán A'),('${STRANGER}','Quản lý B');
  INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount,contract_id,created_at) VALUES
    ('${INV_A9}','${ORG}','INV-A-09','PAID','${BUILDING}','${ROOM}','2026-09','2026-09-30',1200000,1200000,'${CONTRACT}','2026-09-01'),
    ('${INV_A}','${ORG}','INV-A-10','APPROVED','${BUILDING}','${ROOM}','2026-10','2026-10-30',3650000,0,'${CONTRACT}','2026-10-01'),
    ('${INV_B}','${ORG}','INV-B-10','APPROVED','${BUILDING}','${ROOM2}','2026-10','2026-10-30',2000000,0,null,'2026-10-01'),
    ('${INV_C}','${ORG}','INV-C-10','PAID','${BUILDING}','${ROOM3}','2026-10','2026-10-30',1500000,1500000,'${CONTRACT}','2026-10-01'),
    ('${INV_D9}','${ORG}','INV-D-09','OVERDUE','${BUILDING}','${ROOM4}','2026-09','2026-09-30',1000000,0,'${CONTRACT}','2026-09-01'),
    ('${INV_E}','${ORG}','INV-E-10','APPROVED','${BUILDING}','${ROOM5}','2026-10','2026-10-30',1005000,0,'${CONTRACT}','2026-10-01');
  INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount,contract_id,created_at,previous_debt_sources) VALUES
    ('${INV_D10}','${ORG}','INV-D-10','APPROVED','${BUILDING}','${ROOM4}','2026-10','2026-10-30',2500000,0,'${CONTRACT}','2026-10-01',
      '[{"type":"invoice","id":"${INV_D9}","amount":1000000}]');
  INSERT INTO public.invoice_items(invoice_id,type,description,amount,accounting_class) VALUES('${INV_E}','OTHER','Phí nội bộ',5000,'NON_PNL');`;

// Mốc 4 (chỉ số, meter: true): bảng meters, cột còn thiếu của meter_readings / invoice_items, sổ idempotency canonical_write_operations,
// quyền web (is_super_admin, my_org_ids, buildings_for_v3 theo bảng RIÊNG fixture_meter_acl — tách khỏi quyền v3 của guard như production)
// và năm trigger BEFORE INSERT của production chạy NGUYÊN VĂN (meter-trigger-bodies.json; md5 hai thân ghim ở $requires$ của migration).
const METER_A = file('meter_readings_v2'), METER_PAGE = file('hermes_invoice_meter_v1');
const TRIGGERS = JSON.parse(readFileSync(new URL('./meter-trigger-bodies.json', import.meta.url), 'utf8'));
const trigger = (name, secdef = false) => `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql${secdef ? ' SECURITY DEFINER' : ''}
  SET search_path=public AS $tg$${TRIGGERS[name]}$tg$;`;
export const [ROOM6, M1, M2, M3, M4A, M4B, M5, M6, M7, SERVICE_E] = [815, 841, 842, 843, 844, 845, 846, 847, 848, 849].map(uid);
const METER = `INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES('meter_readings.create','action',false) ON CONFLICT(capability) DO NOTHING;
  CREATE TABLE public.meters(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,code text NOT NULL CHECK(char_length(code)>0),building_id uuid,room_id uuid,
    service_id uuid,meter_type text,name text,initial_reading numeric(10,2) DEFAULT 0,status text DEFAULT 'ACTIVE',deleted_at timestamptz,organization_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  ALTER TABLE public.meter_readings ALTER COLUMN id SET DEFAULT gen_random_uuid(),ALTER COLUMN status SET DEFAULT 'UNAPPROVED',
    ADD COLUMN user_id uuid,ADD COLUMN meter_id uuid,ADD COLUMN contract_id uuid,ADD COLUMN service_id uuid,ADD COLUMN approved_by uuid,ADD COLUMN approved_at timestamptz,
    ADD COLUMN recorded_by uuid,ADD COLUMN boundary_id uuid,ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD CONSTRAINT meter_readings_current_gte_previous CHECK (current_reading>=previous_reading);
  CREATE UNIQUE INDEX idx_meter_readings_code ON public.meter_readings(reading_code) WHERE reading_code IS NOT NULL;
  ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS service_id uuid,ADD COLUMN IF NOT EXISTS previous_reading numeric(10,2),
    ADD COLUMN IF NOT EXISTS current_reading numeric(10,2);
  CREATE TABLE app_private.canonical_write_operations(organization_id uuid NOT NULL,operation text NOT NULL,subject_scope text NOT NULL,actor_id uuid NOT NULL,
    idempotency_key text NOT NULL,payload_hash text NOT NULL CHECK(char_length(payload_hash)=32),subject_id uuid,response_payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,PRIMARY KEY(organization_id,operation,subject_scope,actor_id,idempotency_key),
    CHECK(((completed_at IS NULL)=(response_payload IS NULL)) AND ((completed_at IS NULL)=(subject_id IS NULL))));
  CREATE FUNCTION app_private.guard_canonical_write_operation() RETURNS trigger LANGUAGE plpgsql AS $g$ BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Canonical operation ledger is append-only' USING ERRCODE='55000'; END IF;
    IF OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL THEN RAISE EXCEPTION 'Canonical operation can only transition once to completed' USING ERRCODE='55000'; END IF;
    RETURN NEW; END $g$;
  CREATE TRIGGER canonical_write_operations_immutable BEFORE DELETE OR UPDATE ON app_private.canonical_write_operations FOR EACH ROW
    EXECUTE FUNCTION app_private.guard_canonical_write_operation();
  CREATE TABLE public.fixture_meter_acl(permission text,building_id uuid);
  CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS
    $f$ SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=auth.uid()) $f$;
  CREATE OR REPLACE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS
    $f$ SELECT COALESCE(array_agg(organization_id),'{}') FROM public.organization_memberships WHERE user_id=auth.uid() AND status='ACTIVE' $f$;
  CREATE OR REPLACE FUNCTION app_private.buildings_for_v3(p_permission text) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS
    $f$ SELECT COALESCE(array_agg(a.building_id),'{}') FROM public.fixture_meter_acl a WHERE a.permission=p_permission AND auth.uid()='${USER}' $f$;
  GRANT EXECUTE ON FUNCTION public.is_super_admin(),public.my_org_ids() TO authenticated;
  GRANT SELECT ON public.meters,public.meter_readings TO authenticated;
  ${trigger('public.auto_populate_meter_reading_fields')}
  ${trigger('public.auto_populate_previous_reading')}
  ${trigger('public.auto_generate_reading_code', true)}
  ${trigger('public.set_user_id_from_auth', true)}
  CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $u$ BEGIN NEW.updated_at:=clock_timestamp(); RETURN NEW; END $u$;
  CREATE TRIGGER meter_readings_set_user_id_audit BEFORE INSERT ON public.meter_readings FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
  CREATE TRIGGER trigger_auto_generate_reading_code BEFORE INSERT ON public.meter_readings FOR EACH ROW EXECUTE FUNCTION public.auto_generate_reading_code();
  CREATE TRIGGER trigger_auto_populate_meter_reading_fields BEFORE INSERT ON public.meter_readings FOR EACH ROW EXECUTE FUNCTION public.auto_populate_meter_reading_fields();
  CREATE TRIGGER trigger_auto_populate_previous_reading BEFORE INSERT ON public.meter_readings FOR EACH ROW EXECUTE FUNCTION public.auto_populate_previous_reading();
  CREATE TRIGGER trigger_update_meter_reading_updated_at BEFORE UPDATE ON public.meter_readings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();`;
// Công tơ ĐIỆN (toà A trừ M6): M1 P101 có chỉ số tháng 9; M2 P102 ba kỳ 100 kWh (trung bình 3 kỳ); M3 P103 đã có chỉ số tháng 10 và đã lên
// hoá đơn INV_C; M4A/M4B hai công tơ ở P104; M5 P105 chưa có chỉ số nào, chỉ số ban đầu 2.210; M7 P106 có chỉ số chốt trả phòng TLY tháng 10;
// M6 P201 toà B. Chỉ số lịch sử chèn trực tiếp (trigger điền số đầu như production).
const METER_SEED = `INSERT INTO public.rooms VALUES('${ROOM6}','${ORG}','${BUILDING}','P106','OCCUPIED',null);
  INSERT INTO public.meters(id,user_id,code,building_id,room_id,service_id,meter_type,initial_reading,organization_id) VALUES
    ('${M1}','${USER}','DH-101','${BUILDING}','${ROOM}','${SERVICE_E}','ELECTRICITY',1000,'${ORG}'),
    ('${M2}','${USER}','DH-102','${BUILDING}','${ROOM2}','${SERVICE_E}','ELECTRICITY',400,'${ORG}'),
    ('${M3}','${USER}','DH-103','${BUILDING}','${ROOM3}','${SERVICE_E}','ELECTRICITY',300,'${ORG}'),
    ('${M4A}','${USER}','DH-104A','${BUILDING}','${ROOM4}','${SERVICE_E}','ELECTRICITY',0,'${ORG}'),
    ('${M4B}','${USER}','DH-104B','${BUILDING}','${ROOM4}','${SERVICE_E}','ELECTRICITY',0,'${ORG}'),
    ('${M5}','${USER}','DH-105','${BUILDING}','${ROOM5}','${SERVICE_E}','ELECTRICITY',2210,'${ORG}'),
    ('${M6}','${USER}','DH-201','${OTHER_BUILDING}','${OTHER_ROOM}','${SERVICE_E}','ELECTRICITY',0,'${ORG}'),
    ('${M7}','${USER}','DH-106','${BUILDING}','${ROOM6}','${SERVICE_E}','ELECTRICITY',100,'${ORG}');
  INSERT INTO public.meter_readings(meter_id,reading_date,current_reading,status,organization_id) VALUES('${M1}','2026-09-30',1200,'APPROVED','${ORG}');
  INSERT INTO public.meter_readings(meter_id,reading_date,current_reading,status,organization_id) VALUES('${M2}','2026-07-31',500,'APPROVED','${ORG}');
  INSERT INTO public.meter_readings(meter_id,reading_date,current_reading,status,organization_id) VALUES('${M2}','2026-08-31',600,'APPROVED','${ORG}');
  INSERT INTO public.meter_readings(meter_id,reading_date,current_reading,status,organization_id) VALUES('${M2}','2026-09-30',700,'APPROVED','${ORG}');
  INSERT INTO public.meter_readings(meter_id,reading_date,current_reading,status,organization_id) VALUES('${M3}','2026-10-10',350,'APPROVED','${ORG}');
  INSERT INTO public.meter_readings(meter_id,reading_code,reading_date,current_reading,status,organization_id) VALUES('${M7}','TLY2610001','2026-10-05',150,'APPROVED','${ORG}');
  INSERT INTO public.invoice_items(invoice_id,type,description,amount,current_reading,previous_reading) VALUES('${INV_C}','SERVICE','Tiền điện (300 → 350)',175000,350,300);
  INSERT INTO public.fixture_meter_acl VALUES('meter_readings.create','${BUILDING}'),('meter_readings.create','${OTHER_BUILDING}'),
    ('meter_readings.edit','${BUILDING}'),('meter_readings.edit','${OTHER_BUILDING}');`;

// Mốc 5 (điều chỉnh / xác nhận kiểm tra / huỷ / khôi phục, edit: true — kéo theo meter vì vỏ trang Mốc 5 thay vỏ Mốc 4). Thân PRODUCTION
// chạy NGUYÊN VĂN (invoice-writer-bodies.json, đọc 23/10; md5 kiểm ở invoice-edit-sql.test.mjs): review_invoice_adjustment_v2,
// cancel_invoice_with_credit_v1, restore_invoice_with_credit_v1, invoice_rent_support_lock_v1 (khoá công ty → hợp đồng), dựng/làm tròn dòng
// (normalize_invoice_adjustment_items_v2, round_invoice_total_v1) và rào quyền (require/has_building_perm_v1). adjust_invoice_v2 là BẢN PORT
// (thân thật kéo cả bộ đối soát kế toán): cùng chữ ký, cùng thứ tự khoá (invoice_rent_support_lock_v1 rồi hoá đơn FOR UPDATE), cùng câu
// lỗi mục 5, idempotency theo (hoá đơn, khoá) + vân tay, khoá lạc quan ba giá trị. Hàm phụ credit/sổ chuỗi kế toán là bản port tối giản.
// Quyền ghi web theo bảng RIÊNG fixture_invoice_acl (tách khỏi quyền v3 của guard, như production).
const BUILD = file('invoice_adjustment_build_v1'), EDIT_PAGE = file('hermes_invoice_edit_v1');
export const WRITER_BODIES = JSON.parse(readFileSync(new URL('./invoice-writer-bodies.json', import.meta.url), 'utf8'));
const real = name => { const f = WRITER_BODIES[name];
  return `CREATE OR REPLACE FUNCTION ${name}(${f.args}) RETURNS ${f.result === 'invoice_adjustments' ? 'public.invoice_adjustments' : f.result} LANGUAGE ${f.lang}
  ${f.volatility === 's' ? 'STABLE' : f.volatility === 'i' ? 'IMMUTABLE' : 'VOLATILE'}${f.definer ? ' SECURITY DEFINER' : ''} SET ${f.config} AS $body$${f.body}$body$;`; };
export const [ROOM7, ROOM8, ROOM9, CONTRACT2, CONTRACT3, CONTRACT4, INV_P, INV_S, INV_X, INV_X2, ADJ_P, ADJ_S, INV_O] =
  [816, 817, 818, 837, 838, 839, 851, 852, 853, 854, 855, 856, 857].map(uid);
export const [LINE_RENT, LINE_ELEC, LINE_WATER, LINE_PDV, LINE_PARK, LINE_P, LINE_S, LINE_O] = [861, 862, 863, 864, 865, 866, 867, 868].map(uid);
const EDIT = `INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES('invoices.edit','action',false),('invoices.approve','action',false),
    ('invoices.cancel','action',false) ON CONFLICT(capability) DO NOTHING;
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS subtotal numeric(15,2),ADD COLUMN IF NOT EXISTS discount_amount numeric(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS discount_notes text,ADD COLUMN IF NOT EXISTS previous_debt numeric(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS adjustment_review_status text DEFAULT 'NONE',ADD COLUMN IF NOT EXISTS approved_at timestamptz,ADD COLUMN IF NOT EXISTS approved_by uuid;
  ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS organization_id uuid,ADD COLUMN IF NOT EXISTS unit_price numeric(15,2),
    ADD COLUMN IF NOT EXISTS quantity numeric DEFAULT 1,ADD COLUMN IF NOT EXISTS coefficient numeric DEFAULT 1,ADD COLUMN IF NOT EXISTS from_date date,
    ADD COLUMN IF NOT EXISTS to_date date,ADD COLUMN IF NOT EXISTS sort_order int DEFAULT 0,ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT clock_timestamp(),
    ALTER COLUMN accounting_class SET DEFAULT 'REVENUE';
  UPDATE public.invoice_items SET accounting_class='REVENUE' WHERE accounting_class='PNL';
  CREATE TYPE public.invoice_item_type AS ENUM ('RENT','SERVICE','PENALTY','DISCOUNT','OTHER');
  CREATE TABLE public.services(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
  CREATE TABLE public.invoice_adjustments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,invoice_id uuid NOT NULL,revision bigint NOT NULL,
    idempotency_key text NOT NULL,request_fingerprint text,reason text NOT NULL,before_snapshot jsonb NOT NULL,after_snapshot jsonb NOT NULL,before_total numeric NOT NULL,
    after_total numeric NOT NULL,delta numeric NOT NULL,adjusted_by uuid NOT NULL,adjusted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    review_status text NOT NULL DEFAULT 'PENDING',checked_by uuid,checked_at timestamptz,UNIQUE(invoice_id,revision),UNIQUE(invoice_id,idempotency_key));
  CREATE TABLE public.customer_credit_applications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,invoice_id uuid,amount numeric(15,2),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),reversed_at timestamptz,restored_at timestamptz,restored_by uuid,restoration_idempotency_key text);
  CREATE TABLE public.fixture_invoice_acl(permission text,building_id uuid);
  CREATE TABLE public.fixture_edit(rejected_message text,reject_state text,reject_action text);
  INSERT INTO public.fixture_edit VALUES(null,null,null);
  GRANT SELECT ON public.invoice_adjustments,public.customer_credit_applications TO authenticated;
  CREATE OR REPLACE FUNCTION public.can_do_on_building(_table text,_action text,_building_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$ SELECT EXISTS(SELECT 1 FROM public.fixture_building_access WHERE building_id=_building_id)
      AND (_table||'.'||_action NOT IN ('invoices.edit','invoices.approve','invoices.cancel','invoices.delete')
        OR EXISTS(SELECT 1 FROM public.fixture_invoice_acl a WHERE a.permission=_table||'.'||_action AND a.building_id=_building_id AND auth.uid()='${USER}')) $f$;
  CREATE FUNCTION app_private.can_edit_invoice_building_v1(p_building_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS
    $f$ SELECT public.is_super_admin() OR EXISTS(SELECT 1 FROM public.fixture_invoice_acl a WHERE a.permission='invoices.edit' AND a.building_id=p_building_id
      AND auth.uid()='${USER}') $f$;
  CREATE FUNCTION app_private.assert_invoice_credit_cancellable_v1(p_invoice_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    BEGIN IF EXISTS(SELECT 1 FROM public.fixture_edit WHERE reject_action='cancel_source') THEN
      RAISE EXCEPTION 'Reverse the payment credit source before cancelling this invoice' USING ERRCODE='55000'; END IF; END $f$;
  CREATE FUNCTION app_private.reverse_invoice_customer_credit_v1(p_actor uuid,p_invoice_id uuid,p_reason text,p_idempotency_key text) RETURNS jsonb LANGUAGE plpgsql
    SECURITY DEFINER SET search_path=pg_catalog,public AS $f$ DECLARE v_total numeric; BEGIN
      SELECT COALESCE(sum(amount),0) INTO v_total FROM public.customer_credit_applications WHERE invoice_id=p_invoice_id AND reversed_at IS NULL;
      UPDATE public.customer_credit_applications SET reversed_at=clock_timestamp() WHERE invoice_id=p_invoice_id AND reversed_at IS NULL;
      RETURN jsonb_build_object('invoice_id',p_invoice_id,'reversed_amount',v_total,'applications','[]'::jsonb); END $f$;
  CREATE FUNCTION app_private.apply_customer_credit_fifo_v1(p_actor uuid,p_contract_id uuid,p_amount numeric,p_invoice_id uuid,p_application_kind text,
    p_description text,p_idempotency_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $f$ BEGIN
      PERFORM app_private.lock_org_for_decision_v1((SELECT organization_id FROM public.invoices WHERE id=p_invoice_id));
      INSERT INTO public.customer_credit_applications(organization_id,invoice_id,amount) SELECT organization_id,p_invoice_id,p_amount FROM public.invoices WHERE id=p_invoice_id;
      RETURN jsonb_build_object('invoice_id',p_invoice_id,'applied_amount',p_amount,'applications','[]'::jsonb); END $f$;
  CREATE FUNCTION app_private.begin_accounting_chain_write_v1() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN END $f$;
  CREATE FUNCTION app_private.end_accounting_chain_write_v1() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN END $f$;
  ${['app_private.invoice_rent_support_lock_v1', 'app_private.round_invoice_total_v1', 'app_private.normalize_invoice_adjustment_items_v2',
    'app_private.has_building_perm_v1', 'app_private.require_building_perm_v1', 'public.review_invoice_adjustment_v2', 'public.cancel_invoice_with_credit_v1',
    'public.restore_invoice_with_credit_v1'].map(real).join('\n  ')}
  -- Bản port adjust_invoice_v2 (20260912091403): cùng chữ ký và thứ tự khoá; câu lỗi như mục 5; fixture_edit ép một lỗi bất kỳ.
  CREATE FUNCTION public.adjust_invoice_v2(p_invoice_id uuid,p_after_items jsonb,p_discount_amount numeric,p_discount_notes text,p_notes text,p_reason text,
    p_expected_revision bigint,p_expected_paid_amount numeric,p_expected_updated_at timestamptz,p_idempotency_key text) RETURNS public.invoice_adjustments
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $w$
    DECLARE inv public.invoices%ROWTYPE; result public.invoice_adjustments%ROWTYPE; actor uuid:=auth.uid(); items jsonb; old_items jsonb; v_subtotal numeric;
      total numeric; discount numeric; key text:=btrim(p_idempotency_key); fingerprint text; x jsonb; f public.fixture_edit;
    BEGIN
      PERFORM app_private.invoice_rent_support_lock_v1(p_invoice_id);
      IF actor IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
      SELECT * INTO inv FROM public.invoices WHERE id=p_invoice_id AND deleted_at IS NULL FOR UPDATE;
      IF NOT FOUND OR public.can_access_building(inv.building_id) IS DISTINCT FROM true OR public.can_do_on_building('invoices','edit',inv.building_id) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Không có quyền điều chỉnh hóa đơn trong tổ chức/toà này' USING ERRCODE='42501'; END IF;
      IF key IS NULL OR key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 1000 THEN
        RAISE EXCEPTION 'Lý do phải dài 3–1000 ký tự và khóa yêu cầu phải hợp lệ' USING ERRCODE='22023'; END IF;
      items:=app_private.normalize_invoice_adjustment_items_v2(p_after_items,inv.organization_id);
      discount:=coalesce(p_discount_amount,0);
      IF discount<0 THEN RAISE EXCEPTION 'Giảm giá không hợp lệ' USING ERRCODE='22023'; END IF;
      fingerprint:=md5(jsonb_build_object('items',items,'discount',discount,'discount_notes',p_discount_notes,'notes',p_notes,'reason',btrim(p_reason),
        'revision',p_expected_revision,'paid',p_expected_paid_amount,'updated',p_expected_updated_at)::text);
      SELECT * INTO result FROM public.invoice_adjustments WHERE invoice_id=p_invoice_id AND idempotency_key=key;
      IF FOUND THEN
        IF result.request_fingerprint IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'Khóa yêu cầu đã dùng cho nội dung khác; vui lòng tải lại' USING ERRCODE='23505'; END IF;
        RETURN result; END IF;
      SELECT * INTO f FROM public.fixture_edit;
      IF f.rejected_message IS NOT NULL AND COALESCE(f.reject_action,'adjust')='adjust' THEN
        RAISE EXCEPTION '%',f.rejected_message USING ERRCODE=COALESCE(f.reject_state,'P0001'); END IF;
      IF inv.status NOT IN ('APPROVED','PARTIAL_PAID','PAID','OVERDUE') THEN RAISE EXCEPTION 'Chỉ điều chỉnh hóa đơn đã phát hành' USING ERRCODE='55000'; END IF;
      IF p_expected_revision IS DISTINCT FROM inv.adjustment_revision OR p_expected_paid_amount IS DISTINCT FROM coalesce(inv.paid_amount,0)
        OR p_expected_updated_at IS DISTINCT FROM inv.updated_at THEN RAISE EXCEPTION 'Hóa đơn vừa thay đổi hoặc vừa thu tiền; vui lòng tải lại' USING ERRCODE='PT409'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(items) it WHERE it->>'id' IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM public.invoice_items old WHERE old.id=(it->>'id')::uuid AND old.invoice_id=p_invoice_id)) THEN
        RAISE EXCEPTION 'Hạng mục không thuộc hóa đơn/tổ chức' USING ERRCODE='42501'; END IF;
      IF EXISTS(SELECT 1 FROM public.invoice_payment_collections c WHERE c.invoice_id=p_invoice_id AND c.status='ACTIVE' AND c.rounding_amount<>0)
        OR EXISTS(SELECT 1 FROM public.customer_credit_applications c WHERE c.invoice_id=p_invoice_id AND c.reversed_at IS NULL) THEN
        RAISE EXCEPTION 'Hóa đơn có làm tròn hoặc cấn trừ credit đang hiệu lực; đảo giao dịch trong Lịch sử thanh toán trước khi điều chỉnh' USING ERRCODE='55000'; END IF;
      IF EXISTS(SELECT 1 FROM public.invoices later WHERE later.contract_id=inv.contract_id AND later.billing_month>inv.billing_month AND later.deleted_at IS NULL
        AND later.status<>'CANCELLED' AND later.previous_debt_sources @> jsonb_build_array(jsonb_build_object('type','invoice','id',p_invoice_id::text))) THEN
        RAISE EXCEPTION 'Nợ đã chuyển sang hóa đơn sau; cần tất toán hoặc xử lý hóa đơn sau trước khi điều chỉnh' USING ERRCODE='55000'; END IF;
      SELECT sum((v->>'amount')::numeric) INTO v_subtotal FROM jsonb_array_elements(items) v;
      total:=app_private.round_invoice_total_v1(v_subtotal-discount+coalesce(inv.previous_debt,0));
      IF discount>v_subtotal OR total<0 THEN RAISE EXCEPTION 'Giảm giá hoặc tổng tiền không hợp lệ' USING ERRCODE='22023'; END IF;
      SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.sort_order,i.id),'[]') INTO old_items FROM public.invoice_items i WHERE i.invoice_id=p_invoice_id;
      IF jsonb_array_length(old_items)>0 AND (SELECT jsonb_agg(it-'id') FROM jsonb_array_elements(items) it)
        =(SELECT jsonb_agg(it-'id') FROM jsonb_array_elements(app_private.normalize_invoice_adjustment_items_v2(old_items,inv.organization_id)) it)
        AND discount=coalesce(inv.discount_amount,0) AND p_discount_notes IS NOT DISTINCT FROM inv.discount_notes AND p_notes IS NOT DISTINCT FROM inv.notes THEN
        RAISE EXCEPTION 'Không có thay đổi nội dung hóa đơn' USING ERRCODE='22023'; END IF;
      SELECT jsonb_agg(it||jsonb_build_object('id',coalesce((it->>'id')::uuid,gen_random_uuid())) ORDER BY ord) INTO items
        FROM jsonb_array_elements(items) WITH ORDINALITY row_item(it,ord);
      INSERT INTO public.invoice_adjustments(organization_id,invoice_id,revision,idempotency_key,request_fingerprint,reason,before_snapshot,after_snapshot,before_total,
        after_total,delta,adjusted_by) VALUES(inv.organization_id,p_invoice_id,inv.adjustment_revision+1,key,fingerprint,btrim(p_reason),
        to_jsonb(inv)||jsonb_build_object('items',old_items),to_jsonb(inv)||jsonb_build_object('items',items,'subtotal',v_subtotal,'total_amount',total,
          'discount_amount',discount),inv.total_amount,total,total-inv.total_amount,actor) RETURNING * INTO result;
      DELETE FROM public.invoice_items WHERE invoice_id=p_invoice_id;
      FOR x IN SELECT value FROM jsonb_array_elements(items) LOOP
        INSERT INTO public.invoice_items(id,invoice_id,organization_id,service_id,type,description,unit_price,quantity,coefficient,amount,previous_reading,current_reading,
          from_date,to_date,sort_order,accounting_class) VALUES((x->>'id')::uuid,p_invoice_id,inv.organization_id,(x->>'service_id')::uuid,x->>'type',x->>'description',
          (x->>'unit_price')::numeric,(x->>'quantity')::numeric,(x->>'coefficient')::numeric,(x->>'amount')::numeric,(x->>'previous_reading')::numeric,
          (x->>'current_reading')::numeric,(x->>'from_date')::date,(x->>'to_date')::date,(x->>'sort_order')::integer,x->>'accounting_class');
      END LOOP;
      IF total<coalesce(inv.paid_amount,0) THEN
        RAISE EXCEPTION 'Nội dung mới thấp hơn tiền đã phân bổ; đảo giao dịch trong Lịch sử thanh toán trước khi điều chỉnh' USING ERRCODE='55000'; END IF;
      UPDATE public.invoices SET subtotal=v_subtotal,total_amount=total,discount_amount=discount,discount_notes=p_discount_notes,notes=p_notes,
        adjustment_revision=result.revision,adjustment_review_status='PENDING',updated_at=clock_timestamp(),
        status=CASE WHEN coalesce(paid_amount,0)>=total AND total>0 THEN 'PAID' WHEN coalesce(paid_amount,0)>0 THEN 'PARTIAL_PAID'
          WHEN status='OVERDUE' THEN 'OVERDUE' ELSE 'APPROVED' END WHERE id=p_invoice_id;
      RETURN result;
    END $w$;
  GRANT EXECUTE ON FUNCTION public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text),public.review_invoice_adjustment_v2(uuid,bigint),
    public.cancel_invoice_with_credit_v1(uuid,text),public.restore_invoice_with_credit_v1(uuid,text) TO authenticated;`;
// P101 (INV_A, 3.650.000đ, HĐ CONTRACT): tiền phòng, điện có chỉ số, nước theo người (khoá theo mô tả), PDV, gửi xe (thành tiền lệch đơn giá ×
// SL ⇒ dòng giữ nguyên quy về đơn giá = thành tiền). P107 (INV_P): điều chỉnh lần 1 CHỜ KIỂM do người khác làm (Quản lý B). P108 (INV_S):
// điều chỉnh chờ kiểm do CHÍNH người hỏi làm. P109 (INV_X): hoá đơn đã huỷ, có tiền dư khách đã hoàn chờ cấn lại. P107 còn INV_X2 đã huỷ cùng
// HĐ, cùng kỳ với INV_P đang hiệu lực (khôi phục ⇒ trùng kỳ). INV_D10 gánh nợ cũ INV_D9 và có tiền dư đã cấn. INV_E có nợ cũ không nguồn.
// INV_O ở toà B: guard cho, quyền ghi web (fixture_invoice_acl) chỉ có toà A.
const EDIT_SEED = `INSERT INTO public.rooms VALUES('${ROOM7}','${ORG}','${BUILDING}','P107','OCCUPIED',null),('${ROOM8}','${ORG}','${BUILDING}','P108','OCCUPIED',null),
    ('${ROOM9}','${ORG}','${BUILDING}','P109','OCCUPIED',null);
  INSERT INTO public.contracts(id,organization_id,room_id,status) VALUES('${CONTRACT}','${ORG}','${ROOM}','ACTIVE'),('${CONTRACT2}','${ORG}','${ROOM7}','ACTIVE'),
    ('${CONTRACT3}','${ORG}','${ROOM8}','ACTIVE'),('${CONTRACT4}','${ORG}','${ROOM9}','ACTIVE') ON CONFLICT(id) DO NOTHING;
  UPDATE public.invoices SET subtotal=total_amount,discount_amount=0;
  UPDATE public.invoices SET previous_debt=1000000 WHERE id='${INV_D10}';
  UPDATE public.invoices SET previous_debt=300000 WHERE id='${INV_E}';
  INSERT INTO public.invoice_items(id,invoice_id,organization_id,type,description,unit_price,quantity,coefficient,amount,previous_reading,current_reading,sort_order,accounting_class) VALUES
    ('${LINE_RENT}','${INV_A}','${ORG}','RENT','Tiền phòng tháng 10/2026',3000000,1,1,3000000,null,null,0,'REVENUE'),
    ('${LINE_ELEC}','${INV_A}','${ORG}','SERVICE','Tiền điện (1.200 → 1.250)',3500,50,1,175000,1200,1250,1,'REVENUE'),
    ('${LINE_WATER}','${INV_A}','${ORG}','SERVICE','Tiền Nước (2 người)',100000,2,1,200000,null,null,2,'REVENUE'),
    ('${LINE_PDV}','${INV_A}','${ORG}','SERVICE','Phí dịch vụ',150000,1,1,150000,null,null,3,'REVENUE'),
    ('${LINE_PARK}','${INV_A}','${ORG}','OTHER','Phí gửi xe máy',100000,1,1,125000,null,null,4,'REVENUE');
  INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount,contract_id,created_at,subtotal,
    discount_amount,adjustment_revision,adjustment_review_status) VALUES
    ('${INV_P}','${ORG}','INV-P-10','APPROVED','${BUILDING}','${ROOM7}','2026-10','2026-10-30',1900000,0,'${CONTRACT2}','2026-10-01',1900000,0,1,'PENDING'),
    ('${INV_S}','${ORG}','INV-S-10','APPROVED','${BUILDING}','${ROOM8}','2026-10','2026-10-30',1500000,0,'${CONTRACT3}','2026-10-01',1500000,0,1,'PENDING'),
    ('${INV_X}','${ORG}','INV-X-10','CANCELLED','${BUILDING}','${ROOM9}','2026-10','2026-10-15',1200000,0,'${CONTRACT4}','2026-10-01',1200000,0,0,'NONE'),
    ('${INV_X2}','${ORG}','INV-X2-10','CANCELLED','${BUILDING}','${ROOM7}','2026-10','2026-10-30',2000000,0,'${CONTRACT2}','2026-09-30',2000000,0,0,'NONE'),
    ('${INV_O}','${ORG}','INV-O-10','APPROVED','${OTHER_BUILDING}','${OTHER_ROOM}','2026-10','2026-10-30',800000,0,null,'2026-10-01',800000,0,0,'NONE');
  INSERT INTO public.invoice_items(id,invoice_id,organization_id,type,description,unit_price,quantity,coefficient,amount,sort_order,accounting_class) VALUES
    ('${LINE_P}','${INV_P}','${ORG}','RENT','Tiền phòng',1900000,1,1,1900000,0,'REVENUE'),('${LINE_S}','${INV_S}','${ORG}','RENT','Tiền phòng',1500000,1,1,1500000,0,'REVENUE'),
    ('${LINE_O}','${INV_O}','${ORG}','RENT','Tiền phòng',800000,1,1,800000,0,'REVENUE');
  INSERT INTO public.invoice_items(invoice_id,organization_id,type,description,unit_price,quantity,coefficient,amount,sort_order,accounting_class) VALUES
    ('${INV_B}','${ORG}','RENT','Tiền phòng',2000000,1,1,2000000,0,'REVENUE'),('${INV_D9}','${ORG}','RENT','Tiền phòng',1000000,1,1,1000000,0,'REVENUE'),
    ('${INV_D10}','${ORG}','RENT','Tiền phòng',1500000,1,1,1500000,0,'REVENUE');
  INSERT INTO public.invoice_adjustments(id,organization_id,invoice_id,revision,idempotency_key,request_fingerprint,reason,before_snapshot,after_snapshot,before_total,
    after_total,delta,adjusted_by,adjusted_at) VALUES
    ('${ADJ_P}','${ORG}','${INV_P}',1,'web-adj-00000001','f','Giảm tiền phòng do sửa chữa',
      '{"discount_amount":0,"items":[{"id":"${LINE_P}","description":"Tiền phòng","amount":2000000}]}',
      '{"discount_amount":0,"items":[{"id":"${LINE_P}","description":"Tiền phòng","amount":1900000}]}',2000000,1900000,-100000,'${STRANGER}','2026-10-20 08:20:00+00'),
    ('${ADJ_S}','${ORG}','${INV_S}',1,'web-adj-00000002','f','Bớt tiền phòng cho khách quen',
      '{"discount_amount":0,"items":[{"id":"${LINE_S}","description":"Tiền phòng","amount":1600000}]}',
      '{"discount_amount":0,"items":[{"id":"${LINE_S}","description":"Tiền phòng","amount":1500000}]}',1600000,1500000,-100000,'${USER}','2026-10-21 02:00:00+00');
  INSERT INTO public.customer_credit_applications(organization_id,invoice_id,amount) VALUES('${ORG}','${INV_D10}',50000);
  INSERT INTO public.customer_credit_applications(organization_id,invoice_id,amount,reversed_at) VALUES('${ORG}','${INV_X}',50000,'2026-10-16 03:00:00+00');
  INSERT INTO public.fixture_invoice_acl VALUES('invoices.edit','${BUILDING}'),('invoices.approve','${BUILDING}'),('invoices.cancel','${BUILDING}');`;

export async function invoiceSetup(t, { database, meter = false, edit = false } = {}) {
  const f = await setup(t, { action: `${readFileSync(ACTION_PATH, 'utf8')}\n${SUPPORT}\n${RESOLVE}`, database });
  const { db, call } = f;
  const exec = async (label, sql) => { try { await db.exec(sql); } catch (error) { error.message = `${label}: ${error.message}`; throw error; } };
  await exec('web', WEB); await exec('foundation', FOUNDATION);
  for (const name of ['app_private.hermes_vnd_text_v1', 'app_private.hermes_vn_date_text_v1']) await exec(name, statement(EXPENSE, name));
  await exec('room invoices', statement(SHARED, 'public.invoice_room_invoices_v1'));
  for (const [label, sql] of [['plan', PLAN], ['plan#2', PLAN], ['page', PAGE], ['page#2', PAGE]]) await exec(label, sql); // Idempotent.
  await exec('seed', SEED);
  await db.query("INSERT INTO public.fixture_acl(permission,building_ids) VALUES('buildings.view',$1),('thu_tien.collect',$1) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true", [[BUILDING, OTHER_BUILDING]]);
  // Khoá TẮT sau migration (trạng thái production); bật trong fixture như script TEST.
  assert.equal((await db.query("SELECT enabled FROM app_private.hermes_capabilities WHERE capability='thu_tien.collect_transfer'")).rows[0].enabled, false);
  await db.query("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='thu_tien.collect_transfer'");
  for (const table of ['hermes_org_policies', 'hermes_connections'])
    await db.query(`UPDATE app_private.${table} SET action_capabilities=array_append(action_capabilities,'thu_tien.collect_transfer')`);
  if (meter || edit) {
    await exec('meter fixture', METER);
    for (const [label, sql] of [['meter v2', METER_A], ['meter v2#2', METER_A], ['meter page', METER_PAGE], ['meter page#2', METER_PAGE]]) await exec(label, sql);
    await exec('meter seed', METER_SEED);
    await db.query("INSERT INTO public.fixture_acl(permission,building_ids) VALUES('meter_readings.create',$1) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true", [[BUILDING, OTHER_BUILDING]]);
    assert.equal((await db.query("SELECT enabled FROM app_private.hermes_capabilities WHERE capability='meter_readings.create'")).rows[0].enabled, false);
    await db.query("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='meter_readings.create'");
    for (const table of ['hermes_org_policies', 'hermes_connections'])
      await db.query(`UPDATE app_private.${table} SET action_capabilities=array_append(action_capabilities,'meter_readings.create')`);
  }
  if (edit) {
    await exec('edit fixture', EDIT);
    for (const [label, sql] of [['build', BUILD], ['build#2', BUILD], ['edit page', EDIT_PAGE], ['edit page#2', EDIT_PAGE]]) await exec(label, sql);
    await exec('edit seed', EDIT_SEED);
    for (const key of ['invoices.edit', 'invoices.approve', 'invoices.cancel']) {
      await db.query('INSERT INTO public.fixture_acl(permission,building_ids) VALUES($1,$2) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true',
        [key, [BUILDING, OTHER_BUILDING]]);
      assert.equal((await db.query('SELECT enabled FROM app_private.hermes_capabilities WHERE capability=$1', [key])).rows[0].enabled, false);
      await db.query('UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability=$1', [key]);
      for (const table of ['hermes_org_policies', 'hermes_connections'])
        await db.query(`UPDATE app_private.${table} SET action_capabilities=array_append(action_capabilities,$1)`, [key]);
    }
  }
  const run = (phase, requestId, params, extra = {}) => call(
    'SELECT public.hermes_invoice_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result',
    [JSON.stringify(binding), extra.action ?? 'invoice.collect', phase, requestId, JSON.stringify(params), extra.resolved ? JSON.stringify(extra.resolved) : null, extra.basis ?? null]);
  const applyWith = (requestId, params, preview) => run('apply', requestId, params, { resolved: preview.resolved, basis: preview.basis });
  const trace = async () => (await db.query(`SELECT (SELECT count(*)::int FROM public.invoice_payment_collections) collections,
    (SELECT count(*)::int FROM public.fixture_v5_ops) ops,(SELECT count(*)::int FROM app_private.hermes_action_receipts) receipts,
    (SELECT COALESCE(sum(paid_amount),0)::bigint::text FROM public.invoices) paid`)).rows[0];
  const one = (extra = {}) => ({ buildingName: 'toa a', roomName: 'p101', method: 'TK', ...extra });
  const meterRun = (phase, requestId, params, extra = {}) => run(phase, requestId, params, { ...extra, action: 'invoice.meter_record' });
  const meterApply = (requestId, params, preview) => meterRun('apply', requestId, params, { resolved: preview.resolved, basis: preview.basis });
  const editRun = (action, phase, requestId, params, extra = {}) => run(phase, requestId, params, { ...extra, action });
  const editApply = (action, requestId, params, preview) => editRun(action, 'apply', requestId, params, { resolved: preview.resolved, basis: preview.basis });
  return { ...f, exec, run, applyWith, trace, one, meterRun, meterApply, editRun, editApply };
}
