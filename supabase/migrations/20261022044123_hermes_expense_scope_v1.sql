-- Đợt 2 Thu chi — Mốc 3 (22/10/2026; docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 17): xem trước và ghi dùng CÙNG hàm kiểm quyền với
-- hàm ghi web, và nhận toà ảo. Áp SAU 20261022024834_hermes_expense_write_v1 và 20261022044120_hermes_name_directory_virtual_v1.
-- Lỗi đo trên TEST 22/10 (tầng 2): guard Hermes (app_private.hermes_action_guard_v1: role_bindings qua authorized_scope_v3) cho toà vào
-- phạm vi khoá income_expenses.create, nhưng create_income_expense_v1 (production = TEST, md5 8fc6ec5f…) kiểm bằng
-- app_private.authorize_income_expense_on_building(actor, org, 'create', toà) — chỉ dựa trên staff_assignments (vai + người cấp là OWNER +
-- toà/khu/mọi toà), không có nhánh miễn cho chủ ⇒ tài khoản chỉ có role_bindings bị 42501. Luật 17/10: guard và hàm ghi dùng cùng một hàm
-- kiểm quyền ⇒ không bao giờ xem trước "được" rồi ghi "không được", và ngược lại.
--  (1) app_private.hermes_expense_scope_v1(binding, action) DEFINER: ctx của guard; với expense.create, buildingIds chỉ giữ toà mà
--      authorize_income_expense_on_building(app_private.current_uid_v1(), org, 'create', toà) — ĐÚNG lời gọi của hàm ghi — cho phép.
--      Hàm guard chung và hermes_action_capabilities_v1 không đổi (dùng chung mọi trang).
--  (2) app_private.hermes_expense_resolve_core_v1 (thay thân, cùng chữ ký): toà/phòng giải bằng public.hermes_write_name_resolve_v2(..., true)
--      ⇒ nhận toà ảo (chi phí chung). Toà ngoài tập (1) mà người hỏi thấy ⇒ outside_scope ngay ở bản xem trước.
--  (3) app_private.hermes_expense_write_step_v1 (thay thân, cùng chữ ký): dùng (1) thay guard; expense.note ở lượt xem trước cũng CHẠY THỬ
--      append_income_expense_supplement_v1 rồi lùi (khuôn TC2 của expense.create) ⇒ xem trước "được" ⇔ ghi được.
--  (4) public.hermes_expense_write_v1 (thay thân SQL-standard, cùng chữ ký): gắn OID của (1) thay guard.
-- Phần còn lại của ba thân chép nguyên từ 20261022024834 (sinh bằng script, chỉ ba chỗ sửa nêu trên). Không ghi dữ liệu. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_action_guard_v1(jsonb,text)') IS NULL
    OR to_regprocedure('app_private.authorize_income_expense_on_building(uuid,uuid,text,uuid)') IS NULL
    OR to_regprocedure('app_private.current_uid_v1()') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v2(uuid,uuid[],jsonb,boolean)') IS NULL
    OR to_regprocedure('app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)') IS NULL
    OR to_regprocedure('public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)') IS NULL
    OR to_regprocedure('public.append_income_expense_supplement_v1(uuid,text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'hermes_expense_scope_dependency_invalid'; END IF;
END $requires$;

-- 1. Phạm vi thao tác thu chi = guard ∩ hàm kiểm quyền của hàm ghi web.
CREATE OR REPLACE FUNCTION app_private.hermes_expense_scope_v1(p_binding jsonb,p_action text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; v_org uuid; v_actor uuid; v_kept uuid[];
BEGIN
  ctx:=app_private.hermes_action_guard_v1(p_binding,p_action);
  IF p_action='expense.create' THEN
    -- Đúng lời gọi của create_income_expense_v1 (v_actor := app_private.current_uid_v1(); authorize_…(v_actor, v_org, 'create', toà)).
    v_org:=(ctx->>'organizationId')::uuid; v_actor:=app_private.current_uid_v1();
    SELECT COALESCE(array_agg(x.b ORDER BY x.b),'{}'::uuid[]) INTO v_kept
      FROM (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid b) x
      WHERE v_actor IS NOT NULL AND app_private.authorize_income_expense_on_building(v_actor,v_org,'create',x.b);
    ctx:=ctx||jsonb_build_object('buildingIds',to_jsonb(v_kept));
  END IF;
  RETURN ctx;
END $fn$;

-- 2. Giải tên (thay thân, nhận toà ảo).
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
    -- Toà / phòng (D7), NHẬN toà ảo: chi phí chung ghi ở toà ảo như web Thu chi (ie_form_buildings).
    v_name:=public.hermes_write_name_resolve_v2(p_organization_id,p_building_ids,
      jsonb_strip_nulls(jsonb_build_object('building',v_item->>'buildingName','room',v_item->>'roomName')),true);
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

-- 3. Bước ghi (thay thân: phạm vi (1); expense.note chạy thử khi xem trước).
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
  -- Phạm vi = guard ∩ hàm kiểm quyền của hàm ghi web (hermes_expense_scope_v1): lượt 1 và lượt 2 cùng một tập toà.
  ctx:=app_private.hermes_expense_scope_v1(p_binding,p_action);
  v_org:=(ctx->>'organizationId')::uuid;
  IF p_phase='apply' THEN v_resolved:=p_resolved;
  ELSIF p_resolution->>'status'='unresolved' THEN
    RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field',p_resolution->'field','wanted',p_resolution->'wanted',
      'why',p_resolution->'why','candidates',COALESCE(p_resolution->'candidates','[]'::jsonb),'more',COALESCE(p_resolution->'more','false'::jsonb));
  ELSIF p_resolution->>'status'='rejected' THEN RETURN jsonb_build_object('kind','rejected','reason',p_resolution->>'reason');
  ELSIF p_resolution->>'status'='resolved' THEN v_resolved:=p_resolution->'resolved';
  ELSE RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023';
  END IF;
  -- Phát lại TRƯỚC mọi kiểm phạm vi/hạng mục/sổ (review Mốc 2+3): requestId đã có biên nhận ⇒ trả đúng kết quả đã chốt (hoặc
  -- request_conflict / outcome_unknown), kể cả khi quyền sổ hay phạm vi đổi sau lần ghi. requestId mới vẫn qua đủ kiểm rồi mới mở biên nhận.
  IF p_phase='apply' AND EXISTS(SELECT 1 FROM app_private.hermes_action_receipts r WHERE r.organization_id=v_org AND r.user_id=auth.uid()
      AND r.request_id=p_request_id) THEN
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
    IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409';
  END IF;

  IF p_action='expense.note' THEN
    -- Bản đã giải phải là phiếu của công ty, còn sống, ở toà trong phạm vi khoá.
    SELECT * INTO v_voucher FROM public.income_expenses ie WHERE ie.id=(v_resolved->>'voucherId')::uuid AND ie.organization_id=v_org AND ie.deleted_at IS NULL;
    IF NOT FOUND OR NOT (v_voucher.building_id IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid)) THEN
      RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    v_basis:=md5(jsonb_build_array(p_action,v_voucher.id,v_voucher.code,p_params->>'note')::text);
    IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
    IF p_phase<>'apply' AND NOT (p_phase='auto' AND COALESCE(ctx->>'actionClass'='reversible' AND ctx->>'confirm'='never',false)) THEN
      -- Xem trước = chạy thử đúng hàm ghi web rồi lùi (như expense.create): xem trước "được" ⇔ ghi được.
      BEGIN
        PERFORM public.append_income_expense_supplement_v1(v_voucher.id,p_params->>'note','[]'::jsonb,'hermes-note-dry:'||p_request_id::text);
        RAISE EXCEPTION 'hermes_expense_dry_run' USING ERRCODE='HD001';
      EXCEPTION
        WHEN SQLSTATE 'HD001' THEN NULL;
        WHEN OTHERS THEN
          IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
          GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
          RETURN jsonb_build_object('kind','rejected','reason',app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
      END;
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

-- 4. Vỏ public (thay thân SQL-standard: gắn OID của (1)).
CREATE OR REPLACE FUNCTION public.hermes_expense_write_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb DEFAULT NULL,p_expected_basis text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
  WITH g AS MATERIALIZED (SELECT app_private.hermes_expense_scope_v1(p_binding,p_action) AS ctx),
  r AS MATERIALIZED (SELECT CASE WHEN p_phase IN ('preview','auto') AND jsonb_typeof(p_params)='object' THEN
      app_private.hermes_expense_resolve_core_v1((g.ctx->>'organizationId')::uuid,ARRAY(SELECT jsonb_array_elements_text(g.ctx->'buildingIds')::uuid),
        p_action,p_params) END AS resolution FROM g)
  SELECT app_private.hermes_expense_write_step_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,r.resolution) FROM r;
