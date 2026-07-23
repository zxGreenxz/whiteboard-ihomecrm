-- Finance V2 — Hotfix 7i: reserve idempotency đúng contract baseline (F1 verification).
--
-- canonical_write_operations có CHECK: (completed_at IS NULL)=(response_payload IS NULL)
-- AND (completed_at IS NULL)=(subject_id IS NULL) — tức ROW ĐANG RESERVE phải có
-- subject_id NULL; subject chỉ stamp lúc HOÀN TẤT. Helper Stage-5
-- finance_v2_begin_canonical_op ghi subject_id ngay lúc reserve ⇒ 23514 làm MỌI
-- lifecycle RPC V2 (approve/post/…) fail. finish_canonical_op đã COALESCE subject lúc
-- complete nên chỉ cần bỏ subject khỏi INSERT reserve.

BEGIN;

CREATE OR REPLACE FUNCTION app_private.finance_v2_begin_canonical_op(
  p_org uuid, p_operation text, p_subject_scope text, p_actor uuid,
  p_actor_membership uuid, p_idempotency_key text, p_payload_hash text,
  p_subject_id uuid
)
RETURNS app_private.canonical_write_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $begin_op$
DECLARE
  v_op app_private.canonical_write_operations;
BEGIN
  -- Reserve row: subject_id CỐ Ý NULL (baseline completion contract);
  -- p_subject_id giữ trong signature để tương thích caller, stamp lúc finish.
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key,
    payload_hash, subject_id, actor_membership_id, transaction_id
  ) VALUES (
    p_org, p_operation, p_subject_scope, p_actor, p_idempotency_key,
    p_payload_hash, NULL, p_actor_membership, pg_current_xact_id()
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
  DO NOTHING;

  SELECT * INTO v_op
  FROM app_private.canonical_write_operations o
  WHERE o.organization_id = p_org
    AND o.operation = p_operation
    AND o.subject_scope = p_subject_scope
    AND o.actor_id = p_actor
    AND o.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance_v2_begin_canonical_op: failed to reserve operation %', p_operation
      USING ERRCODE = 'P0002';
  END IF;

  IF v_op.payload_hash IS DISTINCT FROM p_payload_hash THEN
    RAISE EXCEPTION 'finance_v2_begin_canonical_op: idempotency key % reused with a different payload for %',
      p_idempotency_key, p_operation
      USING ERRCODE = '23505';
  END IF;

  RETURN v_op;
END
$begin_op$;

-- DEEP SMOKE: reserve → finish → replay-read → cleanup, ngay trong transaction apply.
DO $smoke$
DECLARE
  v_actor uuid := (SELECT user_id FROM public.organization_memberships WHERE id = '8813ab26-7c03-481c-a9ad-8a083eceb5d3');
  v_subject uuid := gen_random_uuid();
  v_op app_private.canonical_write_operations;
BEGIN
  -- Key cố định: re-apply replay row cũ (ledger append-only, không cleanup được).
  v_op := app_private.finance_v2_begin_canonical_op(
    'dddd0000-0000-4000-8000-000000000001', 'smoke.canonical_op.v2', 'smoke-scope',
    v_actor, NULL, 'smoke-reserve-fix-v1', md5('payload'), v_subject);
  IF v_op.completed_at IS NULL THEN
    IF v_op.subject_id IS NOT NULL THEN
      RAISE EXCEPTION 'smoke: reserve phải có subject_id NULL';
    END IF;
    PERFORM app_private.finance_v2_finish_canonical_op(
      'dddd0000-0000-4000-8000-000000000001', 'smoke.canonical_op.v2', 'smoke-scope',
      v_actor, 'smoke-reserve-fix-v1', v_subject, jsonb_build_object('ok', true), 'SMOKE', 1,1,1);
    SELECT * INTO v_op FROM app_private.canonical_write_operations
    WHERE organization_id='dddd0000-0000-4000-8000-000000000001'
      AND operation='smoke.canonical_op.v2' AND idempotency_key='smoke-reserve-fix-v1';
    IF v_op.completed_at IS NULL OR v_op.subject_id IS NULL THEN
      RAISE EXCEPTION 'smoke: finish không stamp đúng subject/completed';
    END IF;
  END IF;
  RAISE NOTICE 'canonical-op smoke OK (completed_at=%)', v_op.completed_at;
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
