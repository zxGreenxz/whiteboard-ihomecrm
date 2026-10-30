-- Đợt 3 trang HOÁ ĐƠN — J06 (30/10/2026, sửa theo nghiệm thu bot HĐn TC-J06 trên TEST, trượt 3/3 vòng; docs/plans/hermes-crm/
-- HOA-DON-THAO-TAC-GHI.md mục 4.1). Phòng còn hai hoá đơn mở (kỳ mới và một kỳ cũ); người dùng nhắn "khách phòng … ck <đúng số còn nợ của
-- kỳ mới> rồi nha", rồi "ok ghi đi". Bot gọi invoice.collect không month / invoiceNumber ⇒ tra cứu trả name_unresolved (hoá đơn mơ hồ) ⇒
-- bot hỏi lại kỳ; lượt "ok" mới chọn kỳ và lại ra bản xem trước ⇒ hai lượt không ghi được. SOUL đã có luật "số tiền bằng đúng số còn nợ của
-- một hoá đơn thì chọn hoá đơn đó" nhưng mô hình không theo ⇒ máy chủ chọn, ngay chỗ đang sinh câu hỏi "nhiều hoá đơn".
-- (1) app_private.hermes_invoice_lookup_core_v3: THAY thân 20261024181440 (đang chạy ở TEST và production, md5 2203bcfca0c71ea443459e8ecb488d97) bằng
--     đúng thân đó + tự chọn theo số tiền khi đủ cả bốn: không month / invoiceNumber; phòng còn từ hai hoá đơn mở (đúng tập ứng viên của
--     câu hỏi lại: thu được, còn nợ thực, nợ chưa kéo sang kỳ sau); số tiền bằng ĐÚNG remaining_amount của một hoá đơn mở; không hoá đơn
--     mở nào khác cũng khớp. Mục đã giải mang pickedBy = amount, otherOpen (tối đa 3 nhãn hoá đơn mở còn lại, khuôn như ứng viên) và
--     otherOpenCount. Không khớp / khớp từ hai ⇒ hỏi lại như cũ; đã nêu kỳ (kể cả hai hoá đơn còn nợ cùng kỳ) hay số hoá đơn ⇒ không đổi.
--     Lô: theo amount của từng mục; danh sách mục giữ đúng thứ tự (WITH ORDINALITY).
-- (2) app_private.hermes_invoice_action_step_v3: THAY thân 20261026234255 (C07, đang chạy ở TEST và production, md5 5569ec5b424476d960bc83a412a4e34a)
--     bằng đúng thân đó, chỉ đổi khối bản xem trước: mục tự chọn ⇒ nhãn dòng "— tự chọn vì số tiền khớp đúng số còn nợ", items[].pickedBy /
--     otherOpen / otherOpenCount, câu tóm tắt "Tự chọn hoá đơn kỳ MM/YYYY vì số tiền khớp đúng số còn nợ; phòng còn N hoá đơn chưa trả khác: …"
--     (lô: phòng + kỳ từng mục) và MỘT cảnh báo cỡ cố định (chọn lại bằng month / invoiceNumber) nối sau cảnh báo của kế hoạch. Lượt ghi không
--     đổi và không tra cứu lại: dùng đúng resolved của bản xem trước (connector giữ theo confirmToken, mô hình không gửi lại được), basis băm
--     cả invoiceId ⇒ lượt ghi không trôi sang hoá đơn khác (lệch ⇒ state_changed).
-- Chữ ký, kiểu trả về, chủ, ACL, khoá NOWAIT, basis và vỏ public.hermes_invoice_action_v1 (SQL-standard, gắn OID) không đổi. Không mã / khuôn
-- mới (preview là dữ liệu tự do, cảnh báo ≤ 300 ký tự) ⇒ áp độc lập với connector. Không ghi dữ liệu nghiệp vụ. Idempotent ($requires$ nhận
-- thân cũ hoặc thân mới của từng hàm; CREATE OR REPLACE); khối kiểm cuối chỉ đọc catalog. Áp SAU 20261026234255.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)') IS NULL
    OR to_regprocedure('public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)') IS NULL
    OR to_regprocedure('public.invoice_room_invoices_v1(uuid,uuid,text,uuid[],date)') IS NULL
    OR to_regprocedure('app_private.hermes_vnd_text_v1(numeric)') IS NULL
    -- Tra cứu lượt 14 (20261024181440) và bước ghi C07 (20261026234255) đang chạy, hoặc chính thân của file này (chạy lại); md5 bỏ CR.
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb)'::regprocedure)
      NOT IN ('2203bcfca0c71ea443459e8ecb488d97','e4aa9f984d19c0f97ef9ebfef08baaa5')
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure)
      NOT IN ('5569ec5b424476d960bc83a412a4e34a','c106786943309e524b6038d6be09c6e6') THEN
    RAISE EXCEPTION 'hermes_invoice_j06_dependency_invalid'; END IF;
