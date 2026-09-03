-- G2-E (2/2) — Action L4 `reservation_deposit.create` theo Nonce ABI v1.
--
-- ĐẶT CỌC GIỮ CHỖ MỘT PHÒNG: khách đặt tiền để giữ phòng trước khi ký hợp đồng.
-- L4 vì nó đụng TIỀN và đụng TÌNH TRẠNG PHÒNG (phòng đang giữ thì người khác
-- không đặt được).
--
-- ĐÂY LÀ ACTION DUY NHẤT CỦA G2-E CÓ TRẠNG THÁI "CHỜ DUYỆT" THẬT
--   `room_reservation_holds.status` mặc định `'PENDING_APPROVAL'` (đo trên
--   production 03/09/2026), và ràng buộc EXCLUDE chỉ tính các hàng
--   `PENDING_APPROVAL`/`APPROVED`. Nên bản ghi Copilot tạo ra là một phiếu giữ
--   chỗ CHỜ DUYỆT, không phải một khoản đã thu. Readback ép đúng điều đó:
--   trạng thái khác `PENDING_APPROVAL` ⇒ `copilot_draft_invariant_violation`
--   và CẢ giao dịch cuộn lại — không có đường nào để Copilot sinh ra một phiếu
--   giữ chỗ đã duyệt.
--
-- RPC GỐC GỌI NGUYÊN VẸN
--   `create_reservation_deposit_v1(p_room_id, p_amount, p_idempotency_key)`
--   (baseline `:59272`; bản production 03/09/2026 khớp từng dòng — chỉ khác
--   kiểu xuống dòng). Nó tự làm: khoá phòng `FOR NO KEY UPDATE`, suy toà → tổ
--   chức, `authorize_tenant_action_v3(..., 'deposits.create', building)`, van
--   `evaluate_feature_route('deposit.hold.v1')`, ghi bảng CWO
--   `canonical_write_operations`, và bắt `exclusion_violation` thành câu "Phòng
--   đang có cọc giữ chỗ còn hiệu lực". KHÔNG chép lại luật nào trong số đó.
--
-- HAI LỚP CHỐNG LẶP, CÙNG MỘT NGUỒN
--   Lớp ngoài là ABI: nonce dùng-một-lần + advisory lock + `ai_write_audit`
--   theo khoá `copilot_action:<action>:<actor>:<org>:<payload_hash>`.
--   Lớp trong là CWO của chính RPC gốc, khoá theo
--   `(org, 'deposit.hold.v1', room_id, actor, idempotency_key)`.
--   `p_idempotency_key` truyền vào lớp trong được DẪN XUẤT TỪ CÙNG `payload_hash`
--   (`'copilot_action_' || 40 ký tự hex đầu`) nên hai lớp không thể bất đồng về
--   "đây có phải cùng một lần bấm hay không". Dạng khoá thoả regex của RPC gốc
--   `^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$` (55 ký tự, ký tự đầu là chữ cái).
--   40 ký tự hex = 160 bit — cắt ngắn để vừa trần 200 ký tự mà vẫn không có
--   nguy cơ đụng độ trong phạm vi một (tổ chức, phòng, người) nào.
--
-- `before_digest` CỦA MỘT HÀNH ĐỘNG TẠO
--   Không có "trạng thái trước" của chính phiếu sắp sinh ra. Thứ có nghĩa là
--   PHIẾU GIỮ CHỖ CÒN HIỆU LỰC của phòng (NULL khi phòng đang trống chỗ giữ) —
--   đúng cái tiền đề mà ràng buộc EXCLUDE cưỡng chế.
--
-- HOÀN TÁC
--   Không có RPC lùi. Huỷ phiếu giữ chỗ qua giao diện Cọc/Giữ chỗ (đổi
--   `status` sang `CANCELLED`), hoặc để nó tự hết hạn sau 24 giờ.
--
-- ĐƯỜNG LÙI CỦA MIGRATION
--   DROP hai hàm; DELETE hàng registry `reservation_deposit.create` và hàng cờ
--   `('action','reservation_deposit.create')`.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. XEM TRƯỚC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_reservation_deposit_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_giu_cho_moi$
DECLARE
  v_actor     uuid := auth.uid();
  v_snapshot  jsonb;
  v_room_id   uuid;
  v_so_tien   numeric;
  v_room      public.rooms%ROWTYPE;
  v_toa       text;
  v_scope     record;
  v_giu_cu    timestamptz;
  v_nonce     bytea;
  v_canonical jsonb;
  v_canh_bao  text := NULL;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1(
    'reservation_deposit.create', p_organization_id);

  BEGIN
    v_room_id := (p_payload ->> 'room_id')::uuid;
    v_so_tien := (p_payload ->> 'amount')::numeric;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_room_id IS NULL OR v_so_tien IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;
  -- Cùng ba điều kiện RPC gốc đo, nhưng đo SỚM: một số tiền vô lý không đáng
  -- tiêu một nonce và để lại một hàng xác nhận rác.
  IF v_so_tien <= 0
     OR v_so_tien::text IN ('NaN', 'Infinity', '-Infinity')
     OR round(v_so_tien, 2) <> v_so_tien THEN
    RAISE EXCEPTION 'so_tien_khong_hop_le' USING ERRCODE = '22023';
  END IF;

  -- Fail-closed theo TỔ CHỨC: phòng của công ty khác trả về ĐÚNG câu như phòng
  -- không tồn tại.
  SELECT * INTO v_room
    FROM public.rooms
   WHERE id = v_room_id
     AND deleted_at IS NULL
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('deposits.create', p_organization_id) s;
  -- Phòng không gắn toà KHÔNG phải "không có gì để kiểm" — nó là "không phạm vi
  -- nào bao được nó". Fail-closed, cùng khuôn với hai action L3 của G2-D.
  IF NOT COALESCE(v_scope.org_wide, false)
     AND (v_room.building_id IS NULL
          OR NOT (v_room.building_id = ANY(COALESCE(v_scope.building_ids, ARRAY[]::uuid[])))) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT b.name INTO v_toa FROM public.buildings b WHERE b.id = v_room.building_id;

  -- Phiếu giữ chỗ còn hiệu lực: cảnh báo, KHÔNG chặn. Ràng buộc EXCLUDE của
  -- bảng mới là hàng rào thật; dựng bản thứ hai ở đây rồi để hai bản lệch nhau
  -- là đúng thứ phải tránh. Việc của xem trước là cho người bấm THẤY trước.
  SELECT h.expires_at INTO v_giu_cu
    FROM public.room_reservation_holds h
   WHERE h.room_id = v_room_id
     AND h.status IN ('PENDING_APPROVAL', 'APPROVED')
     AND h.expires_at > clock_timestamp()
   ORDER BY h.expires_at DESC
   LIMIT 1;
  IF FOUND THEN
    v_canh_bao := 'Phòng ĐANG có phiếu giữ chỗ còn hiệu lực đến '
      || to_char(v_giu_cu, 'DD/MM/YYYY HH24:MI')
      || ' — hệ thống sẽ từ chối đặt thêm.';
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'room_id',         v_room_id,
    'amount',          v_so_tien
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'reservation_deposit.create', app_private.copilot_payload_hash_v1(v_canonical),
     'deposits.create', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'toa_nha',      v_toa,
      'phong',        COALESCE(v_room.code, v_room.name),
      'so_tien',      v_so_tien,
      'han_giu_cho',  '24 giờ kể từ lúc xác nhận',
      'trang_thai',   'Chờ duyệt (PENDING_APPROVAL) — chưa vào sổ quỹ',
      'canh_bao',     v_canh_bao
    )
  );
