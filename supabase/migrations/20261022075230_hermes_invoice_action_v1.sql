-- Đợt 3 trang HOÁ ĐƠN — Mốc 3 (22/10/2026; docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục 2–5, 4.1): thao tác invoice.collect (ghi nhận
-- khách đã trả bằng CHUYỂN KHOẢN TK / THANH TOÁN TT (POS), một phòng hoặc lô ≤ 10 phòng cùng toà) trên khung chung crm_action_* (20261021133823).
-- Áp SAU 20261022075219_invoice_collection_plan_v1 (hàm kế hoạch dùng chung) và #267 (20261021183549). Khuôn ba tầng như Thu chi:
--  (1) app_private.hermes_invoice_reason_v1(sqlstate, message, constraint) IMMUTABLE: câu lỗi thật của record_invoice_collection_v5 ⇒ mã
--      của trang, rồi danh sách chung app_private.hermes_action_reason_v1.
--  (2) app_private.hermes_invoice_lookup_core_v1(org, toà[], action, params) plpgsql STABLE INVOKER search_path='': tiền mặt ⇒ từ chối
--      trước mọi tra cứu (Q13 = c); toà/phòng bằng public.hermes_write_name_resolve_v1 (D7, từng phòng của lô); hoá đơn bằng
--      public.invoice_room_invoices_v1 (Mốc 2: RLS + khoá invoices.view, nợ thực #267) — kỳ trống ⇒ hoá đơn còn nợ thực DUY NHẤT, ≥ 2 ⇒
--      hỏi lại với ứng viên có SỐ HOÁ ĐƠN, người dùng chọn lại bằng invoiceNumber; sổ (cashbookName) trong danh sách sổ nhận của toà
--      (get_receiving_cashbooks_v1). Chỉ tham chiếu public.*. Không khoá dòng nào.
--  (3) app_private.hermes_invoice_action_step_v1(...) DEFINER: phát lại trước; kiểm bản đã giải còn trong phạm vi guard (hoá đơn thuộc đúng
--      công ty/toà/phòng, sổ trong danh sách sổ nhận); khoá các dòng hoá đơn FOR UPDATE NOWAIT theo id tăng; rồi gọi ĐÚNG lời kiểm quyền
--      của v5 authorize_tenant_action_v3(current_uid, org, 'thu_tien.collect', toà) (luật 17/10: không bao giờ xem trước "được" rồi ghi
--      "không được"). THỨ TỰ KHOÁ: guard dùng chung đã khoá dòng công ty ngay đầu giao dịch (hermes_private_command_connection_v1 →
--      lock_org_for_decision_v1, mọi thao tác Hermes), còn record_invoice_collection_v5 khoá hoá đơn → toà/công ty FOR SHARE → công ty
--      NO KEY UPDATE: hai thứ tự ngược nhau. Hermes chờ dòng hoá đơn web đang giữ ⇒ vòng 40P01, và web nhận lỗi ngẫu nhiên. Vì vậy Hermes
--      không chờ (NOWAIT): bận ⇒ 55P03 ⇒ lùi cả giao dịch ⇒ connector trả state_changed; web chỉ chờ Hermes lùi. Người không qua guard không
--      giữ dòng hoá đơn nào (đo PG17 hai kết nối: invoice-write-race-sql.test.mjs). Kế hoạch = public.invoice_collection_plan_v1 cho từng
--      hoá đơn (một nguồn luật với web), đọc SAU khi giữ khoá; mục không thu được của LÔ (đã thu đủ, nháp/huỷ, nợ đã kéo sang kỳ sau) bị
--      loại và nêu ở bản xem trước (HDN2); khách trả dư chưa chọn ⇒ bản xem trước hỏi (choiceRequired, HDN4); lượt 1 CHẠY THỬ v5 trong
--      khối con rồi lùi (HD001); lượt 2 ghi cả tập hoặc không gì (biên nhận trong cùng khối con), so basis, hậu điều kiện.
--  (4) public.hermes_invoice_action_v1: vỏ INVOKER SQL-standard gắn OID guard + (2) + (3) (ghim băm ở scripts/hermes-task-function-contract.mjs).
--  (5) Khoá riêng Hermes thu_tien.collect_transfer seed TẮT (HDN1; quyền CRM giao vào = thu_tien.collect, đúng quyền v5 kiểm). KHÔNG seed
--      thu_tien.collect: khối kiểm của 20261021134531 đòi khoá đó vắng. Chính sách invoice.collect: money, always, chỉ chat riêng.
-- Không ghi dữ liệu nghiệp vụ, không đổi hàm cũ nào. Idempotent (CREATE OR REPLACE, ON CONFLICT DO NOTHING); khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('app_private.hermes_action_policies') IS NULL OR to_regclass('app_private.hermes_action_receipts') IS NULL
    OR to_regprocedure('app_private.hermes_action_guard_v1(jsonb,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_reason_v1(text,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_vnd_text_v1(numeric)') IS NULL
    OR to_regprocedure('app_private.hermes_vn_date_text_v1(date,date)') IS NULL
    OR to_regprocedure('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.lock_org_for_decision_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.current_uid_v1()') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)') IS NULL
    OR to_regprocedure('public.hermes_name_fold_v1(text)') IS NULL
    OR to_regprocedure('public.invoice_room_invoices_v1(uuid,uuid,text,uuid[],date)') IS NULL
    OR to_regprocedure('public.invoice_collection_plan_v1(uuid,jsonb,jsonb)') IS NULL
    OR to_regprocedure('public.get_receiving_cashbooks_v1(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('public.org_today_v1(uuid)') IS NULL
    OR to_regprocedure('public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)') IS NULL
    OR EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='thu_tien.collect')
    OR EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='thu_tien.collect_transfer' AND mode<>'action') THEN
    RAISE EXCEPTION 'hermes_invoice_action_dependency_invalid'; END IF;
