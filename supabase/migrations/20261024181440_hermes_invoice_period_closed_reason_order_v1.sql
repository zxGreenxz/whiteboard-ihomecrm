-- Đợt 3 trang HOÁ ĐƠN — lượt 14 (25/10/2026, sửa theo nghiệm thu lượt cuối C3c trên TEST; docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md
-- mục 4.1, 4.3, 5, 7). Áp SAU 20261024041712_hermes_invoice_collect_v2 (vỏ + tra cứu / bước ghi thu tiền v2 mà file này chép).
--  (0) app_private.hermes_invoice_lookup_core_v3 = bản chép NGUYÊN tra cứu thu tiền v2 (20261024041712, md5 ghim), chỉ đổi: sổ nhận người
--      dùng nêu (cashbookName) tìm ở CẢ hai danh sách sổ nhận TK và TT của toà, so tên bỏ dấu / hoa thường rồi bỏ khoảng trắng, dấu câu
--      ("HKD Tâm" = HKDTAM); đúng một sổ ⇒ dùng sổ đó, sổ chỉ thuộc MỘT hình thức ⇒ hình thức theo sổ (resolved.methodFromBook); không khớp /
--      nhiều sổ ⇒ hỏi lại sổ, ứng viên kèm hình thức — không rơi về sổ mặc định. Nghiệm thu C3c GHI SAI: "ck vào HKD Tâm" ⇒ TK vào sổ mặc
--      định MBHIEP; đúng là TT vào HKDTAM (sổ TT mặc định của toà). Toà không nêu (một phòng) ⇒ phòng duy nhất trong phạm vi quyết định toà;
--      không thấy phòng, hoặc lô không có toà ⇒ hỏi toà (field building, why unspecified).
--  (1) app_private.hermes_invoice_action_step_v3 = bản chép NGUYÊN bước ghi thu tiền v2 (20261024041712, md5 ghim), khoá NOWAIT giữ nguyên,
--      chỉ đổi: ngày thu tính ngay sau kiểm phạm vi; ngày thu thuộc tháng toà đã CHỐT LỢI NHUẬN ⇒ rejected period_closed (facts.month) TRƯỚC
--      sổ nhận, khoá hoá đơn và kế hoạch. Trước đây kế hoạch nói "nợ đã cộng sang hoá đơn kỳ sau" (needs_input debt_carried), bot hỏi lại
--      kỳ và kẹt. Cùng hàm với web: hàm thu web ghi phiếu thu ngày = ngày thu, trigger income_expenses_check_profit_lock →
--      assert_profit_month_open_v2 → app_private.profit_month_locked_v1(toà, ngày phiếu). Không tự đổi ngày. Hình thức theo sổ của tra cứu v3;
--      bản xem trước mở đầu "Sổ nhận: «…» — hình thức, sổ mặc định / theo sổ người dùng nêu" (+ receivingBook, method); chưa nêu sổ mà toà còn
--      sổ nhận khác ⇒ cảnh báo đầu (kèm ghi chú giống tên sổ khác), không đoán, không đổi sổ.
--  (2) app_private.hermes_invoice_edit_step_v2 = bản chép NGUYÊN bước ghi sửa/huỷ/khôi phục v1 (20261023042723, md5 ghim), chỉ đổi thứ tự:
--      bản xem trước đòi lý do (reason_required, dạng needs_input) SAU mọi kiểm cứng và chạy thử hàm ghi web — bot gọi ngay, không hỏi lý
--      do trước. Điều chỉnh chưa có lý do chạy thử adjust_invoice_v2 với lý do tạm (khối con lùi, không để lại gì) để "tổng mới < đã thu"
--      (adjust_below_collected) hiện ra trước; mã đó kèm facts {collected, totalAfter} (tổng sau làm tròn bằng round_invoice_total_v1 như
--      hàm ghi). Lượt 2 (cùng params với bản xem trước, connector khoá) vẫn kiểm lý do ngay đầu.
--  (3) public.hermes_invoice_action_v1: THAY vỏ SQL-standard của 20261024041712 — chỉ đổi tra cứu + bước ghi thu tiền sang v3, bước ghi
--      sửa/huỷ/khôi phục sang v2 (chỉ số, tra cứu sửa/huỷ giữ nguyên). Ghim băm vỏ mới ở scripts/hermes-task-function-contract.mjs; bản cũ vào FORWARD_SUPERSEDED.
-- Hàm đọc thu theo hình thức (báo cáo collection_by_method) sửa ở file riêng dải gói A 20261024185815_hermes_w2a_invoice_collection_retained_v1
-- (hàng rào gói W2: chỉ file của gói A thay được hàm dùng chung của gói A).
-- Mã/khuôn mới (period_closed, facts, reason / buildingName tuỳ chọn, tên phụ cashbook): connector lượt 14 phải lên TRƯỚC (connector cũ:
-- khoá lạ facts ⇒ backend_unavailable, mã lạ ⇒ crm_refused). Connector mới + SQL cũ vẫn an toàn: sổ đi dưới khoá cashbookName như cũ (SQL cũ chỉ
-- tìm trong sổ của hình thức đã nói ⇒ hỏi lại sổ, không ghi nhầm), thiếu toà ⇒ hỏi lại phòng, thiếu lý do ⇒ hỏi lý do. Không ghi dữ liệu nghiệp vụ. Idempotent (CREATE OR REPLACE; chỉ tạo hàm mới và thay
-- vỏ); khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('app_private.hermes_action_policies') IS NULL OR to_regclass('app_private.hermes_action_receipts') IS NULL
    OR to_regclass('public.profit_monthly') IS NULL
    OR to_regprocedure('app_private.hermes_action_guard_v1(jsonb,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_vnd_text_v1(numeric)') IS NULL
    OR to_regprocedure('app_private.hermes_vn_date_text_v1(date,date)') IS NULL
    OR to_regprocedure('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.lock_org_for_decision_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.current_uid_v1()') IS NULL
    OR to_regprocedure('app_private.receiving_cashbook_ids_v1(uuid,uuid,text,uuid)') IS NULL
    OR to_regprocedure('app_private.profit_month_locked_v1(uuid,date)') IS NULL
    OR to_regprocedure('app_private.round_invoice_total_v1(numeric)') IS NULL
    OR to_regprocedure('app_private.can_edit_invoice_building_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.has_building_perm_v1(uuid,text[])') IS NULL
    OR to_regprocedure('public.can_access_building(uuid)') IS NULL OR to_regprocedure('public.can_do_on_building(text,text,uuid)') IS NULL
    OR to_regprocedure('public.invoice_collection_plan_v1(uuid,jsonb,jsonb)') IS NULL
    OR to_regprocedure('public.get_receiving_cashbooks_v1(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('public.org_today_v1(uuid)') IS NULL
    OR to_regprocedure('public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)') IS NULL
    OR to_regprocedure('public.invoice_adjustment_build_v1(uuid,jsonb)') IS NULL
    OR to_regprocedure('public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamp with time zone,text)') IS NULL
    OR to_regprocedure('public.review_invoice_adjustment_v2(uuid,bigint)') IS NULL
    OR to_regprocedure('public.cancel_invoice_with_credit_v1(uuid,text)') IS NULL
    OR to_regprocedure('public.restore_invoice_with_credit_v1(uuid,text)') IS NULL
    OR to_regprocedure('app_private.hermes_invoice_reason_v1(text,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_invoice_edit_reason_v1(text,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_invoice_lookup_core_v2(uuid,uuid[],text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_invoice_meter_lookup_v1(uuid,uuid[],text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_invoice_edit_lookup_v1(uuid,uuid[],text,jsonb)') IS NULL
    OR to_regprocedure('public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)') IS NULL
    -- Tra cứu + bước ghi thu tiền v2 (20261024041712) và bước ghi sửa/huỷ/khôi phục v1 (20261023042723) đang chạy: bản mới chép đúng thân này (md5 bỏ CR).
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_lookup_core_v2(uuid,uuid[],text,jsonb)'::regprocedure)
      IS DISTINCT FROM 'd1299829d7615c8064f31cd9ab42a63c'
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_action_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure)
      IS DISTINCT FROM '8394f1909849f3af773c56fe32e2f5eb'
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_edit_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure)
      IS DISTINCT FROM '2d3dd50510dbbf050cb38b6bb9bfcf4c' THEN
    RAISE EXCEPTION 'hermes_invoice_l14_dependency_invalid'; END IF;
END $requires$;

