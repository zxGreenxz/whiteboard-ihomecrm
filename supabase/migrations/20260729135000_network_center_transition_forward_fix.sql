-- =============================================================================
-- Network Center additive forward-fix: keep legacy completion denied externally
-- while restoring the private completion sink used by authenticated v2 workers.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729135000::bigint);

CREATE OR REPLACE FUNCTION app_private.network_center_complete_command_internal_v2(
  p_worker_id text,
  p_command_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_result jsonb,
  p_rollback jsonb DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_command public.network_commands%ROWTYPE;
  v_outcome text := upper(btrim(coalesce(p_outcome, '')));
  v_result jsonb := coalesce(p_result, '{}'::jsonb);
  v_rollback jsonb := p_rollback;
  v_attempt_id uuid;
  v_status text;
  v_event text;
  v_attempt_outcome text;
  v_reconciliation text;
  v_seq bigint;
  v_response jsonb;
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_command_id IS NULL
     OR p_lease_token IS NULL
     OR v_outcome NOT IN (
       'SUCCEEDED', 'RETRYABLE_FAILURE', 'FAILED', 'UNCERTAIN',
       'CANCELLED_BY_KILL_SWITCH'
     )
     OR jsonb_typeof(v_result) <> 'object'
     OR octet_length(v_result::text) > 65536
     OR (
       v_rollback IS NOT NULL
       AND (
         jsonb_typeof(v_rollback) <> 'object'
         OR octet_length(v_rollback::text) > 65536
       )
     )
     OR p_retry_delay_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'Invalid command completion' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_assert_safe_json_v1(
    v_result, 'command result'
  );
  PERFORM app_private.network_center_assert_safe_json_v1(
    v_rollback, 'command rollback'
  );

  SELECT command.*
  INTO v_command
  FROM public.network_commands command
  WHERE command.id = p_command_id
    AND command.lease_token = p_lease_token
    AND command.lease_owner = p_worker_id
    AND command.status IN ('LEASED', 'RUNNING', 'RECONCILING')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active command lease not found' USING ERRCODE = '55000';
  END IF;

  v_status := CASE
    WHEN v_command.status = 'RECONCILING'
      AND v_outcome = 'RETRYABLE_FAILURE' THEN 'UNCERTAIN'
    ELSE CASE v_outcome
      WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
      WHEN 'RETRYABLE_FAILURE' THEN CASE
        WHEN v_command.attempt_count < v_command.max_attempts
          THEN 'RETRY_WAIT'
        ELSE 'FAILED'
      END
      WHEN 'FAILED' THEN 'FAILED'
      WHEN 'UNCERTAIN' THEN 'UNCERTAIN'
      ELSE 'CANCELLED_BY_KILL_SWITCH'
    END
  END;
  v_event := CASE
    WHEN v_status = 'RETRY_WAIT' THEN 'RETRY_SCHEDULED'
    WHEN v_status = 'CANCELLED_BY_KILL_SWITCH' THEN 'CANCELLED_BY_KILL_SWITCH'
    WHEN v_status = 'UNCERTAIN' THEN 'UNCERTAIN'
    WHEN v_status = 'SUCCEEDED' THEN 'SUCCEEDED'
    ELSE 'FAILED'
  END;
  v_attempt_outcome := CASE
    WHEN v_status = 'SUCCEEDED' THEN 'SUCCEEDED'
    WHEN v_status = 'RETRY_WAIT' THEN 'RETRYABLE_FAILURE'
    WHEN v_status = 'UNCERTAIN' THEN 'UNCERTAIN'
    WHEN v_status = 'CANCELLED_BY_KILL_SWITCH' THEN 'ABANDONED'
    ELSE 'PERMANENT_FAILURE'
  END;
  v_reconciliation := CASE
    WHEN v_status = 'UNCERTAIN' THEN 'REQUIRED'
    WHEN v_command.status = 'RECONCILING' AND v_status = 'SUCCEEDED'
      THEN 'CONFIRMED'
    WHEN v_command.status = 'RECONCILING' AND v_status = 'FAILED'
      THEN 'FAILED'
    ELSE v_command.reconciliation_state
  END;

  SELECT attempt.id
  INTO v_attempt_id
  FROM public.network_command_attempts attempt
  WHERE attempt.command_id = p_command_id
    AND attempt.lease_token = p_lease_token
  ORDER BY attempt.attempt_no DESC
  LIMIT 1;
  IF v_attempt_id IS NOT NULL THEN
    UPDATE public.network_command_attempts
    SET outcome = v_attempt_outcome,
        retryable = (v_status = 'RETRY_WAIT'),
        result = v_result,
        error_code = CASE
          WHEN v_status IN ('SUCCEEDED', 'RETRY_WAIT') THEN NULL
          ELSE v_result->>'code'
        END,
        error_message = CASE
          WHEN v_status = 'SUCCEEDED' THEN NULL
          ELSE left(v_result->>'message', 2000)
        END,
        finished_at = v_now
    WHERE id = v_attempt_id;
  END IF;

  SELECT coalesce(max(event.event_seq) + 1, 1)
  INTO v_seq
  FROM public.network_command_events event
  WHERE event.command_id = p_command_id;
  INSERT INTO public.network_command_events (
    organization_id,
    building_id,
    command_id,
    attempt_id,
    event_seq,
    event_kind,
    occurred_at,
    worker_id,
    payload
  ) VALUES (
    v_command.organization_id,
    v_command.building_id,
    p_command_id,
    v_attempt_id,
    v_seq,
    v_event,
    v_now,
    p_worker_id,
    jsonb_build_object('outcome', v_outcome, 'result', v_result)
  );

  DELETE FROM public.network_device_leases lease
  WHERE lease.command_id = p_command_id
    AND lease.lease_token = p_lease_token
    AND lease.lease_owner = p_worker_id;
  UPDATE public.network_commands command
  SET status = v_status,
      available_at = CASE
        WHEN v_status = 'RETRY_WAIT'
          THEN v_now + make_interval(secs => p_retry_delay_seconds)
        ELSE command.available_at
      END,
      lease_token = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      result = v_result,
      rollback = v_rollback,
      reconciliation_state = v_reconciliation,
      finished_at = CASE
        WHEN v_status IN ('SUCCEEDED', 'FAILED', 'CANCELLED_BY_KILL_SWITCH')
          THEN v_now
        ELSE NULL
      END,
      updated_at = v_now
  WHERE command.id = p_command_id;

  v_response := jsonb_build_object(
    'commandId', p_command_id,
    'status', v_status,
    'result', v_result,
    'rollback', v_rollback,
    'reconciliationState', v_reconciliation
  );
  INSERT INTO public.network_audit_events (
    organization_id,
    building_id,
    actor_type,
    worker_id,
    action,
    target_type,
    target_id,
    target_display,
    reason,
    validation,
    result,
    outcome,
    command_id
  ) VALUES (
    v_command.organization_id,
    v_command.building_id,
    'WORKER',
    p_worker_id,
    lower(v_command.action_type),
    'device',
    v_command.device_id,
    v_command.target_display,
    v_command.reason,
    jsonb_build_object('attemptCount', v_command.attempt_count),
    v_response,
    CASE v_status
      WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
      WHEN 'UNCERTAIN' THEN 'UNCERTAIN'
      ELSE 'FAILED'
    END,
    p_command_id
  );
  INSERT INTO public.network_outbox_events (
    organization_id,
    building_id,
    event_type,
    aggregate_type,
    aggregate_id,
    payload,
    occurred_at
  ) VALUES (
    v_command.organization_id,
    v_command.building_id,
    'network.command.completed',
    'command',
    p_command_id,
    jsonb_build_object('status', v_status),
    v_now
  );
  RETURN v_response;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_complete_v1(
  p_worker_id text,
  p_command_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_result jsonb,
  p_rollback jsonb DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF current_setting('app.network_center_transition_authority', true)
       IS DISTINCT FROM p_command_id::text THEN
    RAISE EXCEPTION 'Legacy compatibility cannot complete commands'
      USING ERRCODE = '42501';
  END IF;
  RETURN app_private.network_center_complete_command_internal_v2(
    p_worker_id,
    p_command_id,
    p_lease_token,
    p_outcome,
    p_result,
    p_rollback,
    p_retry_delay_seconds
  );
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.network_center_complete_command_internal_v2(
  text, uuid, uuid, text, jsonb, jsonb, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.network_center_worker_complete_v1(
  text, uuid, uuid, text, jsonb, jsonb, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_complete_v1(
  text, uuid, uuid, text, jsonb, jsonb, integer
) TO service_role;

COMMENT ON FUNCTION app_private.network_center_complete_command_internal_v2(
  text, uuid, uuid, text, jsonb, jsonb, integer
) IS 'Private authoritative completion sink reached only after v2 worker authentication, final assignment and fenced transition checks.';
COMMENT ON FUNCTION public.network_center_worker_complete_v1(
  text, uuid, uuid, text, jsonb, jsonb, integer
) IS 'Legacy endpoint remains fail-closed; only an in-transaction private transition authority can reach the completion sink.';

COMMIT;

NOTIFY pgrst, 'reload schema';