END $requires$;

INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES('thu_tien.collect_transfer','action',false) ON CONFLICT(capability) DO NOTHING;
INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES
  ('invoice.collect','thu_tien.collect_transfer','thu_tien.collect','money','always',true)
  ON CONFLICT(action) DO NOTHING;

-- 1. Mã lý do của trang (câu lỗi thật của record_invoice_collection_v5, HOA-DON-THAO-TAC-GHI.md mục 5), rồi danh sách chung.
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_reason_v1(p_sqlstate text,p_message text,p_constraint text DEFAULT NULL)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path=pg_catalog,app_private AS $fn$
  SELECT CASE
    WHEN COALESCE(p_message,'') ~ '\[(PROFIT_LOCKED|CASHBOOK_CLOSED|HANDOVER_LOCKED|PERIOD_CLOSED)\]' THEN 'period_locked'
    WHEN COALESCE(p_message,'') ~* 'không còn số tiền có thể thu' THEN 'nothing_to_collect'
    WHEN COALESCE(p_message,'') ~* 'trạng thái hóa đơn không cho phép thu tiền' THEN 'invoice_not_collectible'
    WHEN COALESCE(p_message,'') ~* 'số thu vượt còn phải thu' THEN 'overpay_needs_choice'
    WHEN COALESCE(p_message,'') ~* 'không thể giữ credit' THEN 'credit_requires_contract'
    WHEN COALESCE(p_message,'') ~* '(chưa cài sổ nhận tiền|không nằm trong danh sách sổ nhận tiền|sổ nhận tiền phải là sổ tiền thật)' THEN 'receiving_book_missing'
    WHEN COALESCE(p_message,'') ~* '(không được giao sổ quỹ|không có quyền ghi vào một sổ quỹ)' THEN 'cashbook_not_held'
    WHEN COALESCE(p_message,'') ~* '(cần đối soát|semantic|phân bổ|cọc/NON_PNL vượt|cần review kế toán)' THEN 'reconciliation_required'
    WHEN COALESCE(p_message,'') ~* 'ngày thu không được ở tương lai' THEN 'date_out_of_range'
    WHEN COALESCE(p_message,'') ~* '(writer invoice\.collection\.v5|làm tròn bỏ qua cọc)' THEN 'web_only'
    ELSE app_private.hermes_action_reason_v1(p_sqlstate,p_message,p_constraint) END
$fn$;

