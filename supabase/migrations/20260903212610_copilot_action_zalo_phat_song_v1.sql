-- G5-C2 (5/7, nhom B - hieu ung ngoai) - Action L5 `zalo.broadcast` theo khuon
-- direct_l5_v1 (xem 20260903190255 cho khuon day du), CONG voi co che moi
-- UNKNOWN_EFFECT + doi soat that.
--
-- BOC RPC GOC: `zalo_broadcast(p_conversation_ids uuid[], p_body text)`
-- (SECURITY DEFINER, doc production 03/09/2026 - nhan MOT MANG hoi thoai,
-- tu bo qua (CONTINUE) hoi thoai khong ton tai/khong co quyen, tra ve INTEGER
-- dem so hoi thoai da xep hang gui - KHONG tra id tin nhan nao ca).
--
-- LECH BRIEF CO CHU DICH - thu hep con MOT hoi thoai moi buoc. RPC goc nhan
-- CA MANG (co the nhieu to chuc neu actor co quyen o nhieu noi, va tra ve chi
-- mot con dem - khong the lap lai duoc "id nao thanh cong"). Wrapper CHI nhan
-- DUNG MOT conversation_id, xac nhan no thuoc DUNG to chuc gan voi ke hoach,
-- roi tim CHINH XAC tin nhan RPC goc vua tao (khong doan "moi nhat") de co
-- MOT entity_id xac dinh cho doi soat. Day la mot dieu kien THEM, CHAT HON
-- RPC goc, khong noi rong.
--
-- F1 (review G5-C2 fix round 1) - RACE O DUONG DOC LAI. Ban dau doc "hang
-- zalo_send_queue MOI NHAT cua hoi thoai" - mot lan gui SONG SONG khac (nguoi
-- khac, hoac chinh actor gui tin thu hai) vao CUNG hoi thoai giua luc RPC goc
-- INSERT va luc wrapper SELECT co the chen mot hang MOI HON, lam entity_id
-- (va do do ca doi soat sau nay) tro SAI sang tin cua nguoi khac. Sua bang
-- LIEN KET THAT: chup `v_moc := clock_timestamp()` truoc khi goi RPC goc, tim
-- hang `zalo_messages` co `sent_by = actor` (cot DUY NHAT phan anh dung actor
-- - `zalo_send_queue.user_id` la CHU SO HUU HOI THOAI, khong phai actor, da
-- doi chieu than RPC goc) + `body` khop + `sent_at >= v_moc`, roi lay hang
-- `zalo_send_queue` LIEN KET qua `message_id` (zalo_broadcast tu dat cot do).
-- Khong tim thay -> RAISE `external_effect_entity_not_found` TRUOC bat ky ghi
-- audit/ledger nao (coi la that bai, khong doan 'da_gui' gia).
--
-- VI SAO external_effect/UNKNOWN_EFFECT - `zalo_broadcast` chi XEP HANG tin
-- vao `zalo_send_queue` (worker ngoai tien trinh DB moi la nguoi thuc gui qua
-- Zalo). Bien writer/wrapper coi day la DONE ngay khi INSERT xong la SAI - tin
-- co the FAILED sau do. Buoc dung o UNKNOWN_EFFECT cho toi khi
-- `copilot_plan_reconcile_step_v1` doc lai trang thai THAT cua hang
-- `zalo_send_queue` (queued/processing -> con cho; sent -> DONE; failed ->
-- FAILED).
--
-- MUC 0 - MO RONG ENUM SO HANH DONG them 'step_reconciled' VA
-- 'step_unknown_effect' (F4, review G5-C2 fix round 1 - buoc UNKNOWN_EFFECT
-- ghi so bang su kien RIENG, khong dung chung 'step_done' voi buoc DONE
-- that). Idempotent: chi DROP+ADD lai CHECK khi chua co gia tri moi. Cong voi dam bao cot
-- pin_always da co (nhom A them, nhung file nay co the duoc kiem doc lap
-- tren production chua co 20260903212600 - registry INSERT o duoi can cot
-- do ton tai).
BEGIN;
SET LOCAL lock_timeout = '15s';

DO $them_cot_pin_always$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app_private' AND table_name = 'copilot_action_registry'
       AND column_name = 'pin_always'
  ) THEN
    ALTER TABLE app_private.copilot_action_registry
      ADD COLUMN pin_always boolean NOT NULL DEFAULT false;
  END IF;
END
$them_cot_pin_always$;

DO $mo_rong_ledger_event$
BEGIN
  -- F4 (review G5-C2 fix round 1): them ca 'step_unknown_effect' vao CUNG
  -- dieu kien voi 'step_reconciled' - hai gia tri nay luon di doi (mang moi
  -- CHOT DUY NHAT ca hai, xem chu thich duoi mang), nen chi can kiem SU CO
  -- MAT cua mot trong hai la du de biet ca hai da co hay chua.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'app_private.copilot_action_ledger'::regclass
       AND conname = 'copilot_action_ledger_event_check'
       AND pg_get_constraintdef(oid) LIKE '%step_reconciled%'
       AND pg_get_constraintdef(oid) LIKE '%step_unknown_effect%'
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
        'grant_used','step_reconciled','step_unknown_effect']));
  END IF;
END
$mo_rong_ledger_event$;

