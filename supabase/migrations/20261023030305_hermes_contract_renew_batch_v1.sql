-- Đợt 2 trang HỢP ĐỒNG — Mốc 6: gia hạn hàng loạt (23/10/2026; docs/plans/hermes-crm/HOP-DONG-THAO-TAC-GHI.md mục 3, 4.7; Q23 = a,
-- D-HĐ7). File MỚI, xếp sau 20261022074815 (không sửa file trước):
--   contract.renew_batch (khoá + quyền CRM contracts.renew như contract.renew; irreversible + 'always' ⇒ luôn xem trước, một lần đồng
--     ý cho cả lô). Chọn HĐ ACTIVE hết hạn trong endMonth, trong tập toà của khoá (∩ buildingName nếu có), sắp theo toà rồi phòng;
--     lô ≤ 20 HĐ, còn dư thì báo làm lô sau. LOẠI HĐ đang có báo trả (D-HĐ7: không quyết hộ giữ hay huỷ báo trả), liệt kê trong cảnh
--     báo. Mỗi dòng đúng luật contract.renew (Mốc 3): ngày mới = contract_renewal_end_date_v1(end_date, months), giữ giá + cọc, lý do
--     chung (thiếu ⇒ hỏi một câu; noReason ⇒ câu cố định D-HĐ5), không phát sinh phiếu / hoá đơn, cảnh báo HĐ vừa gia hạn 24 giờ.
--   Ghi: mỗi dòng một savepoint. Lỗi nghiệp vụ của dòng ⇒ dòng đó rejected kèm lý do, các dòng khác vẫn ghi. Lỗi tạm (40001 / 40P01 /
--     55P03 / PT409) ⇒ cả lô lùi, connector trả state_changed. Một biên nhận cho cả lô; phát lại theo requestId đứng TRƯỚC phép so
--     basis (bẫy Mốc 3). HĐ đã gia hạn rời khỏi endMonth nên lần chọn sau tự bỏ chúng.
--   Khoá: guard đã khoá công ty; dòng HĐ của lô lấy FOR UPDATE NOWAIT (soát 40P01 lượt 8: hàm web khoá dòng HĐ trước khoá công ty).
--   HĐ chọn dưới RLS người hỏi bằng hàm INVOKER MỚI public.hermes_contract_batch_lookup_v1 (chỉ id, cờ báo trả, số đếm; không dữ liệu
--     khách). Bước ghi lô là hàm DEFINER MỚI app_private.hermes_contract_batch_step_v1; bước ghi chung của trang KHÔNG đổi (md5 thân
--     20261022074815 ghim ở $requires$). Vỏ dựng lại từ thân 20261022074815 + nhánh lô (giải tên toà, tra lô, chuyển sang bước ghi lô).
-- Không đổi chữ ký, chủ, ACL của hàm có sẵn; không ghi dữ liệu ngoài một dòng chính sách.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE v_step text;
BEGIN
  -- Bước ghi chung phải là thân 20261022074815 (vỏ mới vẫn chuyển mọi thao tác khác sang nó; file này không thay nó nên chạy lại
  -- vẫn cùng md5).
  SELECT p.prosrc INTO v_step FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)');
  IF v_step IS NULL OR md5(v_step)<>'239f771b1a5de25c56c44fa059edbbdd' THEN RAISE EXCEPTION 'hermes_contract_batch_base_changed'; END IF;
  IF to_regprocedure('public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)') IS NULL
    OR position('hermes_contract_party_lookup_v1' IN pg_get_functiondef('public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure))=0
    OR to_regprocedure('public.hermes_contract_action_lookup_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('public.hermes_contract_party_lookup_v1(uuid,uuid,uuid[],text,jsonb)') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)') IS NULL
    OR to_regprocedure('public.renew_contract_with_notice_v1(uuid,uuid,timestamp with time zone,date,text,uuid,numeric,numeric,text,text)') IS NULL
    OR to_regprocedure('public.contract_renewal_end_date_v1(date,integer)') IS NULL
    OR to_regprocedure('app_private.hermes_contract_reason_v1(text,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_contract_date_label_v1(date,date)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_action_policies WHERE action='contract.renew' AND capability='contracts.renew'
      AND crm_permission='contracts.renew')
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='contracts.renew' AND mode='action') THEN
    RAISE EXCEPTION 'hermes_contract_batch_dependency_invalid'; END IF;
END $requires$;

-- 1. Chính sách: cùng khoá + quyền CRM với contract.renew (một khoá phục vụ nhiều thao tác phải cùng quyền CRM); luôn xem trước.
INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES
  ('contract.renew_batch','contracts.renew','contracts.renew','irreversible','always',true)
  ON CONFLICT(action) DO NOTHING;

-- 2. Chọn HĐ của lô dưới RLS người hỏi (INVOKER, STABLE, search_path=''): HĐ ACTIVE chưa kết thúc, end_date trong tháng p_end_month
--    (ngày đầu tháng), phòng thuộc tập toà guard trả cho khoá (∩ p_building_id nếu người dùng nêu toà). Sắp theo toà, phòng, id.
--    Trả 20 HĐ đầu KHÔNG có báo trả (eligible) + 10 HĐ đầu CÓ báo trả (excluded) + hai số đếm; chỉ id, không tên hay dữ liệu khách.
--    Bước ghi DEFINER đọc lại từng id với đủ điều kiện và khoá dòng.
CREATE OR REPLACE FUNCTION public.hermes_contract_batch_lookup_v1(p_organization_id uuid,p_building_ids uuid[],p_building_id uuid,p_end_month date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_eligible jsonb; v_excluded jsonb; v_eligible_total integer; v_excluded_total integer;
BEGIN
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL OR p_building_ids IS NULL
    OR p_end_month IS NULL OR extract(day FROM p_end_month)<>1 THEN
    RAISE EXCEPTION 'hermes_contract_lookup_denied' USING ERRCODE='42501'; END IF;
  WITH c AS (
    SELECT k.id,b.name AS bname,r.name AS rname,k.expected_move_out_date IS NOT NULL AS notice
    FROM public.contracts k JOIN public.rooms r ON r.id=k.room_id AND r.deleted_at IS NULL
      JOIN public.buildings b ON b.id=r.building_id AND b.deleted_at IS NULL
    WHERE k.organization_id=p_organization_id AND k.status='ACTIVE' AND k.actual_end_date IS NULL AND k.deleted_at IS NULL
      AND k.end_date>=p_end_month AND k.end_date<(p_end_month+interval '1 month')::date
      AND r.building_id=ANY(p_building_ids) AND (p_building_id IS NULL OR r.building_id=p_building_id)),
  o AS (SELECT c.id,c.notice,row_number() OVER (PARTITION BY c.notice ORDER BY c.bname,c.rname,c.id) AS n FROM c)
  SELECT COALESCE(jsonb_agg(o.id ORDER BY o.n) FILTER (WHERE NOT o.notice AND o.n<=20),'[]'::jsonb),
      COALESCE(jsonb_agg(o.id ORDER BY o.n) FILTER (WHERE o.notice AND o.n<=10),'[]'::jsonb),
      count(*) FILTER (WHERE NOT o.notice)::integer,count(*) FILTER (WHERE o.notice)::integer
    INTO v_eligible,v_excluded,v_eligible_total,v_excluded_total FROM o;
  RETURN jsonb_build_object('eligible',v_eligible,'eligibleTotal',v_eligible_total,'excluded',v_excluded,'excludedTotal',v_excluded_total);
END $fn$;

-- 3. Bước ghi lô (DEFINER). phase: preview / auto (đều chỉ trả bản xem trước: irreversible + always) | apply (lượt 2: basis tính lại
--    sau khoá công ty + khoá dòng NOWAIT, lệch ⇒ state_changed, không mở biên nhận).
CREATE OR REPLACE FUNCTION app_private.hermes_contract_batch_step_v1(p_binding jsonb,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb,p_lookup jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; v_org uuid; v_prev app_private.hermes_action_receipts; v_month date; v_months integer; v_note text; v_today date; v_tz text;
  v_building uuid; v_building_name text; v_ids uuid[]; v_excluded uuid[]; v_eligible_total integer; v_rows jsonb; v_skipped jsonb;
  v_basis text; v_warnings jsonb:='[]'::jsonb; v_text text; v_resolved jsonb; v_begin jsonb; v_outcome jsonb; v_done jsonb:='[]'::jsonb;
  v_ok integer:=0; v_failed integer:=0; v_constraint text; v_money bigint; v_reason text; v_first_reason text; v_line text; v_row jsonb;
  c public.contracts; c_after public.contracts;
BEGIN
  -- NULL không bao giờ lọt: kiểm IS NULL trước NOT IN.
  IF p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply') OR p_request_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_phase='apply' AND (p_resolved IS NULL OR jsonb_typeof(p_resolved)<>'object' OR p_expected_basis IS NULL)) THEN
    RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  ctx:=app_private.hermes_action_guard_v1(p_binding,'contract.renew_batch');
  v_org:=(ctx->>'organizationId')::uuid;
  -- Giao thức ghi chung: khoá công ty TRƯỚC mọi khoá dòng (guard đã khoá; gọi lại cho tường minh, cùng giao dịch nên không chờ).
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  -- Phát lại theo requestId TRƯỚC mọi phép tính lại: chính lô vừa ghi đã đổi các HĐ (và đưa chúng ra khỏi endMonth) nên basis tính
  -- lại sẽ lệch; không phát lại ở đây thì lần gọi lại nhận state_changed, mô hình xem trước lại với requestId mới.
  SELECT * INTO v_prev FROM app_private.hermes_action_receipts r WHERE r.organization_id=v_org AND r.user_id=auth.uid() AND r.request_id=p_request_id;
  IF FOUND AND v_prev.state IN ('applied','rejected') THEN
    IF v_prev.connection_id::text IS DISTINCT FROM ctx->>'connectionId' THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
    IF v_prev.action IS DISTINCT FROM 'contract.renew_batch' OR v_prev.input->'params' IS DISTINCT FROM p_params THEN
      RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    RETURN v_prev.result;
  END IF;
  -- Tham số: tháng hết hạn YYYY-MM, số tháng 1–24, lý do như contract.renew.
  IF COALESCE(p_params->>'endMonth','') !~ '^2[0-9]{3}-(0[1-9]|1[0-2])$' OR COALESCE(p_params->>'months','') !~ '^[0-9]{1,2}$'
    OR (p_params ? 'buildingName' AND jsonb_typeof(p_params->'buildingName') IS DISTINCT FROM 'string')
    OR (p_params ? 'noReason' AND COALESCE(p_params->>'noReason','') NOT IN ('true','false')) THEN
    RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
  v_months:=(p_params->>'months')::integer;
  IF v_months<1 OR v_months>24 THEN RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
  v_month:=((p_params->>'endMonth')||'-01')::date;
  v_today:=public.org_today_v1(v_org);
  v_tz:=COALESCE(app_private.org_timezone_v1(v_org),'Asia/Ho_Chi_Minh');
  -- Tháng hết hạn trong khoảng 12 tháng trước tới 24 tháng sau tháng hiện tại.
  IF v_month<(date_trunc('month',v_today)-interval '12 months')::date OR v_month>(date_trunc('month',v_today)+interval '24 months')::date THEN
    RETURN jsonb_build_object('kind','needs_input','reason','date_out_of_range'); END IF;
  -- D-HĐ5: không có lý do ⇒ hỏi một câu; người dùng nói không có ⇒ câu cố định (≥ 8 ký tự cho trigger lý do hoa hồng).
  v_note:=NULLIF(btrim(p_params->>'reason'),'');
  IF v_note IS NULL AND p_params->>'noReason'='true' THEN v_note:='Gia hạn theo yêu cầu qua Hermes, không nêu lý do.'; END IF;
  IF v_note IS NULL THEN RETURN jsonb_build_object('kind','needs_input','reason','renew_reason_ask'); END IF;
  IF char_length(v_note)<8 THEN RETURN jsonb_build_object('kind','needs_input','reason','reason_required'); END IF;
  IF char_length(v_note)>1000 THEN RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
  -- Toà (tuỳ chọn): lượt 1 do vỏ giải tên dưới RLS người hỏi; lượt 2 đưa lại id trong bản đã giải. Phải thuộc tập toà của khoá.
  IF p_phase='apply' THEN
    IF p_resolved ? 'buildingId' THEN
      IF COALESCE(p_resolved->>'buildingId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
      v_building:=(p_resolved->>'buildingId')::uuid;
    END IF;
  ELSIF p_params ? 'buildingName' THEN
    IF p_resolution IS NULL THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
    IF p_resolution->>'status'='unresolved' THEN
      RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field',p_resolution->'field','wanted',p_resolution->'wanted',
        'why',p_resolution->'why','candidates',p_resolution->'candidates','more',p_resolution->'more'); END IF;
    IF p_resolution->>'status' IS DISTINCT FROM 'resolved' OR p_resolution#>>'{building,id}' IS NULL THEN
      RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
    v_building:=(p_resolution#>>'{building,id}')::uuid;
  END IF;
  IF v_building IS NOT NULL AND (NOT COALESCE(v_building IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid),false)
      OR NOT EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=v_building AND b.organization_id=v_org AND b.deleted_at IS NULL)) THEN
    RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  SELECT b.name INTO v_building_name FROM public.buildings b WHERE b.id=v_building;
  -- HĐ do vỏ chọn dưới RLS người hỏi (hàm tra lô). Thiếu / sai khuôn ⇒ lỗi gọi.
  IF jsonb_typeof(p_lookup#>'{batch,eligible}') IS DISTINCT FROM 'array' OR jsonb_typeof(p_lookup#>'{batch,excluded}') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_lookup#>'{batch,eligible}')>20 OR jsonb_array_length(p_lookup#>'{batch,excluded}')>10 THEN
    RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  v_ids:=ARRAY(SELECT jsonb_array_elements_text(p_lookup#>'{batch,eligible}')::uuid);
  v_excluded:=ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p_lookup#>'{batch,excluded}') x ORDER BY 1);
  v_eligible_total:=COALESCE((p_lookup#>>'{batch,eligibleTotal}')::integer,0);
  -- Lượt có thể ghi: khoá mọi dòng HĐ của lô NOWAIT (theo id) trước khi đọc. Đang bị hàm ghi web giữ ⇒ 55P03 ⇒ cả lô lùi.
  IF p_phase<>'preview' THEN
    PERFORM 1 FROM public.contracts k WHERE k.id=ANY(v_ids) AND k.organization_id=v_org ORDER BY k.id FOR UPDATE NOWAIT;
  END IF;
  -- Đọc lại từng HĐ (DEFINER) với đủ điều kiện: cùng công ty, ACTIVE chưa kết thúc, KHÔNG báo trả, hết hạn trong tháng, phòng thuộc
  -- tập toà của khoá (∩ toà đã nêu). Dòng không còn đạt thì không vào lô.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('contractId',k.id,'updatedAt',k.updated_at,'endDate',k.end_date,
        'newEndDate',public.contract_renewal_end_date_v1(k.end_date,v_months),'buildingName',b.name,'roomName',r.name,
        'contractNumber',k.contract_number,'recent',EXISTS(SELECT 1 FROM public.contract_extensions e WHERE e.contract_id=k.id
          AND e.created_at>clock_timestamp()-interval '24 hours')) ORDER BY b.name,r.name,k.id),'[]'::jsonb)
    INTO v_rows
    FROM public.contracts k JOIN public.rooms r ON r.id=k.room_id AND r.deleted_at IS NULL
      JOIN public.buildings b ON b.id=r.building_id AND b.deleted_at IS NULL
    WHERE k.id=ANY(v_ids) AND k.organization_id=v_org AND k.status='ACTIVE' AND k.actual_end_date IS NULL AND k.deleted_at IS NULL
      AND k.expected_move_out_date IS NULL AND k.end_date>=v_month AND k.end_date<(v_month+interval '1 month')::date
      AND r.building_id IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid) AND (v_building IS NULL OR r.building_id=v_building);
  -- Ngày mới phải sau ngày cũ và trong 3 660 ngày (như contract.renew); hàm dùng chung luôn cho ngày sau với months ≥ 1.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) x WHERE (x->>'newEndDate')::date<=(x->>'endDate')::date
      OR (x->>'newEndDate')::date>(x->>'endDate')::date+3660) THEN
    RETURN jsonb_build_object('kind','needs_input','reason','date_out_of_range'); END IF;
  -- HĐ bị loại vì có báo trả (D-HĐ7): chỉ để nêu trong cảnh báo.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('buildingName',b.name,'roomName',r.name,'moveOut',k.expected_move_out_date) ORDER BY b.name,r.name,k.id),'[]'::jsonb)
    INTO v_skipped
    FROM public.contracts k JOIN public.rooms r ON r.id=k.room_id JOIN public.buildings b ON b.id=r.building_id
    WHERE k.id=ANY(v_excluded) AND k.organization_id=v_org AND k.expected_move_out_date IS NOT NULL
      AND r.building_id IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid);
  v_basis:=md5(jsonb_build_array('contract.renew_batch',v_month,v_months,v_building,
    (SELECT COALESCE(jsonb_agg(jsonb_build_array(x->'contractId',x->'updatedAt',x->'endDate') ORDER BY x->>'contractId'),'[]'::jsonb)
      FROM jsonb_array_elements(v_rows) x),to_jsonb(v_excluded))::text);
  IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
  IF jsonb_array_length(v_rows)=0 THEN
    RETURN CASE WHEN p_phase='apply' THEN jsonb_build_object('kind','rejected','reason','state_changed')
      ELSE jsonb_build_object('kind','needs_input','reason','renew_batch_empty') END; END IF;
  -- Cảnh báo (≤ 300 ký tự mỗi câu, connector nhận ≤ 10 câu).
  IF (p_lookup#>>'{batch,excludedTotal}')::integer>0 THEN
    v_warnings:=v_warnings||to_jsonb(left('Không gia hạn '||(p_lookup#>>'{batch,excludedTotal}')||' HĐ đang có báo trả (giữ hay huỷ báo trả phải quyết '||
      'từng HĐ bằng gia hạn lẻ): '||COALESCE((SELECT string_agg(x->>'buildingName'||' '||(x->>'roomName')||' (dọn đi '||to_char((x->>'moveOut')::date,'DD/MM/YYYY')||')',
      ', ') FROM jsonb_array_elements(v_skipped) x),'…')||CASE WHEN (p_lookup#>>'{batch,excludedTotal}')::integer>jsonb_array_length(v_skipped) THEN ', …' ELSE '' END||'.',300));
  END IF;
  IF v_eligible_total>jsonb_array_length(v_rows) THEN
    v_warnings:=v_warnings||to_jsonb('Còn '||(v_eligible_total-jsonb_array_length(v_rows))||' HĐ hết hạn tháng '||to_char(v_month,'MM/YYYY')||
      ' chưa vào lô này (tối đa 20 HĐ mỗi lô); ghi xong lô này rồi gọi lại để làm lô sau.');
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) x WHERE (x->>'recent')::boolean) THEN
    v_warnings:=v_warnings||to_jsonb(left('HĐ vừa được gia hạn trong 24 giờ qua (kiểm lại để không gia hạn chồng): '||
      (SELECT string_agg(x->>'buildingName'||' '||(x->>'roomName'),', ') FROM jsonb_array_elements(v_rows) x WHERE (x->>'recent')::boolean)||'.',300));
  END IF;
  v_text:=format('gia hạn %s HĐ hết hạn tháng %s%s thêm %s tháng: giữ nguyên giá thuê và cọc; lý do ghi vào từng HĐ: "%s". Không phát sinh hoá '||
    'đơn hay phiếu. Danh sách: %s.',jsonb_array_length(v_rows),to_char(v_month,'MM/YYYY'),
    CASE WHEN v_building_name IS NOT NULL THEN ' ở toà '||v_building_name ELSE ' (mọi toà trong phạm vi)' END,v_months,v_note,
    (SELECT string_agg(format('%s %s (HĐ %s) %s → %s',x->>'buildingName',x->>'roomName',COALESCE(x->>'contractNumber','chưa có số'),
      to_char((x->>'endDate')::date,'DD/MM/YYYY'),to_char((x->>'newEndDate')::date,'DD/MM/YYYY')),'; ' ORDER BY o)
      FROM jsonb_array_elements(v_rows) WITH ORDINALITY e(x,o)));
  v_resolved:=jsonb_strip_nulls(jsonb_build_object('buildingId',v_building,'buildingName',v_building_name,'count',jsonb_array_length(v_rows)));
  -- Lượt 1 (preview / auto): luôn xem trước, một lần đồng ý cho cả lô.
  IF p_phase<>'apply' THEN
    RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required','warnings',v_warnings,
      'preview',jsonb_strip_nulls(jsonb_build_object('text','Sẽ '||v_text,'buildingName',v_building_name,'endMonth',p_params->>'endMonth',
        'months',v_months,'count',jsonb_array_length(v_rows),'more',greatest(v_eligible_total-jsonb_array_length(v_rows),0),
        'rows',(SELECT jsonb_agg(jsonb_build_object('buildingName',x->'buildingName','roomName',x->'roomName','contractNumber',x->'contractNumber',
          'endDate',jsonb_build_object('from',x->'endDate','to',x->'newEndDate')) ORDER BY o) FROM jsonb_array_elements(v_rows) WITH ORDINALITY e(x,o)))));
  END IF;
  v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,'contract.renew_batch',p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
  IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
  IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
  IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
  -- Mỗi dòng một savepoint (khối BEGIN … EXCEPTION). Khoá idempotency của hàm web riêng từng HĐ, suy từ requestId của lô.
  FOR v_row IN SELECT x FROM jsonb_array_elements(v_rows) WITH ORDINALITY e(x,o) ORDER BY o LOOP
    BEGIN
      SELECT * INTO c FROM public.contracts WHERE id=(v_row->>'contractId')::uuid;
      SELECT (SELECT count(*) FROM public.income_expenses ie WHERE ie.contract_id=c.id)+(SELECT count(*) FROM public.invoices iv WHERE iv.contract_id=c.id) INTO v_money;
      PERFORM public.renew_contract_with_notice_v1(v_org,c.id,c.updated_at,(v_row->>'newEndDate')::date,'KEEP',
        md5('renew_batch:'||p_request_id::text||':'||c.id::text)::uuid,NULL,NULL,v_note,v_note);
      SELECT * INTO c_after FROM public.contracts WHERE id=c.id;
      -- Hậu điều kiện như contract.renew: đúng ngày mới, vẫn hiệu lực, GIỮ NGUYÊN giá + cọc, không có báo trả, không phiếu/hoá đơn mới.
      IF c_after.end_date IS DISTINCT FROM (v_row->>'newEndDate')::date OR c_after.status IS DISTINCT FROM 'ACTIVE'
        OR c_after.rent_price IS DISTINCT FROM c.rent_price OR c_after.total_deposit IS DISTINCT FROM c.total_deposit
        OR c_after.expected_move_out_date IS NOT NULL
        OR (SELECT count(*) FROM public.income_expenses ie WHERE ie.contract_id=c.id)+(SELECT count(*) FROM public.invoices iv WHERE iv.contract_id=c.id)<>v_money
        THEN RAISE EXCEPTION 'hermes_contract_postcondition' USING ERRCODE='P0001'; END IF;
      v_ok:=v_ok+1;
      v_done:=v_done||jsonb_build_array(jsonb_build_object('buildingName',v_row->'buildingName','roomName',v_row->'roomName',
        'contractNumber',v_row->'contractNumber','endDate',jsonb_build_object('from',v_row->'endDate','to',v_row->'newEndDate'),'renewed',true));
    EXCEPTION WHEN OTHERS THEN
      -- Lỗi tạm KHÔNG chốt: RAISE lại ⇒ cả lô lùi (kể cả biên nhận vừa mở); cùng requestId gọi lại được.
      IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
      GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
      v_reason:=app_private.hermes_contract_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,''));
      v_failed:=v_failed+1; v_first_reason:=COALESCE(v_first_reason,v_reason);
      v_done:=v_done||jsonb_build_array(jsonb_build_object('buildingName',v_row->'buildingName','roomName',v_row->'roomName',
        'contractNumber',v_row->'contractNumber','endDate',jsonb_build_object('from',v_row->'endDate','to',v_row->'newEndDate'),'renewed',false,'reason',v_reason));
    END;
  END LOOP;
  IF v_ok=0 THEN
    -- Không dòng nào ghi được: cả lô là một lần từ chối (lý do của dòng đầu), chốt biên nhận.
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,'contract.renew_batch',p_request_id,jsonb_build_object('kind','rejected','reason',v_first_reason));
  END IF;
  SELECT string_agg(x->>'buildingName'||' '||(x->>'roomName')||' ('||(x->>'reason')||')',', ') INTO v_line
    FROM jsonb_array_elements(v_done) x WHERE NOT (x->>'renewed')::boolean;
  v_outcome:=jsonb_build_object('kind','applied','link','/contracts','result',jsonb_strip_nulls(jsonb_build_object(
    'text',format('Đã gia hạn %s/%s HĐ hết hạn tháng %s%s thêm %s tháng (giữ nguyên giá thuê và cọc; không phát sinh hoá đơn hay phiếu).%s',
      v_ok,v_ok+v_failed,to_char(v_month,'MM/YYYY'),CASE WHEN v_building_name IS NOT NULL THEN ' ở toà '||v_building_name ELSE '' END,v_months,
      CASE WHEN v_failed>0 THEN ' Không gia hạn được: '||v_line||'; xem trên web.' ELSE '' END),
    'endMonth',p_params->>'endMonth','months',v_months,'renewed',v_ok,'failed',v_failed,'more',greatest(v_eligible_total-jsonb_array_length(v_rows),0),
    'buildingName',v_building_name,'rows',v_done)));
  RETURN app_private.hermes_action_receipt_finish_v1(p_binding,'contract.renew_batch',p_request_id,v_outcome);
