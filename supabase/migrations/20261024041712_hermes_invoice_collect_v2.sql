-- Đợt 3 trang HOÁ ĐƠN — lượt 8 (24/10/2026, sửa theo nghiệm thu bot trên TEST; docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục 4.1, 5):
-- thu tiền invoice.collect nói ĐÚNG lý do và ĐÚNG trạng thái. Áp SAU 20261023042723_hermes_invoice_edit_v1 (vỏ chuyển theo thao tác).
--  (1) app_private.hermes_invoice_lookup_core_v2 = bản chép NGUYÊN tra cứu v1 (20261022075230, md5 ghim ở $requires$), chỉ đổi nhãn ứng
--      viên: hoá đơn kind SETTLEMENT ghi "hoá đơn thanh lý" (như web gọi) thay chữ "settlement". Thu tiền hoá đơn thanh lý của hợp đồng đã
--      kết thúc KHÔNG bị loại theo thiết kế: tầng 2 trên TEST (24/10) xem trước được với người giữ sổ nhận chuyển khoản của toà.
--  (2) app_private.hermes_invoice_action_step_v2 = bản chép NGUYÊN bước ghi v1 (md5 ghim), khoá NOWAIT giữ nguyên, đổi:
--      * kế hoạch chặn receiving_book_missing mà toà ĐÃ cài sổ nhận cho hình thức đó (app_private.receiving_cashbook_ids_v1, mọi sổ, không
--        lọc người giữ) ⇒ mã MỚI receiving_book_not_held (người hỏi không giữ/biết sổ nào — luật giữ sổ của record_invoice_collection_v5,
--        như web); toà chưa cài ⇒ receiving_book_missing như cũ. Trước đây cả hai thành một câu "cài ở Sổ nhận tiền trên web" — sai cho
--        người không giữ sổ (nghiệm thu: bot chỉ sang web). Sổ người dùng nêu không còn trong danh sách ở lượt 2 ⇒ state_changed.
--      * làm tròn (thiếu < 10.000đ, kế hoạch dùng chung như web): hoá đơn chuyển ĐÃ THANH TOÁN nhưng remaining_amount (cột GENERATED
--        tổng − đã thu) vẫn là số lẻ. "ĐÃ THANH TOÁN ĐỦ" chỉ khi hết nợ thật; làm tròn ⇒ câu nói rõ số lẻ không thu, ghi sổ «Làm tròn tiền
--        thiếu», cột còn nợ vẫn hiện số đó; bản xem trước thêm trường rounding. Câu đã ghi cùng luật, kèm tiền dư giữ lại / phần dư tự trả.
--      * dòng hoá đơn thanh lý nói rõ ("— hoá đơn thanh lý").
--  (3) public.hermes_invoice_action_v1: THAY vỏ SQL-standard của 20261023042723 — chỉ đổi hai tầng thu tiền sang v2 (chỉ số, sửa/huỷ/khôi
--      phục giữ nguyên). Ghim băm vỏ mới ở scripts/hermes-task-function-contract.mjs; bản cũ vào FORWARD_SUPERSEDED. Tầng v1 để nguyên (không
--      đổi thân hàm đã ghim chéo ở 20261022183445 / 20261023042723).
-- Mã mới receiving_book_not_held: connector phải biết mã TRƯỚC khi áp (mã lạ ⇒ crm_refused). Không ghi dữ liệu nghiệp vụ. Idempotent
-- (CREATE OR REPLACE); khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('app_private.hermes_action_policies') IS NULL OR to_regclass('app_private.hermes_action_receipts') IS NULL
    OR to_regprocedure('app_private.hermes_action_guard_v1(jsonb,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_vnd_text_v1(numeric)') IS NULL
    OR to_regprocedure('app_private.hermes_vn_date_text_v1(date,date)') IS NULL
    OR to_regprocedure('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.lock_org_for_decision_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.current_uid_v1()') IS NULL
    OR to_regprocedure('app_private.receiving_cashbook_ids_v1(uuid,uuid,text,uuid)') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)') IS NULL
    OR to_regprocedure('public.hermes_name_fold_v1(text)') IS NULL
    OR to_regprocedure('public.invoice_room_invoices_v1(uuid,uuid,text,uuid[],date)') IS NULL
    OR to_regprocedure('public.invoice_collection_plan_v1(uuid,jsonb,jsonb)') IS NULL
    OR to_regprocedure('public.get_receiving_cashbooks_v1(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('public.org_today_v1(uuid)') IS NULL
    OR to_regprocedure('public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)') IS NULL
    OR to_regprocedure('app_private.hermes_invoice_reason_v1(text,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_invoice_meter_lookup_v1(uuid,uuid[],text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_invoice_edit_lookup_v1(uuid,uuid[],text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_invoice_edit_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)') IS NULL
    OR to_regprocedure('public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)') IS NULL
    -- Hai tầng thu tiền v1 đang chạy (20261022075230): bản v2 chép đúng thân này (md5 bỏ CR).
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_lookup_core_v1(uuid,uuid[],text,jsonb)'::regprocedure)
      IS DISTINCT FROM '6e43435615b525c4ea5b32e9c3588bbc'
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure)
      IS DISTINCT FROM '7c2cdc78435ba4559da0de45828a61ed' THEN
    RAISE EXCEPTION 'hermes_invoice_collect_v2_dependency_invalid'; END IF;