-- 2. Tra cứu (INVOKER, RLS người hỏi). Kết quả: {status:'resolved', resolved} | {status:'unresolved', field, wanted, why, candidates, more}
-- | {status:'rejected', reason}. Mục đầu tiên không giải được thì trả về luôn.
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_lookup_core_v1(p_organization_id uuid,p_building_ids uuid[],p_action text,p_params jsonb)
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
            ||CASE WHEN COALESCE(r->>'kind','MONTHLY')<>'MONTHLY' THEN ', '||lower(r->>'kind') ELSE '' END||')') ORDER BY (r->>'row_no')::int),'[]'::jsonb)
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

-- 3. Bước ghi (DEFINER).
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_action_step_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  ctx jsonb; v_org uuid; v_resolved jsonb; v_begin jsonb; v_outcome jsonb; v_constraint text; v_method text; v_method_text text; v_today date; v_date date;
  v_building uuid; v_batch boolean; v_n int; v_res jsonb; v_amount jsonb; v_plan jsonb; v_plans jsonb; v_excluded jsonb; v_ex text;
  v_receiving jsonb; v_no_round boolean; v_try int; v_runs jsonb; v_run jsonb; v_items jsonb; v_warnings jsonb; v_choice jsonb; v_basis text;
  v_total numeric; v_first_reason text; v_label text; v_line text; v_left numeric; v_mode text; v_book text; v_key text; v_retry boolean;
  v_w jsonb; v_text text; v_reason text; v_sum_applied numeric; v_rounding_missing boolean; v_actor uuid;
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
      RETURN jsonb_build_object('kind','rejected','reason','receiving_book_missing'); END IF;
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
          WHEN v_plan->'blockers' ? 'receiving_book_missing' THEN 'receiving_book_missing' ELSE 'crm_refused' END;
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
      v_label:=format('Phòng %s toà %s, kỳ %s%s',v_plan->>'roomName',v_resolved->>'buildingName',
        to_char(to_date(v_plan->>'billingMonth','YYYY-MM'),'MM/YYYY'),COALESCE(' ('||(v_plan->>'invoiceNumber')||')',''));
      IF v_choice IS NOT NULL THEN
        v_line:=format('%s: còn nợ %s.',v_label,app_private.hermes_vnd_text_v1((v_plan->>'remaining')::numeric));
      ELSE
        v_left:=COALESCE((v_run->>'remaining')::numeric,(v_plan->'after'->>'remaining')::numeric);
        v_line:=format('%s: thu %s; còn nợ %s → %s%s%s%s.',v_label,app_private.hermes_vnd_text_v1((v_plan->>'gross')::numeric),
          app_private.hermes_vnd_text_v1((v_plan->>'remaining')::numeric),app_private.hermes_vnd_text_v1(v_left),
          CASE WHEN COALESCE(v_run->>'status',v_plan->'after'->>'status')='PAID' THEN ': ĐÃ THANH TOÁN ĐỦ' ELSE '' END,
          CASE WHEN (v_plan->>'rounding')::numeric>0 THEN format(' (làm tròn bỏ qua %s)',app_private.hermes_vnd_text_v1((v_plan->>'rounding')::numeric)) ELSE '' END,
          CASE WHEN (v_plan->>'credit')::numeric>0 THEN format('; dư %s giữ lại cho kỳ sau (tiền dư của khách)',app_private.hermes_vnd_text_v1((v_plan->>'credit')::numeric))
            WHEN (v_plan->>'returned')::numeric>0 THEN format('; phần dư %s KHÔNG ghi vào CRM, anh/chị tự chuyển trả khách',app_private.hermes_vnd_text_v1((v_plan->>'returned')::numeric))
            ELSE '' END);
      END IF;
      v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('room',v_plan->>'roomName','month',to_char(to_date(v_plan->>'billingMonth','YYYY-MM'),'MM/YYYY'),
        'invoiceNumber',v_plan->>'invoiceNumber','amount',(v_plan->>'gross')::numeric::bigint::text,
        'remainingBefore',(v_plan->>'remaining')::numeric::bigint::text,'remainingAfter',CASE WHEN v_choice IS NULL THEN v_left::bigint::text END,
        'statusAfter',CASE WHEN v_choice IS NULL THEN COALESCE(v_run->>'status',v_plan->'after'->>'status') END,'text',v_line)));
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
        'text',format('Đã ghi thu %s bằng %s cho hoá đơn %s (%s/%s, kỳ %s). Còn nợ %s%s.',app_private.hermes_vnd_text_v1((v_run->>'gross_amount')::numeric),
          v_method_text,COALESCE(v_plan->>'invoiceNumber',''),v_resolved->>'buildingName',v_plan->>'roomName',
          to_char(to_date(v_plan->>'billingMonth','YYYY-MM'),'MM/YYYY'),
          app_private.hermes_vnd_text_v1(COALESCE((v_run->'invoice'->>'remaining_amount')::numeric,0)),
          CASE WHEN v_run->'invoice'->>'status'='PAID' THEN ' — ĐÃ THANH TOÁN' ELSE '' END))));
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

