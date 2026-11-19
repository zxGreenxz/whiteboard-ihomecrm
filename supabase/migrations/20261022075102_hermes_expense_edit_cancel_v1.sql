-- Đợt 2 Thu chi — Mốc 4 (22/10/2026; docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 19): sửa + huỷ phiếu CHI lập tay, cờ chính sách
-- TC5 (câu 55), lỗi lô nói khoản số mấy, gợi ý hạng mục tự động không nhận hạng mục dòng tiền. Áp SAU 20261022044123_hermes_expense_scope_v1
-- (Mốc 2–3b đã lên production 22/10).
--  (1) Chính sách expense.edit (khoá income_expenses.edit) và expense.cancel (khoá income_expenses.cancel): quyền CRM giao vào là
--      income_expenses.create như web (TC6: người lập sửa/huỷ phiếu của mình; hàm ghi web kiểm phần còn lại); money / irreversible ⇒ luôn
--      xem trước (sàn hermes_action_policy_floor). Hai khoá đã seed TẮT ở 20261021134531; bật là việc của phiên chính.
--  (2) app_private.hermes_action_flags: cờ chính sách đổi bằng dữ liệu (UPDATE), không sửa mã. expense.recurring_child_manual = false
--      (TC5, TẠM tới khi chủ trả lời câu 55): phiếu con tự lập từ phiếu lặp (income_expenses.repeat_parent_id, generate_recurring_vouchers)
--      KHÔNG tính là phiếu lập tay cho Hermes (sửa, huỷ, và duyệt ở Mốc 5).
--  (3) app_private.hermes_expense_manual_v1(phiếu): NULL nếu bot được sửa/huỷ; không thì mã lý do: web_only (phiếu THU), system_voucher
--      (assert_manual_voucher_v1 của web từ chối, hoặc phiếu con định kỳ khi cờ (2) tắt), period_locked (phiếu trong phiên bàn giao). DEFINER, search_path='' (mọi tên đủ schema).
--  (4) app_private.hermes_expense_create_run_v1 (thay thân): lỗi của một khoản mang HINT hermes_item=<số> ⇒ bản xem trước nói khoản số mấy.
--  (5) app_private.hermes_expense_resolve_core_v1 (thay thân): giải mã phiếu cho expense.edit/.cancel (như expense.note), tên toà/phòng/
--      hạng mục/sổ mới của expense.edit; gợi ý hạng mục tự động không nhận hạng mục dòng tiền (c_money_flow của ie_category_suggest_v1)
--      ⇒ hỏi lại; sổ không giữ ở lô ≥ 2 khoản nói khoản số mấy.
--  (6) app_private.hermes_expense_write_step_v1 (thay thân): expense.edit = revise_pending_income_expense_v1, expense.cancel =
--      cancel_income_expense_flex_v1 — ĐÚNG hàm ghi web; xem trước = chạy thử rồi lùi (phiếu đã vào sổ: "tạo bút toán đảo, KHÔNG khôi phục
--      được"); lượt 2 mở biên nhận, so basis (phiên bản phiếu) rồi ghi trong cùng khối con, CAS phiên bản lệch ⇒ state_changed không chốt; lỗi khác
--      (quyền, kỳ chốt, lỗi lập trình) ⇒ chốt rejected với lý do thật + SQLSTATE trong biên nhận. Nêu đúng toà hiện tại ⇒ giữ phòng.
--      Dòng phiếu khoá FOR UPDATE NOWAIT trước khi gọi hàm web: không chờ web khi đang giữ khoá công ty của guard ⇒ không vòng 40P01.
-- (4)–(6) dựng từ thân ĐANG CHẠY production (đo 22/10 bằng db:query; ghim md5 trong $requires$, thân của chính file này cũng nhận ⇒ áp lại
-- được). Vỏ public.hermes_expense_write_v1 và hermes_expense_scope_v1 không đổi. Không ghi dữ liệu nghiệp vụ. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE pin record;
BEGIN
  IF to_regclass('app_private.hermes_action_policies') IS NULL OR to_regclass('app_private.hermes_capabilities') IS NULL
    OR to_regprocedure('app_private.hermes_expense_scope_v1(jsonb,text)') IS NULL
    OR to_regprocedure('app_private.hermes_expense_reason_v1(text,text,text)') IS NULL
    OR to_regprocedure('app_private.assert_manual_voucher_v1(uuid,text)') IS NULL
    OR to_regprocedure('public.revise_pending_income_expense_v1(uuid,bigint,jsonb,jsonb,text,text)') IS NULL
    OR to_regprocedure('public.cancel_income_expense_flex_v1(uuid,text,bigint,bigint)') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v2(uuid,uuid[],jsonb,boolean)') IS NULL
    OR to_regprocedure('public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)') IS NULL
    OR (SELECT count(*) FROM app_private.hermes_capabilities WHERE capability IN ('income_expenses.edit','income_expenses.cancel') AND mode='action')<>2 THEN
    RAISE EXCEPTION 'hermes_expense_edit_cancel_dependency_invalid'; END IF;
  -- Thân đang chạy phải là bản production đo 22/10 (hoặc thân của chính file này): bản vá khác đã thay hàm ⇒ dừng, không gỡ mất.
  FOR pin IN SELECT * FROM (VALUES
      ('app_private.hermes_expense_create_run_v1(uuid,jsonb,jsonb,text)','9932d56b97e80fa36cb9e65009663d98','b09458a449e47e8cd810341babcdc783'),
      ('app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)','59a3a8fddb6ccbdb86fd7ed323025859','cddbdbc517ac74329edbf916293c9260'),
      ('app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)','d82b120263632eb4774bf635a9a00cc9','5ba3da9c66df803792ab769b29dd24a5')) v(fn,running,own) LOOP
    IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid=to_regprocedure(pin.fn)),'') NOT IN (pin.running,pin.own) THEN
      RAISE EXCEPTION 'hermes_expense_edit_cancel_body_drift: %',pin.fn; END IF;
  END LOOP;