END $requires$;

-- 1. Tra cứu thu tiền (INVOKER, RLS người hỏi) — thân 20261024181440 + tự chọn hoá đơn theo số tiền.
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_lookup_core_v3(p_organization_id uuid,p_building_ids uuid[],p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_method text; v_entries jsonb; v_e jsonb; v_name jsonb; v_building uuid; v_building_name text; v_room uuid; v_room_name text; v_rows jsonb;
  v_pick jsonb; v_open jsonb; v_out jsonb:='[]'::jsonb; v_receiving jsonb; v_list jsonb; v_hits jsonb; v_account uuid; v_wanted text;
  v_number text; v_label text; v_key text; v_book_method text; v_amount numeric; v_match jsonb; v_auto boolean; v_others jsonb; v_others_n int;
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
  -- J06: số tiền của từng mục (lô: amount của mục; một phòng: amount chung) đi cùng mục để tự chọn hoá đơn theo số tiền; lô giữ đúng thứ tự
  -- mục (bước ghi ghép amount theo chỉ số mục).
  v_entries:=CASE WHEN p_params ? 'items' THEN (SELECT jsonb_agg(jsonb_build_object('roomName',x.e->>'roomName','month',COALESCE(x.e->>'month',p_params->>'month'),
        'invoiceNumber',x.e->>'invoiceNumber','amount',x.e->'amount') ORDER BY x.n) FROM jsonb_array_elements(p_params->'items') WITH ORDINALITY x(e,n))
    ELSE jsonb_build_array(jsonb_build_object('roomName',p_params->>'roomName','month',p_params->>'month','invoiceNumber',p_params->>'invoiceNumber',
      'amount',p_params->'amount')) END;
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
    v_auto:=false; v_others:='[]'::jsonb; v_others_n:=0;
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
      -- J06 (nghiệm thu HĐn TC-J06): còn ≥ 2 hoá đơn mở (v_pick trống — đúng tập ứng viên của câu hỏi lại), người dùng chưa nêu kỳ / số hoá
      -- đơn, số tiền khớp ĐÚNG số còn nợ (remaining_amount) của MỘT hoá đơn mở và không hoá đơn mở nào khác cũng khớp ⇒ chọn hoá đơn đó
      -- (pickedBy amount; bản xem trước nói rõ). Không khớp / khớp từ hai ⇒ hỏi lại như cũ.
      v_amount:=CASE WHEN jsonb_typeof(v_e->'amount')='number' THEN (v_e->>'amount')::numeric END;
      IF v_pick IS NULL AND NULLIF(v_e->>'month','') IS NULL AND v_amount>0 THEN
        SELECT jsonb_agg(r ORDER BY (r->>'row_no')::int) INTO v_match FROM jsonb_array_elements(COALESCE(v_open,'[]'::jsonb)) r
          WHERE (r->>'remaining_amount')::numeric=v_amount;
        IF jsonb_array_length(COALESCE(v_match,'[]'::jsonb))=1 THEN
          v_pick:=v_match->0; v_auto:=true;
          -- Hoá đơn mở còn lại: tối đa 3 nhãn (khuôn như ứng viên của câu hỏi lại) + tổng số.
          SELECT COALESCE(jsonb_agg(x.label ORDER BY x.n) FILTER (WHERE x.k<=3),'[]'::jsonb),count(*) INTO v_others,v_others_n
            FROM (SELECT (r->>'row_no')::int n,row_number() OVER (ORDER BY (r->>'row_no')::int) k,
                'kỳ '||to_char(to_date(r->>'billing_month','YYYY-MM'),'MM/YYYY')||COALESCE(' · '||(r->>'invoice_number'),'')||' (còn '
                ||replace(to_char(round((r->>'remaining_amount')::numeric),'FM999,999,999,999,999'),',','.')||'đ'
                ||CASE WHEN r->>'kind'='SETTLEMENT' THEN ', hoá đơn thanh lý' WHEN COALESCE(r->>'kind','MONTHLY')<>'MONTHLY' THEN ', '||lower(r->>'kind') ELSE '' END||')' label
              FROM jsonb_array_elements(v_open) r WHERE r->>'invoice_id' IS DISTINCT FROM v_pick->>'invoice_id') x;
        END IF;
      END IF;
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
      'invoiceNumber',v_pick->>'invoice_number','billingMonth',v_pick->>'billing_month')
      ||CASE WHEN v_auto THEN jsonb_build_object('pickedBy','amount','otherOpen',v_others,'otherOpenCount',v_others_n) ELSE '{}'::jsonb END);
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

