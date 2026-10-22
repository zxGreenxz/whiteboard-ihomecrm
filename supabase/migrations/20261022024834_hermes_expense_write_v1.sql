-- Đợt 2 Thu chi — Mốc 2 (22/10/2026; docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 2–5): RPC trang của thao tác expense.create
-- (lập phiếu CHI lập tay, 1–5 khoản cho một lần đồng ý) và expense.note (ghi chú phiếu) trên khung chung crm_action_*
-- (20261021133823). Thay họ crm_expense_* cũ ở connector (TC1, cùng khoá income_expenses.create); hàm SQL cũ giữ nguyên.
-- Khuôn hai tầng như thao tác thử (authenticated KHÔNG có USAGE trên app_private):
--  (1) app_private.hermes_expense_reason_v1(sqlstate, message, constraint) IMMUTABLE: mã lý do của trang (system_voucher,
--      evidence_required, not_pending/cashbook_not_held/date_out_of_range/not_found/quota_exceeded/amount_out_of_range theo câu
--      lỗi thật của hàm ghi web) rồi mới tới danh sách chung app_private.hermes_action_reason_v1 — hàm chung không đổi.
--  (2) app_private.hermes_expense_resolve_core_v1(org, toà[], action, params)  plpgsql STABLE INVOKER, search_path='', chỉ tham
--      chiếu public.*: giải TÊN dưới RLS người hỏi — toà/phòng bằng public.hermes_write_name_resolve_v1 (D7), hạng mục (tên ⇒ khớp
--      bằng rồi chứa duy nhất trong tập dùng được của Hermes; trống ⇒ public.ie_category_suggest_v1 chỉ nhận khi khoá cứng: rule /
--      fee_phrase / provider_code; không chắc ⇒ hỏi lại, không bao giờ tự chọn "Chi khác"), sổ quỹ (tên trong sổ đang giữ của công
--      ty; trống ⇒ public.ie_default_cashbook_v1 với sổ của phiếu CHI lập tay gần nhất của chính người dùng), mã phiếu (dưới RLS
--      phiếu; mã cũ trùng giữa các dãy ⇒ hỏi lại kèm ngày/toà/tiền). Client không gọi thẳng được (không USAGE app_private).
--  (3) app_private.hermes_expense_create_run_v1(...) DEFINER: chạy lô create THẬT bằng create_income_expense_v1 (mỗi khoản một
--      phiếu, khoá idempotency do người gọi đặt) và đọc trạng thái sinh, lý do sinh của bộ máy chi (spend_decisions), phiếu trùng
--      ô kỳ (get_voucher_slot_warning_v1, gồm cả khoản trước trong lô), cam kết còn lại TRƯỚC khoản (commitment_for_v1) ⇒ trả
--      sự thật + basis. Dùng cho cả xem trước (khối con rồi RAISE để lùi — "chạy thử", TC2) lẫn lượt 2 (ghi thật rồi so basis).
--  (4) app_private.hermes_expense_write_step_v1(...) DEFINER: chạy lại guard, kiểm bản đã giải còn trong phạm vi (toà của khoá,
--      phòng thuộc toà, hạng mục hermes_expense_category_ok_v1, sổ hermes_expense_cashbook_ok_v1, phiếu thuộc công ty + toà trong
--      phạm vi), rồi: create ⇒ lượt 1 chạy thử (không để lại gì), lượt 2 ghi cả lô hoặc không gì (TC3: lệch bản đã xem hay một
--      khoản lỗi ⇒ lùi cả lô + biên nhận, state_changed); note ⇒ append_income_expense_supplement_v1, ghi thẳng theo chính sách.
--  (5) public.hermes_expense_write_v1: vỏ INVOKER SQL-standard gắn OID guard + (2) + (4) lúc tạo (khuôn public.hermes_action_probe_v1;
--      ghim băm ở scripts/hermes-task-function-contract.mjs).
--  (6) Chính sách: expense.create (money, always), expense.note (reversible, never) — cùng khoá income_expenses.create, quyền CRM
--      giao vào income_expenses.create. Khoá registry đang TẮT (Q4, 20261021113528): migration này không bật gì.
-- Lỗi tạm (40001/40P01/55P03/PT409) không bao giờ chốt biên nhận: RAISE lại để cả giao dịch lùi. Không đổi hàm cũ nào.
-- Idempotent (CREATE OR REPLACE, ON CONFLICT DO NOTHING); khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('app_private.hermes_action_policies') IS NULL OR to_regclass('app_private.hermes_action_receipts') IS NULL
    OR to_regclass('app_private.spend_decisions') IS NULL OR to_regclass('app_private.ie_auto_approve_config') IS NULL
    OR to_regprocedure('app_private.hermes_action_guard_v1(jsonb,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_reason_v1(text,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_expense_category_ok_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.hermes_expense_cashbook_ok_v1(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.commitment_for_v1(uuid,text,date)') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)') IS NULL
    OR to_regprocedure('public.hermes_name_fold_v1(text)') IS NULL
    OR to_regprocedure('public.ie_category_suggest_v1(uuid,jsonb,text,boolean)') IS NULL
    OR to_regprocedure('public.ie_default_cashbook_v1(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('public.list_cashbooks_for_expense_v2()') IS NULL
    OR to_regprocedure('public.get_voucher_slot_warning_v1(uuid,uuid[],date,date,text,uuid)') IS NULL
    OR to_regprocedure('public.append_income_expense_supplement_v1(uuid,text,jsonb,text)') IS NULL
    OR to_regprocedure('public.create_income_expense_v1(text,text,uuid,uuid,uuid,uuid,text,text,text,uuid,jsonb,boolean,text,date,jsonb,text)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='income_expenses.create' AND mode='action') THEN
    RAISE EXCEPTION 'hermes_expense_write_dependency_invalid'; END IF;
END $requires$;

INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES
  ('expense.create','income_expenses.create','income_expenses.create','money','always',true),
  ('expense.note','income_expenses.create','income_expenses.create','reversible','never',true)
  ON CONFLICT(action) DO NOTHING;

-- 1. Mã lý do của trang (câu lỗi thật của hàm ghi web, THU-CHI-THAO-TAC-GHI.md mục 2.3), rồi danh sách chung.
CREATE OR REPLACE FUNCTION app_private.hermes_expense_reason_v1(p_sqlstate text,p_message text,p_constraint text DEFAULT NULL)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path=pg_catalog,app_private AS $fn$
  SELECT CASE
    WHEN COALESCE(p_message,'') ~ '\[(PROFIT_LOCKED|CASHBOOK_CLOSED|HANDOVER_LOCKED|PERIOD_CLOSED)\]' THEN 'period_locked'
    WHEN COALESCE(p_message,'') ~ '\[NOT_MANUAL\]' OR p_sqlstate='0A000'
      OR COALESCE(p_message,'') ~* '(luồng hệ thống|do hệ thống sinh|owned by system flow|chỉ được sinh từ hệ thống|gắn hoá đơn/khoản thu|lương / chia lợi nhuận|hồ sơ chia lợi nhuận|phiếu đảo của phiếu khác|xử lý phiếu hoa hồng)'
      THEN 'system_voucher'
    WHEN COALESCE(p_message,'') ~* 'FINALIZED evidence' THEN 'evidence_required'
    WHEN COALESCE(p_message,'') ~* '(quyền sử dụng sổ quỹ đã bị thu hồi|no [A-Z_]+ possession of cashbook|sổ quỹ không thuộc tổ chức)' THEN 'cashbook_not_held'
    WHEN COALESCE(p_message,'') ~* '(not in an approvable state|not approvable\+postable)' THEN 'not_pending'
    WHEN COALESCE(p_message,'') ~* 'ngày phiếu phải nằm trong khoảng' THEN 'date_out_of_range'
    WHEN COALESCE(p_message,'') ~* '(hết số lượt canary|hết tổng hạn mức tiền canary)' THEN 'quota_exceeded'
    WHEN p_sqlstate='54000' THEN 'amount_out_of_range'
    WHEN p_sqlstate='P0002' THEN 'not_found'
    ELSE app_private.hermes_action_reason_v1(p_sqlstate,p_message,p_constraint) END
$fn$;

-- 2. Giải tên (INVOKER, RLS người hỏi). Kết quả: {status:'resolved', resolved} | {status:'unresolved', field, wanted, why,
-- candidates, more} | {status:'rejected', reason}. Thứ tự: khoản đầu tiên không giải được thì trả về luôn.
CREATE OR REPLACE FUNCTION app_private.hermes_expense_resolve_core_v1(p_organization_id uuid,p_building_ids uuid[],p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_item jsonb; v_out jsonb:='[]'::jsonb; v_name jsonb; v_building uuid; v_type uuid; v_type_name text; v_auto boolean; v_cashbook uuid;
  v_cashbook_name text; v_last uuid; v_date date; v_today date:=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date; v_period_start date; v_period_end date;
  v_wanted text; v_hits jsonb; v_suggest jsonb; v_code text; v_voucher record; v_count int; v_visible int;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_expense_resolve_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_building_ids IS NULL OR p_action IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object' THEN
    RAISE EXCEPTION 'hermes_expense_resolve_invalid' USING ERRCODE='22023'; END IF;
  IF p_action='expense.note' THEN
    v_code:=upper(btrim(p_params->>'voucherCode'));
    IF v_code IS NULL OR v_code='' THEN RAISE EXCEPTION 'hermes_expense_resolve_invalid' USING ERRCODE='22023'; END IF;
    SELECT count(*) FILTER (WHERE ie.building_id=ANY(p_building_ids)),count(*) INTO v_count,v_visible
      FROM public.income_expenses ie WHERE ie.organization_id=p_organization_id AND upper(ie.code)=v_code AND ie.deleted_at IS NULL;
    IF v_count=1 THEN
      SELECT ie.id,ie.code,ie.building_id INTO v_voucher FROM public.income_expenses ie WHERE ie.organization_id=p_organization_id
        AND upper(ie.code)=v_code AND ie.deleted_at IS NULL AND ie.building_id=ANY(p_building_ids);
      RETURN jsonb_build_object('status','resolved','resolved',jsonb_build_object('voucherId',v_voucher.id,'voucherCode',v_voucher.code,'buildingId',v_voucher.building_id));
    END IF;
    IF v_count>1 THEN
      RETURN jsonb_build_object('status','unresolved','field','voucher','wanted',left(btrim(p_params->>'voucherCode'),200),'why','ambiguous','more',v_count>8,
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',x.label) ORDER BY x.voucher_date DESC,x.label),'[]'::jsonb) FROM (
          SELECT ie.voucher_date,ie.code||' · '||to_char(ie.voucher_date,'DD/MM/YYYY')||' · '||COALESCE(b.name,'?')||' · '
            ||replace(to_char(round(ie.total_amount),'FM999,999,999,999,999'),',','.')||'đ' label
          FROM public.income_expenses ie LEFT JOIN public.buildings b ON b.id=ie.building_id
          WHERE ie.organization_id=p_organization_id AND upper(ie.code)=v_code AND ie.deleted_at IS NULL AND ie.building_id=ANY(p_building_ids)
          ORDER BY ie.voucher_date DESC LIMIT 8) x));
    END IF;
    RETURN jsonb_build_object('status','unresolved','field','voucher','wanted',left(btrim(p_params->>'voucherCode'),200),
      'why',CASE WHEN v_visible>0 THEN 'outside_scope' ELSE 'not_visible' END,'candidates','[]'::jsonb,'more',false);
  END IF;
  IF p_action<>'expense.create' OR jsonb_typeof(p_params->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_params->'items') NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'hermes_expense_resolve_invalid' USING ERRCODE='22023'; END IF;
  -- Sổ "dùng lần trước" của Hermes: sổ của phiếu CHI lập tay gần nhất của chính người dùng ở công ty này (web dùng localStorage).
  SELECT ie.account_id INTO v_last FROM public.income_expenses ie WHERE ie.organization_id=p_organization_id AND ie.user_id=auth.uid()
    AND ie.type='EXPENSE' AND ie.system_source IS NULL AND ie.deleted_at IS NULL AND ie.account_id IS NOT NULL ORDER BY ie.created_at DESC LIMIT 1;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_params->'items') LOOP
    -- Toà / phòng (D7).
    v_name:=public.hermes_write_name_resolve_v1(p_organization_id,p_building_ids,
      jsonb_strip_nulls(jsonb_build_object('building',v_item->>'buildingName','room',v_item->>'roomName')));
    IF v_name->>'status'<>'resolved' THEN RETURN v_name; END IF;
    v_building:=(v_name#>>'{building,id}')::uuid;
    IF v_building IS NULL THEN RETURN jsonb_build_object('status','unresolved','field','building','wanted',COALESCE(v_item->>'buildingName',''),
      'why','not_visible','candidates','[]'::jsonb,'more',false); END IF;
    -- Hạng mục: tập dùng được của Hermes (như hermes_expense_category_ok_v1: CHI, đúng công ty, không lưu trữ/system_only/ẩn/hạn chế/
    -- cọc/chuyển nội bộ) dưới RLS người hỏi; bước ghi kiểm lại bằng chính hàm đó.
    v_type:=NULL; v_type_name:=NULL; v_auto:=false;
    IF NULLIF(btrim(v_item->>'category'),'') IS NOT NULL THEN
      v_wanted:=public.hermes_name_fold_v1(v_item->>'category');
      SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'exact',public.hermes_name_fold_v1(t.name)=v_wanted) ORDER BY t.sort_order NULLS LAST,t.name) INTO v_hits
        FROM public.income_expense_types t WHERE t.organization_id=p_organization_id AND t.type='expense' AND t.archived_at IS NULL
          AND NOT COALESCE(t.system_only,false) AND NOT COALESCE(t.manual_hidden,false) AND NOT COALESCE(t.quick_entry_hidden,false)
          AND NOT COALESCE(t.is_restricted,false) AND NOT COALESCE(t.is_deposit,false) AND NOT COALESCE(t.internal_transfer,false)
          AND (public.hermes_name_fold_v1(t.name)=v_wanted OR (char_length(v_wanted)>=2 AND strpos(public.hermes_name_fold_v1(t.name),v_wanted)>0));
      IF (SELECT count(*) FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h WHERE (h->>'exact')::boolean)=1 THEN
        SELECT (h->>'id')::uuid,h->>'name' INTO v_type,v_type_name FROM jsonb_array_elements(v_hits) h WHERE (h->>'exact')::boolean;
      ELSIF jsonb_array_length(COALESCE(v_hits,'[]'))=1 THEN
        v_type:=(v_hits#>>'{0,id}')::uuid; v_type_name:=v_hits#>>'{0,name}';
      ELSE
        RETURN jsonb_build_object('status','unresolved','field','category','wanted',left(btrim(v_item->>'category'),200),
          'why',CASE WHEN jsonb_array_length(COALESCE(v_hits,'[]'))>=2 THEN 'ambiguous' ELSE 'not_visible' END,
          'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',h->>'name')),'[]'::jsonb) FROM (SELECT h FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h LIMIT 8) x),
          'more',jsonb_array_length(COALESCE(v_hits,'[]'))>8);
      END IF;
    ELSE
      -- Không nêu hạng mục: gợi ý dùng chung với Báo chi nhanh; chỉ nhận khi KHOÁ CỨNG (rule / fee_phrase / provider_code) và nằm trong tập
      -- của Hermes. Còn lại hỏi lại người dùng, gợi ý đứng đầu ứng viên — không bao giờ tự chọn "Chi khác".
      v_suggest:=public.ie_category_suggest_v1(p_organization_id,jsonb_build_array(jsonb_build_object('text',v_item->>'content')),'expense',false)->0;
      SELECT t.id,t.name INTO v_type,v_type_name FROM public.income_expense_types t WHERE t.id=(v_suggest->>'typeId')::uuid
        AND v_suggest->>'reason' IN ('rule','fee_phrase','provider_code') AND t.organization_id=p_organization_id AND t.type='expense'
        AND NOT COALESCE(t.is_restricted,false) AND NOT COALESCE(t.is_deposit,false) AND NOT COALESCE(t.internal_transfer,false);
      IF v_type IS NULL THEN
        RETURN jsonb_build_object('status','unresolved','field','category','wanted',left(btrim(v_item->>'content'),200),'why','ambiguous','more',false,
          'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',x.name)),'[]'::jsonb) FROM (
            SELECT t.name FROM public.income_expense_types t WHERE t.organization_id=p_organization_id AND t.type='expense' AND t.archived_at IS NULL
              AND NOT COALESCE(t.system_only,false) AND NOT COALESCE(t.manual_hidden,false) AND NOT COALESCE(t.quick_entry_hidden,false)
              AND NOT COALESCE(t.is_restricted,false) AND NOT COALESCE(t.is_deposit,false) AND NOT COALESCE(t.internal_transfer,false)
            ORDER BY (t.id=(v_suggest->>'typeId')::uuid) DESC,t.sort_order NULLS LAST,t.name LIMIT 8) x));
      END IF;
      v_auto:=true;
    END IF;
    -- Sổ quỹ: chỉ sổ đang giữ của công ty (như expenseCashbooksForOrg); sổ thấy mà không giữ ⇒ cashbook_not_held ngay lượt 1.
    v_cashbook:=NULL; v_cashbook_name:=NULL;
    IF NULLIF(btrim(v_item->>'cashbook'),'') IS NOT NULL THEN
      v_wanted:=public.hermes_name_fold_v1(v_item->>'cashbook');
      SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'exact',public.hermes_name_fold_v1(a.name)=v_wanted,'held',c.id IS NOT NULL) ORDER BY a.name) INTO v_hits
        FROM public.accounts a LEFT JOIN public.list_cashbooks_for_expense_v2() c ON c.id=a.id
        WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual,false)
          AND (public.hermes_name_fold_v1(a.name)=v_wanted OR (char_length(v_wanted)>=2 AND strpos(public.hermes_name_fold_v1(a.name),v_wanted)>0));
      IF (SELECT count(*) FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h WHERE (h->>'exact')::boolean)=1 THEN
        v_hits:=(SELECT jsonb_agg(h) FROM jsonb_array_elements(v_hits) h WHERE (h->>'exact')::boolean);
      END IF;
      IF jsonb_array_length(COALESCE(v_hits,'[]'))=1 THEN
        IF NOT (v_hits#>>'{0,held}')::boolean THEN RETURN jsonb_build_object('status','rejected','reason','cashbook_not_held'); END IF;
        v_cashbook:=(v_hits#>>'{0,id}')::uuid; v_cashbook_name:=v_hits#>>'{0,name}';
      ELSE
        RETURN jsonb_build_object('status','unresolved','field','cashbook','wanted',left(btrim(v_item->>'cashbook'),200),
          'why',CASE WHEN jsonb_array_length(COALESCE(v_hits,'[]'))>=2 THEN 'ambiguous' ELSE 'not_visible' END,'more',jsonb_array_length(COALESCE(v_hits,'[]'))>8,
          'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',h->>'name')),'[]'::jsonb) FROM (SELECT h FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h
            WHERE (h->>'held')::boolean LIMIT 8) x));
      END IF;
    ELSE
      v_cashbook:=public.ie_default_cashbook_v1(p_organization_id,v_building,v_last);
      IF v_cashbook IS NULL THEN RETURN jsonb_build_object('status','rejected','reason','cashbook_not_held'); END IF;
      SELECT a.name INTO v_cashbook_name FROM public.accounts a WHERE a.id=v_cashbook;
    END IF;
    -- Ngày và kỳ (giờ Việt Nam).
    v_date:=COALESCE((v_item->>'voucherDate')::date,v_today);
    IF NULLIF(v_item->>'period','') IS NOT NULL THEN
      v_period_start:=((v_item->>'period')||'-01')::date; v_period_end:=(v_period_start+interval '1 month'-interval '1 day')::date;
    ELSE v_period_start:=v_date; v_period_end:=v_date; END IF;
    v_out:=v_out||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('buildingId',v_building,'buildingName',v_name#>>'{building,name}',
      'roomId',v_name#>>'{room,id}','roomName',v_name#>>'{room,name}','typeId',v_type,'typeName',v_type_name,'typeAuto',v_auto,
      'cashbookId',v_cashbook,'cashbookName',v_cashbook_name,'voucherDate',v_date,'periodStart',v_period_start,'periodEnd',v_period_end)));
  END LOOP;
  RETURN jsonb_build_object('status','resolved','resolved',jsonb_build_object('items',v_out));