END $requires$;

-- 1. Chính sách hai thao tác (TC6).
INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES
  ('expense.edit','income_expenses.edit','income_expenses.create','money','always',true),
  ('expense.cancel','income_expenses.cancel','income_expenses.create','irreversible','always',true)
  ON CONFLICT(action) DO NOTHING;

-- 2. Cờ chính sách (TC5).
CREATE TABLE IF NOT EXISTS app_private.hermes_action_flags(
  flag text PRIMARY KEY CHECK (flag ~ '^[a-z][a-z0-9_]{1,31}\.[a-z][a-z0-9_]{1,63}$'),
  enabled boolean NOT NULL,
  note text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 500),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE app_private.hermes_action_flags OWNER TO postgres;
ALTER TABLE app_private.hermes_action_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_action_flags FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
INSERT INTO app_private.hermes_action_flags(flag,enabled,note) VALUES
  ('expense.recurring_child_manual',false,'TC5 / câu 55: phiếu con tự lập từ phiếu lặp có tính là phiếu lập tay để Hermes sửa, huỷ, duyệt không. TẠM false tới khi chủ trả lời; đổi bằng UPDATE, không sửa mã.')
  ON CONFLICT(flag) DO NOTHING;

-- 3. Phiếu bot được sửa/huỷ.
CREATE OR REPLACE FUNCTION app_private.hermes_expense_manual_v1(p_voucher uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v public.income_expenses;
BEGIN
  SELECT * INTO v FROM public.income_expenses ie WHERE ie.id=p_voucher AND ie.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v.type IS DISTINCT FROM 'EXPENSE' THEN RETURN 'web_only'; END IF;
  -- Đúng allow-list "lập tay" của web (assert_manual_voucher_v1: luồng sở hữu, hoá đơn/thanh toán, lương, cổ đông, bút toán đảo, bàn giao,
  -- system_source, giữ chỗ chi lợi nhuận) — không chép điều kiện sang đây.
  BEGIN
    PERFORM app_private.assert_manual_voucher_v1(p_voucher,'xử lý');
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE IN ('40001','40P01','55P03') THEN RAISE; END IF;
    RETURN app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM);
  END;
  -- TC5 / câu 55: phiếu con tự lập từ phiếu lặp (repeat_parent_id) tính là lập tay chỉ khi cờ bật (mặc định TẠM false).
  IF v.repeat_parent_id IS NOT NULL AND NOT COALESCE((SELECT f.enabled FROM app_private.hermes_action_flags f
      WHERE f.flag='expense.recurring_child_manual'),false) THEN RETURN 'system_voucher'; END IF;
  RETURN NULL;
END $fn$;

-- 4. Chạy lô: lỗi một khoản mang số khoản (thay thân).
CREATE OR REPLACE FUNCTION app_private.hermes_expense_create_run_v1(p_org uuid,p_params jsonb,p_resolved jsonb,p_key_prefix text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  v_item jsonb; v_res jsonb; i int:=0; v_row public.income_expenses; v_fee text; v_force boolean; v_commitment numeric; v_remaining numeric; v_amount numeric;
  v_reason text; v_reason_used boolean; v_dups jsonb; v_facts jsonb:='[]'::jsonb; v_basis jsonb:='[]'::jsonb; v_threshold numeric; v_batch uuid[]:='{}';
  v_state text; v_msg text; v_detail text; v_constraint text;
BEGIN
  SELECT c.threshold INTO v_threshold FROM app_private.ie_auto_approve_config c WHERE c.organization_id=p_org;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_params->'items') LOOP
    i:=i+1; v_res:=p_resolved->'items'->(i-1); v_amount:=(v_item->>'amount')::numeric;
    BEGIN
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
    EXCEPTION WHEN OTHERS THEN
      -- Mốc 4 (review): lỗi của khoản thứ i mang số khoản (HINT hermes_item=i) ⇒ bản xem trước nói khoản số mấy; mã lỗi, câu lỗi, ràng
      -- buộc giữ nguyên (phân loại lý do và lỗi tạm không đổi).
      GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE,v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_constraint=CONSTRAINT_NAME;
      RAISE EXCEPTION USING ERRCODE=v_state,MESSAGE=v_msg,DETAIL=v_detail,HINT='hermes_item='||i,CONSTRAINT=v_constraint;
    END;
  END LOOP;
  RETURN jsonb_build_object('facts',v_facts,'basis',md5(v_basis::text));
END $fn$;

