import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setup, binding, ACTION_PATH, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, CASHBOOK, ORG, USER } from './finance-fixture.mjs';
import { ACTION_REASON_CODES, ACTION_INPUT_REASONS } from './action-reasons.mjs';

// RPC trang Hoá đơn (Đợt 3 Mốc 3, HOA-DON-THAO-TAC-GHI.md mục 2–5, 4.1) trên PGlite với fixture Hermes của thu chi (binding/phiên/chính
// sách thật của các migration Hermes; quyền CRM giả qua fixture_acl). Hai migration của mốc chạy THẬT (mỗi file hai lượt), hàm kế hoạch dùng
// chung thật, invoice_room_invoices_v1 thật (Mốc 2), nợ thực #267 thật. Hàm ghi web record_invoice_collection_v5 ở đây là BẢN PORT (cùng
// chữ ký, cùng câu lỗi đã liệt kê ở mục 5, idempotency theo khoá + băm, khoá lạc quan p_expected_paid_amount) — nó chứng minh logic của
// bước ghi Hermes (chạy thử không để lại dấu vết, lô cả-hoặc-không, basis, lý do, phạm vi), KHÔNG chứng minh v5 thật: phần đó đo ở tầng 2.
const file = slug => { const found = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name)); assert.equal(found.length, 1, slug);
  return readFileSync(`supabase/migrations/${found[0]}`, 'utf8').replaceAll('\r\n', '\n'); };