-- ---------------------------------------------------------------------------
-- MUC 0b - VA DONG CO KE HOACH. Than chep NGUYEN VEN tu production (doc qua
-- Management API ngay truoc khi viet file - da xac nhan la THAN SONG, khop
-- byte-for-byte voi 20260903190255 tren production 03/09/2026), CHI hai cho
-- doi trong doan "DUOI" (thanh cong): (a) v_buoc_status tinh TRUOC UPDATE dua
-- theo verify_kind='external_effect'; (b) v_plan_status ep 'APPROVED' khi
-- buoc la UNKNOWN_EFFECT, bat ke con buoc PENDING nao khac. KHONG dong nao
-- khac trong ham bi sua - dung tinh than "patch ONLY" cua task nay.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_plan_execute_step_v1(p_plan_id uuid, p_step_no integer, p_expected_plan_version integer, p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'
AS $function$
DECLARE
  v_actor       uuid := auth.uid();
  v_plan        app_private.copilot_plans%ROWTYPE;
  v_step        app_private.copilot_plan_steps%ROWTYPE;
  v_reg         app_private.copilot_action_registry%ROWTYPE;
  v_snapshot    jsonb := '{}'::jsonb;
  v_max_direct  text;
  v_policy_rev  bigint;
  v_next        int;
  v_version     int;
  v_kq          jsonb;
  v_ket         jsonb;
  v_canon_moi   jsonb;
  v_nonce       text;
  v_bang        text;
  v_entity_id   uuid;
  v_audit_id    uuid;
  v_trang_thai  text;
  v_after       jsonb;
  v_after_hex   text;
  v_voucher     uuid;
  v_idem        boolean := false;
  v_loi         text := NULL;
  v_chi_tiet    text := NULL;
  v_sqlstate    text := NULL;
  v_su_kien     text := NULL;
  v_ledger_id   uuid;
  v_plan_status text;
  v_buoc_status text;
  v_chan        int[];
  v_j           int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL OR p_step_no IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id AND p.user_id = v_actor
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_organization_id IS NULL OR v_plan.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  IF v_plan.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'plan_not_approved: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;

  IF COALESCE(v_plan.execute_deadline, v_plan.expires_at) <= clock_timestamp() THEN
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
      'step_no',         p_step_no,
      'plan_version',    v_version,
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_plan.consent_confirmation_id,
      'consent_kind',    v_plan.consent_kind,
      'step_up_id',      v_plan.step_up_confirmation_id,
      'error_code',      'plan_expired',
      'outcome',         jsonb_build_object('giai_doan', 'execute')));
    RETURN jsonb_build_object(
      'ok',           false,
      'error_code',   'plan_expired',
      'plan_id',      v_plan.id,
      'plan_version', v_version,
      'plan_status',  'EXPIRED',
      'step', jsonb_build_object(
        'step_no', p_step_no, 'status', 'BLOCKED', 'outcome', NULL,
        'error_code', 'plan_expired'),
      'next_step_no', NULL);
  END IF;

  IF p_expected_plan_version IS NULL OR v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale: dang o %, nguoi goi mong %',
      v_plan.version, p_expected_plan_version
      USING ERRCODE = '40001';
  END IF;

  SELECT min(step_no) INTO v_next
    FROM app_private.copilot_plan_steps
   WHERE plan_id = v_plan.id AND status = 'PENDING';
  IF v_next IS NULL THEN
    RAISE EXCEPTION 'plan_no_pending_step' USING ERRCODE = '22023';
  END IF;
  IF p_step_no IS DISTINCT FROM v_next THEN
    RAISE EXCEPTION 'step_order: buoc ke tiep la %', v_next USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND step_no < p_step_no AND status <> 'DONE'
  ) THEN
    RAISE EXCEPTION 'step_order: con buoc truoc chua xong' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_step
    FROM app_private.copilot_plan_steps
   WHERE plan_id = v_plan.id AND step_no = p_step_no
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'step_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    IF NOT app_private.copilot_action_flag_allows_v1(
             'copilot.execution_plan', v_plan.organization_id) THEN
      RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
    END IF;

    IF v_plan.consent_kind = 'standing_grant' THEN
      IF EXISTS (
        SELECT 1
          FROM unnest(v_plan.standing_grant_ids) AS gid
         WHERE NOT EXISTS (
           SELECT 1 FROM app_private.copilot_standing_grants g
            WHERE g.id = gid
              AND g.revoked_at IS NULL
              AND g.expires_at > clock_timestamp()
         )
      ) THEN
        RAISE EXCEPTION 'grant_revoked' USING ERRCODE = '42501';
      END IF;
    END IF;

    SELECT * INTO v_reg
      FROM app_private.copilot_action_registry
     WHERE action_id = v_step.action_id;
    IF NOT FOUND OR NOT v_reg.enabled OR v_reg.version <> v_step.action_version THEN
      RAISE EXCEPTION 'registry_changed' USING ERRCODE = '42501';
    END IF;

    SELECT max_direct_risk, revision INTO v_max_direct, v_policy_rev
      FROM app_private.copilot_action_policy WHERE id;
    IF v_max_direct IS NULL OR v_policy_rev IS NULL THEN
      RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
    END IF;
    IF v_policy_rev IS DISTINCT FROM v_plan.policy_revision
       OR NOT app_private.copilot_plan_role_allowed_v1(v_plan.organization_id)
       OR (v_reg.executor_kind <> 'maker_submit_v1'
           AND (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
             > (CASE v_max_direct WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)) THEN
      RAISE EXCEPTION 'policy_changed' USING ERRCODE = '42501';
    END IF;

    v_snapshot := app_private.copilot_action_gate_v1(v_step.action_id, v_plan.organization_id);

    IF v_step.canonical IS NULL
       OR v_step.payload_digest IS NULL
       OR app_private.copilot_payload_hash_v1(v_step.canonical)
            IS DISTINCT FROM v_step.payload_digest THEN
      RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
    END IF;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_chi_tiet = MESSAGE_TEXT;
    v_loi := split_part(v_chi_tiet, ':', 1);
    v_su_kien := 'step_blocked';
  END;

  IF v_loi IS NULL THEN
    BEGIN
      IF v_reg.executor_kind = 'nonce_abi_v1' THEN
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.preview_rpc)
           INTO v_kq
          USING v_plan.organization_id, v_step.payload;
        v_canon_moi := v_kq -> 'canonical';
        v_nonce := v_kq ->> 'confirmation_nonce';
        IF jsonb_typeof(COALESCE(v_canon_moi, 'null'::jsonb)) <> 'object'
           OR app_private.copilot_payload_hash_v1(v_canon_moi)
                IS DISTINCT FROM v_step.payload_digest THEN
          RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
        END IF;

        EXECUTE format('SELECT public.%I($1, $2)', v_reg.execute_rpc)
           INTO v_ket
          USING v_nonce, v_canon_moi;

      ELSIF v_reg.executor_kind = 'direct_l5_v1' THEN
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.preview_rpc)
           INTO v_kq
          USING v_plan.organization_id, v_step.payload;
        v_canon_moi := v_kq -> 'canonical';
        v_nonce := v_kq ->> 'confirmation_nonce';
        IF jsonb_typeof(COALESCE(v_canon_moi, 'null'::jsonb)) <> 'object'
           OR app_private.copilot_payload_hash_v1(v_canon_moi)
                IS DISTINCT FROM v_step.payload_digest THEN
          RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
        END IF;

        PERFORM set_config('app.copilot_plan_context',
                            v_plan.id::text || ':' || p_step_no::text, true);
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.execute_rpc)
           INTO v_ket
          USING v_nonce, v_canon_moi;
        PERFORM set_config('app.copilot_plan_context', '', true);

      ELSIF v_reg.executor_kind = 'maker_submit_v1' THEN
        IF v_step.ref_step IS NOT NULL THEN
          SELECT NULLIF(s.outcome ->> 'entity_id', '')::uuid INTO v_voucher
            FROM app_private.copilot_plan_steps s
           WHERE s.plan_id = v_plan.id
             AND s.step_no = v_step.ref_step
             AND s.status = 'DONE';
          IF v_voucher IS NULL THEN
            RAISE EXCEPTION 'ref_step_unresolved' USING ERRCODE = '22023';
          END IF;
        ELSE
          v_voucher := NULLIF(v_step.canonical ->> 'voucher_id', '')::uuid;
          IF v_voucher IS NULL THEN
            RAISE EXCEPTION 'step_voucher_invalid' USING ERRCODE = '22023';
          END IF;
        END IF;
        v_ket := app_private.copilot_plan_submit_voucher_v1(
                   v_plan.organization_id, v_voucher, v_plan.id, v_step.step_no);

      ELSE
        RAISE EXCEPTION 'executor_not_supported' USING ERRCODE = '0A000';
      END IF;

      v_trang_thai := COALESCE(v_ket ->> 'status', 'da_thuc_hien');
      v_bang := COALESCE(NULLIF(v_ket ->> 'entity_table', ''), v_reg.produces_entity_table);
      v_entity_id := NULLIF(v_ket ->> 'entity_id', '')::uuid;
      v_audit_id := NULLIF(v_ket ->> 'audit_id', '')::uuid;
      v_idem := v_trang_thai IN ('da_thuc_hien_truoc_do', 'da_tao_truoc_do')
                OR COALESCE((v_ket ->> 'idempotent')::boolean, false);

      IF v_entity_id IS NULL OR v_bang IS NULL OR v_bang !~ '^[a-z_][a-z0-9_]*$' THEN
        RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
      END IF;
      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', v_bang)
         INTO v_after
        USING v_entity_id;
      IF v_after IS NULL
         OR NULLIF(v_after ->> 'organization_id', '')::uuid
              IS DISTINCT FROM v_plan.organization_id THEN
        RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
      END IF;

      CASE v_reg.verify_kind
        WHEN 'ie_draft' THEN
          IF v_after ->> 'approval_status' IS DISTINCT FROM 'UNAPPROVED'
             OR v_after ->> 'posting_status' IS DISTINCT FROM 'UNPOSTED'
             OR NULLIF(v_after ->> 'user_id', '')::uuid IS DISTINCT FROM v_actor THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        WHEN 'approval_request_pending' THEN
          IF v_after ->> 'state' IS DISTINCT FROM 'PENDING_APPROVAL'
             OR NULLIF(v_after ->> 'maker_user_id', '')::uuid IS DISTINCT FROM v_actor THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        WHEN 'hold_pending_approval' THEN
          IF v_after ->> 'status' IS DISTINCT FROM 'PENDING_APPROVAL' THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        ELSE
          -- 'readback' VA 'external_effect' deu roi vao day: readback la
          -- "ton tai + dung to chuc" da la toan bo loi hua; external_effect
          -- khong co bat bien nao them o day - trang thai THAT cua no chi
          -- duoc doi soat sau, boi copilot_plan_reconcile_step_v1.
          NULL;
      END CASE;
    EXCEPTION WHEN others THEN
      PERFORM set_config('app.copilot_plan_context', '', true);
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_chi_tiet = MESSAGE_TEXT;
      v_loi := split_part(v_chi_tiet, ':', 1);
      v_su_kien := 'step_failed';
    END;
  END IF;

  IF v_loi IS NULL THEN
    v_after_hex := encode(
      extensions.digest(convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex');

    -- G5-C2: verify_kind='external_effect' -> buoc dung o UNKNOWN_EFFECT,
    -- KHONG DONE, cho toi khi copilot_plan_reconcile_step_v1 doi soat that.
    v_buoc_status := CASE WHEN v_reg.verify_kind = 'external_effect'
                          THEN 'UNKNOWN_EFFECT' ELSE 'DONE' END;

    UPDATE app_private.copilot_plan_steps
       SET status = v_buoc_status,
           outcome = jsonb_build_object(
             'entity_table', v_bang,
             'entity_id',    v_entity_id,
             'audit_id',     v_audit_id,
             'idempotent',   v_idem,
             'status',       v_trang_thai),
           error_code = NULL,
           error_detail = NULL,
           executed_at = clock_timestamp()
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    -- F4 (review G5-C2 fix round 1): su kien RIENG cho buoc UNKNOWN_EFFECT -
    -- khong con dung chung 'step_done' (truoc day phan biet DUY NHAT qua
    -- outcome.step_status, de lan voi buoc DONE that trong bat ky truy van so
    -- nao loc theo event='step_done').
    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               CASE WHEN v_buoc_status = 'UNKNOWN_EFFECT'
                                   THEN 'step_unknown_effect' ELSE 'step_done' END,
      'organization_id',     v_plan.organization_id,
      'plan_id',             v_plan.id,
      'step_no',             p_step_no,
      'plan_version',        v_plan.version + 1,
      'action_id',           v_step.action_id,
      'permission_key',      v_step.permission_key,
      'permission_snapshot', v_snapshot,
      'consent_id',          v_plan.consent_confirmation_id,
      'consent_kind',        v_plan.consent_kind,
      'step_up_id',          v_plan.step_up_confirmation_id,
      'payload_digest',      encode(v_step.payload_digest, 'hex'),
      'after_digest',        v_after_hex,
      'entity_table',        v_bang,
      'entity_id',           v_entity_id,
      'audit_id',            v_audit_id,
      'amount',              NULLIF(v_step.canonical ->> 'amount', ''),
      'outcome', jsonb_build_object('status', v_trang_thai, 'idempotent', v_idem,
                                     'step_status', v_buoc_status)));

    UPDATE app_private.copilot_plan_steps
       SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    SELECT min(step_no) INTO v_next
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status = 'PENDING';
    -- G5-C2: mot buoc UNKNOWN_EFFECT khong bao gio dua ke hoach len DONE, bat
    -- ke con buoc PENDING nao khac hay khong - phai cho reconcile.
    v_plan_status := CASE WHEN v_buoc_status = 'UNKNOWN_EFFECT' THEN 'APPROVED'
                          WHEN v_next IS NULL THEN 'DONE' ELSE 'APPROVED' END;

    UPDATE app_private.copilot_plans
       SET status = v_plan_status, version = version + 1, updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
    END IF;

  ELSE
    v_buoc_status := CASE WHEN v_su_kien = 'step_blocked' THEN 'BLOCKED' ELSE 'FAILED' END;

    UPDATE app_private.copilot_plan_steps
       SET status = v_buoc_status,
           error_code = v_loi,
           error_detail = left(COALESCE(v_chi_tiet, ''), 1000),
           executed_at = clock_timestamp()
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    SELECT array_agg(step_no ORDER BY step_no) INTO v_chan
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status = 'PENDING' AND step_no <> p_step_no;

    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_failed'
     WHERE plan_id = v_plan.id AND status = 'PENDING' AND step_no <> p_step_no;

    v_plan_status := 'FAILED';
    UPDATE app_private.copilot_plans
       SET status = 'FAILED',
           version = version + 1,
           failure_reason = v_su_kien || ':' || p_step_no::text || ':' || COALESCE(v_loi, '?'),
           updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
    END IF;

    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               v_su_kien,
      'organization_id',     v_plan.organization_id,
      'plan_id',             v_plan.id,
      'step_no',             p_step_no,
      'plan_version',        v_version,
      'action_id',           v_step.action_id,
      'permission_key',      v_step.permission_key,
      'permission_snapshot', v_snapshot,
      'consent_id',          v_plan.consent_confirmation_id,
      'consent_kind',        v_plan.consent_kind,
      'step_up_id',          v_plan.step_up_confirmation_id,
      'payload_digest',      encode(v_step.payload_digest, 'hex'),
      'error_code',          v_loi,
      'sqlstate',            v_sqlstate,
      'outcome', jsonb_build_object('plan_status', 'FAILED')));

    UPDATE app_private.copilot_plan_steps
       SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    IF v_chan IS NOT NULL THEN
      FOREACH v_j IN ARRAY v_chan LOOP
        PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
          'event',           'step_blocked',
          'organization_id', v_plan.organization_id,
          'plan_id',         v_plan.id,
          'step_no',         v_j,
          'plan_version',    v_version,
          'action_id',       (SELECT action_id FROM app_private.copilot_plan_steps
                               WHERE plan_id = v_plan.id AND step_no = v_j),
          'permission_key',  'copilot.execution_plan',
          'consent_id',      v_plan.consent_confirmation_id,
          'consent_kind',    v_plan.consent_kind,
          'step_up_id',      v_plan.step_up_confirmation_id,
          'error_code',      'plan_failed',
          'outcome',         jsonb_build_object('nguyen_nhan_tu_buoc', p_step_no)));
      END LOOP;
    END IF;
    v_next := NULL;
  END IF;

  RETURN jsonb_build_object(
    'ok',           v_loi IS NULL,
    'error_code',   v_loi,
    'plan_id',      v_plan.id,
    'plan_version', v_version,
    'plan_status',  v_plan_status,
    'step', jsonb_build_object(
      'step_no',    p_step_no,
      'status',     v_buoc_status,
      'outcome',    CASE WHEN v_loi IS NULL THEN jsonb_build_object(
                           'entity_table', v_bang,
                           'entity_id',    v_entity_id,
                           'audit_id',     v_audit_id,
                           'idempotent',   v_idem)
                         ELSE NULL END,
      'error_code', v_loi),
    'next_step_no', v_next);
