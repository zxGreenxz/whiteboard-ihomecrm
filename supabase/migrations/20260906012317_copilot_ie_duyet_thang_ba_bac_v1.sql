-- =============================================================================
-- copilot_ie_duyet_thang_ba_bac_v1 — Copilot duyệt phiếu phải đi ĐÚNG thang mà
-- giao diện đi; trước đợt này nó chỉ có bậc giữa
-- Ngày 06/09/2026 · gốc lộ ra từ ca 6 ma trận L5
-- =============================================================================
-- ĐO ĐƯỢC, KHÔNG PHẢI SUY
--   Ca 6 (`.e2e-fleet/specs/copilot-plan-l5-matrix.spec.ts`) chạy tới bước thực
--   thi thì `copilot_plan_execute_step_v1` trả `ok:false` với
--
--     error_code = 'Phiếu chưa thuộc luồng canonical — dùng đường legacy'
--
--   Đó là 55000 của `public.approve_income_expense_v1` khi
--   `app_private.is_income_expense_flow_owned(id)` = false.
--
--   Đếm trên production ngày 06/09/2026, 30 ngày gần nhất:
--     · org thật "iHome CRM": 741 phiếu, 342 thuộc luồng canonical → 399 phiếu
--       (hơn MỘT NỬA) mà Copilot KHÔNG duyệt được.
--     · org DEMO: 31 phiếu, 0 canonical → ca 6 không bao giờ xanh được.
--
--   Nên đây không phải lỗi của bài test hay của dữ liệu DEMO. Đây là lỗ hổng
--   NĂNG LỰC của chính hành động L5: một super admin ngồi bấm trên giao diện
--   duyệt được những phiếu đó, Copilot thì không.
--
-- ĐƯỜNG ĐÚNG ĐÃ CÓ SẴN, WRAPPER CHỈ KHÔNG DÙNG
--   `useApproveVoucher` (`src/hooks/income-expenses/statusMutations.ts`) đi ba
--   bậc, và chính `approve_income_expense_v1` ghi trong thân nó rằng 55000 kia
--   là "tín hiệu fallback (hook chuyển sang approve_voucher legacy)" cùng dòng
--   "Permission parity với public.approve_voucher". Tức thang ba bậc là THIẾT KẾ,
--   còn wrapper của Copilot mới là chỗ hụt:
--
--     (1) Cặp phiếu bỏ cọc (thu + chi cấn nhau) → `set_termination_forfeit_status_v1`.
--     (2) `approve_income_expense_v1` — đường canonical.
--     (3) 55000 mang dấu canonical/legacy → `approve_voucher` — đường legacy.
--
-- KHÔNG NỚI MỘT LY QUYỀN NÀO
--   * Bậc (2) và (3) có CÙNG bộ điều kiện quyền — V1 tự ghi "Permission parity":
--     `user_id = actor OR is_super_admin() OR can_do_on_building('income_expenses',
--     'approve', building_id)`.
--   * Cả hai đều gọi `app_private.assert_no_engine_request_v1` nên phiếu đã vào
--     hộp chờ duyệt vẫn bị chặn — maker-checker giữ nguyên, Copilot vẫn không tự
--     duyệt được hồ sơ nó đã nộp.
--   * Bậc (1) là HÀNG RÀO, không phải tiện nghi: duyệt một chân của cặp bỏ cọc
--     bằng đường thường sẽ để cặp lệch, và cặp lệch thì kẹt vĩnh viễn (xem
--     20260902092845 + guard writer-xid). `approve_income_expense_v2` rẽ ở đúng
--     chỗ này; wrapper nay rẽ giống. Trước đợt này wrapper KHÔNG rẽ — tức nó
--     đang mang sẵn rủi ro đó, chỉ chưa ai bấm vào.
--   * Mọi cửa phía trên giữ nguyên từng dòng: nonce, hợp đồng tool, digest
--     payload, `l5_requires_plan`, `copilot_action_gate_v1`, advisory lock,
--     idempotency `ai_write_audit`, và READBACK vẫn đòi
--     `approval_status = 'APPROVED'` — bậc nào chạy cũng phải qua phép đọc lại đó.
--
-- BỘ LỌC 55000 PHẢI HẸP
--   `approve_income_expense_v1` còn một 55000 KHÁC ("approve transition affected
--   % rows (expected 1)") và đó là lỗi thật, phải nổ ra. Nên điều kiện là
--   sqlstate 55000 CỘNG thông điệp chứa CẢ "canonical" VÀ "legacy" — hai từ
--   ASCII, nên phép so không phụ thuộc byte dấu tiếng Việt (thân hàm đi qua
--   `pg_get_functiondef`, `EXECUTE`, file migration, git; đừng để một dấu móc
--   quyết định hàng rào có chạy hay không).
--
-- SỔ PHẢI NÓI ĐÃ ĐI BẬC NÀO
--   Dòng `action_executed` thêm `outcome.duong_duyet` ∈ {forfeit_pair, canonical,
--   legacy}. Không thêm khoá nào vào giá trị TRẢ VỀ của wrapper: engine
--   (`copilot_plan_execute_step_v1`) đọc vỏ đó, và đợt này không phải lúc đổi
--   hợp đồng giữa engine với wrapper.
--
-- PHẠM VI — ĐÚNG MỘT WRAPPER
--   Đã đo: trong các RPC gốc mà nhóm wrapper L5 gọi, CHỈ `approve_income_expense_v1`
--   mang guard `is_income_expense_flow_owned`. `approve_and_post_income_expense_v2`,
--   `post_approved_income_expense_v2`, `cancel_income_expense_flex_v1`,
--   `set_termination_forfeit_status_v1` đều KHÔNG. Nên chỉ
--   `copilot_execute_ie_duyet_v1` được sửa; các wrapper khác không chạm.
--   Thân hàm dưới đây sinh TỪ `pg_get_functiondef` của production (luật nhà), rồi
--   thay đúng khối gọi RPC gốc.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';
CREATE OR REPLACE FUNCTION public.copilot_execute_ie_duyet_v1(p_confirmation_nonce text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'
AS $function$
DECLARE
  v_actor     uuid := auth.uid();
  v_hash      bytea;
  v_row       app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot  jsonb;
  v_org       uuid;
  v_ie_id     uuid;
  v_key       text;
  v_prev      public.ai_write_audit%ROWTYPE;
  v_before    jsonb;
  v_after     jsonb;
  v_ie        public.income_expenses%ROWTYPE;
  v_audit_id  uuid;
  v_ledger_id uuid;
  -- 06/09/2026: BẬC nào của thang duyệt đã thật sự chạy. Vào sổ, không vào vỏ
  -- trả về — hợp đồng giữa engine và wrapper không đổi trong đợt này.
  v_duong     text := NULL;
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
  IF v_row.tool IS DISTINCT FROM 'income_expense.duyet'
     OR v_row.permission_key IS DISTINCT FROM 'income_expenses.approve' THEN
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
    v_org   := (p_payload ->> 'organization_id')::uuid;
    v_ie_id := (p_payload ->> 'income_expense_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_ie_id IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  -- F1 (review G5-C dot 1, fix round 1): guard L5 KHONG con la kiem
  -- "marker co mat hay khong" don thuan -- no la mot cau hoi DATABASE THAT:
  -- dung co dang co mot ke hoach APPROVED, dung buoc PENDING, dung nguoi, dung
  -- to chuc, dung action_id hay khong. Ca hai chu ky (parse + tra bang) nam
  -- trong MOT helper dung chung (app_private.copilot_l5_plan_context_ok_v1),
  -- dinh nghia o migration dau tien cua dot va CREATE OR REPLACE lai giong het
  -- o day (idempotent -- xem chu thich canh dinh nghia helper phia duoi).
  IF NOT app_private.copilot_l5_plan_context_ok_v1('income_expense.duyet', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('income_expense.duyet', v_org);

  v_key := 'copilot_action:income_expense.duyet:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'income_expenses',
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

  -- Phieu phai con song va dung to chuc. Kiem lai o day chu khong tin buoc
  -- xem truoc: giua hai buoc co toi 5 phut.
  SELECT * INTO v_ie
    FROM public.income_expenses
   WHERE id = v_ie_id
     AND deleted_at IS NULL
     AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- `before_digest` LUON khac NULL o mot hanh dong DUYET: phieu phai ton tai
  -- truoc do moi duyet duoc, khac voi mot hanh dong TAO moi.
  v_before := to_jsonb(v_ie);

  -- ═══ THANG BA BẬC — cùng thứ tự `useApproveVoucher` của giao diện ═══════
  -- (1) Cặp phiếu bỏ cọc: duyệt một chân bằng đường thường sẽ để cặp LỆCH, và
  --     cặp lệch thì kẹt vĩnh viễn (20260902092845 + guard writer-xid). Rẽ
  --     TRƯỚC mọi thứ khác, đúng chỗ `approve_income_expense_v2` rẽ.
  IF EXISTS (
    SELECT 1 FROM app_private.termination_forfeit_authorizations f
     WHERE f.revenue_voucher_id = v_ie_id OR f.offset_voucher_id = v_ie_id
  ) THEN
    PERFORM public.set_termination_forfeit_status_v1(v_ie_id, 'APPROVED');
    v_duong := 'forfeit_pair';
  ELSE
  BEGIN
    -- (2) Đường canonical.
    PERFORM public.approve_income_expense_v1(v_ie_id);
    v_duong := 'canonical';
  EXCEPTION
    WHEN sqlstate '55000' THEN
      -- (3) Đường legacy. CHỈ nhận đúng tín hiệu fallback mà chính V1 khai:
      -- 55000 + thông điệp mang CẢ "canonical" VÀ "legacy". V1 còn một 55000
      -- khác ("approve transition affected % rows") — đó là lỗi thật, phải nổ.
      -- So bằng hai từ ASCII để hàng rào không phụ thuộc byte dấu tiếng Việt.
      IF SQLERRM NOT LIKE '%canonical%' OR SQLERRM NOT LIKE '%legacy%' THEN
        RAISE;
      END IF;
      -- Không nới quyền: V1 tự ghi "Permission parity với public.approve_voucher",
      -- và cả hai đều PERFORM assert_no_engine_request_v1 nên phiếu đã vào hộp
      -- chờ duyệt vẫn bị chặn — Copilot vẫn không tự duyệt hồ sơ nó đã nộp.
      PERFORM public.approve_voucher(v_ie_id);
      v_duong := 'legacy';
    WHEN others THEN
    -- F2 (review G5-C dot 1, fix round 1): KHONG ghi 'action_failed' o day.
    -- Nhanh nay LUON bi cuon nguoc: goi truc tiep (ngoai ke hoach) da bi chan
    -- tu F1 phia tren, va goi qua ke hoach thi than ham nay chay BEN TRONG
    -- mot BEGIN/EXCEPTION khac cua chinh engine (TANG (3) cua
    -- copilot_plan_execute_step_v1) -- savepoint ngam cua khoi do cuon lai MOI
    -- thu ben trong no khi RAISE, ke ca mot INSERT vao so vua chay o day. Dong
    -- 'step_failed'/'step_blocked' SONG DUY NHAT do CHINH engine ghi o giao
    -- dich NGOAI, sau khi da rollback ve savepoint do. RAISE lai de engine bat
    -- duoc va ghi dung dong do.
    RAISE;
  END;
  END IF;

  -- READBACK — doc lai tu BANG, khong tin ket qua void cua RPC goc.
  SELECT * INTO v_ie
    FROM public.income_expenses
   WHERE id = v_ie_id;
  IF NOT FOUND
     OR v_ie.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF v_ie.approval_status IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
  END IF;
  v_after := to_jsonb(v_ie);

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'income_expense.duyet', v_key, 'income_expenses',
     v_ie.id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'income_expense.duyet',
    'permission_key',      'income_expenses.approve',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'income_expenses',
    'entity_id',           v_ie.id,
    'audit_id',            v_audit_id,
    'outcome',             jsonb_build_object('status', 'da_thuc_hien',
                                                'duong_duyet', v_duong)
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'income_expenses',
    'entity_id',    v_ie.id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$function$;

COMMENT ON FUNCTION public.copilot_execute_ie_duyet_v1(text, jsonb) IS
  'Thuc thi hanh dong L5 income_expense.duyet trong mot buoc ke hoach APPROVED. Tu 06/09/2026 di '
  'DUNG thang ba bac cua giao dien: cap phieu bo coc -> set_termination_forfeit_status_v1; phieu '
  'canonical -> approve_income_expense_v1; phieu legacy (55000 mang dau canonical/legacy) -> '
  'approve_voucher. Khong noi quyen (V1 va approve_voucher parity, ca hai chan phieu da vao engine). '
  'So ghi outcome.duong_duyet de biet da di bac nao.';

REVOKE ALL ON FUNCTION public.copilot_execute_ie_duyet_v1(text, jsonb) FROM PUBLIC;
DO $thu_hoi_duyet$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_ie_duyet_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_ie_duyet_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_ie_duyet_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_ie_duyet_v1(text, jsonb) TO authenticated;
  END IF;
END
$thu_hoi_duyet$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog nên chạy được cả trên DB rỗng của Restore Drill
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_def text;
  v_acl text;
  v_cua text;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.proacl::text INTO v_def, v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'copilot_execute_ie_duyet_v1'
     AND pg_get_function_identity_arguments(p.oid) = 'p_confirmation_nonce text, p_payload jsonb';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'nghiem_thu: khong thay public.copilot_execute_ie_duyet_v1(text, jsonb)';
  END IF;

  -- 1) Ba bậc đều có mặt, mỗi bậc đúng một lần.
  IF ( SELECT count(*) FROM regexp_matches(v_def, 'set_termination_forfeit_status_v1\(v_ie_id, ''APPROVED''\)', 'g') ) <> 1 THEN
    RAISE EXCEPTION 'nghiem_thu: thieu bac (1) cap phieu bo coc';
  END IF;
  IF ( SELECT count(*) FROM regexp_matches(v_def, 'public\.approve_income_expense_v1\(v_ie_id\)', 'g') ) <> 1 THEN
    RAISE EXCEPTION 'nghiem_thu: thieu bac (2) duong canonical';
  END IF;
  IF ( SELECT count(*) FROM regexp_matches(v_def, 'public\.approve_voucher\(v_ie_id\)', 'g') ) <> 1 THEN
    RAISE EXCEPTION 'nghiem_thu: thieu bac (3) duong legacy';
  END IF;

  -- 2) BỘ LỌC PHẢI HẸP. Đây là bất biến đắt nhất: bắt trần sqlstate 55000 sẽ nuốt
  --    luôn lỗi "approve transition affected % rows" — một lỗi thật.
  IF v_def !~ 'WHEN sqlstate ''55000'' THEN' THEN
    RAISE EXCEPTION 'nghiem_thu: khong thay nhanh bat 55000';
  END IF;
  IF v_def !~ 'SQLERRM NOT LIKE ''%canonical%''' OR v_def !~ 'SQLERRM NOT LIKE ''%legacy%''' THEN
    RAISE EXCEPTION 'nghiem_thu: nhanh 55000 khong loc theo CA HAI dau canonical va legacy';
  END IF;

  -- 3) Cửa phía trên KHÔNG được nới một dòng nào.
  FOR v_cua IN SELECT unnest(ARRAY[
        'confirmation_required', 'confirmation_not_found', 'confirmation_contract_mismatch',
        'confirmation_already_used', 'confirmation_expired', 'payload_changed',
        'organization_mismatch', 'l5_requires_plan', 'copilot_action_gate_v1',
        'pg_advisory_xact_lock', 'ai_write_audit', 'copilot_draft_invariant_violation',
        'copilot_write_readback_mismatch'])
  LOOP
    IF position(v_cua in v_def) = 0 THEN
      RAISE EXCEPTION 'nghiem_thu: mat cua bao ve "%" khoi wrapper', v_cua;
    END IF;
  END LOOP;

  -- 4) Sổ nói đã đi bậc nào, và vỏ TRẢ VỀ giữ nguyên hợp đồng với engine.
  IF v_def !~ '''duong_duyet'', v_duong' THEN
    RAISE EXCEPTION 'nghiem_thu: so khong ghi duong_duyet';
  END IF;
  IF ( SELECT count(*) FROM regexp_matches(v_def, 'RETURN jsonb_build_object\(', 'g') ) <> 2 THEN
    RAISE EXCEPTION 'nghiem_thu: so vo tra ve doi (phai la 2: da_thuc_hien_truoc_do va da_thuc_hien)';
  END IF;

  -- 5) Khuôn hàm + ACL.
  IF v_def !~ 'SECURITY DEFINER' OR v_def !~ 'SET search_path' THEN
    RAISE EXCEPTION 'nghiem_thu: wrapper mat SECURITY DEFINER hoac search_path ghim';
  END IF;
  SELECT p.proacl::text INTO v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'copilot_execute_ie_duyet_v1'
     AND pg_get_function_identity_arguments(p.oid) = 'p_confirmation_nonce text, p_payload jsonb';
  IF v_acl IS NULL OR v_acl ~ '(\{|,)=[a-zA-Z*]*X' THEN
    RAISE EXCEPTION 'nghiem_thu: wrapper con EXECUTE cho PUBLIC (proacl=%)', COALESCE(v_acl, 'NULL');
  END IF;
END
$nghiem_thu$;

NOTIFY pgrst, 'reload schema';

COMMIT;
