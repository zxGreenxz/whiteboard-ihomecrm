-- G5-C2 (bổ sung, theo yêu cầu điều phối viên — E2E review phát hiện: mất PIN
-- thì KHÔNG có đường phục hồi). `copilot_step_up_set_pin_v1` (đổi PIN) đòi PIN
-- CŨ khớp khi đã có hàng trong `app_private.copilot_step_up_pins` — đúng, đó
-- là hàng rào chống ai đó đổi PIN người khác qua một phiên đã đăng nhập. Nhưng
-- nếu người giữ PIN THẬT SỰ quên nó, không ai (kể cả chính họ) tự đặt lại
-- được: `set_pin_v1` luôn đòi khớp PIN cũ trước khi ghi đè.
--
-- `copilot_step_up_reset_pin_v1(p_user_id, p_reason)` — super admin only, XOÁ
-- hẳn hàng PIN của mục tiêu (không chỉ mở khoá đếm/lock như
-- `copilot_step_up_unlock_v1`), để `set_pin_v1` của CHÍNH người đó đi vào
-- nhánh TẠO MỚI (không hàng cũ ⇒ không đòi PIN cũ). Dọn luôn mọi
-- `copilot_write_confirmations` (tool='step_up') CHƯA TIÊU của người đó — một
-- token step-up cũ (bằng chứng "đã xác thực bằng PIN cũ", còn hiệu lực 5
-- phút) không nên sống sót qua một lần reset quản trị.
BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- MUC 0 - MO RONG ENUM SO HANH DONG them 'step_up_pin_reset', va cho phep
-- organization_id NULL o su kien nay (giong 'policy_changed'/'step_up_pin_set'
-- /'step_up_unlocked'/'step_up_locked' — hanh dong nay khong gan mot to chuc
-- nao). Idempotent: chi DROP+ADD lai CHECK khi chua co gia tri moi.
-- ---------------------------------------------------------------------------
DO $mo_rong_ledger_event$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'app_private.copilot_action_ledger'::regclass
       AND conname = 'copilot_action_ledger_event_check'
       AND pg_get_constraintdef(oid) LIKE '%step_up_pin_reset%'
  ) THEN
    ALTER TABLE app_private.copilot_action_ledger
      DROP CONSTRAINT IF EXISTS copilot_action_ledger_event_check;
    ALTER TABLE app_private.copilot_action_ledger
      ADD CONSTRAINT copilot_action_ledger_event_check
      CHECK (event = ANY (ARRAY[
        'plan_created','plan_approved','step_done','step_failed','step_blocked',
        'plan_cancelled','plan_expired','action_executed','action_failed',
        'policy_changed','capability_changed','step_up_pin_set','step_up_verified',
        'step_up_locked','step_up_unlocked','grant_created','grant_revoked',
        'grant_used','step_reconciled','step_up_pin_reset']));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'app_private.copilot_action_ledger'::regclass
       AND conname = 'copilot_action_ledger_org_required'
       AND pg_get_constraintdef(oid) LIKE '%step_up_pin_reset%'
  ) THEN
    ALTER TABLE app_private.copilot_action_ledger
      DROP CONSTRAINT IF EXISTS copilot_action_ledger_org_required;
    ALTER TABLE app_private.copilot_action_ledger
      ADD CONSTRAINT copilot_action_ledger_org_required
      CHECK (organization_id IS NOT NULL
             OR event = ANY (ARRAY[
               'policy_changed','step_up_pin_set','step_up_unlocked','step_up_locked',
               'step_up_pin_reset']));
  END IF;
END
$mo_rong_ledger_event$;

