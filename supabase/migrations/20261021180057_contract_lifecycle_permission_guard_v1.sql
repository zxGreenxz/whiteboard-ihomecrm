-- ============================================================
-- Câu 26 (chủ chốt 21/10/2026) — HỢP ĐỒNG: kiểm quyền ở máy chủ khớp đúng quyền web cho
-- thanh lý / trả phòng, gia hạn và sửa trạng thái hợp đồng. (Hoá đơn: migration kế tiếp.)
--
-- LỖ (đọc pg_get_functiondef + catalog production 22/10/2026, chỉ đọc)
--   Web gác nút bằng khoá riêng — canUse(perms,'contracts','terminate') cho Thanh lý, ĐK chuyển đi,
--   hàng đợi trả phòng/quyết toán; canUse(perms,'contracts','renew') cho Gia hạn — còn máy chủ chỉ
--   hỏi contracts.edit ⇒ người có contracts.edit mà thiếu khoá riêng gọi thẳng RPC/REST vẫn làm được:
--   * thanh lý / trả phòng: confirm_contract_return_v1, finalize_contract_exit_case_v1 (+ bọc
--     finalize_contract_transfer_exit_v1), update_contract_exit_case_kind_v1; hàm thanh lý cũ
--     terminate_contract_move_out / terminate_contract_forfeit (authenticated gọi thẳng được; cũng là
--     lõi của *_with_credit_v1 và run_contract_exit_settlement_v1); approve_contract_termination_v1
--     (đường duyệt hồ sơ cũ, Copilot contract.duyet_thanh_ly còn gọi); set_contract_move_out_notice_v1
--     (báo ngày trả phòng — web gác bằng contracts.terminate);
--   * gia hạn: renew_contract_with_notice_v1 (web) và renew_contract (authenticated gọi thẳng được,
--     Copilot contract.gia_han gọi) — cả hai đi qua app_private.commission_reason_renew_before_v1;
--   * sửa trạng thái: PATCH bảng contracts (RLS contracts.edit) đổi được status / actual_end_date /
--     expected_move_out_date, không trigger nào canh ⇒ "thanh lý chay" không ca trả phòng, không
--     quyết toán, phòng tự nhả. Web không có màn nào sửa thẳng các cột này (form Sửa HĐ dùng
--     schema .strict() không có các khoá đó).
--
-- ĐO PRODUCTION 90 NGÀY (23/07–22/10/2026, chỉ đọc, chỉ đếm; chi tiết theo vai ở mô tả PR)
--   13 membership ACTIVE. Với từng người: phạm vi contracts.edit ⊆ phạm vi contracts.terminate và
--   ⊆ contracts.renew (cùng vai, cùng phạm vi; một Quản lý toà có thêm terminate qua override), không
--   DENY, không emergency deny ⇒ 0 người dùng hợp lệ bị chặn nhầm. Người làm thật trong 90 ngày (trả
--   phòng 14, quyết toán sau 7, đổi loại 1, hồ sơ thanh lý 105, báo trả 1, gia hạn qua adapter 3)
--   đều là Quản lý toà / Chủ sở hữu (+ super admin) — đều có khoá riêng. Đổi thẳng trạng thái ngoài
--   luồng: 0 (không hợp đồng TERMINATED nào thiếu cả ca trả phòng lẫn hồ sơ thanh lý được cập nhật
--   trong 90 ngày; sự kiện cư trú TERMINATED-ngoài-luồng từ 07/10: 0).
--
-- VÁ
--   1. app_private.require_building_perm_v1(toà, việc, VARIADIC khoá): hàm kiểm quyền DÙNG CHUNG
--      (luật 17/10), cùng nguồn can_do_on_building mà RLS/web dùng (super admin qua, tài khoản đã nghỉ
--      bị chặn), theo ĐÚNG toà của bản ghi; nhiều khoá = chỉ cần một. Không đủ ⇒ 42501
--      '[THIEU_QUYEN:<khoá>] Bạn không có quyền <việc> ở toà nhà này.' + HINT tiếng Việt.
--   2. Tám hàm: chèn MỘT dòng PERFORM require_building_perm_v1(...) ngay sau rào quyền cũ (mang dấu
--      "[q26] kiểm quyền máy chủ khớp web"); phần còn lại giữ nguyên từng chữ bản production (ghim md5
--      ở tiền kiểm). Rào cũ (contracts.edit) GIỮ NGUYÊN — chỉ thêm điều kiện, không nới. Chữ ký, kiểu
--      trả về, ACL không đổi (CREATE OR REPLACE).
--   3. Trigger a01_contract_lifecycle_columns_guard (BEFORE UPDATE OF status, actual_end_date,
--      expected_move_out_date, WHEN current_user IN ('authenticated','anon')): đường REST không đổi
--      thẳng các cột vòng đời; writer SECURITY DEFINER và service_role đi thẳng như cũ.
--
-- KHÔNG ĐỔI (ngoài phạm vi câu 26, ghi để không hiểu nhầm là đã vá)
--   Chuyển phòng/nhượng (web contracts.transfer, máy chủ contracts.edit); reject_contract_termination_v1;
--   form Sửa HĐ vẫn đổi end_date/room_id/giá bằng contracts.edit đúng như web cho phép; xoá mềm.
--
-- ĐƯỜNG LÙI (một forward migration khác, không phá dữ liệu)
--   DROP TRIGGER IF EXISTS a01_contract_lifecycle_columns_guard ON public.contracts;
--   CREATE OR REPLACE tám hàm bằng thân production = thân trong file này bỏ đúng các dòng mang dấu
--   [q26] (md5 ở tiền kiểm); sau đó DROP FUNCTION app_private.guard_contract_lifecycle_columns_v1()
--   và app_private.require_building_perm_v1(uuid,text,text[]) khi không còn hàm nào gọi.
-- ============================================================

-- 0. Tiền kiểm — không vá mù lên định nghĩa lạ. md5 = pg_get_functiondef đọc trên production
--    (chỉ đọc, 22/10/2026); TEST cùng md5. Bản đã mang dấu [q26] (lượt chạy lại) thì replace lại y hệt.
DO $preflight$
DECLARE
  r record;
  v_def text;