END
$xem_truoc_giu_cho_moi$;

COMMENT ON FUNCTION public.copilot_preview_reservation_deposit_v1(uuid, jsonb) IS
  'Nonce ABI v1 — xem truoc dat coc giu cho mot phong. Goi copilot_action_gate_v1 truoc khi phat nonce; canh bao khi phong dang co phieu giu cho con hieu luc.';

REVOKE ALL ON FUNCTION public.copilot_preview_reservation_deposit_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_giu_cho_moi$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_reservation_deposit_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_reservation_deposit_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_reservation_deposit_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_reservation_deposit_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_giu_cho_moi$;

-- ---------------------------------------------------------------------------
-- 2. THỰC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_reservation_deposit_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_giu_cho_moi$
DECLARE
  v_actor     uuid := auth.uid();
  v_hash      bytea;
  v_row       app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot  jsonb;
  v_org       uuid;
  v_room_id   uuid;
  v_so_tien   numeric;
  v_key       text;
  v_key_goc   text;
  v_prev      public.ai_write_audit%ROWTYPE;
  v_before    jsonb;
  v_after     jsonb;
  v_ket       json;
  v_hold_id   uuid;
  v_doc_lai   public.room_reservation_holds%ROWTYPE;
  v_audit_id  uuid;
  v_ledger_id uuid;
  v_sqlstate  text;
  v_message   text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_confirmation_nonce IS NULL
     OR p_confirmation_nonce !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '42501';
  END IF;

  v_hash := app_private.copilot_payload_hash_v1(p_payload);

  SELECT * INTO v_row
    FROM app_private.copilot_write_confirmations c
   WHERE c.nonce_digest = extensions.digest(
           decode(p_confirmation_nonce, 'hex'), 'sha256')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.tool IS DISTINCT FROM 'reservation_deposit.create'
     OR v_row.permission_key IS DISTINCT FROM 'deposits.create' THEN
    RAISE EXCEPTION 'confirmation_contract_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_row.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;
  IF v_row.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'confirmation_expired' USING ERRCODE = '42501';
  END IF;
  IF v_row.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_org     := (p_payload ->> 'organization_id')::uuid;
    v_room_id := (p_payload ->> 'room_id')::uuid;
    v_so_tien := (p_payload ->> 'amount')::numeric;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_room_id IS NULL OR v_so_tien IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('reservation_deposit.create', v_org);

  v_key := 'copilot_action:reservation_deposit.create:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'room_reservation_holds',
      'entity_id',    v_prev.entity_id,
      'audit_id',     v_prev.id,
      'ledger_id',    NULL
    );
  END IF;

  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE id = v_row.id
     AND consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  -- Phòng phải còn sống và thuộc đúng công ty. Kiểm lại ở đây chứ không tin
  -- bước xem trước: giữa hai bước có 5 phút.
  IF NOT EXISTS (
    SELECT 1 FROM public.rooms r
     WHERE r.id = v_room_id
       AND r.deleted_at IS NULL
       AND r.organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- `before` = phiếu giữ chỗ còn hiệu lực của phòng (tiền đề mà EXCLUDE cưỡng chế).
  SELECT to_jsonb(h) INTO v_before
    FROM public.room_reservation_holds h
   WHERE h.room_id = v_room_id
     AND h.status IN ('PENDING_APPROVAL', 'APPROVED')
     AND h.expires_at > clock_timestamp()
   ORDER BY h.expires_at DESC
   LIMIT 1;

  -- Khoá cho lớp CWO của RPC gốc, dẫn xuất từ CÙNG payload_hash của lớp ngoài.
  v_key_goc := 'copilot_action_' || substr(encode(v_hash, 'hex'), 1, 40);

  BEGIN
    v_ket := public.create_reservation_deposit_v1(v_room_id, v_so_tien, v_key_goc);
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               'action_failed',
      'organization_id',     v_org,
      'action_id',           'reservation_deposit.create',
      'permission_key',      'deposits.create',
      'permission_snapshot', v_snapshot,
      'consent_kind',        'click',
      'consent_id',          v_row.id,
      'payload_digest',      encode(v_hash, 'hex'),
      'before_digest',       CASE WHEN v_before IS NULL THEN NULL
                                  ELSE encode(extensions.digest(
                                         convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex') END,
      'entity_table',        'room_reservation_holds',
      'error_code',          v_message,
      'sqlstate',            v_sqlstate
    ));
    RAISE;
  END;

  v_hold_id := NULLIF(v_ket ->> 'hold_id', '')::uuid;
  IF v_hold_id IS NULL THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- READBACK — đọc lại từ BẢNG, không tin JSON mà RPC gốc trả về. Bốn điều phải
  -- đúng, và điều thứ tư là bất biến NHÁP: một phiếu giữ chỗ Copilot tạo ra
  -- luôn ở trạng thái CHỜ DUYỆT. Lệch một điều là cuộn lại cả giao dịch.
  SELECT * INTO v_doc_lai
    FROM public.room_reservation_holds h
   WHERE h.id = v_hold_id;
  IF NOT FOUND
     OR v_doc_lai.organization_id IS DISTINCT FROM v_org
     OR v_doc_lai.held_by IS DISTINCT FROM v_actor
     OR v_doc_lai.room_id IS DISTINCT FROM v_room_id THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF v_doc_lai.status IS DISTINCT FROM 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
  END IF;
  v_after := to_jsonb(v_doc_lai);

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'reservation_deposit.create', v_key, 'room_reservation_holds',
     v_doc_lai.id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'reservation_deposit.create',
    'permission_key',      'deposits.create',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       CASE WHEN v_before IS NULL THEN NULL
                                ELSE encode(extensions.digest(
                                       convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex') END,
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'room_reservation_holds',
    'entity_id',           v_doc_lai.id,
    'audit_id',            v_audit_id,
    'outcome',             jsonb_build_object('status', 'da_thuc_hien')
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'room_reservation_holds',
    'entity_id',    v_doc_lai.id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_giu_cho_moi$;

COMMENT ON FUNCTION public.copilot_execute_reservation_deposit_v1(text, jsonb) IS
  'Nonce ABI v1 — tieu nonce, goi lai cong hanh dong, dat coc giu cho qua create_reservation_deposit_v1 voi khoa CWO dan xuat tu payload_hash, doc lai phieu de ep bat bien PENDING_APPROVAL, ghi ai_write_audit + so hanh dong.';

REVOKE ALL ON FUNCTION public.copilot_execute_reservation_deposit_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_giu_cho_moi$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_reservation_deposit_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_reservation_deposit_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_reservation_deposit_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_reservation_deposit_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_giu_cho_moi$;

-- ---------------------------------------------------------------------------
-- 3. SỔ ĐĂNG KÝ + CÔNG TẮC
-- ---------------------------------------------------------------------------
INSERT INTO app_private.copilot_action_registry (
  action_id, version, label_vi, permission_key, risk, executor_kind,
  consent_required, preview_rpc, execute_rpc, verify_kind,
  produces_entity_table, consumes_ref_table, rollback_rpc, rollback_note,
  flag_contract_id, enabled
)
VALUES (
  'reservation_deposit.create',
  1,
  'Tạo phiếu giữ chỗ chờ duyệt',
  'deposits.create',
  'L4',
  'nonce_abi_v1',
  'click',
  'copilot_preview_reservation_deposit_v1',
  'copilot_execute_reservation_deposit_v1',
  'hold_pending_approval',
  'room_reservation_holds',
  'rooms',
  NULL,
  'Huy phieu giu cho qua giao dien Coc/Giu cho (doi status sang CANCELLED), hoac de no tu het han sau 24 gio. KHONG co RPC lui: duong huy la thao tac cua nguoi co quyen tren giao dien',
  'reservation_deposit.create',
  true
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'reservation_deposit.create', 'disabled',
  'seed kill switch cho action L4 tao phieu giu cho (G2-E)',
  'migration:20260903085654_copilot_action_reservation_deposit_create_v1',
  'migration:20260903085654_copilot_action_reservation_deposit_create_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', '', true);

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog, chạy được trên database rỗng.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ten   text;
  v_thieu text[] := '{}'::text[];
  v_ho    text[] := '{}'::text[];
BEGIN
  FOREACH v_ten IN ARRAY ARRAY[
    'public.copilot_preview_reservation_deposit_v1(uuid, jsonb)',
    'public.copilot_execute_reservation_deposit_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G2-E reservation deposit: %', array_to_string(v_thieu, ', ');
  END IF;

  IF to_regprocedure('app_private.copilot_action_gate_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_action_gate_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('app_private.copilot_ledger_append_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'copilot_ledger_append_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('public.create_reservation_deposit_v1(uuid, numeric, text)') IS NULL THEN
    RAISE EXCEPTION 'create_reservation_deposit_v1 missing — baseline phai co truoc';
  END IF;
  IF to_regclass('public.room_reservation_holds') IS NULL THEN
    RAISE EXCEPTION 'room_reservation_holds missing — baseline phai co truoc';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_reservation_deposit_v1(uuid, jsonb)',
      'public.copilot_execute_reservation_deposit_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G2-E reservation deposit: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'reservation_deposit.create'
       AND risk = 'L4' AND executor_kind = 'nonce_abi_v1' AND consent_required = 'click'
       AND permission_key = 'deposits.create'
  ) THEN
    RAISE EXCEPTION 'seed registry reservation_deposit.create sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'reservation_deposit.create'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: reservation_deposit.create';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