END
$function$
;

-- ---------------------------------------------------------------------------
-- MUC 0c - copilot_plan_reconcile_step_v1 - THAN THAT (truoc la RAISE
-- not_implemented). Chu so huu ke hoach hoac super admin; doi ke hoach dang
-- APPROVED, buoc dang UNKNOWN_EFFECT, registry.verify_kind='external_effect'.
-- Doc entity_table/entity_id tu chinh outcome ma copilot_plan_execute_step_v1
-- da ghi (khong tin tham so nguoi goi). Bang outbox/request khac nhau doc
-- khac nhau - CASE tren entity_table, KHONG mot cot "status" chung.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_plan_reconcile_step_v1(p_plan_id uuid, p_step_no integer, p_expected_plan_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_plan           app_private.copilot_plans%ROWTYPE;
  v_step           app_private.copilot_plan_steps%ROWTYPE;
  v_reg            app_private.copilot_action_registry%ROWTYPE;
  v_entity_table   text;
  v_entity_id      uuid;
  v_row            jsonb;
  v_ext_status     text;
  v_new_step_status text;
  v_ledger_id      uuid;
  v_version        int;
  v_plan_status    text;
  v_next           int;
  v_chan           int[];
  v_j              int;
  v_after_outcome  jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL OR p_step_no IS NULL OR p_expected_plan_version IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id
       AND (p.user_id = v_actor OR public.is_super_admin())
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_plan.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'plan_not_approved: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;
  IF v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
  END IF;

  IF NOT app_private.copilot_action_flag_allows_v1(
           'copilot.execution_plan', v_plan.organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_step
    FROM app_private.copilot_plan_steps s
   WHERE s.plan_id = v_plan.id AND s.step_no = p_step_no
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'step_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_step.status <> 'UNKNOWN_EFFECT' THEN
    RAISE EXCEPTION 'step_not_unknown_effect: dang o %', v_step.status USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_reg
    FROM app_private.copilot_action_registry
   WHERE action_id = v_step.action_id;
  IF NOT FOUND OR v_reg.verify_kind <> 'external_effect' THEN
    RAISE EXCEPTION 'registry_changed' USING ERRCODE = '42501';
  END IF;

  v_entity_table := v_step.outcome ->> 'entity_table';
  v_entity_id    := NULLIF(v_step.outcome ->> 'entity_id', '')::uuid;
  IF v_entity_table IS NULL OR v_entity_id IS NULL
     OR v_entity_table !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  IF v_entity_table = 'zalo_send_queue' THEN
    SELECT to_jsonb(t) INTO v_row FROM public.zalo_send_queue t
     WHERE t.id = v_entity_id AND t.organization_id = v_plan.organization_id;
    IF v_row IS NULL THEN
      RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
    END IF;
    v_ext_status := CASE v_row ->> 'status'
                      WHEN 'sent' THEN 'DONE'
                      WHEN 'failed' THEN 'FAILED'
                      ELSE 'PENDING'
                    END;
  ELSIF v_entity_table = 'network_commands' THEN
    SELECT to_jsonb(t) INTO v_row FROM public.network_commands t
     WHERE t.id = v_entity_id AND t.organization_id = v_plan.organization_id;
    IF v_row IS NULL THEN
      RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
    END IF;
    v_ext_status := CASE
                      WHEN v_row ->> 'status' = 'SUCCEEDED' THEN 'DONE'
                      WHEN v_row ->> 'status' IN ('FAILED', 'CANCELLED_BY_KILL_SWITCH') THEN 'FAILED'
                      ELSE 'PENDING'
                    END;
  ELSE
    RAISE EXCEPTION 'executor_not_supported: doi soat khong biet bang %', v_entity_table
      USING ERRCODE = '0A000';
  END IF;

  IF v_ext_status = 'PENDING' THEN
    -- Chua co gi doi - tra ve nguyen trang, KHONG ghi so (client co the hoi
    -- lai nhieu lan), KHONG tang version.
    RETURN jsonb_build_object(
      'ok', true, 'error_code', NULL,
      'plan_id', v_plan.id, 'plan_version', v_plan.version, 'plan_status', v_plan.status,
      'step', jsonb_build_object('step_no', p_step_no, 'status', 'UNKNOWN_EFFECT',
                                  'outcome', v_step.outcome, 'error_code', NULL),
      'next_step_no', NULL);
  END IF;

  v_new_step_status := v_ext_status;
  v_after_outcome := v_step.outcome || jsonb_build_object(
    'reconciled_status', v_new_step_status, 'reconciled_at', clock_timestamp());

  UPDATE app_private.copilot_plan_steps
     SET status = v_new_step_status,
         outcome = v_after_outcome,
         error_code = CASE WHEN v_new_step_status = 'FAILED' THEN 'external_effect_failed' ELSE NULL END,
         executed_at = COALESCE(v_step.executed_at, clock_timestamp())
   WHERE plan_id = v_plan.id AND step_no = p_step_no;

  IF v_new_step_status = 'DONE' THEN
    SELECT min(step_no) INTO v_next
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status IN ('PENDING', 'UNKNOWN_EFFECT');
    v_plan_status := CASE WHEN v_next IS NULL THEN 'DONE' ELSE 'APPROVED' END;

    UPDATE app_private.copilot_plans
       SET status = v_plan_status, version = version + 1, updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
    END IF;

    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'step_reconciled',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'step_no',         p_step_no,
      'plan_version',    v_version,
      'action_id',       v_step.action_id,
      'permission_key',  v_step.permission_key,
      'consent_id',      v_plan.consent_confirmation_id,
      'consent_kind',    v_plan.consent_kind,
      'step_up_id',      v_plan.step_up_confirmation_id,
      'outcome', jsonb_build_object('reconciled_status', 'DONE',
                                     'entity_table', v_entity_table, 'entity_id', v_entity_id)));
    UPDATE app_private.copilot_plan_steps SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

  ELSE
    SELECT array_agg(step_no ORDER BY step_no) INTO v_chan
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status IN ('PENDING','UNKNOWN_EFFECT') AND step_no <> p_step_no;

    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_failed'
     WHERE plan_id = v_plan.id AND status IN ('PENDING','UNKNOWN_EFFECT') AND step_no <> p_step_no;

    v_plan_status := 'FAILED';
    UPDATE app_private.copilot_plans
       SET status = 'FAILED', version = version + 1,
           failure_reason = 'step_reconciled_failed:' || p_step_no::text,
           updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
    END IF;

    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'step_reconciled',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'step_no',         p_step_no,
      'plan_version',    v_version,
      'action_id',       v_step.action_id,
      'permission_key',  v_step.permission_key,
      'consent_id',      v_plan.consent_confirmation_id,
      'consent_kind',    v_plan.consent_kind,
      'step_up_id',      v_plan.step_up_confirmation_id,
      'error_code',      'external_effect_failed',
      'outcome', jsonb_build_object('reconciled_status', 'FAILED',
                                     'entity_table', v_entity_table, 'entity_id', v_entity_id)));
    UPDATE app_private.copilot_plan_steps SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    IF v_chan IS NOT NULL THEN
      FOREACH v_j IN ARRAY v_chan LOOP
        PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
          'event',           'step_blocked',
          'organization_id', v_plan.organization_id,
          'plan_id',         v_plan.id,
          'step_no',         v_j,
          'plan_version',    v_version,
          'action_id',       (SELECT action_id FROM app_private.copilot_plan_steps
                               WHERE plan_id = v_plan.id AND step_no = v_j),
          'permission_key',  'copilot.execution_plan',
          'error_code',      'plan_failed',
          'outcome',         jsonb_build_object('nguyen_nhan_tu_buoc', p_step_no)));
      END LOOP;
    END IF;
    v_next := NULL;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'error_code', NULL,
    'plan_id', v_plan.id, 'plan_version', v_version, 'plan_status', v_plan_status,
    'step', jsonb_build_object(
      'step_no', p_step_no, 'status', v_new_step_status,
      'outcome', v_after_outcome,
      'error_code', CASE WHEN v_new_step_status = 'FAILED' THEN 'external_effect_failed' ELSE NULL END),
    'next_step_no', v_next);