const statement = (sql, name) => { const match = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?\\$fn\\$;`));
  assert.ok(match, name); return match[0]; };
const RESOLVE = file('hermes_write_name_resolve_v1'), FOUNDATION = file('hermes_action_foundation_v1');
const EXPENSE = file('hermes_expense_write_v1'), SHARED = file('hermes_w2a_invoice_shared_v1');
const PLAN = file('invoice_collection_plan_v1'), PAGE = file('hermes_invoice_action_v1');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rid = n => uid(900 + n);
const code = expected => error => error.code === expected;
const [ROOM2, ROOM3, ROOM4, ROOM5] = [811, 812, 813, 814].map(uid);
const [INV_A, INV_A9, INV_B, INV_C, INV_D9, INV_D10, INV_E] = [821, 822, 823, 824, 825, 826, 827].map(uid);
const [TK1, TK2, TT1, TM1, ROUNDING, CONTRACT, STRANGER] = [831, 832, 833, 834, 835, 836, 877].map(uid);
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
    ('${TK2}','${ORG}','${USER}','MB toà A','',false),('${TT1}','${ORG}','${USER}','Sổ HKD toà A','',false),('${TM1}','${ORG}','${USER}','Tiền mặt người thu','',false),
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

test('hermes_invoice_action_v1 (invoice.collect): tiền mặt chặn, chạy thử không để lại dấu vết, lô cả-hoặc-không, basis, lý do, phạm vi', { timeout: 300000 }, async t => {
  const f = await setup(t, { action: `${readFileSync(ACTION_PATH, 'utf8')}\n${SUPPORT}\n${RESOLVE}` });
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
  const run = (phase, requestId, params, extra = {}) => call(
    'SELECT public.hermes_invoice_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result',
    [JSON.stringify(binding), extra.action ?? 'invoice.collect', phase, requestId, JSON.stringify(params), extra.resolved ? JSON.stringify(extra.resolved) : null, extra.basis ?? null]);
  const applyWith = (requestId, params, preview) => run('apply', requestId, params, { resolved: preview.resolved, basis: preview.basis });
  const trace = async () => (await db.query(`SELECT (SELECT count(*)::int FROM public.invoice_payment_collections) collections,
    (SELECT count(*)::int FROM public.fixture_v5_ops) ops,(SELECT count(*)::int FROM app_private.hermes_action_receipts) receipts,
    (SELECT COALESCE(sum(paid_amount),0)::bigint::text FROM public.invoices) paid`)).rows[0];
  const one = (extra = {}) => ({ buildingName: 'toa a', roomName: 'p101', method: 'TK', ...extra });

  await t.test('tiền mặt ⇒ cash_collection_web_only trước mọi tra cứu, cả lượt 2', async () => {
    assert.deepEqual(await run('preview', rid(1), one({ method: 'TM', buildingName: 'không có toà này' })), { kind: 'rejected', reason: 'cash_collection_web_only' });
    assert.deepEqual(await run('apply', rid(1), one({ method: 'TM' }), { resolved: { buildingId: BUILDING }, basis: 'x' }), { kind: 'rejected', reason: 'cash_collection_web_only' });
  });

  await t.test('một phòng, kỳ trống = hoá đơn còn nợ DUY NHẤT; chạy thử v5 rồi lùi; lượt 2 ghi đúng bản đã xem; phát lại', async () => {
    const before = await trace();
    const preview = await run('preview', rid(2), one());
    assert.equal(preview.kind, 'preview', JSON.stringify(preview)); assert.equal(preview.confirm, 'required');
    assert.equal(preview.resolved.items[0].invoiceId, INV_A, 'kỳ 09 đã thu đủ ⇒ chọn kỳ 10');
    assert.match(preview.preview.summary, /^Sẽ ghi THU 3\.650\.000đ chuyển khoản ngày 22\/10\/2026 \(thứ Năm, hôm nay\) vào sổ «VCB toà A \*\*\*» cho hoá đơn INV-A-10\.$/);
    assert.deepEqual([preview.preview.items[0].amount, preview.preview.items[0].remainingBefore, preview.preview.items[0].remainingAfter, preview.preview.items[0].statusAfter],
      ['3650000', '3650000', '0', 'PAID']);
    assert.match(preview.preview.items[0].text, /Phòng P101 toà Toà A, kỳ 10\/2026 \(INV-A-10\): thu 3\.650\.000đ; còn nợ 3\.650\.000đ → 0đ: ĐÃ THANH TOÁN ĐỦ\./);
    assert.deepEqual(await trace(), before, 'chạy thử không để lại lần thu, khoá idempotency, biên nhận hay tiền');
    const applied = await applyWith(rid(2), one(), preview);
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    assert.equal(applied.link, `/invoices/${INV_A}`);
    assert.deepEqual([applied.result.invoices[0].applied, applied.result.invoices[0].statusAfter, applied.result.applied], ['3650000', 'PAID', '3650000']);
    const row = (await db.query('SELECT idempotency_key,tenders FROM public.invoice_payment_collections WHERE invoice_id=$1', [INV_A])).rows[0];
    assert.equal(row.idempotency_key, `hermes-inv:${rid(2)}`);
    assert.deepEqual(row.tenders, [{ payment_method: 'TK', gross_amount: 3650000, account_id: TK1 }]);
    assert.deepEqual(await applyWith(rid(2), one(), preview), applied, 'phát lại y nguyên');
    const after = await trace();
    assert.deepEqual([after.collections - before.collections, after.receipts - before.receipts], [1, 1]);
    // Hoá đơn hết nợ ⇒ hỏi lại (needs_input), không phải lỗi.
    assert.deepEqual(await run('preview', rid(3), one({ month: '2026-10' })), { kind: 'rejected', reason: 'nothing_to_collect' });
    assert.ok(ACTION_INPUT_REASONS.includes('nothing_to_collect'));
  });

  await t.test('nợ đã kéo sang kỳ sau (#267): kỳ trống chọn hoá đơn gánh; nêu kỳ cũ ⇒ debt_carried', async () => {
    const preview = await run('preview', rid(4), one({ roomName: 'P104' }));
    assert.equal(preview.resolved.items[0].invoiceId, INV_D10, 'không bao giờ chọn kỳ 09 có nợ đã nằm trong kỳ 10');
    assert.equal(preview.preview.items[0].amount, '2500000');
    assert.deepEqual(await run('preview', rid(5), one({ roomName: 'P104', month: '2026-09' })), { kind: 'rejected', reason: 'debt_carried' });
  });

  await t.test('khách trả dư: chưa chọn ⇒ bản xem trước HỎI (choiceRequired), lượt 2 không ghi; keep / return', async () => {
    await f.rollbackCase(async () => {
      const params = one({ roomName: 'P104', amount: 2600000 });
      const ask = await run('preview', rid(6), params);
      assert.deepEqual([ask.kind, ask.preview.choiceRequired], ['preview', 'overpay']);
      assert.match(ask.preview.summary, /^Khách trả 2\.600\.000đ, còn nợ 2\.500\.000đ, dư 100\.000đ\. CHƯA chọn: giữ lại cho kỳ sau \(overpay=keep\) hay trả lại khách \(overpay=return\)\?/);
      const before = await trace();
      assert.deepEqual(await applyWith(rid(6), params, ask), { kind: 'rejected', reason: 'overpay_needs_choice' });
      assert.deepEqual(await trace(), before);
      const keep = await run('preview', rid(7), { ...params, overpay: 'keep' });
      assert.match(keep.preview.items[0].text, /dư 100\.000đ giữ lại cho kỳ sau/);
      const applied = await applyWith(rid(7), { ...params, overpay: 'keep' }, keep);
      assert.deepEqual([applied.result.invoices[0].applied, applied.result.invoices[0].credit], ['2500000', '100000']);
      // Không gắn hợp đồng ⇒ chỉ trả lại khách được; return ⇒ chỉ ghi đúng số còn nợ.
      const noContract = await run('preview', rid(8), one({ roomName: 'P102', amount: 2100000 }));
      assert.match(noContract.preview.summary, /chỉ trả lại khách được \(overpay=return\)/);
      assert.deepEqual(await run('preview', rid(9), one({ roomName: 'P102', amount: 2100000, overpay: 'keep' })), { kind: 'rejected', reason: 'credit_requires_contract' });
      const ret = await run('preview', rid(10), one({ roomName: 'P102', amount: 2100000, overpay: 'return' }));
      assert.match(ret.preview.items[0].text, /phần dư 100\.000đ KHÔNG ghi vào CRM, anh\/chị tự chuyển trả khách/);
      assert.equal(ret.preview.items[0].amount, '2000000');
    });
  });

  await t.test('thiếu < 10.000đ làm tròn như web; v5 chặn làm tròn (NON_PNL) ⇒ xem trước lại KHÔNG làm tròn, nói rõ', async () => {
    await f.rollbackCase(async () => {
      const round = await run('preview', rid(11), one({ roomName: 'P102', amount: 1995000 }));
      assert.match(round.preview.items[0].text, /\(làm tròn bỏ qua 5\.000đ\)/);
      const applied = await applyWith(rid(11), one({ roomName: 'P102', amount: 1995000 }), round);
      assert.deepEqual([applied.result.invoices[0].rounding, applied.result.invoices[0].statusAfter], ['5000', 'PAID']);
      assert.deepEqual((await db.query('SELECT tenders FROM public.invoice_payment_collections WHERE invoice_id=$1', [INV_B])).rows[0].tenders,
        [{ payment_method: 'TK', gross_amount: 1995000, account_id: TK1, rounding_account_id: ROUNDING }]);
      const blocked = await run('preview', rid(12), one({ roomName: 'P105', amount: 1000000 }));
      assert.equal(blocked.kind, 'preview', JSON.stringify(blocked));
      assert.equal(blocked.resolved.noRounding, true);
      assert.ok(blocked.warnings.some(w => /không làm tròn được phần thiếu 5\.000đ \(phần thiếu là tiền cọc\)/.test(w)), blocked.warnings.join('\n'));
      const done = await applyWith(rid(12), one({ roomName: 'P105', amount: 1000000 }), blocked);
      assert.deepEqual([done.kind, done.result.invoices[0].statusAfter, done.result.invoices[0].remainingAfter], ['applied', 'PARTIAL_PAID', '5000']);
    });
  });

  await t.test('lô cùng toà: mục đã thu đủ bị loại và nêu ở bản xem trước (HDN2); lượt 2 cả tập hoặc không gì', async () => {
    await f.rollbackCase(async () => {
      const params = { buildingName: 'Toà A', method: 'TT', items: [{ roomName: 'P102' }, { roomName: 'P103' }, { roomName: 'P104' }] };
      const preview = await run('preview', rid(13), params);
      assert.equal(preview.kind, 'preview', JSON.stringify(preview));
      assert.deepEqual(preview.preview.items.map(i => [i.room, i.amount]), [['P102', '2000000'], ['P104', '2500000']]);
      assert.deepEqual(preview.preview.excluded, ['P103: hoá đơn không còn số phải thu — bỏ khỏi lần ghi này']);
      assert.match(preview.preview.summary, /^Sẽ ghi THU 4\.500\.000đ vào sổ HKD \(TT\) ngày .* vào sổ «Sổ HKD toà A» cho 2 hoá đơn\.$/);
      const before = await trace();
      // Một hoá đơn bị v5 từ chối ở lượt 2 (sau khi lượt 1 chạy thử qua) ⇒ không hoá đơn nào được ghi, biên nhận lùi theo.
      await db.query('UPDATE public.fixture_v5 SET rejected_message=$1,reject_state=$2,reject_invoice=$3', ['[PROFIT_LOCKED] tháng đã chốt', 'P0001', INV_D10]);
      assert.deepEqual(await applyWith(rid(13), params, preview), { kind: 'rejected', reason: 'state_changed' });
      assert.deepEqual(await trace(), before);
      assert.deepEqual(await run('preview', rid(14), params), { kind: 'rejected', reason: 'period_locked' }, 'xem trước lại bắt sớm');
      await db.query('UPDATE public.fixture_v5 SET rejected_message=NULL,reject_state=NULL,reject_invoice=NULL');
      const fresh = await run('preview', rid(15), params);
      const applied = await applyWith(rid(15), params, fresh);
      assert.deepEqual([applied.link, applied.result.invoices.length, applied.result.applied], ['/invoices', 2, '4500000']);
      assert.deepEqual((await db.query("SELECT idempotency_key FROM public.invoice_payment_collections WHERE idempotency_key LIKE $1 ORDER BY 1", [`hermes-inv:${rid(15)}:%`])).rows
        .map(r => r.idempotency_key), [`hermes-inv:${rid(15)}:1`, `hermes-inv:${rid(15)}:3`]);
      // Cả lô đều không thu được ⇒ lý do của mục đầu.
      assert.deepEqual(await run('preview', rid(16), { buildingName: 'Toà A', method: 'TT', items: [{ roomName: 'P103' }, { roomName: 'P101', month: '2026-09' }] }),
        { kind: 'rejected', reason: 'nothing_to_collect' });
    });
  });

  await t.test('basis: người khác vừa thu giữa hai lượt ⇒ state_changed, không mở biên nhận', async () => {
    await f.rollbackCase(async () => {
      const preview = await run('preview', rid(17), one({ roomName: 'P102', amount: 500000 }));
      await db.query('UPDATE public.invoices SET paid_amount=100000,status=$2 WHERE id=$1', [INV_B, 'PARTIAL_PAID']);
      const before = await trace();
      assert.deepEqual(await applyWith(rid(17), one({ roomName: 'P102', amount: 500000 }), preview), { kind: 'rejected', reason: 'state_changed' });
      assert.deepEqual(await trace(), before);
    });
  });

  await t.test('giải tên: kỳ mơ hồ ⇒ hỏi lại có ứng viên; sổ theo tên trong danh sách sổ nhận; tham số chéo sai ⇒ invalid_params', async () => {
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.invoices SET status='APPROVED',paid_amount=0 WHERE id=ANY($1)", [[INV_A9, INV_A]]);
      const vague = await run('preview', rid(18), one());
      assert.deepEqual([vague.kind, vague.field, vague.why, vague.candidates.map(c => c.name)],
        ['needs_input', 'invoice', 'ambiguous', ['kỳ 10/2026 (còn 3.650.000đ)', 'kỳ 09/2026 (còn 1.200.000đ)']]);
      assert.equal((await run('preview', rid(19), one({ month: '2026-09' }))).resolved.items[0].invoiceId, INV_A9);
    });
    const named = await run('preview', rid(20), one({ roomName: 'P102', amount: 100000, cashbookName: 'mb' }));
    assert.equal(named.resolved.accountId, TK2);
    assert.match(named.preview.summary, /vào sổ «MB toà A»/);
    const wrongBook = await run('preview', rid(21), one({ roomName: 'P102', amount: 100000, cashbookName: 'quỹ lạ' }));
    assert.deepEqual([wrongBook.kind, wrongBook.field, wrongBook.why, wrongBook.candidates.map(c => c.name)],
      ['needs_input', 'cashbook', 'not_visible', ['VCB toà A ***', 'MB toà A']]);
    for (const bad of [{ buildingName: 'Toà A', method: 'TK' }, { ...one(), items: [{ roomName: 'P102' }] },
      { buildingName: 'Toà A', method: 'TK', amount: 1000, items: [{ roomName: 'P102' }] }, { buildingName: 'Toà A', method: 'TK', items: [{ roomName: 'P102' }, { roomName: 'p102' }] }])
      assert.deepEqual(await run('preview', rid(22), bad), { kind: 'rejected', reason: 'invalid_params' }, JSON.stringify(bad));
    assert.deepEqual(await run('preview', rid(23), one({ date: '2026-10-23' })), { kind: 'rejected', reason: 'date_out_of_range' });
  });

  await t.test('phạm vi = guard ∩ quyền thu của v5: toà guard cho mà v5 không cho ⇒ ngoài phạm vi ngay ở bản xem trước; bản đã giải giả ⇒ not_allowed', async () => {
    await f.rollbackCase(async () => {
      await db.query("INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount,contract_id) VALUES($1,$2,'INV-OB-10','APPROVED',$3,$4,'2026-10','2026-10-30',900000,0,$5)",
        [uid(828), ORG, OTHER_BUILDING, OTHER_ROOM, CONTRACT]);
      await db.query("UPDATE public.authorization_scopes SET scope_type='ORGANIZATION',building_id=NULL WHERE organization_id=$1 AND scope_type='BUILDING'", [ORG]);
      const ok = await run('preview', rid(24), { buildingName: 'Toà B', roomName: 'P201', method: 'TK' });
      assert.equal(ok.kind, 'preview', 'toà B: cả guard lẫn v5 cho');
      await db.query('DELETE FROM public.fixture_collect_acl WHERE building_id=$1', [OTHER_BUILDING]);
      assert.deepEqual(await run('preview', rid(25), { buildingName: 'Toà B', roomName: 'P201', method: 'TK' }),
        { kind: 'needs_input', reason: 'name_unresolved', field: 'building', wanted: 'Toà B', why: 'outside_scope', candidates: [], more: false });
      // Lượt 2 đưa bản đã giải sang toà B ⇒ not_allowed TRƯỚC biên nhận.
      const before = await trace();
      assert.deepEqual(await run('apply', rid(24), { buildingName: 'Toà B', roomName: 'P201', method: 'TK' }, { resolved: ok.resolved, basis: ok.basis }),
        { kind: 'rejected', reason: 'not_allowed' });
      const a = await run('preview', rid(26), one({ roomName: 'P102', amount: 1000 }));
      for (const forged of [{ ...a.resolved, items: [{ ...a.resolved.items[0], roomId: ROOM }] }, { ...a.resolved, items: [{ ...a.resolved.items[0], invoiceId: uid(828) }] },
        { ...a.resolved, method: 'TT' }])
        assert.deepEqual(await run('apply', rid(26), one({ roomName: 'P102', amount: 1000 }), { resolved: forged, basis: a.basis }), { kind: 'rejected', reason: 'not_allowed' }, JSON.stringify(forged));
      assert.deepEqual(await run('apply', rid(26), one({ roomName: 'P102', amount: 1000 }), { resolved: { ...a.resolved, accountId: CASHBOOK }, basis: a.basis }),
        { kind: 'rejected', reason: 'receiving_book_missing' });
      assert.deepEqual(await trace(), before);
    });
  });

  await t.test('lỗi v5 ở lượt 1 ⇒ lý do đóng của trang; lỗi tạm không bị nuốt; bảng câu lỗi', async () => {
    await f.rollbackCase(async () => {
      for (const [message, state, reason] of [['Bạn không được giao sổ quỹ này (cần là Người giữ sổ hoặc Người biết sổ). Chọn sổ khác.', '42501', 'cashbook_not_held'],
        ['Số đã thu không khớp bút toán semantic; cần đối soát trước', '55000', 'reconciliation_required'], ['Writer invoice.collection.v5 đang bị đóng băng', '55000', 'web_only'],
        ['Không có quyền thu tiền hóa đơn', '42501', 'not_allowed'], ['lỗi lạ', 'XX000', 'crm_refused']]) {
        await db.query('UPDATE public.fixture_v5 SET rejected_message=$1,reject_state=$2', [message, state]);
        assert.deepEqual(await run('preview', rid(27), one({ roomName: 'P102', amount: 1000 })), { kind: 'rejected', reason }, message);
        assert.ok(ACTION_REASON_CODES.includes(reason));
      }
      await db.query("UPDATE public.fixture_v5 SET rejected_message='canceling statement due to lock timeout',reject_state='55P03'");
      await assert.rejects(run('preview', rid(28), one({ roomName: 'P102', amount: 1000 })), code('55P03'));
    });
    const mapped = async (sqlstate, message) => (await db.query('SELECT app_private.hermes_invoice_reason_v1($1,$2) r', [sqlstate, message])).rows[0].r;
    for (const [sqlstate, message, expected] of [['55000', 'Hóa đơn không còn số tiền có thể thu', 'nothing_to_collect'],
      ['55000', 'Trạng thái hóa đơn không cho phép thu tiền: CANCELLED', 'invoice_not_collectible'],
      ['22023', 'Số thu vượt còn phải thu; chọn thối lại hoặc giữ credit', 'overpay_needs_choice'],
      ['22023', 'Không thể giữ credit cho hóa đơn không có hợp đồng', 'credit_requires_contract'],
      ['42501', 'Toà A chưa cài sổ nhận tiền cho hình thức Chuyển khoản.', 'receiving_book_missing'],
      ['42501', 'Sổ "x" không nằm trong danh sách sổ nhận tiền Thanh toán của toà A.', 'receiving_book_missing'],
      ['55000', 'Dữ liệu cọc/NON_PNL vượt tổng phải thu; cần review kế toán', 'reconciliation_required'],
      ['22023', 'Ngày thu không được ở tương lai (hôm nay là 22/10/2026)', 'date_out_of_range'], ['P0001', '[CASHBOOK_CLOSED] sổ đã chốt', 'period_locked'],
      ['PT409', 'Số đã thu vừa thay đổi; vui lòng tải lại hóa đơn', 'state_changed'], ['23505', 'idempotency_key đã dùng với nội dung khác', 'crm_refused']])
      assert.equal(await mapped(sqlstate, message), expected, message);
  });

  await t.test('rào: sàn money; action/phase NULL; khoá tắt; catalog và quyền thực thi; không seed thu_tien.collect', async () => {
    await assert.rejects(db.query("UPDATE app_private.hermes_action_policies SET confirm='never' WHERE action='invoice.collect'"), code('23514'));
    for (const phase of [null, 'write']) await assert.rejects(run(phase, rid(30), one()), code('22023'));
    await assert.rejects(run('preview', rid(31), one(), { action: 'invoice.adjust' }), code('42501'), 'chưa có dòng chính sách ⇒ không tồn tại');
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='thu_tien.collect_transfer'");
      await assert.rejects(run('preview', rid(32), one()), code('42501'));
    });
    assert.equal((await db.query("SELECT count(*)::int n FROM app_private.hermes_capabilities WHERE capability='thu_tien.collect'")).rows[0].n, 0);
    const acl = (await db.query(`SELECT p.oid::regprocedure::text fn,p.prosecdef,p.prosqlbody IS NOT NULL standard,has_function_privilege('authenticated',p.oid,'EXECUTE') auth,
      has_function_privilege('anon',p.oid,'EXECUTE') anon FROM pg_proc p WHERE p.proname LIKE 'hermes_invoice_%' OR p.proname LIKE 'invoice_collection_plan%' ORDER BY 1`)).rows;
    assert.deepEqual(acl.map(r => [r.fn.replace(/\(.*/, ''), r.prosecdef, r.standard, r.auth, r.anon]), [
      ['app_private.hermes_invoice_action_step_v1', true, false, true, false], ['app_private.hermes_invoice_lookup_core_v1', false, false, true, false],
      ['app_private.hermes_invoice_reason_v1', false, false, false, false], ['app_private.hermes_invoice_scope_v1', true, false, true, false],
      ['hermes_invoice_action_v1', false, true, true, false], ['invoice_collection_plan_core_v1', false, false, true, false],
      ['invoice_collection_plan_v1', false, false, true, false]]);
  });
});