END;

ALTER FUNCTION app_private.hermes_expense_scope_v1(jsonb,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_expense_scope_v1(jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ INVOKER chạy dưới authenticated và gắn OID của (1) (như guard ở 20261021133823): cần EXECUTE; không có USAGE app_private nên client
-- không gọi theo tên được. Quyền của lõi giải tên, bước ghi, vỏ giữ như 20261022024834 (CREATE OR REPLACE không đổi ACL).
GRANT EXECUTE ON FUNCTION app_private.hermes_expense_scope_v1(jsonb,text) TO authenticated;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_expense_scope_v1(jsonb,text)'::regprocedure AND prosecdef AND provolatile='v')
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND NOT prosecdef AND prosqlbody IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_proc'::regclass
      AND objid='public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND refobjid='app_private.hermes_expense_scope_v1(jsonb,text)'::regprocedure)
    OR EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_proc'::regclass
      AND objid='public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND refobjid='app_private.hermes_action_guard_v1(jsonb,text)'::regprocedure)
    OR position('hermes_write_name_resolve_v2' IN (SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)'::regprocedure))=0
    OR position('hermes_expense_scope_v1' IN (SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure))=0
    OR has_function_privilege('anon','app_private.hermes_expense_scope_v1(jsonb,text)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_expense_scope_catalog_invalid'; END IF;
END $check$;
COMMIT;
