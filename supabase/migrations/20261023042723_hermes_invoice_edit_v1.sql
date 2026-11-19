-- Đợt 3 trang HOÁ ĐƠN — Mốc 5 (23/10/2026; docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục 4.3–4.5, 5): bốn thao tác trên RPC trang
-- public.hermes_invoice_action_v1 — invoice.adjust (điều chỉnh: giảm thêm, thêm khoản, đặt thành tiền một dòng không có chỉ số),
-- invoice.adjustment_check (xác nhận ĐÃ KIỂM TRA điều chỉnh do người khác làm, Q19 = a, HDN6), invoice.cancel / invoice.restore (huỷ /
-- khôi phục hoá đơn chưa thu, lý do bắt buộc chỉ nằm ở biên nhận + audit Hermes, HDN8). Mọi thao tác luôn xem trước.
-- Áp SAU 20261022183445_hermes_invoice_meter_v1 (vỏ chuyển theo thao tác) và 20261023042242_invoice_adjustment_build_v1 (hàm dựng dòng dùng chung).
--  (1) app_private.hermes_invoice_edit_reason_v1(sqlstate, message, constraint) IMMUTABLE: câu lỗi thật của adjust_invoice_v2 /
--      review_invoice_adjustment_v2 / cancel_invoice_with_credit_v1 / restore_invoice_with_credit_v1 ⇒ mã của trang, rồi ánh xạ của Mốc 3.
--  (2) app_private.hermes_invoice_edit_lookup_v1(org, toà[], action, params) plpgsql STABLE INVOKER search_path='': toà/phòng bằng
--      public.hermes_write_name_resolve_v1 (D7); hoá đơn của phòng dưới RLS người hỏi + khoá trang invoices.view theo toà; kỳ trống ⇒ hoá
--      đơn MONTHLY mới nhất chưa huỷ (khôi phục: đã huỷ; xác nhận kiểm tra: điều chỉnh chờ DUY NHẤT), có kỳ/số ⇒ đúng một ứng viên, ≥ 2 ⇒
--      hỏi lại với ứng viên mang SỐ HOÁ ĐƠN; điều chỉnh: dòng người dùng nêu (setItems.match) khớp ĐÚNG MỘT dòng theo mô tả đã bỏ dấu trên
--      danh sách dòng của public.invoice_adjustment_build_v1 — dòng khoá (chỉ số, điện/nước, cọc, NON_PNL) ⇒ adjust_meter_line_web_only.
--      Chỉ tham chiếu public.*. Không khoá dòng nào.
--  (3) app_private.hermes_invoice_edit_step_v1(...) DEFINER: phát lại trước; đối chiếu bản đã giải (hoá đơn thuộc đúng công ty/toà/phòng,
--      toà ∈ guard). THỨ TỰ KHOÁ: guard dùng chung đã khoá dòng công ty (lock_org_for_decision_v1). Ba hàm ghi web điều chỉnh/huỷ/khôi phục
--      khoá công ty → hợp đồng → hoá đơn (invoice_rent_support_lock_v1 rồi FOR UPDATE) — cùng chiều; review_invoice_adjustment_v2 khoá hoá
--      đơn → điều chỉnh, không xin công ty; nhưng các đường web khác giữ dòng hoá đơn / hợp đồng TRƯỚC khi xin công ty
--      (record_invoice_collection_v5, hàm ghi hợp đồng). Vì vậy Hermes KHÔNG CHỜ: hợp đồng → hoá đơn (→ điều chỉnh) FOR UPDATE NOWAIT, bận ⇒
--      55P03 ⇒ lùi cả giao dịch ⇒ connector trả state_changed (bài học Mốc 3b). Rồi kiểm ĐÚNG biểu thức quyền của hàm ghi (luật 17/10:
--      không bao giờ xem trước "được" rồi ghi "không được"); lượt 1 CHẠY THỬ đúng hàm ghi web trong khối con rồi lùi (HD001) — tổng sau,
--      trạng thái sau và mọi lỗi của hàm ghi ra ngay ở bản xem trước; lượt 2 mở biên nhận, so basis, gọi hàm ghi với khoá
--      hermes-adj: / hermes-cancel: / hermes-restore: <requestId> (review_invoice_adjustment_v2 không nhận khoá: phát lại nhờ biên nhận +
--      CHECKED trả lại bản cũ), hậu điều kiện. Điều chỉnh do chính người hỏi làm ⇒ adjustment_self_check_web_only (HDN6).
--  (4) public.hermes_invoice_action_v1: THAY vỏ SQL-standard của 20261022183445 để chuyển thêm bốn thao tác sang (2)/(3); thu tiền và chỉ
--      số giữ nguyên thân (md5 ghim ở $requires$). Ghim băm vỏ mới ở scripts/hermes-task-function-contract.mjs; bản cũ vào FORWARD_SUPERSEDED.
--  (5) Dòng chính sách: invoice.adjust (invoices.edit, money), invoice.adjustment_check (invoices.approve, irreversible), invoice.cancel /
--      invoice.restore (invoices.cancel, money); đều always, chỉ chat riêng. Ba khoá đã seed TẮT ở 20261021134531.
-- Không ghi dữ liệu nghiệp vụ. Idempotent (CREATE OR REPLACE, ON CONFLICT DO NOTHING); khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('app_private.hermes_action_policies') IS NULL OR to_regclass('app_private.hermes_action_receipts') IS NULL
    OR to_regclass('public.invoice_adjustments') IS NULL OR to_regclass('public.customer_credit_applications') IS NULL
    OR to_regprocedure('app_private.hermes_action_guard_v1(jsonb,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_vnd_text_v1(numeric)') IS NULL
    OR to_regprocedure('app_private.hermes_vn_date_text_v1(date,date)') IS NULL
    OR to_regprocedure('app_private.current_uid_v1()') IS NULL
    OR to_regprocedure('app_private.can_edit_invoice_building_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.has_building_perm_v1(uuid,text[])') IS NULL
    OR to_regprocedure('public.can_access_building(uuid)') IS NULL OR to_regprocedure('public.can_do_on_building(text,text,uuid)') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)') IS NULL
    OR to_regprocedure('public.hermes_name_fold_v1(text)') IS NULL
    OR to_regprocedure('public.org_today_v1(uuid)') IS NULL
    OR to_regprocedure('public.invoice_adjustment_build_v1(uuid,jsonb)') IS NULL
    OR to_regprocedure('public.review_invoice_adjustment_v2(uuid,bigint)') IS NULL
    OR to_regprocedure('public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)') IS NULL
    -- Thứ tự khoá ở trên dựa vào việc ba hàm ghi web vẫn mở đầu bằng khoá công ty → hợp đồng của invoice_rent_support_lock_v1.
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamp with time zone,text)',
        'public.cancel_invoice_with_credit_v1(uuid,text)','public.restore_invoice_with_credit_v1(uuid,text)']) f
      WHERE to_regprocedure(f) IS NULL OR position('app_private.invoice_rent_support_lock_v1(p_invoice_id)' IN
        (SELECT p.prosrc FROM pg_proc p WHERE p.oid=to_regprocedure(f)))=0)
    -- Vỏ cũ chuyển bốn tầng thu tiền + chỉ số và ánh xạ lý do Mốc 3: thân giữ nguyên (md5 đúng file đã duyệt, bỏ CR).
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_lookup_core_v1(uuid,uuid[],text,jsonb)'::regprocedure)
      IS DISTINCT FROM '6e43435615b525c4ea5b32e9c3588bbc'
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure)
      IS DISTINCT FROM '7c2cdc78435ba4559da0de45828a61ed'
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_meter_lookup_v1(uuid,uuid[],text,jsonb)'::regprocedure)
      IS DISTINCT FROM '56f5e7ca5508f88d2cd6e7ca587150fd'
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure)
      IS DISTINCT FROM 'bcaeccc890b87c70119a2d9d87e4e826'
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_reason_v1(text,text,text)'::regprocedure)
      IS DISTINCT FROM '47ad56de87103936f0f79ba88c62a177'
    OR (SELECT count(*) FROM app_private.hermes_capabilities WHERE capability IN ('invoices.edit','invoices.approve','invoices.cancel') AND mode='action')<>3 THEN
    RAISE EXCEPTION 'hermes_invoice_edit_dependency_invalid'; END IF;