END $requires$;

-- 1. Tra cứu (INVOKER, RLS người hỏi) — bản chép v1, nhãn hoá đơn thanh lý.
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_lookup_core_v2(p_organization_id uuid,p_building_ids uuid[],p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_method text; v_entries jsonb; v_e jsonb; v_name jsonb; v_building uuid; v_building_name text; v_room uuid; v_room_name text; v_rows jsonb;
  v_pick jsonb; v_open jsonb; v_out jsonb:='[]'::jsonb; v_receiving jsonb; v_list jsonb; v_hits jsonb; v_account uuid; v_wanted text;
  v_number text; v_label text;
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
  FOR v_e IN SELECT value FROM jsonb_array_elements(v_entries) LOOP
    v_name:=public.hermes_write_name_resolve_v1(p_organization_id,p_building_ids,
      jsonb_strip_nulls(jsonb_build_object('building',p_params->>'buildingName','room',v_e->>'roomName')));
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
  -- Sổ nhận người dùng nêu: chỉ trong danh sách sổ nhận của toà theo hình thức (như ô sổ của form web).
  IF NULLIF(btrim(p_params->>'cashbookName'),'') IS NOT NULL THEN
    v_receiving:=public.get_receiving_cashbooks_v1(p_organization_id,v_building,NULL);
    v_list:=COALESCE(v_receiving->v_method,'[]'::jsonb);
    v_wanted:=public.hermes_name_fold_v1(p_params->>'cashbookName');
    SELECT jsonb_agg(b) INTO v_hits FROM jsonb_array_elements(v_list) b WHERE public.hermes_name_fold_v1(b->>'name')=v_wanted;
    IF v_hits IS NULL THEN
      SELECT jsonb_agg(b) INTO v_hits FROM jsonb_array_elements(v_list) b
        WHERE char_length(v_wanted)>=2 AND strpos(public.hermes_name_fold_v1(b->>'name'),v_wanted)>0;
    END IF;
    IF jsonb_array_length(COALESCE(v_hits,'[]'::jsonb))<>1 THEN
      RETURN jsonb_build_object('status','unresolved','field','cashbook','wanted',left(btrim(p_params->>'cashbookName'),200),
        'why',CASE WHEN jsonb_array_length(COALESCE(v_hits,'[]'::jsonb))>=2 THEN 'ambiguous' ELSE 'not_visible' END,'more',false,
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',regexp_replace(b->>'name','[0-9]{5,}','***','g'))),'[]'::jsonb)
          FROM (SELECT b FROM jsonb_array_elements(CASE WHEN v_hits IS NULL THEN v_list ELSE v_hits END) b LIMIT 8) x));
    END IF;
    v_account:=(v_hits#>>'{0,id}')::uuid;
  END IF;
  RETURN jsonb_build_object('status','resolved','resolved',jsonb_strip_nulls(jsonb_build_object('buildingId',v_building,'buildingName',v_building_name,
    'method',v_method,'accountId',v_account,'items',v_out)));
END $fn$;

-- 2. Bước ghi (DEFINER) — bản chép v1: lý do sổ nhận tách hai mã, câu làm tròn / thanh lý nói đúng trạng thái.
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_action_step_v2(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  ctx jsonb; v_org uuid; v_resolved jsonb; v_begin jsonb; v_outcome jsonb; v_constraint text; v_method text; v_method_text text; v_today date; v_date date;
  v_building uuid; v_batch boolean; v_n int; v_res jsonb; v_amount jsonb; v_plan jsonb; v_plans jsonb; v_excluded jsonb; v_ex text;
  v_receiving jsonb; v_no_round boolean; v_try int; v_runs jsonb; v_run jsonb; v_items jsonb; v_warnings jsonb; v_choice jsonb; v_basis text;
  v_total numeric; v_first_reason text; v_label text; v_line text; v_left numeric; v_mode text; v_book text; v_key text; v_retry boolean;
  v_w jsonb; v_text text; v_reason text; v_sum_applied numeric; v_rounding_missing boolean; v_actor uuid; v_round numeric; v_st text; v_settle boolean;
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
  v_today:=public.org_today_v1(v_org);
  v_date:=COALESCE(NULLIF(p_params->>'date','')::date,v_today);
  IF v_date>v_today THEN RETURN jsonb_build_object('kind','rejected','reason','date_out_of_range'); END IF;
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
    SELECT COALESCE(jsonb_agg(w),'[]'::jsonb) INTO v_warnings FROM (SELECT w FROM jsonb_array_elements(v_warnings) w WHERE jsonb_typeof(w)='string' LIMIT 10) x;
    RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved||jsonb_build_object('noRounding',v_no_round),'confirm','required',
      'warnings',v_warnings,'preview',jsonb_strip_nulls(jsonb_build_object(
        'summary',CASE WHEN v_choice IS NOT NULL THEN
            format('Khách trả %s, còn nợ %s, dư %s. CHƯA chọn: %s',app_private.hermes_vnd_text_v1((v_choice->>'gross')::numeric),
              app_private.hermes_vnd_text_v1((v_choice->>'remaining')::numeric),app_private.hermes_vnd_text_v1((v_choice->>'overpay')::numeric),
              CASE WHEN (v_choice->>'canKeep')::boolean THEN 'giữ lại cho kỳ sau (overpay=keep) hay trả lại khách (overpay=return)? Hỏi người dùng rồi gọi lại kèm overpay, KHÔNG xác nhận bản này.'
                ELSE 'hoá đơn không gắn hợp đồng nên chỉ trả lại khách được (overpay=return). Hỏi người dùng rồi gọi lại kèm overpay, KHÔNG xác nhận bản này.' END)
          ELSE format('Sẽ ghi THU %s bằng %s ngày %s vào sổ «%s» cho %s.',app_private.hermes_vnd_text_v1(v_total),v_method_text,
              app_private.hermes_vn_date_text_v1(v_date,v_today),v_book,
              CASE WHEN jsonb_array_length(v_plans)=1 THEN 'hoá đơn '||COALESCE(v_plans->0->>'invoiceNumber','') ELSE jsonb_array_length(v_plans)||' hoá đơn' END) END,
        'choiceRequired',CASE WHEN v_choice IS NOT NULL THEN 'overpay' END,
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

-- 3. Vỏ public: chuyển theo thao tác (khuôn 20261023042723), thu tiền sang v2.
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
      ELSE app_private.hermes_invoice_lookup_core_v2((g.ctx->>'organizationId')::uuid,ARRAY(SELECT jsonb_array_elements_text(g.ctx->'buildingIds')::uuid),
          p_action,p_params) END END AS resolution FROM g)
  SELECT CASE WHEN p_action='invoice.meter_record'
    THEN app_private.hermes_invoice_meter_step_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,r.resolution)
    WHEN p_action IN ('invoice.adjust','invoice.adjustment_check','invoice.cancel','invoice.restore')
    THEN app_private.hermes_invoice_edit_step_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,r.resolution)
    ELSE app_private.hermes_invoice_action_step_v2(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,r.resolution) END FROM r;
END;

ALTER FUNCTION app_private.hermes_invoice_lookup_core_v2(uuid,uuid[],text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_invoice_action_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_lookup_core_v2(uuid,uuid[],text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_action_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ INVOKER chạy dưới authenticated nên cần EXECUTE trên đúng các hàm app_private nó gắn OID; không có USAGE app_private nên client không
-- gọi theo tên được. Tầng chỉ số / sửa-huỷ-khôi phục và guard đã cấp ở migration của chúng.
GRANT EXECUTE ON FUNCTION app_private.hermes_invoice_lookup_core_v2(uuid,uuid[],text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_invoice_action_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;

DO $check$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid='app_private.hermes_invoice_action_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure AND NOT prosecdef AND prosqlbody IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_invoice_lookup_core_v2(uuid,uuid[],text,jsonb)'::regprocedure AND NOT prosecdef AND provolatile='s'
      AND replace(COALESCE(array_to_string(proconfig,','),''),'"','')='search_path=' AND position('hoá đơn thanh lý' IN prosrc)>0)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_invoice_action_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure AND prosecdef)
    -- Vỏ gắn đủ bảy tầng: guard, hai tầng thu tiền v2, hai tầng chỉ số, hai tầng sửa/huỷ/khôi phục — và KHÔNG còn tầng thu tiền v1.
    OR (SELECT count(DISTINCT refobjid) FROM pg_depend WHERE classid='pg_proc'::regclass AND objid='public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND refobjid IN ('app_private.hermes_action_guard_v1(jsonb,text)'::regprocedure,'app_private.hermes_invoice_lookup_core_v2(uuid,uuid[],text,jsonb)'::regprocedure,'app_private.hermes_invoice_action_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_meter_lookup_v1(uuid,uuid[],text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_edit_lookup_v1(uuid,uuid[],text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_edit_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure))<>7
    OR EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_proc'::regclass AND objid='public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND refobjid IN ('app_private.hermes_invoice_lookup_core_v1(uuid,uuid[],text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure))
    -- Hermes đã giữ dòng công ty từ guard ⇒ dòng hoá đơn khoá KHÔNG CHỜ (chờ = vòng 40P01 với v5 của web).
    OR position('ORDER BY i.id FOR UPDATE NOWAIT' IN v_src)=0 OR position('receiving_book_not_held' IN v_src)=0
    OR has_function_privilege('anon','public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_invoice_action_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_invoice_reason_v1(text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_invoice_collect_v2_catalog_invalid'; END IF;
END $check$;
COMMIT;