END
$function$
;

REVOKE ALL ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid, integer, integer)
  FROM PUBLIC;
DO $quyen_reconcile$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid, integer, integer) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid, integer, integer) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid, integer, integer) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid, integer, integer) TO authenticated;
  END IF;
END
$quyen_reconcile$;

-- ---------------------------------------------------------------------------
-- MUC 1 - XEM TRUOC zalo.broadcast
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_zalo_phat_song_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_zalo_phat_song$
DECLARE
  v_actor       uuid := auth.uid();
  v_snapshot    jsonb;
  v_conv_id     uuid;
  v_body        text;
  v_conv        public.zalo_conversations%ROWTYPE;
  v_canonical   jsonb;
  v_nonce       bytea;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('zalo.broadcast', p_organization_id);

  BEGIN
    v_conv_id := (p_payload ->> 'conversation_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  v_body := NULLIF(btrim(COALESCE(p_payload ->> 'body', '')), '');
  IF v_conv_id IS NULL OR v_body IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_conv
    FROM public.zalo_conversations c
   WHERE c.id = v_conv_id AND c.organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.zalo_can('send', p_organization_id) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id',  p_organization_id,
    'conversation_id',  v_conv_id,
    'body',             v_body
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'zalo.broadcast', app_private.copilot_payload_hash_v1(v_canonical),
     'chat_zalo.send', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'ten_khach_hang',      v_conv.name,
      'trang_thai_hien_tai', 'Se xep hang gui qua zalo_send_queue',
      'hau_qua',             'Se GUI mot tin Zalo - hieu ung ngoai, doi soat sau khi thuc thi',
      'canh_bao',            'Buoc se dung o "hieu ung ngoai - dang doi soat" cho toi khi worker gui xong'
    )
  );