END $requires$;

INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES
  ('invoice.adjust','invoices.edit','invoices.edit','money','always',true),
  ('invoice.adjustment_check','invoices.approve','invoices.approve','irreversible','always',true),
  ('invoice.cancel','invoices.cancel','invoices.cancel','money','always',true),
  ('invoice.restore','invoices.cancel','invoices.cancel','money','always',true)
  ON CONFLICT(action) DO NOTHING;

-- 1. Mã lý do của trang (câu lỗi thật của bốn hàm ghi web, HOA-DON-THAO-TAC-GHI.md mục 5), rồi ánh xạ Mốc 3 (và danh sách chung).
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_edit_reason_v1(p_sqlstate text,p_message text,p_constraint text DEFAULT NULL)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path=pg_catalog,app_private AS $fn$
  SELECT CASE
    WHEN COALESCE(p_message,'') ~ '\[(PROFIT_LOCKED|CASHBOOK_CLOSED|HANDOVER_LOCKED|PERIOD_CLOSED)\]' THEN 'period_locked'
    -- Hoá đơn có hỗ trợ tiền phòng: hàm ghi đòi đối soát (PT409) — không phải "dữ liệu vừa đổi".
    WHEN COALESCE(p_message,'') ~ '(REVENUE_CAP_REVIEW|Support discount changes require reconciliation)' THEN 'web_only'
    WHEN COALESCE(p_message,'') ~* 'có làm tròn hoặc cấn trừ' THEN 'adjust_has_rounding_or_credit'
    WHEN COALESCE(p_message,'') ~* 'nợ đã chuyển sang hóa đơn sau' THEN 'adjust_debt_carried'
    WHEN COALESCE(p_message,'') ~* 'thấp hơn tiền đã phân bổ' THEN 'adjust_below_collected'
    WHEN COALESCE(p_message,'') ~* 'không có thay đổi nội dung hóa đơn' THEN 'adjust_no_change'
    WHEN COALESCE(p_message,'') ~* 'chỉ điều chỉnh hóa đơn đã phát hành' THEN 'web_only'
    WHEN COALESCE(p_message,'') ~* '(giảm giá hoặc tổng tiền không hợp lệ|giảm giá không hợp lệ)' THEN 'amount_out_of_range'
    WHEN COALESCE(p_message,'') ~* 'lý do phải dài' THEN 'reason_required'
    WHEN COALESCE(p_message,'') ~* '(chưa đối soát|chưa chứng minh được|unreconciled legacy customer credit|mixed active and pending-restoration credit|credit invoice has no contract)'
      THEN 'reconciliation_required'
    WHEN COALESCE(p_message,'') ~* '(không thể huỷ hoá đơn ở trạng thái này|reverse the payment credit source)' THEN 'cancel_has_payment'
    WHEN COALESCE(p_message,'') ~* 'only cancelled invoices can be restored' THEN 'invoice_not_cancelled'
    WHEN p_constraint='idx_invoices_unique_contract_billing' OR COALESCE(p_message,'') ~ 'idx_invoices_unique_contract_billing' THEN 'restore_conflict'
    -- Khoá idempotency do requestId cấp: trùng nghĩa là lệch đầu vào, không phải "đã ghi trước đó".
    WHEN COALESCE(p_message,'') ~* 'khóa yêu cầu đã dùng cho nội dung khác' THEN 'crm_refused'
    ELSE app_private.hermes_invoice_reason_v1(p_sqlstate,p_message,p_constraint) END
