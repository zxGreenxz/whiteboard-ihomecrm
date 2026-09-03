-- G3-FIX migration 1/2 — hai lỗi ĐO ĐƯỢC trong task-G3-E2E-report.md, sửa
-- forward, không đụng chữ ký, không đụng ACL đang cấp.
--
-- (§7) public.set_copilot_feature_flag_v2 — CAS trên revision toàn cục dùng
--   format() để dựng DETAIL cho hai RAISE, cả hai đều thiếu specifier '%s' và
--   chỉ để trần '%'. format() với specifier trần là lỗi CÚ PHÁP của chính nó
--   (22023 'unrecognized format() type specifier'), nên câu RAISE dự định phát
--   ra (40001 copilot_rollout_stale_revision / 22023
--   invalid_rollout_transition) không bao giờ tới nơi — nó chết ngay tại chỗ
--   dựng DETAIL, TRƯỚC KHI transaction kịp bung ERRCODE dự định. Đã đo thật
--   bằng dry-run ROLLBACK trên production trong phiên G3-E2E: CAS vẫn
--   fail-closed (không có lỗ hổng), nhưng client nhận nhầm mã lỗi nên vòng
--   thử-lại của copilot-action-matrix.spec.ts thành mã chết. Sửa ĐÚNG hai dòng
--   named ở trên; phần còn lại của thân hàm chép NGUYÊN VĂN từ định nghĩa đang
--   sống trên production (xác minh bằng pg_get_functiondef ngay trước khi viết
--   migration này).
--
-- (§6) public.copilot_plan_approve_v1 — nhánh ghi-rồi-RETURN 'plan_expired'
--   (quyết định 4 ở đầu 20260903100253) không bao giờ với tới được qua đường
--   thường: kế hoạch và phiếu đồng ý cùng nhận cùng một 'clock_timestamp() +
--   5 phút' lúc create, và cửa nonce ('confirmation_expired', RAISE — cuốn
--   ngược) đứng TRƯỚC cửa kế hoạch trong thân hàm cũ, nên một kế hoạch quá hạn
--   luôn ném 403 confirmation_expired chứ không bao giờ chạy tới nhánh ghi
--   EXPIRED + trả plan_expired. Đo thật bằng một lượt chờ 5 phút 5 giây trên
--   production trong phiên G3-E2E (§6 của report đó). Chọn Phương án 1 của
--   brief: ĐỔI THỨ TỰ — kiểm plans.expires_at TRƯỚC khi tra
--   confirmation.expires_at — thay vì nới hạn confirmation, vì hạn của
--   confirmation là ranh giới bảo mật của chính nonce (CHƯA từng có ai đề nghị
--   nới nó). Đây là dịch chuyển NGUYÊN VẸN một khối IF xuống dưới nhánh
--   plan_expired; không có dòng nào khác trong thân hàm bị đổi (đối chiếu bằng
--   diff với pg_get_functiondef của bản đang sống — xem tail giống hệt).
--
-- CẢ HAI đều là CREATE OR REPLACE cùng chữ ký (không overload); ACL tái cấp
-- lại đúng nguyên trạng đang sống (authenticated only — đã đo has_function_
-- privilege trên production trước khi viết migration), REVOKE PUBLIC/anon/
-- service_role được để guarded bằng to_regrole cho an toàn dry-run.
--
-- Nghiệm thu CATALOG-ONLY — migration này chạy được trên Restore Drill (schema
-- baseline rỗng dữ liệu): khối cuối chỉ đọc pg_proc.prosrc + has_function_
-- privilege, không đụng bảng nào.
BEGIN;
SET LOCAL lock_timeout = '15s';

DO $tien_de$
BEGIN
  IF to_regprocedure('public.set_copilot_feature_flag_v2(text, text, text, bigint, uuid, text, text, timestamptz, text)') IS NULL THEN
    RAISE EXCEPTION 'set_copilot_feature_flag_v2 missing — 20260829030000 must run first';
  END IF;
  IF to_regprocedure('public.copilot_plan_approve_v1(uuid, text, text, integer, text)') IS NULL THEN
    RAISE EXCEPTION 'copilot_plan_approve_v1 missing — 20260903100253 must run first';
  END IF;