-- 0. Tra cứu thu tiền (INVOKER, RLS người hỏi) — bản chép v2 (20261024041712, md5 ghim): sổ người dùng nêu tìm ở cả TK + TT; toà không nêu.
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_lookup_core_v3(p_organization_id uuid,p_building_ids uuid[],p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_method text; v_entries jsonb; v_e jsonb; v_name jsonb; v_building uuid; v_building_name text; v_room uuid; v_room_name text; v_rows jsonb;
  v_pick jsonb; v_open jsonb; v_out jsonb:='[]'::jsonb; v_receiving jsonb; v_list jsonb; v_hits jsonb; v_account uuid; v_wanted text;
  v_number text; v_label text; v_key text; v_book_method text;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_invoice_lookup_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_building_ids IS NULL OR p_action IS DISTINCT FROM 'invoice.collect' OR p_params IS NULL OR jsonb_typeof(p_params)<>'object' THEN
    RAISE EXCEPTION 'hermes_invoice_lookup_invalid' USING ERRCODE='22023'; END IF;
  v_method:=upper(btrim(COALESCE(p_params->>'method','')));
  -- Q13 = c (chủ chốt 21/10): tiền mặt ghi trên web (trang Thu tiền), kể cả chủ ghi hộ — trước mọi tra cứu.
  IF v_method='TM' THEN RETURN jsonb_build_object('status','rejected','reason','cash_collection_web_only'); END IF;
  -- Một phòng (roomName) XOR lô (items ≤ 10); lô không nhận amount / invoiceNumber chung.
  IF v_method NOT IN ('TK','TT') OR (p_params ? 'roomName')=(p_params ? 'items') OR (p_params ? 'items' AND (p_params ? 'amount' OR p_params ? 'invoiceNumber'))
    OR (p_params ? 'items' AND (jsonb_typeof(p_params->'items')<>'array' OR jsonb_array_length(p_params->'items') NOT BETWEEN 1 AND 10)) THEN
    RETURN jsonb_build_object('status','rejected','reason','invalid_params'); END IF;
  v_entries:=CASE WHEN p_params ? 'items' THEN (SELECT jsonb_agg(jsonb_build_object('roomName',e->>'roomName','month',COALESCE(e->>'month',p_params->>'month'),
        'invoiceNumber',e->>'invoiceNumber')) FROM jsonb_array_elements(p_params->'items') e)
    ELSE jsonb_build_array(jsonb_build_object('roomName',p_params->>'roomName','month',p_params->>'month','invoiceNumber',p_params->>'invoiceNumber')) END;
  -- Lượt 14 (nghiệm thu C3c): toà KHÔNG nêu ⇒ một phòng giải trong cả phạm vi được ghi (phòng duy nhất quyết định toà); lô cần toà.
  IF NULLIF(btrim(p_params->>'buildingName'),'') IS NULL AND p_params ? 'items' THEN
    RETURN jsonb_build_object('status','unresolved','field','building','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false); END IF;
  FOR v_e IN SELECT value FROM jsonb_array_elements(v_entries) LOOP
    v_name:=public.hermes_write_name_resolve_v1(p_organization_id,p_building_ids,
      jsonb_strip_nulls(jsonb_build_object('building',p_params->>'buildingName','room',v_e->>'roomName')));
    IF NULLIF(btrim(p_params->>'buildingName'),'') IS NULL AND v_name->>'status'='unresolved' AND v_name->>'field'='room' AND v_name->>'why'='not_visible' THEN
      RETURN jsonb_build_object('status','unresolved','field','building','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false); END IF;
    IF v_name->>'status'<>'resolved' THEN RETURN v_name; END IF;
    v_building:=(v_name#>>'{building,id}')::uuid; v_building_name:=v_name#>>'{building,name}';
    v_room:=(v_name#>>'{room,id}')::uuid; v_room_name:=v_name#>>'{room,name}';
    IF v_building IS NULL OR v_room IS NULL THEN RETURN jsonb_build_object('status','unresolved','field','room','wanted',COALESCE(v_e->>'roomName',''),
      'why','not_visible','candidates','[]'::jsonb,'more',false); END IF;
    SELECT jsonb_agg(to_jsonb(r) ORDER BY r.row_no) INTO v_rows
      FROM public.invoice_room_invoices_v1(p_organization_id,v_room,NULLIF(v_e->>'month',''),ARRAY[v_building]) r;
    v_number:=upper(btrim(NULLIF(v_e->>'invoiceNumber','')));
    v_label:=left(v_room_name||COALESCE(' kỳ '||(v_e->>'month'),'')||COALESCE(' '||(v_e->>'invoiceNumber'),''),200);
    IF v_rows IS NULL THEN
      RETURN jsonb_build_object('status','unresolved','field','invoice','wanted',v_label,'why','not_visible','candidates','[]'::jsonb,'more',false); END IF;
    -- Còn nợ thực, thu được (APPROVED/PARTIAL_PAID/OVERDUE) và nợ chưa kéo sang hoá đơn kỳ sau (#267: nợ đã kéo thu ở hoá đơn gánh).
    SELECT jsonb_agg(r ORDER BY (r->>'row_no')::int) INTO v_open FROM jsonb_array_elements(v_rows) r
      WHERE r->>'status' IN ('APPROVED','PARTIAL_PAID','OVERDUE') AND (r->>'effective_outstanding')::numeric>0
        AND (r->>'carried_out_amount')::numeric=0;
    IF v_number IS NOT NULL THEN
      -- Người dùng chọn đích danh bằng số hoá đơn (từ ứng viên của lần hỏi lại).
      SELECT r INTO v_pick FROM jsonb_array_elements(v_rows) r WHERE upper(btrim(r->>'invoice_number'))=v_number LIMIT 1;
    ELSE
      v_pick:=CASE
        WHEN jsonb_array_length(v_rows)=1 THEN v_rows->0
        WHEN jsonb_array_length(COALESCE(v_open,'[]'::jsonb))=1 THEN v_open->0
        WHEN jsonb_array_length(COALESCE(v_open,'[]'::jsonb))=0 THEN COALESCE(
          -- Không còn nợ thực: hoá đơn còn số phải thu mà nợ đã kéo sang kỳ sau (⇒ debt_carried), nếu không thì hoá đơn chính (⇒ không còn gì để thu).
          (SELECT r FROM jsonb_array_elements(v_rows) r WHERE r->>'status' IN ('APPROVED','PARTIAL_PAID','OVERDUE')
            AND (r->>'remaining_amount')::numeric>0 ORDER BY (r->>'row_no')::int LIMIT 1),v_rows->0) END;
    END IF;
    IF v_pick IS NULL THEN
      -- Ứng viên mang số hoá đơn: hai hoá đơn còn nợ CÙNG kỳ vẫn phân biệt được; mô hình gửi lại invoiceNumber.
      RETURN jsonb_build_object('status','unresolved','field','invoice','wanted',v_label,
        'why',CASE WHEN v_number IS NOT NULL THEN 'not_visible' ELSE 'ambiguous' END,'more',jsonb_array_length(COALESCE(v_open,'[]'::jsonb))>8,
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',
            'kỳ '||to_char(to_date(r->>'billing_month','YYYY-MM'),'MM/YYYY')||COALESCE(' · '||(r->>'invoice_number'),'')||' (còn '
            ||replace(to_char(round((r->>'remaining_amount')::numeric),'FM999,999,999,999,999'),',','.')||'đ'
            ||CASE WHEN r->>'kind'='SETTLEMENT' THEN ', hoá đơn thanh lý' WHEN COALESCE(r->>'kind','MONTHLY')<>'MONTHLY' THEN ', '||lower(r->>'kind') ELSE '' END||')') ORDER BY (r->>'row_no')::int),'[]'::jsonb)
          FROM (SELECT r FROM jsonb_array_elements(COALESCE(v_open,'[]'::jsonb)) r LIMIT 8) x));
    END IF;
    v_out:=v_out||jsonb_build_array(jsonb_build_object('invoiceId',v_pick->>'invoice_id','roomId',v_room,'roomName',v_room_name,
      'invoiceNumber',v_pick->>'invoice_number','billingMonth',v_pick->>'billing_month'));
  END LOOP;
  -- Một hoá đơn không được thu hai lần trong cùng lô.
  IF (SELECT count(DISTINCT x->>'invoiceId') FROM jsonb_array_elements(v_out) x)<>jsonb_array_length(v_out) THEN
    RETURN jsonb_build_object('status','rejected','reason','invalid_params'); END IF;
  -- Sổ nhận người dùng nêu (lượt 14, nghiệm thu C3c: "ck vào HKD Tâm" ghi nhầm sổ mặc định chuyển khoản): tìm trong CẢ hai danh sách sổ nhận
  -- TK và TT của toà (mỗi danh sách = ô sổ của form web theo hình thức), so tên bỏ dấu / hoa thường, rồi bỏ cả khoảng trắng / dấu câu ("HKD Tâm"
  -- = HKDTAM), rồi chứa. Đúng một sổ ⇒ dùng sổ đó; sổ chỉ thuộc MỘT hình thức ⇒ hình thức theo sổ (methodFromBook, bản xem trước nói rõ);
  -- thuộc cả hai ⇒ giữ hình thức người dùng nói. Không khớp / nhiều sổ ⇒ hỏi lại sổ (ứng viên kèm hình thức) — KHÔNG rơi về sổ mặc định.
  IF NULLIF(btrim(p_params->>'cashbookName'),'') IS NOT NULL THEN
    v_receiving:=public.get_receiving_cashbooks_v1(p_organization_id,v_building,NULL);
    SELECT COALESCE(jsonb_agg(b||jsonb_build_object('method',mm.m) ORDER BY mm.o,x.n),'[]'::jsonb) INTO v_list
      FROM (VALUES ('TK',CASE WHEN v_method='TK' THEN 0 ELSE 1 END),('TT',CASE WHEN v_method='TT' THEN 0 ELSE 1 END)) mm(m,o)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v_receiving->mm.m,'[]'::jsonb)) WITH ORDINALITY x(b,n);
    v_wanted:=public.hermes_name_fold_v1(p_params->>'cashbookName');
    v_key:=regexp_replace(v_wanted,'[^a-z0-9]','','g');
    SELECT jsonb_agg(b) INTO v_hits FROM jsonb_array_elements(v_list) b WHERE public.hermes_name_fold_v1(b->>'name')=v_wanted;
    IF v_hits IS NULL THEN
      SELECT jsonb_agg(b) INTO v_hits FROM jsonb_array_elements(v_list) b
        WHERE char_length(v_key)>=2 AND regexp_replace(public.hermes_name_fold_v1(b->>'name'),'[^a-z0-9]','','g')=v_key;
    END IF;
    IF v_hits IS NULL THEN
      SELECT jsonb_agg(b) INTO v_hits FROM jsonb_array_elements(v_list) b
        WHERE char_length(v_key)>=2 AND strpos(regexp_replace(public.hermes_name_fold_v1(b->>'name'),'[^a-z0-9]','','g'),v_key)>0;
    END IF;
    IF (SELECT count(DISTINCT b->>'id') FROM jsonb_array_elements(COALESCE(v_hits,'[]'::jsonb)) b)<>1 THEN
      RETURN jsonb_build_object('status','unresolved','field','cashbook','wanted',left(btrim(p_params->>'cashbookName'),200),
        'why',CASE WHEN v_hits IS NOT NULL THEN 'ambiguous' ELSE 'not_visible' END,'more',jsonb_array_length(CASE WHEN v_hits IS NULL THEN v_list ELSE v_hits END)>8,
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',left(regexp_replace(b->>'name','[0-9]{5,}','***','g'),90)
            ||CASE b->>'method' WHEN 'TK' THEN ' — chuyển khoản (TK)' ELSE ' — thanh toán (TT)' END)),'[]'::jsonb)
          FROM (SELECT b FROM jsonb_array_elements(CASE WHEN v_hits IS NULL THEN v_list ELSE v_hits END) b LIMIT 8) x));
    END IF;
    v_account:=(v_hits#>>'{0,id}')::uuid;
    v_book_method:=CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(v_hits) b WHERE b->>'method'=v_method) THEN v_method ELSE v_hits#>>'{0,method}' END;
  END IF;
  RETURN jsonb_build_object('status','resolved','resolved',jsonb_strip_nulls(jsonb_build_object('buildingId',v_building,'buildingName',v_building_name,
    'method',COALESCE(v_book_method,v_method),'methodFromBook',CASE WHEN v_book_method IS DISTINCT FROM v_method AND v_book_method IS NOT NULL THEN true END,
    'accountId',v_account,'items',v_out)));
END $fn$;