$fn$;

-- 2. Tra cứu (INVOKER, RLS người hỏi). Kết quả: {status:'resolved', resolved} | {status:'unresolved', field, wanted, why, candidates, more}
-- | {status:'rejected', reason}.
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_edit_lookup_v1(p_organization_id uuid,p_building_ids uuid[],p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_name jsonb; v_building uuid; v_building_name text; v_room uuid; v_room_name text; v_month text; v_number text; v_label text;
  v_rows jsonb; v_cand jsonb; v_pick jsonb; v_build jsonb; v_s jsonb; v_wanted text; v_hits jsonb; v_ids jsonb:='[]'::jsonb;
  v_adjustment uuid; v_adjusted_by uuid; v_who text;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_invoice_lookup_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_building_ids IS NULL OR p_action IS NULL
    OR p_action NOT IN ('invoice.adjust','invoice.adjustment_check','invoice.cancel','invoice.restore') OR p_params IS NULL OR jsonb_typeof(p_params)<>'object' THEN
    RAISE EXCEPTION 'hermes_invoice_lookup_invalid' USING ERRCODE='22023'; END IF;
  -- Điều chỉnh phải đổi ít nhất một thứ (ràng buộc chéo tham số kiểm ở SQL, mục 3).
  IF p_action='invoice.adjust' AND NOT (p_params ? 'discount' OR p_params ? 'addItems' OR p_params ? 'setItems') THEN
    RETURN jsonb_build_object('status','rejected','reason','invalid_params'); END IF;
  v_name:=public.hermes_write_name_resolve_v1(p_organization_id,p_building_ids,
    jsonb_strip_nulls(jsonb_build_object('building',p_params->>'buildingName','room',p_params->>'roomName')));
  IF v_name->>'status'<>'resolved' THEN RETURN v_name; END IF;
  v_building:=(v_name#>>'{building,id}')::uuid; v_building_name:=v_name#>>'{building,name}';
  v_room:=(v_name#>>'{room,id}')::uuid; v_room_name:=v_name#>>'{room,name}';
  IF v_building IS NULL OR v_room IS NULL THEN RETURN jsonb_build_object('status','unresolved','field','room','wanted',COALESCE(p_params->>'roomName',''),
    'why','not_visible','candidates','[]'::jsonb,'more',false); END IF;
  v_month:=NULLIF(btrim(COALESCE(p_params->>'month','')),''); v_number:=upper(btrim(NULLIF(p_params->>'invoiceNumber','')));
  v_label:=left(v_room_name||COALESCE(' kỳ '||v_month,'')||COALESCE(' '||btrim(p_params->>'invoiceNumber'),''),200);
  -- Hoá đơn của phòng dưới RLS người hỏi + khoá trang invoices.view theo toà (như invoice_room_invoices_v1); mới nhất trước, MONTHLY trước.
  IF public.can_do_on_building('invoices','view',v_building) IS NOT TRUE THEN
    RETURN jsonb_build_object('status','unresolved','field','invoice','wanted',v_label,'why','not_visible','candidates','[]'::jsonb,'more',false); END IF;
  SELECT jsonb_agg(jsonb_build_object('invoiceId',i.id,'invoiceNumber',i.invoice_number,'billingMonth',i.billing_month,'status',i.status::text,
      'kind',COALESCE(i.kind,'MONTHLY'),'total',COALESCE(i.total_amount,0),'review',i.adjustment_review_status)
      ORDER BY i.billing_month DESC,(COALESCE(i.kind,'MONTHLY')='MONTHLY') DESC,i.created_at DESC,i.id) INTO v_rows
    FROM public.invoices i WHERE i.organization_id=p_organization_id AND i.building_id=v_building AND i.room_id=v_room AND i.deleted_at IS NULL
      AND (v_month IS NULL OR i.billing_month=v_month) AND (v_number IS NULL OR upper(btrim(i.invoice_number))=v_number);
  IF v_rows IS NULL THEN
    RETURN jsonb_build_object('status','unresolved','field','invoice','wanted',v_label,'why','not_visible','candidates','[]'::jsonb,'more',false); END IF;
  SELECT jsonb_agg(r ORDER BY n) INTO v_cand FROM jsonb_array_elements(v_rows) WITH ORDINALITY x(r,n)
    WHERE CASE p_action WHEN 'invoice.restore' THEN r->>'status'='CANCELLED'
      WHEN 'invoice.adjustment_check' THEN r->>'status'<>'CANCELLED' AND r->>'review'='PENDING' ELSE r->>'status'<>'CANCELLED' END;
  IF v_cand IS NULL THEN
    -- Có hoá đơn nhưng ở trạng thái khác: đã huỷ (điều chỉnh/huỷ), đang hiệu lực (khôi phục), không có điều chỉnh chờ (xác nhận kiểm tra).
    RETURN jsonb_build_object('status','rejected','reason',CASE p_action WHEN 'invoice.restore' THEN 'invoice_not_cancelled'
      WHEN 'invoice.adjustment_check' THEN 'nothing_to_check' ELSE 'invoice_already_cancelled' END); END IF;
  -- Kỳ trống (không số hoá đơn): hoá đơn MONTHLY mới nhất; xác nhận kiểm tra: điều chỉnh chờ DUY NHẤT. Có kỳ/số: đúng một ứng viên.
  v_pick:=CASE WHEN jsonb_array_length(v_cand)=1 THEN v_cand->0
    WHEN v_month IS NULL AND v_number IS NULL AND p_action<>'invoice.adjustment_check' THEN
      COALESCE((SELECT r FROM jsonb_array_elements(v_cand) WITH ORDINALITY x(r,n) WHERE r->>'kind'='MONTHLY' ORDER BY n LIMIT 1),v_cand->0) END;
  IF v_pick IS NULL THEN
    RETURN jsonb_build_object('status','unresolved','field','invoice','wanted',v_label,'why','ambiguous','more',jsonb_array_length(v_cand)>8,
      'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',
          'kỳ '||to_char(to_date(r->>'billingMonth','YYYY-MM'),'MM/YYYY')||COALESCE(' · '||(r->>'invoiceNumber'),'')||' (tổng '
          ||replace(to_char(round((r->>'total')::numeric),'FM999,999,999,999,999'),',','.')||'đ'
          ||CASE WHEN r->>'kind'<>'MONTHLY' THEN ', '||lower(r->>'kind') ELSE '' END||')') ORDER BY n),'[]'::jsonb)
        FROM (SELECT r,n FROM jsonb_array_elements(v_cand) WITH ORDINALITY x(r,n) ORDER BY n LIMIT 8) y));
  END IF;

  IF p_action='invoice.adjust' THEN
    -- Dòng hiện có theo hàm dựng dòng dùng chung (cùng luật khoá dòng với web); hoá đơn web phải tự xử (thanh lý, nợ cũ lệch nguồn,
    -- chưa phát hành) ⇒ chỉ đường web ngay.
    v_build:=public.invoice_adjustment_build_v1((v_pick->>'invoiceId')::uuid,'{}'::jsonb);
    IF v_build->'blockers' ? 'not_found' THEN
      RETURN jsonb_build_object('status','unresolved','field','invoice','wanted',v_label,'why','not_visible','candidates','[]'::jsonb,'more',false); END IF;
    IF v_build->'blockers' ?| ARRAY['not_issued','settlement','debt_source_invalid','debt_source_mismatch'] THEN
      RETURN jsonb_build_object('status','rejected','reason','web_only'); END IF;
    IF p_params ? 'setItems' AND jsonb_typeof(p_params->'setItems')<>'array' THEN RETURN jsonb_build_object('status','rejected','reason','invalid_params'); END IF;
    FOR v_s IN SELECT value FROM jsonb_array_elements(COALESCE(p_params->'setItems','[]'::jsonb)) LOOP
      v_wanted:=public.hermes_name_fold_v1(v_s->>'match');
      SELECT jsonb_agg(l) INTO v_hits FROM jsonb_array_elements(v_build#>'{before,lines}') l WHERE public.hermes_name_fold_v1(l->>'description')=v_wanted;
      IF v_hits IS NULL AND char_length(v_wanted)>=2 THEN
        SELECT jsonb_agg(l) INTO v_hits FROM jsonb_array_elements(v_build#>'{before,lines}') l
          WHERE strpos(public.hermes_name_fold_v1(l->>'description'),v_wanted)>0;
      END IF;
      IF jsonb_array_length(COALESCE(v_hits,'[]'::jsonb))<>1 THEN
        RETURN jsonb_build_object('status','unresolved','field','invoice','wanted',left(COALESCE(v_s->>'match',''),200),
          'why',CASE WHEN jsonb_array_length(COALESCE(v_hits,'[]'::jsonb))>=2 THEN 'ambiguous' ELSE 'not_visible' END,
          'more',jsonb_array_length(CASE WHEN v_hits IS NULL THEN v_build#>'{before,lines}' ELSE v_hits END)>8,
          'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',left(l->>'description',120)||' ('
              ||replace(to_char(round((l->>'amount')::numeric),'FM999,999,999,999,999'),',','.')||'đ)') ORDER BY n),'[]'::jsonb)
            FROM (SELECT l,n FROM jsonb_array_elements(CASE WHEN v_hits IS NULL THEN v_build#>'{before,lines}' ELSE v_hits END) WITH ORDINALITY x(l,n)
              ORDER BY n LIMIT 8) y));
      END IF;
      IF v_hits->0->>'lock' IS NOT NULL THEN RETURN jsonb_build_object('status','rejected','reason','adjust_meter_line_web_only'); END IF;
      v_ids:=v_ids||jsonb_build_array(v_hits->0->>'id');
    END LOOP;
    IF (SELECT count(DISTINCT x) FROM jsonb_array_elements_text(v_ids) x)<>jsonb_array_length(v_ids) THEN
      RETURN jsonb_build_object('status','rejected','reason','invalid_params'); END IF;
  ELSIF p_action='invoice.adjustment_check' THEN
    -- Điều chỉnh của phiên bản hiện hành (hàm ghi chỉ cho kiểm phiên bản đó); tên người điều chỉnh dưới RLS profiles.
    SELECT a.id,a.adjusted_by INTO v_adjustment,v_adjusted_by FROM public.invoice_adjustments a JOIN public.invoices i ON i.id=a.invoice_id
      WHERE a.invoice_id=(v_pick->>'invoiceId')::uuid AND a.revision=i.adjustment_revision AND a.review_status='PENDING';
    IF v_adjustment IS NULL THEN RETURN jsonb_build_object('status','rejected','reason','nothing_to_check'); END IF;
    SELECT p.full_name INTO v_who FROM public.profiles p WHERE p.id=v_adjusted_by;
  END IF;
  RETURN jsonb_build_object('status','resolved','resolved',jsonb_strip_nulls(jsonb_build_object('buildingId',v_building,'buildingName',v_building_name,
    'roomId',v_room,'roomName',v_room_name,'invoiceId',v_pick->>'invoiceId','invoiceNumber',v_pick->>'invoiceNumber','billingMonth',v_pick->>'billingMonth',
    'setItemIds',CASE WHEN p_action='invoice.adjust' THEN v_ids END,'adjustmentId',v_adjustment,'adjusterName',left(btrim(v_who),120))));