-- 4. Vỏ public (đầu hàm theo khuôn lane migrate:forward nhận cho thân SQL-standard ghi, như public.hermes_expense_write_v1).
CREATE OR REPLACE FUNCTION public.hermes_invoice_action_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb DEFAULT NULL,p_expected_basis text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
  WITH g AS MATERIALIZED (SELECT app_private.hermes_action_guard_v1(p_binding,p_action) AS ctx),
  r AS MATERIALIZED (SELECT CASE WHEN p_phase IN ('preview','auto') AND jsonb_typeof(p_params)='object' THEN
      app_private.hermes_invoice_lookup_core_v1((g.ctx->>'organizationId')::uuid,ARRAY(SELECT jsonb_array_elements_text(g.ctx->'buildingIds')::uuid),
        p_action,p_params) END AS resolution FROM g)
  SELECT app_private.hermes_invoice_action_step_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,r.resolution) FROM r;
END;

ALTER FUNCTION app_private.hermes_invoice_reason_v1(text,text,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_invoice_lookup_core_v1(uuid,uuid[],text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_invoice_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_reason_v1(text,text,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_lookup_core_v1(uuid,uuid[],text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ INVOKER chạy dưới authenticated nên cần EXECUTE trên đúng các hàm app_private nó gắn OID (tra cứu, bước ghi; guard đã cấp ở
-- 20261021133823); không có USAGE app_private nên client không gọi theo tên được. Ánh xạ lý do chỉ bước ghi (DEFINER) gọi: không cấp.
GRANT EXECUTE ON FUNCTION app_private.hermes_invoice_lookup_core_v1(uuid,uuid[],text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_invoice_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND NOT prosecdef AND prosqlbody IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_invoice_lookup_core_v1(uuid,uuid[],text,jsonb)'::regprocedure AND NOT prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_invoice_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure AND prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_proc'::regclass
      AND objid='public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND refobjid='app_private.hermes_action_guard_v1(jsonb,text)'::regprocedure)
    -- Hermes đã giữ dòng công ty từ guard ⇒ dòng hoá đơn khoá KHÔNG CHỜ (chờ = vòng 40P01 với v5 của web).
    OR position('ORDER BY i.id FOR UPDATE NOWAIT' IN (SELECT prosrc FROM pg_proc
      WHERE oid='app_private.hermes_invoice_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure))=0
    OR has_function_privilege('anon','public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_invoice_reason_v1(text,text,text)','EXECUTE')
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_action_policies WHERE action='invoice.collect' AND capability='thu_tien.collect_transfer'
      AND crm_permission='thu_tien.collect' AND action_class='money' AND confirm='always' AND private_only)
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='thu_tien.collect_transfer' AND mode='action')
    OR EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='thu_tien.collect')
    OR app_private.hermes_invoice_reason_v1('55000','Hóa đơn không còn số tiền có thể thu')<>'nothing_to_collect'
    OR app_private.hermes_invoice_reason_v1('42501','Bạn không được giao sổ quỹ này (cần là Người giữ sổ hoặc Người biết sổ). Chọn sổ khác.')<>'cashbook_not_held'
    OR app_private.hermes_invoice_reason_v1('P0001','[PROFIT_LOCKED] Tháng 10 của toà A đã chốt lợi nhuận')<>'period_locked'
    OR app_private.hermes_invoice_reason_v1('XX999','lạ')<>'crm_refused' THEN
    RAISE EXCEPTION 'hermes_invoice_action_catalog_invalid'; END IF;
END $check$;
COMMIT;
