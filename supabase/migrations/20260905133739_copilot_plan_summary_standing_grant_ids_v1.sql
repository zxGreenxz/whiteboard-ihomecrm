-- =============================================================================
-- copilot_plan_summary_standing_grant_ids_v1 — bản đọc kế hoạch thiếu đúng MỘT khoá
-- Ngày 05/09/2026 · ca 4 (uỷ quyền đứng) của ma trận L5 còn đỏ vì BẢN ĐỌC, không vì máy uỷ quyền
-- =============================================================================
-- VẤN ĐỀ — HÀNG GHI ĐÚNG, SỔ ĐÚNG, CHỈ BẢN ĐỌC KHÔNG NÓI RA
--   E2E thật (run 33965915915, trên bản dựng e4d0f385 đang chạy production, Mức 3 BẬT)
--   làm ca 4 của `.e2e-fleet/specs/copilot-plan-l5-matrix.spec.ts:823` đỏ ở đúng một dòng:
--
--     expect(ke.standing_grant_ids ?? []).toContain(grantId);
--       Expected value:  "cd8a4a75-623d-4bc5-a8c9-bb04bcc1a587"
--       Received array:  []
--
--   Hai dòng ngay trên nó XANH: `plan_status = 'APPROVED'` và `consent_nonce = null`,
--   tức nhánh tự duyệt theo uỷ quyền đứng ĐÃ chạy đúng sau bản vá 20260905091725.
--   Đọc lại `copilot_plan_create_v1`: hàng `copilot_plans` được ghi
--   `standing_grant_ids = v_final_grant_ids`, dòng sổ `plan_approved` cũng mang mảng id
--   đó, và mỗi uỷ quyền được ghi một dòng `grant_used`. Máy uỷ quyền không sai gì.
--
--   Chỗ hụt nằm ở BẢN ĐỌC: `app_private.copilot_plan_summary_v1` — sinh ở
--   20260903100253_copilot_execution_plan_v1.sql:523, và là ĐỊNH NGHĨA DUY NHẤT trên
--   toàn repo — không hề dựng khoá `standing_grant_ids` trong `jsonb_build_object`.
--   Khoá vắng mặt nên JSON trả về không có trường đó, `?? []` của spec biến nó thành
--   mảng rỗng. Người duyệt cũng không đọc được kế hoạch vừa tiêu uỷ quyền nào.
--
-- VÌ SAO MỘT LẦN SỬA LÀ ĐỦ CHO CẢ HAI ĐƯỜNG ĐỌC
--   Hàm này là chỗ lược bỏ bí mật duy nhất: `copilot_plan_create_v1` (khi trả lại kế
--   hoạch cũ, hoặc kế hoạch vừa tự duyệt) và `copilot_plan_get_v1` (giao diện poll) đều
--   đi qua nó — đúng như COMMENT của chính hàm ghi. Thêm khoá ở đây là cả hai đường thấy.
--
-- KHUÔN GIỮ NGUYÊN, KHÔNG NỚI THÊM GÌ
--   * Chữ ký không đổi (`(uuid) RETURNS jsonb`) nên CREATE OR REPLACE là đủ — không
--     DROP, không đẻ overload, PostgREST không phải chọn giữa hai bản.
--   * `standing_grant_ids` là `uuid[] NOT NULL DEFAULT '{}'` (20260903100253:179), nên
--     đường bấm tay và đường PIN ra MẢNG RỖNG, không ra NULL. `COALESCE(...,'[]')` là
--     đai an toàn nếu về sau cột bị nới thành nullable — chớ đọc nó thành "cột này đang
--     có thể NULL".
--   * KHÔNG thêm trường nào khác. Thứ tuyệt đối không ra khỏi hàm này vẫn nguyên: nonce
--     (không lưu), `canonical`, `payload`, `payload_digest` thô — khối nghiệm thu dưới
--     canh đúng bốn thứ đó.
--   * Phát lại nguyên khối REVOKE: CREATE OR REPLACE giữ ACL cũ, nhưng phát lại là
--     idempotent và giữ `check-definer-acl` xanh khi hàm được sinh lại trên DB rỗng
--     (Contract: hàm SECURITY DEFINER phải REVOKE anon + authenticated RIÊNG — REVOKE
--     FROM PUBLIC không cắt anon trên Supabase).
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION app_private.copilot_plan_summary_v1(p_plan_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $tom_tat$
  SELECT jsonb_build_object(
    'plan_id',            p.id,
    'plan_version',       p.version,
    'plan_digest',        encode(p.plan_digest, 'hex'),
    'plan_status',        p.status,
    'organization_id',    p.organization_id,
    'client_request_id',  p.client_request_id,
    'max_risk',           p.max_risk,
    'step_count',         p.step_count,
    'consent_kind',       p.consent_kind,
    -- MỚI 05/09: người duyệt phải đọc được kế hoạch này tiêu uỷ quyền đứng nào.
    -- Cột NOT NULL DEFAULT '{}' nên đường bấm tay / đường PIN ra mảng rỗng.
    'standing_grant_ids', COALESCE(to_jsonb(p.standing_grant_ids), '[]'::jsonb),
    'registry_revision',  p.registry_revision,
    'policy_revision',    p.policy_revision,
    'expires_at',         p.expires_at,
    'approved_at',        p.approved_at,
    'execute_deadline',   p.execute_deadline,
    'failure_reason',     p.failure_reason,
    'created_at',         p.created_at,
    'updated_at',         p.updated_at,
    'steps', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'step_no',       s.step_no,
               'action_id',     s.action_id,
               'label_vi',      COALESCE(r.label_vi, s.action_id),
               'risk',          s.risk,
               'executor_kind', s.executor_kind,
               'status',        s.status,
               'preview',       s.preview,
               'outcome',       s.outcome,
               'error_code',    s.error_code,
               'ref_step',      s.ref_step,
               'executed_at',   s.executed_at
             ) ORDER BY s.step_no)
        FROM app_private.copilot_plan_steps s
        LEFT JOIN app_private.copilot_action_registry r ON r.action_id = s.action_id
       WHERE s.plan_id = p.id), '[]'::jsonb)
  )
    FROM app_private.copilot_plans p
   WHERE p.id = p_plan_id;
