-- Hermes trang Hợp đồng, lượt 12 — sửa theo nghiệm thu lượt cuối C3 trên TEST (24/10): ghi nhận trả phòng LẦN HAI cho phòng đã trả và
-- đã có khách mới. Tra cứu của trang lấy HĐ HIỆN HÀNH của phòng (HĐ mới) ⇒ ngày trả của HĐ cũ rơi trước ngày bắt đầu HĐ mới và bước ghi trả
-- needs_input date_out_of_range ("ngày không hợp lệ") ⇒ bot hỏi lại ngày như gõ sai. Sửa nhánh contract.return của bước ghi: ngày trả
-- trước ngày bắt đầu HĐ hiện hành ⇒ rejected room_has_new_contract (lý do riêng: phòng đã có HĐ mới, HĐ trước đã ghi nhận trả / thanh lý ⇒
-- không ghi trả lần hai) + link /contracts/<HĐ trước của phòng> (không có ⇒ HĐ hiện hành), kiểm TRƯỚC mọi kiểm khoảng ngày. Mọi nhánh
-- khác, basis, biên nhận, khoá NOWAIT, luật xác nhận giữ nguyên.
-- Dựng từ thân 20261024040002 (C2; TEST đang chạy, md5 bd6fc1aa08bda769b3f79ff622af7e0d). Production chưa có C2 (đang chạy thân 20261022074815, md5
-- 239f771b1a5de25c56c44fa059edbbdd) ⇒ $requires$ nhận cả hai, áp sau 040002 theo thứ tự tên; thân của file này là thân 040002 + đúng khối trên.
-- Connector: lý do mới room_has_new_contract (action-reasons + host-ownership) PHẢI lên TRƯỚC file này — connector cũ đổi lý do lạ thành
-- crm_refused (không hỏng, nhưng mất câu riêng). Không đổi chữ ký, chủ, ACL.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)') IS NULL
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure) NOT IN ('bd6fc1aa08bda769b3f79ff622af7e0d','239f771b1a5de25c56c44fa059edbbdd','440f22e8975cb0afc7208f4707187f7d')
    OR to_regprocedure('app_private.hermes_contract_date_label_v1(date,date)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_action_policies WHERE action='contract.return') THEN
    RAISE EXCEPTION 'hermes_contract_return_twice_dependency_invalid'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION app_private.hermes_contract_action_step_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb,p_lookup jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; v_org uuid; v_resolved jsonb; v_today date; v_tz text; c public.contracts; l public.room_sale_locks;
  v_basis text; v_date date; v_hours integer; v_note text; v_place text; v_text text; v_warnings jsonb:='[]'::jsonb;
  v_begin jsonb; v_result jsonb; v_outcome jsonb; v_constraint text; v_notice boolean; v_contract boolean;
  v_new_end date; v_months integer; v_choice text; v_money bigint; v_dup text; c_after public.contracts; v_prev app_private.hermes_action_receipts;
  v_kind text; v_money_sum numeric; v_unpaid jsonb; v_case public.contract_exit_cases; v_room_status text;
  v_customer uuid; v_members jsonb; v_desired jsonb; v_after jsonb; v_need_confirm boolean:=false; v_start date; v_end date;
  v_rent numeric; v_deposit numeric; v_payload jsonb; v_draft_id uuid; v_last_draft public.contract_drafts; v_party boolean;
  v_phone text; v_params jsonb;
BEGIN
  -- NULL không bao giờ lọt: NOT IN với NULL cho NULL (không RAISE), nên mọi tham số bắt buộc kiểm IS NULL trước.
  IF p_action IS NULL OR p_action NOT IN ('contract.notice_set','contract.notice_cancel','contract.room_lock','contract.room_unlock','contract.renew',
    'contract.return','contract.occupant_add','contract.occupant_remove','contract.draft')
    OR p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply') OR p_request_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_phase='apply' AND (p_resolved IS NULL OR jsonb_typeof(p_resolved)<>'object' OR p_expected_basis IS NULL)) THEN
    RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  ctx:=app_private.hermes_action_guard_v1(p_binding,p_action);
  v_org:=(ctx->>'organizationId')::uuid;
  -- Giao thức ghi chung: khoá tổ chức TRƯỚC mọi khoá dòng (hàm ghi web cũng gọi lock_org_for_decision_v1 rồi mới khoá dòng HĐ /
  -- khoá tạm). Guard đã khoá qua hermes_private_command_connection_v1; gọi lại ở đây cho tường minh, không dựa vào nội tình guard
  -- (cùng giao dịch nên không chờ). Kiểm biên nhận ngay dưới chạy SAU khoá này: lời gọi cùng requestId đang chờ sẽ thấy biên nhận
  -- lời trước vừa chốt (review #270 mục 1–2).
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  v_notice:=p_action IN ('contract.notice_set','contract.notice_cancel');
  v_contract:=v_notice OR p_action IN ('contract.renew','contract.return','contract.occupant_add','contract.occupant_remove');
  -- Mốc 5: thao tác có khách (tra dưới RLS người hỏi ở vỏ); nháp chỉ khi người dùng nêu khách.
  v_party:=p_action IN ('contract.occupant_add','contract.occupant_remove')
    OR (p_action='contract.draft' AND (p_params ? 'customerPhone' OR p_params ? 'customerName'));
  -- Biên nhận không giữ SĐT đầy đủ (review #277 mục 4): params lưu và so khi phát lại thay customerPhone bằng sha256 của
  -- (tổ chức, SĐT đã chuẩn hoá như hàm tra khách). Cùng SĐT ⇒ cùng băm nên phát lại / request_conflict vẫn đúng. Băm chỉ để biên
  -- nhận không chứa SĐT dạng chữ; SĐT có ~10^9 giá trị nên ai đọc được bảng biên nhận (app_private, chỉ chủ hàm) vẫn dò được, như
  -- đọc thẳng customers.phone.
  v_params:=p_params;
  IF p_params ? 'customerPhone' THEN
    v_phone:=regexp_replace(COALESCE(p_params->>'customerPhone',''),'[^0-9]','','g');
    IF v_phone ~ '^84[0-9]{9,10}$' THEN v_phone:='0'||substr(v_phone,3); END IF;
    v_params:=(p_params-'customerPhone')||jsonb_build_object('customerPhoneSha256',encode(sha256(convert_to(v_org::text||':'||v_phone,'UTF8')),'hex'));
  END IF;
  -- Phát lại theo requestId TRƯỚC mọi phép tính lại (thiết kế nền chung mục 3.1): chính lần ghi trước đã đổi HĐ nên basis tính
  -- lại sẽ lệch; không phát lại ở đây thì lần gọi lại nhận state_changed, mô hình xem trước lại và có thể ghi chồng. Biên nhận đã
  -- chốt cùng thao tác + cùng params ⇒ trả y nguyên; khác ⇒ request_conflict; kết nối khác ⇒ PT409 (như receipt_begin). Biên nhận
  -- 'started' (giao dịch khác đang ghi) để receipt_begin xử lý.
  SELECT * INTO v_prev FROM app_private.hermes_action_receipts r WHERE r.organization_id=v_org AND r.user_id=auth.uid() AND r.request_id=p_request_id;
  IF FOUND AND v_prev.state IN ('applied','rejected') THEN
    IF v_prev.connection_id::text IS DISTINCT FROM ctx->>'connectionId' THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
    IF v_prev.action IS DISTINCT FROM p_action OR v_prev.input->'params' IS DISTINCT FROM v_params THEN
      RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    RETURN v_prev.result;
  END IF;
  IF p_phase='apply' THEN
    v_resolved:=p_resolved;
  ELSIF p_resolution IS NULL THEN
    -- Mọi thao tác của trang nêu phòng; vỏ chỉ không giải khi params thiếu roomName (connector đã chặn).
    RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023';
  ELSIF p_resolution->>'status'='unresolved' THEN
    RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field',p_resolution->'field','wanted',p_resolution->'wanted',
      'why',p_resolution->'why','candidates',p_resolution->'candidates','more',p_resolution->'more');
  ELSIF p_resolution->>'status'='resolved' AND p_resolution#>>'{room,id}' IS NOT NULL THEN
    v_resolved:=jsonb_strip_nulls(jsonb_build_object('buildingId',COALESCE(p_resolution#>'{building,id}',p_resolution#>'{room,buildingId}'),
      'roomId',p_resolution#>'{room,id}','roomName',p_resolution#>'{room,name}',
      'contractId',CASE WHEN v_contract THEN p_lookup->'contractId' END,'representativeName',CASE WHEN v_contract THEN p_lookup->'representativeName' END));
    v_resolved:=v_resolved||jsonb_strip_nulls(jsonb_build_object('buildingName',(SELECT b.name FROM public.buildings b WHERE b.id=(v_resolved->>'buildingId')::uuid)));
    -- Mốc 5: khách do tra cứu dưới RLS giải ở vỏ. Chưa giải ⇒ hỏi lại như tên toà/phòng; bớt người ở mà không thấy trong HĐ ⇒
    -- occupant_not_on_contract. Không nêu khách cho thao tác người ở ⇒ thiếu tham số. Phòng không có HĐ hiện hành ⇒ để nhánh HĐ trả
    -- room_has_no_active_contract / already_returned trước.
    IF v_party AND NOT (p_action IN ('contract.occupant_add','contract.occupant_remove') AND p_lookup->>'contractId' IS NULL) THEN
      IF p_lookup#>>'{party,customer,status}'='resolved' THEN
        v_resolved:=v_resolved||jsonb_strip_nulls(jsonb_build_object('customerId',p_lookup#>'{party,customer,id}','customerName',p_lookup#>'{party,customer,name}'));
      ELSIF p_lookup#>>'{party,customer,status}'='unresolved' THEN
        IF p_action='contract.occupant_remove' AND p_lookup#>>'{party,customer,why}'='not_visible' THEN
          RETURN jsonb_build_object('kind','needs_input','reason','occupant_not_on_contract'); END IF;
        RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field','customer','wanted',p_lookup#>'{party,customer,wanted}',
          'why',p_lookup#>'{party,customer,why}','candidates',p_lookup#>'{party,customer,candidates}','more',p_lookup#>'{party,customer,more}');
      ELSE RETURN jsonb_build_object('kind','needs_input','reason','invalid_params');
      END IF;
    END IF;
  ELSE RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023';
  END IF;
  -- Bản đã giải (lượt 1 hay đưa lại ở lượt 2) phải nằm trong phạm vi hiện tại của khoá; phòng thuộc đúng toà, đúng công ty.
  IF v_resolved->>'buildingId' IS NULL OR v_resolved->>'roomId' IS NULL
    OR NOT COALESCE((v_resolved->>'buildingId')::uuid IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid),false)
    OR NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=(v_resolved->>'roomId')::uuid AND r.building_id=(v_resolved->>'buildingId')::uuid
      AND r.organization_id=v_org AND r.deleted_at IS NULL) THEN
    RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  -- Mốc 5b (review #277 mục 2–3): khách đã chọn phải còn trong phạm vi ở CẢ HAI lượt. Lượt 2 vỏ tra lại đúng customerId dưới RLS
  -- người hỏi (p_lookup.party): không còn thấy / ra khách khác ⇒ state_changed. Rồi kiểm dứt khoát (DEFINER, thấy mọi HĐ) cùng
  -- luật phạm vi với hàm tra khách: có HĐ ở toà của kết nối, hoặc không có HĐ nào ở toà ngoài phạm vi.
  IF v_party AND p_phase='apply' AND (NOT (v_resolved ? 'customerId') OR p_lookup#>>'{party,customer,status}' IS DISTINCT FROM 'resolved'
    OR p_lookup#>>'{party,customer,id}' IS DISTINCT FROM v_resolved->>'customerId') THEN
    RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
  IF v_party AND v_resolved ? 'customerId' AND NOT (
      EXISTS(SELECT 1 FROM public.contract_customers cc JOIN public.contracts k ON k.id=cc.contract_id AND k.organization_id=v_org AND k.deleted_at IS NULL
        JOIN public.rooms r ON r.id=k.room_id WHERE cc.customer_id=(v_resolved->>'customerId')::uuid
          AND r.building_id IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid))
      OR NOT EXISTS(SELECT 1 FROM public.contract_customers cc JOIN public.contracts k ON k.id=cc.contract_id AND k.organization_id=v_org AND k.deleted_at IS NULL
        JOIN public.rooms r ON r.id=k.room_id WHERE cc.customer_id=(v_resolved->>'customerId')::uuid
          AND r.building_id NOT IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid))) THEN
    RETURN CASE WHEN p_phase='apply' THEN jsonb_build_object('kind','rejected','reason','state_changed')
      ELSE jsonb_build_object('kind','needs_input','reason','name_unresolved','field','customer','wanted',CASE WHEN v_phone<>'' THEN 'SĐT …'||right(v_phone,3)
        ELSE COALESCE(NULLIF(btrim(p_params->>'customerName'),''),'khách đã nêu') END,'why','outside_scope','candidates','[]'::jsonb,'more',false) END;
  END IF;
  v_today:=public.org_today_v1(v_org);
  v_tz:=COALESCE(app_private.org_timezone_v1(v_org),'Asia/Ho_Chi_Minh');
  v_place:=format('phòng %s toà %s',v_resolved->>'roomName',v_resolved->>'buildingName');
  -- Chống vòng khoá 40P01 (soát 23/10, mẫu Hoá đơn #279). Bước ghi đã giữ khoá công ty (guard + dòng trên), còn nhiều hàm ghi web
  -- khoá dòng nghiệp vụ TRƯỚC rồi mới khoá công ty (đo production 23/10):
  --   - dòng HĐ: create_new_contract_extension, terminate_contract_move_out;
  --   - dòng phòng: create_contract_v2, sign_and_checkin_contract_draft_v1, lock_room_for_sale_v1, release_room_sale_lock_v1,
  --     giữ chỗ / chính sách bán / tin pass.
  -- Nếu bước ghi CHỜ đúng dòng đó thì thành vòng. Đổi thứ tự trong bước ghi không gỡ được vì khoá công ty đã nằm ở guard. Vì vậy ở
  -- lượt có thể ghi, các dòng sẽ phải chờ được lấy NOWAIT:
  --   - đang bị giữ ⇒ 55P03 ngay, cả giao dịch lùi, connector đổi thành state_changed;
  --   - lấy được ⇒ giao dịch web đến sau chờ bước ghi xong, không còn chiều ngược lại.
  -- Độ mạnh bằng mức cao nhất mà hàm ghi web phía sau sẽ xin (không nâng khoá giữa chừng):
  --   - khoá tạm / gỡ khoá / trả phòng: NO KEY UPDATE (lock_room_for_sale_v1, release_room_sale_lock_v1, trigger trạng thái phòng);
  --   - nháp: KEY SHARE (khoá ngoại khi chèn nháp).
  -- Không hàm web nào khoá khách / khoá tạm / tin pass / hồ sơ trả phòng trước công ty.
  IF p_phase<>'preview' AND p_action IN ('contract.room_lock','contract.room_unlock','contract.return') THEN
    PERFORM 1 FROM public.rooms r WHERE r.id=(v_resolved->>'roomId')::uuid FOR NO KEY UPDATE NOWAIT;
  ELSIF p_phase<>'preview' AND p_action='contract.draft' THEN
    PERFORM 1 FROM public.rooms r WHERE r.id=(v_resolved->>'roomId')::uuid FOR KEY SHARE NOWAIT;
  END IF;

  IF v_contract THEN
    IF v_resolved->>'contractId' IS NULL THEN
      -- Không có HĐ hiện hành thấy được: đã ghi trả phòng và đang chờ quyết toán, hay phòng trống.
      IF p_phase<>'apply' AND EXISTS(SELECT 1 FROM public.contract_exit_cases x JOIN public.contracts k ON k.id=x.contract_id
          WHERE x.organization_id=v_org AND k.room_id=(v_resolved->>'roomId')::uuid AND x.state='PENDING') THEN
        RETURN jsonb_build_object('kind','rejected','reason','already_returned'); END IF;
      RETURN CASE WHEN p_phase='apply' THEN jsonb_build_object('kind','rejected','reason','state_changed')
        ELSE jsonb_build_object('kind','needs_input','reason','room_has_no_active_contract') END;
    END IF;
    -- Lượt preview chỉ đọc: không khoá dòng. auto/apply có thể ghi: khoá dòng HĐ (sau khoá tổ chức ở trên), NOWAIT (xem trên).
    IF p_phase='preview' THEN
      SELECT * INTO c FROM public.contracts k WHERE k.id=(v_resolved->>'contractId')::uuid AND k.organization_id=v_org
        AND k.room_id=(v_resolved->>'roomId')::uuid;
    ELSE
      SELECT * INTO c FROM public.contracts k WHERE k.id=(v_resolved->>'contractId')::uuid AND k.organization_id=v_org
        AND k.room_id=(v_resolved->>'roomId')::uuid FOR UPDATE NOWAIT;
    END IF;
    IF NOT FOUND OR c.status IS DISTINCT FROM 'ACTIVE' OR c.actual_end_date IS NOT NULL OR c.deleted_at IS NOT NULL THEN
      RETURN CASE WHEN p_phase='apply' THEN jsonb_build_object('kind','rejected','reason','state_changed')
        ELSE jsonb_build_object('kind','needs_input','reason','room_has_no_active_contract') END; END IF;
    -- Người ở: danh sách thành viên đúng khuôn hàm web dựng (p_expected) + khách đã chọn vào basis; thao tác khác basis giữ nguyên.
    IF p_action IN ('contract.occupant_add','contract.occupant_remove') THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('customer_id',cc.customer_id,'is_representative',cc.is_representative,'notes',cc.notes)
          ORDER BY cc.customer_id),'[]'::jsonb) INTO v_members FROM public.contract_customers cc WHERE cc.contract_id=c.id;
    END IF;
    v_basis:=md5((jsonb_build_array(p_action,c.id,c.updated_at,c.expected_move_out_date,c.end_date,c.status,c.rent_price,c.total_deposit)
      ||CASE WHEN v_members IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v_members,v_resolved->'customerId') END)::text);
    IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
    v_place:=format('%s (HĐ %s%s)',v_place,COALESCE(c.contract_number,'chưa có số'),
      CASE WHEN v_resolved->>'representativeName' IS NOT NULL THEN ', khách '||(v_resolved->>'representativeName') ELSE '' END);
    IF p_action='contract.notice_set' THEN
      IF COALESCE(p_params->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
      BEGIN v_date:=(p_params->>'date')::date;
      EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END;
      -- D-HĐ8: ngày đã qua gần như luôn là nhầm sang "khách đã dọn đi" ⇒ hướng sang ghi nhận trả phòng.
      IF v_date<v_today THEN RETURN jsonb_build_object('kind','needs_input','reason','notice_date_past'); END IF;
      IF v_date<c.start_date THEN RETURN jsonb_build_object('kind','needs_input','reason','date_out_of_range'); END IF;
      IF v_date>c.end_date THEN v_warnings:=v_warnings||to_jsonb('Ngày dọn đi sau ngày hết hạn HĐ ('||to_char(c.end_date,'DD/MM/YYYY')||
        '); nhớ gia hạn HĐ hoặc ghi nhận trả phòng đúng ngày.'); END IF;
      v_note:=NULLIF(btrim(p_params->>'note'),'');
      v_text:=CASE WHEN c.expected_move_out_date IS NOT DISTINCT FROM v_date
        THEN format('Báo trả %s đã là %s; không đổi.',v_place,app_private.hermes_contract_date_label_v1(v_date,v_today))
        ELSE format('báo trả %s: ngày dự kiến dọn đi %s (trước đó: %s).',v_place,app_private.hermes_contract_date_label_v1(v_date,v_today),
          COALESCE(app_private.hermes_contract_date_label_v1(c.expected_move_out_date,v_today),'chưa báo')) END;
    ELSIF p_action='contract.renew' THEN
      -- Ngày mới: ĐÚNG MỘT trong số tháng (hàm dùng chung với web) hoặc ngày người dùng nói (phải sau ngày kết thúc hiện tại).
      IF (p_params ? 'months')=(p_params ? 'newEndDate') THEN RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
      IF p_params ? 'months' THEN
        v_months:=CASE WHEN COALESCE(p_params->>'months','') ~ '^[0-9]{1,2}$' THEN (p_params->>'months')::integer END;
        IF v_months IS NULL OR v_months<1 OR v_months>60 THEN RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
        v_new_end:=public.contract_renewal_end_date_v1(c.end_date,v_months);
      ELSE
        IF COALESCE(p_params->>'newEndDate','') !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
        BEGIN v_new_end:=(p_params->>'newEndDate')::date;
        EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END;
      END IF;
      IF v_new_end IS NULL OR v_new_end<=c.end_date OR v_new_end>c.end_date+3660 THEN
        RETURN jsonb_build_object('kind','needs_input','reason','date_out_of_range'); END IF;
      -- Q21: chỉ gia hạn giữ nguyên giá và cọc. Mô hình nhắc lại đúng giá/cọc hiện tại thì nhận; khác ⇒ chỉ đường web.
      IF (p_params ? 'newRentPrice' AND (COALESCE(p_params->>'newRentPrice','') !~ '^[0-9]{1,16}$'
            OR (p_params->>'newRentPrice')::numeric IS DISTINCT FROM round(COALESCE(c.rent_price,0))))
        OR (p_params ? 'newDeposit' AND (COALESCE(p_params->>'newDeposit','') !~ '^[0-9]{1,16}$'
            OR (p_params->>'newDeposit')::numeric IS DISTINCT FROM round(COALESCE(c.total_deposit,0)))) THEN
        RETURN jsonb_build_object('kind','rejected','reason','renew_price_change_web_only'); END IF;
      -- D-HĐ5: không có lý do ⇒ hỏi một câu; người dùng nói không có ⇒ câu cố định (≥ 8 ký tự cho trigger lý do hoa hồng).
      v_note:=NULLIF(btrim(p_params->>'reason'),'');
      IF v_note IS NULL AND p_params->>'noReason'='true' THEN v_note:='Gia hạn theo yêu cầu qua Hermes, không nêu lý do.'; END IF;
      IF v_note IS NULL THEN RETURN jsonb_build_object('kind','needs_input','reason','renew_reason_ask'); END IF;
      IF char_length(v_note)<8 THEN RETURN jsonb_build_object('kind','needs_input','reason','reason_required'); END IF;
      -- HĐ có báo trả: bắt buộc chọn giữ/huỷ (hàm web luôn đòi notice_choice; không báo trả ⇒ KEEP như web).
      IF c.expected_move_out_date IS NOT NULL THEN
        IF NOT (p_params ? 'keepMoveOutNotice') OR p_params->>'keepMoveOutNotice' NOT IN ('true','false') THEN
          RETURN jsonb_build_object('kind','needs_input','reason','notice_choice_required'); END IF;
        v_choice:=CASE WHEN p_params->>'keepMoveOutNotice'='true' THEN 'KEEP' ELSE 'CANCEL' END;
        IF v_choice='KEEP' THEN v_warnings:=v_warnings||to_jsonb('Báo trả '||to_char(c.expected_move_out_date,'DD/MM/YYYY')||
          ' vẫn GIỮ: khách vẫn dọn đi ngày đó dù HĐ gia hạn tới '||to_char(v_new_end,'DD/MM/YYYY')||'.'); END IF;
      ELSE v_choice:='KEEP';
      END IF;
      -- Cảnh báo trùng: HĐ vừa được gia hạn trong 24 giờ qua (mô hình gửi lại với requestId mới ⇒ gia hạn chồng).
      SELECT 'HĐ vừa được gia hạn lúc '||to_char(e.created_at AT TIME ZONE v_tz,'HH24:MI DD/MM')||' ('||COALESCE(to_char(e.old_end_date,'DD/MM/YYYY'),'?')||
          ' → '||COALESCE(to_char(e.new_end_date,'DD/MM/YYYY'),'?')||'); kiểm lại để không gia hạn chồng.' INTO v_dup
        FROM public.contract_extensions e WHERE e.contract_id=c.id AND e.created_at>clock_timestamp()-interval '24 hours' ORDER BY e.created_at DESC LIMIT 1;
      IF v_dup IS NOT NULL THEN v_warnings:=v_warnings||to_jsonb(v_dup); END IF;
      v_text:=format('gia hạn %s: ngày kết thúc %s → %s%s. Giá thuê giữ %sđ/tháng, cọc giữ %sđ. Báo trả: %s. Lý do ghi vào HĐ: "%s". Không phát sinh hoá đơn hay phiếu.',
        v_place,to_char(c.end_date,'DD/MM/YYYY'),app_private.hermes_contract_date_label_v1(v_new_end,v_today),
        CASE WHEN v_months IS NOT NULL THEN ' (+'||v_months||' tháng)' ELSE '' END,
        replace(to_char(round(COALESCE(c.rent_price,0)),'FM999,999,999,999,990'),',','.'),
        replace(to_char(round(COALESCE(c.total_deposit,0)),'FM999,999,999,999,990'),',','.'),
        CASE WHEN c.expected_move_out_date IS NULL THEN 'không có'
          WHEN v_choice='KEEP' THEN 'GIỮ ngày '||to_char(c.expected_move_out_date,'DD/MM/YYYY')
          ELSE 'HUỶ (trước đó dọn đi '||to_char(c.expected_move_out_date,'DD/MM/YYYY')||')' END,v_note);
    ELSIF p_action='contract.return' THEN
      -- Mốc 4 (Q20 = a, D-HĐ6): ghi nhận khách ĐÃ trả phòng, quyết toán sau (DEFERRED). Ngày tương lai ⇒ khách chưa dọn: hướng sang
      -- báo trả. Loại do máy chủ suy từ ngày (≥ ngày hết hạn ⇒ hết hạn, trước đó ⇒ trả sớm); bỏ cọc chỉ khi người dùng nói.
      IF COALESCE(p_params->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
      BEGIN v_date:=(p_params->>'date')::date;
      EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END;
      -- Lượt 12 (nghiệm thu C3 24/10): ngày trả TRƯỚC ngày bắt đầu HĐ hiện hành ⇒ phòng đã có HĐ mới; HĐ trước đã ghi nhận trả phòng
      -- (chờ quyết toán) hoặc đã thanh lý ⇒ KHÔNG ghi trả lần hai: rejected room_has_new_contract + link HĐ trước của phòng (không có ⇒ HĐ
      -- hiện hành). Kiểm TRƯỚC khoảng ngày — trước đây ra date_out_of_range nên bot hỏi lại ngày như thể gõ sai.
      IF v_date<c.start_date THEN
        RETURN jsonb_build_object('kind','rejected','reason','room_has_new_contract','link','/contracts/'||COALESCE((SELECT k.id FROM public.contracts k
          WHERE k.organization_id=v_org AND k.room_id=c.room_id AND k.id<>c.id AND k.deleted_at IS NULL AND k.start_date<=v_date
          ORDER BY k.start_date DESC,k.id LIMIT 1),c.id)::text);
      END IF;
      IF v_date>v_today THEN RETURN jsonb_build_object('kind','needs_input','reason','return_date_future'); END IF;
      v_note:=NULLIF(btrim(p_params->>'note'),'');
      IF v_note IS NULL OR char_length(v_note)<3 OR char_length(v_note)>1000
        OR (p_params ? 'forfeit' AND COALESCE(p_params->>'forfeit','') NOT IN ('true','false')) THEN
        RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
      v_kind:=CASE WHEN p_params->>'forfeit'='true' THEN 'FORFEIT' WHEN v_date>=c.end_date THEN 'NATURAL_EXPIRY' ELSE 'EARLY_RETURN' END;
      -- Đã có hồ sơ thanh lý (luồng cũ) hay hồ sơ trả phòng của HĐ ⇒ không ghi chồng (hàm web cũng từ chối, ở đây nói rõ lý do).
      IF EXISTS(SELECT 1 FROM public.contract_terminations t WHERE t.contract_id=c.id)
        OR EXISTS(SELECT 1 FROM public.contract_exit_cases x WHERE x.contract_id=c.id) THEN
        RETURN jsonb_build_object('kind','rejected','reason','already_returned'); END IF;
      -- Lượt 11 (nghiệm thu 24/10): ghi trả phòng KHÔNG lùi được ⇒ ngày trả luôn kèm THỨ (returnDateLabel, đầu câu xem trước) và cảnh
      -- báo rõ khi khác ngày báo trả hoặc đã qua hơn 7 ngày. Luật xác nhận không đổi (vẫn luôn xem trước rồi mới ghi).
      IF c.expected_move_out_date IS NOT NULL AND c.expected_move_out_date IS DISTINCT FROM v_date THEN
        v_warnings:=v_warnings||to_jsonb('NGÀY TRẢ KHÁC NGÀY BÁO TRẢ: báo trả '||app_private.hermes_contract_date_label_v1(c.expected_move_out_date,v_today)||
          ', ngày trả sẽ ghi '||app_private.hermes_contract_date_label_v1(v_date,v_today)||'. Hỏi lại người dùng ngày nào đúng trước khi đồng ý.'); END IF;
      IF v_date<v_today-7 THEN
        v_warnings:=v_warnings||to_jsonb('NGÀY TRẢ ĐÃ QUA '||(v_today-v_date)||' NGÀY: '||app_private.hermes_contract_date_label_v1(v_date,v_today)||
          '. Kiểm lại ngày với người dùng; ghi rồi không lùi được.'); END IF;
      IF v_kind='EARLY_RETURN' THEN
        v_warnings:=v_warnings||to_jsonb('Trả trước ngày hết hạn HĐ ('||to_char(c.end_date,'DD/MM/YYYY')||') ⇒ loại TRẢ SỚM; bỏ cọc chỉ khi '||
          'người dùng nói rõ (forfeit=true); đổi loại về sau làm trên web.'); END IF;
      v_unpaid:=CASE WHEN jsonb_typeof(p_lookup->'unpaidInvoices')='object' THEN p_lookup->'unpaidInvoices' END;
      v_text:=format('ghi nhận khách TRẢ PHÒNG %s vào NGÀY %s; loại: %s. Sau khi ghi: HĐ chuyển Đã thanh lý, phòng thành trống, KHÔNG lùi '||
        'được. Quyết toán (hoàn cọc, trừ tiền, chỉ số chốt) làm trên web. Cọc đã thu %sđ; hoá đơn chưa thu: %s; chỉ số điện nước khi '||
        'trả: chưa ghi. Nội dung thanh lý: "%s".',v_place,app_private.hermes_contract_date_label_v1(v_date,v_today),
        CASE v_kind WHEN 'NATURAL_EXPIRY' THEN 'hết hạn' WHEN 'EARLY_RETURN' THEN 'trả sớm' ELSE 'BỎ CỌC' END,
        replace(to_char(round(COALESCE(c.deposit_paid,0)),'FM999,999,999,999,990'),',','.'),
        CASE WHEN v_unpaid IS NULL THEN 'không xem được (cần quyền xem hoá đơn)' WHEN (v_unpaid->>'count')::integer=0 THEN 'không có'
          ELSE (v_unpaid->>'count')||' hoá đơn, '||replace(to_char(round((v_unpaid->>'amount')::numeric),'FM999,999,999,999,990'),',','.')||'đ' END,
        v_note);
    ELSIF p_action IN ('contract.occupant_add','contract.occupant_remove') THEN
      -- Mốc 5 (D-HĐ2): thêm / bớt người ở qua hàm web reconcile_contract_customers_v1, ghi thẳng. Người mới không là đại diện;
      -- không bỏ người đại diện qua bot (hàm web không chặn) ⇒ HĐ luôn giữ nguyên người đại diện đang có.
      v_customer:=(v_resolved->>'customerId')::uuid;
      IF v_customer IS NULL THEN RETURN CASE WHEN p_phase='apply' THEN jsonb_build_object('kind','rejected','reason','state_changed')
        ELSE jsonb_build_object('kind','needs_input','reason','invalid_params') END; END IF;
      IF p_action='contract.occupant_add' THEN
        IF NOT EXISTS(SELECT 1 FROM public.customers cu WHERE cu.id=v_customer AND cu.organization_id=v_org AND cu.deleted_at IS NULL) THEN
          RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_members) m WHERE m->>'customer_id'=v_customer::text) THEN
          v_desired:=v_members;
          v_text:=format('%s đã ở trong %s; không đổi.',v_resolved->>'customerName',v_place);
        ELSE
          SELECT jsonb_agg(x ORDER BY x->>'customer_id') INTO v_desired FROM jsonb_array_elements(v_members||jsonb_build_array(
            jsonb_build_object('customer_id',v_customer::text,'is_representative',false,'notes',NULL))) x;
          v_text:=format('thêm người ở %s vào %s (không phải người đại diện).',v_resolved->>'customerName',v_place);
        END IF;
      ELSE
        IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_members) m WHERE m->>'customer_id'=v_customer::text) THEN
          RETURN CASE WHEN p_phase='apply' THEN jsonb_build_object('kind','rejected','reason','state_changed')
            ELSE jsonb_build_object('kind','needs_input','reason','occupant_not_on_contract') END; END IF;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_members) m WHERE m->>'customer_id'=v_customer::text AND (m->>'is_representative')::boolean) THEN
          RETURN jsonb_build_object('kind','rejected','reason','cannot_remove_representative'); END IF;
        SELECT COALESCE(jsonb_agg(m ORDER BY m->>'customer_id'),'[]'::jsonb) INTO v_desired FROM jsonb_array_elements(v_members) m
          WHERE m->>'customer_id'<>v_customer::text;
        -- Ghi chú của người bị bớt mất theo dòng thành viên (thêm lại không khôi phục) ⇒ không còn "lùi được" trọn vẹn: có ghi chú thì
        -- nói rõ và máy chủ đòi xác nhận (review #277 mục 4).
        SELECT NULLIF(btrim(m->>'notes'),'') INTO v_note FROM jsonb_array_elements(v_members) m WHERE m->>'customer_id'=v_customer::text;
        IF v_note IS NOT NULL THEN
          v_need_confirm:=true;
          v_warnings:=v_warnings||to_jsonb('Ghi chú của '||(v_resolved->>'customerName')||' trên HĐ sẽ mất (thêm lại không khôi phục): "'||left(v_note,200)||'".');
        END IF;
        v_text:=format('bớt người ở %s khỏi %s%s.',v_resolved->>'customerName',v_place,
          CASE WHEN v_note IS NOT NULL THEN '; xoá cả ghi chú của người này trên HĐ ("'||left(v_note,200)||'")' ELSE '' END);
      END IF;
    ELSE
      IF c.expected_move_out_date IS NULL THEN RETURN jsonb_build_object('kind','rejected','reason','no_notice'); END IF;
      v_note:=NULLIF(btrim(p_params->>'reason'),'');
      IF v_note IS NULL OR char_length(v_note)<8 THEN RETURN jsonb_build_object('kind','needs_input','reason','reason_required'); END IF;
      v_text:=format('huỷ báo trả %s (trước đó: dọn đi %s); lý do: %s.',v_place,
        app_private.hermes_contract_date_label_v1(c.expected_move_out_date,v_today),v_note);
    END IF;
  ELSIF p_action='contract.draft' THEN
    -- Mốc 5 (Q22 = a, D-HĐ3): soạn NHÁP HĐ mới qua hàm web save_contract_draft; người ký và hoàn tất trên web (tab Nháp). Nháp không
    -- giữ phòng, không tạo tiền. Ngày kết thúc do người dùng nói (đo production 22/10: không có luật cộng tháng nào chiếm đa số).
    IF COALESCE(p_params->>'startDate','') !~ '^\d{4}-\d{2}-\d{2}$' OR COALESCE(p_params->>'endDate','') !~ '^\d{4}-\d{2}-\d{2}$'
      OR COALESCE(p_params->>'rentPrice','') !~ '^[0-9]{1,13}$' OR COALESCE(p_params->>'deposit','') !~ '^[0-9]{1,13}$'
      OR char_length(COALESCE(p_params->>'note',''))>500 THEN
      RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
    BEGIN v_start:=(p_params->>'startDate')::date; v_end:=(p_params->>'endDate')::date;
    EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END;
    v_rent:=(p_params->>'rentPrice')::numeric; v_deposit:=(p_params->>'deposit')::numeric; v_note:=NULLIF(btrim(p_params->>'note'),'');
    IF v_rent<1 THEN RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
    IF v_end<=v_start OR v_end>v_start+3660 OR v_start<v_today-366 OR v_start>v_today+366 THEN
      RETURN jsonb_build_object('kind','needs_input','reason','date_out_of_range'); END IF;
    -- HĐ còn hiệu lực của phòng (đọc DEFINER, không dữ liệu cá nhân) + nháp gần nhất còn sửa được của phòng. ACTIVE + EXTENDED như web
    -- coi là còn khách (20261010114500, giữ chỗ phòng); chỉ để cảnh báo nên rộng hơn thao tác người ở (review #277 mục 1).
    SELECT * INTO c FROM public.contracts k WHERE k.organization_id=v_org AND k.room_id=(v_resolved->>'roomId')::uuid AND k.status IN ('ACTIVE','EXTENDED')
      AND k.actual_end_date IS NULL AND k.deleted_at IS NULL ORDER BY k.end_date DESC NULLS LAST,k.id LIMIT 1;
    SELECT * INTO v_last_draft FROM public.contract_drafts d WHERE d.organization_id=v_org AND d.room_id=(v_resolved->>'roomId')::uuid
      AND d.status='EDITABLE' ORDER BY d.created_at DESC,d.id LIMIT 1;
    v_basis:=md5(jsonb_build_array(p_action,v_resolved->'roomId',c.id,c.updated_at,v_last_draft.id,v_last_draft.updated_at,v_resolved->'customerId')::text);
    IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
    -- Máy chủ đòi xác nhận (D-HĐ3): phòng còn HĐ phủ ngày bắt đầu, hoặc đã có nháp của phòng trong 24 giờ.
    IF c.id IS NOT NULL AND COALESCE(c.expected_move_out_date,c.end_date)>=v_start THEN
      v_need_confirm:=true;
      v_warnings:=v_warnings||to_jsonb('Phòng đang có HĐ '||COALESCE(c.contract_number,'chưa có số')||' tới '||
        to_char(COALESCE(c.expected_move_out_date,c.end_date),'DD/MM/YYYY')||CASE WHEN c.expected_move_out_date IS NOT NULL THEN ' (báo trả)' ELSE '' END||
        ', mà nháp bắt đầu '||to_char(v_start,'DD/MM/YYYY')||': kiểm lại trước khi ký.'); END IF;
    IF v_last_draft.id IS NOT NULL AND v_last_draft.created_at>clock_timestamp()-interval '24 hours' THEN
      v_need_confirm:=true;
      v_warnings:=v_warnings||to_jsonb('Phòng đã có nháp HĐ soạn lúc '||to_char(v_last_draft.created_at AT TIME ZONE v_tz,'HH24:MI DD/MM')||
        ' (chưa ký); kiểm lại để không soạn trùng.'); END IF;
    v_customer:=(v_resolved->>'customerId')::uuid;
    v_draft_id:=md5('draft:'||p_request_id::text)::uuid;
    -- Payload đúng allowlist của save_contract_draft; mặc định như form web (ngày ký = hôm nay, kỳ hằng tháng, giảm giá 0, ngày tính
    -- tiền trống = theo ngày bắt đầu). Dịch vụ: không tự chọn ⇒ lúc ký áp dịch vụ mặc định của toà như form web.
    v_payload:=jsonb_build_object('form',jsonb_build_object('room_id',v_resolved->>'roomId','signed_date',v_today::text,'start_date',v_start::text,
        'end_date',v_end::text,'rent_price',v_rent,'total_deposit',v_deposit,'payment_cycle','MONTHLY','start_billing_date','','end_billing_date','',
        'notes',COALESCE(v_note,''),'discount_months',0,'discount_amount_per_month',0),
      'customers',COALESCE((SELECT jsonb_build_array(jsonb_build_object('id',cu.id::text,'full_name',cu.full_name,'phone',cu.phone,'id_number',cu.id_number,
        'is_representative',true,'notes',NULL)) FROM public.customers cu WHERE cu.id=v_customer AND cu.organization_id=v_org AND cu.deleted_at IS NULL),'[]'::jsonb),
      'services','[]'::jsonb,'use_custom_services',false);
    IF v_customer IS NOT NULL AND jsonb_array_length(v_payload->'customers')=0 THEN
      RETURN CASE WHEN p_phase='apply' THEN jsonb_build_object('kind','rejected','reason','state_changed')
        ELSE jsonb_build_object('kind','needs_input','reason','invalid_params') END; END IF;
    v_text:=format('soạn NHÁP HĐ mới %s: bắt đầu %s, kết thúc %s, giá thuê %sđ/tháng, cọc %sđ, kỳ thanh toán hằng tháng; khách: %s. Nháp KHÔNG '||
      'giữ phòng, không tạo tiền; dịch vụ theo mặc định của toà khi ký. Mở nháp trên web (Hợp đồng → tab Nháp) để kiểm, xuất và ký.',
      v_place,app_private.hermes_contract_date_label_v1(v_start,v_today),to_char(v_end,'DD/MM/YYYY'),
      replace(to_char(v_rent,'FM999,999,999,999,990'),',','.'),replace(to_char(v_deposit,'FM999,999,999,999,990'),',','.'),
      COALESCE(v_resolved->>'customerName','chưa có (thêm trên web)'));
  ELSE
    -- Khoá tạm đang mở của phòng (chưa gỡ, chưa hết hạn). Hết hạn thì hàm web tự coi là đóng.
    IF p_phase='preview' THEN
      SELECT * INTO l FROM public.room_sale_locks k WHERE k.organization_id=v_org AND k.room_id=(v_resolved->>'roomId')::uuid
        AND k.released_at IS NULL AND k.expires_at>clock_timestamp() ORDER BY k.locked_at DESC, k.id LIMIT 1;
    ELSE
      SELECT * INTO l FROM public.room_sale_locks k WHERE k.organization_id=v_org AND k.room_id=(v_resolved->>'roomId')::uuid
        AND k.released_at IS NULL AND k.expires_at>clock_timestamp() ORDER BY k.locked_at DESC, k.id LIMIT 1 FOR UPDATE NOWAIT;
    END IF;
    v_basis:=md5(jsonb_build_array(p_action,v_resolved->'roomId',l.id)::text);
    IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
    IF p_action='contract.room_lock' THEN
      v_hours:=CASE WHEN COALESCE(p_params->>'hours','') ~ '^(6|12|24)$' THEN (p_params->>'hours')::integer END;
      IF v_hours IS NULL THEN RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
      v_note:=NULLIF(btrim(p_params->>'note'),'');
      v_text:=format('khoá tạm %s trong %s giờ (ẩn khỏi danh sách bán và link công khai; hết giờ tự mở).',v_place,v_hours);
    ELSE
      IF l.id IS NULL THEN RETURN jsonb_build_object('kind','rejected','reason','no_open_lock'); END IF;
      v_text:=format('gỡ khoá tạm %s (khoá tới %s %s).',v_place,to_char(l.expires_at AT TIME ZONE v_tz,'HH24:MI'),
        app_private.hermes_contract_date_label_v1((l.expires_at AT TIME ZONE v_tz)::date,v_today));
    END IF;
  END IF;

  -- Chỉ ghi khi lượt 2 (apply) hoặc auto với thao tác reversible + never; mọi giá trị khác (kể cả NULL) ⇒ xem trước.
  -- Mốc 5: máy chủ đòi xác nhận cho từng lần gọi (nháp trên phòng còn khách / trùng nháp 24 giờ) dù chính sách ghi thẳng.
  IF p_phase<>'apply' AND (v_need_confirm OR NOT (p_phase='auto' AND COALESCE(ctx->>'actionClass'='reversible' AND ctx->>'confirm'='never',false))) THEN
    RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required','warnings',v_warnings,
      'preview',jsonb_strip_nulls(jsonb_build_object('text','Sẽ '||v_text,'buildingName',v_resolved->'buildingName','roomName',v_resolved->'roomName',
        'contractNumber',CASE WHEN v_contract THEN to_jsonb(c.contract_number) END,'representativeName',v_resolved->'representativeName',
        'endDate',CASE WHEN p_action='contract.renew' THEN jsonb_build_object('from',c.end_date,'to',v_new_end) END,
        'rentPrice',CASE WHEN p_action='contract.renew' THEN to_jsonb(round(COALESCE(c.rent_price,0))::text) END,
        'totalDeposit',CASE WHEN p_action='contract.renew' THEN to_jsonb(round(COALESCE(c.total_deposit,0))::text) END,
        'moveOutNotice',CASE WHEN p_action='contract.renew' THEN to_jsonb(CASE WHEN c.expected_move_out_date IS NULL THEN 'none'
          WHEN v_choice='KEEP' THEN 'keep' ELSE 'cancel' END) END,
        'returnDate',CASE WHEN p_action='contract.return' THEN to_jsonb(v_date) END,
        'returnDateLabel',CASE WHEN p_action='contract.return' THEN to_jsonb(app_private.hermes_contract_date_label_v1(v_date,v_today)) END,'kind',CASE WHEN p_action='contract.return' THEN to_jsonb(v_kind) END,
        'depositPaid',CASE WHEN p_action='contract.return' THEN to_jsonb(round(COALESCE(c.deposit_paid,0))::text) END,
        'unpaidInvoices',CASE WHEN p_action='contract.return' THEN v_unpaid END,'customerName',CASE WHEN v_party THEN v_resolved->'customerName' END,
        'draft',CASE WHEN p_action='contract.draft' THEN jsonb_build_object('startDate',v_start,'endDate',v_end,'rentPrice',v_rent::text,
          'deposit',v_deposit::text,'paymentCycle','MONTHLY') END)));
  END IF;
  v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',v_params,'resolved',v_resolved));
  IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
  IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
  IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
  BEGIN
    IF p_action='contract.notice_set' THEN
      v_result:=public.set_contract_move_out_notice_v1(v_org,c.id,c.updated_at,v_date,v_note);
      -- Hậu điều kiện: đúng HĐ, đúng ngày, HĐ vẫn hiệu lực.
      IF v_result->>'contract_id' IS DISTINCT FROM c.id::text OR (v_result->>'expected_move_out_date')::date IS DISTINCT FROM v_date
        OR v_result->>'status' IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'hermes_contract_postcondition' USING ERRCODE='P0001'; END IF;
      v_outcome:=jsonb_build_object('kind','applied','link','/contracts/'||c.id,'result',jsonb_strip_nulls(jsonb_build_object(
        'text',CASE WHEN c.expected_move_out_date IS NOT DISTINCT FROM v_date THEN v_text ELSE 'Đã ghi '||v_text END,
        'buildingName',v_resolved->'buildingName','roomName',v_resolved->'roomName','contractNumber',c.contract_number,
        'representativeName',v_resolved->'representativeName','endDate',c.end_date,'changed',c.expected_move_out_date IS DISTINCT FROM v_date,
        'warnings',v_warnings))||jsonb_build_object('moveOutDate',jsonb_build_object('from',c.expected_move_out_date,'to',v_date)));
    ELSIF p_action='contract.notice_cancel' THEN
      v_result:=public.set_contract_move_out_notice_v1(v_org,c.id,c.updated_at,NULL,v_note);
      IF v_result->>'contract_id' IS DISTINCT FROM c.id::text OR v_result->>'expected_move_out_date' IS NOT NULL
        OR v_result->>'status' IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'hermes_contract_postcondition' USING ERRCODE='P0001'; END IF;
      v_outcome:=jsonb_build_object('kind','applied','link','/contracts/'||c.id,'result',jsonb_strip_nulls(jsonb_build_object(
        'text','Đã '||v_text,'buildingName',v_resolved->'buildingName','roomName',v_resolved->'roomName','contractNumber',c.contract_number,
        'representativeName',v_resolved->'representativeName','endDate',c.end_date,'changed',true))
        ||jsonb_build_object('moveOutDate',jsonb_build_object('from',c.expected_move_out_date,'to',NULL)));
    ELSIF p_action='contract.renew' THEN
      SELECT (SELECT count(*) FROM public.income_expenses ie WHERE ie.contract_id=c.id)+(SELECT count(*) FROM public.invoices iv WHERE iv.contract_id=c.id) INTO v_money;
      PERFORM public.renew_contract_with_notice_v1(v_org,c.id,c.updated_at,v_new_end,v_choice,p_request_id,NULL,NULL,v_note,v_note);
      SELECT * INTO c_after FROM public.contracts WHERE id=c.id;
      -- Hậu điều kiện: đúng ngày mới, HĐ vẫn hiệu lực, GIỮ NGUYÊN giá + cọc, báo trả đúng lựa chọn, không phát sinh phiếu/hoá đơn.
      IF c_after.end_date IS DISTINCT FROM v_new_end OR c_after.status IS DISTINCT FROM 'ACTIVE' OR c_after.rent_price IS DISTINCT FROM c.rent_price
        OR c_after.total_deposit IS DISTINCT FROM c.total_deposit
        OR (v_choice='CANCEL' AND c_after.expected_move_out_date IS NOT NULL)
        OR (v_choice='KEEP' AND c_after.expected_move_out_date IS DISTINCT FROM c.expected_move_out_date)
        OR (SELECT count(*) FROM public.income_expenses ie WHERE ie.contract_id=c.id)+(SELECT count(*) FROM public.invoices iv WHERE iv.contract_id=c.id)<>v_money
        THEN RAISE EXCEPTION 'hermes_contract_postcondition' USING ERRCODE='P0001'; END IF;
      v_outcome:=jsonb_build_object('kind','applied','link','/contracts/'||c.id,'result',jsonb_strip_nulls(jsonb_build_object(
        'text','Đã '||replace(v_text,' Không phát sinh hoá đơn hay phiếu.',''),'buildingName',v_resolved->'buildingName','roomName',v_resolved->'roomName',
        'contractNumber',c.contract_number,'representativeName',v_resolved->'representativeName','months',v_months,
        'rentPrice',round(COALESCE(c.rent_price,0))::text,'totalDeposit',round(COALESCE(c.total_deposit,0))::text,
        'moveOutNotice',CASE WHEN c.expected_move_out_date IS NULL THEN 'none' WHEN v_choice='KEEP' THEN 'kept' ELSE 'cancelled' END))
        ||jsonb_build_object('endDate',jsonb_build_object('from',c.end_date,'to',v_new_end)));
    ELSIF p_action='contract.return' THEN
      SELECT (SELECT count(*) FROM public.income_expenses ie WHERE ie.contract_id=c.id)+(SELECT count(*) FROM public.invoices iv WHERE iv.contract_id=c.id),
        COALESCE((SELECT sum(ie.total_amount) FROM public.income_expenses ie WHERE ie.contract_id=c.id),0)
          +COALESCE((SELECT sum(iv.total_amount) FROM public.invoices iv WHERE iv.contract_id=c.id),0) INTO v_money,v_money_sum;
      -- DEFERRED: hàm web chỉ đổi HĐ + mở hồ sơ chờ quyết toán, không gọi hàm tiền nào; khoá idempotency theo requestId.
      v_result:=public.confirm_contract_return_v1(v_org,c.id,c.updated_at,'hermes:'||p_request_id::text,v_date,v_kind,'DEFERRED',NULL,NULL,v_note);
      SELECT * INTO c_after FROM public.contracts WHERE id=c.id;
      SELECT * INTO v_case FROM public.contract_exit_cases x WHERE x.contract_id=c.id;
      -- Hậu điều kiện: HĐ TERMINATED đúng ngày; đúng MỘT hồ sơ PENDING DEFERRED đúng khoá + loại; không có hồ sơ thanh lý cũ; đếm
      -- và tổng phiếu thu chi + hoá đơn của HĐ KHÔNG đổi (lệch ⇒ lùi về savepoint, crm_refused).
      IF c_after.status IS DISTINCT FROM 'TERMINATED' OR c_after.actual_end_date IS DISTINCT FROM v_date
        OR v_case.id IS NULL OR v_case.state IS DISTINCT FROM 'PENDING' OR v_case.settlement_mode IS DISTINCT FROM 'DEFERRED'
        OR v_case.physical_idempotency_key IS DISTINCT FROM 'hermes:'||p_request_id::text OR v_case.initial_kind IS DISTINCT FROM v_kind
        OR (SELECT count(*) FROM public.contract_exit_cases x WHERE x.contract_id=c.id)<>1
        OR EXISTS(SELECT 1 FROM public.contract_terminations t WHERE t.contract_id=c.id)
        OR (SELECT count(*) FROM public.income_expenses ie WHERE ie.contract_id=c.id)+(SELECT count(*) FROM public.invoices iv WHERE iv.contract_id=c.id)<>v_money
        OR COALESCE((SELECT sum(ie.total_amount) FROM public.income_expenses ie WHERE ie.contract_id=c.id),0)
          +COALESCE((SELECT sum(iv.total_amount) FROM public.invoices iv WHERE iv.contract_id=c.id),0) IS DISTINCT FROM v_money_sum
        THEN RAISE EXCEPTION 'hermes_contract_postcondition' USING ERRCODE='P0001'; END IF;
      SELECT r.status::text INTO v_room_status FROM public.rooms r WHERE r.id=c.room_id;
      v_outcome:=jsonb_build_object('kind','applied','link','/contracts/'||c.id,'result',jsonb_strip_nulls(jsonb_build_object(
        'text','Đã ghi nhận khách trả phòng '||v_place||': ngày trả '||app_private.hermes_contract_date_label_v1(v_date,v_today)||', loại: '||
          CASE v_kind WHEN 'NATURAL_EXPIRY' THEN 'hết hạn' WHEN 'EARLY_RETURN' THEN 'trả sớm' ELSE 'bỏ cọc' END||'. HĐ đã chuyển Đã thanh lý'||
          CASE WHEN v_room_status='AVAILABLE' THEN ', phòng trống' ELSE '' END||'. Quyết toán (hoàn cọc, trừ tiền, chỉ số chốt) làm trên web.',
        'buildingName',v_resolved->'buildingName','roomName',v_resolved->'roomName','contractNumber',c.contract_number,
        'representativeName',v_resolved->'representativeName','returnDate',v_date,'kind',v_kind,'exitCaseId',v_case.id,'roomStatus',v_room_status,
        'nextStep','Quyết toán trên web: /contracts/'||c.id)));
    ELSIF p_action IN ('contract.occupant_add','contract.occupant_remove') THEN
      v_result:=public.reconcile_contract_customers_v1(v_org,c.id,v_members,v_desired);
      SELECT COALESCE(jsonb_agg(jsonb_build_object('customer_id',cc.customer_id,'is_representative',cc.is_representative,'notes',cc.notes)
          ORDER BY cc.customer_id),'[]'::jsonb) INTO v_after FROM public.contract_customers cc WHERE cc.contract_id=c.id;
      -- Hậu điều kiện: đúng danh sách mong muốn; người đại diện giữ nguyên, còn ít nhất một (bớt người ở không bao giờ bỏ đại diện).
      IF v_after IS DISTINCT FROM v_desired
        OR (SELECT COALESCE(jsonb_agg(m->>'customer_id' ORDER BY m->>'customer_id') FILTER (WHERE (m->>'is_representative')::boolean),'[]'::jsonb)
          FROM jsonb_array_elements(v_after) m) IS DISTINCT FROM (SELECT COALESCE(jsonb_agg(m->>'customer_id' ORDER BY m->>'customer_id')
          FILTER (WHERE (m->>'is_representative')::boolean),'[]'::jsonb) FROM jsonb_array_elements(v_members) m)
        THEN RAISE EXCEPTION 'hermes_contract_postcondition' USING ERRCODE='P0001'; END IF;
      v_outcome:=jsonb_build_object('kind','applied','link','/contracts/'||c.id,'result',jsonb_strip_nulls(jsonb_build_object(
        'text',CASE WHEN v_desired=v_members THEN v_text ELSE 'Đã '||v_text END||' HĐ có '||jsonb_array_length(v_after)||' người ở.',
        'buildingName',v_resolved->'buildingName','roomName',v_resolved->'roomName','contractNumber',c.contract_number,
        'customerName',v_resolved->'customerName','changed',v_desired IS DISTINCT FROM v_members,'occupantCount',jsonb_array_length(v_after))));
    ELSIF p_action='contract.draft' THEN
      SELECT count(*) INTO v_money FROM public.contracts k WHERE k.room_id=(v_resolved->>'roomId')::uuid AND k.deleted_at IS NULL;
      SELECT r.status::text INTO v_room_status FROM public.rooms r WHERE r.id=(v_resolved->>'roomId')::uuid;
      v_result:=public.save_contract_draft(v_org,(v_resolved->>'buildingId')::uuid,(v_resolved->>'roomId')::uuid,v_payload,NULL,v_draft_id,NULL,p_request_id);
      -- Hậu điều kiện: đúng một nháp mới (id theo requestId) còn sửa được, đúng phòng + ngày + giá; không sinh HĐ, phòng giữ trạng thái.
      IF NOT EXISTS(SELECT 1 FROM public.contract_drafts d WHERE d.id=v_draft_id AND d.organization_id=v_org AND d.room_id=(v_resolved->>'roomId')::uuid
          AND d.building_id=(v_resolved->>'buildingId')::uuid AND d.status='EDITABLE' AND d.payload#>>'{form,start_date}'=v_start::text
          AND d.payload#>>'{form,end_date}'=v_end::text AND (d.payload#>>'{form,rent_price}')::numeric=v_rent)
        OR (SELECT count(*) FROM public.contracts k WHERE k.room_id=(v_resolved->>'roomId')::uuid AND k.deleted_at IS NULL)<>v_money
        OR (SELECT r.status::text FROM public.rooms r WHERE r.id=(v_resolved->>'roomId')::uuid) IS DISTINCT FROM v_room_status
        THEN RAISE EXCEPTION 'hermes_contract_postcondition' USING ERRCODE='P0001'; END IF;
      v_outcome:=jsonb_build_object('kind','applied','link','/contracts','result',jsonb_strip_nulls(jsonb_build_object(
        'text','Đã '||v_text,'buildingName',v_resolved->'buildingName','roomName',v_resolved->'roomName','draftId',v_draft_id,
        'startDate',v_start,'endDate',v_end,'rentPrice',v_rent::text,'deposit',v_deposit::text,'customerName',v_resolved->'customerName',
        'nextStep','Mở Hợp đồng → tab Nháp để kiểm, xuất và ký.')));
    ELSIF p_action='contract.room_lock' THEN
      v_result:=public.lock_room_for_sale_v1(v_org,(v_resolved->>'roomId')::uuid,v_hours,v_note);
      IF v_result->>'room_id' IS DISTINCT FROM v_resolved->>'roomId' OR v_result->>'active' IS DISTINCT FROM 'true'
        THEN RAISE EXCEPTION 'hermes_contract_postcondition' USING ERRCODE='P0001'; END IF;
      v_outcome:=jsonb_build_object('kind','applied','link',NULL,'result',jsonb_strip_nulls(jsonb_build_object(
        'text','Đã '||v_text||' Khoá tới '||to_char((v_result->>'expires_at')::timestamptz AT TIME ZONE v_tz,'HH24:MI')||' '||
          app_private.hermes_contract_date_label_v1(((v_result->>'expires_at')::timestamptz AT TIME ZONE v_tz)::date,v_today)||'.',
        'buildingName',v_resolved->'buildingName','roomName',v_resolved->'roomName','hours',v_hours,
        'expiresAt',v_result->'expires_at','note',v_note)));
    ELSE
      v_result:=public.release_room_sale_lock_v1(v_org,l.id);
      IF v_result->>'id' IS DISTINCT FROM l.id::text OR v_result->>'active' IS DISTINCT FROM 'false'
        THEN RAISE EXCEPTION 'hermes_contract_postcondition' USING ERRCODE='P0001'; END IF;
      v_outcome:=jsonb_build_object('kind','applied','link',NULL,'result',jsonb_strip_nulls(jsonb_build_object(
        'text','Đã '||v_text,'buildingName',v_resolved->'buildingName','roomName',v_resolved->'roomName')));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Lỗi tạm (tranh chấp tuần tự, deadlock, chờ khoá, ngữ cảnh đổi) KHÔNG chốt biên nhận (mục 3.1 nền chung): RAISE lại để cả
    -- giao dịch lùi, kể cả biên nhận vừa mở; cùng requestId gọi lại được. Lỗi khác: hàm ghi web đã lùi về savepoint của khối.
    IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
    v_outcome:=jsonb_build_object('kind','rejected','reason',app_private.hermes_contract_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome,SQLSTATE,SQLERRM);
  END;
  RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
END $fn$;

ALTER FUNCTION app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) TO authenticated;

DO $check$
DECLARE p pg_catalog.pg_proc;
BEGIN
  SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid='app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure;
  IF NOT p.prosecdef OR pg_get_userbyid(p.proowner)<>'postgres' OR md5(p.prosrc)<>'440f22e8975cb0afc7208f4707187f7d'
    OR has_function_privilege('anon','app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)','EXECUTE') OR NOT has_function_privilege('authenticated','app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)','EXECUTE')
    OR position('hermes_contract_action_step_v1' IN pg_get_functiondef('public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'hermes_contract_return_twice_check_failed'; END IF;
END $check$;
COMMIT;