END
$tien_de$;

-- ============================================================================
-- Fix 1 — copilot_rollout_stale_revision / invalid_rollout_transition format()
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_copilot_feature_flag_v2(
  p_scope text,
  p_contract_id text,
  p_state text,
  p_expected_revision bigint,
  p_canary_org uuid DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_evidence_link text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_rollback_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_current_revision bigint;
  v_row public.copilot_feature_flags%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'expected_revision_required' USING ERRCODE = '22023';
  END IF;
  IF p_scope NOT IN ('page', 'action')
     OR btrim(COALESCE(p_contract_id, '')) = ''
     OR p_state NOT IN ('disabled', 'shadow', 'enabled') THEN
    RAISE EXCEPTION 'invalid_rollout_contract' USING ERRCODE = '22023';
  END IF;
  IF btrim(COALESCE(p_reason, '')) = ''
     OR btrim(COALESCE(p_evidence_link, '')) = ''
     OR btrim(COALESCE(p_rollback_reference, '')) = '' THEN
    RAISE EXCEPTION 'rollout_evidence_required' USING ERRCODE = '22023';
  END IF;

  -- Serialize the global CAS check before locking the individual flag row.
  PERFORM pg_advisory_xact_lock(hashtext('copilot_feature_rollout_global')::bigint);
  SELECT s.last_value
  INTO v_current_revision
  FROM public.copilot_feature_rollout_revision_seq s;
  IF v_current_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'copilot_rollout_stale_revision'
      USING ERRCODE = '40001',
            DETAIL = format('expected %s, current %s', p_expected_revision, v_current_revision);
  END IF;

  SELECT f.*
  INTO v_row
  FROM public.copilot_feature_flags f
  WHERE f.scope = p_scope
    AND f.contract_id = btrim(p_contract_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_rollout_contract' USING ERRCODE = '22023';
  END IF;
  IF v_row.state = p_state
     OR NOT (
       (v_row.state = 'disabled' AND p_state = 'shadow')
       OR (v_row.state = 'shadow' AND p_state = 'enabled')
       OR (v_row.state = 'shadow' AND p_state = 'disabled')
       OR (v_row.state = 'enabled' AND p_state = 'shadow')
       OR (v_row.state = 'enabled' AND p_state = 'disabled')
     ) THEN
    RAISE EXCEPTION 'invalid_rollout_transition'
      USING ERRCODE = '22023',
            DETAIL = format('%s -> %s', v_row.state, p_state);
  END IF;
  IF p_state = 'disabled' AND (p_canary_org IS NOT NULL OR p_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'disabled_rollout_cannot_be_canary_scoped' USING ERRCODE = '22023';
  END IF;
  IF p_canary_org IS NULL AND p_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'rollout_expiry_requires_canary_org' USING ERRCODE = '22023';
  END IF;
  IF p_canary_org IS NOT NULL
     AND (p_expires_at IS NULL OR p_expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'canary_expiry_required' USING ERRCODE = '22023';
  END IF;
  IF p_canary_org IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.organizations o
    WHERE o.id = p_canary_org
      AND o.status = 'ACTIVE'
      AND NOT (o.id = ANY(public.sandbox_org_ids()))
  ) THEN
    RAISE EXCEPTION 'invalid_canary_organization' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.copilot_feature_flag_transition', 'v2', true);
  UPDATE public.copilot_feature_flags f
  SET state = p_state,
      canary_org = p_canary_org,
      updated_by = v_actor,
      reason = btrim(p_reason),
      evidence_link = btrim(p_evidence_link),
      expires_at = p_expires_at,
      rollback_reference = btrim(p_rollback_reference)
  WHERE f.scope = v_row.scope
    AND f.contract_id = v_row.contract_id
  RETURNING f.* INTO v_row;
  PERFORM set_config('app.copilot_feature_flag_transition', '', true);

  -- The existing AFTER trigger appends the immutable audit event in this
  -- transaction, carrying the trigger-assigned global revision.
  RETURN jsonb_build_object(
    'scope', v_row.scope,
    'contract_id', v_row.contract_id,
    'state', v_row.state,
    'canary_org', v_row.canary_org,
    'expires_at', v_row.expires_at,
    'revision', v_row.revision,
    'updated_by', v_row.updated_by,
    'updated_at', v_row.updated_at,
    'reason', v_row.reason,
    'evidence_link', v_row.evidence_link,
    'rollback_reference', v_row.rollback_reference
  );
END
$fn$;

-- Tái cấp ACL đúng nguyên trạng đang sống trên production (đo bằng
-- has_function_privilege trước khi viết migration này): chỉ authenticated,
-- không anon, không service_role, không PUBLIC.
DO $acl_flag$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.set_copilot_feature_flag_v2(text, text, text, bigint, uuid, text, text, timestamptz, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.set_copilot_feature_flag_v2(text, text, text, bigint, uuid, text, text, timestamptz, text) FROM service_role;
  END IF;
  REVOKE ALL ON FUNCTION public.set_copilot_feature_flag_v2(text, text, text, bigint, uuid, text, text, timestamptz, text) FROM PUBLIC;
END
$acl_flag$;
GRANT EXECUTE ON FUNCTION public.set_copilot_feature_flag_v2(text, text, text, bigint, uuid, text, text, timestamptz, text) TO authenticated;

-- ============================================================================
-- Fix 2 — copilot_plan_approve_v1: plan_expired TRƯỚC confirmation_expired
-- ============================================================================

CREATE OR REPLACE FUNCTION public.copilot_plan_approve_v1(
  p_plan_id               uuid,
  p_consent_nonce         text,
  p_plan_digest           text,
  p_expected_plan_version int,
  p_step_up_token         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $duyet_ke_hoach$
DECLARE
  v_actor      uuid := auth.uid();
  v_conf       app_private.copilot_write_confirmations%ROWTYPE;
  v_plan       app_private.copilot_plans%ROWTYPE;
  v_reg        app_private.copilot_action_registry%ROWTYPE;
  v_step       app_private.copilot_plan_steps%ROWTYPE;
  v_max_direct text;
  v_policy_rev bigint;
  v_ly_do      text := NULL;
  v_chi_tiet   text := NULL;
  v_buoc_hong  int := NULL;
  v_version    int;
  v_han        timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Hình sai thì không cần chạm bảng nonce: một lời gọi không có nonce thật
  -- không được phép soi cả bảng đó.
  IF p_consent_nonce IS NULL OR p_consent_nonce !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '42501';
  END IF;
  IF p_plan_digest IS NULL OR p_plan_digest !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'plan_digest_mismatch' USING ERRCODE = '22023';
  END IF;

  -- Khoá hàng nonce ngay từ đầu: hai lần bấm song song phải có đúng một lần thắng.
  SELECT * INTO v_conf
    FROM app_private.copilot_write_confirmations c
   WHERE c.nonce_digest = extensions.digest(decode(p_consent_nonce, 'hex'), 'sha256')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  -- Nonce của người khác trả về cùng một câu với "không tìm thấy" — trả lời khác
  -- đi là xác nhận giúp kẻ gọi rằng nonce đó có thật.
  IF v_conf.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_conf.tool IS DISTINCT FROM 'lap_ke_hoach'
     OR v_conf.permission_key IS DISTINCT FROM 'copilot.execution_plan' THEN
    RAISE EXCEPTION 'confirmation_contract_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_conf.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id AND p.user_id = v_actor
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    -- Hai tab. Không chờ: một trong hai đang ở giữa một chuỗi ghi tiền.
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_plan.organization_id IS DISTINCT FROM v_conf.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;
  -- Ba vế phải trùng nhau: vân tay lưu trong kế hoạch, `payload_hash` của hàng
  -- nonce, và chuỗi giao diện echo lại. Lệch một vế nghĩa là thứ người dùng nhìn
  -- thấy không phải thứ sắp chạy.
  IF v_plan.plan_digest IS DISTINCT FROM decode(p_plan_digest, 'hex')
     OR v_conf.payload_hash IS DISTINCT FROM v_plan.plan_digest THEN
    RAISE EXCEPTION 'plan_digest_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_plan.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'plan_not_draft: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;
  IF p_expected_plan_version IS NULL OR v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale: dang o %, nguoi goi mong %',
      v_plan.version, p_expected_plan_version
      USING ERRCODE = '40001';
  END IF;

  -- QUÁ HẠN. Ghi trạng thái rồi TRẢ VỀ, không RAISE — xem quyết định 4 ở đầu file.
  IF v_plan.expires_at <= clock_timestamp() THEN
    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_expired'
     WHERE plan_id = v_plan.id AND status = 'PENDING';
    UPDATE app_private.copilot_plans
       SET status = 'EXPIRED', version = version + 1,
           failure_reason = 'plan_expired', updated_at = clock_timestamp()
     WHERE id = v_plan.id
    RETURNING version INTO v_version;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'plan_expired',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'plan_version',    v_version,
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_plan.consent_confirmation_id,
      'consent_kind',    v_plan.consent_kind,
      'step_up_id',      v_plan.step_up_confirmation_id,
      'error_code',      'plan_expired',
      'outcome',         jsonb_build_object('giai_doan', 'approve')));
    RETURN jsonb_build_object(
      'ok',               false,
      'error_code',       'plan_expired',
      'plan_id',          v_plan.id,
      'plan_version',     v_version,
      'plan_status',      'EXPIRED',
      'execute_deadline', NULL);
  END IF;

  -- Đổi thứ tự: quá hạn của KẾ HOẠCH được kiểm TRƯỚC quá hạn của
  -- CONFIRMATION, để nhánh ghi-rồi-RETURN plan_expired phía trên với tới được.
  -- Trước đợt này cửa nonce (bên trên, cùng khối duyệt) luôn đứng trước cửa kế
  -- hoạch nên plan_expired là mã chết — vì thời điểm tạo gán CÙNG một hạn cho cả
  -- hai hàng. Xem G3-FIX brief mục 1 + task-G3-E2E-report.md §6.
  IF v_conf.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'confirmation_expired' USING ERRCODE = '42501';
  END IF;

  SELECT max_direct_risk, revision INTO v_max_direct, v_policy_rev
    FROM app_private.copilot_action_policy WHERE id;
  -- Thiếu hàng policy KHÔNG được rơi vào im lặng: `v_max_direct` NULL làm điều
  -- kiện step-up ngay dưới lặng lẽ sai, và phép so trần rủi ro trong vòng lặp
  -- cũng thành vô nghĩa. Van trần rủi ro mà biến mất thì đóng cửa, đừng đoán.
  IF v_max_direct IS NULL OR v_policy_rev IS NULL THEN
    RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
  END IF;

  -- ĐIỂM NỐI #3 — step-up PIN. Ở v1 (`max_direct_risk = 'L4'`) một kế hoạch L5
  -- chỉ có thể là L5 nhờ `maker_submit_v1`, vốn được miễn trần, nên nhánh này
  -- chưa chạy trong thực tế; nó tồn tại để G5-A chỉ phải thay THÂN, không phải
  -- thay chữ ký và không phải đụng giao diện.
  IF v_plan.max_risk = 'L5' AND v_max_direct = 'L5' AND p_step_up_token IS NULL THEN
    RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
  END IF;
  IF p_step_up_token IS NOT NULL THEN
    RAISE EXCEPTION 'step_up_not_implemented' USING ERRCODE = '0A000';
  END IF;

  -- Công tắc của cả cơ chế, hỏi LẠI. Tắt giữa lúc lập và lúc bấm là chuyện thật
  -- (đó chính là ý nghĩa của một kill switch), và ở đây chưa có gì để ghi lại
  -- nên NÉM là câu trả lời đúng: kế hoạch ở nguyên DRAFT rồi tự hết hạn.
  IF NOT app_private.copilot_action_flag_allows_v1(
           'copilot.execution_plan', v_plan.organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  -- POLICY ĐƯỢC ÉP LẠI Ở ĐÂY, KHÔNG CHỈ Ở LÚC LẬP.
  --
  --   `copilot_action_gate_v1` KHÔNG biết gì về trần rủi ro hay danh sách vai:
  --   nó đo registry + cờ + cấm khẩn cấp + phạm vi quyền. Nghĩa là nếu policy
  --   chỉ được ép ở `create`, thì một lần hạ trần L4 → L3 (hoặc bỏ `owner` khỏi
  --   `allowed_roles`) ở phút thứ 2 KHÔNG chạm được vào một kế hoạch lập ở phút
  --   0: nó vẫn duyệt được ở phút 3 và chạy tới phút 35. Van mà không có tác
  --   dụng lên thứ đang chờ chạy thì nó không phải van.
  --
  --   Ba vế, và cả ba đi cùng một mã `policy_changed` vì với người bấm chúng là
  --   một chuyện: luật đã đổi kể từ lúc kế hoạch này được lập.
  IF v_policy_rev IS DISTINCT FROM v_plan.policy_revision THEN
    v_ly_do := 'policy_changed';
  ELSIF NOT app_private.copilot_plan_role_allowed_v1(v_plan.organization_id) THEN
    v_ly_do := 'policy_changed';
  END IF;

  -- KIỂM LẠI TOÀN BỘ BƯỚC NGAY TRƯỚC KHI DUYỆT. Giữa lúc lập và lúc bấm có tới 5
  -- phút: đủ để ai đó thu quyền, tắt một action, hoặc kéo cầu dao khẩn cấp.
  FOR v_step IN
    SELECT * FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id ORDER BY step_no
  LOOP
    -- Vế policy ở trên đã chốt lý do thì bước ĐẦU TIÊN mang nó — không chạy tiếp
    -- vòng lặp để một mã lỗi khác đè lên.
    IF v_ly_do IS NOT NULL THEN
      v_buoc_hong := v_step.step_no;
      EXIT;
    END IF;
    BEGIN
      SELECT * INTO v_reg
        FROM app_private.copilot_action_registry
       WHERE action_id = v_step.action_id;
      IF NOT FOUND OR NOT v_reg.enabled OR v_reg.version <> v_step.action_version THEN
        v_ly_do := 'registry_changed';
      -- Trần rủi ro, đo LẠI theo policy của lúc BẤM. Miễn trừ vẫn theo đúng một
      -- `executor_kind` như ở `create`, không theo mức rủi ro.
      ELSIF v_reg.executor_kind <> 'maker_submit_v1'
            AND (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
              > (CASE v_max_direct WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END) THEN
        v_ly_do := 'policy_changed';
      ELSE
        PERFORM app_private.copilot_action_gate_v1(v_step.action_id, v_plan.organization_id);
      END IF;
    EXCEPTION WHEN others THEN
      -- Giữ nguyên mã lỗi THẬT của cửa đã chặn (`copilot_action_disabled`,
      -- `tenant_emergency_denied`, `not_permitted`…). Ép tất cả về một chữ
      -- `step_not_permitted` sẽ làm người trực sự cố đi sửa phân quyền cho một
      -- lệnh cấm khẩn cấp — cùng lớp lỗi mà thứ tự bốn cửa của G2-A đã sửa.
      GET STACKED DIAGNOSTICS v_chi_tiet = MESSAGE_TEXT;
      v_ly_do := COALESCE(NULLIF(split_part(v_chi_tiet, ':', 1), ''), 'step_not_permitted');
    END;
    IF v_ly_do IS NOT NULL THEN
      v_buoc_hong := v_step.step_no;
      EXIT;
    END IF;
  END LOOP;

  IF v_ly_do IS NOT NULL THEN
    -- NONCE VẪN BỊ TIÊU. Người dùng đã bấm; phiếu đồng ý đó đã được dùng, và
    -- việc kế hoạch không chạy được là câu trả lời chứ không phải một lần bấm
    -- hỏng. Để nonce sống tiếp là mở đường thử lại tới khi lọt.
    UPDATE app_private.copilot_write_confirmations
       SET consumed_at = clock_timestamp()
     WHERE id = v_conf.id AND consumed_at IS NULL;

    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED',
           error_code = CASE WHEN step_no = v_buoc_hong THEN v_ly_do ELSE 'plan_failed' END
     WHERE plan_id = v_plan.id AND status = 'PENDING';

    UPDATE app_private.copilot_plans
       SET status = 'FAILED',
           version = version + 1,
           consent_confirmation_id = v_conf.id,
           consent_kind = 'click',
           -- Cùng khuôn với `execute_step`: <sự kiện sổ>:<bước>:<mã lỗi thật>.
           -- Mã lỗi thật là `policy_changed`, `registry_changed`,
           -- `copilot_action_disabled`, `tenant_emergency_denied`,
           -- `not_permitted`… — xem khối EXCEPTION ở vòng lặp trên.
           failure_reason = 'step_blocked:' || v_buoc_hong::text || ':' || v_ly_do,
           updated_at = clock_timestamp()
     WHERE id = v_plan.id
    RETURNING version INTO v_version;

    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'step_blocked',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'step_no',         v_buoc_hong,
      'plan_version',    v_version,
      'action_id',       (SELECT action_id FROM app_private.copilot_plan_steps
                           WHERE plan_id = v_plan.id AND step_no = v_buoc_hong),
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_conf.id,
      'consent_kind',    'click',
      'step_up_id',      v_plan.step_up_confirmation_id,
      'error_code',      v_ly_do,
      'outcome',         jsonb_build_object('giai_doan', 'approve', 'plan_status', 'FAILED')));

    RETURN jsonb_build_object(
      'ok',               false,
      'error_code',       v_ly_do,
      'plan_id',          v_plan.id,
      'plan_version',     v_version,
      'plan_status',      'FAILED',
      'execute_deadline', NULL,
      'step_no',          v_buoc_hong);
  END IF;

  -- CAS TIÊU NONCE. `consumed_at IS NULL` trong WHERE là thứ biến hai lần bấm
  -- song song thành một lần duyệt.
  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE id = v_conf.id AND consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  v_han := clock_timestamp() + interval '30 minutes';
  UPDATE app_private.copilot_plans
     SET status = 'APPROVED',
         approved_at = clock_timestamp(),
         execute_deadline = v_han,
         consent_confirmation_id = v_conf.id,
         consent_kind = 'click',
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE id = v_plan.id AND version = p_expected_plan_version
  RETURNING version INTO v_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
  END IF;

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',           'plan_approved',
    'organization_id', v_plan.organization_id,
    'plan_id',         v_plan.id,
    'plan_version',    v_version,
    'permission_key',  'copilot.execution_plan',
    'permission_snapshot', jsonb_build_object(
      'registry_revision', v_plan.registry_revision,
      'policy_revision',   v_policy_rev,
      'max_direct_risk',   v_max_direct,
      'plan_max_risk',     v_plan.max_risk,
      'step_count',        v_plan.step_count,
      'is_super_admin',    public.is_super_admin(),
      'checked_at',        clock_timestamp()),
    'consent_id',      v_conf.id,
    'consent_kind',    'click',
    'step_up_id',      v_plan.step_up_confirmation_id,
    'payload_digest',  encode(v_plan.plan_digest, 'hex'),
    'outcome', jsonb_build_object('plan_status', 'APPROVED', 'execute_deadline', v_han)));

  RETURN jsonb_build_object(
    'ok',               true,
    'error_code',       NULL,
    'plan_id',          v_plan.id,
    'plan_version',     v_version,
    'plan_status',      'APPROVED',
    'execute_deadline', v_han);
END
$duyet_ke_hoach$;

-- Tái cấp ACL đúng nguyên trạng đang sống trên production.
DO $acl_approve$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) FROM service_role;
  END IF;
  REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) FROM PUBLIC;