END $fn$;

-- 3. Chạy lô create THẬT (dùng cho chạy thử trong khối con rồi lùi, và cho lượt 2). p_key_prefix: 'hermes-dry:<rid>' | 'hermes-expense:<rid>'.
CREATE OR REPLACE FUNCTION app_private.hermes_expense_create_run_v1(p_org uuid,p_params jsonb,p_resolved jsonb,p_key_prefix text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  v_item jsonb; v_res jsonb; i int:=0; v_row public.income_expenses; v_fee text; v_force boolean; v_commitment numeric; v_remaining numeric; v_amount numeric;
  v_reason text; v_reason_used boolean; v_dups jsonb; v_facts jsonb:='[]'::jsonb; v_basis jsonb:='[]'::jsonb; v_threshold numeric; v_batch uuid[]:='{}';
BEGIN
  SELECT c.threshold INTO v_threshold FROM app_private.ie_auto_approve_config c WHERE c.organization_id=p_org;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_params->'items') LOOP
    i:=i+1; v_res:=p_resolved->'items'->(i-1); v_amount:=(v_item->>'amount')::numeric;
    SELECT t.fee_category,COALESCE(t.force_approval,false) INTO v_fee,v_force FROM public.income_expense_types t WHERE t.id=(v_res->>'typeId')::uuid;
    -- Cam kết của kỳ (khoản cam kết theo phí cố định), đọc TRƯỚC khoản này.
    v_commitment:=NULL; v_remaining:=NULL;
    IF v_fee IS NOT NULL THEN
      SELECT c.amount,c.remaining INTO v_commitment,v_remaining
        FROM app_private.commitment_for_v1((v_res->>'buildingId')::uuid,v_fee,(v_res->>'periodStart')::date) c LIMIT 1;
    END IF;
    v_row:=public.create_income_expense_v1('EXPENSE',v_item->>'content',(v_res->>'buildingId')::uuid,(v_res->>'roomId')::uuid,NULL,NULL,
      NULLIF(v_item->>'payee',''),NULL,NULL,(v_res->>'cashbookId')::uuid,'[]'::jsonb,NULL,NULL,(v_res->>'voucherDate')::date,
      jsonb_build_array(jsonb_build_object('income_expense_type_id',v_res->>'typeId','description',NULL,'quantity',1,'unit_price',v_amount,
        'start_date',v_res->>'periodStart','end_date',v_res->>'periodEnd')),p_key_prefix||':'||i);
    IF v_row.id IS NULL OR v_row.organization_id IS DISTINCT FROM p_org OR v_row.type IS DISTINCT FROM 'EXPENSE'
      OR v_row.building_id IS DISTINCT FROM (v_res->>'buildingId')::uuid OR v_row.account_id IS DISTINCT FROM (v_res->>'cashbookId')::uuid
      OR v_row.total_amount IS DISTINCT FROM v_amount THEN RAISE EXCEPTION 'hermes_expense_write_mismatch' USING ERRCODE='PT409'; END IF;
    v_reason:=NULL; v_reason_used:=false;
    SELECT d.engine_reason,COALESCE(d.enforced OR d.match,false) INTO v_reason,v_reason_used FROM app_private.spend_decisions d WHERE d.income_expense_id=v_row.id;
    -- Trùng ô kỳ: cùng toà + hạng mục, kỳ giao nhau (khoản không nêu kỳ: ± 3 ngày quanh ngày phiếu), gồm cả khoản trước trong lô.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',w.voucher_id,'code',w.code,'date',w.voucher_date,'amount',w.total_amount,'sameAmount',w.total_amount=v_amount,
        'inBatch',w.voucher_id=ANY(v_batch)) ORDER BY (w.voucher_id=ANY(v_batch)),w.voucher_date DESC,w.code),'[]'::jsonb) INTO v_dups
      FROM public.get_voucher_slot_warning_v1((v_res->>'buildingId')::uuid,ARRAY[(v_res->>'typeId')::uuid],
        CASE WHEN v_item ? 'period' THEN (v_res->>'periodStart')::date ELSE (v_res->>'voucherDate')::date-3 END,
        CASE WHEN v_item ? 'period' THEN (v_res->>'periodEnd')::date ELSE (v_res->>'voucherDate')::date+3 END,'EXPENSE',v_row.id) w;
    v_facts:=v_facts||jsonb_build_array(jsonb_build_object('i',i,'id',v_row.id,'code',v_row.code,'approvalStatus',v_row.approval_status,
      'postingStatus',v_row.posting_status,'reason',v_reason,'reasonUsed',v_reason_used,
      'force',v_force,'threshold',v_threshold,'fee',v_fee,'commitment',v_commitment,'remaining',v_remaining,'dups',v_dups));
    -- basis: sự thật mà người dùng sẽ thấy (đã giải, tiền, trạng thái + lý do sinh, phiếu trùng, cam kết còn lại) — không gồm mã/ID phiếu mới.
    v_basis:=v_basis||jsonb_build_array(jsonb_build_array(v_res,v_amount,v_item->>'content',v_item->>'payee',v_row.approval_status,v_row.posting_status,
      v_reason,(SELECT COALESCE(jsonb_agg(d->>'code' ORDER BY d->>'code'),'[]'::jsonb) FROM jsonb_array_elements(v_dups) d WHERE NOT (d->>'inBatch')::boolean),
      (SELECT count(*) FROM jsonb_array_elements(v_dups) d WHERE (d->>'inBatch')::boolean),v_remaining));
    v_batch:=v_batch||v_row.id;
  END LOOP;
  RETURN jsonb_build_object('facts',v_facts,'basis',md5(v_basis::text));