-- 5. Giải tên (thay thân).
CREATE OR REPLACE FUNCTION app_private.hermes_expense_resolve_core_v1(p_organization_id uuid,p_building_ids uuid[],p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_item jsonb; v_out jsonb:='[]'::jsonb; v_name jsonb; v_building uuid; v_type uuid; v_type_name text; v_auto boolean; v_cashbook uuid;
  v_cashbook_name text; v_last uuid; v_date date; v_today date:=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date; v_period_start date; v_period_end date;
  v_wanted text; v_hits jsonb; v_suggest jsonb; v_code text; v_voucher record; v_count int; v_visible int; v_i int:=0; v_extra jsonb;
  -- Hạng mục dòng tiền (= c_money_flow của public.ie_category_suggest_v1; test khoá hai danh sách bằng nhau).
  c_money_flow CONSTANT text[]:=ARRAY['noi_bo','bo_sung_hoan_coc','tra_tien_thua_khach','chia_loi_nhuan'];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_expense_resolve_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_building_ids IS NULL OR p_action IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object' THEN
    RAISE EXCEPTION 'hermes_expense_resolve_invalid' USING ERRCODE='22023'; END IF;
  IF p_action IN ('expense.note','expense.edit','expense.cancel') THEN
    v_code:=upper(btrim(p_params->>'voucherCode'));
    IF v_code IS NULL OR v_code='' THEN RAISE EXCEPTION 'hermes_expense_resolve_invalid' USING ERRCODE='22023'; END IF;
    SELECT count(*) FILTER (WHERE ie.building_id=ANY(p_building_ids)),count(*) INTO v_count,v_visible
      FROM public.income_expenses ie WHERE ie.organization_id=p_organization_id AND upper(ie.code)=v_code AND ie.deleted_at IS NULL;
    IF v_count=1 THEN
      SELECT ie.id,ie.code,ie.building_id INTO v_voucher FROM public.income_expenses ie WHERE ie.organization_id=p_organization_id
        AND upper(ie.code)=v_code AND ie.deleted_at IS NULL AND ie.building_id=ANY(p_building_ids);
      v_extra:=jsonb_build_object('voucherId',v_voucher.id,'voucherCode',v_voucher.code,'buildingId',v_voucher.building_id);
      IF p_action='expense.edit' THEN
        -- Mốc 4, expense.edit: tên mới (nếu nêu) giải như expense.create. Toà mới trong phạm vi khoá (nhận toà ảo); chỉ nêu phòng ⇒ phòng
        -- trong toà của phiếu. Hạng mục / sổ chỉ nhận tên người dùng nêu (sửa không tự gợi ý).
        IF NULLIF(btrim(p_params->>'buildingName'),'') IS NOT NULL OR NULLIF(btrim(p_params->>'roomName'),'') IS NOT NULL THEN
          v_name:=public.hermes_write_name_resolve_v2(p_organization_id,
            CASE WHEN NULLIF(btrim(p_params->>'buildingName'),'') IS NULL THEN ARRAY[v_voucher.building_id] ELSE p_building_ids END,
            jsonb_strip_nulls(jsonb_build_object('building',NULLIF(btrim(p_params->>'buildingName'),''),'room',NULLIF(btrim(p_params->>'roomName'),''))),true);
          IF v_name->>'status'<>'resolved' THEN RETURN v_name; END IF;
          IF NULLIF(btrim(p_params->>'buildingName'),'') IS NOT NULL THEN
            IF v_name#>>'{building,id}' IS NULL THEN RETURN jsonb_build_object('status','unresolved','field','building','wanted',left(btrim(p_params->>'buildingName'),200),
              'why','not_visible','candidates','[]'::jsonb,'more',false); END IF;
            v_extra:=v_extra||jsonb_build_object('newBuildingId',v_name#>>'{building,id}','newBuildingName',v_name#>>'{building,name}');
          END IF;
          IF v_name#>>'{room,id}' IS NOT NULL THEN v_extra:=v_extra||jsonb_build_object('roomId',v_name#>>'{room,id}','roomName',v_name#>>'{room,name}'); END IF;
        END IF;
        IF NULLIF(btrim(p_params->>'category'),'') IS NOT NULL THEN
          v_wanted:=public.hermes_name_fold_v1(p_params->>'category');
          SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'exact',public.hermes_name_fold_v1(t.name)=v_wanted) ORDER BY t.sort_order NULLS LAST,t.name) INTO v_hits
            FROM public.income_expense_types t WHERE t.organization_id=p_organization_id AND t.type='expense' AND t.archived_at IS NULL
              AND NOT COALESCE(t.system_only,false) AND NOT COALESCE(t.manual_hidden,false) AND NOT COALESCE(t.quick_entry_hidden,false)
              AND NOT COALESCE(t.is_restricted,false) AND NOT COALESCE(t.is_deposit,false) AND NOT COALESCE(t.internal_transfer,false)
              AND (public.hermes_name_fold_v1(t.name)=v_wanted OR (char_length(v_wanted)>=2 AND strpos(public.hermes_name_fold_v1(t.name),v_wanted)>0));
          IF (SELECT count(*) FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h WHERE (h->>'exact')::boolean)=1 THEN
            v_hits:=(SELECT jsonb_agg(h) FROM jsonb_array_elements(v_hits) h WHERE (h->>'exact')::boolean);
          END IF;
          IF jsonb_array_length(COALESCE(v_hits,'[]'))<>1 THEN
            RETURN jsonb_build_object('status','unresolved','field','category','wanted',left(btrim(p_params->>'category'),200),
              'why',CASE WHEN jsonb_array_length(COALESCE(v_hits,'[]'))>=2 THEN 'ambiguous' ELSE 'not_visible' END,
              'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',h->>'name')),'[]'::jsonb) FROM (SELECT h FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h LIMIT 8) x),
              'more',jsonb_array_length(COALESCE(v_hits,'[]'))>8);
          END IF;
          v_extra:=v_extra||jsonb_build_object('typeId',v_hits#>>'{0,id}','typeName',v_hits#>>'{0,name}');
        END IF;
        IF NULLIF(btrim(p_params->>'cashbook'),'') IS NOT NULL THEN
          v_wanted:=public.hermes_name_fold_v1(p_params->>'cashbook');
          SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'exact',public.hermes_name_fold_v1(a.name)=v_wanted,'held',c.id IS NOT NULL) ORDER BY a.name) INTO v_hits
            FROM public.accounts a LEFT JOIN public.list_cashbooks_for_expense_v2() c ON c.id=a.id
            WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual,false)
              AND (public.hermes_name_fold_v1(a.name)=v_wanted OR (char_length(v_wanted)>=2 AND strpos(public.hermes_name_fold_v1(a.name),v_wanted)>0));
          IF (SELECT count(*) FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h WHERE (h->>'exact')::boolean)=1 THEN
            v_hits:=(SELECT jsonb_agg(h) FROM jsonb_array_elements(v_hits) h WHERE (h->>'exact')::boolean);
          END IF;
          IF jsonb_array_length(COALESCE(v_hits,'[]'))<>1 THEN
            RETURN jsonb_build_object('status','unresolved','field','cashbook','wanted',left(btrim(p_params->>'cashbook'),200),
              'why',CASE WHEN jsonb_array_length(COALESCE(v_hits,'[]'))>=2 THEN 'ambiguous' ELSE 'not_visible' END,'more',jsonb_array_length(COALESCE(v_hits,'[]'))>8,
              'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',h->>'name')),'[]'::jsonb) FROM (SELECT h FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h
                WHERE (h->>'held')::boolean LIMIT 8) x));
          END IF;
          IF NOT (v_hits#>>'{0,held}')::boolean THEN RETURN jsonb_build_object('status','rejected','reason','cashbook_not_held'); END IF;
          v_extra:=v_extra||jsonb_build_object('cashbookId',v_hits#>>'{0,id}','cashbookName',v_hits#>>'{0,name}');
        END IF;
      END IF;
      RETURN jsonb_build_object('status','resolved','resolved',v_extra);
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
    v_i:=v_i+1;
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
        AND NOT COALESCE(t.is_restricted,false) AND NOT COALESCE(t.is_deposit,false) AND NOT COALESCE(t.internal_transfer,false)
        -- Mốc 4 (review): khoá cứng vào hạng mục dòng tiền (vd "tiền phòng 5 ngày" ⇒ trả tiền thừa khách) không tự nhận ⇒ hỏi lại.
        AND NOT (COALESCE(v_suggest->>'ruleKey','')=ANY(c_money_flow));
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
        IF NOT (v_hits#>>'{0,held}')::boolean THEN RETURN jsonb_strip_nulls(jsonb_build_object('status','rejected','reason','cashbook_not_held','item',CASE WHEN jsonb_array_length(p_params->'items')>1 THEN v_i END)); END IF;
        v_cashbook:=(v_hits#>>'{0,id}')::uuid; v_cashbook_name:=v_hits#>>'{0,name}';
      ELSE
        RETURN jsonb_build_object('status','unresolved','field','cashbook','wanted',left(btrim(v_item->>'cashbook'),200),
          'why',CASE WHEN jsonb_array_length(COALESCE(v_hits,'[]'))>=2 THEN 'ambiguous' ELSE 'not_visible' END,'more',jsonb_array_length(COALESCE(v_hits,'[]'))>8,
          'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',h->>'name')),'[]'::jsonb) FROM (SELECT h FROM jsonb_array_elements(COALESCE(v_hits,'[]')) h
            WHERE (h->>'held')::boolean LIMIT 8) x));
      END IF;
    ELSE
      v_cashbook:=public.ie_default_cashbook_v1(p_organization_id,v_building,v_last);
      IF v_cashbook IS NULL THEN RETURN jsonb_strip_nulls(jsonb_build_object('status','rejected','reason','cashbook_not_held','item',CASE WHEN jsonb_array_length(p_params->'items')>1 THEN v_i END)); END IF;
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