-- 2. Bước ghi thu tiền (DEFINER) — thân 20261026234255 (C07) + bản xem trước nói rõ hoá đơn tự chọn.
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_action_step_v3(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  ctx jsonb; v_org uuid; v_resolved jsonb; v_begin jsonb; v_outcome jsonb; v_constraint text; v_method text; v_method_text text; v_today date; v_date date;
  v_building uuid; v_batch boolean; v_n int; v_res jsonb; v_amount jsonb; v_plan jsonb; v_plans jsonb; v_excluded jsonb; v_ex text;
  v_receiving jsonb; v_no_round boolean; v_try int; v_runs jsonb; v_run jsonb; v_items jsonb; v_warnings jsonb; v_choice jsonb; v_basis text;
  v_total numeric; v_first_reason text; v_label text; v_line text; v_left numeric; v_mode text; v_book text; v_key text; v_retry boolean;
  v_others text; v_note_key text; v_w jsonb; v_text text; v_reason text; v_sum_applied numeric; v_rounding_missing boolean; v_actor uuid; v_round numeric; v_st text; v_settle boolean;
  v_res_item jsonb; v_auto boolean; v_auto_n int:=0; v_auto_note text; v_auto_one text;
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
      -- C07 (nghiệm thu 26–27/10): kiểm hoãn của các bảng hàm ghi web chạm (constraint trigger DEFERRED — phân bổ thành phần hoá đơn, chứng cứ
      -- đồng hồ, cọc có phòng…) chạy NGAY trong khối con như lúc COMMIT. Không ép thì sự kiện hoãn bị bỏ cùng khối và bản xem trước "ghi được"
      -- một lần thu mà COMMIT sẽ từ chối. Lỗi rơi vào nhánh EXCEPTION dưới (lý do đóng); khối lùi ⇒ chế độ ràng buộc về như trước khối.
      SET CONSTRAINTS ALL IMMEDIATE;
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
      -- J06: hoá đơn tra cứu TỰ CHỌN theo số tiền (pickedBy amount) ⇒ nhãn dòng, items[].pickedBy / otherOpen, câu tóm tắt và một cảnh báo.
      v_res_item:=v_resolved->'items'->((v_plan->>'n')::int-1);
      v_auto:=COALESCE(v_res_item->>'pickedBy'='amount',false);
      IF v_auto THEN
        v_auto_n:=v_auto_n+1;
        v_auto_note:=concat_ws(', ',v_auto_note,format('phòng %s kỳ %s',v_plan->>'roomName',to_char(to_date(v_plan->>'billingMonth','YYYY-MM'),'MM/YYYY')));
        v_auto_one:=format(' Tự chọn hoá đơn kỳ %s vì số tiền khớp đúng số còn nợ; phòng còn %s hoá đơn chưa trả khác: %s%s.',
          to_char(to_date(v_plan->>'billingMonth','YYYY-MM'),'MM/YYYY'),COALESCE(v_res_item->>'otherOpenCount','?'),
          COALESCE((SELECT string_agg(o.v,', ' ORDER BY o.i) FROM jsonb_array_elements_text(COALESCE(v_res_item->'otherOpen','[]'::jsonb)) WITH ORDINALITY o(v,i)),'…'),
          CASE WHEN COALESCE((v_res_item->>'otherOpenCount')::int,0)>jsonb_array_length(COALESCE(v_res_item->'otherOpen','[]'::jsonb)) THEN ', …' ELSE '' END);
      END IF;
      v_label:=format('Phòng %s toà %s, kỳ %s%s%s%s',v_plan->>'roomName',v_resolved->>'buildingName',
        to_char(to_date(v_plan->>'billingMonth','YYYY-MM'),'MM/YYYY'),COALESCE(' ('||(v_plan->>'invoiceNumber')||')',''),
        CASE WHEN v_settle THEN ' — hoá đơn thanh lý' ELSE '' END,CASE WHEN v_auto THEN ' — tự chọn vì số tiền khớp đúng số còn nợ' ELSE '' END);
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
        'invoiceNumber',v_plan->>'invoiceNumber','pickedBy',CASE WHEN v_auto THEN 'amount' END,'otherOpen',CASE WHEN v_auto THEN v_res_item->'otherOpen' END,
        'otherOpenCount',CASE WHEN v_auto THEN (v_res_item->>'otherOpenCount')::int END,'amount',(v_plan->>'gross')::numeric::bigint::text,
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
    -- J06: MỘT cảnh báo cho mọi mục tự chọn, nối SAU cảnh báo của kế hoạch (thu trùng, quá hạn…) để trần 10 không đẩy mất chúng; cỡ cố định —
    -- danh sách hoá đơn mở còn lại nằm ở câu tóm tắt / items[].otherOpen (không trần 300 ký tự).
    IF v_auto_n>0 THEN
      v_warnings:=v_warnings||jsonb_build_array(left(CASE WHEN jsonb_array_length(v_plans)=1
        THEN format('Người dùng chưa nêu kỳ nên TỰ CHỌN hoá đơn kỳ %s%s của phòng %s vì số tiền khớp đúng số còn nợ. Nếu người dùng nói kỳ / hoá đơn khác: gọi lại kèm month hoặc invoiceNumber để xem trước lại.',
          to_char(to_date(v_plans->0->>'billingMonth','YYYY-MM'),'MM/YYYY'),COALESCE(' ('||(v_plans->0->>'invoiceNumber')||')',''),v_plans->0->>'roomName')
        ELSE format('Người dùng chưa nêu kỳ nên TỰ CHỌN hoá đơn theo số tiền khớp đúng số còn nợ cho %s mục (xem tóm tắt). Nếu người dùng nói kỳ / hoá đơn khác: gọi lại kèm month hoặc invoiceNumber trong mục đó để xem trước lại.',
          v_auto_n) END,300));
    END IF;
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
              CASE WHEN jsonb_array_length(v_plans)=1 THEN 'hoá đơn '||COALESCE(v_plans->0->>'invoiceNumber','') ELSE jsonb_array_length(v_plans)||' hoá đơn' END)
            ||CASE WHEN v_auto_n=0 THEN '' WHEN jsonb_array_length(v_plans)=1 THEN COALESCE(v_auto_one,'')
              ELSE format(' Tự chọn hoá đơn theo số tiền khớp đúng số còn nợ: %s.',v_auto_note) END END,
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
    v_outcome:=app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
    -- C07: tập dượt kiểm hoãn SAU khi chốt biên nhận (rào biên nhận chưa chốt cũng là kiểm hoãn). Trước đây chúng chỉ chạy lúc COMMIT, sau khi
    -- hàm đã trả applied và ngoài mọi khối EXCEPTION ⇒ PostgREST trả mã lạ (55000 ⇒ HTTP 500) ⇒ connector action_outcome_unknown, giao dịch lùi
    -- cả biên nhận ⇒ crm_action_status not_found. Khối con này ép chúng chạy rồi tự lùi: sự kiện hoãn được trả về hàng đợi và chạy lại lúc
    -- COMMIT như cũ, chế độ ràng buộc không đổi cho phần còn lại của giao dịch. Lỗi (không phải HC001) lọt ra khối ghi ⇒ lùi lần thu lẫn biên
    -- nhận ⇒ state_changed như mọi lỗi lượt 2 (lỗi tạm vẫn ném lại).
    BEGIN
      SET CONSTRAINTS ALL IMMEDIATE;
      RAISE EXCEPTION 'hermes_invoice_commit_checks' USING ERRCODE='HC001';
    EXCEPTION WHEN SQLSTATE 'HC001' THEN NULL;
    END;
    RETURN v_outcome;
  EXCEPTION
    WHEN SQLSTATE 'HS001' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed');
    WHEN OTHERS THEN
      IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
      -- Lượt 1 đã chạy thử cùng hàm ghi mà qua: lỗi ở đây nghĩa là dữ liệu đã đổi sau bản xem trước ⇒ không ghi gì, xem trước lại.
      RETURN jsonb_build_object('kind','rejected','reason','state_changed');
  END;