END $fn$;

-- 3. Bước ghi (DEFINER).
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_edit_step_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  ctx jsonb; v_org uuid; v_resolved jsonb; v_begin jsonb; v_outcome jsonb; v_constraint text; v_reason text; v_today date; v_actor uuid;
  v_building uuid; v_invoice uuid; inv public.invoices%ROWTYPE; v_label text; v_month text; v_basis text; v_note text;
  v_ops jsonb; v_build jsonb; v_ids jsonb; v_adj public.invoice_adjustments%ROWTYPE; v_done public.invoice_adjustments%ROWTYPE;
  v_run jsonb; v_res jsonb; v_items jsonb; v_warnings jsonb:='[]'::jsonb; v_credit numeric:=0; v_carried jsonb; v_c jsonb;
  v_status text; v_remaining numeric; v_when text; v_who text; v_noop boolean:=false; v_status_text text;
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
  v_note:=btrim(COALESCE(p_params->>'reason',''));
  IF p_action<>'invoice.adjustment_check' AND char_length(v_note) NOT BETWEEN 8 AND (CASE WHEN p_action='invoice.adjust' THEN 1000 ELSE 500 END) THEN
    RETURN jsonb_build_object('kind','rejected','reason','reason_required'); END IF;

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
          v_note,inv.adjustment_revision,COALESCE(inv.paid_amount,0),inv.updated_at,'hermes-dry:'||p_request_id::text);
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
          RETURN jsonb_build_object('kind','rejected','reason',v_reason);
      END;
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