-- ---------------------------------------------------------------------------
-- MUC 1 - RPC copilot_step_up_reset_pin_v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_step_up_reset_pin_v1(p_user_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'
AS $function$
DECLARE
  v_actor      uuid := auth.uid();
  v_da_xoa_pin boolean;
  v_so_token   int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'step_up_superadmin_only' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_required' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023';
  END IF;

  -- XOÁ HẲN hàng PIN (khác `unlock_v1`, chỉ mở khoá đếm/lock). Không có hàng
  -- thì `copilot_step_up_set_pin_v1` của chính người đó đi thẳng nhánh TẠO
  -- MỚI — không đòi `p_current_pin` (PIN cũ đã mất, không thể khớp gì cả).
  DELETE FROM app_private.copilot_step_up_pins WHERE user_id = p_user_id;
  v_da_xoa_pin := FOUND;

  -- Dọn token step-up CHƯA TIÊU của người đó — bằng chứng "đã xác thực bằng
  -- PIN cũ" không nên sống sót qua một lần reset quản trị.
  DELETE FROM app_private.copilot_write_confirmations
   WHERE user_id = p_user_id AND tool = 'step_up' AND consumed_at IS NULL;
  GET DIAGNOSTICS v_so_token = ROW_COUNT;

  -- Sổ KHÔNG mang PIN/token — chỉ mang việc "đã bị super admin reset", giống
  -- khuôn của step_up_verified/step_up_pin_set.
  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',          'step_up_pin_reset',
    'permission_key', 'copilot.step_up',
    'outcome',        jsonb_build_object(
      'target_user_id', p_user_id,
      'reason',         p_reason,
      'pin_da_xoa',     v_da_xoa_pin,
      'token_da_xoa',   v_so_token
    )));

  RETURN jsonb_build_object('ok', true, 'da_reset', v_da_xoa_pin);
END
$function$;

COMMENT ON FUNCTION public.copilot_step_up_reset_pin_v1(uuid, text) IS
  'Super admin XOÁ hẳn PIN step-up của một người dùng (khác unlock — chỉ mở khoá đếm/lock) khi PIN đã mất, để họ tự đặt PIN mới không cần PIN cũ. Dọn token step-up chưa tiêu. Gọi CHỈ từ src/copilot/plan/stepUpClient.ts (rpcAllowlist).';

REVOKE ALL ON FUNCTION public.copilot_step_up_reset_pin_v1(uuid, text)
  FROM PUBLIC;
DO $quyen_reset_pin$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_step_up_reset_pin_v1(uuid, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_step_up_reset_pin_v1(uuid, text) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_step_up_reset_pin_v1(uuid, text) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_step_up_reset_pin_v1(uuid, text) TO authenticated;
  END IF;
END
$quyen_reset_pin$;

-- ---------------------------------------------------------------------------
-- NGHIEM THU
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ho text[] := '{}'::text[];
BEGIN
  IF to_regprocedure('public.copilot_step_up_reset_pin_v1(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'thieu ham copilot_step_up_reset_pin_v1';
  END IF;
  IF to_regprocedure('app_private.copilot_ledger_append_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'copilot_ledger_append_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('app_private.copilot_step_up_ghi_that_bai_v1(uuid, uuid)') IS NULL THEN
    -- Khong goi truc tiep tu ham nay, nhung xac nhan khuon step_up da co san
    -- (helper dung chung voi set_pin_v1/verify_v1) truoc khi ket luan migration
    -- nay dat dung ngu canh.
    RAISE EXCEPTION 'copilot_step_up_ghi_that_bai_v1 missing — baseline step-up phai co truoc';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'app_private.copilot_action_ledger'::regclass
       AND conname = 'copilot_action_ledger_event_check'
       AND pg_get_constraintdef(oid) LIKE '%step_up_pin_reset%'
  ) THEN
    RAISE EXCEPTION 'enum copilot_action_ledger.event chua co step_up_pin_reset';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'app_private.copilot_action_ledger'::regclass
       AND conname = 'copilot_action_ledger_org_required'
       AND pg_get_constraintdef(oid) LIKE '%step_up_pin_reset%'
  ) THEN
    RAISE EXCEPTION 'copilot_action_ledger_org_required chua mien to chuc cho step_up_pin_reset';
  END IF;

  IF to_regrole('anon') IS NOT NULL
     AND has_function_privilege('anon', 'public.copilot_step_up_reset_pin_v1(uuid, text)'::regprocedure, 'EXECUTE') THEN
    v_ho := v_ho || 'public.copilot_step_up_reset_pin_v1(uuid, text)';
  END IF;
  IF cardinality(v_ho) > 0 THEN
    RAISE EXCEPTION 'anon goi duoc copilot_step_up_reset_pin_v1: %', array_to_string(v_ho, ', ');
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
