// Fixture SQL dùng chung của RPC trang Thu chi: expense-write-sql.test.mjs (PGlite) và expense-write-race-sql.test.mjs (PostgreSQL thật, hai
// kết nối). Migration Hermes thật + BẢN PORT hàm ghi web (cùng chữ ký, cùng câu lỗi chính, cùng thứ tự khoá ở chỗ được đo); quyền CRM giả
// qua fixture_acl. database: PGlite-shaped { exec, query, close } trên PostgreSQL thật (finance-fixture); edit / approve / locks: thân
// 20261022075102 / 20261023013109 / 20261023031258 thay thế (đột biến).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setup, binding, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, CASHBOOK, FOREIGN_CASHBOOK, CATEGORY, ORG, USER, ACTION_PATH } from './finance-fixture.mjs';
export { binding, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, CASHBOOK, FOREIGN_CASHBOOK, CATEGORY, ORG, USER };

export const file = slug => { const found = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name)); assert.equal(found.length, 1, slug);
  return readFileSync(`supabase/migrations/${found[0]}`, 'utf8').replaceAll('\r\n', '\n'); };
export const RESOLVE = file('hermes_write_name_resolve_v1'), FOUNDATION = file('hermes_action_foundation_v1');
export const RULES = file('ie_quick_entry_shared_rules_v1'), WRITE = file('hermes_expense_write_v1');
// Mốc 3: giải tên nhận toà ảo (v2) + phạm vi = guard ∩ hàm kiểm quyền của hàm ghi web, ghi chú chạy thử.
export const RESOLVE2 = file('hermes_name_directory_virtual_v1'), SCOPE_FIX = file('hermes_expense_scope_v1');
// Mốc 4: sửa / huỷ (khoá income_expenses.edit/.cancel seed TẮT ở 20261021134531), cờ TC5, khoản số mấy, hạng mục dòng tiền.
export const KEYS = file('hermes_action_keys_seed_v1'), EDIT = file('hermes_expense_edit_cancel_v1');
export const VIRTUAL = '00000000-0000-4000-8000-000000000688';
export const rid = n => `00000000-0000-4000-8000-${String(700 + n).padStart(12, '0')}`;
export const code = expected => error => error.code === expected;
export const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const [PCCC, WATER, SYSTEM, CB2, STRANGER] = [601, 602, 603, 604, 677].map(uid);
export const SUPPORT = `CREATE TABLE IF NOT EXISTS public.building_common_names(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,name text);
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
// Bảng/hàm web mà hai migration Thu chi đòi, bản fixture. Hàm ghi port: thang sinh (người lập có quyền duyệt ⇒ duyệt; hạng mục bắt
// buộc duyệt / từ ngưỡng ⇒ chờ; cam kết: vượt phần còn lại ⇒ chờ), phiếu đã duyệt ⇒ POSTED (cầu a85), mã PC từ bảng đếm, dòng hạng
// mục có kỳ, quyết định bộ máy chi, thông báo cho phiếu chờ; fixture_writer.reject_name / reject_message / reject_state giả lập lỗi.
export const WEB = `ALTER TABLE public.income_expense_types ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}',ADD COLUMN IF NOT EXISTS rule_key text,
    ADD COLUMN IF NOT EXISTS fee_category text,ADD COLUMN IF NOT EXISTS sort_order integer,ADD COLUMN IF NOT EXISTS category text,
    ADD COLUMN IF NOT EXISTS force_approval boolean DEFAULT false;
  ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS quick_default_building_id uuid,ADD COLUMN IF NOT EXISTS is_default boolean DEFAULT false;
  ALTER TABLE public.income_expenses ADD COLUMN IF NOT EXISTS posting_status text,ADD COLUMN IF NOT EXISTS system_source text,
    ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT clock_timestamp();
  ALTER TABLE public.fixture_writer ADD COLUMN IF NOT EXISTS reject_name text,ADD COLUMN IF NOT EXISTS reject_state text;
  GRANT SELECT ON public.income_expense_types,public.accounts,public.income_expenses TO authenticated;
  CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),income_expense_id uuid,income_expense_type_id uuid,amount numeric,start_date date,end_date date);
  CREATE TABLE public.notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),voucher_id uuid);
  CREATE TABLE public.fixture_code_counter(organization_id uuid PRIMARY KEY,last_value int);
  CREATE TABLE public.fixture_supplements(voucher_id uuid,note text,idempotency_key text PRIMARY KEY);
  CREATE TABLE app_private.spend_decisions(income_expense_id uuid PRIMARY KEY,engine_reason text,enforced boolean,match boolean);
  CREATE TABLE app_private.ie_auto_approve_config(organization_id uuid PRIMARY KEY,threshold numeric);
  CREATE TABLE public.fixture_commitments(building_id uuid,fee_category text,period_month date,amount numeric);
  INSERT INTO app_private.ie_auto_approve_config VALUES('${ORG}',600000);
  -- Mốc 3: quyền tạo phiếu của hàm ghi web THEO MÔ HÌNH CŨ (staff_assignments) — tách khỏi quyền v3 của guard (fixture_acl) như production;
  -- hàm ghi port gọi đúng hàm này với app_private.current_uid_v1() như create_income_expense_v1 thật.
  CREATE TABLE public.fixture_staff_assignments(user_id uuid,building_id uuid);
  INSERT INTO public.fixture_staff_assignments VALUES('${USER}','${BUILDING}');
  CREATE FUNCTION app_private.current_uid_v1() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT auth.uid() $f$;
  CREATE FUNCTION app_private.authorize_income_expense_on_building(p_actor uuid,p_organization_id uuid,p_action text,p_building_id uuid) RETURNS boolean
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    SELECT p_action IN ('create','restricted_create') AND EXISTS(SELECT 1 FROM public.fixture_staff_assignments s JOIN public.buildings b ON b.id=s.building_id
      WHERE s.user_id=p_actor AND b.organization_id=p_organization_id AND (s.building_id=p_building_id OR s.building_id IS NULL)) $f$;
  REVOKE ALL ON FUNCTION app_private.authorize_income_expense_on_building(uuid,uuid,text,uuid) FROM PUBLIC;
  CREATE FUNCTION public.list_cashbooks_for_expense_v2() RETURNS TABLE(id uuid,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
    AS $f$ SELECT a.id,a.name FROM public.accounts a WHERE a.user_id=auth.uid() AND a.deleted_at IS NULL ORDER BY a.name $f$;
  GRANT EXECUTE ON FUNCTION public.list_cashbooks_for_expense_v2() TO authenticated;
  CREATE FUNCTION app_private.commitment_for_v1(p_building uuid,p_fee_category text,p_period date) RETURNS TABLE(commitment_id uuid,amount numeric,remaining numeric)
    LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $f$
    SELECT gen_random_uuid(),c.amount,c.amount-COALESCE((SELECT sum(it.amount) FROM public.income_expense_items it JOIN public.income_expenses ie ON ie.id=it.income_expense_id
      JOIN public.income_expense_types t ON t.id=it.income_expense_type_id WHERE ie.building_id=p_building AND t.fee_category=p_fee_category AND ie.approval_status<>'CANCELLED'
      AND date_trunc('month',it.start_date)=date_trunc('month',p_period)),0)
    FROM public.fixture_commitments c WHERE c.building_id=p_building AND c.fee_category=p_fee_category AND c.period_month=date_trunc('month',p_period)::date $f$;
  CREATE FUNCTION public.get_voucher_slot_warning_v1(p_building_id uuid,p_type_ids uuid[],p_start date,p_end date,p_type text DEFAULT 'EXPENSE',p_exclude_id uuid DEFAULT NULL)
    RETURNS TABLE(voucher_id uuid,code text,voucher_name text,total_amount numeric,matched_amount numeric,voucher_date date,approval_status text,created_at timestamptz,
      creator_name text,type_names text,same_amount boolean) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    SELECT ie.id,ie.code,ie.name,ie.total_amount,sum(it.amount),ie.voucher_date,ie.approval_status,ie.created_at,NULL,NULL,false
      FROM public.income_expense_items it JOIN public.income_expenses ie ON ie.id=it.income_expense_id
     WHERE ie.building_id=p_building_id AND ie.type=p_type AND ie.deleted_at IS NULL AND ie.approval_status<>'CANCELLED' AND (p_exclude_id IS NULL OR ie.id<>p_exclude_id)
       AND it.income_expense_type_id=ANY(p_type_ids) AND it.start_date<=p_end AND it.end_date>=p_start
     GROUP BY ie.id,ie.code,ie.name,ie.total_amount,ie.voucher_date,ie.approval_status,ie.created_at $f$;
  CREATE FUNCTION public.append_income_expense_supplement_v1(p_voucher uuid,p_note text DEFAULT NULL,p_attachments jsonb DEFAULT '[]',p_idempotency_key text DEFAULT NULL)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    DECLARE v public.fixture_supplements;
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM public.income_expenses ie WHERE ie.id=p_voucher AND ie.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'Không có quyền bổ sung phiếu này' USING ERRCODE='42501'; END IF;
      PERFORM 1 FROM public.income_expenses ie WHERE ie.id=p_voucher FOR UPDATE; -- như hàm thật: khoá dòng phiếu
      SELECT * INTO v FROM public.fixture_supplements WHERE idempotency_key=p_idempotency_key;
      IF FOUND AND v.note IS DISTINCT FROM p_note THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng với nội dung khác' USING ERRCODE='23505'; END IF;
      IF NOT FOUND THEN INSERT INTO public.fixture_supplements VALUES(p_voucher,p_note,p_idempotency_key); END IF;
      RETURN jsonb_build_object('ok',true);
    END $f$;
  CREATE OR REPLACE FUNCTION public.create_income_expense_v1(p_type text,p_name text,p_building_id uuid,p_room_id uuid,p_tenant_id uuid,p_contract_id uuid,
    p_payer_name text,p_receive_bank_account text,p_receive_bank_name text,p_account_id uuid,p_attachments jsonb,p_business_result_accounting boolean,p_notes text,
    p_voucher_date date,p_items jsonb,p_idempotency_key text) RETURNS public.income_expenses LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $w$
    DECLARE v_org uuid; v_row public.income_expenses; v_total numeric; v_hash text; v_op public.fixture_canonical_ops; w public.fixture_writer; v_type uuid;
      v_force boolean; v_fee text; v_threshold numeric; v_status text; v_reason text; v_next int; v_remaining numeric; v_start date;
    BEGIN
      IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
      SELECT organization_id INTO v_org FROM public.buildings WHERE id=p_building_id AND deleted_at IS NULL;
      IF v_org IS NULL OR NOT app_private.authorize_income_expense_on_building(app_private.current_uid_v1(),v_org,'create',p_building_id)
        THEN RAISE EXCEPTION 'Không có quyền tạo phiếu thu/chi cho toà này' USING ERRCODE='42501'; END IF;
      IF p_voucher_date NOT BETWEEN '2000-01-01' AND '2100-12-31' THEN RAISE EXCEPTION 'Ngày phiếu phải nằm trong khoảng 2000-01-01 đến 2100-12-31'; END IF;
      IF p_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=p_account_id AND a.organization_id=v_org AND a.user_id=auth.uid())
        THEN RAISE EXCEPTION 'Không có quyền sử dụng sổ quỹ này' USING ERRCODE='42501'; END IF;
      -- Như hàm thật: khoá FOR SHARE phòng và sổ của phiếu (sau khi guard của Hermes đã giữ công ty).
      PERFORM 1 FROM public.rooms r WHERE r.id=p_room_id FOR SHARE;
      PERFORM 1 FROM public.accounts a WHERE a.id=p_account_id FOR SHARE;
      SELECT * INTO w FROM public.fixture_writer;
      IF w.rejected_message IS NOT NULL AND (w.reject_name IS NULL OR w.reject_name=p_name) THEN
        RAISE EXCEPTION '%',w.rejected_message USING ERRCODE=COALESCE(w.reject_state,'P0001'); END IF;
      v_type:=(p_items->0->>'income_expense_type_id')::uuid; v_start:=(p_items->0->>'start_date')::date;
      SELECT COALESCE(t.force_approval,false),t.fee_category INTO v_force,v_fee FROM public.income_expense_types t WHERE t.id=v_type;
      SELECT COALESCE(sum((it->>'quantity')::numeric*(it->>'unit_price')::numeric),0) INTO v_total FROM jsonb_array_elements(p_items) it;
      v_hash:=md5(jsonb_build_array(p_type,p_name,p_building_id,p_room_id,p_account_id,p_voucher_date,p_items,p_payer_name)::text);
      SELECT * INTO v_op FROM public.fixture_canonical_ops WHERE idempotency_key=p_idempotency_key AND actor=auth.uid();
      IF FOUND THEN
        IF v_op.payload_hash<>v_hash THEN RAISE EXCEPTION 'idempotency_key đã được dùng với payload khác' USING ERRCODE='23505'; END IF;
        SELECT * INTO v_row FROM public.income_expenses WHERE id=v_op.voucher_id; RETURN v_row;
      END IF;
      SELECT threshold INTO v_threshold FROM app_private.ie_auto_approve_config WHERE organization_id=v_org;
      SELECT c.remaining INTO v_remaining FROM app_private.commitment_for_v1(p_building_id,v_fee,v_start) c;
      IF app_private.can_v3('income_expenses.approve',p_building_id) THEN v_status:='APPROVED'; v_reason:='SELF_APPROVER';
      ELSIF v_remaining IS NOT NULL THEN v_status:=CASE WHEN v_total<=v_remaining THEN 'APPROVED' ELSE 'UNAPPROVED' END;
        v_reason:=CASE WHEN v_total<=v_remaining THEN 'WITHIN_COMMITMENT' ELSE 'OVER_COMMITMENT' END;
      ELSIF v_force THEN v_status:='UNAPPROVED'; v_reason:='FORCE_APPROVAL';
      ELSIF v_threshold IS NOT NULL AND v_total>=v_threshold THEN v_status:='UNAPPROVED'; v_reason:='OVER_THRESHOLD';
      ELSE v_status:='APPROVED'; v_reason:='UNDER_THRESHOLD'; END IF;
      INSERT INTO public.fixture_code_counter VALUES(v_org,0) ON CONFLICT DO NOTHING;
      UPDATE public.fixture_code_counter SET last_value=last_value+1 WHERE organization_id=v_org RETURNING last_value INTO v_next;
      INSERT INTO public.income_expenses(organization_id,user_id,code,type,name,building_id,room_id,account_id,voucher_date,total_amount,approval_status,payer_name,kqkd_amount,posting_status)
        VALUES(v_org,auth.uid(),'PC2610'||lpad(v_next::text,3,'0'),p_type,p_name,p_building_id,p_room_id,p_account_id,p_voucher_date,v_total,v_status,p_payer_name,v_total,
          CASE WHEN v_status='APPROVED' THEN 'POSTED' ELSE 'UNPOSTED' END) RETURNING * INTO v_row;
      INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount,start_date,end_date)
        SELECT v_row.id,(it->>'income_expense_type_id')::uuid,(it->>'quantity')::numeric*(it->>'unit_price')::numeric,(it->>'start_date')::date,(it->>'end_date')::date
        FROM jsonb_array_elements(p_items) it;
      INSERT INTO app_private.spend_decisions VALUES(v_row.id,v_reason,true,true);
      IF v_status='UNAPPROVED' THEN INSERT INTO public.notifications(voucher_id) VALUES(v_row.id); END IF;
      INSERT INTO public.fixture_canonical_ops VALUES(p_idempotency_key,auth.uid(),v_hash,v_row.id);
      RETURN v_row;
    END $w$;
  UPDATE public.income_expense_types SET sort_order=10,category='Sửa chữa' WHERE id='${CATEGORY}';
  INSERT INTO public.income_expense_types(id,organization_id,type,name,rule_key,keywords,fee_category,force_approval,sort_order) VALUES
    ('${PCCC}','${ORG}','expense','PCCC','pccc',ARRAY['pccc'],NULL,false,20),('${WATER}','${ORG}','expense','Đóng tiền nước','nuoc',ARRAY['tiền nước'],'nuoc',true,30);
  INSERT INTO public.income_expense_types(id,organization_id,type,name,system_only) VALUES('${SYSTEM}','${ORG}','expense','Hoa hồng môi giới',true);
  INSERT INTO public.accounts VALUES('${CB2}','${ORG}','${USER}','Tiền mặt toà A','',false,null,'${BUILDING}',false);`;
// Mốc 4: hàm ghi web sửa / huỷ / allow-list "lập tay" — BẢN PORT (cùng chữ ký, cùng câu lỗi chính; CAS phiên bản; lý do khi đổi trục tiền;
// người lập hoặc quyền sửa/huỷ ở toà (fixture_acl); huỷ phiếu đã vào sổ ⇒ bút toán đảo). fixture_writer.reject_name 'revise' / 'cancel'
// giả lập lỗi của hàm web. Hàm thật đo ở tầng 2 trên TEST.
export const WEB4 = `ALTER TABLE public.income_expenses ADD COLUMN IF NOT EXISTS approval_version bigint NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS posting_version bigint NOT NULL DEFAULT 1,ADD COLUMN IF NOT EXISTS repeat_parent_id uuid,
    ADD COLUMN IF NOT EXISTS repeat_cycle text NOT NULL DEFAULT 'NONE';
  ALTER TABLE public.income_expense_items ADD COLUMN IF NOT EXISTS description text,ADD COLUMN IF NOT EXISTS quantity numeric NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS unit_price numeric,ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT clock_timestamp();
  CREATE FUNCTION public.fixture_item_price() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN NEW.unit_price:=COALESCE(NEW.unit_price,NEW.amount); NEW.amount:=COALESCE(NEW.amount,NEW.quantity*NEW.unit_price); RETURN NEW; END $f$;
  CREATE TRIGGER fixture_item_price BEFORE INSERT ON public.income_expense_items FOR EACH ROW EXECUTE FUNCTION public.fixture_item_price();
  CREATE TABLE public.fixture_revisions(voucher_id uuid,revision_no int,actor uuid,reason text,changed text[],idempotency_key text);
  CREATE TABLE public.fixture_postings(voucher_id uuid,kind text,amount numeric);
  CREATE TABLE public.fixture_cancellations(voucher_id uuid PRIMARY KEY,kind text,reason text);
  CREATE FUNCTION app_private.assert_manual_voucher_v1(p_voucher uuid,p_action text DEFAULT 'huỷ') RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$
    DECLARE v public.income_expenses;
    BEGIN
      SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher;
      IF NOT FOUND THEN RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE='P0002'; END IF;
      IF v.salary_staff_id IS NOT NULL THEN RAISE EXCEPTION '[NOT_MANUAL] Phiếu gắn lương nhân sự — sửa ở màn hình lương.' USING ERRCODE='42501'; END IF;
      IF v.system_source IS NOT NULL THEN RAISE EXCEPTION '[NOT_MANUAL] Phiếu do hệ thống sinh (%) — xử lý ở luồng nguồn.',v.system_source USING ERRCODE='42501'; END IF;
    END $f$;
  CREATE FUNCTION public.revise_pending_income_expense_v1(p_voucher uuid,p_expected_approval_version bigint,p_patch jsonb,p_items jsonb DEFAULT NULL,
    p_reason text DEFAULT NULL,p_idempotency_key text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $f$
    DECLARE v public.income_expenses; w public.fixture_writer; v_reason text:=NULLIF(btrim(COALESCE(p_reason,'')),''); v_changed text[]:='{}';
      v_old jsonb; v_new jsonb; v_no int;
    BEGIN
      SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher FOR UPDATE;
      IF NOT FOUND OR v.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE='P0002'; END IF;
      IF EXISTS(SELECT 1 FROM public.fixture_revisions r WHERE r.voucher_id=p_voucher AND r.actor=auth.uid() AND r.idempotency_key=p_idempotency_key) THEN
        RETURN jsonb_build_object('id',p_voucher,'changed',true,'replayed',true); END IF;
      IF v.approval_status<>'UNAPPROVED' THEN
        RAISE EXCEPTION 'Chỉ sửa được phiếu Chờ duyệt — phiếu này đang ở trạng thái %',v.approval_status USING ERRCODE='55000'; END IF;
      IF v.approval_version IS DISTINCT FROM p_expected_approval_version THEN
        RAISE EXCEPTION 'Phiếu vừa được người khác sửa — tải lại để xem thay đổi.' USING ERRCODE='PT409'; END IF;
      IF v.system_source IS NOT NULL AND v.system_source NOT IN ('contract.commission','termination.refund') THEN
        RAISE EXCEPTION 'Phiếu do hệ thống sinh (%) — sửa ở luồng gốc',v.system_source USING ERRCODE='42501'; END IF;
      IF v.user_id IS DISTINCT FROM auth.uid() AND NOT EXISTS(SELECT 1 FROM public.fixture_acl a WHERE a.permission='income_expenses.edit' AND a.allowed
          AND v.building_id=ANY(a.building_ids)) THEN
        RAISE EXCEPTION 'Chỉ người lập phiếu hoặc người có quyền sửa thu chi ở toà này mới sửa được' USING ERRCODE='42501'; END IF;
      IF p_patch ? 'account_id' AND (p_patch->>'account_id')::uuid IS DISTINCT FROM v.account_id AND NOT EXISTS(SELECT 1 FROM public.accounts a
          WHERE a.id=(p_patch->>'account_id')::uuid AND a.user_id=auth.uid()) THEN RAISE EXCEPTION 'Không có quyền sử dụng sổ quỹ này' USING ERRCODE='42501'; END IF;
      SELECT * INTO w FROM public.fixture_writer;
      IF w.rejected_message IS NOT NULL AND w.reject_name='revise' THEN RAISE EXCEPTION '%',w.rejected_message USING ERRCODE=COALESCE(w.reject_state,'P0001'); END IF;
      IF p_patch ? 'name' AND p_patch->>'name' IS DISTINCT FROM v.name THEN v_changed:=v_changed||'name'::text; END IF;
      IF p_patch ? 'payer_name' AND p_patch->>'payer_name' IS DISTINCT FROM v.payer_name THEN v_changed:=v_changed||'payer_name'::text; END IF;
      IF p_patch ? 'voucher_date' AND (p_patch->>'voucher_date')::date IS DISTINCT FROM v.voucher_date THEN v_changed:=v_changed||'voucher_date'::text; END IF;
      IF p_patch ? 'account_id' AND (p_patch->>'account_id')::uuid IS DISTINCT FROM v.account_id THEN v_changed:=v_changed||'account_id'::text; END IF;
      IF p_patch ? 'building_id' AND (p_patch->>'building_id')::uuid IS DISTINCT FROM v.building_id THEN v_changed:=v_changed||'building_id'::text; END IF;
      IF p_patch ? 'room_id' AND (p_patch->>'room_id')::uuid IS DISTINCT FROM v.room_id THEN v_changed:=v_changed||'room_id'::text; END IF;
      SELECT jsonb_agg(jsonb_build_array(it.income_expense_type_id,it.quantity*it.unit_price,it.start_date,it.end_date) ORDER BY it.created_at,it.id) INTO v_old
        FROM public.income_expense_items it WHERE it.income_expense_id=p_voucher;
      IF p_items IS NOT NULL THEN
        SELECT jsonb_agg(jsonb_build_array((i->>'income_expense_type_id')::uuid,(i->>'quantity')::numeric*(i->>'unit_price')::numeric,(i->>'start_date')::date,
          (i->>'end_date')::date)) INTO v_new FROM jsonb_array_elements(p_items) i;
        IF v_new IS DISTINCT FROM v_old THEN v_changed:=v_changed||'items'::text; END IF;
      END IF;
      IF cardinality(v_changed)=0 THEN RETURN jsonb_build_object('id',p_voucher,'changed',false); END IF;
      IF (v_changed && ARRAY['building_id','items'] OR ('account_id'=ANY(v_changed) AND v.account_id IS NOT NULL)) AND (v_reason IS NULL OR char_length(v_reason)<8) THEN
        RAISE EXCEPTION 'Đổi số tiền, hạng mục, loại, sổ quỹ hoặc toà phải ghi lý do (ít nhất 8 ký tự).' USING ERRCODE='22023'; END IF;
      -- Như bảng thật: khoá ngoại phiếu → sổ / phòng ⇒ đổi sổ / phòng lấy KEY SHARE trên dòng mới.
      IF 'account_id'=ANY(v_changed) THEN PERFORM 1 FROM public.accounts a WHERE a.id=(p_patch->>'account_id')::uuid FOR KEY SHARE; END IF;
      IF 'room_id'=ANY(v_changed) THEN PERFORM 1 FROM public.rooms r WHERE r.id=(p_patch->>'room_id')::uuid FOR KEY SHARE; END IF;
      UPDATE public.income_expenses SET name=COALESCE(p_patch->>'name',name),payer_name=CASE WHEN p_patch ? 'payer_name' THEN p_patch->>'payer_name' ELSE payer_name END,
        voucher_date=COALESCE((p_patch->>'voucher_date')::date,voucher_date),account_id=CASE WHEN p_patch ? 'account_id' THEN (p_patch->>'account_id')::uuid ELSE account_id END,
        building_id=COALESCE((p_patch->>'building_id')::uuid,building_id),room_id=CASE WHEN p_patch ? 'room_id' THEN (p_patch->>'room_id')::uuid ELSE room_id END,
        approval_version=approval_version+1 WHERE id=p_voucher;
      IF 'items'=ANY(v_changed) THEN
        DELETE FROM public.income_expense_items WHERE income_expense_id=p_voucher;
        INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,description,quantity,unit_price,start_date,end_date)
          SELECT p_voucher,(i->>'income_expense_type_id')::uuid,i->>'description',(i->>'quantity')::numeric,(i->>'unit_price')::numeric,
            (i->>'start_date')::date,(i->>'end_date')::date FROM jsonb_array_elements(p_items) i;
        UPDATE public.income_expenses SET total_amount=(SELECT sum(quantity*unit_price) FROM public.income_expense_items WHERE income_expense_id=p_voucher) WHERE id=p_voucher;
      END IF;
      SELECT COALESCE(max(revision_no),0)+1 INTO v_no FROM public.fixture_revisions WHERE voucher_id=p_voucher;
      INSERT INTO public.fixture_revisions VALUES(p_voucher,v_no,auth.uid(),v_reason,v_changed,p_idempotency_key);
      RETURN jsonb_build_object('id',p_voucher,'changed',true,'revision_no',v_no,'approval_version',v.approval_version+1,'changed_fields',to_jsonb(v_changed));
    END $f$;
  CREATE FUNCTION public.cancel_income_expense_flex_v1(p_voucher uuid,p_reason text,p_expected_approval_version bigint DEFAULT NULL,
    p_expected_posting_version bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $f$
    DECLARE v public.income_expenses; w public.fixture_writer; v_kind text:='CANCELLED_UNPOSTED';
    BEGIN
      IF char_length(btrim(COALESCE(p_reason,'')))<8 THEN
        RAISE EXCEPTION 'Phải ghi lý do huỷ (ít nhất 8 ký tự) để còn đối soát về sau.' USING ERRCODE='22023'; END IF;
      SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher AND deleted_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE='P0002'; END IF;
      -- Như hàm thật: dòng phiếu trước, dòng CÔNG TY sau (authorize_tenant_action_v3 / trigger rent_support_voucher_lifecycle_guard_v1).
      PERFORM app_private.lock_org_for_decision_v1(v.organization_id);
      IF v.approval_status='CANCELLED' THEN RETURN jsonb_build_object('id',p_voucher,'changed',false,'reason','đã huỷ trước đó'); END IF;
      SELECT * INTO w FROM public.fixture_writer;
      IF w.rejected_message IS NOT NULL AND w.reject_name='cancel' THEN RAISE EXCEPTION '%',w.rejected_message USING ERRCODE=COALESCE(w.reject_state,'P0001'); END IF;
      PERFORM app_private.assert_manual_voucher_v1(p_voucher,'huỷ');
      IF v.user_id IS DISTINCT FROM auth.uid() AND NOT EXISTS(SELECT 1 FROM public.fixture_acl a WHERE a.permission='income_expenses.cancel' AND a.allowed
          AND v.building_id=ANY(a.building_ids)) THEN RAISE EXCEPTION 'Không có quyền huỷ phiếu thu chi trên toà này' USING ERRCODE='42501'; END IF;
      IF p_expected_approval_version IS NOT NULL AND v.approval_version<>p_expected_approval_version THEN
        RAISE EXCEPTION 'Phiếu vừa được người khác thay đổi — hãy tải lại' USING ERRCODE='40001'; END IF;
      IF p_expected_posting_version IS NOT NULL AND v.posting_version<>p_expected_posting_version THEN
        RAISE EXCEPTION 'Phiếu vừa được người khác ghi sổ — hãy tải lại' USING ERRCODE='40001'; END IF;
      -- reject_name 'cancel-posted' giả lập phiếu mà hàm web xử như đã vào sổ dù cột trạng thái chưa theo kịp (nguồn sự thật = hàm web).
      IF COALESCE(v.posting_status,'UNPOSTED')='POSTED' OR w.reject_name='cancel-posted' THEN
        -- Như bảng thật: bút toán đảo có khoá ngoại tới sổ của phiếu ⇒ KEY SHARE trên dòng sổ.
        PERFORM 1 FROM public.accounts a WHERE a.id=v.account_id FOR KEY SHARE;
        INSERT INTO public.fixture_postings VALUES(p_voucher,'REVERSAL',v.total_amount); v_kind:='CANCELLED_AFTER_POSTING'; END IF;
      UPDATE public.income_expenses SET approval_status='CANCELLED',posting_status=CASE WHEN v_kind='CANCELLED_AFTER_POSTING' THEN 'REVERSED' ELSE posting_status END,
        approval_version=approval_version+1,posting_version=posting_version+CASE WHEN v_kind='CANCELLED_AFTER_POSTING' THEN 1 ELSE 0 END WHERE id=p_voucher;
      -- Như trigger thật a75_ie_cancel_close_request: đóng yêu cầu duyệt đang mở của phiếu.
      UPDATE public.approval_requests ar SET state='CANCELLED' WHERE ar.subject_type='INCOME_EXPENSE' AND ar.subject_id=p_voucher AND ar.state='PENDING_APPROVAL';
      INSERT INTO public.fixture_cancellations VALUES(p_voucher,v_kind,p_reason);
      RETURN jsonb_build_object('id',p_voucher,'changed',true,'cancellation_kind',v_kind);
    END $f$;
  INSERT INTO public.income_expense_types(id,organization_id,type,name,rule_key,keywords,sort_order) VALUES
    ('00000000-0000-4000-8000-000000000605','${ORG}','expense','Trả lại tiền thừa cho khách','tra_tien_thua_khach',ARRAY['thối tiền','khách đóng dư'],40);`;

// Mốc 5: hàm duyệt web — BẢN PORT (cùng chữ ký, cùng câu lỗi chính, cùng thứ tự khoá: dòng phiếu FOR UPDATE → công ty): duyệt
// (approve_income_expense_v2), duyệt + chi (approve_and_post_income_expense_v2: quyền duyệt ở toà, sổ phải do người gọi giữ, chỉ phiếu
// CASHBOOK, CAS hai phiên bản, đòi chứng từ FINALIZED), nhận ảnh phiếu làm chứng từ (adopt_…: chỉ URL storage của bucket ảnh thu chi;
// đã gắn / cách ly ⇒ bỏ qua), rào #263 (ie_self_approve_over_threshold_blocked_v1 đọc has_building_perm_v1 = fixture_legacy_approvers).
// fixture_writer.reject_name 'approve' / 'approve-post' giả lập lỗi của hàm web (kỳ đã chốt, mất quyền …). Hàm thật đo ở tầng 2 trên TEST.
export const APPROVE = file('hermes_expense_approve_v1');
export const IMAGE = n => `https://fixture.invalid/storage/v1/object/public/income-expense-attachments/fixture/${n}.jpg`;
export const WEB5 = `ALTER TABLE public.income_expenses ADD COLUMN IF NOT EXISTS posting_mode text NOT NULL DEFAULT 'CASHBOOK',
    ADD COLUMN IF NOT EXISTS review_state text DEFAULT 'PENDING',ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS creator_name text,ADD COLUMN IF NOT EXISTS approved_by uuid;
  CREATE TABLE public.fixture_evidence(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,object_name text,state text NOT NULL DEFAULT 'FINALIZED',
    UNIQUE(organization_id,object_name));
  CREATE TABLE public.fixture_approvals(voucher_id uuid,kind text,actor uuid,idempotency_key text);
  CREATE TABLE public.fixture_legacy_approvers(user_id uuid,building_id uuid);
  CREATE FUNCTION app_private.has_building_perm_v1(p_building uuid,p_perm text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
    AS $f$ SELECT p_perm='income_expenses.approve' AND EXISTS(SELECT 1 FROM public.fixture_legacy_approvers a WHERE a.user_id=auth.uid() AND a.building_id=p_building) $f$;
  CREATE FUNCTION app_private.ie_self_approve_over_threshold_blocked_v1(p_voucher_id uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public,app_private AS $f$
    DECLARE v record; v_threshold numeric;
    BEGIN
      IF auth.uid() IS NULL OR p_voucher_id IS NULL THEN RETURN false; END IF;
      SELECT ie.organization_id,ie.type,ie.user_id,ie.building_id,ie.total_amount INTO v FROM public.income_expenses ie WHERE ie.id=p_voucher_id;
      IF NOT FOUND OR v.user_id IS DISTINCT FROM auth.uid() OR v.type IS DISTINCT FROM 'EXPENSE' THEN RETURN false; END IF;
      SELECT c.threshold INTO v_threshold FROM app_private.ie_auto_approve_config c WHERE c.organization_id=v.organization_id;
      IF v_threshold IS NULL OR COALESCE(v.total_amount,0)<v_threshold THEN RETURN false; END IF;
      RETURN NOT COALESCE(app_private.has_building_perm_v1(v.building_id,'income_expenses.approve'),false);
    END $f$;
  CREATE FUNCTION public.adopt_voucher_attachments_as_evidence_v2(p_voucher uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog,app_private,public AS $f$
    DECLARE v public.income_expenses; v_url text; v_prefix text:='/storage/v1/object/public/income-expense-attachments/'; v_object text; v_row public.fixture_evidence;
      v_ids jsonb:='[]'; v_skipped jsonb:='[]';
    BEGIN
      SELECT * INTO v FROM public.income_expenses ie WHERE ie.id=p_voucher AND ie.deleted_at IS NULL;
      IF NOT FOUND THEN RAISE EXCEPTION 'adopt_voucher_attachments_as_evidence_v2: phiếu % không tồn tại',p_voucher USING ERRCODE='P0002'; END IF;
      IF v.attachments IS NULL OR jsonb_typeof(v.attachments)<>'array' THEN RETURN jsonb_build_object('evidence_ids',v_ids,'skipped',v_skipped); END IF;
      FOR v_url IN SELECT jsonb_array_elements_text(v.attachments) LOOP
        IF position(v_prefix IN COALESCE(v_url,''))=0 THEN v_skipped:=v_skipped||jsonb_build_object('url',v_url,'reason','KHONG_PHAI_FILE_STORAGE'); CONTINUE; END IF;
        v_object:=substring(v_url FROM position(v_prefix IN v_url)+length(v_prefix));
        INSERT INTO public.fixture_evidence(organization_id,object_name) VALUES(v.organization_id,v_object) ON CONFLICT(organization_id,object_name) DO NOTHING;
        SELECT * INTO v_row FROM public.fixture_evidence e WHERE e.organization_id=v.organization_id AND e.object_name=v_object FOR UPDATE;
        IF v_row.state<>'FINALIZED' THEN v_skipped:=v_skipped||jsonb_build_object('url',v_url,'reason',v_row.state); CONTINUE; END IF;
        v_ids:=v_ids||to_jsonb(v_row.id);
      END LOOP;
      RETURN jsonb_build_object('evidence_ids',v_ids,'skipped',v_skipped);
    END $f$;
  CREATE FUNCTION public.approve_income_expense_v2(p_voucher uuid,p_expected_approval_version bigint,p_idempotency_key text) RETURNS jsonb LANGUAGE plpgsql
    SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $f$
    DECLARE v public.income_expenses; w public.fixture_writer;
    BEGIN
      IF p_idempotency_key IS NULL OR length(p_idempotency_key)=0 THEN
        RAISE EXCEPTION 'approve_income_expense_v2: idempotency key is required' USING ERRCODE='22023'; END IF;
      SELECT * INTO v FROM public.income_expenses ie WHERE ie.id=p_voucher FOR UPDATE;
      IF NOT FOUND OR v.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'approve_income_expense_v2: voucher % not found',p_voucher USING ERRCODE='P0002'; END IF;
      -- Như hàm thật: dòng phiếu trước, dòng CÔNG TY sau (authorize_tenant_action_v3).
      PERFORM app_private.lock_org_for_decision_v1(v.organization_id);
      IF EXISTS(SELECT 1 FROM public.fixture_approvals a WHERE a.idempotency_key=p_idempotency_key AND a.actor=auth.uid()) THEN
        RETURN jsonb_build_object('voucherId',p_voucher,'approvalStatus',v.approval_status,'replayed',true); END IF;
      IF NOT EXISTS(SELECT 1 FROM public.fixture_acl a WHERE a.permission='income_expenses.approve' AND a.allowed AND (a.org_wide OR v.building_id=ANY(a.building_ids))) THEN
        RAISE EXCEPTION 'approve_income_expense_v2: income_expenses.approve required in scope' USING ERRCODE='42501'; END IF;
      SELECT * INTO w FROM public.fixture_writer;
      IF w.rejected_message IS NOT NULL AND w.reject_name='approve' THEN RAISE EXCEPTION '%',w.rejected_message USING ERRCODE=COALESCE(w.reject_state,'P0001'); END IF;
      IF v.approval_status<>'UNAPPROVED' OR v.review_state NOT IN ('PENDING','CHANGES_REQUESTED') THEN
        RAISE EXCEPTION 'approve_income_expense_v2: voucher not in an approvable state (%, %)',v.approval_status,v.review_state USING ERRCODE='55000'; END IF;
      IF v.approval_version<>p_expected_approval_version THEN
        RAISE EXCEPTION 'approve_income_expense_v2: approval_version mismatch (expected %, found %)',p_expected_approval_version,v.approval_version USING ERRCODE='55000'; END IF;
      UPDATE public.income_expenses SET approval_status='APPROVED',approved_by=auth.uid(),review_state='RESOLVED',approval_version=approval_version+1 WHERE id=p_voucher;
      UPDATE public.approval_requests ar SET state='APPROVED' WHERE ar.subject_type='INCOME_EXPENSE' AND ar.subject_id=p_voucher AND ar.state='PENDING_APPROVAL';
      INSERT INTO public.fixture_approvals VALUES(p_voucher,'APPROVE',auth.uid(),p_idempotency_key);
      RETURN jsonb_build_object('voucherId',p_voucher,'approvalStatus','APPROVED','reviewState','RESOLVED','approvalVersion',v.approval_version+1);
    END $f$;
  CREATE FUNCTION public.approve_and_post_income_expense_v2(input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $f$
    DECLARE v public.income_expenses; w public.fixture_writer; v_cashbook uuid:=(input->>'cashbookId')::uuid;
      v_ev uuid[]:=ARRAY(SELECT jsonb_array_elements_text(COALESCE(input->'evidenceIds','[]'::jsonb))::uuid);
    BEGIN
      IF COALESCE(input->>'subjectKind','VOUCHER')<>'VOUCHER' THEN
        RAISE EXCEPTION 'approve_and_post_income_expense_v2: only VOUCHER subjects are supported here' USING ERRCODE='22023'; END IF;
      IF input->>'subjectId' IS NULL OR v_cashbook IS NULL OR input->>'postedOn' IS NULL OR input->>'idempotencyKey' IS NULL THEN
        RAISE EXCEPTION 'approve_and_post_income_expense_v2: subjectId, cashbookId, postedOn, idempotencyKey are required' USING ERRCODE='22023'; END IF;
      SELECT * INTO v FROM public.income_expenses ie WHERE ie.id=(input->>'subjectId')::uuid FOR UPDATE;
      IF NOT FOUND OR v.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'approve_and_post_income_expense_v2: voucher % not found',input->>'subjectId' USING ERRCODE='P0002'; END IF;
      PERFORM app_private.lock_org_for_decision_v1(v.organization_id);
      IF EXISTS(SELECT 1 FROM public.fixture_approvals a WHERE a.idempotency_key=input->>'idempotencyKey' AND a.actor=auth.uid()) THEN
        RETURN jsonb_build_object('voucherId',v.id,'approvalStatus',v.approval_status,'postingStatus',v.posting_status,'replayed',true); END IF;
      IF NOT EXISTS(SELECT 1 FROM public.fixture_acl a WHERE a.permission='income_expenses.approve' AND a.allowed AND (a.org_wide OR v.building_id=ANY(a.building_ids))) THEN
        RAISE EXCEPTION 'approve_and_post_income_expense_v2: income_expenses.approve required in scope' USING ERRCODE='42501'; END IF;
      PERFORM 1 FROM public.accounts a WHERE a.id=v_cashbook AND a.organization_id=v.organization_id AND a.deleted_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'approve_and_post_income_expense_v2: cashbook % not found',v_cashbook USING ERRCODE='42501'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=v_cashbook AND a.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'assert_cashbook_access_v2: no CUSTODIAN possession of cashbook %',v_cashbook USING ERRCODE='42501'; END IF;
      IF v.posting_mode IS DISTINCT FROM 'CASHBOOK' THEN
        RAISE EXCEPTION 'approve_and_post_income_expense_v2: only CASHBOOK vouchers can be posted' USING ERRCODE='55000'; END IF;
      IF v.approval_status IS DISTINCT FROM 'UNAPPROVED' OR COALESCE(v.review_state,'') NOT IN ('PENDING','CHANGES_REQUESTED') OR v.posting_status IS DISTINCT FROM 'UNPOSTED' THEN
        RAISE EXCEPTION 'approve_and_post_income_expense_v2: voucher not approvable+postable (%, %, %)',v.approval_status,v.review_state,v.posting_status USING ERRCODE='55000'; END IF;
      IF v.approval_version<>(input->>'expectedApprovalVersion')::bigint OR v.posting_version<>(input->>'expectedPostingVersion')::bigint THEN
        RAISE EXCEPTION 'approve_and_post_income_expense_v2: version mismatch' USING ERRCODE='55000'; END IF;
      SELECT * INTO w FROM public.fixture_writer;
      IF w.rejected_message IS NOT NULL AND w.reject_name='approve-post' THEN RAISE EXCEPTION '%',w.rejected_message USING ERRCODE=COALESCE(w.reject_state,'P0001'); END IF;
      IF NOT EXISTS(SELECT 1 FROM public.fixture_evidence e WHERE e.id=ANY(v_ev) AND e.state='FINALIZED') THEN
        RAISE EXCEPTION 'finance_v2_post_manual_voucher: at least one FINALIZED evidence is required' USING ERRCODE='55000'; END IF;
      UPDATE public.fixture_evidence SET state='ATTACHED' WHERE id=ANY(v_ev);
      UPDATE public.income_expenses SET approval_status='APPROVED',approved_by=auth.uid(),review_state='RESOLVED',approval_version=approval_version+1,
        posting_status='POSTED',posting_version=posting_version+1,account_id=v_cashbook WHERE id=v.id;
      UPDATE public.approval_requests ar SET state='APPROVED' WHERE ar.subject_type='INCOME_EXPENSE' AND ar.subject_id=v.id AND ar.state='PENDING_APPROVAL';
      INSERT INTO public.fixture_postings VALUES(v.id,'POSTING',v.total_amount);
      INSERT INTO public.fixture_approvals VALUES(v.id,'APPROVE_POST',auth.uid(),input->>'idempotencyKey');
      RETURN jsonb_build_object('voucherId',v.id,'approvalStatus','APPROVED','postingStatus','POSTED','approvalVersion',v.approval_version+1,'postingVersion',v.posting_version+1);
    END $f$;`;

// Lượt 8: bước ghi khoá NOWAIT trước các dòng mà hàm web sẽ khoá (20261023031258). Bảng yêu cầu duyệt (hàm duyệt / huỷ web ghi nó) và
// BẢN PORT ba kiểu hàm web khoá dòng nghiệp vụ rồi mới khoá công ty (đo thân production 23/10): confirm_cashbook_closing_v1 (sổ FOR UPDATE →
// lock_org_for_decision_v1), consume_room_next_claim_v1 (phòng FOR NO KEY UPDATE → công ty), save_room_sale_policy_v1 (phòng FOR UPDATE →
// công ty), emergency_approve_financial_v1 (yêu cầu duyệt FOR UPDATE → công ty). Dùng cho test đua hai kết nối.
export const LOCKS = file('hermes_expense_row_locks_nowait_v1');
// Mỗi câu khoá trước của bước ghi lượt 8 (đúng một chỗ trong thân) — test đua và đột biến dùng chung.
const VOUCHER_ROW = "ie.deleted_at IS NULL\n      FOR UPDATE NOWAIT;";
export const LOCK_SITES = {
  editCancelVoucher: `Hermes không bao giờ chờ web.\n    SELECT * INTO v_voucher FROM public.income_expenses ie WHERE ie.id=(v_resolved->>'voucherId')::uuid AND ie.organization_id=v_org AND ${VOUCHER_ROW}`,
  noteVoucher: `cả lượt xem trước lẫn lượt ghi.\n    SELECT * INTO v_voucher FROM public.income_expenses ie WHERE ie.id=(v_resolved->>'voucherId')::uuid AND ie.organization_id=v_org AND ${VOUCHER_ROW}`,
  approveVouchers: 'ORDER BY ie.id FOR UPDATE NOWAIT;',
  approveRequests: "ar.subject_id IN (SELECT (x->>'voucherId')::uuid FROM jsonb_array_elements(v_resolved->'vouchers') x) ORDER BY ar.id FOR UPDATE NOWAIT;",
  approveCashbooks: '      ORDER BY a.id FOR UPDATE NOWAIT;',
  editCancelRequests: 'ar.subject_id=v_voucher.id\n      ORDER BY ar.id FOR UPDATE NOWAIT;',
  editCancelCashbooks: 'ORDER BY a.id FOR KEY SHARE NOWAIT;',
  editRoom: "r.id=(v_resolved->>'roomId')::uuid FOR KEY SHARE NOWAIT;",
  createRooms: 'ORDER BY r.id FOR SHARE NOWAIT;',
  createCashbooks: 'ORDER BY a.id FOR SHARE NOWAIT;',
};
export const WEB8 = `CREATE TABLE public.approval_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,subject_type text,subject_id uuid,
    state text NOT NULL DEFAULT 'PENDING_APPROVAL');
  GRANT SELECT ON public.approval_requests TO authenticated;
  CREATE FUNCTION public.fixture_close_cashbook(p_cashbook uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $f$
    DECLARE v_org uuid;
    BEGIN
      SELECT a.organization_id INTO v_org FROM public.accounts a WHERE a.id=p_cashbook FOR UPDATE;
      PERFORM app_private.lock_org_for_decision_v1(v_org);
      RETURN 'closed';
    END $f$;
  CREATE FUNCTION public.fixture_claim_room(p_room uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $f$
    DECLARE v_org uuid;
    BEGIN
      SELECT r.organization_id INTO v_org FROM public.rooms r WHERE r.id=p_room FOR NO KEY UPDATE;
      PERFORM app_private.lock_org_for_decision_v1(v_org);
      RETURN 'claimed';
    END $f$;
  CREATE FUNCTION public.fixture_save_room_policy(p_room uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $f$
    DECLARE v_org uuid;
    BEGIN
      SELECT r.organization_id INTO v_org FROM public.rooms r WHERE r.id=p_room FOR UPDATE;
      PERFORM app_private.lock_org_for_decision_v1(v_org);
      RETURN 'saved';
    END $f$;
  CREATE FUNCTION public.fixture_emergency_approve(p_request uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $f$
    DECLARE v_org uuid;
    BEGIN
      SELECT ar.organization_id INTO v_org FROM public.approval_requests ar WHERE ar.id=p_request FOR UPDATE;
      PERFORM app_private.lock_org_for_decision_v1(v_org);
      UPDATE public.approval_requests SET state='APPROVED' WHERE id=p_request;
      RETURN 'approved';
    END $f$;`;

export async function expenseSetup(t, { database, edit = EDIT, approve = APPROVE, locks = LOCKS } = {}) {
  const f = await setup(t, { action: `${readFileSync(ACTION_PATH, 'utf8')}\n${SUPPORT}\n${RESOLVE}`, database });
  const { db, call } = f;
  await db.exec(FOUNDATION); await db.exec(WEB);
  await db.exec(RULES); await db.exec(RULES); await db.exec(WRITE); await db.exec(WRITE); // Idempotent.
  await db.exec(RESOLVE2); await db.exec(RESOLVE2); await db.exec(SCOPE_FIX); await db.exec(SCOPE_FIX);
  // Mốc 4 áp lên thân Mốc 3 (= production): $requires$ ghim md5 thân đang chạy; lần hai nhận thân của chính file.
  await db.exec(KEYS); await db.exec(WEB4); await db.exec(edit); await db.exec(edit);
  // Mốc 5 áp lên thân Mốc 4/4b (ghim md5 như trên).
  await db.exec(WEB5); await db.exec(approve); await db.exec(approve);
  // Lượt 8 áp lên thân Mốc 5.
  await db.exec(WEB8); await db.exec(locks); await db.exec(locks);
  await db.query("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability IN ('income_expenses.edit','income_expenses.cancel','income_expenses.approve_vouchers')");
  for (const table of ['hermes_org_policies', 'hermes_connections'])
    await db.query(`UPDATE app_private.${table} SET action_capabilities=action_capabilities||ARRAY['income_expenses.edit','income_expenses.cancel','income_expenses.approve_vouchers']`);
  await db.query("INSERT INTO public.fixture_acl(permission,building_ids) VALUES('buildings.view',$1) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true", [[BUILDING, OTHER_BUILDING]]);
  const run = (action, phase, requestId, params, extra = {}) => call(
    'SELECT public.hermes_expense_write_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result',
    [JSON.stringify(binding), action, phase, requestId, JSON.stringify(params), extra.resolved ? JSON.stringify(extra.resolved) : null, extra.basis ?? null]);
  return { ...f, db, call, run };
}
