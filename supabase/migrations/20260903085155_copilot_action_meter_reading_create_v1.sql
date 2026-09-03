-- G2-E (1/2) — Action L4 `meter_reading.create` theo Nonce ABI v1.
--
-- GHI MỘT CHỈ SỐ CÔNG TƠ cho một kỳ: phòng nào, công tơ nào, chỉ số mới bao
-- nhiêu. Đây là L4 chứ không phải L3 vì con số này ĐI VÀO TIỀN: kỳ hoá đơn kế
-- tiếp đọc `meter_readings` để tính tiêu thụ điện/nước, nên một chỉ số sai là
-- một hoá đơn sai.
--
-- NÓI THẲNG MỘT ĐIỀU LỆCH VỚI TÊN GỌI CỦA TASK
--   Task này mang tên "action L4 (draft)". Bản ghi chỉ số KHÔNG có trạng thái
--   nháp: `create_meter_reading_v1` (baseline `:58578`, đối chiếu bản
--   production 03/09/2026 — md5 của prosrc khớp từng byte) ép cứng
--   `status = 'APPROVED'`, `approved_by = auth.uid()`, `approved_at = now()`.
--   Bảng chỉ nhận hai trạng thái (`UNAPPROVED`/`APPROVED`) và RPC gốc không có
--   tham số nào chọn được trạng thái. Nên hàng rào ở đây KHÔNG phải "ghi ra bản
--   nháp" mà là ba lớp khác: cờ kill switch của action, một cú bấm thật của con
--   người tiêu một nonce dùng-một-lần, và quyền `meter_readings.create` đo đúng
--   toà. `verify_kind` khai `readback_org_creator` chứ không khai `*_draft` —
--   khai `draft` ở đây là nói dối sổ đăng ký.
--
--   VÀ BẢN XEM TRƯỚC PHẢI NÓI RA ĐIỀU ĐÓ. Khối `preview` có trường
--   `trang_thai` với đúng câu "Đã duyệt ngay…". Một thẻ xác nhận im lặng về
--   trạng thái sẽ để người bấm mang theo giả định của những đường ghi khác
--   ("Copilot chỉ lập nháp thôi mà") vào đúng cái nút không có bước duyệt.
--
--   Đường lùi: xoá bản ghi chỉ số qua giao diện Chốt công tơ.
--   `bulk_delete_meter_readings_v1` là thao tác XOÁ (L5), Copilot không cầm.
--
-- RPC GỐC GỌI NGUYÊN VẸN
--   `create_meter_reading_v1(p_meter_id, p_reading_date, p_current_reading,
--   p_notes, NULL)`. Tham số thứ năm — `p_meter_image_url` — LUÔN NULL và không
--   có đường nào để payload chạm tới nó: ảnh công tơ là bằng chứng đo đếm, và
--   một mô hình dựng URL ảnh là một đường đưa nội dung ngoài vào hồ sơ đo.
--   Mọi luật của RPC gốc (biên giới tổ chức, `can_do_on_building`, ràng buộc
--   `current_reading >= previous_reading`) KHÔNG được chép lại ở đây — chép là
--   dựng bản thứ hai của luật rồi để hai bản lệch nhau.
--
-- CHỈ SỐ KỲ TRƯỚC TRONG BẢN XEM TRƯỚC
--   Lấy theo ĐÚNG luật của trigger `auto_populate_previous_reading` đang chạy
--   trên bảng: bản ghi mới nhất chưa xoá của công tơ (`ORDER BY reading_date
--   DESC, created_at DESC`), không có thì `meters.initial_reading`, vẫn không
--   có thì 0. Bản xem trước phải nói thứ SẼ xảy ra, không phải thứ nghe hợp lý.
--   Công tơ chưa có kỳ nào thì kèm `canh_bao` — người bấm cần biết con số
--   "tiêu thụ" đang tính từ một mốc suy ra chứ không phải từ một kỳ đã chốt.
--
-- TIÊU THỤ ÂM
--   Xem trước VẪN trả về (kèm `canh_bao`), không chặn. Chặn ở đây sẽ là bản thứ
--   hai của một luật đã có: CHECK `meter_readings_current_gte_previous` từ chối
--   INSERT với 23514, và RPC gốc dịch nó thành câu tiếng Việt. Việc của xem
--   trước là cho người bấm THẤY con số âm trước khi bấm.
--
-- `before_digest` CỦA MỘT HÀNH ĐỘNG TẠO
--   Không có "trạng thái trước" của chính bản ghi sắp sinh ra. Thứ có nghĩa để
--   chốt là BẢN GHI KỲ TRƯỚC — cái mốc mà con số mới được đo tương đối với nó.
--   Ghi digest của hàng đó (NULL khi công tơ chưa có kỳ nào) cho phép người đọc
--   sổ về sau dựng lại đúng ngữ cảnh của phép tính.
--
-- ĐƯỜNG LÙI CỦA MIGRATION
--   DROP hai hàm; DELETE hàng registry `meter_reading.create` và hàng cờ
--   `('action','meter_reading.create')`.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. XEM TRƯỚC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_meter_reading_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_chi_so$
DECLARE
  v_actor     uuid := auth.uid();
  v_snapshot  jsonb;
  v_meter_id  uuid;
  v_ngay      date;
  v_chi_so    numeric;
  v_ghi_chu   text;
  v_meter     public.meters%ROWTYPE;
  v_toa       text;
  v_phong     text;
  v_truoc     numeric;
  v_co_ky     boolean := false;
  v_scope     record;
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
    'meter_reading.create', p_organization_id);

  BEGIN
    v_meter_id := (p_payload ->> 'meter_id')::uuid;
    v_ngay     := (p_payload ->> 'reading_date')::date;
    v_chi_so   := (p_payload ->> 'current_reading')::numeric;
    v_ghi_chu  := NULLIF(btrim(COALESCE(p_payload ->> 'notes', '')), '');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_meter_id IS NULL OR v_ngay IS NULL OR v_chi_so IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_chi_so < 0 OR v_chi_so::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'chi_so_khong_hop_le' USING ERRCODE = '22023';
  END IF;
  -- 5000, KHÔNG phải một con số khác. `ghi_chu_qua_dai` là MỘT mã lỗi dùng
  -- chung với `income_expense.annotate` (20260903072353 chặn ở 5000), và một mã
  -- lỗi mang hai ngưỡng khác nhau thì câu tiếng Việt gắn với nó
  -- (`GIAI_THICH_LOI_HANH_DONG` trong writeTools.ts) chỉ có thể đúng với một bên.
  IF char_length(COALESCE(v_ghi_chu, '')) > 5000 THEN
    RAISE EXCEPTION 'ghi_chu_qua_dai' USING ERRCODE = '22023';
  END IF;

  -- Fail-closed theo TỔ CHỨC. Công tơ của công ty khác trả về ĐÚNG câu như công
  -- tơ không tồn tại: một thông báo phân biệt hai trường hợp là kênh dò xem
  -- công ty bên cạnh có id nào.
  SELECT * INTO v_meter
    FROM public.meters
   WHERE id = v_meter_id
     AND deleted_at IS NULL
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('meter_readings.create', p_organization_id) s;
  -- Công tơ chưa gắn toà KHÔNG phải "không có gì để kiểm" — nó là "không phạm
  -- vi nào bao được nó". RPC gốc cũng từ chối bản ghi cho công tơ không toà.
  IF NOT COALESCE(v_scope.org_wide, false)
     AND (v_meter.building_id IS NULL
          OR NOT (v_meter.building_id = ANY(COALESCE(v_scope.building_ids, ARRAY[]::uuid[])))) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT b.name INTO v_toa FROM public.buildings b WHERE b.id = v_meter.building_id;
  SELECT COALESCE(r.code, r.name) INTO v_phong
    FROM public.rooms r WHERE r.id = v_meter.room_id;

  -- Chép ĐÚNG luật của trigger auto_populate_previous_reading.
  SELECT mr.current_reading INTO v_truoc
    FROM public.meter_readings mr
   WHERE mr.meter_id = v_meter_id
     AND mr.deleted_at IS NULL
   ORDER BY mr.reading_date DESC, mr.created_at DESC
   LIMIT 1;
  v_co_ky := FOUND;
  IF NOT v_co_ky THEN
    v_truoc := COALESCE(v_meter.initial_reading, 0);
    v_canh_bao := 'Công tơ chưa có kỳ nào đã chốt — chỉ số trước lấy từ chỉ số ban đầu của công tơ.';
  END IF;

  IF v_chi_so < v_truoc THEN
    v_canh_bao := COALESCE(v_canh_bao || ' ', '')
      || 'Chỉ số mới NHỎ HƠN chỉ số trước — hệ thống sẽ từ chối ghi.';
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'meter_id',        v_meter_id,
    'reading_date',    v_ngay,
    'current_reading', v_chi_so,
    'notes',           v_ghi_chu
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'meter_reading.create', app_private.copilot_payload_hash_v1(v_canonical),
     'meter_readings.create', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'toa_nha',      v_toa,
      'phong',        v_phong,
      'cong_to',      COALESCE(v_meter.code, v_meter.name),
      'chi_so_truoc', v_truoc,
      'chi_so_moi',   v_chi_so,
      'tieu_thu',     v_chi_so - v_truoc,
      'ngay_ghi',     v_ngay,
      'ghi_chu',      v_ghi_chu,
      'trang_thai',   'Đã duyệt ngay (như khi chốt công tơ trên giao diện) — KHÔNG phải bản nháp',
      'canh_bao',     v_canh_bao
    )
  );
