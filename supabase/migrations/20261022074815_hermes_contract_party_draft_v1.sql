-- Đợt 2 trang HỢP ĐỒNG — Mốc 5: thêm / bớt người ở + soạn nháp HĐ mới (22/10/2026; docs/plans/hermes-crm/HOP-DONG-THAO-TAC-GHI.md
-- mục 4.5–4.6; Q22 = a, D-HĐ2, D-HĐ3). File MỚI, xếp sau 20261022061813 (không sửa 6 file trước):
--   contract.occupant_add / contract.occupant_remove (khoá + quyền CRM contracts.edit, reversible + 'never': ghi thẳng) ⇒ hàm web
--     public.reconcile_contract_customers_v1 (p_expected = danh sách đúng khuôn hàm web dựng). Người mới không là đại diện; KHÔNG bỏ
--     người đại diện qua bot (hàm web không chặn) ⇒ cannot_remove_representative; người không có trong HĐ ⇒ occupant_not_on_contract.
--   contract.draft (khoá + quyền CRM contracts.create, reversible + 'never') ⇒ hàm web public.save_contract_draft: nháp không giữ phòng,
--     không tạo tiền; người ký và hoàn tất trên web. Máy chủ đòi xác nhận cho lần gọi khi phòng còn HĐ phủ ngày bắt đầu hoặc đã có nháp
--     của phòng trong 24 giờ (D-HĐ3).
--   Khách tìm dưới RLS người hỏi bằng hàm INVOKER MỚI public.hermes_contract_party_lookup_v1 (SĐT ưu tiên, rồi tên khớp đúng; ứng
--     viên "tên · …3 số cuối"). Vỏ dựng lại (thân 20261022022951 + một nhánh gọi hàm tra khách); bước ghi dựng từ thân 20261022061813
--     (sẽ là thân ĐANG CHẠY khi áp file này), md5(prosrc) ghim ở $requires$, chạy lại nhận thân đã có nhánh mới.
-- Không đổi chữ ký, chủ, ACL của hàm có sẵn; không ghi dữ liệu ngoài ba dòng chính sách.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE v_step text;
BEGIN
  SELECT p.prosrc INTO v_step FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)');
  IF v_step IS NULL OR NOT (md5(v_step)='aebfa4c3a1c9393643389ce7b602aa69' OR position('contract.occupant_add' IN v_step)>0) THEN
    RAISE EXCEPTION 'hermes_contract_party_base_changed'; END IF;
  IF to_regprocedure('public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)') IS NULL
    OR position('hermes_contract_action_step_v1' IN pg_get_functiondef('public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure))=0
    OR to_regprocedure('public.hermes_contract_action_lookup_v1(uuid,uuid)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_action_policies WHERE action='contract.return')
    OR to_regprocedure('public.reconcile_contract_customers_v1(uuid,uuid,jsonb,jsonb)') IS NULL
    OR to_regprocedure('public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid)') IS NULL
    OR to_regclass('public.contract_drafts') IS NULL OR to_regclass('public.contract_customers') IS NULL
    OR to_regprocedure('public.hermes_name_fold_v1(text)') IS NULL
    OR (SELECT count(*) FROM app_private.hermes_capabilities WHERE capability IN ('contracts.edit','contracts.create') AND mode='action')<>2 THEN
    RAISE EXCEPTION 'hermes_contract_party_dependency_invalid'; END IF;
END $requires$;

-- 1. Chính sách: người ở theo contracts.edit, nháp theo contracts.create (cùng quyền hàm web đòi); đều ghi thẳng.
INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES
  ('contract.occupant_add','contracts.edit','contracts.edit','reversible','never',true),
  ('contract.occupant_remove','contracts.edit','contracts.edit','reversible','never',true),
  ('contract.draft','contracts.create','contracts.create','reversible','never',true)
  ON CONFLICT(action) DO NOTHING;

-- 2. Tra khách dưới RLS người hỏi (INVOKER, STABLE, search_path='').
CREATE OR REPLACE FUNCTION public.hermes_contract_party_lookup_v1(p_organization_id uuid,p_room_id uuid,p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_ids uuid[]; v_contract uuid; v_phone text; v_name text; v_found jsonb; v_count integer;
BEGIN
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL OR p_room_id IS NULL
    OR p_action IS NULL OR p_action NOT IN ('contract.occupant_add','contract.occupant_remove','contract.draft')
    OR p_params IS NULL OR jsonb_typeof(p_params)<>'object' THEN
    RAISE EXCEPTION 'hermes_contract_lookup_denied' USING ERRCODE='42501'; END IF;
  -- HĐ hiện hành của phòng mà người hỏi thấy (như tra cứu của trang); bớt người ở chỉ tìm trong khách của HĐ này.
  SELECT array_agg(c.id ORDER BY c.id) INTO v_ids FROM public.contracts c
    WHERE c.organization_id=p_organization_id AND c.room_id=p_room_id AND c.status='ACTIVE' AND c.actual_end_date IS NULL AND c.deleted_at IS NULL;
  IF COALESCE(cardinality(v_ids),0)=1 THEN v_contract:=v_ids[1]; END IF;
  -- SĐT ưu tiên: chỉ chữ số, +84/84 đầu số ⇒ 0; khớp đúng. Không có SĐT thì tên: khớp đúng sau khi gấp dấu/hoa thường.
  v_phone:=regexp_replace(COALESCE(p_params->>'customerPhone',''),'[^0-9]','','g');
  IF v_phone ~ '^84[0-9]{9,10}$' THEN v_phone:='0'||substr(v_phone,3); END IF;
  v_name:=NULLIF(btrim(COALESCE(p_params->>'customerName','')),'');
  IF v_phone='' AND v_name IS NULL THEN RETURN jsonb_build_object('customer',jsonb_build_object('status','none')); END IF;
  -- Dưới RLS customers của người hỏi (khoá web customers.view theo toà): không thấy thì như không có.
  SELECT count(*)::integer,COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'name',x.full_name,'tail',right(x.digits,3)) ORDER BY x.full_name,x.id)
      FILTER (WHERE x.n<=9),'[]'::jsonb)
    INTO v_count,v_found
    FROM (SELECT cu.id,cu.full_name,regexp_replace(COALESCE(cu.phone,''),'[^0-9]','','g') digits,row_number() OVER (ORDER BY cu.full_name,cu.id) n
      FROM public.customers cu WHERE cu.organization_id=p_organization_id AND cu.deleted_at IS NULL
        AND CASE WHEN v_phone<>'' THEN (CASE WHEN regexp_replace(COALESCE(cu.phone,''),'[^0-9]','','g') ~ '^84[0-9]{9,10}$'
              THEN '0'||substr(regexp_replace(COALESCE(cu.phone,''),'[^0-9]','','g'),3) ELSE regexp_replace(COALESCE(cu.phone,''),'[^0-9]','','g') END)=v_phone
          ELSE public.hermes_name_fold_v1(cu.full_name)=public.hermes_name_fold_v1(v_name) END
        AND (p_action<>'contract.occupant_remove' OR EXISTS(SELECT 1 FROM public.contract_customers cc WHERE cc.contract_id=v_contract
          AND cc.customer_id=cu.id))) x;
  IF v_count=1 THEN
    RETURN jsonb_build_object('customer',jsonb_build_object('status','resolved','id',v_found->0->'id','name',v_found->0->'name'));
  END IF;
  -- Ứng viên: tên · …3 số cuối SĐT (không lộ đủ SĐT), tối đa 8.
  RETURN jsonb_build_object('customer',jsonb_build_object('status','unresolved','field','customer',
    'wanted',COALESCE(v_name,'SĐT …'||right(v_phone,3)),'why',CASE WHEN v_count=0 THEN 'not_visible' ELSE 'ambiguous' END,
    'candidates',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',left(f->>'name',100)||' · …'||(f->>'tail')) ORDER BY o)
      FROM jsonb_array_elements(v_found) WITH ORDINALITY e(f,o) WHERE o<=8),'[]'::jsonb),'more',v_count>8));