-- 4. Vỏ public: chuyển theo thao tác. Đầu hàm theo khuôn lane migrate:forward nhận cho thân SQL-standard ghi (như 20261022183445).
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
      ELSE app_private.hermes_invoice_lookup_core_v1((g.ctx->>'organizationId')::uuid,ARRAY(SELECT jsonb_array_elements_text(g.ctx->'buildingIds')::uuid),
          p_action,p_params) END END AS resolution FROM g)
  SELECT CASE WHEN p_action='invoice.meter_record'
    THEN app_private.hermes_invoice_meter_step_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,r.resolution)
    WHEN p_action IN ('invoice.adjust','invoice.adjustment_check','invoice.cancel','invoice.restore')
    THEN app_private.hermes_invoice_edit_step_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,r.resolution)
    ELSE app_private.hermes_invoice_action_step_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,r.resolution) END FROM r;
END;

ALTER FUNCTION app_private.hermes_invoice_edit_reason_v1(text,text,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_invoice_edit_lookup_v1(uuid,uuid[],text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_invoice_edit_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_edit_reason_v1(text,text,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_edit_lookup_v1(uuid,uuid[],text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_edit_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ INVOKER chạy dưới authenticated nên cần EXECUTE trên đúng các hàm app_private nó gắn OID (guard: 20261021133823; thu tiền:
-- 20261022075230; chỉ số: 20261022183445); không có USAGE app_private nên client không gọi theo tên được. Ánh xạ lý do chỉ bước ghi gọi.
GRANT EXECUTE ON FUNCTION app_private.hermes_invoice_edit_lookup_v1(uuid,uuid[],text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_invoice_edit_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;

DO $check$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid='app_private.hermes_invoice_edit_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND NOT prosecdef AND prosqlbody IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_invoice_edit_lookup_v1(uuid,uuid[],text,jsonb)'::regprocedure AND NOT prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_invoice_edit_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure AND prosecdef)
    -- Vỏ gắn đủ bảy tầng: guard, hai tầng thu tiền, hai tầng chỉ số (thân giữ nguyên), hai tầng sửa/huỷ/khôi phục.
    OR (SELECT count(DISTINCT refobjid) FROM pg_depend WHERE classid='pg_proc'::regclass
      AND objid='public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND refobjid IN ('app_private.hermes_action_guard_v1(jsonb,text)'::regprocedure,
        'app_private.hermes_invoice_lookup_core_v1(uuid,uuid[],text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_meter_lookup_v1(uuid,uuid[],text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_edit_lookup_v1(uuid,uuid[],text,jsonb)'::regprocedure,
        'app_private.hermes_invoice_edit_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure))<>7
    -- Hợp đồng, hoá đơn và điều chỉnh khoá KHÔNG CHỜ (guard đã giữ dòng công ty).
    OR (length(v_src)-length(replace(v_src,'FOR UPDATE NOWAIT','')))/length('FOR UPDATE NOWAIT')<>3
    OR has_function_privilege('anon','public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_invoice_edit_reason_v1(text,text,text)','EXECUTE')
    OR (SELECT count(*) FROM app_private.hermes_action_policies WHERE confirm='always' AND private_only AND (action,capability,crm_permission,action_class) IN (
      ('invoice.adjust','invoices.edit','invoices.edit','money'),('invoice.adjustment_check','invoices.approve','invoices.approve','irreversible'),
      ('invoice.cancel','invoices.cancel','invoices.cancel','money'),('invoice.restore','invoices.cancel','invoices.cancel','money')))<>4
    OR app_private.hermes_invoice_edit_reason_v1('55000','Hóa đơn có làm tròn hoặc cấn trừ credit đang hiệu lực; đảo giao dịch trong Lịch sử thanh toán trước khi điều chỉnh')
      <>'adjust_has_rounding_or_credit'
    OR app_private.hermes_invoice_edit_reason_v1('55000','Nội dung mới thấp hơn tiền đã phân bổ; đảo giao dịch trong Lịch sử thanh toán trước khi điều chỉnh')
      <>'adjust_below_collected'
    OR app_private.hermes_invoice_edit_reason_v1('P0001','Không thể huỷ hoá đơn ở trạng thái này (chỉ huỷ được hoá đơn nháp/đã duyệt và chưa thu đồng nào)')
      <>'cancel_has_payment'
    OR app_private.hermes_invoice_edit_reason_v1('PT409','REVENUE_CAP_REVIEW')<>'web_only'
    OR app_private.hermes_invoice_edit_reason_v1('23505','duplicate key value violates unique constraint "idx_invoices_unique_contract_billing"',
      'idx_invoices_unique_contract_billing')<>'restore_conflict'
    OR app_private.hermes_invoice_edit_reason_v1('P0001','[PROFIT_LOCKED] Tháng 10 của toà A đã chốt lợi nhuận')<>'period_locked'
    OR app_private.hermes_invoice_edit_reason_v1('XX999','lạ')<>'crm_refused' THEN
    RAISE EXCEPTION 'hermes_invoice_edit_catalog_invalid'; END IF;
END $check$;
COMMIT;