-- 1. Bước ghi thu tiền (DEFINER) — bản chép v2 (20261024041712, md5 ghim): tháng đã chốt lợi nhuận kiểm ngay sau phạm vi; hình thức theo sổ.
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_action_step_v3(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  ctx jsonb; v_org uuid; v_resolved jsonb; v_begin jsonb; v_outcome jsonb; v_constraint text; v_method text; v_method_text text; v_today date; v_date date;
  v_building uuid; v_batch boolean; v_n int; v_res jsonb; v_amount jsonb; v_plan jsonb; v_plans jsonb; v_excluded jsonb; v_ex text;
  v_receiving jsonb; v_no_round boolean; v_try int; v_runs jsonb; v_run jsonb; v_items jsonb; v_warnings jsonb; v_choice jsonb; v_basis text;
  v_total numeric; v_first_reason text; v_label text; v_line text; v_left numeric; v_mode text; v_book text; v_key text; v_retry boolean;
  v_others text; v_note_key text; v_w jsonb; v_text text; v_reason text; v_sum_applied numeric; v_rounding_missing boolean; v_actor uuid; v_round numeric; v_st text; v_settle boolean;
BEGIN
  IF p_action IS DISTINCT FROM 'invoice.collect' OR p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply')
    OR p_request_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_phase='apply' AND (p_resolved IS NULL OR jsonb_typeof(p_resolved)<>'object' OR p_expected_basis IS NULL)) THEN
    RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  v_method:=upper(btrim(COALESCE(p_params->>'method','')));
  IF v_method='TM' THEN RETURN jsonb_build_object('kind','rejected','reason','cash_collection_web_only'); END IF;
  -- Nhãn hình thức như web (RecordPaymentDialog: TK = Chuyển khoản, TT = Thanh toán; toà gọi sổ TT là POS).
  v_method_text:=CASE v_method WHEN 'TK' THEN 'chuyển khoản' ELSE 'thanh toán (TT/POS)' END;
  -- Guard dùng chung đã khoá dòng công ty (hermes_private_command_connection_v1 → lock_org_for_decision_v1) cho cả giao dịch.
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
  -- Lượt 14: sổ người dùng nêu chỉ thuộc MỘT hình thức nhận của toà (tra cứu v3) ⇒ ghi theo hình thức của sổ; còn lại giữ hình thức đã nói.
  IF (v_resolved->>'methodFromBook')::boolean IS TRUE AND v_resolved->>'method' IN ('TK','TT') THEN
    v_method:=v_resolved->>'method'; v_method_text:=CASE v_method WHEN 'TK' THEN 'chuyển khoản' ELSE 'thanh toán (TT/POS)' END; END IF;
  -- Phát lại TRƯỚC mọi kiểm phạm vi/hoá đơn/sổ và mọi khoá (khuôn Thu chi Mốc 3b): requestId đã có biên nhận ⇒ đúng kết quả đã chốt.
  IF p_phase='apply' AND EXISTS(SELECT 1 FROM app_private.hermes_action_receipts r WHERE r.organization_id=v_org AND r.user_id=auth.uid()
      AND r.request_id=p_request_id) THEN
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
    IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409';
  END IF;

  -- Bản đã giải phải còn trong phạm vi guard: toà ∈ guard, cùng hình thức, mỗi hoá đơn thuộc đúng công ty/toà/phòng, không lặp, sổ trong danh sách.
  v_batch:=p_params ? 'items';
  v_building:=NULLIF(v_resolved->>'buildingId','')::uuid;
  IF v_building IS NULL OR NOT (v_building IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid)) OR v_resolved->>'method' IS DISTINCT FROM v_method
    OR jsonb_typeof(v_resolved->'items') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_resolved->'items')<>(CASE WHEN v_batch THEN jsonb_array_length(p_params->'items') ELSE 1 END)
    OR (SELECT count(DISTINCT x->>'invoiceId') FROM jsonb_array_elements(v_resolved->'items') x)<>jsonb_array_length(v_resolved->'items')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_resolved->'items') x WHERE NOT EXISTS(SELECT 1 FROM public.invoices i JOIN public.rooms r ON r.id=i.room_id
      WHERE i.id=NULLIF(x->>'invoiceId','')::uuid AND i.organization_id=v_org AND i.building_id=v_building AND i.deleted_at IS NULL
        AND i.room_id=NULLIF(x->>'roomId','')::uuid AND r.building_id=v_building AND r.organization_id=v_org)) THEN
    RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  v_today:=public.org_today_v1(v_org);
  v_date:=COALESCE(NULLIF(p_params->>'date','')::date,v_today);
  IF v_date>v_today THEN RETURN jsonb_build_object('kind','rejected','reason','date_out_of_range'); END IF;
  -- Lượt 14 (nghiệm thu C3c): ngày thu thuộc tháng toà đã CHỐT LỢI NHUẬN ⇒ từ chối ngay, TRƯỚC sổ nhận, khoá và kế hoạch (nợ đã kéo sang
  -- hoá đơn kỳ sau, làm tròn): cùng hàm của trigger phiếu mà hàm thu web chạm (income_expenses_check_profit_lock → assert_profit_month_open_v2,
  -- theo toà + ngày phiếu = ngày thu). Không tự đổi ngày; facts.month cho câu trả lời.
  IF app_private.profit_month_locked_v1(v_building,v_date) THEN
    RETURN jsonb_build_object('kind','rejected','reason','period_closed','facts',jsonb_build_object('month',to_char(v_date,'YYYY-MM'))); END IF;
  IF v_resolved->>'accountId' IS NOT NULL THEN
    v_receiving:=public.get_receiving_cashbooks_v1(v_org,v_building,NULL);
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(v_receiving->v_method,'[]'::jsonb)) b WHERE b->>'id'=v_resolved->>'accountId') THEN
      RETURN jsonb_build_object('kind','rejected','reason',CASE WHEN p_phase='apply' THEN 'state_changed' ELSE CASE WHEN cardinality(app_private.receiving_cashbook_ids_v1(v_org,v_building,v_method,NULL))>0
          THEN 'receiving_book_not_held' ELSE 'receiving_book_missing' END END); END IF;
  END IF;
  -- Dòng hoá đơn KHÔNG CHỜ (id tăng): v5 của web khoá hoá đơn → công ty, còn Hermes đã giữ công ty từ guard; chờ ở đây là vòng 40P01 với web
  -- đang thu cùng hoá đơn. Bận ⇒ 55P03, giao dịch lùi, connector trả state_changed (xem trước lại); web chạy tiếp ngay.
  PERFORM 1 FROM public.invoices i WHERE i.id IN (SELECT (x->>'invoiceId')::uuid FROM jsonb_array_elements(v_resolved->'items') x)
    ORDER BY i.id FOR UPDATE NOWAIT;
  -- Kiểm quyền của v5 dưới khoá công ty (đã giữ từ guard; gọi lại không chờ).
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  v_actor:=app_private.current_uid_v1();
  IF v_actor IS NULL OR NOT COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(v_actor,v_org,'thu_tien.collect',v_building,NULL) a),false) THEN
    RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  v_mode:=CASE p_params->>'overpay' WHEN 'keep' THEN 'keep' WHEN 'return' THEN 'return' ELSE 'reject' END;
  -- Đã quyết ở bản xem trước: không làm tròn (phần thiếu là cọc theo v5, hoặc chưa có sổ "Làm tròn tiền thiếu"). Chỉ thu hẹp, không nới.
  v_no_round:=COALESCE((v_resolved->>'noRounding')::boolean,false);

  FOR v_try IN 1..2 LOOP
    v_retry:=false; v_plans:='[]'::jsonb; v_excluded:='[]'::jsonb; v_choice:=NULL; v_rounding_missing:=false; v_n:=0;
    -- Kế hoạch từng hoá đơn (một nguồn luật với web: public.invoice_collection_plan_v1), đọc sau khi đã giữ khoá.
    FOR v_res IN SELECT value FROM jsonb_array_elements(v_resolved->'items') LOOP
      v_n:=v_n+1;
      v_amount:=CASE WHEN v_batch THEN p_params->'items'->(v_n-1)->'amount' ELSE p_params->'amount' END;
      v_plan:=public.invoice_collection_plan_v1((v_res->>'invoiceId')::uuid,
        jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('method',v_method,'amount',v_amount,'accountId',v_resolved->>'accountId'))),
        jsonb_build_object('overpay',v_mode,'collectionDate',v_date,'allowRounding',NOT v_no_round));
      IF v_plan->'blockers' ? 'rounding_book_missing' AND NOT v_no_round THEN v_no_round:=true; v_rounding_missing:=true; v_retry:=true; EXIT; END IF;
      v_ex:=CASE WHEN v_plan->'blockers' ? 'not_found' THEN 'not_allowed'
        WHEN v_plan->'blockers' ? 'not_collectible' THEN 'invoice_not_collectible'
        WHEN v_plan->'blockers' ? 'nothing_to_collect' THEN 'nothing_to_collect'
        WHEN (v_plan->>'carriedOut')::numeric>0 THEN 'debt_carried' END;
      IF v_ex='not_allowed' THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
      IF v_ex IS NOT NULL THEN
        -- HDN2: mục không thu được bị loại khỏi lô, nêu ở bản xem trước. Một phòng ⇒ trả lý do.
        IF NOT v_batch THEN RETURN jsonb_build_object('kind','rejected','reason',v_ex); END IF;
        v_excluded:=v_excluded||jsonb_build_array(jsonb_build_object('n',v_n,'invoiceId',v_res->>'invoiceId','reason',v_ex,
          'text',format('%s: %s — bỏ khỏi lần ghi này',v_res->>'roomName',CASE v_ex WHEN 'nothing_to_collect' THEN 'hoá đơn không còn số phải thu'
            WHEN 'invoice_not_collectible' THEN 'hoá đơn nháp/đã huỷ' ELSE 'nợ kỳ này đã cộng vào hoá đơn kỳ sau, thu ở hoá đơn kỳ sau' END)));
        CONTINUE;
      END IF;
      IF v_plan->'blockers' ? 'overpay_needs_choice' THEN
        v_choice:=COALESCE(v_choice,jsonb_build_object('n',v_n,'room',v_res->>'roomName','gross',v_plan->'gross','remaining',v_plan->'remaining',
          'overpay',v_plan->'overpay','canKeep',v_plan->'policy'->'canKeep'));
      ELSIF jsonb_array_length(v_plan->'blockers')>0 THEN
        v_reason:=CASE WHEN v_plan->'blockers' ? 'future_date' THEN 'date_out_of_range'
          WHEN v_plan->'blockers' ? 'invalid_amount' THEN 'amount_out_of_range'
          WHEN v_plan->'blockers' ? 'credit_requires_contract' THEN 'credit_requires_contract'
          WHEN v_plan->'blockers' ? 'receiving_book_missing' THEN CASE WHEN cardinality(app_private.receiving_cashbook_ids_v1(v_org,v_building,v_method,NULL))>0
          THEN 'receiving_book_not_held' ELSE 'receiving_book_missing' END ELSE 'crm_refused' END;
        RETURN jsonb_build_object('kind','rejected','reason',v_reason);
      END IF;
      v_plans:=v_plans||jsonb_build_array(v_plan||jsonb_build_object('n',v_n,'roomName',v_res->>'roomName'));
    END LOOP;
    CONTINUE WHEN v_retry;
    IF jsonb_array_length(v_plans)=0 THEN
      v_first_reason:=v_excluded->0->>'reason';
      RETURN jsonb_build_object('kind','rejected','reason',COALESCE(v_first_reason,'nothing_to_collect'));
    END IF;
    -- Khách trả dư mà chưa chọn: lượt 2 không ghi (HDN4).
    IF v_choice IS NOT NULL AND p_phase='apply' THEN RETURN jsonb_build_object('kind','rejected','reason','overpay_needs_choice'); END IF;
    v_basis:=md5(jsonb_build_array(p_action,v_date,v_method,p_params->>'note',v_resolved->>'accountId',v_no_round,
      (SELECT jsonb_agg(jsonb_build_array(p->'invoiceId',p->'paid',p->'total',p->'status',p->'updatedAt',p->'adjustmentRevision',p->'tenders',
        p->'overpayAction',p->'applied',p->'credit',p->'rounding',p->'returned') ORDER BY (p->>'n')::int) FROM jsonb_array_elements(v_plans) p),
      (SELECT jsonb_agg(jsonb_build_array(e->'invoiceId',e->'reason') ORDER BY (e->>'n')::int) FROM jsonb_array_elements(v_excluded) e))::text);
    EXIT WHEN p_phase='apply' OR v_choice IS NOT NULL;
    -- Lượt 1: CHẠY THỬ đúng hàm ghi web trong khối con rồi lùi — không để lại lần thu, phiếu, bút toán hay khoá idempotency nào.
    BEGIN
      v_runs:='[]'::jsonb;
      FOR v_plan IN SELECT value FROM jsonb_array_elements(v_plans) ORDER BY (value->>'n')::int LOOP
        v_run:=public.record_invoice_collection_v5((v_plan->>'invoiceId')::uuid,v_date,v_plan->'tenders',v_plan->>'overpayAction',
          (v_plan->>'rounding')::numeric>0,NULLIF(btrim(p_params->>'note'),''),NULL,(v_plan->>'paid')::numeric,
          'hermes-dry:'||p_request_id::text||':'||(v_plan->>'n'));
        v_runs:=v_runs||jsonb_build_array(jsonb_build_object('n',(v_plan->>'n')::int,'applied',v_run->'applied_amount','credit',v_run->'credit_amount',
          'rounding',v_run->'rounding_amount','status',v_run->'invoice'->>'status','paid',v_run->'invoice'->'paid_amount',
          'remaining',v_run->'invoice'->'remaining_amount'));
      END LOOP;
      RAISE EXCEPTION 'hermes_invoice_dry_run' USING ERRCODE='HD001';
    EXCEPTION
      WHEN SQLSTATE 'HD001' THEN NULL;
      WHEN OTHERS THEN
        IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
        -- v5 chặn làm tròn bỏ qua cọc/NON_PNL: xem trước lại KHÔNG làm tròn (một lần), bản xem trước nói rõ.
        IF SQLERRM ~* 'làm tròn bỏ qua cọc' AND NOT v_no_round THEN v_no_round:=true; CONTINUE; END IF;
        GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
        RETURN jsonb_build_object('kind','rejected','reason',app_private.hermes_invoice_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
    END;
    EXIT;
  END LOOP;

  IF p_phase<>'apply' THEN
    v_items:='[]'::jsonb; v_warnings:='[]'::jsonb; v_total:=0;
    v_book:=COALESCE(regexp_replace((SELECT a.name FROM public.accounts a WHERE a.id=NULLIF(v_plans->0->'tenders'->0->>'account_id','')::uuid),'[0-9]{5,}','***','g'),'?');
    FOR v_plan IN SELECT value FROM jsonb_array_elements(v_plans) ORDER BY (value->>'n')::int LOOP
      v_run:=(SELECT r FROM jsonb_array_elements(COALESCE(v_runs,'[]'::jsonb)) r WHERE (r->>'n')::int=(v_plan->>'n')::int);
      v_total:=v_total+COALESCE((v_plan->>'gross')::numeric,0);
      v_settle:=EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=(v_plan->>'invoiceId')::uuid AND i.kind::text='SETTLEMENT');
      v_label:=format('Phòng %s toà %s, kỳ %s%s%s',v_plan->>'roomName',v_resolved->>'buildingName',
        to_char(to_date(v_plan->>'billingMonth','YYYY-MM'),'MM/YYYY'),COALESCE(' ('||(v_plan->>'invoiceNumber')||')',''),
        CASE WHEN v_settle THEN ' — hoá đơn thanh lý' ELSE '' END);
      IF v_choice IS NOT NULL THEN
        v_line:=format('%s: còn nợ %s.',v_label,app_private.hermes_vnd_text_v1((v_plan->>'remaining')::numeric));
      ELSE
        v_left:=COALESCE((v_run->>'remaining')::numeric,(v_plan->'after'->>'remaining')::numeric);
        v_round:=COALESCE((v_run->>'rounding')::numeric,(v_plan->>'rounding')::numeric,0);
        v_st:=COALESCE(v_run->>'status',v_plan->'after'->>'status');
        -- "ĐỦ" chỉ khi hết nợ thật. Làm tròn (thiếu < 10.000đ, như web): hoá đơn ĐÃ THANH TOÁN nhưng cột còn nợ (tổng − đã thu) vẫn hiện số lẻ.
        v_line:=format('%s: thu %s; còn nợ %s → %s%s%s.',v_label,app_private.hermes_vnd_text_v1((v_plan->>'gross')::numeric),
          app_private.hermes_vnd_text_v1((v_plan->>'remaining')::numeric),app_private.hermes_vnd_text_v1(v_left),
          CASE WHEN v_st='PAID' AND v_round>0 THEN format(': ĐÃ THANH TOÁN nhờ làm tròn như web — %s số lẻ KHÔNG thu, ghi vào sổ «Làm tròn tiền thiếu»; cột còn nợ của hoá đơn vẫn hiện %s',
              app_private.hermes_vnd_text_v1(v_round),app_private.hermes_vnd_text_v1(v_left))
            WHEN v_st='PAID' AND v_left<=0 THEN ': ĐÃ THANH TOÁN ĐỦ' WHEN v_st='PAID' THEN ': ĐÃ THANH TOÁN' ELSE '' END,
          CASE WHEN (v_plan->>'credit')::numeric>0 THEN format('; dư %s giữ lại cho kỳ sau (tiền dư của khách)',app_private.hermes_vnd_text_v1((v_plan->>'credit')::numeric))
            WHEN (v_plan->>'returned')::numeric>0 THEN format('; phần dư %s KHÔNG ghi vào CRM, anh/chị tự chuyển trả khách',app_private.hermes_vnd_text_v1((v_plan->>'returned')::numeric))
            ELSE '' END);
      END IF;
      v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('room',v_plan->>'roomName','month',to_char(to_date(v_plan->>'billingMonth','YYYY-MM'),'MM/YYYY'),
        'invoiceNumber',v_plan->>'invoiceNumber','amount',(v_plan->>'gross')::numeric::bigint::text,
        'remainingBefore',(v_plan->>'remaining')::numeric::bigint::text,'remainingAfter',CASE WHEN v_choice IS NULL THEN v_left::bigint::text END,
        'statusAfter',CASE WHEN v_choice IS NULL THEN COALESCE(v_run->>'status',v_plan->'after'->>'status') END,
        'rounding',CASE WHEN v_choice IS NULL AND v_round>0 THEN v_round::bigint::text END,'text',v_line)));
      -- Cảnh báo (≤ 10, mỗi câu ≤ 300 ký tự). Mã chưa có câu thì bỏ qua — không bao giờ nối NULL (jsonb || NULL làm mất cả mảng).
      FOR v_w IN SELECT value FROM jsonb_array_elements(COALESCE(v_plan->'warnings','[]'::jsonb)) LOOP
        v_text:=CASE v_w->>'code'
          WHEN 'possible_duplicate' THEN format('Phòng %s: hoá đơn này vừa được thu %s lúc %s bởi %s — có thể THU TRÙNG; hỏi lại người dùng.',v_plan->>'roomName',
            app_private.hermes_vnd_text_v1((v_w->>'grossAmount')::numeric),to_char(((v_w->>'createdAt')::timestamptz) AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI'),
            COALESCE(NULLIF(btrim(v_w->>'collectorName'),''),'một người khác'))
          WHEN 'overdue' THEN format('Phòng %s: hoá đơn đã quá hạn %s ngày.',v_plan->>'roomName',v_w->>'days')
          WHEN 'old_date' THEN format('Ngày thu lùi %s ngày so với hôm nay.',v_w->>'days')
          WHEN 'rounding_deposit_due' THEN format('Phòng %s: còn thiếu %s nhưng không làm tròn được vì hoá đơn còn tiền cọc; hoá đơn còn nợ phần này.',
            v_plan->>'roomName',app_private.hermes_vnd_text_v1((v_w->>'shortage')::numeric))
          ELSE NULL END;
        IF v_text IS NOT NULL THEN v_warnings:=v_warnings||jsonb_build_array(left(v_text,300)); END IF;
      END LOOP;
      IF v_no_round AND (v_plan->>'shortage')::numeric>0 AND (v_plan->>'shortage')::numeric<10000 THEN
        v_warnings:=v_warnings||jsonb_build_array(format('Phòng %s: không làm tròn được phần thiếu %s (%s); hoá đơn còn nợ phần này.',v_plan->>'roomName',
          app_private.hermes_vnd_text_v1((v_plan->>'shortage')::numeric),
          CASE WHEN v_rounding_missing THEN 'công ty chưa có sổ "Làm tròn tiền thiếu"' ELSE 'phần thiếu là tiền cọc' END)); END IF;
      IF (v_plan->>'gross')::numeric>=50000000 THEN
        v_warnings:=v_warnings||jsonb_build_array(format('Phòng %s: số tiền lớn (từ 50 triệu) — đọc lại số cho người dùng.',v_plan->>'roomName')); END IF;
      IF mod((v_plan->>'gross')::numeric,1000)<>0 THEN
        v_warnings:=v_warnings||jsonb_build_array(format('Phòng %s: số tiền không tròn nghìn — kiểm lại đơn vị.',v_plan->>'roomName')); END IF;
    END LOOP;
    IF v_resolved->>'accountId' IS NULL AND v_choice IS NULL THEN
      v_receiving:=public.get_receiving_cashbooks_v1(v_org,v_building,NULL);
      v_note_key:=regexp_replace(public.hermes_name_fold_v1(p_params->>'note'),'[^a-z0-9]','','g');
      SELECT string_agg(format('«%s» (%s)',left(regexp_replace(o.name,'[0-9]{5,}','***','g'),40),o.m),', ' ORDER BY o.ord),
          max(CASE WHEN char_length(v_note_key)>=3 AND strpos(regexp_replace(public.hermes_name_fold_v1(o.name),'[^a-z0-9]','','g'),v_note_key)>0
            THEN format(' Ghi chú «%s» giống tên sổ «%s».',left(btrim(p_params->>'note'),40),left(regexp_replace(o.name,'[0-9]{5,}','***','g'),40)) END)
        INTO v_others,v_text
        FROM (SELECT b->>'name' name,string_agg(mm.m,'/' ORDER BY mm.m) m,min(mm.m||x.n::text) ord FROM (VALUES ('TK'),('TT')) mm(m)
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v_receiving->mm.m,'[]'::jsonb)) WITH ORDINALITY x(b,n)
          WHERE b->>'id' IS DISTINCT FROM v_plans->0->'tenders'->0->>'account_id' GROUP BY b->>'id',b->>'name' ORDER BY 3 LIMIT 4) o;
      IF v_others IS NOT NULL THEN
        v_warnings:=jsonb_build_array(left(format('Chưa nêu sổ nhận nên dùng sổ mặc định «%s» (%s). Toà còn sổ nhận %s. Người dùng đã nói sổ/tài khoản nhận khác thì gọi lại kèm cashbookName (máy chủ chọn hình thức theo sổ), KHÔNG xác nhận bản này.%s',
          v_book,v_method,v_others,COALESCE(v_text,'')),300))||v_warnings; END IF;
    END IF;
    SELECT COALESCE(jsonb_agg(w),'[]'::jsonb) INTO v_warnings FROM (SELECT w FROM jsonb_array_elements(v_warnings) w WHERE jsonb_typeof(w)='string' LIMIT 10) x;
    RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved||jsonb_build_object('noRounding',v_no_round),'confirm','required',
      'warnings',v_warnings,'preview',jsonb_strip_nulls(jsonb_build_object(
        'summary',CASE WHEN v_choice IS NOT NULL THEN
            format('Khách trả %s, còn nợ %s, dư %s. CHƯA chọn: %s',app_private.hermes_vnd_text_v1((v_choice->>'gross')::numeric),
              app_private.hermes_vnd_text_v1((v_choice->>'remaining')::numeric),app_private.hermes_vnd_text_v1((v_choice->>'overpay')::numeric),
              CASE WHEN (v_choice->>'canKeep')::boolean THEN 'giữ lại cho kỳ sau (overpay=keep) hay trả lại khách (overpay=return)? Hỏi người dùng rồi gọi lại kèm overpay, KHÔNG xác nhận bản này.'
                ELSE 'hoá đơn không gắn hợp đồng nên chỉ trả lại khách được (overpay=return). Hỏi người dùng rồi gọi lại kèm overpay, KHÔNG xác nhận bản này.' END)
          ELSE format('Sổ nhận: «%s» — %s, %s. Sẽ ghi THU %s ngày %s cho %s.',v_book,v_method_text,
              CASE WHEN (v_resolved->>'methodFromBook')::boolean IS TRUE THEN format('theo sổ người dùng nêu (sổ này nhận %s, không nhận %s ở toà này)',v_method_text,
                  CASE upper(btrim(p_params->>'method')) WHEN 'TK' THEN 'chuyển khoản' ELSE 'thanh toán (TT/POS)' END)
                WHEN v_resolved->>'accountId' IS NOT NULL THEN 'theo sổ người dùng nêu' ELSE 'sổ mặc định của toà (người dùng chưa nêu sổ)' END,
              app_private.hermes_vnd_text_v1(v_total),app_private.hermes_vn_date_text_v1(v_date,v_today),
              CASE WHEN jsonb_array_length(v_plans)=1 THEN 'hoá đơn '||COALESCE(v_plans->0->>'invoiceNumber','') ELSE jsonb_array_length(v_plans)||' hoá đơn' END) END,
        'choiceRequired',CASE WHEN v_choice IS NOT NULL THEN 'overpay' END,'receivingBook',v_book,'method',v_method,
        'items',v_items,'excluded',CASE WHEN jsonb_array_length(v_excluded)>0 THEN (SELECT jsonb_agg(e->'text' ORDER BY (e->>'n')::int) FROM jsonb_array_elements(v_excluded) e) END,
        'note','Không kèm ảnh biên nhận (thêm ở trang hoá đơn trên web nếu cần).')));
  END IF;

  -- Lượt 2: cả tập hoặc không gì. Biên nhận mở trong cùng khối con: lệch bản đã xem hay một hoá đơn lỗi ⇒ lùi cả lô lẫn biên nhận.
  BEGIN
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
    IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
    IF v_basis IS DISTINCT FROM p_expected_basis THEN RAISE EXCEPTION 'hermes_invoice_state_changed' USING ERRCODE='HS001'; END IF;
    v_items:='[]'::jsonb; v_sum_applied:=0;
    FOR v_plan IN SELECT value FROM jsonb_array_elements(v_plans) ORDER BY (value->>'n')::int LOOP
      v_key:='hermes-inv:'||p_request_id::text||CASE WHEN v_batch THEN ':'||(v_plan->>'n') ELSE '' END;
      v_run:=public.record_invoice_collection_v5((v_plan->>'invoiceId')::uuid,v_date,v_plan->'tenders',v_plan->>'overpayAction',
        (v_plan->>'rounding')::numeric>0,NULLIF(btrim(p_params->>'note'),''),NULL,(v_plan->>'paid')::numeric,v_key);
      -- Hậu điều kiện: có lần thu, số áp đúng kế hoạch, không dòng tiền mặt.
      IF v_run->>'collection_id' IS NULL OR abs((v_run->>'applied_amount')::numeric-(v_plan->>'applied')::numeric)>=0.01
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan->'tenders') t WHERE t->>'payment_method' NOT IN ('TK','TT')) THEN
        RAISE EXCEPTION 'hermes_invoice_postcondition' USING ERRCODE='HS001'; END IF;
      v_sum_applied:=v_sum_applied+(v_run->>'applied_amount')::numeric;
      v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('invoiceNumber',v_plan->>'invoiceNumber','room',v_plan->>'roomName',
        'building',v_resolved->>'buildingName','month',to_char(to_date(v_plan->>'billingMonth','YYYY-MM'),'MM/YYYY'),
        'applied',(v_run->>'applied_amount')::numeric::bigint::text,'credit',NULLIF((v_run->>'credit_amount')::numeric,0)::bigint::text,
        'rounding',NULLIF((v_run->>'rounding_amount')::numeric,0)::bigint::text,
        'remainingAfter',COALESCE((v_run->'invoice'->>'remaining_amount')::numeric,0)::bigint::text,'statusAfter',v_run->'invoice'->>'status',
        'text',format('Đã ghi thu %s bằng %s cho hoá đơn %s%s (%s/%s, kỳ %s). %s%s',app_private.hermes_vnd_text_v1((v_run->>'gross_amount')::numeric),
          v_method_text,COALESCE(v_plan->>'invoiceNumber',''),
          CASE WHEN EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=(v_plan->>'invoiceId')::uuid AND i.kind::text='SETTLEMENT') THEN ' (thanh lý)' ELSE '' END,
          v_resolved->>'buildingName',v_plan->>'roomName',to_char(to_date(v_plan->>'billingMonth','YYYY-MM'),'MM/YYYY'),
          CASE WHEN v_run->'invoice'->>'status'='PAID' AND COALESCE((v_run->>'rounding_amount')::numeric,0)>0 THEN
              format('ĐÃ THANH TOÁN nhờ làm tròn: %s số lẻ không thu, ghi vào sổ «Làm tròn tiền thiếu»; cột còn nợ của hoá đơn vẫn hiện %s.',
                app_private.hermes_vnd_text_v1((v_run->>'rounding_amount')::numeric),
                app_private.hermes_vnd_text_v1(COALESCE((v_run->'invoice'->>'remaining_amount')::numeric,0)))
            WHEN v_run->'invoice'->>'status'='PAID' AND COALESCE((v_run->'invoice'->>'remaining_amount')::numeric,0)<=0 THEN 'Hết nợ — ĐÃ THANH TOÁN ĐỦ.'
            ELSE format('Còn nợ %s%s.',app_private.hermes_vnd_text_v1(COALESCE((v_run->'invoice'->>'remaining_amount')::numeric,0)),
              CASE WHEN v_run->'invoice'->>'status'='PAID' THEN ' — ĐÃ THANH TOÁN' ELSE '' END) END,
          CASE WHEN COALESCE((v_run->>'credit_amount')::numeric,0)>0 THEN format(' Dư %s giữ lại cho kỳ sau (tiền dư của khách).',
              app_private.hermes_vnd_text_v1((v_run->>'credit_amount')::numeric))
            WHEN COALESCE((v_plan->>'returned')::numeric,0)>0 THEN format(' Phần dư %s KHÔNG ghi vào CRM; anh/chị tự chuyển trả khách.',
              app_private.hermes_vnd_text_v1((v_plan->>'returned')::numeric)) ELSE '' END))));
    END LOOP;
    v_outcome:=jsonb_build_object('kind','applied','result',jsonb_strip_nulls(jsonb_build_object('invoices',v_items,
        'applied',v_sum_applied::bigint::text,'excluded',CASE WHEN jsonb_array_length(v_excluded)>0 THEN (SELECT jsonb_agg(e->'text' ORDER BY (e->>'n')::int)
          FROM jsonb_array_elements(v_excluded) e) END)),
      'link',CASE WHEN jsonb_array_length(v_plans)=1 THEN '/invoices/'||(v_plans->0->>'invoiceId') ELSE '/invoices' END);
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
  EXCEPTION
    WHEN SQLSTATE 'HS001' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed');
    WHEN OTHERS THEN
      IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
      -- Lượt 1 đã chạy thử cùng hàm ghi mà qua: lỗi ở đây nghĩa là dữ liệu đã đổi sau bản xem trước ⇒ không ghi gì, xem trước lại.
      RETURN jsonb_build_object('kind','rejected','reason','state_changed');
  END;