BEGIN
  IF to_regprocedure('public.can_do_on_building(text, text, uuid)') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'Thiếu helper quyền (can_do_on_building / is_super_admin / auth.uid) — DỪNG.' USING ERRCODE = '55000';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('app_private.commission_reason_renew_before_v1(uuid, date, numeric, numeric, text)', 'b2d48b4faf498c7b72ad80f7ee340300'),
    ('public.confirm_contract_return_v1(uuid, uuid, timestamp with time zone, text, date, text, text, jsonb, jsonb, text)', 'e641a41be2388a685e14bbd9fe32c2f8'),
    ('public.finalize_contract_exit_case_v1(uuid, uuid, bigint, text, text, text, jsonb)', '982eb922b884c1fc5fe2284b730fcd9d'),
    ('public.update_contract_exit_case_kind_v1(uuid, uuid, bigint, text, text, text)', '9dd58f437f6aedcc3359b51c4887cc3b'),
    ('public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid, jsonb)', '82a4cdbf74b4c0570d4078cbca78adac'),
    ('public.terminate_contract_forfeit(uuid, date, jsonb)', '20c97cce83ed98d810a157256ddd457f'),
    ('public.approve_contract_termination_v1(uuid, text)', 'e11e106768d7a4430541215c97cfdc1d'),
    ('public.set_contract_move_out_notice_v1(uuid, uuid, timestamp with time zone, date, text)', '57c5945503a2e705b07fbb229c8b0de9')
  ) AS t(sig, md5) LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'Thiếu hàm % — DỪNG.', r.sig USING ERRCODE = '55000';
    END IF;
    v_def := pg_get_functiondef(to_regprocedure(r.sig));
    IF position('[q26] kiểm quyền máy chủ khớp web' IN v_def) > 0 THEN
      CONTINUE;
    END IF;
    IF md5(v_def) <> r.md5 THEN
      RAISE EXCEPTION '% KHÁC bản đã đối chiếu (md5 %, chờ %) — DỪNG, đọc pg_get_functiondef trước khi replace.', r.sig, md5(v_def), r.md5
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$preflight$;