$tom_tat$;

COMMENT ON FUNCTION app_private.copilot_plan_summary_v1(uuid) IS
  'Ban doc DA LUOC BO cua mot ke hoach: khong nonce, khong canonical, khong payload, khong digest '
  'tho. Ca copilot_plan_create_v1 (tra lai ke hoach cu) lan copilot_plan_get_v1 deu di qua day. '
  'Tu 05/09/2026 co them standing_grant_ids (mang rong khi ke hoach di duong bam tay hoac duong PIN).';

REVOKE ALL ON FUNCTION app_private.copilot_plan_summary_v1(uuid) FROM PUBLIC;
DO $thu_hoi_tom_tat$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_summary_v1(uuid) FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_summary_v1(uuid) FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_summary_v1(uuid) FROM service_role;
  END IF;
END
$thu_hoi_tom_tat$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog nên chạy được cả trên DB rỗng của Restore Drill
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_def text;
  v_acl text;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.proacl::text
    INTO v_def, v_acl
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private'
     AND p.proname = 'copilot_plan_summary_v1'
     AND pg_get_function_identity_arguments(p.oid) = 'p_plan_id uuid';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'nghiem_thu: khong thay app_private.copilot_plan_summary_v1(p_plan_id uuid)';
  END IF;

  -- 1) Khoá vừa thêm phải có thật — đây đúng là nguyên nhân ca 4 đỏ.
  IF position('standing_grant_ids' in v_def) = 0 THEN
    RAISE EXCEPTION 'nghiem_thu: ban doc ke hoach van thieu khoa standing_grant_ids';
  END IF;

  -- 2) Bốn thứ tuyệt đối không được ra khỏi bản đọc.
  IF v_def ~ 'canonical' THEN
    RAISE EXCEPTION 'nghiem_thu: ban doc lot canonical';
  END IF;
  IF v_def ~ 'payload_digest' THEN
    RAISE EXCEPTION 'nghiem_thu: ban doc lot payload_digest tho';
  END IF;
  IF v_def ~ 's\.payload' THEN
    RAISE EXCEPTION 'nghiem_thu: ban doc lot payload cua buoc';
  END IF;
  IF v_def ~ 'consent_nonce' THEN
    RAISE EXCEPTION 'nghiem_thu: ban doc lot consent_nonce';
  END IF;

  -- 3) Khuôn hàm không được nới: vẫn DEFINER + STABLE + search_path ghim.
  IF v_def !~ 'SECURITY DEFINER' THEN
    RAISE EXCEPTION 'nghiem_thu: mat SECURITY DEFINER';
  END IF;
  IF v_def !~ 'STABLE' THEN
    RAISE EXCEPTION 'nghiem_thu: mat STABLE';
  END IF;
  IF v_def !~ 'SET search_path' THEN
    RAISE EXCEPTION 'nghiem_thu: mat SET search_path';
  END IF;

  -- 4) ACL: bản đọc này là hàng nội bộ, chỉ owner được EXECUTE.
  --    proacl NULL nghĩa là đang ăn mặc định của Postgres — mà mặc định của
  --    hàm là EXECUTE cho PUBLIC, nên NULL ở đây là lỗi, không phải "sạch".
  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'nghiem_thu: proacl NULL nen PUBLIC van co EXECUTE theo mac dinh';
  END IF;
  IF v_acl ~ '(\{|,)=[a-zA-Z*]*X' THEN
    RAISE EXCEPTION 'nghiem_thu: PUBLIC con EXECUTE tren ban doc ke hoach';
  END IF;
  IF to_regrole('anon') IS NOT NULL
     AND has_function_privilege('anon', 'app_private.copilot_plan_summary_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: anon con EXECUTE tren ban doc ke hoach';
  END IF;
  IF to_regrole('authenticated') IS NOT NULL
     AND has_function_privilege('authenticated', 'app_private.copilot_plan_summary_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: authenticated con EXECUTE tren ban doc ke hoach';
  END IF;
  IF to_regrole('service_role') IS NOT NULL
     AND has_function_privilege('service_role', 'app_private.copilot_plan_summary_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: service_role con EXECUTE tren ban doc ke hoach';
  END IF;

  RAISE NOTICE 'nghiem_thu: copilot_plan_summary_v1 da co standing_grant_ids, khong lot bi mat, ACL sach';
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