END
$xem_truoc_chi_so$;

COMMENT ON FUNCTION public.copilot_preview_meter_reading_v1(uuid, jsonb) IS
  'Nonce ABI v1 — xem truoc ghi chi so cong to. Goi copilot_action_gate_v1 truoc khi phat nonce; chi so ky truoc lay theo dung luat trigger auto_populate_previous_reading.';

REVOKE ALL ON FUNCTION public.copilot_preview_meter_reading_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_chi_so$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_meter_reading_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_meter_reading_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_meter_reading_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_meter_reading_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_chi_so$;

-- ---------------------------------------------------------------------------
-- 2. THỰC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_meter_reading_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_chi_so$
DECLARE
  v_actor     uuid := auth.uid();
  v_hash      bytea;
  v_row       app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot  jsonb;
  v_org       uuid;
  v_meter_id  uuid;
  v_ngay      date;
  v_chi_so    numeric;
  v_ghi_chu   text;
  v_key       text;
  v_prev      public.ai_write_audit%ROWTYPE;
  v_before    jsonb;
  v_after     jsonb;
  v_moi       public.meter_readings%ROWTYPE;
  v_doc_lai   public.meter_readings%ROWTYPE;
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
  IF v_row.tool IS DISTINCT FROM 'meter_reading.create'
     OR v_row.permission_key IS DISTINCT FROM 'meter_readings.create' THEN
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
    v_org      := (p_payload ->> 'organization_id')::uuid;
    v_meter_id := (p_payload ->> 'meter_id')::uuid;
    v_ngay     := (p_payload ->> 'reading_date')::date;
    v_chi_so   := (p_payload ->> 'current_reading')::numeric;
    v_ghi_chu  := NULLIF(p_payload ->> 'notes', '');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_meter_id IS NULL OR v_ngay IS NULL OR v_chi_so IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('meter_reading.create', v_org);

  v_key := 'copilot_action:meter_reading.create:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'meter_readings',
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

  -- Công tơ phải còn sống và thuộc đúng công ty. Kiểm lại ở đây chứ không tin
  -- bước xem trước: giữa hai bước có 5 phút.
  IF NOT EXISTS (
    SELECT 1 FROM public.meters m
     WHERE m.id = v_meter_id
       AND m.deleted_at IS NULL
       AND m.organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- `before` = bản ghi KỲ TRƯỚC (mốc mà con số mới được đo tương đối với nó).
  SELECT to_jsonb(mr) INTO v_before
    FROM public.meter_readings mr
   WHERE mr.meter_id = v_meter_id
     AND mr.deleted_at IS NULL
   ORDER BY mr.reading_date DESC, mr.created_at DESC
   LIMIT 1;

  BEGIN
    v_moi := public.create_meter_reading_v1(v_meter_id, v_ngay, v_chi_so, v_ghi_chu, NULL);
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               'action_failed',
      'organization_id',     v_org,
      'action_id',           'meter_reading.create',
      'permission_key',      'meter_readings.create',
      'permission_snapshot', v_snapshot,
      'consent_kind',        'click',
      'consent_id',          v_row.id,
      'payload_digest',      encode(v_hash, 'hex'),
      'before_digest',       CASE WHEN v_before IS NULL THEN NULL
                                  ELSE encode(extensions.digest(
                                         convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex') END,
      'entity_table',        'meter_readings',
      'error_code',          v_message,
      'sqlstate',            v_sqlstate
    ));
    RAISE;
  END;

  -- READBACK — đọc lại từ BẢNG, không tin giá trị RPC gốc trả về.
  --
  -- HAI TẦNG, HAI MÃ LỖI, và sự phân biệt là có chủ ý:
  --   · DANH TÍNH sai (công ty / người ghi / công tơ) ⇒
  --     `copilot_write_readback_mismatch` — bản ghi rơi vào chỗ không ai định.
  --   · GIÁ TRỊ sai (chỉ số, ngày chốt) ⇒ `copilot_draft_invariant_violation` —
  --     bản ghi đúng chỗ nhưng KHÁC thứ đã hiện trên thẻ xác nhận, tức cú bấm
  --     của người dùng đồng ý cho một con số và hệ ghi một con số khác. Đây là
  --     mã mà cả plan dùng cho "hàng ghi ra không đúng thứ đã hứa".
  -- Cả hai đều RAISE nên cuộn lại toàn bộ giao dịch.
  --
  -- So chỉ số qua `round(…, 2)`: cột là `numeric(10,2)`, nên 1234.567 gửi lên sẽ
  -- nằm trong bảng thành 1234.57. So thô sẽ báo động giả ở mọi chỉ số lẻ.
  SELECT * INTO v_doc_lai
    FROM public.meter_readings mr
   WHERE mr.id = v_moi.id;
  IF NOT FOUND
     OR v_doc_lai.organization_id IS DISTINCT FROM v_org
     OR v_doc_lai.user_id IS DISTINCT FROM v_actor
     OR v_doc_lai.meter_id IS DISTINCT FROM v_meter_id THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF v_doc_lai.current_reading IS DISTINCT FROM round(v_chi_so, 2)
     OR v_doc_lai.reading_date IS DISTINCT FROM v_ngay THEN
    RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
  END IF;
  v_after := to_jsonb(v_doc_lai);

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'meter_reading.create', v_key, 'meter_readings',
     v_doc_lai.id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'meter_reading.create',
    'permission_key',      'meter_readings.create',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       CASE WHEN v_before IS NULL THEN NULL
                                ELSE encode(extensions.digest(
                                       convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex') END,
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'meter_readings',
    'entity_id',           v_doc_lai.id,
    'audit_id',            v_audit_id,
    'outcome',             jsonb_build_object('status', 'da_thuc_hien')
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'meter_readings',
    'entity_id',    v_doc_lai.id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_chi_so$;

COMMENT ON FUNCTION public.copilot_execute_meter_reading_v1(text, jsonb) IS
  'Nonce ABI v1 — tieu nonce, goi lai cong hanh dong, ghi chi so qua create_meter_reading_v1, doc lai ban ghi de xac minh to chuc/nguoi ghi/cong to, ghi ai_write_audit + so hanh dong.';

REVOKE ALL ON FUNCTION public.copilot_execute_meter_reading_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_chi_so$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_meter_reading_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_meter_reading_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_meter_reading_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_meter_reading_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_chi_so$;

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
  'meter_reading.create',
  1,
  'Ghi chỉ số công tơ',
  'meter_readings.create',
  'L4',
  'nonce_abi_v1',
  'click',
  'copilot_preview_meter_reading_v1',
  'copilot_execute_meter_reading_v1',
  'readback_org_creator',
  'meter_readings',
  'meters',
  NULL,
  'Xoa ban ghi chi so qua giao dien Chot cong to. KHONG co RPC lui: bulk_delete_meter_readings_v1 la thao tac XOA (L5) va Copilot khong cam no. Chi so ky truoc nam trong before_digest cua so hanh dong va trong khoi preview.chi_so_truoc',
  'meter_reading.create',
  true
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'meter_reading.create', 'disabled',
  'seed kill switch cho action L4 ghi chi so cong to (G2-E)',
  'migration:20260903085155_copilot_action_meter_reading_create_v1',
  'migration:20260903085155_copilot_action_meter_reading_create_v1'
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
    'public.copilot_preview_meter_reading_v1(uuid, jsonb)',
    'public.copilot_execute_meter_reading_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G2-E meter reading: %', array_to_string(v_thieu, ', ');
  END IF;

  IF to_regprocedure('app_private.copilot_action_gate_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_action_gate_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('app_private.copilot_ledger_append_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'copilot_ledger_append_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('public.create_meter_reading_v1(uuid, date, numeric, text, text)') IS NULL THEN
    RAISE EXCEPTION 'create_meter_reading_v1 missing — baseline phai co truoc';
  END IF;
  IF to_regclass('public.meter_readings') IS NULL OR to_regclass('public.meters') IS NULL THEN
    RAISE EXCEPTION 'meter_readings/meters missing — baseline phai co truoc';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_meter_reading_v1(uuid, jsonb)',
      'public.copilot_execute_meter_reading_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G2-E meter reading: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'meter_reading.create'
       AND risk = 'L4' AND executor_kind = 'nonce_abi_v1' AND consent_required = 'click'
       AND permission_key = 'meter_readings.create'
  ) THEN
    RAISE EXCEPTION 'seed registry meter_reading.create sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'meter_reading.create'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: meter_reading.create';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