END $fn$;

-- Hai hàm định dạng (chỉ hiển thị).
CREATE OR REPLACE FUNCTION app_private.hermes_vnd_text_v1(p_amount numeric)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
  SELECT CASE WHEN p_amount IS NULL THEN NULL ELSE replace(to_char(round(p_amount),'FM999,999,999,999,999'),',','.')||'đ' END
$fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_vn_date_text_v1(p_date date,p_today date)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
  SELECT to_char(p_date,'DD/MM/YYYY')||' ('||(ARRAY['thứ Hai','thứ Ba','thứ Tư','thứ Năm','thứ Sáu','thứ Bảy','Chủ nhật'])[extract(isodow FROM p_date)::int]
    ||CASE WHEN p_date=p_today THEN ', hôm nay' WHEN p_date=p_today-1 THEN ', hôm qua' ELSE '' END||')'
$fn$;

-- 4. Bước ghi (DEFINER).
CREATE OR REPLACE FUNCTION app_private.hermes_expense_write_step_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  ctx jsonb; v_org uuid; v_resolved jsonb; v_res jsonb; v_run jsonb; v_basis text; v_begin jsonb; v_outcome jsonb; v_constraint text;
  v_items jsonb:='[]'::jsonb; v_warnings jsonb:='[]'::jsonb; f jsonb; v_item jsonb; v_today date:=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  v_total numeric:=0; v_will text; v_why text; v_voucher public.income_expenses; d jsonb; i int;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('expense.create','expense.note') OR p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply')
    OR p_request_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_phase='apply' AND (p_resolved IS NULL OR jsonb_typeof(p_resolved)<>'object' OR p_expected_basis IS NULL)) THEN
    RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  ctx:=app_private.hermes_action_guard_v1(p_binding,p_action);
  v_org:=(ctx->>'organizationId')::uuid;
  IF p_phase='apply' THEN v_resolved:=p_resolved;
  ELSIF p_resolution->>'status'='unresolved' THEN
    RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field',p_resolution->'field','wanted',p_resolution->'wanted',
      'why',p_resolution->'why','candidates',COALESCE(p_resolution->'candidates','[]'::jsonb),'more',COALESCE(p_resolution->'more','false'::jsonb));
  ELSIF p_resolution->>'status'='rejected' THEN RETURN jsonb_build_object('kind','rejected','reason',p_resolution->>'reason');
  ELSIF p_resolution->>'status'='resolved' THEN v_resolved:=p_resolution->'resolved';
  ELSE RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023';
  END IF;

  IF p_action='expense.note' THEN
    -- Bản đã giải phải là phiếu của công ty, còn sống, ở toà trong phạm vi khoá.
    SELECT * INTO v_voucher FROM public.income_expenses ie WHERE ie.id=(v_resolved->>'voucherId')::uuid AND ie.organization_id=v_org AND ie.deleted_at IS NULL;
    IF NOT FOUND OR NOT (v_voucher.building_id IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid)) THEN
      RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    v_basis:=md5(jsonb_build_array(p_action,v_voucher.id,v_voucher.code,p_params->>'note')::text);
    IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
    IF p_phase<>'apply' AND NOT (p_phase='auto' AND COALESCE(ctx->>'actionClass'='reversible' AND ctx->>'confirm'='never',false)) THEN
      RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required','warnings','[]'::jsonb,
        'preview',jsonb_build_object('summary','Ghi chú vào phiếu '||v_voucher.code||': "'||left(p_params->>'note',200)||'"','code',v_voucher.code,'note',p_params->>'note'));
    END IF;
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
    IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
    BEGIN
      PERFORM public.append_income_expense_supplement_v1(v_voucher.id,p_params->>'note','[]'::jsonb,'hermes-note:'||p_request_id::text);
      v_outcome:=jsonb_build_object('kind','applied','link','/income-expense/voucher/'||v_voucher.id,
        'result',jsonb_build_object('code',v_voucher.code,'noted',true));
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
      GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
      v_outcome:=jsonb_build_object('kind','rejected','reason',app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
      RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome,SQLSTATE,SQLERRM);
    END;
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
  END IF;

  -- expense.create: mọi khoản đã giải phải còn trong phạm vi.
  IF jsonb_typeof(v_resolved->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(v_resolved->'items')<>jsonb_array_length(p_params->'items') THEN
    RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  FOR v_res IN SELECT value FROM jsonb_array_elements(v_resolved->'items') LOOP
    IF v_res->>'buildingId' IS NULL OR NOT ((v_res->>'buildingId')::uuid IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid))
      OR (v_res->>'roomId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=(v_res->>'roomId')::uuid
        AND r.building_id=(v_res->>'buildingId')::uuid AND r.organization_id=v_org AND r.deleted_at IS NULL))
      OR v_res->>'typeId' IS NULL OR NOT app_private.hermes_expense_category_ok_v1(v_org,(v_res->>'typeId')::uuid)
      OR v_res->>'cashbookId' IS NULL OR v_res->>'voucherDate' IS NULL OR v_res->>'periodStart' IS NULL OR v_res->>'periodEnd' IS NULL THEN
      RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    IF NOT app_private.hermes_expense_cashbook_ok_v1(v_org,auth.uid(),(v_res->>'cashbookId')::uuid) THEN
      RETURN jsonb_build_object('kind','rejected','reason','cashbook_not_held'); END IF;
  END LOOP;

  IF p_phase<>'apply' THEN
    -- Lượt 1: CHẠY THỬ đúng hàm ghi web trong khối con rồi lùi (TC2) — không để lại phiếu, mã, cam kết hay thông báo nào.
    BEGIN
      v_run:=app_private.hermes_expense_create_run_v1(v_org,p_params,v_resolved,'hermes-dry:'||p_request_id::text);
      RAISE EXCEPTION 'hermes_expense_dry_run' USING ERRCODE='HD001';
    EXCEPTION
      WHEN SQLSTATE 'HD001' THEN NULL;
      WHEN OTHERS THEN
        IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
        GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
        RETURN jsonb_build_object('kind','rejected','reason',app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
    END;
    i:=0;
    FOR f IN SELECT value FROM jsonb_array_elements(v_run->'facts') LOOP
      i:=i+1; v_item:=p_params->'items'->(i-1); v_res:=v_resolved->'items'->(i-1); v_total:=v_total+(v_item->>'amount')::numeric;
      v_why:=CASE WHEN (f->>'reasonUsed')::boolean THEN CASE f->>'reason'
          WHEN 'UNDER_THRESHOLD' THEN 'dưới ngưỡng tự duyệt '||COALESCE(app_private.hermes_vnd_text_v1((f->>'threshold')::numeric),'')
          WHEN 'SELF_APPROVER' THEN 'người lập có quyền duyệt'
          WHEN 'WITHIN_COMMITMENT' THEN 'trong cam kết chi còn lại'
          WHEN 'UNDER_CEILING' THEN 'dưới trần chi'
          WHEN 'OVER_THRESHOLD' THEN 'từ ngưỡng tự duyệt '||COALESCE(app_private.hermes_vnd_text_v1((f->>'threshold')::numeric),'')||' trở lên'
          WHEN 'FORCE_APPROVAL' THEN 'hạng mục "'||(v_res->>'typeName')||'" bắt buộc duyệt'
          WHEN 'OVER_COMMITMENT' THEN 'vượt cam kết chi còn lại của kỳ'
          WHEN 'NO_COMMITMENT' THEN 'chưa có cam kết chi cho kỳ này'
          WHEN 'NO_CASHBOOK' THEN 'sổ quỹ chưa hợp lệ' WHEN 'NO_CASHBOOK_RIGHT' THEN 'sổ quỹ chưa hợp lệ'
          ELSE NULL END END;
      -- Bộ máy chi không ghi quyết định cho phiếu này (đo TEST 22/10) ⇒ câu "vì …" dựng từ dữ kiện; trạng thái vẫn lấy từ hàm ghi.
      v_why:=COALESCE(v_why,CASE WHEN f->>'approvalStatus'='APPROVED' THEN CASE
          WHEN (f->>'threshold') IS NOT NULL AND (v_item->>'amount')::numeric<(f->>'threshold')::numeric
            THEN 'dưới ngưỡng tự duyệt '||app_private.hermes_vnd_text_v1((f->>'threshold')::numeric)
          ELSE 'người lập có quyền duyệt' END
        WHEN (f->>'force')::boolean THEN 'hạng mục "'||(v_res->>'typeName')||'" bắt buộc duyệt'
        WHEN (f->>'threshold') IS NOT NULL AND (v_item->>'amount')::numeric>=(f->>'threshold')::numeric
          THEN 'từ ngưỡng tự duyệt '||app_private.hermes_vnd_text_v1((f->>'threshold')::numeric)||' trở lên'
        ELSE 'theo thang duyệt CRM' END);
      v_will:=CASE WHEN f->>'approvalStatus'='APPROVED' AND f->>'postingStatus'='POSTED'
          THEN 'VÀO SỔ NGAY khi ghi ('||v_why||') — trừ sổ '||(v_res->>'cashbookName')
        WHEN f->>'approvalStatus'='APPROVED' THEN 'ĐÃ DUYỆT khi ghi ('||v_why||'), chưa vào sổ'
        ELSE 'CHỜ DUYỆT: '||v_why||'; muốn chi được thì thêm ảnh chứng từ ở trang phiếu' END;
      v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('stt',i,'building',v_res->>'buildingName','room',v_res->>'roomName',
        'category',v_res->>'typeName','categoryAuto',CASE WHEN (v_res->>'typeAuto')::boolean THEN 'tự chọn theo nội dung — sửa nếu sai' END,
        'content',v_item->>'content','amount',app_private.hermes_vnd_text_v1((v_item->>'amount')::numeric),'payee',v_item->>'payee',
        'voucherDate',app_private.hermes_vn_date_text_v1((v_res->>'voucherDate')::date,v_today),
        'period',CASE WHEN v_item ? 'period' THEN 'tháng '||to_char((v_res->>'periodStart')::date,'MM/YYYY') END,
        'cashbook',v_res->>'cashbookName','willBe',v_will)));
      -- Cảnh báo (≤ 10, mỗi câu ≤ 300 ký tự).
      FOR d IN SELECT value FROM jsonb_array_elements(f->'dups') LIMIT 2 LOOP
        v_warnings:=v_warnings||to_jsonb(left(CASE WHEN (d->>'inBatch')::boolean
          THEN format('Khoản %s: trùng toà, hạng mục, kỳ với một khoản khác trong lần ghi này%s',i,
            CASE WHEN (d->>'sameAmount')::boolean THEN ' — CÙNG SỐ TIỀN, có thể ghi trùng' ELSE '' END)
          ELSE format('Khoản %s: đã có phiếu %s ngày %s cùng toà, cùng hạng mục, %s%s',i,d->>'code',
            to_char((d->>'date')::date,'DD/MM'),app_private.hermes_vnd_text_v1((d->>'amount')::numeric),
            CASE WHEN (d->>'sameAmount')::boolean THEN ' — CÙNG SỐ TIỀN, có thể ghi trùng' ELSE '' END) END,300));
      END LOOP;
      IF f->>'fee' IS NOT NULL THEN
        v_warnings:=v_warnings||to_jsonb(left(CASE WHEN f->>'commitment' IS NULL
          THEN format('Khoản %s: chưa có cam kết chi "%s" cho tháng %s ở toà này',i,v_res->>'typeName',to_char((v_res->>'periodStart')::date,'MM/YYYY'))
          ELSE format('Khoản %s: cam kết "%s" tháng %s là %s, còn %s trước khoản này%s',i,v_res->>'typeName',to_char((v_res->>'periodStart')::date,'MM/YYYY'),
            app_private.hermes_vnd_text_v1((f->>'commitment')::numeric),app_private.hermes_vnd_text_v1((f->>'remaining')::numeric),
            CASE WHEN (v_item->>'amount')::numeric>(f->>'remaining')::numeric THEN ' — khoản này VƯỢT phần còn lại' ELSE '' END) END,300));
      END IF;
      IF (v_res->>'voucherDate')::date<v_today-7 THEN
        v_warnings:=v_warnings||to_jsonb(format('Khoản %s: ngày phiếu lùi %s ngày so với hôm nay',i,v_today-(v_res->>'voucherDate')::date)); END IF;
      IF (v_res->>'voucherDate')::date>v_today THEN v_warnings:=v_warnings||to_jsonb(format('Khoản %s: ngày phiếu ở tương lai',i)); END IF;
      IF (v_item->>'amount')::numeric>=50000000 THEN
        v_warnings:=v_warnings||to_jsonb(format('Khoản %s: số tiền lớn (từ 50 triệu) — đọc lại số cho người dùng',i)); END IF;
      IF mod((v_item->>'amount')::numeric,1000)<>0 THEN
        v_warnings:=v_warnings||to_jsonb(format('Khoản %s: số tiền không tròn nghìn — kiểm lại đơn vị (nghìn/triệu)',i)); END IF;
    END LOOP;
    SELECT COALESCE(jsonb_agg(w),'[]'::jsonb) INTO v_warnings FROM (SELECT w FROM jsonb_array_elements(v_warnings) w LIMIT 10) x;
    RETURN jsonb_build_object('kind','preview','basis',v_run->>'basis','resolved',v_resolved,'confirm','required','warnings',v_warnings,
      'preview',jsonb_build_object('summary',format('Ghi %s phiếu chi, tổng %s.',jsonb_array_length(v_items),app_private.hermes_vnd_text_v1(v_total)),
        'items',v_items,'note','Chưa nhận ảnh qua Zalo: sau khi ghi, thêm ảnh ở trang phiếu.'));
  END IF;

  -- Lượt 2: ghi cả lô hoặc không gì (TC3). Biên nhận mở trong cùng khối con: lệch bản đã xem hay một khoản lỗi ⇒ lùi cả lô lẫn
  -- biên nhận (không chốt) ⇒ state_changed, người dùng xem trước lại.
  BEGIN
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
    IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
    v_run:=app_private.hermes_expense_create_run_v1(v_org,p_params,v_resolved,'hermes-expense:'||p_request_id::text);
    IF v_run->>'basis' IS DISTINCT FROM p_expected_basis THEN RAISE EXCEPTION 'hermes_expense_state_changed' USING ERRCODE='HS001'; END IF;
    i:=0;
    FOR f IN SELECT value FROM jsonb_array_elements(v_run->'facts') LOOP
      i:=i+1; v_res:=v_resolved->'items'->(i-1); v_item:=p_params->'items'->(i-1);
      v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('code',f->>'code','building',v_res->>'buildingName','room',v_res->>'roomName',
        'category',v_res->>'typeName','amount',(v_item->>'amount'),'amountText',app_private.hermes_vnd_text_v1((v_item->>'amount')::numeric),
        'cashbook',v_res->>'cashbookName','voucherDate',v_res->>'voucherDate','approvalStatus',f->>'approvalStatus','postingStatus',f->>'postingStatus',
        'statusText',CASE WHEN f->>'approvalStatus'='APPROVED' AND f->>'postingStatus'='POSTED' THEN 'Đã duyệt và CHI khỏi sổ '||(v_res->>'cashbookName')
          WHEN f->>'approvalStatus'='APPROVED' THEN 'Đã duyệt, chưa vào sổ' ELSE 'Chờ duyệt; thêm ảnh chứng từ ở trang phiếu để chi được' END)));
    END LOOP;
    v_outcome:=jsonb_build_object('kind','applied','result',jsonb_build_object('vouchers',v_items),
      'link',CASE WHEN jsonb_array_length(v_run->'facts')=1 THEN '/income-expense/voucher/'||(v_run#>>'{facts,0,id}') ELSE '/income-expense' END);
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
  EXCEPTION
    WHEN SQLSTATE 'HS001' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed');
    WHEN OTHERS THEN
      IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
      -- Lượt 1 đã chạy thử cùng hàm ghi mà qua: lỗi ở đây nghĩa là dữ liệu đã đổi sau bản xem trước ⇒ không ghi gì, xem trước lại.
      RETURN jsonb_build_object('kind','rejected','reason','state_changed');
  END;
END $fn$;

-- 5. Vỏ public (đầu hàm theo khuôn lane migrate:forward nhận cho thân SQL-standard ghi, như public.hermes_action_probe_v1).
CREATE OR REPLACE FUNCTION public.hermes_expense_write_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb DEFAULT NULL,p_expected_basis text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
  WITH g AS MATERIALIZED (SELECT app_private.hermes_action_guard_v1(p_binding,p_action) AS ctx),
  r AS MATERIALIZED (SELECT CASE WHEN p_phase IN ('preview','auto') AND jsonb_typeof(p_params)='object' THEN
      app_private.hermes_expense_resolve_core_v1((g.ctx->>'organizationId')::uuid,ARRAY(SELECT jsonb_array_elements_text(g.ctx->'buildingIds')::uuid),
        p_action,p_params) END AS resolution FROM g)
  SELECT app_private.hermes_expense_write_step_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,r.resolution) FROM r;
END;

ALTER FUNCTION app_private.hermes_expense_reason_v1(text,text,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_expense_create_run_v1(uuid,jsonb,jsonb,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_vnd_text_v1(numeric) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_vn_date_text_v1(date,date) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_expense_reason_v1(text,text,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_expense_create_run_v1(uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_vnd_text_v1(numeric) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_vn_date_text_v1(date,date) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ INVOKER chạy dưới authenticated nên cần EXECUTE trên đúng các hàm app_private nó gắn OID (lõi giải tên, bước ghi; guard đã cấp ở
-- 20261021133823). Ánh xạ lý do, chạy lô, định dạng chỉ bước ghi (DEFINER) gọi: không cấp cho authenticated.
GRANT EXECUTE ON FUNCTION app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND NOT prosecdef AND prosqlbody IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)'::regprocedure AND NOT prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure AND prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_expense_create_run_v1(uuid,jsonb,jsonb,text)'::regprocedure AND prosecdef)
    OR has_function_privilege('anon','public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_expense_create_run_v1(uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_expense_reason_v1(text,text,text)','EXECUTE')
    OR (SELECT count(*) FROM app_private.hermes_action_policies WHERE action IN ('expense.create','expense.note') AND capability='income_expenses.create'
      AND crm_permission='income_expenses.create' AND private_only)<>2
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_action_policies WHERE action='expense.create' AND action_class='money' AND confirm='always')
    OR app_private.hermes_expense_reason_v1('42501','[NOT_MANUAL] Phiếu do hệ thống sinh (x) — xử lý ở luồng nguồn.')<>'system_voucher'
    OR app_private.hermes_expense_reason_v1('55000','finance_v2_post_manual_voucher: at least one FINALIZED evidence is required')<>'evidence_required'
    OR app_private.hermes_expense_reason_v1('P0001','[PROFIT_LOCKED] Tháng 10 của toà A đã chốt lợi nhuận')<>'period_locked'
    OR app_private.hermes_expense_reason_v1('XX999','lạ')<>'crm_refused' THEN
    RAISE EXCEPTION 'hermes_expense_write_catalog_invalid'; END IF;
END $check$;
COMMIT;