END $fn$;

ALTER FUNCTION public.hermes_contract_batch_lookup_v1(uuid,uuid[],uuid,date) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_contract_batch_step_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_contract_batch_lookup_v1(uuid,uuid[],uuid,date) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_contract_batch_step_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_contract_batch_lookup_v1(uuid,uuid[],uuid,date) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_contract_batch_step_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb,jsonb) TO authenticated;

-- 4. Vỏ public: thân 20261022074815 + nhánh lô (gắn OID hàm tra lô và bước ghi lô lúc tạo). Lô: lượt 1 giải tên toà (nếu có) dưới
--    RLS người hỏi; mọi lượt tra lô trong tập toà guard trả (lượt 2 theo toà trong bản đã giải); rồi chuyển sang bước ghi lô. Thao tác
--    khác giữ đúng đường cũ. Câu lệnh ghim băm ở scripts/hermes-task-function-contract.mjs.
CREATE OR REPLACE FUNCTION public.hermes_contract_action_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb DEFAULT NULL,p_expected_basis text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
  WITH g AS MATERIALIZED (SELECT app_private.hermes_action_guard_v1(p_binding,p_action) AS ctx),
  r AS MATERIALIZED (SELECT g.ctx,CASE WHEN p_phase IN ('preview','auto') AND jsonb_typeof(p_params)='object' AND p_params ? 'roomName' THEN
      public.hermes_write_name_resolve_v1((g.ctx->>'organizationId')::uuid,ARRAY(SELECT jsonb_array_elements_text(g.ctx->'buildingIds')::uuid),
        jsonb_strip_nulls(jsonb_build_object('building',p_params->>'buildingName','room',p_params->>'roomName')))
    WHEN p_phase IN ('preview','auto') AND p_action='contract.renew_batch' AND jsonb_typeof(p_params)='object'
      AND jsonb_typeof(p_params->'buildingName')='string' THEN
      public.hermes_write_name_resolve_v1((g.ctx->>'organizationId')::uuid,ARRAY(SELECT jsonb_array_elements_text(g.ctx->'buildingIds')::uuid),
        jsonb_build_object('building',p_params->>'buildingName')) END AS resolution FROM g),
  l AS MATERIALIZED (SELECT r.resolution,CASE
    WHEN p_action='contract.renew_batch' THEN CASE WHEN jsonb_typeof(p_params)='object' AND p_params->>'endMonth' ~ '^2[0-9]{3}-(0[1-9]|1[0-2])$'
        AND (r.resolution IS NULL OR r.resolution->>'status'='resolved') THEN jsonb_build_object('batch',
      public.hermes_contract_batch_lookup_v1((r.ctx->>'organizationId')::uuid,ARRAY(SELECT jsonb_array_elements_text(r.ctx->'buildingIds')::uuid),
        CASE WHEN p_phase='apply' THEN CASE WHEN jsonb_typeof(p_resolved)='object'
            AND p_resolved->>'buildingId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (p_resolved->>'buildingId')::uuid END
          ELSE (r.resolution#>>'{building,id}')::uuid END,
        ((p_params->>'endMonth')||'-01')::date)) END
    WHEN r.resolution->>'status'='resolved' AND r.resolution#>>'{room,id}' IS NOT NULL THEN
      public.hermes_contract_action_lookup_v1((r.ctx->>'organizationId')::uuid,(r.resolution#>>'{room,id}')::uuid)
      ||CASE WHEN p_action IN ('contract.occupant_add','contract.occupant_remove','contract.draft') THEN jsonb_build_object('party',
        public.hermes_contract_party_lookup_v1((r.ctx->>'organizationId')::uuid,(r.resolution#>>'{room,id}')::uuid,
          ARRAY(SELECT jsonb_array_elements_text(r.ctx->'buildingIds')::uuid),p_action,p_params))
        ELSE '{}'::jsonb END
    WHEN p_phase='apply' AND p_action IN ('contract.occupant_add','contract.occupant_remove','contract.draft') AND jsonb_typeof(p_resolved)='object'
      AND p_resolved ? 'customerId' AND p_resolved ? 'roomId' THEN jsonb_build_object('party',
        public.hermes_contract_party_lookup_v1((r.ctx->>'organizationId')::uuid,(p_resolved->>'roomId')::uuid,
          ARRAY(SELECT jsonb_array_elements_text(r.ctx->'buildingIds')::uuid),p_action,jsonb_build_object('customerId',p_resolved->'customerId')))
    END AS lookup FROM r)
  SELECT CASE WHEN p_action='contract.renew_batch' THEN
      app_private.hermes_contract_batch_step_v1(p_binding,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,l.resolution,l.lookup)
    ELSE app_private.hermes_contract_action_step_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,l.resolution,l.lookup) END
  FROM l;
END;

ALTER FUNCTION public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;

DO $check$
DECLARE v_lookup pg_catalog.pg_proc; v_step pg_catalog.pg_proc;
BEGIN
  SELECT * INTO v_lookup FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('public.hermes_contract_batch_lookup_v1(uuid,uuid[],uuid,date)');
  SELECT * INTO v_step FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('app_private.hermes_contract_batch_step_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb,jsonb)');
  IF (SELECT count(*) FROM app_private.hermes_action_policies WHERE action LIKE 'contract.%')<>10
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_action_policies WHERE (action,capability,crm_permission,action_class,confirm,private_only)=
      ('contract.renew_batch','contracts.renew','contracts.renew','irreversible','always',true))
    OR v_lookup.oid IS NULL OR v_lookup.prosecdef OR replace(COALESCE(array_to_string(v_lookup.proconfig,','),''),'"','')<>'search_path='
    OR v_step.oid IS NULL OR NOT v_step.prosecdef
    OR position('hermes_contract_batch_step_v1' IN pg_get_functiondef('public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure))=0
    OR position('hermes_contract_batch_lookup_v1' IN pg_get_functiondef('public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure))=0
    OR position('hermes_contract_party_lookup_v1' IN pg_get_functiondef('public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure))=0
    OR NOT has_function_privilege('authenticated','public.hermes_contract_batch_lookup_v1(uuid,uuid[],uuid,date)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_contract_batch_lookup_v1(uuid,uuid[],uuid,date)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_contract_batch_check_failed'; END IF;
END $check$;
COMMIT;