END
$acl_approve$;
GRANT EXECUTE ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) TO authenticated;

-- ============================================================================
-- Nghiệm thu — catalog-only, chạy được trên schema-only baseline
-- ============================================================================
DO $nghiem_thu$
DECLARE
  v_src_flag    text;
  v_src_approve text;
BEGIN
  IF to_regprocedure('public.set_copilot_feature_flag_v2(text, text, text, bigint, uuid, text, text, timestamptz, text)') IS NULL THEN
    RAISE EXCEPTION 'set_copilot_feature_flag_v2 missing after apply';
  END IF;
  IF to_regprocedure('public.copilot_plan_approve_v1(uuid, text, text, integer, text)') IS NULL THEN
    RAISE EXCEPTION 'copilot_plan_approve_v1 missing after apply';
  END IF;

  SELECT prosrc INTO v_src_flag FROM pg_proc
   WHERE oid = 'public.set_copilot_feature_flag_v2(text, text, text, bigint, uuid, text, text, timestamptz, text)'::regprocedure;
  IF strpos(v_src_flag, 'expected %s, current %s') = 0 THEN
    RAISE EXCEPTION 'set_copilot_feature_flag_v2: stale-revision format specifier not fixed';
  END IF;
  IF strpos(v_src_flag, 'expected %, current %') > 0 THEN
    RAISE EXCEPTION 'set_copilot_feature_flag_v2: stale-revision format() bug still present';
  END IF;
  IF strpos(v_src_flag, '%s -> %s') = 0 THEN
    RAISE EXCEPTION 'set_copilot_feature_flag_v2: invalid-transition format specifier not fixed';
  END IF;
  IF strpos(v_src_flag, '% -> %') > 0 THEN
    RAISE EXCEPTION 'set_copilot_feature_flag_v2: invalid-transition format() bug still present';
  END IF;

  SELECT prosrc INTO v_src_approve FROM pg_proc
   WHERE oid = 'public.copilot_plan_approve_v1(uuid, text, text, integer, text)'::regprocedure;
  IF strpos(v_src_approve, 'plan_expired') = 0 OR strpos(v_src_approve, 'confirmation_expired') = 0 THEN
    RAISE EXCEPTION 'copilot_plan_approve_v1: expected branches missing after apply';
  END IF;
  IF strpos(v_src_approve, 'plan_expired') > strpos(v_src_approve, 'confirmation_expired') THEN
    RAISE EXCEPTION 'copilot_plan_approve_v1: plan_expired must be checked before confirmation_expired';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    IF has_function_privilege('anon', 'public.set_copilot_feature_flag_v2(text, text, text, bigint, uuid, text, text, timestamptz, text)'::regprocedure, 'EXECUTE')
      OR has_function_privilege('anon', 'public.copilot_plan_approve_v1(uuid, text, text, integer, text)'::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon must not execute either fixed function';
    END IF;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    IF has_function_privilege('service_role', 'public.set_copilot_feature_flag_v2(text, text, text, bigint, uuid, text, text, timestamptz, text)'::regprocedure, 'EXECUTE')
      OR has_function_privilege('service_role', 'public.copilot_plan_approve_v1(uuid, text, text, integer, text)'::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role must not execute either fixed function';
    END IF;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    IF NOT has_function_privilege('authenticated', 'public.set_copilot_feature_flag_v2(text, text, text, bigint, uuid, text, text, timestamptz, text)'::regprocedure, 'EXECUTE')
      OR NOT has_function_privilege('authenticated', 'public.copilot_plan_approve_v1(uuid, text, text, integer, text)'::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated must keep EXECUTE on both fixed functions';
    END IF;
  END IF;

  RAISE NOTICE 'G3-FIX migration 1/2: format() fixed + plan_expired ordering fixed + ACL reasserted.';
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
