-- Chuyển phòng cùng tòa. Cả hai RPC đều qua lõi ghi lịch sử và trigger hoa hồng.
-- Dùng quyền theo tòa như nút Chuyển phòng; giữ thêm rào contracts.edit đang có.
-- Nguồn thân hàm là baseline transfer_room và adapter báo dọn 20260928035250.
BEGIN;

DO $kiem_truoc$
DECLARE
  f record;
BEGIN
  FOR f IN SELECT * FROM (VALUES
    ('app_private.commission_reason_transfer_room_before_v1(uuid,uuid,numeric,date,text)', '90d6b6cbe3d7525c7e606045d25e93c2', '2a5e58109e5537a84985a60112028188'),
    ('app_private.apply_contract_notice_transition_v1(uuid,uuid,timestamptz,text,text,uuid,text,jsonb)', 'cb98756bf03e6abf05dcdb4604c305d4', 'e038bac107fd6b4bf3adf42ab2231056')
  ) AS sig(name, before_hash, after_hash) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(f.name)
        AND p.prosecdef AND p.provolatile = 'v'
        AND md5(replace(p.prosrc, chr(13), '')) IN (f.before_hash, f.after_hash)
    ) THEN
      RAISE EXCEPTION 'Thân hàm chuyển phòng đã thay đổi hoặc không tồn tại: %', f.name USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF to_regprocedure('app_private.require_building_perm_v1(uuid,text,text[])') IS NULL
     OR to_regprocedure('app_private.room_sale_workflow_fact_v1(uuid,uuid,text,boolean,integer)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu hàm kiểm quyền hoặc trạng thái phòng' USING ERRCODE = '55000';
  END IF;
END $kiem_truoc$;

CREATE OR REPLACE FUNCTION app_private.commission_reason_transfer_room_before_v1(
  p_contract_id    uuid,
  p_new_room_id    uuid,
  p_new_rent_price numeric DEFAULT NULL::numeric,
  p_transfer_date  date    DEFAULT CURRENT_DATE,
  p_notes          text    DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_contract   RECORD;
  v_old_room   uuid;
  v_old_bld    uuid;
  v_new_bld    uuid;
  v_new_status text;
  v_lock_a     uuid;
  v_lock_b     uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  IF p_new_room_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu phòng mới';
  END IF;
  IF p_transfer_date IS NULL THEN
    RAISE EXCEPTION 'Thiếu ngày chuyển phòng' USING ERRCODE = '22023';
  END IF;

  -- Cùng thứ tự khóa tư vấn với adapter báo dọn.
  SELECT c.room_id INTO v_old_room
    FROM public.contracts c
   WHERE c.id = p_contract_id AND c.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;

  v_lock_a := LEAST(COALESCE(v_old_room, p_new_room_id), p_new_room_id);
  v_lock_b := GREATEST(COALESCE(v_old_room, p_new_room_id), p_new_room_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended('room:' || v_lock_a::text, 0));
  IF v_lock_b IS DISTINCT FROM v_lock_a THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
              pg_catalog.hashtextextended('room:' || v_lock_b::text, 0));
  END IF;

  SELECT * INTO v_contract
    FROM public.contracts
   WHERE id = p_contract_id AND deleted_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;
  IF v_contract.room_id IS DISTINCT FROM v_old_room THEN
    RAISE EXCEPTION 'Hợp đồng đã thay đổi; vui lòng tải lại trước khi tiếp tục' USING ERRCODE = 'PT409';
  END IF;

  -- Các writer giữ chỗ và khóa bán cũng khóa dòng rooms. NOWAIT tránh chờ chéo
  -- với writer đang giữ phòng và đang đợi khóa tổ chức do adapter báo dọn giữ.
  PERFORM r.id FROM public.rooms r
    WHERE r.id IN (v_old_room, p_new_room_id) AND r.organization_id = v_contract.organization_id
    ORDER BY r.id FOR NO KEY UPDATE NOWAIT;

  SELECT r.building_id INTO v_old_bld
    FROM public.rooms r JOIN public.buildings b ON b.id = r.building_id AND b.organization_id = r.organization_id
   WHERE r.id = v_old_room AND r.organization_id = v_contract.organization_id;
  IF v_old_bld IS NULL OR NOT (
    COALESCE(public.is_super_admin(), false)
    OR COALESCE(public.can_do_on_building('contracts', 'edit', v_old_bld), false)
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên hợp đồng này' USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.require_building_perm_v1(v_old_bld, 'chuyển phòng', 'contracts.transfer');

  IF v_contract.status NOT IN ('ACTIVE', 'EXTENDED') THEN
    RAISE EXCEPTION 'Chỉ chuyển phòng được khi hợp đồng đang hiệu lực';
  END IF;
  IF p_new_room_id = v_contract.room_id THEN
    RAISE EXCEPTION 'Phòng mới trùng phòng hiện tại';
  END IF;

  IF p_transfer_date < v_contract.start_date THEN
    RAISE EXCEPTION 'Ngày chuyển không được trước ngày bắt đầu hợp đồng' USING ERRCODE = '22023';
  END IF;
  IF p_transfer_date > public.org_today_v1(v_contract.organization_id) THEN
    RAISE EXCEPTION 'Ngày chuyển không được ở tương lai' USING ERRCODE = '22023';
  END IF;
  -- Lịch sử cư trú xếp các lần chuyển đã duyệt/hoàn tất theo ngày vào phòng.
  IF EXISTS (
    SELECT 1 FROM public.contract_transfers tr
     WHERE tr.contract_id = p_contract_id
       AND tr.transfer_type IN ('ROOM_CHANGE', 'BOTH_CHANGE')
       AND tr.status IN ('APPROVED', 'COMPLETED')
       AND COALESCE(tr.move_in_date, tr.transfer_date) >= p_transfer_date
  ) THEN
    RAISE EXCEPTION 'Ngày chuyển phải sau lần chuyển phòng gần nhất' USING ERRCODE = '22023';
  END IF;

  SELECT r.building_id, r.status::text INTO v_new_bld, v_new_status
    FROM public.rooms r JOIN public.buildings b ON b.id = r.building_id AND b.organization_id = r.organization_id
   WHERE r.id = p_new_room_id AND r.organization_id = v_contract.organization_id AND r.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phòng mới không tồn tại';
  END IF;
  IF v_old_bld IS DISTINCT FROM v_new_bld THEN
    RAISE EXCEPTION
      'Phòng mới thuộc toà khác — chuyển phòng chỉ trong cùng một toà. Muốn đổi toà thì thanh lý hợp đồng rồi tạo hợp đồng mới.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.contracts
     WHERE room_id = p_new_room_id
       AND id <> p_contract_id
       AND status IN ('ACTIVE','EXTENDED')
       AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Phòng mới đã có hợp đồng đang hiệu lực';
  END IF;

  -- Trạng thái vật lý AVAILABLE có thể đi kèm giữ chỗ, cọc, khóa bán hoặc đang chuẩn bị.
  IF v_new_status IS DISTINCT FROM 'AVAILABLE' OR NOT EXISTS (
    SELECT 1 FROM app_private.room_sale_workflow_fact_v1(
      p_new_room_id, v_contract.organization_id, v_new_status, false, 0
    ) f WHERE f.sale_state = 'READY'
  ) OR EXISTS (
    -- Phiếu giữ chỗ đời cũ vẫn giữ phòng dù chưa làm đổi trạng thái vật lý.
    SELECT 1 FROM public.room_reservation_holds h
     WHERE h.organization_id = v_contract.organization_id AND h.room_id = p_new_room_id
       AND h.contract_id IS NULL AND h.status IN ('PENDING_APPROVAL', 'APPROVED')
       AND h.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'Phòng mới không còn trống' USING ERRCODE = '55000';
  END IF;

  -- Ghi lịch sử trước khi đổi hợp đồng. Mọi bước cùng một giao dịch.
  INSERT INTO public.contract_transfers (
    user_id, contract_id, transfer_type, transfer_date,
    old_room_id, new_room_id, new_rent_price,
    move_out_date, move_in_date, reason, notes, status, approved_at, approved_by
  ) VALUES (
    v_contract.user_id, p_contract_id, 'ROOM_CHANGE', p_transfer_date,
    v_old_room, p_new_room_id, p_new_rent_price,
    p_transfer_date, p_transfer_date, p_notes, p_notes, 'COMPLETED', NOW(), auth.uid()
  );

  -- 4) Chuyển phòng (GIỮ status ACTIVE/EXTENDED, KHÔNG đụng kỳ hạn) ----------
  UPDATE public.contracts
     SET room_id    = p_new_room_id,
         rent_price = COALESCE(p_new_rent_price, rent_price),
         notes      = CASE
                        WHEN p_notes IS NULL OR length(btrim(p_notes)) = 0 THEN notes
                        WHEN notes  IS NULL OR length(btrim(notes))  = 0 THEN p_notes
                        ELSE notes || E'\n[Chuyển phòng ' || to_char(p_transfer_date,'DD/MM/YYYY') || '] ' || p_notes
                      END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- 5) Đồng bộ trạng thái phòng --------------------------------------------
  IF v_old_room IS NOT NULL AND v_old_room <> p_new_room_id THEN
    UPDATE public.rooms SET status = 'AVAILABLE', updated_at = NOW()
     WHERE id = v_old_room
       AND NOT EXISTS (
         SELECT 1 FROM public.contracts
          WHERE room_id = v_old_room
            AND id <> p_contract_id
            AND status IN ('ACTIVE','EXTENDED')
            AND deleted_at IS NULL
       );
  END IF;

  UPDATE public.rooms SET status = 'OCCUPIED', updated_at = NOW() WHERE id = p_new_room_id;

  RETURN p_contract_id;
END;
$function$;

CREATE OR REPLACE FUNCTION app_private.apply_contract_notice_transition_v1(p_org uuid,p_contract uuid,p_expected_at timestamptz,p_operation text,
  p_choice text,p_request uuid,p_reason text,p_core_args jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.contracts%ROWTYPE;h public.contract_notice_transition_events%ROWTYPE;v_building uuid;v_old_room uuid;v_new_room uuid;
  v_hash text;v_result uuid;v_allowed boolean;v_reason text;v_prior date;v_result_date date;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_org=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501'; END IF;
  IF p_operation IS NULL OR p_operation NOT IN ('RENEW','TRANSFER_ROOM') OR p_choice IS NULL OR p_choice NOT IN ('KEEP','CANCEL')
    OR (p_operation='TRANSFER_ROOM' AND p_choice<>'CANCEL') OR p_request IS NULL OR length(p_reason)>2000 THEN RAISE EXCEPTION 'Cần chọn giữ hoặc hủy báo dọn và mã yêu cầu hợp lệ' USING ERRCODE='22023'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  IF p_operation='TRANSFER_ROOM' THEN
    SELECT room_id INTO v_old_room FROM public.contracts WHERE id=p_contract AND organization_id=p_org AND deleted_at IS NULL;
    v_new_room:=(p_core_args->>'new_room_id')::uuid;
    -- Follow the existing room-transfer lock order; never hold a contract row before its room locks.
    IF v_old_room IS NOT NULL AND v_new_room IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('room:'||LEAST(v_old_room,v_new_room)::text,0));
      IF v_old_room<>v_new_room THEN PERFORM pg_advisory_xact_lock(hashtextextended('room:'||GREATEST(v_old_room,v_new_room)::text,0)); END IF;
    END IF;
  END IF;
  SELECT * INTO c FROM public.contracts WHERE id=p_contract AND organization_id=p_org AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hợp đồng trong tổ chức này' USING ERRCODE='42501'; END IF;
  SELECT building_id INTO v_building FROM public.rooms WHERE id=c.room_id AND organization_id=p_org;
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,'contracts.edit',v_building,NULL);
  IF v_building IS NULL OR NOT COALESCE(public.can_access_building(v_building),false) OR NOT COALESCE(public.can_do_on_building('contracts','edit',v_building),false)
    OR NOT COALESCE(v_allowed,false) THEN RAISE EXCEPTION 'Không có quyền thao tác hợp đồng tại tòa nhà này' USING ERRCODE='42501'; END IF;
  -- Kiểm trước đọc biên nhận, kể cả khi phát lại yêu cầu sau thu hồi quyền.
  IF p_operation = 'TRANSFER_ROOM' THEN
    PERFORM app_private.require_building_perm_v1(v_building, 'chuyển phòng', 'contracts.transfer');
  END IF;
  v_reason:=COALESCE(NULLIF(btrim(p_reason),''),CASE WHEN p_operation='RENEW' THEN CASE WHEN p_choice='KEEP' THEN 'Giữ báo dọn khi gia hạn hợp đồng' ELSE 'Hủy báo dọn khi gia hạn hợp đồng' END ELSE 'Hủy báo dọn phòng cũ khi chuyển phòng' END);
  v_hash:=md5(jsonb_build_object('contract',p_contract,'expected_at',p_expected_at,'operation',p_operation,'choice',p_choice,'reason',v_reason,'args',p_core_args)::text);
  SELECT * INTO h FROM public.contract_notice_transition_events WHERE request_id=p_request;
  IF FOUND THEN
    IF h.organization_id<>p_org OR h.contract_id<>p_contract OR h.actor_id<>auth.uid() OR h.intent_hash<>v_hash THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng cho dữ kiện khác' USING ERRCODE='23505'; END IF;
    RETURN h.result_contract_id;
  END IF;
  IF p_expected_at IS NULL OR c.updated_at IS DISTINCT FROM p_expected_at OR (p_operation='TRANSFER_ROOM' AND c.room_id IS DISTINCT FROM v_old_room) THEN RAISE EXCEPTION 'Hợp đồng đã thay đổi; vui lòng tải lại trước khi tiếp tục' USING ERRCODE='PT409'; END IF;
  v_prior:=c.expected_move_out_date;
  IF p_choice='CANCEL' AND v_prior IS NOT NULL THEN
    UPDATE public.contracts SET expected_move_out_date=NULL,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
    INSERT INTO public.contract_move_out_notice_events(organization_id,contract_id,actor_id,previous_date,new_date,reason,contract_updated_at)
      VALUES(p_org,c.id,auth.uid(),v_prior,NULL,v_reason,c.updated_at);
  END IF;
  -- Exact current APIs and inputs. No replacement renew/transfer or financial logic.
  IF p_operation='RENEW' THEN
    v_result:=public.renew_contract(c.id,(p_core_args->>'new_end_date')::date,(p_core_args->>'new_rent_price')::numeric,(p_core_args->>'new_deposit')::numeric,p_core_args->>'notes');
  ELSE
    v_result:=public.transfer_room(c.id,(p_core_args->>'new_room_id')::uuid,(p_core_args->>'new_rent_price')::numeric,(p_core_args->>'transfer_date')::date,p_core_args->>'notes');
  END IF;
  SELECT expected_move_out_date INTO v_result_date FROM public.contracts WHERE id=v_result AND organization_id=p_org;
  IF NOT FOUND OR v_result_date IS DISTINCT FROM (CASE WHEN p_choice='KEEP' THEN v_prior ELSE NULL END) THEN RAISE EXCEPTION 'Báo dọn sau thao tác không đúng lựa chọn; thay đổi đã được hoàn tác' USING ERRCODE='55000'; END IF;
  INSERT INTO public.contract_notice_transition_events(organization_id,contract_id,building_id,previous_room_id,result_contract_id,operation,notice_choice,
    previous_notice_date,expected_updated_at,reason,actor_id,request_id,intent_hash)
  VALUES(p_org,c.id,v_building,c.room_id,v_result,p_operation,p_choice,v_prior,p_expected_at,v_reason,auth.uid(),p_request,v_hash);
  RETURN v_result;
END $fn$;

REVOKE ALL ON FUNCTION app_private.commission_reason_transfer_room_before_v1(uuid,uuid,numeric,date,text),
  app_private.apply_contract_notice_transition_v1(uuid,uuid,timestamptz,text,text,uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