END $fn$;

ALTER FUNCTION app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ INVOKER chạy dưới authenticated và gắn OID hai hàm này (như 20261024181440, 20261026234255).
GRANT EXECUTE ON FUNCTION app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) TO authenticated;

DO $check$
DECLARE l pg_catalog.pg_proc; s pg_catalog.pg_proc;
BEGIN
  SELECT * INTO l FROM pg_catalog.pg_proc WHERE oid='app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb)'::regprocedure;
  SELECT * INTO s FROM pg_catalog.pg_proc WHERE oid='app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure;
  IF l.prosecdef OR l.provolatile<>'s' OR pg_get_userbyid(l.proowner)<>'postgres'
    OR replace(COALESCE(array_to_string(l.proconfig,','),''),'"','')<>'search_path=' OR md5(replace(l.prosrc,chr(13),''))<>'e4aa9f984d19c0f97ef9ebfef08baaa5'
    OR NOT s.prosecdef OR pg_get_userbyid(s.proowner)<>'postgres' OR md5(replace(s.prosrc,chr(13),''))<>'c106786943309e524b6038d6be09c6e6'
    OR position('ORDER BY i.id FOR UPDATE NOWAIT' IN s.prosrc)=0
    OR has_function_privilege('anon','app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb)','EXECUTE') OR NOT has_function_privilege('authenticated','app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)','EXECUTE') OR NOT has_function_privilege('authenticated','app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)','EXECUTE')
    -- Vỏ vẫn gắn đúng hai tầng này (pg_depend theo OID; CREATE OR REPLACE giữ OID).
    OR (SELECT count(DISTINCT refobjid) FROM pg_depend WHERE classid='pg_proc'::regclass AND objid='public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND refobjid IN ('app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb)'::regprocedure,'app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure))<>2 THEN
    RAISE EXCEPTION 'hermes_invoice_j06_check_failed'; END IF;
END $check$;
COMMIT;