END $fn$;

-- 2. Bước ghi sửa/huỷ/khôi phục (DEFINER) — bản chép v1 (20261023042723, md5 ghim): lý do đòi sau kiểm cứng; tổng mới < đã thu kèm facts.
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_edit_step_v2(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  ctx jsonb; v_org uuid; v_resolved jsonb; v_begin jsonb; v_outcome jsonb; v_constraint text; v_reason text; v_today date; v_actor uuid;
  v_building uuid; v_invoice uuid; inv public.invoices%ROWTYPE; v_label text; v_month text; v_basis text; v_note text;
  v_ops jsonb; v_build jsonb; v_ids jsonb; v_adj public.invoice_adjustments%ROWTYPE; v_done public.invoice_adjustments%ROWTYPE;
  v_run jsonb; v_res jsonb; v_items jsonb; v_warnings jsonb:='[]'::jsonb; v_credit numeric:=0; v_carried jsonb; v_c jsonb;
  v_status text; v_remaining numeric; v_when text; v_who text; v_noop boolean:=false; v_status_text text; v_note_ok boolean; v_total_after numeric;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('invoice.adjust','invoice.adjustment_check','invoice.cancel','invoice.restore')
    OR p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply') OR p_request_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_phase='apply' AND (p_resolved IS NULL OR jsonb_typeof(p_resolved)<>'object' OR p_expected_basis IS NULL)) THEN
    RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  -- Guard dùng chung đã khoá dòng công ty (hermes_private_command_connection_v1 → lock_org_for_decision_v1) cho cả giao dịch.
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
  -- Phát lại TRƯỚC mọi kiểm phạm vi/trạng thái và mọi khoá: requestId đã có biên nhận ⇒ đúng kết quả đã chốt.
  IF p_phase='apply' AND EXISTS(SELECT 1 FROM app_private.hermes_action_receipts r WHERE r.organization_id=v_org AND r.user_id=auth.uid()
      AND r.request_id=p_request_id) THEN
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
    IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409';
  END IF;
  -- Lý do bắt buộc (điều chỉnh 8–1000, huỷ/khôi phục 8–500): nằm trong biên nhận + audit Hermes, không ghi đè invoices.notes (HDN8).
  -- Lượt 14 (nghiệm thu C3c): bản xem trước đòi lý do SAU mọi kiểm cứng và chạy thử hàm ghi (tổng mới < đã thu, dòng khoá, đã thu nên
  -- không huỷ…) ⇒ bot gọi ngay, không hỏi lý do trước. Lượt 2 (cùng params với bản xem trước) vẫn kiểm ngay tại đây.
  v_note:=btrim(COALESCE(p_params->>'reason',''));
  v_note_ok:=p_action='invoice.adjustment_check' OR char_length(v_note) BETWEEN 8 AND (CASE WHEN p_action='invoice.adjust' THEN 1000 ELSE 500 END);
  IF p_phase='apply' AND NOT v_note_ok THEN RETURN jsonb_build_object('kind','rejected','reason','reason_required'); END IF;

  -- Bản đã giải phải còn trong phạm vi guard: toà ∈ guard; hoá đơn thuộc đúng công ty/toà/phòng, phòng thuộc đúng toà.
  v_building:=NULLIF(v_resolved->>'buildingId','')::uuid; v_invoice:=NULLIF(v_resolved->>'invoiceId','')::uuid;
  IF v_building IS NULL OR v_invoice IS NULL OR NOT (v_building IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid))
    OR NOT EXISTS(SELECT 1 FROM public.invoices i JOIN public.rooms r ON r.id=i.room_id WHERE i.id=v_invoice AND i.organization_id=v_org
      AND i.building_id=v_building AND i.deleted_at IS NULL AND i.room_id=NULLIF(v_resolved->>'roomId','')::uuid AND r.building_id=v_building
      AND r.organization_id=v_org) THEN
    RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  -- KHÔNG CHỜ: hợp đồng → hoá đơn (→ điều chỉnh). Guard đã giữ công ty; đường web giữ hoá đơn/hợp đồng rồi mới xin công ty (v5, hàm ghi hợp
  -- đồng) ⇒ chờ ở đây là vòng 40P01. Bận ⇒ 55P03, giao dịch lùi, connector trả state_changed. Hàm ghi web gọi sau khoá lại đúng các dòng này.
  PERFORM 1 FROM public.contracts c WHERE c.organization_id=v_org AND c.id=(SELECT i.contract_id FROM public.invoices i WHERE i.id=v_invoice)
    FOR UPDATE NOWAIT;
  SELECT * INTO inv FROM public.invoices i WHERE i.id=v_invoice FOR UPDATE NOWAIT;
  IF p_action='invoice.adjustment_check' THEN
    SELECT * INTO v_adj FROM public.invoice_adjustments a WHERE a.id=NULLIF(v_resolved->>'adjustmentId','')::uuid AND a.invoice_id=v_invoice
      AND a.organization_id=v_org FOR UPDATE NOWAIT;
  END IF;
  -- Quyền: ĐÚNG biểu thức của hàm ghi web (adjust_invoice_v2: invoices.edit; review_invoice_adjustment_v2: invoices.approve; huỷ/khôi
  -- phục: can_edit_invoice_building_v1 + invoices.cancel hoặc invoices.delete — rào câu 26), ngay ở bản xem trước.
  v_actor:=app_private.current_uid_v1();
  IF v_actor IS NULL OR NOT COALESCE(CASE p_action
      WHEN 'invoice.adjust' THEN public.can_access_building(v_building) IS TRUE AND public.can_do_on_building('invoices','edit',v_building) IS TRUE
      WHEN 'invoice.adjustment_check' THEN public.can_access_building(v_building) IS TRUE AND public.can_do_on_building('invoices','approve',v_building) IS TRUE
      ELSE app_private.can_edit_invoice_building_v1(v_building) IS TRUE
        AND app_private.has_building_perm_v1(v_building,'invoices.cancel','invoices.delete') IS TRUE END,false) THEN
    RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  v_today:=public.org_today_v1(v_org);
  v_month:=to_char(to_date(inv.billing_month,'YYYY-MM'),'MM/YYYY');
  v_label:=format('%s (%s/%s, kỳ %s)',COALESCE(inv.invoice_number,'?'),v_resolved->>'buildingName',v_resolved->>'roomName',v_month);

  IF p_action='invoice.adjust' THEN
    -- Thao tác = tham số người dùng + id dòng do tra cứu khớp (đúng thứ tự setItems); dựng dòng sau bằng hàm dùng chung, đọc SAU khi giữ khoá.
    v_ids:=COALESCE(v_resolved->'setItemIds','[]'::jsonb);
    IF jsonb_typeof(v_ids)<>'array' OR (p_params ? 'setItems' AND jsonb_typeof(p_params->'setItems')<>'array')
      OR (p_params ? 'addItems' AND jsonb_typeof(p_params->'addItems')<>'array') OR (p_params ? 'discount' AND jsonb_typeof(p_params->'discount')<>'number')
      OR jsonb_array_length(v_ids)<>(CASE WHEN p_params ? 'setItems' THEN jsonb_array_length(p_params->'setItems') ELSE 0 END) THEN
      RETURN jsonb_build_object('kind','rejected','reason','invalid_params'); END IF;
    v_ops:=jsonb_strip_nulls(jsonb_build_object('discountAdd',p_params->'discount',
      'addItems',(SELECT jsonb_agg(jsonb_build_object('description',btrim(a->>'description'),'amount',a->'amount') ORDER BY n)
        FROM jsonb_array_elements(COALESCE(p_params->'addItems','[]'::jsonb)) WITH ORDINALITY x(a,n)),
      'setItems',(SELECT jsonb_agg(jsonb_build_object('id',v_ids->>(n::int-1),'amount',s->'amount') ORDER BY n)
        FROM jsonb_array_elements(COALESCE(p_params->'setItems','[]'::jsonb)) WITH ORDINALITY x(s,n))));
    BEGIN
      v_build:=public.invoice_adjustment_build_v1(v_invoice,v_ops);
    EXCEPTION WHEN SQLSTATE '22023' THEN RETURN jsonb_build_object('kind','rejected','reason','invalid_params');
    END;
    v_reason:=CASE WHEN v_build->'blockers' ? 'not_found' THEN 'not_allowed'
      WHEN v_build->'blockers' ?| ARRAY['not_issued','settlement','debt_source_invalid','debt_source_mismatch'] THEN 'web_only'
      WHEN v_build->'blockers' ? 'line_locked' THEN 'adjust_meter_line_web_only'
      -- Dòng đã khớp ở bản xem trước không còn trên hoá đơn: hoá đơn vừa được điều chỉnh.
      WHEN v_build->'blockers' ? 'line_not_found' THEN 'state_changed'
      WHEN jsonb_array_length(v_build->'changed')=0 THEN 'adjust_no_change' END;
    IF v_reason IS NOT NULL THEN RETURN jsonb_build_object('kind','rejected','reason',v_reason); END IF;
    v_basis:=md5(jsonb_build_array(p_action,v_invoice,inv.adjustment_revision,COALESCE(inv.paid_amount,0),inv.updated_at,inv.status,
      v_build->'after',v_note)::text);
    IF p_phase<>'apply' THEN
      -- Lượt 1: CHẠY THỬ adjust_invoice_v2 (tổng sau do chính hàm ghi làm tròn) trong khối con rồi lùi — không để lại điều chỉnh, dòng hay khoá.
      BEGIN
        v_done:=public.adjust_invoice_v2(v_invoice,v_build#>'{after,items}',(v_build#>>'{after,discount}')::numeric,inv.discount_notes,inv.notes,
          CASE WHEN v_note_ok THEN v_note ELSE 'hermes: kiểm trước khi hỏi lý do' END,inv.adjustment_revision,COALESCE(inv.paid_amount,0),inv.updated_at,
          'hermes-dry:'||p_request_id::text);
        SELECT i.status::text,COALESCE(i.remaining_amount,COALESCE(i.total_amount,0)-COALESCE(i.paid_amount,0)) INTO v_status,v_remaining
          FROM public.invoices i WHERE i.id=v_invoice;
        v_res:=jsonb_build_object('before',v_done.before_total,'after',v_done.after_total,'delta',v_done.delta,'revision',v_done.revision);
        RAISE EXCEPTION 'hermes_invoice_dry_run' USING ERRCODE='HD001';
      EXCEPTION
        WHEN SQLSTATE 'HD001' THEN NULL;
        WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
          v_reason:=app_private.hermes_invoice_edit_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,''));
          IF SQLSTATE IN ('40001','40P01','55P03','PT409') AND v_reason<>'web_only' THEN RAISE; END IF;
          IF v_reason='adjust_below_collected' THEN
            v_total_after:=app_private.round_invoice_total_v1((v_build#>>'{after,subtotal}')::numeric-(v_build#>>'{after,discount}')::numeric
              +COALESCE(inv.previous_debt,0));
            RETURN jsonb_build_object('kind','rejected','reason',v_reason,'facts',jsonb_strip_nulls(jsonb_build_object(
              'collected',round(GREATEST(COALESCE(inv.paid_amount,0),0))::bigint::text,
              'totalAfter',CASE WHEN v_total_after>=0 THEN round(v_total_after)::bigint::text END)));
          END IF;
          RETURN jsonb_build_object('kind','rejected','reason',v_reason);
      END;
      IF NOT v_note_ok THEN RETURN jsonb_build_object('kind','rejected','reason','reason_required'); END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('text',CASE c->>'op'
          WHEN 'set' THEN format('«%s»: %s → %s',left(c->>'description',120),app_private.hermes_vnd_text_v1((c->>'before')::numeric),
            app_private.hermes_vnd_text_v1((c->>'after')::numeric))
          WHEN 'add' THEN format('Thêm «%s»: %s',left(c->>'description',120),app_private.hermes_vnd_text_v1((c->>'after')::numeric))
          ELSE format('Giảm trừ: %s → %s',app_private.hermes_vnd_text_v1((c->>'before')::numeric),app_private.hermes_vnd_text_v1((c->>'after')::numeric)) END)
        ORDER BY n),'[]'::jsonb) INTO v_items FROM jsonb_array_elements(v_build->'changed') WITH ORDINALITY x(c,n);
      IF inv.adjustment_review_status='PENDING' THEN
        v_warnings:=v_warnings||jsonb_build_array('Hoá đơn đang có một điều chỉnh chờ xác nhận kiểm tra; điều chỉnh mới thay chỗ, người kiểm sẽ xem bản mới.'); END IF;
      IF inv.status::text='PAID' AND v_status IS DISTINCT FROM 'PAID' THEN
        v_warnings:=v_warnings||jsonb_build_array(format('Hoá đơn đang ĐÃ THANH TOÁN; sau điều chỉnh khách còn nợ %s.',app_private.hermes_vnd_text_v1(v_remaining))); END IF;
      IF abs((v_res->>'delta')::numeric)>=5000000 THEN
        v_warnings:=v_warnings||jsonb_build_array('Số chênh lớn (từ 5 triệu) — đọc lại số cho người dùng.'); END IF;
      v_status_text:=CASE v_status WHEN 'PAID' THEN 'đã thanh toán đủ' WHEN 'PARTIAL_PAID' THEN 'đã thu một phần' WHEN 'OVERDUE' THEN 'quá hạn'
        WHEN 'APPROVED' THEN 'chưa thu' ELSE lower(COALESCE(v_status,'?')) END;
      RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required','warnings',v_warnings,
        'preview',jsonb_strip_nulls(jsonb_build_object(
          'summary',format('Sẽ ĐIỀU CHỈNH hoá đơn %s: tổng %s → %s (%s). Lý do: «%s». Đã thu %s; trạng thái sau: %s. Điều chỉnh sẽ chờ người có quyền xác nhận đã kiểm tra.',
            v_label,app_private.hermes_vnd_text_v1((v_res->>'before')::numeric),app_private.hermes_vnd_text_v1((v_res->>'after')::numeric),
            CASE WHEN (v_res->>'delta')::numeric>0 THEN '+'||app_private.hermes_vnd_text_v1((v_res->>'delta')::numeric)
              WHEN (v_res->>'delta')::numeric<0 THEN '−'||app_private.hermes_vnd_text_v1(-(v_res->>'delta')::numeric) ELSE 'không đổi tổng' END,
            left(v_note,300),app_private.hermes_vnd_text_v1(COALESCE(inv.paid_amount,0)),v_status_text),
          'invoiceNumber',inv.invoice_number,'month',v_month,'totalBefore',(v_res->>'before')::numeric::bigint::text,
          'totalAfter',(v_res->>'after')::numeric::bigint::text,'items',v_items)));
    END IF;
  ELSIF p_action='invoice.adjustment_check' THEN
    IF v_adj.id IS NULL OR v_adj.revision IS DISTINCT FROM inv.adjustment_revision OR v_adj.review_status IS DISTINCT FROM 'PENDING'
      OR inv.adjustment_review_status IS DISTINCT FROM 'PENDING' THEN
      RETURN jsonb_build_object('kind','rejected','reason',CASE WHEN p_phase='apply' THEN 'state_changed' ELSE 'nothing_to_check' END); END IF;
    -- HDN6: điều chỉnh do chính người hỏi làm không tự xác nhận qua bot (kiểm chéo); web không cấm nên câu chỉ đường web.
    IF v_adj.adjusted_by=v_actor THEN RETURN jsonb_build_object('kind','rejected','reason','adjustment_self_check_web_only'); END IF;
    v_basis:=md5(jsonb_build_array(p_action,v_invoice,v_adj.id,v_adj.revision,v_adj.review_status,inv.updated_at)::text);
    IF p_phase<>'apply' THEN
      BEGIN
        v_done:=public.review_invoice_adjustment_v2(v_adj.id,v_adj.revision);
        RAISE EXCEPTION 'hermes_invoice_dry_run' USING ERRCODE='HD001';
      EXCEPTION
        WHEN SQLSTATE 'HD001' THEN NULL;
        WHEN OTHERS THEN
          IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
          GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
          RETURN jsonb_build_object('kind','rejected','reason',app_private.hermes_invoice_edit_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
      END;
      -- Dòng đổi: so ảnh trước/sau theo id (đổi thành tiền/mô tả, thêm, bỏ) và giảm trừ; tối đa 8 câu.
      SELECT COALESCE(jsonb_agg(jsonb_build_object('text',t) ORDER BY o,n),'[]'::jsonb) INTO v_items FROM (
        SELECT * FROM (
          SELECT 1 AS o,a.n,format('«%s»: %s → %s',left(a.e->>'description',120),app_private.hermes_vnd_text_v1(COALESCE((b.e->>'amount')::numeric,0)),
              app_private.hermes_vnd_text_v1(COALESCE((a.e->>'amount')::numeric,0))) AS t
            FROM jsonb_array_elements(COALESCE(v_adj.after_snapshot->'items','[]'::jsonb)) WITH ORDINALITY a(e,n)
            JOIN jsonb_array_elements(COALESCE(v_adj.before_snapshot->'items','[]'::jsonb)) b(e) ON b.e->>'id'=a.e->>'id'
            WHERE COALESCE((b.e->>'amount')::numeric,0)<>COALESCE((a.e->>'amount')::numeric,0) OR b.e->>'description' IS DISTINCT FROM a.e->>'description'
          UNION ALL
          SELECT 2,a.n,format('Thêm «%s»: %s',left(a.e->>'description',120),app_private.hermes_vnd_text_v1(COALESCE((a.e->>'amount')::numeric,0)))
            FROM jsonb_array_elements(COALESCE(v_adj.after_snapshot->'items','[]'::jsonb)) WITH ORDINALITY a(e,n)
            WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(v_adj.before_snapshot->'items','[]'::jsonb)) b(e) WHERE b.e->>'id'=a.e->>'id')
          UNION ALL
          SELECT 3,b.n,format('Bỏ «%s»: %s',left(b.e->>'description',120),app_private.hermes_vnd_text_v1(COALESCE((b.e->>'amount')::numeric,0)))
            FROM jsonb_array_elements(COALESCE(v_adj.before_snapshot->'items','[]'::jsonb)) WITH ORDINALITY b(e,n)
            WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(v_adj.after_snapshot->'items','[]'::jsonb)) a(e) WHERE a.e->>'id'=b.e->>'id')
          UNION ALL
          SELECT 4,1,format('Giảm trừ: %s → %s',app_private.hermes_vnd_text_v1(COALESCE((v_adj.before_snapshot->>'discount_amount')::numeric,0)),
              app_private.hermes_vnd_text_v1(COALESCE((v_adj.after_snapshot->>'discount_amount')::numeric,0)))
            WHERE COALESCE((v_adj.before_snapshot->>'discount_amount')::numeric,0)<>COALESCE((v_adj.after_snapshot->>'discount_amount')::numeric,0)
        ) d ORDER BY o,n LIMIT 8) x;
      v_when:=to_char(v_adj.adjusted_at AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI')||' '
        ||app_private.hermes_vn_date_text_v1((v_adj.adjusted_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,v_today);
      v_who:=COALESCE(NULLIF(btrim(v_resolved->>'adjusterName'),''),'một người khác');
      RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required','warnings',v_warnings,
        'preview',jsonb_strip_nulls(jsonb_build_object(
          'summary',format('Sẽ XÁC NHẬN ĐÃ KIỂM TRA điều chỉnh lần %s của hoá đơn %s, do %s làm lúc %s: tổng %s → %s (%s); lý do «%s». Đã thu %s. Xác nhận rồi không bỏ được.',
            v_adj.revision,v_label,v_who,v_when,app_private.hermes_vnd_text_v1(v_adj.before_total),app_private.hermes_vnd_text_v1(v_adj.after_total),
            CASE WHEN v_adj.delta>0 THEN '+'||app_private.hermes_vnd_text_v1(v_adj.delta) WHEN v_adj.delta<0 THEN '−'||app_private.hermes_vnd_text_v1(-v_adj.delta)
              ELSE 'không đổi tổng' END,left(v_adj.reason,300),app_private.hermes_vnd_text_v1(COALESCE(inv.paid_amount,0))),
          'invoiceNumber',inv.invoice_number,'month',v_month,'revision',v_adj.revision,'items',v_items)));
    END IF;
  ELSIF p_action='invoice.cancel' THEN
    -- Luật hàm ghi: chỉ nháp/đã duyệt chưa thu đồng nào; quá hạn huỷ trên web (mục 1).
    v_reason:=CASE WHEN inv.status::text='CANCELLED' THEN CASE WHEN p_phase='apply' THEN 'state_changed' ELSE 'invoice_already_cancelled' END
      WHEN inv.status::text='OVERDUE' THEN 'cancel_overdue_web_only'
      WHEN COALESCE(inv.paid_amount,0)<>0 OR inv.status::text IN ('PAID','PARTIAL_PAID') THEN 'cancel_has_payment'
      WHEN inv.status::text NOT IN ('DRAFT','APPROVED') THEN 'web_only' END;
    IF v_reason IS NOT NULL THEN RETURN jsonb_build_object('kind','rejected','reason',v_reason); END IF;
    SELECT COALESCE(sum(a.amount),0) INTO v_credit FROM public.customer_credit_applications a WHERE a.invoice_id=v_invoice AND a.reversed_at IS NULL;
    v_basis:=md5(jsonb_build_array(p_action,v_invoice,inv.status,COALESCE(inv.paid_amount,0),inv.updated_at,v_credit,v_note)::text);
    IF p_phase<>'apply' THEN
      BEGIN
        v_run:=public.cancel_invoice_with_credit_v1(v_invoice,'hermes-dry:'||p_request_id::text);
        v_noop:=COALESCE((v_run->>'noop')::boolean,false);
        RAISE EXCEPTION 'hermes_invoice_dry_run' USING ERRCODE='HD001';
      EXCEPTION
        WHEN SQLSTATE 'HD001' THEN NULL;
        WHEN OTHERS THEN
          IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
          GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
          RETURN jsonb_build_object('kind','rejected','reason',app_private.hermes_invoice_edit_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
      END;
      IF v_noop THEN RETURN jsonb_build_object('kind','rejected','reason','invoice_already_cancelled'); END IF;
      IF NOT v_note_ok THEN RETURN jsonb_build_object('kind','rejected','reason','reason_required'); END IF;
      -- Nợ cũ hoá đơn này đang gánh (#267, previous_debt_sources): huỷ thì khoản đó tính lại ở hoá đơn nguồn.
      FOR v_c IN SELECT jsonb_build_object('amount',(s->>'amount')::numeric,'month',to_char(to_date(src.billing_month,'YYYY-MM'),'MM/YYYY'),
          'number',src.invoice_number) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(inv.previous_debt_sources)='array' THEN inv.previous_debt_sources
            ELSE '[]'::jsonb END) WITH ORDINALITY x(s,n)
          JOIN public.invoices src ON src.id::text=s->>'id' AND src.organization_id=v_org
          WHERE s->>'type'='invoice' AND jsonb_typeof(s->'amount')='number' AND (s->>'amount')::numeric>0 ORDER BY n LIMIT 5 LOOP
        v_warnings:=v_warnings||jsonb_build_array(format('Hoá đơn này đang gánh nợ cũ %s của kỳ %s (%s): huỷ thì khoản nợ đó tính lại ở hoá đơn kỳ %s.',
          app_private.hermes_vnd_text_v1((v_c->>'amount')::numeric),v_c->>'month',COALESCE(v_c->>'number','?'),v_c->>'month'));
      END LOOP;
      RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required','warnings',v_warnings,
        'preview',jsonb_strip_nulls(jsonb_build_object(
          'summary',format('Sẽ HUỶ hoá đơn %s, tổng %s, chưa thu đồng nào. Lý do: «%s».%s',v_label,app_private.hermes_vnd_text_v1(COALESCE(inv.total_amount,0)),
            left(v_note,300),CASE WHEN v_credit>0 THEN format(' Tiền dư %s của khách đã cấn vào hoá đơn sẽ hoàn lại cho khách (dùng cho kỳ sau).',
              app_private.hermes_vnd_text_v1(v_credit)) ELSE '' END),
          'invoiceNumber',inv.invoice_number,'month',v_month,'total',COALESCE(inv.total_amount,0)::bigint::text,
          'creditReturned',NULLIF(v_credit,0)::bigint::text)));
    END IF;
  ELSE
    -- invoice.restore. Kỳ này đã có hoá đơn tháng khác đang hiệu lực (cùng HĐ) ⇒ chỉ mục duy nhất idx_invoices_unique_contract_billing chặn.
    IF inv.status::text<>'CANCELLED' THEN
      RETURN jsonb_build_object('kind','rejected','reason',CASE WHEN p_phase='apply' THEN 'state_changed' ELSE 'invoice_not_cancelled' END); END IF;
    IF inv.contract_id IS NOT NULL AND COALESCE(inv.kind,'MONTHLY')='MONTHLY' AND EXISTS(SELECT 1 FROM public.invoices o WHERE o.contract_id=inv.contract_id
        AND o.billing_month=inv.billing_month AND o.id<>inv.id AND o.deleted_at IS NULL AND o.status::text<>'CANCELLED' AND COALESCE(o.kind,'MONTHLY')='MONTHLY') THEN
      RETURN jsonb_build_object('kind','rejected','reason','restore_conflict'); END IF;
    SELECT COALESCE(sum(a.amount),0) INTO v_credit FROM public.customer_credit_applications a
      WHERE a.invoice_id=v_invoice AND a.reversed_at IS NOT NULL AND a.restored_at IS NULL;
    v_basis:=md5(jsonb_build_array(p_action,v_invoice,inv.status,inv.updated_at,v_credit,v_note)::text);
    IF p_phase<>'apply' THEN
      BEGIN
        v_run:=public.restore_invoice_with_credit_v1(v_invoice,'hermes-dry:'||p_request_id::text);
        v_noop:=COALESCE((v_run->>'noop')::boolean,false);
        RAISE EXCEPTION 'hermes_invoice_dry_run' USING ERRCODE='HD001';
      EXCEPTION
        WHEN SQLSTATE 'HD001' THEN NULL;
        WHEN OTHERS THEN
          IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
          GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
          RETURN jsonb_build_object('kind','rejected','reason',app_private.hermes_invoice_edit_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
      END;
      IF v_noop THEN RETURN jsonb_build_object('kind','rejected','reason','invoice_not_cancelled'); END IF;
      IF NOT v_note_ok THEN RETURN jsonb_build_object('kind','rejected','reason','reason_required'); END IF;
      IF inv.due_date<v_today THEN
        v_warnings:=v_warnings||jsonb_build_array(format('Hạn thanh toán %s đã qua: khôi phục xong hoá đơn sẽ hiện quá hạn.',to_char(inv.due_date,'DD/MM/YYYY'))); END IF;
      RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required','warnings',v_warnings,
        'preview',jsonb_strip_nulls(jsonb_build_object(
          'summary',format('Sẽ KHÔI PHỤC hoá đơn %s (đang huỷ), tổng %s; hoá đơn trở lại chờ thu. Lý do: «%s».%s',v_label,
            app_private.hermes_vnd_text_v1(COALESCE(inv.total_amount,0)),left(v_note,300),
            CASE WHEN v_credit>0 THEN format(' Tiền dư %s của khách sẽ cấn lại vào hoá đơn.',app_private.hermes_vnd_text_v1(v_credit)) ELSE '' END),
          'invoiceNumber',inv.invoice_number,'month',v_month,'total',COALESCE(inv.total_amount,0)::bigint::text,
          'creditReapplied',NULLIF(v_credit,0)::bigint::text)));
    END IF;
  END IF;

  -- Lượt 2: biên nhận + hàm ghi web trong cùng khối con; lệch bản đã xem hay hậu điều kiện sai ⇒ lùi cả hai, xem trước lại.
  BEGIN
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
    IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
    IF v_basis IS DISTINCT FROM p_expected_basis THEN RAISE EXCEPTION 'hermes_invoice_state_changed' USING ERRCODE='HS001'; END IF;
    IF p_action='invoice.adjust' THEN
      v_done:=public.adjust_invoice_v2(v_invoice,v_build#>'{after,items}',(v_build#>>'{after,discount}')::numeric,inv.discount_notes,inv.notes,
        v_note,inv.adjustment_revision,COALESCE(inv.paid_amount,0),inv.updated_at,'hermes-adj:'||p_request_id::text);
      IF v_done.invoice_id IS DISTINCT FROM v_invoice OR v_done.revision IS DISTINCT FROM inv.adjustment_revision+1
        OR v_done.idempotency_key IS DISTINCT FROM 'hermes-adj:'||p_request_id::text THEN
        RAISE EXCEPTION 'hermes_invoice_postcondition' USING ERRCODE='HS001'; END IF;
      v_outcome:=jsonb_build_object('kind','applied','result',jsonb_strip_nulls(jsonb_build_object('invoiceNumber',inv.invoice_number,
          'building',v_resolved->>'buildingName','room',v_resolved->>'roomName','month',v_month,'revision',v_done.revision,'reviewStatus',v_done.review_status,
          'totalBefore',v_done.before_total::bigint::text,'totalAfter',v_done.after_total::bigint::text,'delta',v_done.delta::bigint::text,
          'text',format('Đã điều chỉnh hoá đơn %s: tổng %s → %s. Điều chỉnh lần %s chờ người có quyền xác nhận đã kiểm tra.',v_label,
            app_private.hermes_vnd_text_v1(v_done.before_total),app_private.hermes_vnd_text_v1(v_done.after_total),v_done.revision))),
        'link','/invoices/'||v_invoice::text);
    ELSIF p_action='invoice.adjustment_check' THEN
      v_done:=public.review_invoice_adjustment_v2(v_adj.id,v_adj.revision);
      IF v_done.id IS DISTINCT FROM v_adj.id OR v_done.review_status IS DISTINCT FROM 'CHECKED' OR v_done.checked_by IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'hermes_invoice_postcondition' USING ERRCODE='HS001'; END IF;
      v_outcome:=jsonb_build_object('kind','applied','result',jsonb_strip_nulls(jsonb_build_object('invoiceNumber',inv.invoice_number,
          'building',v_resolved->>'buildingName','room',v_resolved->>'roomName','month',v_month,'revision',v_done.revision,'reviewStatus',v_done.review_status,
          'text',format('Đã xác nhận ĐÃ KIỂM TRA điều chỉnh lần %s của hoá đơn %s.',v_done.revision,v_label))),
        'link','/invoices/'||v_invoice::text);
    ELSIF p_action='invoice.cancel' THEN
      v_run:=public.cancel_invoice_with_credit_v1(v_invoice,'hermes-cancel:'||p_request_id::text);
      IF COALESCE((v_run->>'noop')::boolean,true) OR v_run->'invoice'->>'status' IS DISTINCT FROM 'CANCELLED' THEN
        RAISE EXCEPTION 'hermes_invoice_postcondition' USING ERRCODE='HS001'; END IF;
      v_outcome:=jsonb_build_object('kind','applied','result',jsonb_strip_nulls(jsonb_build_object('invoiceNumber',inv.invoice_number,
          'building',v_resolved->>'buildingName','room',v_resolved->>'roomName','month',v_month,'status','CANCELLED',
          'creditReturned',NULLIF(COALESCE((v_run->'credit'->>'reversed_amount')::numeric,0),0)::bigint::text,
          'text',format('Đã huỷ hoá đơn %s (tổng %s).%s',v_label,app_private.hermes_vnd_text_v1(COALESCE(inv.total_amount,0)),
            CASE WHEN COALESCE((v_run->'credit'->>'reversed_amount')::numeric,0)>0 THEN format(' Tiền dư %s đã hoàn lại cho khách.',
              app_private.hermes_vnd_text_v1((v_run->'credit'->>'reversed_amount')::numeric)) ELSE '' END))),
        'link','/invoices/'||v_invoice::text);
    ELSE
      v_run:=public.restore_invoice_with_credit_v1(v_invoice,'hermes-restore:'||p_request_id::text);
      IF COALESCE((v_run->>'noop')::boolean,true) OR COALESCE(v_run->'invoice'->>'status','CANCELLED')='CANCELLED' THEN
        RAISE EXCEPTION 'hermes_invoice_postcondition' USING ERRCODE='HS001'; END IF;
      v_outcome:=jsonb_build_object('kind','applied','result',jsonb_strip_nulls(jsonb_build_object('invoiceNumber',inv.invoice_number,
          'building',v_resolved->>'buildingName','room',v_resolved->>'roomName','month',v_month,'status',v_run->'invoice'->>'status',
          'creditReapplied',NULLIF(COALESCE((v_run->'credit'->>'applied_amount')::numeric,0),0)::bigint::text,
          'text',format('Đã khôi phục hoá đơn %s (tổng %s); hoá đơn trở lại chờ thu.',v_label,app_private.hermes_vnd_text_v1(COALESCE(inv.total_amount,0))))),
        'link','/invoices/'||v_invoice::text);
    END IF;
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
  EXCEPTION
    WHEN SQLSTATE 'HS001' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed');
    WHEN OTHERS THEN
      IF SQLSTATE IN ('40001','40P01','55P03','PT409') AND SQLERRM !~ '(REVENUE_CAP_REVIEW|Support discount changes require reconciliation)' THEN RAISE; END IF;
      -- Lượt 1 đã chạy thử cùng hàm ghi mà qua: lỗi ở đây nghĩa là dữ liệu đã đổi sau bản xem trước ⇒ không ghi gì, xem trước lại.
      RETURN jsonb_build_object('kind','rejected','reason','state_changed');
  END;
END $fn$;

-- 3. Vỏ public: chuyển theo thao tác (khuôn 20261024041712), thu tiền sang bước v3, sửa/huỷ/khôi phục sang bước v2.
CREATE OR REPLACE FUNCTION public.hermes_invoice_action_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb DEFAULT NULL,p_expected_basis text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
  WITH g AS MATERIALIZED (SELECT app_private.hermes_action_guard_v1(p_binding,p_action) AS ctx),
  r AS MATERIALIZED (SELECT CASE WHEN p_phase IN ('preview','auto') AND jsonb_typeof(p_params)='object' THEN
      CASE WHEN p_action='invoice.meter_record' THEN
        app_private.hermes_invoice_meter_lookup_v1((g.ctx->>'organizationId')::uuid,ARRAY(SELECT jsonb_array_elements_text(g.ctx->'buildingIds')::uuid),
          p_action,p_params)
      WHEN p_action IN ('invoice.adjust','invoice.adjustment_check','invoice.cancel','invoice.restore') THEN
        app_private.hermes_invoice_edit_lookup_v1((g.ctx->>'organizationId')::uuid,ARRAY(SELECT jsonb_array_elements_text(g.ctx->'buildingIds')::uuid),
          p_action,p_params)
      ELSE app_private.hermes_invoice_lookup_core_v3((g.ctx->>'organizationId')::uuid,ARRAY(SELECT jsonb_array_elements_text(g.ctx->'buildingIds')::uuid),
          p_action,p_params) END END AS resolution FROM g)
  SELECT CASE WHEN p_action='invoice.meter_record'
    THEN app_private.hermes_invoice_meter_step_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,r.resolution)
    WHEN p_action IN ('invoice.adjust','invoice.adjustment_check','invoice.cancel','invoice.restore')
    THEN app_private.hermes_invoice_edit_step_v2(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,r.resolution)
    ELSE app_private.hermes_invoice_action_step_v3(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,r.resolution) END FROM r;