END $fn$;

-- 3. Bước ghi (thân 20261022061813 + nhánh người ở + nháp).
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
  -- Phát lại theo requestId TRƯỚC mọi phép tính lại (thiết kế nền chung mục 3.1): chính lần ghi trước đã đổi HĐ nên basis tính
  -- lại sẽ lệch; không phát lại ở đây thì lần gọi lại nhận state_changed, mô hình xem trước lại và có thể ghi chồng. Biên nhận đã
  -- chốt cùng thao tác + cùng params ⇒ trả y nguyên; khác ⇒ request_conflict; kết nối khác ⇒ PT409 (như receipt_begin). Biên nhận
  -- 'started' (giao dịch khác đang ghi) để receipt_begin xử lý.
  SELECT * INTO v_prev FROM app_private.hermes_action_receipts r WHERE r.organization_id=v_org AND r.user_id=auth.uid() AND r.request_id=p_request_id;
  IF FOUND AND v_prev.state IN ('applied','rejected') THEN
    IF v_prev.connection_id::text IS DISTINCT FROM ctx->>'connectionId' THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
    IF v_prev.action IS DISTINCT FROM p_action OR v_prev.input->'params' IS DISTINCT FROM p_params THEN
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
  v_today:=public.org_today_v1(v_org);
  v_tz:=COALESCE(app_private.org_timezone_v1(v_org),'Asia/Ho_Chi_Minh');
  v_place:=format('phòng %s toà %s',v_resolved->>'roomName',v_resolved->>'buildingName');

  IF v_contract THEN
    IF v_resolved->>'contractId' IS NULL THEN
      -- Không có HĐ hiện hành thấy được: đã ghi trả phòng và đang chờ quyết toán, hay phòng trống.
      IF p_phase<>'apply' AND EXISTS(SELECT 1 FROM public.contract_exit_cases x JOIN public.contracts k ON k.id=x.contract_id
          WHERE x.organization_id=v_org AND k.room_id=(v_resolved->>'roomId')::uuid AND x.state='PENDING') THEN
        RETURN jsonb_build_object('kind','rejected','reason','already_returned'); END IF;
      RETURN CASE WHEN p_phase='apply' THEN jsonb_build_object('kind','rejected','reason','state_changed')
        ELSE jsonb_build_object('kind','needs_input','reason','room_has_no_active_contract') END;
    END IF;
    -- Lượt preview chỉ đọc: không khoá dòng. auto/apply có thể ghi: khoá dòng HĐ (sau khoá tổ chức ở trên).
    IF p_phase='preview' THEN
      SELECT * INTO c FROM public.contracts k WHERE k.id=(v_resolved->>'contractId')::uuid AND k.organization_id=v_org
        AND k.room_id=(v_resolved->>'roomId')::uuid;
    ELSE
      SELECT * INTO c FROM public.contracts k WHERE k.id=(v_resolved->>'contractId')::uuid AND k.organization_id=v_org
        AND k.room_id=(v_resolved->>'roomId')::uuid FOR UPDATE;
    END IF;
    IF NOT FOUND OR c.status IS DISTINCT FROM 'ACTIVE' OR c.actual_end_date IS NOT NULL OR c.deleted_at IS NOT NULL THEN
      RETURN CASE WHEN p_phase='apply' THEN jsonb_build_object('kind','rejected','reason','state_changed')
        ELSE jsonb_build_object('kind','needs_input','reason','room_has_no_active_contract') END; END IF;
    -- Người ở: danh sách thành viên đúng khuôn hàm web dựng (p_expected) vào basis; thao tác khác basis giữ nguyên.
    IF p_action IN ('contract.occupant_add','contract.occupant_remove') THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('customer_id',cc.customer_id,'is_representative',cc.is_representative,'notes',cc.notes)
          ORDER BY cc.customer_id),'[]'::jsonb) INTO v_members FROM public.contract_customers cc WHERE cc.contract_id=c.id;
    END IF;
    v_basis:=md5((jsonb_build_array(p_action,c.id,c.updated_at,c.expected_move_out_date,c.end_date,c.status,c.rent_price,c.total_deposit)
      ||CASE WHEN v_members IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v_members) END)::text);
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
      IF v_date>v_today THEN RETURN jsonb_build_object('kind','needs_input','reason','return_date_future'); END IF;
      IF v_date<c.start_date THEN RETURN jsonb_build_object('kind','needs_input','reason','date_out_of_range'); END IF;
      v_note:=NULLIF(btrim(p_params->>'note'),'');
      IF v_note IS NULL OR char_length(v_note)<3 OR char_length(v_note)>1000
        OR (p_params ? 'forfeit' AND COALESCE(p_params->>'forfeit','') NOT IN ('true','false')) THEN
        RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
      v_kind:=CASE WHEN p_params->>'forfeit'='true' THEN 'FORFEIT' WHEN v_date>=c.end_date THEN 'NATURAL_EXPIRY' ELSE 'EARLY_RETURN' END;
      -- Đã có hồ sơ thanh lý (luồng cũ) hay hồ sơ trả phòng của HĐ ⇒ không ghi chồng (hàm web cũng từ chối, ở đây nói rõ lý do).
      IF EXISTS(SELECT 1 FROM public.contract_terminations t WHERE t.contract_id=c.id)
        OR EXISTS(SELECT 1 FROM public.contract_exit_cases x WHERE x.contract_id=c.id) THEN
        RETURN jsonb_build_object('kind','rejected','reason','already_returned'); END IF;
      IF c.expected_move_out_date IS NOT NULL AND c.expected_move_out_date IS DISTINCT FROM v_date THEN
        v_warnings:=v_warnings||to_jsonb('Báo trả trước đó là '||to_char(c.expected_move_out_date,'DD/MM/YYYY')||'; ngày trả thực tế ghi '||
          to_char(v_date,'DD/MM/YYYY')||'.'); END IF;
      IF v_kind='EARLY_RETURN' THEN
        v_warnings:=v_warnings||to_jsonb('Trả trước ngày hết hạn HĐ ('||to_char(c.end_date,'DD/MM/YYYY')||') ⇒ loại TRẢ SỚM; bỏ cọc chỉ khi '||
          'người dùng nói rõ (forfeit=true); đổi loại về sau làm trên web.'); END IF;
      v_unpaid:=CASE WHEN jsonb_typeof(p_lookup->'unpaidInvoices')='object' THEN p_lookup->'unpaidInvoices' END;
      v_text:=format('ghi nhận khách TRẢ PHÒNG %s: ngày trả %s, loại: %s. Sau khi ghi: HĐ chuyển Đã thanh lý, phòng thành trống, KHÔNG lùi '||
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
        v_text:=format('bớt người ở %s khỏi %s.',v_resolved->>'customerName',v_place);
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
    -- HĐ hiện hành của phòng (đọc DEFINER, không dữ liệu cá nhân) + nháp gần nhất còn sửa được của phòng.
    SELECT * INTO c FROM public.contracts k WHERE k.organization_id=v_org AND k.room_id=(v_resolved->>'roomId')::uuid AND k.status='ACTIVE'
      AND k.actual_end_date IS NULL AND k.deleted_at IS NULL ORDER BY k.end_date DESC NULLS LAST,k.id LIMIT 1;
    SELECT * INTO v_last_draft FROM public.contract_drafts d WHERE d.organization_id=v_org AND d.room_id=(v_resolved->>'roomId')::uuid
      AND d.status='EDITABLE' ORDER BY d.created_at DESC,d.id LIMIT 1;
    v_basis:=md5(jsonb_build_array(p_action,v_resolved->'roomId',c.id,c.updated_at,v_last_draft.id,v_last_draft.updated_at)::text);
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
        AND k.released_at IS NULL AND k.expires_at>clock_timestamp() ORDER BY k.locked_at DESC, k.id LIMIT 1 FOR UPDATE;
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
        'returnDate',CASE WHEN p_action='contract.return' THEN to_jsonb(v_date) END,'kind',CASE WHEN p_action='contract.return' THEN to_jsonb(v_kind) END,
        'depositPaid',CASE WHEN p_action='contract.return' THEN to_jsonb(round(COALESCE(c.deposit_paid,0))::text) END,
        'unpaidInvoices',CASE WHEN p_action='contract.return' THEN v_unpaid END,'customerName',CASE WHEN v_party THEN v_resolved->'customerName' END,
        'draft',CASE WHEN p_action='contract.draft' THEN jsonb_build_object('startDate',v_start,'endDate',v_end,'rentPrice',v_rent::text,
          'deposit',v_deposit::text,'paymentCycle','MONTHLY') END)));
  END IF;
  v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
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

