-- Đợt 2 trang HỢP ĐỒNG — Mốc 4: ghi nhận khách TRẢ PHÒNG, quyết toán sau (22/10/2026; docs/plans/hermes-crm/HOP-DONG-THAO-TAC-GHI.md
-- mục 4.4; Q20 = a, D-HĐ6). Thao tác contract.return (khoá + quyền CRM contracts.terminate, irreversible + 'always': luôn xem
-- trước) gọi ĐÚNG hàm ghi web public.confirm_contract_return_v1 chế độ DEFERRED (rào câu 26 của 20261021180057 trong hàm web):
-- HĐ chuyển Đã thanh lý, mở hồ sơ chờ quyết toán; quyết toán (hoàn cọc, trừ tiền, chỉ số chốt) làm trên web. Ngày tương lai ⇒
-- return_date_future (hướng sang báo trả); loại máy chủ suy từ ngày; bỏ cọc chỉ khi người dùng nói. Hậu điều kiện: không phát
-- sinh tiền (đếm + tổng phiếu thu chi và hoá đơn của HĐ không đổi), đúng một hồ sơ PENDING. Rào P0a (20261021114556) vẫn chặn
-- phiếu hoàn thứ hai sau đó.
-- File MỚI (không sửa 20261022022951): CREATE OR REPLACE hai hàm của trang, dựng từ thân của file đó — sẽ là thân ĐANG CHẠY khi
-- áp file này; md5(prosrc) ghim ở $requires$ (chạy lại nhận thân đã có nhánh mới). Phần còn lại của hai thân giữ nguyên từng chữ:
--   public.hermes_contract_action_lookup_v1: + hoá đơn chưa thu của HĐ (chỉ khi người hỏi xem được hoá đơn ở toà đó).
--   app_private.hermes_contract_action_step_v1: + nhánh contract.return (xem trước + ghi + hậu điều kiện).
-- Vỏ public.hermes_contract_action_v1 không đổi (gắn OID; CREATE OR REPLACE giữ OID). Không đổi chữ ký, chủ, ACL; không ghi dữ liệu
-- ngoài một dòng chính sách.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE v_step text; v_lookup text; v_return text;
BEGIN
  SELECT p.prosrc INTO v_step FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)');
  SELECT p.prosrc INTO v_lookup FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.hermes_contract_action_lookup_v1(uuid,uuid)');
  IF v_step IS NULL OR NOT (md5(v_step)='861b39ed123d3adc51179b61350378a1' OR position('contract.return' IN v_step)>0)
    OR v_lookup IS NULL OR NOT (md5(v_lookup)='494f968f8f0b790605c16f06b643d5a1' OR position('unpaidInvoices' IN v_lookup)>0) THEN
    RAISE EXCEPTION 'hermes_contract_return_base_changed'; END IF;
  SELECT p.prosrc INTO v_return FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.confirm_contract_return_v1(uuid,uuid,timestamp with time zone,text,date,text,text,jsonb,jsonb,text)');
  IF v_return IS NULL OR position('contracts.terminate' IN v_return)=0
    OR to_regprocedure('public.invoice_effective_outstanding_v1(uuid[])') IS NULL
    OR to_regprocedure('public.can_do_on_building(text,text,uuid)') IS NULL
    OR to_regclass('public.contract_terminations') IS NULL OR to_regclass('public.contract_exit_cases') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.contract_exit_cases'::regclass
      AND a.attname='physical_idempotency_key' AND NOT a.attisdropped)
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='contracts.terminate' AND mode='action')
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_action_policies WHERE action='contract.notice_set')
    OR to_regprocedure('public.approve_contract_termination_v1(uuid,text)') IS NULL
    OR position('[TERMINATION_CONTRACT_CLOSED]' IN pg_get_functiondef('public.approve_contract_termination_v1(uuid,text)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'hermes_contract_return_dependency_invalid'; END IF;
END $requires$;

-- 1. Chính sách: cùng khoá + quyền CRM với báo trả (contracts.terminate); irreversible + 'always'.
INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES
  ('contract.return','contracts.terminate','contracts.terminate','irreversible','always',true)
  ON CONFLICT(action) DO NOTHING;

-- 2. Tra cứu dưới RLS người hỏi (thân 20261022022951 + hoá đơn chưa thu).
CREATE OR REPLACE FUNCTION public.hermes_contract_action_lookup_v1(p_organization_id uuid,p_room_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_ids uuid[]; v_name text; v_building uuid; v_unpaid jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL OR p_room_id IS NULL THEN
    RAISE EXCEPTION 'hermes_contract_lookup_denied' USING ERRCODE='42501'; END IF;
  -- HĐ hiện hành của phòng mà người hỏi thấy được. Hai dòng (dữ liệu hỏng) ⇒ không chọn, bước ghi trả "không có HĐ".
  SELECT array_agg(c.id ORDER BY c.id) INTO v_ids FROM public.contracts c
    WHERE c.organization_id=p_organization_id AND c.room_id=p_room_id AND c.status='ACTIVE' AND c.actual_end_date IS NULL AND c.deleted_at IS NULL;
  IF COALESCE(cardinality(v_ids),0)<>1 THEN RETURN jsonb_build_object('contractId',NULL); END IF;
  -- Tên khách đại diện chỉ khi RLS customers / contract_customers cho thấy.
  SELECT cu.full_name INTO v_name FROM public.contract_customers cc JOIN public.customers cu ON cu.id=cc.customer_id
    WHERE cc.contract_id=v_ids[1] AND cc.is_representative ORDER BY cc.customer_id LIMIT 1;
  -- Mốc 4: hoá đơn chưa thu của HĐ cho câu xem trước trả phòng. Chỉ khi người hỏi có quyền xem hoá đơn ở toà của phòng (khoá
  -- web, như thẻ "Phải thu"); không có ⇒ NULL (câu xem trước nói "không xem được"), không lộ số. Tập: hoá đơn chưa xoá, chưa huỷ
  -- của HĐ dưới RLS invoices; còn nợ = GREATEST(nợ thực của hàm dùng chung invoice_effective_outstanding_v1, 0), như thẻ đó.
  SELECT r.building_id INTO v_building FROM public.rooms r WHERE r.id=p_room_id;
  IF v_building IS NOT NULL AND COALESCE(public.can_do_on_building('invoices','view',v_building),false) THEN
    SELECT jsonb_build_object('count',count(*) FILTER (WHERE x.owed>0),'amount',COALESCE(sum(x.owed) FILTER (WHERE x.owed>0),0)::text) INTO v_unpaid
      FROM (SELECT GREATEST(COALESCE(o.effective_outstanding,i.remaining_amount),0) owed FROM public.invoices i
        LEFT JOIN public.invoice_effective_outstanding_v1(ARRAY(SELECT i2.id FROM public.invoices i2 WHERE i2.contract_id=v_ids[1]
          AND i2.deleted_at IS NULL AND i2.status::text<>'CANCELLED')) o ON o.invoice_id=i.id
        WHERE i.contract_id=v_ids[1] AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED') x;
  END IF;
  RETURN jsonb_build_object('contractId',v_ids[1],'representativeName',v_name,'unpaidInvoices',v_unpaid);
END $fn$;

-- 3. Bước ghi (thân 20261022022951 + nhánh contract.return).
CREATE OR REPLACE FUNCTION app_private.hermes_contract_action_step_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb,p_lookup jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; v_org uuid; v_resolved jsonb; v_today date; v_tz text; c public.contracts; l public.room_sale_locks;
  v_basis text; v_date date; v_hours integer; v_note text; v_place text; v_text text; v_warnings jsonb:='[]'::jsonb;
  v_begin jsonb; v_result jsonb; v_outcome jsonb; v_constraint text; v_notice boolean; v_contract boolean;
  v_new_end date; v_months integer; v_choice text; v_money bigint; v_dup text; c_after public.contracts; v_prev app_private.hermes_action_receipts;
  v_kind text; v_money_sum numeric; v_unpaid jsonb; v_case public.contract_exit_cases; v_room_status text;
BEGIN
  -- NULL không bao giờ lọt: NOT IN với NULL cho NULL (không RAISE), nên mọi tham số bắt buộc kiểm IS NULL trước.
  IF p_action IS NULL OR p_action NOT IN ('contract.notice_set','contract.notice_cancel','contract.room_lock','contract.room_unlock','contract.renew',
    'contract.return')
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
  v_contract:=v_notice OR p_action IN ('contract.renew','contract.return');
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
    v_basis:=md5(jsonb_build_array(p_action,c.id,c.updated_at,c.expected_move_out_date,c.end_date,c.status,c.rent_price,c.total_deposit)::text);
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
    ELSE
      IF c.expected_move_out_date IS NULL THEN RETURN jsonb_build_object('kind','rejected','reason','no_notice'); END IF;
      v_note:=NULLIF(btrim(p_params->>'reason'),'');
      IF v_note IS NULL OR char_length(v_note)<8 THEN RETURN jsonb_build_object('kind','needs_input','reason','reason_required'); END IF;
      v_text:=format('huỷ báo trả %s (trước đó: dọn đi %s); lý do: %s.',v_place,
        app_private.hermes_contract_date_label_v1(c.expected_move_out_date,v_today),v_note);
    END IF;
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
  IF p_phase<>'apply' AND NOT (p_phase='auto' AND COALESCE(ctx->>'actionClass'='reversible' AND ctx->>'confirm'='never',false)) THEN
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
        'unpaidInvoices',CASE WHEN p_action='contract.return' THEN v_unpaid END)));
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

ALTER FUNCTION public.hermes_contract_action_lookup_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_contract_action_lookup_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_contract_action_lookup_v1(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) TO authenticated;

DO $check$
DECLARE v_step pg_catalog.pg_proc; v_lookup pg_catalog.pg_proc;
BEGIN
  SELECT * INTO v_step FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)');
  SELECT * INTO v_lookup FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('public.hermes_contract_action_lookup_v1(uuid,uuid)');
  IF (SELECT count(*) FROM app_private.hermes_action_policies WHERE action LIKE 'contract.%')<>6
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_action_policies WHERE action='contract.return' AND capability='contracts.terminate'
      AND crm_permission='contracts.terminate' AND action_class='irreversible' AND confirm='always' AND private_only)
    OR position('contract.return' IN v_step.prosrc)=0 OR NOT v_step.prosecdef
    OR position('unpaidInvoices' IN v_lookup.prosrc)=0 OR v_lookup.prosecdef OR replace(COALESCE(array_to_string(v_lookup.proconfig,','),''),'"','')<>'search_path='
    OR NOT has_function_privilege('authenticated','app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.hermes_contract_action_lookup_v1(uuid,uuid)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)','EXECUTE') OR has_function_privilege('anon','public.hermes_contract_action_lookup_v1(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_contract_return_check_failed'; END IF;
END $check$;
COMMIT;