END;

ALTER FUNCTION app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_invoice_edit_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_edit_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ INVOKER chạy dưới authenticated nên cần EXECUTE trên đúng các hàm app_private nó gắn OID; không có USAGE app_private nên client không
-- gọi theo tên được. Tra cứu / chỉ số và guard đã cấp ở migration của chúng; hàm đọc dùng chung giữ nguyên quyền (CREATE OR REPLACE).
GRANT EXECUTE ON FUNCTION app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_invoice_edit_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;

DO $check$
DECLARE v_step text; v_edit text;
BEGIN
  SELECT prosrc INTO v_step FROM pg_proc WHERE oid='app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure;
  SELECT prosrc INTO v_edit FROM pg_proc WHERE oid='app_private.hermes_invoice_edit_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure AND NOT prosecdef AND prosqlbody IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb)'::regprocedure AND NOT prosecdef AND provolatile='s'
      AND replace(COALESCE(array_to_string(proconfig,','),''),'"','')='search_path=' AND position('methodFromBook' IN prosrc)>0)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure AND prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_invoice_edit_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure AND prosecdef)
    -- Vỏ gắn đủ bảy tầng: guard, tra cứu thu tiền v3 + bước ghi v3, hai tầng chỉ số, tra cứu sửa/huỷ/khôi phục v1 + bước ghi v2 — và KHÔNG
    -- còn tra cứu / bước ghi thu tiền v2, bước ghi sửa-huỷ-khôi phục v1.
    OR (SELECT count(DISTINCT refobjid) FROM pg_depend WHERE classid='pg_proc'::regclass AND objid='public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND refobjid IN ('app_private.hermes_action_guard_v1(jsonb,text)'::regprocedure,'app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_meter_lookup_v1(uuid,uuid[],text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_edit_lookup_v1(uuid,uuid[],text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_edit_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure))<>7
    OR EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_proc'::regclass AND objid='public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND refobjid IN ('app_private.hermes_invoice_action_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_lookup_core_v2(uuid,uuid[],text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_edit_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure))
    -- Hermes đã giữ dòng công ty từ guard ⇒ dòng hoá đơn / hợp đồng khoá KHÔNG CHỜ (chờ = vòng 40P01 với hàm ghi web).
    OR position('ORDER BY i.id FOR UPDATE NOWAIT' IN v_step)=0 OR position('app_private.profit_month_locked_v1(v_building,v_date)' IN v_step)=0
    OR position('period_closed' IN v_step)=0 OR position('FOR UPDATE NOWAIT' IN v_edit)=0 OR position('v_note_ok' IN v_edit)=0
    OR has_function_privilege('anon','public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_invoice_edit_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.profit_month_locked_v1(uuid,date)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_invoice_reason_v1(text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_invoice_l14_catalog_invalid'; END IF;
END $check$;
COMMIT;