-- 6. Bước ghi (thay thân).
CREATE OR REPLACE FUNCTION app_private.hermes_expense_write_step_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  ctx jsonb; v_org uuid; v_resolved jsonb; v_res jsonb; v_run jsonb; v_basis text; v_begin jsonb; v_outcome jsonb; v_constraint text;
  v_items jsonb:='[]'::jsonb; v_warnings jsonb:='[]'::jsonb; f jsonb; v_item jsonb; v_today date:=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  v_total numeric:=0; v_will text; v_why text; v_voucher public.income_expenses; d jsonb; i int;
  v_hint text; v_patch jsonb; v_new_items jsonb; v_changes jsonb; v_out jsonb; v_count int; v_line record; v_shift boolean; v_posted boolean;
  v_cashbook_name text; v_summary text; v_moved boolean; v_err_state text; v_err_msg text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('expense.create','expense.note','expense.edit','expense.cancel') OR p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply')
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
  ELSIF p_resolution->>'status'='rejected' THEN
    RETURN jsonb_strip_nulls(jsonb_build_object('kind','rejected','reason',p_resolution->>'reason','item',p_resolution->'item'));
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

  IF p_action IN ('expense.edit','expense.cancel') THEN
    -- Mốc 4: phiếu đã giải phải của công ty, còn sống, ở toà trong phạm vi khoá, và là phiếu CHI lập tay (hermes_expense_manual_v1: THU ⇒
    -- web_only; luồng hệ thống, hoặc phiếu con định kỳ khi cờ TC5 tắt ⇒ system_voucher). Lượt 2 kiểm lại: bản đã giải đến từ connector.
    -- Khoá dòng phiếu NOWAIT TRƯỚC khi gọi hàm web (Mốc 4b, cùng mẫu Hoá đơn #279): guard dùng chung đã giữ dòng CÔNG TY từ đầu giao dịch,
    -- còn hàm web (cancel_income_expense_flex_v1, trigger vòng đời) giữ dòng phiếu rồi mới khoá công ty ⇒ chờ phiếu ở đây là vòng 40P01.
    -- NOWAIT ⇒ 55P03 ngay (connector: state_changed, xem trước lại), Hermes không bao giờ chờ web.
    SELECT * INTO v_voucher FROM public.income_expenses ie WHERE ie.id=(v_resolved->>'voucherId')::uuid AND ie.organization_id=v_org AND ie.deleted_at IS NULL
      FOR UPDATE NOWAIT;
    IF NOT FOUND OR NOT (v_voucher.building_id IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid)) THEN
      RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    v_why:=app_private.hermes_expense_manual_v1(v_voucher.id);
    IF v_why IS NOT NULL THEN RETURN jsonb_build_object('kind','rejected','reason',v_why); END IF;
    SELECT count(*)::int INTO v_count FROM public.income_expense_items it WHERE it.income_expense_id=v_voucher.id;
    SELECT it.income_expense_type_id type_id,t.name type_name,it.description,it.quantity,it.unit_price,it.start_date,it.end_date INTO v_line
      FROM public.income_expense_items it LEFT JOIN public.income_expense_types t ON t.id=it.income_expense_type_id
      WHERE it.income_expense_id=v_voucher.id ORDER BY it.created_at,it.id LIMIT 1;

    IF p_action='expense.edit' THEN
      IF NOT (p_params ?| ARRAY['amount','category','content','payee','voucherDate','cashbook','buildingName','roomName']) THEN
        RETURN jsonb_build_object('kind','rejected','reason','invalid_params'); END IF;
      IF (v_resolved ? 'newBuildingId' AND NOT ((v_resolved->>'newBuildingId')::uuid IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid)))
        OR (v_resolved ? 'roomId' AND NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=(v_resolved->>'roomId')::uuid AND r.organization_id=v_org
          AND r.deleted_at IS NULL AND r.building_id=COALESCE((v_resolved->>'newBuildingId')::uuid,v_voucher.building_id)))
        OR (v_resolved ? 'typeId' AND NOT app_private.hermes_expense_category_ok_v1(v_org,(v_resolved->>'typeId')::uuid)) THEN
        RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
      IF v_resolved ? 'cashbookId' AND NOT app_private.hermes_expense_cashbook_ok_v1(v_org,auth.uid(),(v_resolved->>'cashbookId')::uuid) THEN
        RETURN jsonb_build_object('kind','rejected','reason','cashbook_not_held'); END IF;
      -- Tiền / hạng mục chỉ sửa qua bot khi phiếu có đúng một dòng hạng mục (phiếu của Báo chi nhanh và của Hermes); nhiều dòng ⇒ web.
      IF (p_params ? 'amount' OR v_resolved ? 'typeId') AND v_count<>1 THEN RETURN jsonb_build_object('kind','rejected','reason','web_only'); END IF;
      -- Patch theo khoá của revise_pending_income_expense_v1. Nêu đúng toà hiện tại ⇒ không đổi toà, giữ phòng (review Mốc 4). Đổi toà thật ⇒
      -- phòng theo toà mới; không nêu phòng ⇒ bỏ phòng, bản xem trước cảnh báo.
      v_moved:=v_resolved ? 'newBuildingId' AND (v_resolved->>'newBuildingId')::uuid IS DISTINCT FROM v_voucher.building_id;
      v_patch:=jsonb_strip_nulls(jsonb_build_object('name',p_params->>'content','payer_name',p_params->>'payee','voucher_date',p_params->>'voucherDate',
        'account_id',v_resolved->>'cashbookId','building_id',CASE WHEN v_moved THEN v_resolved->>'newBuildingId' END));
      IF v_moved OR v_resolved ? 'roomId' THEN v_patch:=v_patch||jsonb_build_object('room_id',v_resolved->'roomId'); END IF;
      -- Dòng hạng mục: đổi tiền (một dòng, số lượng 1) / hạng mục; kỳ một ngày trùng ngày phiếu cũ đi theo ngày phiếu mới (kỳ = ngày phiếu như lúc lập).
      v_shift:=p_params ? 'voucherDate' AND v_count=1 AND v_line.start_date=v_voucher.voucher_date AND v_line.end_date=v_voucher.voucher_date;
      v_new_items:=CASE WHEN p_params ? 'amount' OR v_resolved ? 'typeId' OR v_shift THEN jsonb_build_array(jsonb_build_object(
        'income_expense_type_id',COALESCE(v_resolved->>'typeId',v_line.type_id::text),'description',v_line.description,
        'quantity',CASE WHEN p_params ? 'amount' THEN 1 ELSE v_line.quantity END,'unit_price',COALESCE((p_params->>'amount')::numeric,v_line.unit_price),
        'start_date',CASE WHEN v_shift THEN p_params->>'voucherDate' ELSE v_line.start_date::text END,
        'end_date',CASE WHEN v_shift THEN p_params->>'voucherDate' ELSE v_line.end_date::text END)) END;
      -- Trước → sau cho người dùng (tên, không UUID); trường không đổi thật thì bỏ.
      SELECT COALESCE(jsonb_agg(jsonb_build_object('field',c.f,'before',c.b,'after',c.a) ORDER BY c.n),'[]'::jsonb) INTO v_changes FROM (VALUES
        (1,'số tiền',app_private.hermes_vnd_text_v1(v_voucher.total_amount),app_private.hermes_vnd_text_v1((p_params->>'amount')::numeric)),
        (2,'hạng mục',v_line.type_name,v_resolved->>'typeName'),
        (3,'nội dung',v_voucher.name,p_params->>'content'),
        (4,'người nhận',COALESCE(v_voucher.payer_name,'(trống)'),p_params->>'payee'),
        (5,'ngày phiếu',to_char(v_voucher.voucher_date,'DD/MM/YYYY'),to_char((p_params->>'voucherDate')::date,'DD/MM/YYYY')),
        (6,'sổ quỹ',COALESCE((SELECT a.name FROM public.accounts a WHERE a.id=v_voucher.account_id),'(chưa chọn)'),v_resolved->>'cashbookName'),
        (7,'toà',(SELECT b.name FROM public.buildings b WHERE b.id=v_voucher.building_id),v_resolved->>'newBuildingName'),
        (8,'phòng',COALESCE((SELECT r.name FROM public.rooms r WHERE r.id=v_voucher.room_id),'(không)'),
          CASE WHEN v_moved OR v_resolved ? 'roomId' THEN COALESCE(v_resolved->>'roomName','(không)') END)) c(n,f,b,a)
        WHERE c.a IS NOT NULL AND c.a IS DISTINCT FROM c.b;
      v_basis:=md5(jsonb_build_array(p_action,v_voucher.id,v_voucher.approval_version,v_voucher.posting_version,v_voucher.approval_status,
        v_voucher.posting_status,v_patch,v_new_items,p_params->>'reason')::text);
      IF p_phase<>'apply' THEN
        -- Xem trước = chạy thử revise_pending_income_expense_v1 (đúng hàm web: chỉ phiếu Chờ duyệt, người lập hoặc người có quyền sửa, CAS
        -- phiên bản, lý do khi đổi tiền/hạng mục/sổ/toà, kỳ đã chốt) rồi lùi.
        BEGIN
          v_out:=public.revise_pending_income_expense_v1(v_voucher.id,v_voucher.approval_version,v_patch,v_new_items,p_params->>'reason',
            'hermes-edit-dry:'||p_request_id::text);
          RAISE EXCEPTION 'hermes_expense_dry_run' USING ERRCODE='HD001';
        EXCEPTION
          WHEN SQLSTATE 'HD001' THEN NULL;
          WHEN OTHERS THEN
            IF SQLSTATE IN ('40P01','55P03') THEN RAISE; END IF;
            GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
            RETURN jsonb_build_object('kind','rejected','reason',app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
        END;
        IF NOT COALESCE((v_out->>'changed')::boolean,false) OR jsonb_array_length(v_changes)=0 THEN
          RETURN jsonb_build_object('kind','rejected','reason','invalid_params'); END IF;
        IF (p_params->>'amount')::numeric>=50000000 THEN v_warnings:=v_warnings||to_jsonb('Số tiền lớn (từ 50 triệu) — đọc lại số cho người dùng'::text); END IF;
        IF mod((p_params->>'amount')::numeric,1000)<>0 THEN v_warnings:=v_warnings||to_jsonb('Số tiền không tròn nghìn — kiểm lại đơn vị (nghìn/triệu)'::text); END IF;
        IF (p_params->>'voucherDate')::date<v_today-7 THEN
          v_warnings:=v_warnings||to_jsonb(format('Ngày phiếu lùi %s ngày so với hôm nay',v_today-(p_params->>'voucherDate')::date)); END IF;
        IF (p_params->>'voucherDate')::date>v_today THEN v_warnings:=v_warnings||to_jsonb('Ngày phiếu ở tương lai'::text); END IF;
        IF v_moved AND v_voucher.room_id IS NOT NULL AND NOT v_resolved ? 'roomId' THEN
          v_warnings:=v_warnings||to_jsonb(left(format('Đổi toà: phiếu BỎ phòng %s (phòng của toà cũ); cần phòng ở toà mới thì nêu roomName',
            COALESCE((SELECT r.name FROM public.rooms r WHERE r.id=v_voucher.room_id),'cũ')),300)); END IF;
        SELECT format('Sửa phiếu %s (chờ duyệt): %s.',v_voucher.code,string_agg(format('%s %s → %s',c->>'field',c->>'before',c->>'after'),'; '))
          ||COALESCE(' Lý do: '||(p_params->>'reason')||'.','') INTO v_summary FROM jsonb_array_elements(v_changes) c;
        RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required','warnings',v_warnings,
          'preview',jsonb_strip_nulls(jsonb_build_object('summary',left(v_summary,600),'code',v_voucher.code,'changes',v_changes,'reason',p_params->>'reason',
            'willBe','Sau khi sửa phiếu vẫn CHỜ DUYỆT; lần sửa ghi vào lịch sử phiếu')));
      END IF;
      -- Lượt 2: biên nhận, so basis (phiên bản phiếu + patch) và ghi trong cùng khối con: lệch ⇒ lùi cả biên nhận, state_changed.
      BEGIN
        v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
        IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
        IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
        IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
        IF p_expected_basis IS DISTINCT FROM v_basis THEN RAISE EXCEPTION 'hermes_expense_state_changed' USING ERRCODE='HS001'; END IF;
        v_out:=public.revise_pending_income_expense_v1(v_voucher.id,v_voucher.approval_version,v_patch,v_new_items,p_params->>'reason',
          'hermes-edit:'||p_request_id::text);
        IF NOT COALESCE((v_out->>'changed')::boolean,false) THEN RAISE EXCEPTION 'hermes_expense_state_changed' USING ERRCODE='HS001'; END IF;
        v_outcome:=jsonb_build_object('kind','applied','link','/income-expense/voucher/'||v_voucher.id,'result',jsonb_build_object('code',v_voucher.code,
          'changed',v_changes,'revisionNo',v_out->'revision_no','statusText','Đã sửa; phiếu vẫn chờ duyệt'));
        RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
      EXCEPTION
        WHEN SQLSTATE 'HS001' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed');
        WHEN OTHERS THEN
          IF SQLSTATE IN ('40P01','55P03') OR SQLERRM='hermes_action_outcome_unknown' THEN RAISE; END IF;
          -- Mốc 4b (review): chỉ lỗi do dữ liệu vừa đổi (CAS phiên bản PT409/40001 của hàm web) là state_changed, không chốt. Lỗi khác (quyền
          -- 42501, kỳ đã chốt, hết chờ duyệt, lỗi lập trình ⇒ crm_refused) chốt rejected với lý do thật + SQLSTATE/câu lỗi trong biên nhận để có
          -- dấu vết; khối con đã lùi cả biên nhận ⇒ mở lại rồi chốt; gọi lại cùng requestId phát lại đúng kết cục.
          GET STACKED DIAGNOSTICS v_err_state=RETURNED_SQLSTATE,v_err_msg=MESSAGE_TEXT,v_constraint=CONSTRAINT_NAME;
          v_why:=app_private.hermes_expense_reason_v1(v_err_state,v_err_msg,NULLIF(v_constraint,''));
          IF v_why='state_changed' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
          v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
          IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
          RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,jsonb_build_object('kind','rejected','reason',v_why),
            v_err_state,v_err_msg);
      END;
    END IF;

    -- expense.cancel = cancel_income_expense_flex_v1 (đúng hàm web: người lập / chủ / quyền huỷ + giữ sổ; phiếu đã vào sổ ⇒ bút toán đảo).
    SELECT a.name INTO v_cashbook_name FROM public.accounts a WHERE a.id=v_voucher.account_id;
    v_basis:=md5(jsonb_build_array(p_action,v_voucher.id,v_voucher.approval_version,v_voucher.posting_version,v_voucher.approval_status,
      v_voucher.posting_status,p_params->>'reason')::text);
    IF p_phase<>'apply' THEN
      BEGIN
        v_out:=public.cancel_income_expense_flex_v1(v_voucher.id,p_params->>'reason',v_voucher.approval_version,v_voucher.posting_version);
        RAISE EXCEPTION 'hermes_expense_dry_run' USING ERRCODE='HD001';
      EXCEPTION
        WHEN SQLSTATE 'HD001' THEN NULL;
        WHEN OTHERS THEN
          IF SQLSTATE IN ('40P01','55P03') THEN RAISE; END IF;
          GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
          RETURN jsonb_build_object('kind','rejected','reason',app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
      END;
      -- Hàm web trả changed=false khi phiếu đã huỷ trước đó ⇒ không còn gì để huỷ.
      IF NOT COALESCE((v_out->>'changed')::boolean,false) THEN RETURN jsonb_build_object('kind','rejected','reason','not_pending'); END IF;
      -- "Đã vào sổ" theo kết cục THẬT của lần chạy thử (hàm web viết bút toán đảo hay không), không theo cột trạng thái (review Mốc 4).
      v_posted:=v_out->>'cancellation_kind'='CANCELLED_AFTER_POSTING';
      IF COALESCE(v_voucher.repeat_cycle,'NONE')<>'NONE' AND v_voucher.repeat_parent_id IS NULL THEN
        v_warnings:=v_warnings||to_jsonb('Phiếu lặp lại theo chu kỳ: huỷ thì các kỳ sau KHÔNG tự lập nữa'::text); END IF;
      RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required','warnings',v_warnings,
        'preview',jsonb_strip_nulls(jsonb_build_object(
          'summary',format('Huỷ phiếu %s — %s, %s, %s, ngày %s.',v_voucher.code,app_private.hermes_vnd_text_v1(v_voucher.total_amount),
            COALESCE(v_line.type_name,'?')||CASE WHEN v_count>1 THEN format(' và %s hạng mục khác',v_count-1) ELSE '' END,
            (SELECT b.name FROM public.buildings b WHERE b.id=v_voucher.building_id),to_char(v_voucher.voucher_date,'DD/MM/YYYY')),
          'code',v_voucher.code,'reason',p_params->>'reason',
          'willBe',CASE WHEN v_posted THEN format('ĐÃ VÀO SỔ %s ⇒ huỷ sẽ tạo bút toán đảo (cộng lại %s vào sổ), KHÔNG khôi phục được',
              COALESCE(v_cashbook_name,'quỹ'),app_private.hermes_vnd_text_v1(v_voucher.total_amount))
            ELSE 'CHƯA VÀO SỔ ⇒ phiếu chuyển sang Đã huỷ, sổ quỹ không đổi' END)));
    END IF;
    BEGIN
      v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
      IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
      IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
      IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
      IF p_expected_basis IS DISTINCT FROM v_basis THEN RAISE EXCEPTION 'hermes_expense_state_changed' USING ERRCODE='HS001'; END IF;
      v_out:=public.cancel_income_expense_flex_v1(v_voucher.id,p_params->>'reason',v_voucher.approval_version,v_voucher.posting_version);
      IF NOT COALESCE((v_out->>'changed')::boolean,false) THEN RAISE EXCEPTION 'hermes_expense_state_changed' USING ERRCODE='HS001'; END IF;
      v_outcome:=jsonb_build_object('kind','applied','link','/income-expense/voucher/'||v_voucher.id,'result',jsonb_build_object('code',v_voucher.code,
        'amountText',app_private.hermes_vnd_text_v1(v_voucher.total_amount),'cancellationKind',v_out->>'cancellation_kind',
        'statusText',CASE WHEN v_out->>'cancellation_kind'='CANCELLED_AFTER_POSTING' THEN 'Đã huỷ; đã tạo bút toán đảo vào sổ '||COALESCE(v_cashbook_name,'quỹ')
          ELSE 'Đã huỷ (chưa vào sổ nên sổ quỹ không đổi)' END));
      RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
    EXCEPTION
      WHEN SQLSTATE 'HS001' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed');
      WHEN OTHERS THEN
        IF SQLSTATE IN ('40P01','55P03') OR SQLERRM='hermes_action_outcome_unknown' THEN RAISE; END IF;
        -- Như sửa: chỉ CAS phiên bản ⇒ state_changed; lỗi khác chốt lý do thật + SQLSTATE vào biên nhận.
        GET STACKED DIAGNOSTICS v_err_state=RETURNED_SQLSTATE,v_err_msg=MESSAGE_TEXT,v_constraint=CONSTRAINT_NAME;
        v_why:=app_private.hermes_expense_reason_v1(v_err_state,v_err_msg,NULLIF(v_constraint,''));
        IF v_why='state_changed' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
        v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
        IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
        RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,jsonb_build_object('kind','rejected','reason',v_why),
          v_err_state,v_err_msg);
    END;
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
        -- Mốc 4 (review): lô ≥ 2 khoản ⇒ nói khoản số mấy (HINT hermes_item=i của hermes_expense_create_run_v1).
        GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME,v_hint=PG_EXCEPTION_HINT;
        RETURN jsonb_strip_nulls(jsonb_build_object('kind','rejected','reason',app_private.hermes_expense_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')),
          'item',CASE WHEN jsonb_array_length(p_params->'items')>1 THEN substring(v_hint FROM '^hermes_item=([1-9][0-9]?)$')::int END));
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