-- 1. Hàm kiểm quyền dùng chung (luật 17/10: công thức quyền dùng ≥ 2 nơi đặt trong database).
--    Hỏi đúng khoá mà web hỏi bằng canUse(perms, module, action): cùng nguồn can_do_on_building
--    (= RLS buildings_for_v3 + super admin + chặn tài khoản đã nghỉ), nhưng theo ĐÚNG toà của bản
--    ghi. Nhiều khoá = chỉ cần một (web huỷ hoá đơn: invoices.cancel HOẶC invoices.delete).
--    Toà NULL chỉ qua được với super admin (fail-closed cho người thường).
CREATE OR REPLACE FUNCTION app_private.require_building_perm_v1(p_building_id uuid, p_viec text, VARIADIC p_permission_keys text[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_key text;
  v_keys text := array_to_string(p_permission_keys, '|');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '[THIEU_QUYEN] Bạn chưa đăng nhập.' USING ERRCODE = '42501';
  END IF;
  IF coalesce(cardinality(p_permission_keys), 0) = 0
     OR EXISTS (SELECT 1 FROM unnest(p_permission_keys) k WHERE k IS NULL OR k !~ '^[a-z_]+\.[a-z_]+$') THEN
    RAISE EXCEPTION 'require_building_perm_v1: khoá quyền không hợp lệ (%)', v_keys USING ERRCODE = '22023';
  END IF;
  IF p_building_id IS NOT NULL OR COALESCE(public.is_super_admin(), false) THEN
    FOREACH v_key IN ARRAY p_permission_keys LOOP
      IF COALESCE(public.can_do_on_building(split_part(v_key, '.', 1), split_part(v_key, '.', 2), p_building_id), false) THEN
        RETURN;
      END IF;
    END LOOP;
  END IF;
  RAISE EXCEPTION '[THIEU_QUYEN:%] Bạn không có quyền % ở toà nhà này.', v_keys, coalesce(nullif(btrim(p_viec), ''), v_keys)
    USING ERRCODE = '42501',
          HINT = format('Cần quyền %s ở toà này (giống nút trên web). Nhờ chủ hoặc quản trị cấp quyền trong Phân quyền.',
                        replace(v_keys, '|', ' hoặc '));
END
$fn$;

COMMENT ON FUNCTION app_private.require_building_perm_v1(uuid, text, text[]) IS
  'Câu 26 (chủ chốt 21/10/2026): kiểm quyền máy chủ khớp đúng khoá web của thao tác (contracts.terminate, contracts.renew, invoices.cancel|invoices.delete, invoices.record_payment) theo toà của bản ghi. Không đủ ⇒ 42501 [THIEU_QUYEN:<khoá>] + HINT tiếng Việt. Chỉ gọi từ hàm SECURITY DEFINER, SAU rào quyền cũ — thêm điều kiện, không thay rào cũ.';

REVOKE ALL ON FUNCTION app_private.require_building_perm_v1(uuid, text, text[]) FROM PUBLIC, anon, authenticated, service_role;

-- 2.1 app_private.commission_reason_renew_before_v1: thêm 'contracts.renew' (thân production giữ nguyên từng chữ, md5 b2d48b4f…)
CREATE OR REPLACE FUNCTION app_private.commission_reason_renew_before_v1(p_contract_id uuid, p_new_end_date date, p_new_rent_price numeric DEFAULT NULL::numeric, p_new_deposit numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_room uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  SELECT room_id INTO v_room FROM public.contracts
   WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT (
    public.is_super_admin()
    OR (v_room IS NOT NULL AND public.can_do_on_building('contracts','edit',
          (SELECT building_id FROM public.rooms WHERE id = v_room)))
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên hợp đồng này' USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.require_building_perm_v1((SELECT building_id FROM public.rooms WHERE id = v_room), 'gia hạn hợp đồng', 'contracts.renew'); -- [q26] kiểm quyền máy chủ khớp web
  RETURN public.renew_contract_impl(p_contract_id, p_new_end_date, p_new_rent_price, p_new_deposit, p_notes);
END $function$;

-- 2.2 public.confirm_contract_return_v1: thêm 'contracts.terminate' (thân production giữ nguyên từng chữ, md5 e641a41b…)
CREATE OR REPLACE FUNCTION public.confirm_contract_return_v1(p_organization_id uuid, p_contract_id uuid, p_expected_contract_updated_at timestamp with time zone, p_idempotency_key text, p_actual_move_out_on date, p_initial_kind text, p_settlement_mode text, p_settlement jsonb DEFAULT NULL::jsonb, p_meter_boundary jsonb DEFAULT NULL::jsonb, p_return_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE c public.contracts%ROWTYPE; v_room public.rooms%ROWTYPE; v_building public.buildings%ROWTYPE;
  e public.contract_exit_cases%ROWTYPE; v_key text:=btrim(p_idempotency_key); v_hash text; v_result jsonb; v_legacy uuid; v_party jsonb; v_customer text;
  v_return_note text:=NULLIF(btrim(p_return_note,E' \t\n\r\f'||chr(11)),'');
BEGIN
  IF v_return_note IS NULL THEN
    RAISE EXCEPTION 'Vui lòng nhập nội dung thanh lý để đối chiếu sau này' USING ERRCODE='22023';
  END IF;
  IF p_actual_move_out_on IS NULL OR p_initial_kind IS NULL OR p_initial_kind NOT IN ('NATURAL_EXPIRY','EARLY_RETURN','FORFEIT')
    OR p_settlement_mode IS NULL OR p_settlement_mode NOT IN ('DEFERRED','IMMEDIATE') OR v_key IS NULL
    OR v_key!~'^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN RAISE EXCEPTION 'Actual date, initial kind, mode and request key are required' USING ERRCODE='22023'; END IF;
  IF (p_settlement_mode='DEFERRED' AND p_settlement IS NOT NULL) OR (p_settlement_mode='IMMEDIATE' AND jsonb_typeof(p_settlement) IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'Settlement payload does not match return mode' USING ERRCODE='22023';
  END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Organization is outside the writable scope' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO c FROM public.contracts WHERE id=p_contract_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contract not found' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id=c.room_id;
  SELECT * INTO v_building FROM public.buildings WHERE id=v_room.building_id;
  IF v_room.organization_id IS DISTINCT FROM c.organization_id OR v_building.organization_id IS DISTINCT FROM c.organization_id THEN
    RAISE EXCEPTION 'Contract room scope mismatch' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(c.organization_id,v_room.building_id);
  PERFORM app_private.require_building_perm_v1(v_room.building_id, 'trả phòng / thanh lý hợp đồng', 'contracts.terminate'); -- [q26] kiểm quyền máy chủ khớp web
  v_hash:=md5(jsonb_build_object('contract_id',p_contract_id,'expected_updated_at',p_expected_contract_updated_at,'actual_date',p_actual_move_out_on,
    'initial_kind',p_initial_kind,'mode',p_settlement_mode,'settlement',p_settlement,'meter_boundary',p_meter_boundary,'return_note',v_return_note)::text);
  SELECT * INTO e FROM public.contract_exit_cases WHERE contract_id=p_contract_id FOR UPDATE;
  IF FOUND THEN
    IF e.physical_actor=auth.uid() AND e.physical_idempotency_key=v_key THEN
      IF e.physical_payload_hash<>v_hash THEN RAISE EXCEPTION 'Request key reused with different return intent' USING ERRCODE='23505'; END IF;
      RETURN app_private.contract_exit_case_response_v1(e.id);
    END IF;
    RAISE EXCEPTION 'Contract has already been physically returned' USING ERRCODE='PT409';
  END IF;
  IF p_expected_contract_updated_at IS NULL OR c.updated_at IS DISTINCT FROM p_expected_contract_updated_at THEN
    RAISE EXCEPTION 'Contract changed; reload before returning' USING ERRCODE='PT409'; END IF;
  IF p_actual_move_out_on>public.org_today_v1(p_organization_id) THEN
    RAISE EXCEPTION 'Actual return date cannot be in the future; use a planned notice' USING ERRCODE='22023'; END IF;
  IF c.status NOT IN ('ACTIVE','EXTENDED') OR c.room_id IS NULL OR c.actual_end_date IS NOT NULL OR p_actual_move_out_on<c.start_date
    OR EXISTS(SELECT 1 FROM public.contract_terminations t WHERE t.contract_id=c.id) THEN
    RAISE EXCEPTION 'Contract is not eligible for an actual return' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM public.contract_customers cc JOIN public.customers cu ON cu.id=cc.customer_id
    WHERE cc.contract_id=c.id AND cu.organization_id IS DISTINCT FROM c.organization_id) THEN
    RAISE EXCEPTION 'Party scope mismatch' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object('tenant_id',c.tenant_id,'parent_contract_id',c.parent_contract_id,
    'customers',COALESCE((SELECT jsonb_agg(jsonb_build_object('customer_id',cc.customer_id,'is_representative',cc.is_representative) ORDER BY cc.customer_id)
      FROM public.contract_customers cc WHERE cc.contract_id=c.id),'[]'::jsonb),
    'tenants',COALESCE((SELECT jsonb_agg(ct.tenant_id ORDER BY ct.tenant_id) FROM public.contract_tenants ct WHERE ct.contract_id=c.id),'[]'::jsonb)) INTO v_party;
  SELECT cu.full_name INTO v_customer FROM public.contract_customers cc JOIN public.customers cu ON cu.id=cc.customer_id
    WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.customer_id LIMIT 1;
  INSERT INTO public.contract_exit_cases(organization_id,building_id,contract_id,room_at_handover_id,actual_move_out_on,initial_kind,current_kind,
    settlement_mode,party_snapshot,physical_actor,physical_idempotency_key,physical_payload_hash,contract_number,building_name,room_name,customer_name,return_note)
    VALUES(c.organization_id,v_room.building_id,c.id,c.room_id,p_actual_move_out_on,p_initial_kind,p_initial_kind,
      p_settlement_mode,v_party,auth.uid(),v_key,v_hash,c.contract_number,v_building.name,v_room.name,v_customer,v_return_note) RETURNING * INTO e;
  -- Pass listings belong to the departing occupancy. A retry exits above, so it
  -- cannot retire a listing created for the next tenant after this handover.
  UPDATE public.room_pass_listings SET active=false,updated_at=clock_timestamp()
    WHERE room_id=c.room_id AND active
      AND (organization_id=c.organization_id OR (organization_id IS NULL AND user_id=c.user_id));
  IF p_settlement_mode='DEFERRED' THEN
    -- Absolutely no call to a financial/termination writer in this branch.
    UPDATE public.contracts SET status='TERMINATED',actual_end_date=p_actual_move_out_on,updated_at=clock_timestamp() WHERE id=c.id;
  ELSE
    v_result:=app_private.run_contract_exit_settlement_v1(e.id,p_initial_kind,p_settlement,v_key,false);
    SELECT id INTO v_legacy FROM public.contract_terminations WHERE contract_id=c.id AND actual_move_out_date=p_actual_move_out_on AND status='COMPLETED';
    IF v_legacy IS NULL THEN RAISE EXCEPTION 'Settlement did not record its financial audit' USING ERRCODE='55000'; END IF;
    UPDATE public.contract_exit_cases SET state='FINALIZED',version=version+1,updated_at=clock_timestamp(),finalized_at=clock_timestamp(),
      settlement_actor=auth.uid(),settlement_idempotency_key=v_key,settlement_payload_hash=v_hash,settlement_result=v_result,legacy_termination_id=v_legacy WHERE id=e.id;
  END IF;
  PERFORM app_private.record_contract_meter_boundary_set_v1(c.organization_id,c.id,c.room_id,'MOVE_OUT',p_actual_move_out_on,
    COALESCE(p_meter_boundary,jsonb_build_object('state','MISSING','reason','Chưa ghi chỉ số khi trả phòng','readings','[]'::jsonb)));
  RETURN app_private.contract_exit_case_response_v1(e.id);
END $function$;

-- 2.3 public.finalize_contract_exit_case_v1: thêm 'contracts.terminate' (thân production giữ nguyên từng chữ, md5 982eb922…)
CREATE OR REPLACE FUNCTION public.finalize_contract_exit_case_v1(p_organization_id uuid, p_case_id uuid, p_expected_version bigint, p_idempotency_key text, p_current_kind text, p_reason text, p_settlement jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE e public.contract_exit_cases%ROWTYPE; c public.contracts%ROWTYPE; v_contract uuid; v_key text:=btrim(p_idempotency_key); v_hash text; v_result jsonb; v_legacy uuid;
BEGIN
  IF v_key IS NULL OR v_key!~'^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' OR p_current_kind IS NULL
    OR p_current_kind NOT IN ('NATURAL_EXPIRY','EARLY_RETURN','FORFEIT') THEN RAISE EXCEPTION 'Invalid settlement request' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Organization is outside the writable scope' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT contract_id INTO v_contract FROM public.contract_exit_cases WHERE id=p_case_id AND organization_id=p_organization_id;
  SELECT * INTO c FROM public.contracts WHERE id=v_contract AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_case_id AND organization_id=p_organization_id FOR UPDATE;
  IF e.id IS NULL OR c.id IS NULL THEN RAISE EXCEPTION 'Exit case not found' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(e.organization_id,e.building_id);
  PERFORM app_private.require_building_perm_v1(e.building_id, 'quyết toán thanh lý hợp đồng', 'contracts.terminate'); -- [q26] kiểm quyền máy chủ khớp web
  v_hash:=md5(jsonb_build_object('case_id',e.id,'expected_version',p_expected_version,'current_kind',p_current_kind,'reason',p_reason,'settlement',p_settlement)::text);
  IF e.state='FINALIZED' THEN
    IF e.settlement_actor=auth.uid() AND e.settlement_idempotency_key=v_key THEN
      IF e.settlement_payload_hash<>v_hash THEN RAISE EXCEPTION 'Request key reused with different settlement intent' USING ERRCODE='23505'; END IF;
      RETURN app_private.contract_exit_case_response_v1(e.id);
    END IF;
    RAISE EXCEPTION 'Exit case is already finalized' USING ERRCODE='PT409';
  END IF;
  IF p_expected_version IS NULL OR e.version<>p_expected_version THEN RAISE EXCEPTION 'Exit case changed; reload' USING ERRCODE='PT409'; END IF;
  IF c.status<>'TERMINATED' OR c.organization_id IS DISTINCT FROM e.organization_id OR c.room_id IS DISTINCT FROM e.room_at_handover_id
    OR c.actual_end_date IS DISTINCT FROM e.actual_move_out_on THEN RAISE EXCEPTION 'Physical exit identity changed' USING ERRCODE='55000'; END IF;
  IF e.current_kind IS DISTINCT FROM p_current_kind AND NULLIF(btrim(p_reason),'') IS NULL THEN
    RAISE EXCEPTION 'A kind change requires a reason' USING ERRCODE='22023'; END IF;
  -- Same contract, same pinned party. Never authorize a current occupant by room.
  IF e.party_snapshot IS DISTINCT FROM jsonb_build_object('tenant_id',c.tenant_id,'parent_contract_id',c.parent_contract_id,
    'customers',COALESCE((SELECT jsonb_agg(jsonb_build_object('customer_id',cc.customer_id,'is_representative',cc.is_representative) ORDER BY cc.customer_id)
      FROM public.contract_customers cc WHERE cc.contract_id=c.id),'[]'::jsonb),
    'tenants',COALESCE((SELECT jsonb_agg(ct.tenant_id ORDER BY ct.tenant_id) FROM public.contract_tenants ct WHERE ct.contract_id=c.id),'[]'::jsonb)) THEN
    RAISE EXCEPTION 'Exit party lineage needs review' USING ERRCODE='55000'; END IF;
  PERFORM app_private.assert_contract_transfer_exit_terms_v1(e.id,p_current_kind,p_settlement);
  v_result:=app_private.run_contract_exit_settlement_v1(e.id,p_current_kind,p_settlement,v_key,true);
  SELECT id INTO v_legacy FROM public.contract_terminations WHERE contract_id=c.id AND actual_move_out_date=e.actual_move_out_on AND status='COMPLETED';
  IF v_legacy IS NULL THEN RAISE EXCEPTION 'Settlement did not record its financial audit' USING ERRCODE='55000'; END IF;
  IF e.current_kind IS DISTINCT FROM p_current_kind THEN
    INSERT INTO app_private.contract_exit_kind_history(case_id,before_kind,after_kind,reason,version,actor_id,idempotency_key,payload_hash)
      VALUES(e.id,e.current_kind,p_current_kind,btrim(p_reason),e.version+1,auth.uid(),v_key,v_hash);
  END IF;
  UPDATE public.contract_exit_cases SET current_kind=p_current_kind,state='FINALIZED',version=version+1,updated_at=clock_timestamp(),finalized_at=clock_timestamp(),
    settlement_actor=auth.uid(),settlement_idempotency_key=v_key,settlement_payload_hash=v_hash,settlement_result=v_result,legacy_termination_id=v_legacy WHERE id=e.id;
  RETURN app_private.contract_exit_case_response_v1(e.id);
END $function$;

-- 2.4 public.update_contract_exit_case_kind_v1: thêm 'contracts.terminate' (thân production giữ nguyên từng chữ, md5 9dd58f43…)
CREATE OR REPLACE FUNCTION public.update_contract_exit_case_kind_v1(p_organization_id uuid, p_case_id uuid, p_expected_version bigint, p_kind text, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE e public.contract_exit_cases%ROWTYPE; h app_private.contract_exit_kind_history%ROWTYPE; v_key text:=btrim(p_idempotency_key); v_hash text;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('NATURAL_EXPIRY','EARLY_RETURN','FORFEIT') OR NULLIF(btrim(p_reason),'') IS NULL
    OR v_key IS NULL OR v_key!~'^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN RAISE EXCEPTION 'Kind, reason and request key are required' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Organization is outside the writable scope' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_case_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exit case not found' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(e.organization_id,e.building_id);
  PERFORM app_private.require_building_perm_v1(e.building_id, 'đổi loại thanh lý hợp đồng', 'contracts.terminate'); -- [q26] kiểm quyền máy chủ khớp web
  v_hash:=md5(jsonb_build_object('case_id',p_case_id,'expected_version',p_expected_version,'kind',p_kind,'reason',btrim(p_reason))::text);
  SELECT * INTO h FROM app_private.contract_exit_kind_history WHERE case_id=e.id AND actor_id=auth.uid() AND idempotency_key=v_key;
  IF FOUND THEN
    IF h.payload_hash<>v_hash THEN RAISE EXCEPTION 'Request key reused with different kind change' USING ERRCODE='23505'; END IF;
    RETURN app_private.contract_exit_case_response_v1(e.id);
  END IF;
  IF p_expected_version IS NULL OR e.version<>p_expected_version OR e.state<>'PENDING' THEN RAISE EXCEPTION 'Exit case changed or finalized' USING ERRCODE='PT409'; END IF;
  INSERT INTO app_private.contract_exit_kind_history(case_id,before_kind,after_kind,reason,version,actor_id,idempotency_key,payload_hash)
    VALUES(e.id,e.current_kind,p_kind,btrim(p_reason),e.version+1,auth.uid(),v_key,v_hash);
  UPDATE public.contract_exit_cases SET current_kind=p_kind,version=version+1,updated_at=clock_timestamp() WHERE id=e.id;
  RETURN app_private.contract_exit_case_response_v1(e.id);
END $function$;

-- 2.5 public.terminate_contract_move_out: thêm 'contracts.terminate' (thân production giữ nguyên từng chữ, md5 82a4cdbf…)
CREATE OR REPLACE FUNCTION public.terminate_contract_move_out(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT '[]'::jsonb, p_shortfall_mode text DEFAULT 'PAID'::text, p_receipt_account_id uuid DEFAULT NULL::uuid, p_refund_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_room uuid;
  v_org uuid;
  v_owner uuid;
  v_building uuid;
  v_deposit_paid numeric;
  v_extra numeric := 0;
  v_cash_shortfall numeric := 0;
  v_receipt_account uuid;
  v_cash_authz boolean;
  v_core_writer boolean;
  v_opened_writer boolean := false;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT
    contract_row.room_id,
    contract_row.organization_id,
    contract_row.user_id,
    room_row.building_id,
    contract_row.deposit_paid
    INTO v_room, v_org, v_owner, v_building, v_deposit_paid
  FROM public.contracts contract_row
  LEFT JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF NOT (
    public.is_super_admin()
    OR (
      v_room IS NOT NULL
      AND public.can_do_on_building(
        'contracts', 'edit',
        (SELECT room_row.building_id
         FROM public.rooms room_row
         WHERE room_row.id = v_room)
      )
    )
  ) THEN
    RAISE EXCEPTION 'Missing permission to terminate contract'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.require_building_perm_v1(v_building, 'thanh lý hợp đồng', 'contracts.terminate'); -- [q26] kiểm quyền máy chủ khớp web

  IF p_receipt_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.accounts account_row
    WHERE account_row.id = p_receipt_account_id
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
  ) THEN
    RAISE EXCEPTION 'Receipt account is outside the contract organization or is not a real active cashbook'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(sum((entry->>'amount')::numeric), 0)
      INTO v_extra
    FROM jsonb_array_elements(COALESCE(p_extra_charges, '[]'::jsonb)) item(entry)
    WHERE NULLIF(entry->>'amount', '') IS NOT NULL
      AND (entry->>'amount')::numeric > 0;
  END IF;

  v_cash_shortfall := GREATEST(
    COALESCE(p_outstanding_debt, 0)
      + COALESCE(p_penalty_fee, 0)
      + v_extra
      - LEAST(
          GREATEST(COALESCE(p_deposit_refund, 0), 0),
          COALESCE(v_deposit_paid, 0)
        )
      - GREATEST(COALESCE(p_excess_rent, 0), 0)
      - COALESCE((
          SELECT SUM((entry->>'amount')::numeric)
          FROM jsonb_array_elements(COALESCE(p_refund_items, '[]'::jsonb)) item(entry)
          WHERE jsonb_typeof(COALESCE(p_refund_items, '[]'::jsonb)) = 'array'
            AND NULLIF(entry->>'amount', '') IS NOT NULL
            AND (entry->>'amount')::numeric > 0
        ), 0),
    0
  );

  IF upper(COALESCE(p_shortfall_mode, 'PAID')) = 'PAID'
     AND v_cash_shortfall > 0 THEN
    v_receipt_account := COALESCE(
      p_receipt_account_id,
      public._collector_thu_account(auth.uid()),
      public._termination_pick_account(v_owner, v_building)
    );

    IF v_receipt_account IS NULL THEN
      RAISE EXCEPTION 'Cannot resolve an active real receipt account in the contract organization'
        USING ERRCODE = '42501';
    END IF;
    PERFORM 1
    FROM public.accounts account_row
    WHERE account_row.id = v_receipt_account
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cannot resolve an active real receipt account in the contract organization'
        USING ERRCODE = '42501';
    END IF;

    PERFORM app_private.lock_org_for_decision_v1(v_org);
    SELECT decision.allowed
      INTO v_cash_authz
    FROM app_private.authorize_tenant_action_v3(
      auth.uid(), v_org, 'thu_tien.collect', v_building, v_receipt_account
    ) decision;
    IF NOT COALESCE(v_cash_authz, false) THEN
      RAISE EXCEPTION 'Missing receipt permission or cashbook possession for termination collection'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_receipt_account := p_receipt_account_id;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  IF NOT v_core_writer THEN
    PERFORM app_private.assert_contract_has_no_customer_credit_v1(
      p_contract_id, v_org
    );
    PERFORM app_private.begin_accounting_chain_write_v1();
    v_opened_writer := true;
  END IF;

  INSERT INTO app_private.termination_move_out_writer_context (
    transaction_id, backend_pid, organization_id, user_id,
    contract_id, building_id, room_id, move_out_date, opened_at
  ) VALUES (
    txid_current(), pg_backend_pid(), v_org, v_owner,
    p_contract_id, v_building, v_room, p_move_out_date, clock_timestamp()
  ) ON CONFLICT (transaction_id, backend_pid) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_id = EXCLUDED.user_id,
      contract_id = EXCLUDED.contract_id,
      building_id = EXCLUDED.building_id,
      room_id = EXCLUDED.room_id,
      move_out_date = EXCLUDED.move_out_date,
      opened_at = EXCLUDED.opened_at;

  BEGIN
    v_result := public.terminate_contract_move_out_impl(
      p_contract_id, p_move_out_date, COALESCE(p_deposit_refund, 0),
      COALESCE(p_penalty_fee, 0), COALESCE(p_excess_rent, 0),
      COALESCE(p_outstanding_debt, 0), p_notes,
      COALESCE(p_extra_charges, '[]'::jsonb),
      COALESCE(p_shortfall_mode, 'PAID'), v_receipt_account,
      COALESCE(p_refund_items, '[]'::jsonb)
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM app_private.termination_move_out_writer_context
    WHERE transaction_id = txid_current()
      AND backend_pid = pg_backend_pid();
    IF v_opened_writer THEN
      PERFORM app_private.end_accounting_chain_write_v1();
    END IF;
    RAISE;
  END;

  DELETE FROM app_private.termination_move_out_writer_context
  WHERE transaction_id = txid_current()
    AND backend_pid = pg_backend_pid();

  IF v_opened_writer THEN
    PERFORM app_private.end_accounting_chain_write_v1();
  END IF;
  RETURN v_result;
END;
$function$;

-- 2.6 public.terminate_contract_forfeit: thêm 'contracts.terminate' (thân production giữ nguyên từng chữ, md5 20c97cce…)
CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_room uuid;
  v_org uuid;
  v_core_writer boolean;
  v_opened_writer boolean := false;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT contract_row.room_id, contract_row.organization_id
    INTO v_room, v_org
  FROM public.contracts contract_row
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF NOT (
    public.is_super_admin()
    OR (
      v_room IS NOT NULL
      AND public.can_do_on_building(
        'contracts', 'edit',
        (SELECT room_row.building_id
         FROM public.rooms room_row
         WHERE room_row.id = v_room)
      )
    )
  ) THEN
    RAISE EXCEPTION 'Missing permission to terminate contract'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.require_building_perm_v1((SELECT room_row.building_id FROM public.rooms room_row WHERE room_row.id = v_room), 'thanh lý hợp đồng (bỏ cọc)', 'contracts.terminate'); -- [q26] kiểm quyền máy chủ khớp web

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  IF NOT v_core_writer THEN
    PERFORM app_private.assert_contract_has_no_customer_credit_v1(
      p_contract_id, v_org
    );
    PERFORM app_private.begin_accounting_chain_write_v1();
    v_opened_writer := true;
  END IF;

  BEGIN
    v_result := public.terminate_contract_forfeit_impl(
      p_contract_id, p_forfeit_date, COALESCE(p_extra_charges, '[]'::jsonb)
    );
  EXCEPTION WHEN OTHERS THEN
    IF v_opened_writer THEN
      PERFORM app_private.end_accounting_chain_write_v1();
    END IF;
    RAISE;
  END;

  IF v_opened_writer THEN
    PERFORM app_private.end_accounting_chain_write_v1();
  END IF;
  RETURN v_result;
END;
$function$;

-- 2.7 public.approve_contract_termination_v1: thêm 'contracts.terminate' (thân production giữ nguyên từng chữ, md5 e11e1067…)
CREATE OR REPLACE FUNCTION public.approve_contract_termination_v1(p_termination_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_term public.contract_terminations%rowtype;
  v_contract public.contracts%rowtype;
  v_building uuid;
  v_refund numeric;
  v_refund_raw numeric;
  v_deposit_real numeric;
  v_capped boolean := false;
  v_notes text;
  v_type_id uuid;
  v_voucher_id uuid;
  v_voucher_kind text;
  v_type_names text[];
  v_desc text;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_term from public.contract_terminations
   where id = p_termination_id for update;
  if not found then
    raise exception 'Không tìm thấy yêu cầu thanh lý hoặc bạn không có quyền' using errcode = '42501';
  end if;

  select * into v_contract from public.contracts
   where id = v_term.contract_id for update;
  if not found then
    raise exception 'Hợp đồng của yêu cầu thanh lý không còn tồn tại';
  end if;

  -- contracts KHÔNG có cột building_id — toà suy qua phòng (helper chuẩn RLS).
  v_building := public.building_of_contract(v_contract.id);
  if not (public.is_super_admin()
          or public.can_do_on_building('contracts', 'edit', v_building)) then
    raise exception 'Không có quyền duyệt thanh lý hợp đồng này' using errcode = '42501';
  end if;
  perform app_private.require_building_perm_v1(v_building, 'duyệt thanh lý hợp đồng', 'contracts.terminate'); -- [q26] kiểm quyền máy chủ khớp web

  if v_term.status = 'COMPLETED' then
    return jsonb_build_object('termination_id', v_term.id, 'status', 'COMPLETED',
                              'voucher_id', null, 'noop', true);
  end if;

  -- [P0a 21/10/2026] Chỉ duyệt hồ sơ của hợp đồng CÒN HIỆU LỰC. Hợp đồng đã trả
  -- phòng / đã thanh lý thì tiền đã (hoặc sẽ) quyết toán ở màn Trả phòng /
  -- Quyết toán; duyệt thêm ở đây là ghi phiếu hoàn/thu lần hai, và dòng hồ sơ
  -- chen vào còn chiếm UNIQUE(contract_id) của finalize_contract_exit_case_v1.
  -- Kiểm SAU khoá hợp đồng (FOR UPDATE ở trên): confirm_contract_return_v1 khoá
  -- cùng dòng trước khi ghi ca trả phòng, nên không chen được giữa hai bước.
  if coalesce(v_contract.status::text, '') not in ('ACTIVE', 'EXTENDED')
     or v_contract.actual_end_date is not null
     or v_contract.deleted_at is not null
     or exists (select 1 from public.contract_exit_cases e
                 where e.contract_id = v_contract.id) then
    raise exception '[TERMINATION_CONTRACT_CLOSED] Hợp đồng % đã trả phòng hoặc đã thanh lý (trạng thái %) — không duyệt thêm hồ sơ thanh lý, vì sẽ ghi phiếu hoàn/thu lần hai. Quyết toán làm ở màn Trả phòng / Quyết toán.',
      coalesce(v_contract.contract_number, left(v_contract.id::text, 8)), v_contract.status
      using errcode = '55000';
  end if;

  select coalesce(nullif(btrim(full_name), ''), nullif(btrim(email), ''), 'Người dùng')
    into v_actor_name from public.profiles where id = v_actor;

  -- 1-3: chuỗi trạng thái (giữ nguyên thứ tự legacy, nay atomic trong 1 tx)
  update public.contract_terminations
     set status = 'APPROVED', approved_by = v_actor, approved_at = now()
   where id = v_term.id;

  update public.contracts
     set status = 'TERMINATED', updated_at = now()
   where id = v_contract.id;

  update public.contract_terminations
     set status = 'COMPLETED', refund_date = now()
   where id = v_term.id;

  -- 4: bút toán tiền (thay cash_book đã chết) — phiếu NHÁP chờ kế toán
  --
  -- [H2.3a] contract_terminations.refund_amount là cột GENERATED:
  --     refund_amount = total_deposit − (công nợ + tiền thuê + phí + …)
  -- total_deposit là cọc GHI TRÊN HỒ SƠ, không phải cọc đã vào két. Ký cọc
  -- 10tr, mới đóng 4tr, không khấu trừ gì ⇒ cột ra 10tr và phiếu chi cũ ghi
  -- đúng 10tr: chi ra 6tr chưa từng thu. preview_termination_refund_v1 đã báo
  -- đúng việc này (VUOT_COC_THAT) nhưng chỉ là cảnh báo trên màn hình, writer
  -- vẫn ghi theo cột. Nay kẹp cứng ở writer theo cọc THỰC NHẬN.
  --
  -- Chỉ KẸP, không tính lại: kẹp là chặn trên đơn điệu, không bao giờ ghi
  -- nhiều hơn hôm nay. Phần chênh còn lại (khấu trừ vốn đã trừ trên cọc thoả
  -- thuận) là bài toán của đường thanh lý mới — đợt 4 plan 2 hoàn cọc đang tạm
  -- dừng theo quyết định chủ 28/08/2026.
  v_refund_raw := coalesce(v_term.refund_amount, 0);
  v_refund := v_refund_raw;
  if v_refund > 0 then
    v_deposit_real := coalesce(public.contract_deposit_paid_derived(v_contract.id), 0);
    if v_refund > v_deposit_real then
      v_refund := v_deposit_real;
      v_capped := true;
    end if;
  end if;

  v_notes := nullif(btrim(coalesce(p_note, '')), '');
  if v_capped then
    v_notes := coalesce(v_notes || E'\n', '')
      || '[Kẹp theo cọc thực nhận] Hồ sơ thanh lý tính hoàn '
      || round(v_refund_raw)::bigint || 'đ theo cọc thoả thuận, nhưng cọc THỰC NHẬN '
      || 'của hợp đồng chỉ có ' || round(v_deposit_real)::bigint
      || 'đ. Phiếu ghi theo cọc thực nhận. Chênh '
      || round(v_refund_raw - v_deposit_real)::bigint
      || 'đ là khoản chưa từng vào két — muốn hoàn thì phải có phiếu thu cọc đứng sau.';
  end if;

  if v_refund <> 0 then
    if v_refund > 0 then
      v_voucher_kind := 'EXPENSE';
      v_type_names := array['Hoàn cọc / tiền thừa khi thanh lý',
                            'Hoàn trả thanh lý',
                            'Hoàn cọc thanh lý',
                            'Hoàn tiền thừa thanh lý'];
      v_desc := 'Hoàn cọc thanh lý hợp đồng';
    else
      v_voucher_kind := 'INCOME';
      v_type_names := array['Thu thanh lý (khách trả thêm)',
                            'Doanh thu thanh lý'];
      v_desc := 'Thu thêm từ thanh lý hợp đồng';
    end if;

    -- Resolve hạng mục trong org theo thứ tự ưu tiên; trùng tên → bản cũ nhất.
    select t.id into v_type_id
      from public.income_expense_types t
     where t.organization_id = v_term.organization_id
       and lower(t.type) = lower(v_voucher_kind)
       and t.name = any (v_type_names)
     order by array_position(v_type_names, t.name), t.created_at
     limit 1;
    if v_type_id is null then
      raise exception 'Org chưa có hạng mục "%" cho bút toán thanh lý — tạo hạng mục rồi duyệt lại',
        v_type_names[1];
    end if;

    insert into public.income_expenses (
      user_id, creator_name, type, name,
      building_id, room_id, contract_id, account_id,
      payer_name, approval_status, voucher_date, attachments,
      notes, organization_id
    ) values (
      v_actor, coalesce(v_actor_name, 'Người dùng'), v_voucher_kind,
      v_desc || ' ' || coalesce(v_contract.contract_number, left(v_contract.id::text, 8)),
      v_building, v_contract.room_id, v_contract.id, null,
      null, 'UNAPPROVED', public.org_today_v1(NULL), '[]'::jsonb,
      v_notes, v_term.organization_id
    ) returning id into v_voucher_id;

    -- [H2.3b] Truyền `amount` tường minh. Hôm nay trigger auto_calc_item_amount
    -- ghi đè amount := quantity * unit_price nên giá trị này trùng khít; đó
    -- đúng là lý do phải viết ra — lúc H3.1 gỡ ghi đè, call-site đã sẵn sàng
    -- chứ không đẻ ra item amount NULL.
    insert into public.income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price, amount, start_date, end_date
    ) values (
      v_voucher_id, v_type_id,
      v_desc || ' (yêu cầu ' || left(v_term.id::text, 8) || ')',
      1, abs(v_refund), abs(v_refund), public.org_today_v1(NULL), public.org_today_v1(NULL)
    );
  end if;

  -- 5: trả phòng
  --
  -- [H2.3c] Trước đây: update rooms set status='AVAILABLE' VÔ ĐIỀU KIỆN. Hai
  -- thứ bị cướp:
  --   · hợp đồng còn hiệu lực KHÁC trên cùng phòng (ở ghép / chồng kỳ) — phòng
  --     đang OCCUPIED bị trả trống dù còn người ở;
  --   · cờ RESERVED của khách kế đã đặt cọc giữ chỗ.
  -- Dòng dưới dùng ĐÚNG predicate NOT EXISTS của trigger
  -- update_room_status_on_contract_change (plan con F sở hữu trigger đó — ở đây
  -- chỉ chép predicate, không sửa trigger), rồi gọi helper chuẩn để dựng lại
  -- RESERVED. recompute_room_reservation tự bỏ qua MAINTENANCE/UNAVAILABLE và
  -- tự nhường phòng còn hợp đồng hiệu lực, nên gọi lại luôn an toàn.
  if v_contract.room_id is not null then
    update public.rooms
       set status = 'AVAILABLE', updated_at = now()
     where id = v_contract.room_id
       and not exists (
         select 1 from public.contracts c
          where c.room_id = v_contract.room_id
            and c.deleted_at is null
            and c.status in ('ACTIVE', 'EXTENDED')
            and c.id <> v_contract.id
       );

    perform public.recompute_room_reservation(v_contract.room_id);
  end if;

  return jsonb_build_object('termination_id', v_term.id, 'status', 'COMPLETED',
                            'voucher_id', v_voucher_id, 'room_id', v_contract.room_id,
                            'refund_amount', v_refund,
                            'refund_amount_requested', v_refund_raw,
                            'refund_capped', v_capped);
end;
$function$;

-- 2.8 public.set_contract_move_out_notice_v1: thêm 'contracts.terminate' (thân production giữ nguyên từng chữ, md5 57c59455…)
CREATE OR REPLACE FUNCTION public.set_contract_move_out_notice_v1(p_organization_id uuid, p_contract_id uuid, p_expected_updated_at timestamp with time zone, p_expected_move_out_date date DEFAULT NULL::date, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_contract public.contracts%ROWTYPE;
  v_building uuid;
  v_allowed boolean;
  v_reason text := nullif(btrim(p_reason), '');
  v_previous date;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'Notice organization unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT c.* INTO v_contract FROM public.contracts c
    JOIN public.rooms r ON r.id = c.room_id AND r.organization_id = c.organization_id
    JOIN public.buildings b ON b.id = r.building_id AND b.organization_id = c.organization_id
    JOIN public.organizations o ON o.id = c.organization_id AND o.status = 'ACTIVE'
    WHERE c.id = p_contract_id AND c.organization_id = p_organization_id
      AND c.deleted_at IS NULL AND r.deleted_at IS NULL AND b.deleted_at IS NULL
      AND public.can_access_building(b.id)
    FOR UPDATE OF c;
  IF NOT FOUND THEN RAISE EXCEPTION 'Notice contract unavailable' USING ERRCODE = '42501'; END IF;
  SELECT building_id INTO v_building FROM public.rooms WHERE id = v_contract.room_id FOR SHARE;
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(
    auth.uid(), p_organization_id, 'contracts.edit', v_building, NULL);
  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION 'Not authorized to edit notice' USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.require_building_perm_v1(v_building, 'báo ngày trả phòng', 'contracts.terminate'); -- [q26] kiểm quyền máy chủ khớp web
  IF v_contract.status <> 'ACTIVE' OR v_contract.actual_end_date IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.contracts newer
       WHERE newer.room_id = v_contract.room_id AND newer.organization_id = p_organization_id
         AND newer.id <> v_contract.id AND newer.status = 'ACTIVE' AND newer.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Contract is no longer current' USING ERRCODE = '55000';
  END IF;
  IF p_expected_updated_at IS NULL OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Notice snapshot changed; reload' USING ERRCODE = 'PT409';
  END IF;
  IF (p_expected_move_out_date IS NOT NULL AND (NOT isfinite(p_expected_move_out_date)
      OR p_expected_move_out_date < v_contract.start_date))
     OR length(v_reason) > 2000 OR (p_expected_move_out_date IS NULL AND v_reason IS NULL) THEN
    RAISE EXCEPTION 'Invalid notice date or reason' USING ERRCODE = '22023';
  END IF;
  v_previous := v_contract.expected_move_out_date;
  IF v_previous IS DISTINCT FROM p_expected_move_out_date THEN
    UPDATE public.contracts SET expected_move_out_date = p_expected_move_out_date,
      updated_at = clock_timestamp() WHERE id = v_contract.id RETURNING * INTO v_contract;
    INSERT INTO public.contract_move_out_notice_events(
      organization_id, contract_id, actor_id, previous_date, new_date, reason, contract_updated_at)
      VALUES (p_organization_id, v_contract.id, auth.uid(), v_previous,
        p_expected_move_out_date, v_reason, v_contract.updated_at);
  END IF;
  RETURN jsonb_build_object('contract_id', v_contract.id, 'organization_id', v_contract.organization_id,
    'expected_move_out_date', v_contract.expected_move_out_date, 'updated_at', v_contract.updated_at,
    'today', public.org_today_v1(v_contract.organization_id), 'status', v_contract.status);
END;
$function$;

-- 3. Sửa trạng thái hợp đồng: đường REST (PATCH bảng contracts bằng JWT) không được đổi cột vòng
--    đời. Web không có màn nào sửa thẳng các cột này — trạng thái/ngày trả phòng thực tế chỉ đổi qua
--    RPC trả phòng/thanh lý (đã kiểm contracts.terminate ở mục 2), báo trả qua
--    set_contract_move_out_notice_v1. WHEN chỉ khớp vai authenticated/anon: writer SECURITY DEFINER
--    (chạy dưới chủ hàm) và service_role đi thẳng như cũ. Hàm trigger không đọc bảng nào nên để
--    SECURITY INVOKER; lúc bắn trigger Postgres không hỏi quyền EXECUTE/USAGE trên app_private.
CREATE OR REPLACE FUNCTION app_private.guard_contract_lifecycle_columns_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.actual_end_date IS DISTINCT FROM OLD.actual_end_date
     OR NEW.expected_move_out_date IS DISTINCT FROM OLD.expected_move_out_date THEN
    RAISE EXCEPTION '[HOP_DONG_VONG_DOI_QUA_RPC] Không sửa thẳng trạng thái / ngày trả phòng của hợp đồng % từ giao diện. Dùng thao tác Báo trả phòng, Trả phòng, Thanh lý hoặc Gia hạn trên trang Hợp đồng.',
      coalesce(OLD.contract_number, left(OLD.id::text, 8))
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION app_private.guard_contract_lifecycle_columns_v1() IS
  'Trigger a01 trên contracts (chỉ đường REST: WHEN current_user là authenticated/anon): chặn đổi thẳng status, actual_end_date, expected_move_out_date — 42501 [HOP_DONG_VONG_DOI_QUA_RPC]. Writer SECURITY DEFINER và service_role không bị ảnh hưởng. Câu 26, 22/10/2026.';

REVOKE ALL ON FUNCTION app_private.guard_contract_lifecycle_columns_v1() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a01_contract_lifecycle_columns_guard ON public.contracts;
CREATE TRIGGER a01_contract_lifecycle_columns_guard
  BEFORE UPDATE OF status, actual_end_date, expected_move_out_date ON public.contracts
  FOR EACH ROW
  WHEN (current_user IN ('authenticated', 'anon'))
  EXECUTE FUNCTION app_private.guard_contract_lifecycle_columns_v1();

-- 4. Tự kiểm (chỉ catalog — chạy được trên database rỗng của Restore Drill).
DO $sau$
DECLARE
  r record;
  v_def text;
  v_n int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('app_private.commission_reason_renew_before_v1(uuid, date, numeric, numeric, text)', 'contracts.renew'),
    ('public.confirm_contract_return_v1(uuid, uuid, timestamp with time zone, text, date, text, text, jsonb, jsonb, text)', 'contracts.terminate'),
    ('public.finalize_contract_exit_case_v1(uuid, uuid, bigint, text, text, text, jsonb)', 'contracts.terminate'),
    ('public.update_contract_exit_case_kind_v1(uuid, uuid, bigint, text, text, text)', 'contracts.terminate'),
    ('public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid, jsonb)', 'contracts.terminate'),
    ('public.terminate_contract_forfeit(uuid, date, jsonb)', 'contracts.terminate'),
    ('public.approve_contract_termination_v1(uuid, text)', 'contracts.terminate'),
    ('public.set_contract_move_out_notice_v1(uuid, uuid, timestamp with time zone, date, text)', 'contracts.terminate')
  ) AS t(sig, perm) LOOP
    v_def := pg_get_functiondef(to_regprocedure(r.sig));
    IF (length(v_def) - length(replace(v_def, '[q26] kiểm quyền máy chủ khớp web', ''))) / length('[q26] kiểm quyền máy chủ khớp web') <> 1
       OR position('app_private.require_building_perm_v1(' IN v_def) = 0
       OR position('''' || r.perm || '''' IN v_def) = 0 THEN
      RAISE EXCEPTION '% chưa có đúng một dòng kiểm % [q26]', r.sig, r.perm USING ERRCODE = '55000';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(r.sig)) THEN
      RAISE EXCEPTION '% phải SECURITY DEFINER', r.sig USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'app_private.require_building_perm_v1(uuid, text, text[])'::regprocedure)
     OR has_function_privilege('authenticated', 'app_private.require_building_perm_v1(uuid, text, text[])', 'EXECUTE')
     OR has_function_privilege('anon', 'app_private.require_building_perm_v1(uuid, text, text[])', 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.require_building_perm_v1(uuid, text, text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'require_building_perm_v1 phải SECURITY DEFINER và không ai ngoài chủ hàm gọi được' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('authenticated', 'app_private.guard_contract_lifecycle_columns_v1()', 'EXECUTE')
     OR has_function_privilege('anon', 'app_private.guard_contract_lifecycle_columns_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated còn EXECUTE trên guard_contract_lifecycle_columns_v1' USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_trigger t
   WHERE NOT t.tgisinternal
     AND t.tgrelid = 'public.contracts'::regclass
     AND t.tgname = 'a01_contract_lifecycle_columns_guard'
     AND t.tgfoid = 'app_private.guard_contract_lifecycle_columns_v1()'::regprocedure
     AND t.tgenabled = 'O'
     AND position('BEFORE UPDATE OF status, actual_end_date, expected_move_out_date ON public.contracts' IN pg_get_triggerdef(t.oid)) > 0
     AND position('WHEN ((CURRENT_USER = ANY (ARRAY[''authenticated''::name, ''anon''::name])))' IN pg_get_triggerdef(t.oid)) > 0;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Thiếu trigger a01_contract_lifecycle_columns_guard (BEFORE UPDATE OF status, actual_end_date, expected_move_out_date; WHEN chỉ authenticated/anon; đang bật)' USING ERRCODE = '55000';
  END IF;
END
$sau$;