END
$xem_truoc_zalo_phat_song$;

COMMENT ON FUNCTION public.copilot_preview_zalo_phat_song_v1(uuid, jsonb) IS
  'direct_l5_v1/external_effect - xem truoc gui broadcast Zalo (boc zalo_broadcast). Nhom B - MOT hoi thoai moi buoc (thu hep co chu dich so voi mang cua RPC goc).';

REVOKE ALL ON FUNCTION public.copilot_preview_zalo_phat_song_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_zalo_phat_song$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_zalo_phat_song_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_zalo_phat_song_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_zalo_phat_song_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_zalo_phat_song_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_zalo_phat_song$;

-- ---------------------------------------------------------------------------
-- MUC 2 - THUC THI zalo.broadcast
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_zalo_phat_song_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_zalo_phat_song$
DECLARE
  v_actor      uuid := auth.uid();
  v_hash       bytea;
  v_row        app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot   jsonb;
  v_org        uuid;
  v_conv_id    uuid;
  v_body       text;
  v_key        text;
  v_prev       public.ai_write_audit%ROWTYPE;
  v_count      int;
  v_queue_id   uuid;
  v_after      jsonb;
  v_audit_id   uuid;
  v_ledger_id  uuid;
  v_moc        timestamptz;
  v_msg_id     uuid;
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
  IF v_row.tool IS DISTINCT FROM 'zalo.broadcast'
     OR v_row.permission_key IS DISTINCT FROM 'chat_zalo.send' THEN
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
    v_conv_id := (p_payload ->> 'conversation_id')::uuid;
    v_body    := p_payload ->> 'body';
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_conv_id IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  IF NOT app_private.copilot_l5_plan_context_ok_v1('zalo.broadcast', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('zalo.broadcast', v_org);

  -- Fail-closed: hoi thoai phai CON o dung to chuc luc thuc thi (co the doi
  -- giua luc xem truoc va luc chay, toi 30 phut).
  IF NOT EXISTS (
    SELECT 1 FROM public.zalo_conversations c
     WHERE c.id = v_conv_id AND c.organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_key := 'copilot_action:zalo.broadcast:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'zalo_send_queue',
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

  -- before_digest NULL - hanh dong nay GUI TIN MOI, khong co "truoc".
  -- F1 (review G5-C2 fix round 1): chup MOC THOI GIAN truoc khi goi RPC goc -
  -- doc lai o duoi PHAI loc theo moc nay, khong duoc doc "hang moi nhat cua
  -- hoi thoai" tran - hai buoi gui SONG SONG (nguoi khac, hoac worker khac)
  -- vao CUNG hoi thoai co the chen mot hang MOI HON giua luc RPC goc INSERT
  -- va luc SELECT doc lai, lam entity_id tro sang tin CUA NGUOI KHAC.
  v_moc := clock_timestamp();
  v_count := public.zalo_broadcast(ARRAY[v_conv_id], v_body);
  IF COALESCE(v_count, 0) < 1 THEN
    -- RPC goc am tham bo qua (khong quyen/khong ton tai) thay vi RAISE - buoc
    -- xem truoc lai da kiem ca hai o tren nen day chi con la mot khoang cach
    -- hiem (vd. quyen bi rut giua luc duyet va luc chay). Bien no thanh loi
    -- ro rang thay vi tra ve 'da_thuc_hien' cho mot tin KHONG he duoc xep hang.
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- Tim CHINH XAC tin nhan RPC goc vua tao CHO ACTOR NAY (F1, review G5-C2 fix
  -- round 1) - roi lay hang outbox LIEN KET THAT qua message_id
  -- (zalo_broadcast tu dat message_id khi INSERT zalo_send_queue - xem than
  -- RPC goc). KHONG loc zalo_send_queue.user_id = actor: da doi chieu lai
  -- than RPC goc (ca ban production lan ban 20260626000008) - cot do luon la
  -- c.user_id (CHU SO HUU HOI THOAI), khong phai actor goi ham. Loc theo cot
  -- do se tu choi SAI moi lan actor khac chu so huu hoi thoai (vd. admin thao
  -- tac thay) - mot ca that, khong phai canh hiem. `sent_by` tren zalo_messages
  -- moi la cot phan anh DUNG actor.
  SELECT id INTO v_msg_id
    FROM public.zalo_messages m
   WHERE m.conversation_id = v_conv_id
     AND m.organization_id = v_org
     AND m.sent_by = v_actor
     AND m.body = v_body
     AND m.sent_at >= v_moc
   ORDER BY m.sent_at ASC
   LIMIT 1;
  IF v_msg_id IS NULL THEN
    -- Khong tim thay tin nhan CUA CHINH giao dich nay - coi la THAT BAI ro
    -- rang (chua ghi audit/ledger nao o day), khong doan 'da_gui' gia.
    RAISE EXCEPTION 'external_effect_entity_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, to_jsonb(t) INTO v_queue_id, v_after
    FROM public.zalo_send_queue t
   WHERE t.message_id = v_msg_id
     AND t.organization_id = v_org
   ORDER BY t.created_at ASC
   LIMIT 1;
  IF v_queue_id IS NULL
     OR NULLIF(v_after ->> 'organization_id', '')::uuid IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'external_effect_entity_not_found' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'zalo.broadcast', v_key, 'zalo_send_queue',
     v_queue_id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'zalo.broadcast',
    'permission_key',      'chat_zalo.send',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       NULL,
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'zalo_send_queue',
    'entity_id',            v_queue_id,
    'audit_id',             v_audit_id,
    'outcome',              jsonb_build_object('status', 'da_gui', 'queued_count', v_count)
  ));

  RETURN jsonb_build_object(
    'status',       'da_gui',
    'entity_table', 'zalo_send_queue',
    'entity_id',    v_queue_id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_zalo_phat_song$;

COMMENT ON FUNCTION public.copilot_execute_zalo_phat_song_v1(text, jsonb) IS
  'direct_l5_v1/external_effect - tieu nonce, tu choi neu khong chay trong ke hoach, goi lai zalo_broadcast voi mang MOT phan tu, tim CHINH XAC tin nhan vua tao (sent_by=actor, khong doan moi nhat - F1 fix round 1) roi lay hang zalo_send_queue lien ket qua message_id lam entity_id. Buoc dung o UNKNOWN_EFFECT (khong DONE) - doi soat that o copilot_plan_reconcile_step_v1.';

REVOKE ALL ON FUNCTION public.copilot_execute_zalo_phat_song_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_zalo_phat_song$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_zalo_phat_song_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_zalo_phat_song_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_zalo_phat_song_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_zalo_phat_song_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_zalo_phat_song$;

-- ---------------------------------------------------------------------------
-- MUC 3 - SO DANG KY + CO
-- ---------------------------------------------------------------------------
INSERT INTO app_private.copilot_action_registry (
  action_id, version, label_vi, permission_key, risk, executor_kind,
  consent_required, preview_rpc, execute_rpc, verify_kind,
  produces_entity_table, consumes_ref_table, rollback_rpc, rollback_note,
  flag_contract_id, enabled, grantable, pin_always
)
VALUES (
  'zalo.broadcast',
  1,
  'Gửi tin Zalo',
  'chat_zalo.send',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_zalo_phat_song_v1',
  'copilot_execute_zalo_phat_song_v1',
  'external_effect',
  'zalo_send_queue',
  NULL,
  NULL,
  'Khong co RPC thu hoi mot tin da gui qua Zalo (khac thu hoi trong DB cua chinh app). Muon "sua" chi con cach gui THEM mot tin dinh chinh - ghi ro trong hoi thoai.',
  'zalo.broadcast',
  true,
  false,
  false
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'zalo.broadcast', 'disabled',
  'seed kill switch cho action L5 gui tin Zalo (G5-C2 nhom B) - policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903212610_copilot_action_zalo_phat_song_v1',
  'migration:20260903212610_copilot_action_zalo_phat_song_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', '', true);

-- ---------------------------------------------------------------------------
-- NGHIEM THU
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ten   text;
  v_thieu text[] := '{}'::text[];
  v_ho    text[] := '{}'::text[];
  v_than  text;
BEGIN
  FOREACH v_ten IN ARRAY ARRAY[
    'public.copilot_preview_zalo_phat_song_v1(uuid, jsonb)',
    'public.copilot_execute_zalo_phat_song_v1(text, jsonb)',
    'public.copilot_plan_reconcile_step_v1(uuid, integer, integer)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C2 zalo_phat_song: %', array_to_string(v_thieu, ', ');
  END IF;

  IF to_regprocedure('app_private.copilot_l5_plan_context_ok_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_l5_plan_context_ok_v1 missing - 20260903190255 phai chay truoc';
  END IF;
  IF to_regprocedure('public.zalo_broadcast(uuid[], text)') IS NULL THEN
    RAISE EXCEPTION 'zalo_broadcast missing - baseline phai co truoc';
  END IF;

  SELECT pg_get_functiondef('public.copilot_plan_execute_step_v1(uuid, integer, integer, uuid)'::regprocedure)
    INTO v_than;
  IF v_than !~ 'external_effect' OR v_than !~ 'UNKNOWN_EFFECT' THEN
    RAISE EXCEPTION 'copilot_plan_execute_step_v1 chua co nhanh external_effect/UNKNOWN_EFFECT';
  END IF;

  SELECT pg_get_functiondef('public.copilot_plan_reconcile_step_v1(uuid, integer, integer)'::regprocedure)
    INTO v_than;
  IF v_than ~ 'not_implemented' THEN
    RAISE EXCEPTION 'copilot_plan_reconcile_step_v1 van con la stub not_implemented';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'app_private.copilot_action_ledger'::regclass
       AND conname = 'copilot_action_ledger_event_check'
       AND pg_get_constraintdef(oid) LIKE '%step_reconciled%'
       AND pg_get_constraintdef(oid) LIKE '%step_unknown_effect%'
  ) THEN
    RAISE EXCEPTION 'enum copilot_action_ledger.event chua co step_reconciled/step_unknown_effect';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_zalo_phat_song_v1(uuid, jsonb)',
      'public.copilot_execute_zalo_phat_song_v1(text, jsonb)',
      'public.copilot_plan_reconcile_step_v1(uuid, integer, integer)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C2 zalo_phat_song: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'zalo.broadcast'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'chat_zalo.send'
       AND verify_kind = 'external_effect'
       AND grantable = false
  ) THEN
    RAISE EXCEPTION 'seed registry zalo.broadcast sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'zalo.broadcast'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: zalo.broadcast';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