ALTER FUNCTION app_private.hermes_expense_manual_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_expense_manual_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Quyền của create_run, lõi giải tên, bước ghi giữ như 20261022024834 (CREATE OR REPLACE không đổi ACL); hermes_expense_manual_v1 chỉ bước
-- ghi (DEFINER, chủ postgres) gọi.

DO $check$
BEGIN
  IF (SELECT count(*) FROM app_private.hermes_action_policies WHERE (action,capability,crm_permission,action_class,confirm,private_only) IN
      (('expense.edit','income_expenses.edit','income_expenses.create','money','always',true),
       ('expense.cancel','income_expenses.cancel','income_expenses.create','irreversible','always',true)))<>2
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_action_flags WHERE flag='expense.recurring_child_manual')
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_expense_manual_v1(uuid)'::regprocedure AND prosecdef AND provolatile='s'
      AND 'search_path=""'=ANY(proconfig))
    OR has_function_privilege('authenticated','app_private.hermes_expense_manual_v1(uuid)','EXECUTE')
    OR has_table_privilege('authenticated','app_private.hermes_action_flags','SELECT')
    OR position('cancel_income_expense_flex_v1' IN (SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure))=0
    OR position('revise_pending_income_expense_v1' IN (SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure))=0
    OR position('hermes_item=' IN (SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_expense_create_run_v1(uuid,jsonb,jsonb,text)'::regprocedure))=0
    OR NOT has_function_privilege('authenticated','public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_expense_edit_cancel_catalog_invalid'; END IF;
END $check$;
COMMIT;