ALTER FUNCTION public.hermes_contract_party_lookup_v1(uuid,uuid,text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_contract_party_lookup_v1(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_contract_party_lookup_v1(uuid,uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) TO authenticated;

-- 4. Vỏ public: thân 20261022022951 + tra khách cho ba thao tác Mốc 5 (gắn OID hàm tra khách lúc tạo). Câu lệnh ghim băm ở
--    scripts/hermes-task-function-contract.mjs.
CREATE OR REPLACE FUNCTION public.hermes_contract_action_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb DEFAULT NULL,p_expected_basis text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
  WITH g AS MATERIALIZED (SELECT app_private.hermes_action_guard_v1(p_binding,p_action) AS ctx),
  r AS MATERIALIZED (SELECT g.ctx,CASE WHEN p_phase IN ('preview','auto') AND jsonb_typeof(p_params)='object' AND p_params ? 'roomName' THEN
      public.hermes_write_name_resolve_v1((g.ctx->>'organizationId')::uuid,ARRAY(SELECT jsonb_array_elements_text(g.ctx->'buildingIds')::uuid),
        jsonb_strip_nulls(jsonb_build_object('building',p_params->>'buildingName','room',p_params->>'roomName'))) END AS resolution FROM g),
  l AS MATERIALIZED (SELECT r.resolution,CASE WHEN r.resolution->>'status'='resolved' AND r.resolution#>>'{room,id}' IS NOT NULL THEN
      public.hermes_contract_action_lookup_v1((r.ctx->>'organizationId')::uuid,(r.resolution#>>'{room,id}')::uuid)
      ||CASE WHEN p_action IN ('contract.occupant_add','contract.occupant_remove','contract.draft') THEN jsonb_build_object('party',
        public.hermes_contract_party_lookup_v1((r.ctx->>'organizationId')::uuid,(r.resolution#>>'{room,id}')::uuid,p_action,p_params))
        ELSE '{}'::jsonb END END AS lookup FROM r)
  SELECT app_private.hermes_contract_action_step_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,l.resolution,l.lookup) FROM l;
END;

ALTER FUNCTION public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;

DO $check$
DECLARE v_party pg_catalog.pg_proc;
BEGIN
  SELECT * INTO v_party FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('public.hermes_contract_party_lookup_v1(uuid,uuid,text,jsonb)');
  IF (SELECT count(*) FROM app_private.hermes_action_policies WHERE action LIKE 'contract.%')<>9
    OR (SELECT count(*) FROM app_private.hermes_action_policies WHERE (action,capability,crm_permission,action_class,confirm,private_only) IN
      (('contract.occupant_add','contracts.edit','contracts.edit','reversible','never',true),
       ('contract.occupant_remove','contracts.edit','contracts.edit','reversible','never',true),
       ('contract.draft','contracts.create','contracts.create','reversible','never',true)))<>3
    OR position('contract.occupant_add' IN (SELECT prosrc FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)')))=0
    OR v_party.oid IS NULL OR v_party.prosecdef OR replace(COALESCE(array_to_string(v_party.proconfig,','),''),'"','')<>'search_path='
    OR position('hermes_contract_party_lookup_v1' IN pg_get_functiondef('public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure))=0
    OR NOT has_function_privilege('authenticated','public.hermes_contract_party_lookup_v1(uuid,uuid,text,jsonb)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_contract_party_lookup_v1(uuid,uuid,text,jsonb)','EXECUTE') OR has_function_privilege('anon','public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_contract_party_check_failed'; END IF;
END $check$;
COMMIT;
