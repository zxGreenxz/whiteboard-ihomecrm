-- =============================================================================
-- Network Center operational safety: doomed-command admission, UNCERTAIN
-- recovery, cross-host reconciliation evidence, the §5/14 post-check invariant,
-- and a fleet-wide mutation gate.
--
-- Every change here is additive. No table is rewritten, no column is dropped,
-- no GRANT is widened. Worker RPCs stay worker-scoped (service_role), operator
-- RPCs stay execute-scoped (authenticated + network_center.execute) and are
-- therefore unreachable with a worker credential, because a worker connection
-- carries no auth.uid() and app_private.network_center_require_execute_v1()
-- rejects a NULL actor before touching any row.
--
-- 1. observation_deadline is absolute from command creation. Neither claim path
--    filtered on it, so a command that could never legally record its result was
--    still leased and EXECUTED against a real router. Both claim paths now
--    refuse a command that cannot finish inside its window, and a sweeper
--    settles the ones that expired while queued.
-- 2. An unresolved UNCERTAIN blocks every later command for its device -
--    including REBOOT_ROUTER - and nothing in the schema could resolve it.
--    Reconciliation now has a bounded attempt count, an expired reconciliation
--    window is retired automatically (it can never succeed once the deadline has
--    passed), and an execute-scoped operator RPC can retire one by hand with an
--    audited reason.
-- 3. CYCLE_ACCESS_PORT proved the disable half from worker process memory, so a
--    reconciliation on a different host could never satisfy the postcondition.
--    The authoritative evaluator now also accepts an earlier attempt's recorded
--    POST_ACTION disable for the same command and managed resource. The live
--    `enabled` readback is still mandatory: a recorded disable can never on its
--    own manufacture SUCCEEDED.
-- 4. §5 invariant 14 ("a failed post-check opens a critical incident and sets
--    changes_paused=true for that building") was never implemented in SQL. It is
--    now enforced inside the same transaction as the transition, so a different
--    action against a router left in an unknown state is no longer admitted.
--    A benign not-applicable outcome (DHCP_RENEW_NOT_APPLICABLE) is explicitly
--    not a failed post-check and never pauses a building.
-- 5. There was no org-wide pause; stopping the fleet mid-incident needed N
--    per-building admin calls. An organization mutation gate is enforced inside
--    app_private.network_center_require_execute_v1 - the one guard every
--    execute-scoped RPC already passes through - and in both claim paths, so no
--    RPC path can bypass it. Resuming is owner-only; pausing is not, because the
--    fail-safe direction must never wait for an owner.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729138000::bigint);

-- -----------------------------------------------------------------------------
-- 5. Organization-level mutation gate storage.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.network_org_mutation_gates (
  organization_id uuid PRIMARY KEY
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  mutations_paused boolean NOT NULL DEFAULT false,
  paused_reason text,
  paused_at timestamptz,
  paused_by uuid,
  resumed_reason text,
  resumed_at timestamptz,
  resumed_by uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT network_org_mutation_gates_version_check CHECK (version > 0),
  CONSTRAINT network_org_mutation_gates_paused_check CHECK (
    mutations_paused = false
    OR (
      paused_at IS NOT NULL
      AND paused_by IS NOT NULL
      AND paused_reason IS NOT NULL
      AND char_length(btrim(paused_reason)) BETWEEN 3 AND 500
    )
  ),
  CONSTRAINT network_org_mutation_gates_resume_check CHECK (
    (resumed_at IS NULL) = (resumed_by IS NULL)
    AND (
      resumed_reason IS NULL
      OR char_length(btrim(resumed_reason)) BETWEEN 3 AND 500
    )
  )
);

CREATE INDEX IF NOT EXISTS network_org_mutation_gates_paused_idx
  ON public.network_org_mutation_gates (organization_id)
  WHERE mutations_paused;

ALTER TABLE public.network_org_mutation_gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_org_mutation_gates FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.network_org_mutation_gates
  FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Bounded reconciliation attempts.
--
-- ADD COLUMN with a non-volatile DEFAULT does not rewrite the table on
-- PostgreSQL 11+, and the CHECK is added NOT VALID then validated under
-- SHARE UPDATE EXCLUSIVE so no reader or writer of this hot table is blocked
-- for the duration of a scan.
-- -----------------------------------------------------------------------------

ALTER TABLE public.network_commands
  ADD COLUMN IF NOT EXISTS reconciliation_attempt_count integer NOT NULL
    DEFAULT 0;

DO $reconciliation_attempt_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.network_commands'::regclass
      AND conname = 'network_commands_reconciliation_attempt_check'
  ) THEN
    ALTER TABLE public.network_commands
      ADD CONSTRAINT network_commands_reconciliation_attempt_check
      CHECK (reconciliation_attempt_count BETWEEN 0 AND 50) NOT VALID;
    ALTER TABLE public.network_commands
      VALIDATE CONSTRAINT network_commands_reconciliation_attempt_check;
  END IF;
END;
$reconciliation_attempt_constraint$;

-- Serves the deadline sweeper without a sequential scan of settled history.
CREATE INDEX IF NOT EXISTS network_commands_expiry_sweep_idx
  ON public.network_commands (observation_deadline, id)
  WHERE status IN ('QUEUED', 'RETRY_WAIT', 'UNCERTAIN');

-- -----------------------------------------------------------------------------
-- 5. The gate predicate. Fail closed: an unresolvable tenant is treated as
--    paused, never as "no gate row therefore allowed".
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_private.network_center_org_mutations_paused_v1(
  p_organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
  SELECT p_organization_id IS NULL OR EXISTS (
    SELECT 1
    FROM public.network_org_mutation_gates gate
    WHERE gate.organization_id = p_organization_id
      AND gate.mutations_paused
  );
$fn$;

REVOKE ALL ON FUNCTION app_private.network_center_org_mutations_paused_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Permission-only half of the execute guard.
--
-- Pausing and resuming the fleet must keep working while the fleet is paused, so
-- they need the identity and permission checks without the gate and without the
-- per-building rollout state. Splitting the existing guard keeps exactly one
-- implementation of "who is allowed to act on this building" and keeps the lock
-- order (building -> settings) identical to the guard it replaces.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_private.network_center_require_execute_permission_v1(
  p_building_id uuid
)
RETURNS TABLE (organization_id uuid, building_name text, actor_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  actor_id := (SELECT auth.uid());
  IF actor_id IS NULL OR p_building_id IS NULL THEN
    RAISE EXCEPTION 'Network Center execute permission is required'
      USING ERRCODE = '42501';
  END IF;

  SELECT building.organization_id, building.name
  INTO organization_id, building_name
  FROM public.buildings building
  WHERE building.id = p_building_id
    AND building.deleted_at IS NULL
    AND building.is_virtual = false
  FOR UPDATE;

  IF organization_id IS NULL
     OR NOT public.can_do_on_building(
       'network_center', 'execute', p_building_id
     ) THEN
    RAISE EXCEPTION 'Network Center execute permission is required'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION
  app_private.network_center_require_execute_permission_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- The single server-side guard every execute-scoped RPC already passes through.
-- The organization gate is checked here, before the per-building rollout state,
-- so one paused organization stops every execute-scoped RPC path at once.
CREATE OR REPLACE FUNCTION app_private.network_center_require_execute_v1(
  p_building_id uuid
)
RETURNS TABLE (organization_id uuid, building_name text, actor_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_state text;
  -- Locals, not the OUT parameters: `organization_id` is also a column of
  -- public.network_site_settings, and an unqualified reference to it inside the
  -- rollout query would be an ambiguous name under plpgsql.variable_conflict.
  v_organization_id uuid;
  v_building_name text;
  v_actor_id uuid;
BEGIN
  SELECT scope.organization_id, scope.building_name, scope.actor_id
  INTO v_organization_id, v_building_name, v_actor_id
  FROM app_private.network_center_require_execute_permission_v1(
    p_building_id
  ) scope;
  IF v_organization_id IS NULL OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Network Center execute permission is required'
      USING ERRCODE = '42501';
  END IF;

  IF app_private.network_center_org_mutations_paused_v1(v_organization_id) THEN
    RAISE EXCEPTION 'NETWORK_CENTER_ORG_PAUSED' USING ERRCODE = '42501';
  END IF;

  SELECT settings.rollout_state
  INTO v_state
  FROM public.network_site_settings settings
  WHERE settings.organization_id = v_organization_id
    AND settings.building_id = p_building_id
  FOR UPDATE;

  IF v_state = 'READ_ONLY' THEN
    RAISE EXCEPTION 'NETWORK_CENTER_READ_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_state IS DISTINCT FROM 'EXECUTE' THEN
    RAISE EXCEPTION 'NETWORK_CENTER_OFF' USING ERRCODE = '42501';
  END IF;

  organization_id := v_organization_id;
  building_name := v_building_name;
  actor_id := v_actor_id;
  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.network_center_require_execute_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. §5 invariant 14: a failed post-check opens a critical incident AND pauses
--    the building, in the transition's own transaction.
--
-- Also reused by the deadline sweeper when an UNCERTAIN command runs out of
-- reconciliation window: at that point the router state is genuinely unknown, so
-- releasing the device without pausing the building would admit a new action
-- against a router nobody has proven anything about.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_private.network_center_pause_building_after_failure_v1(
  p_command public.network_commands,
  p_actor_worker_id text,
  p_incident_type text,
  p_title text,
  p_summary text,
  p_detail jsonb,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_fingerprint text;
  v_incident_id uuid;
  v_paused boolean := false;
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
BEGIN
  IF p_command.id IS NULL
     OR p_command.organization_id IS NULL
     OR p_command.building_id IS NULL
     OR p_command.device_id IS NULL
     OR p_actor_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_incident_type !~ '^[A-Z][A-Z0-9_]{2,63}$'
     OR char_length(btrim(coalesce(p_title, ''))) NOT BETWEEN 3 AND 200
     OR char_length(btrim(coalesce(p_summary, ''))) NOT BETWEEN 3 AND 2000
     OR jsonb_typeof(v_detail) <> 'object'
     OR octet_length(v_detail::text) > 16384
     OR p_now IS NULL THEN
    RAISE EXCEPTION 'Invalid Network Center failure escalation'
      USING ERRCODE = '22023';
  END IF;

  v_fingerprint := 'network-center:' || lower(p_incident_type) || ':'
    || p_command.id::text;

  INSERT INTO public.network_incidents (
    organization_id, building_id, device_id, interface_id, fingerprint,
    incident_type, severity, status, title, summary, availability_impact,
    opened_at, last_observed_at, occurrence_count, observed_values
  ) VALUES (
    p_command.organization_id, p_command.building_id, p_command.device_id,
    p_command.interface_id, v_fingerprint, p_incident_type, 'CRITICAL', 'OPEN',
    btrim(p_title), btrim(p_summary), true, p_now, p_now, 1, v_detail
  )
  ON CONFLICT (organization_id, building_id, fingerprint)
    WHERE status <> 'RESOLVED'
  DO UPDATE SET
    severity = 'CRITICAL',
    last_observed_at = greatest(
      public.network_incidents.last_observed_at, EXCLUDED.last_observed_at
    ),
    occurrence_count = public.network_incidents.occurrence_count + 1,
    observed_values = EXCLUDED.observed_values,
    version = public.network_incidents.version + 1
  RETURNING id INTO v_incident_id;

  INSERT INTO public.network_incident_events (
    organization_id, building_id, incident_id, event_seq, event_kind,
    severity, occurred_at, worker_id, details
  ) VALUES (
    p_command.organization_id, p_command.building_id, v_incident_id,
    coalesce((
      SELECT max(event.event_seq) + 1
      FROM public.network_incident_events event
      WHERE event.incident_id = v_incident_id
    ), 1),
    'OPENED', 'CRITICAL', p_now, p_actor_worker_id,
    v_detail || jsonb_build_object('commandId', p_command.id)
  );

  UPDATE public.network_site_settings settings
  SET changes_paused = true,
      version = settings.version + 1,
      updated_at = p_now
  WHERE settings.organization_id = p_command.organization_id
    AND settings.building_id = p_command.building_id
    AND NOT settings.changes_paused;
  v_paused := FOUND;

  INSERT INTO public.network_audit_events (
    organization_id, building_id, actor_type, action, target_type, target_id,
    target_display, reason, validation, result, outcome, command_id, occurred_at
  ) VALUES (
    p_command.organization_id, p_command.building_id, 'SYSTEM',
    'system.pause_after_failed_check', 'building', p_command.building_id,
    jsonb_build_object(
      'deviceId', p_command.device_id,
      'actionType', p_command.action_type
    ),
    btrim(p_summary),
    v_detail,
    jsonb_build_object(
      'incidentId', v_incident_id,
      'changesPaused', true,
      'pausedByThisTransition', v_paused
    ),
    'FAILED', p_command.id, p_now
  );

  INSERT INTO public.network_outbox_events (
    organization_id, building_id, event_type, aggregate_type, aggregate_id,
    payload, occurred_at
  ) VALUES (
    p_command.organization_id, p_command.building_id,
    'network.building.changes_paused', 'building', p_command.building_id,
    jsonb_build_object(
      'incidentId', v_incident_id,
      'commandId', p_command.id,
      'incidentType', p_incident_type
    ),
    p_now
  );

  RETURN jsonb_build_object(
    'incidentId', v_incident_id,
    'changesPaused', true,
    'pausedByThisTransition', v_paused
  );
END;
$fn$;

REVOKE ALL ON FUNCTION
  app_private.network_center_pause_building_after_failure_v1(
    public.network_commands, text, text, text, text, jsonb, timestamptz
  ) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Authoritative postcondition evaluation with cross-host disable evidence.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_private.network_center_evaluate_postcondition_v1(
  p_command public.network_commands,
  p_before jsonb,
  p_after jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_before_expiry numeric;
  v_after_expiry numeric;
  v_before_uptime numeric;
  v_after_uptime numeric;
  v_before_at timestamptz;
  v_after_at timestamptz;
  v_live_disable boolean;
  v_recorded_disable boolean;
  v_disable_source text;
BEGIN
  p_before := coalesce(p_before, '{}'::jsonb);
  p_after := coalesce(p_after, '{}'::jsonb);
  BEGIN
    v_before_at := nullif(p_before->>'observedAt', '')::timestamptz;
    v_after_at := nullif(p_after->>'observedAt', '')::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object(
      'outcome', 'UNCERTAIN', 'code', 'INVALID_OBSERVATION_TIME'
    );
  END;
  IF v_before_at IS NULL OR v_after_at IS NULL
     OR v_after_at < v_before_at
     OR v_after_at > p_command.observation_deadline THEN
    RETURN jsonb_build_object(
      'outcome', 'UNCERTAIN', 'code', 'OBSERVATION_DEADLINE_EXCEEDED'
    );
  END IF;

  IF p_command.action_type = 'FLUSH_DNS_CACHE' THEN
    IF p_after #>> '{dns,commandAck}' = 'true' THEN
      RETURN jsonb_build_object(
        'outcome', 'SUCCEEDED', 'dnsAck', true,
        'expected', p_command.expected_postcondition
      );
    END IF;
  ELSIF p_command.action_type = 'RENEW_DHCP_LEASE' THEN
    IF p_before #>> '{dhcp,notApplicable}' = 'true'
       OR p_after #>> '{dhcp,notApplicable}' = 'true' THEN
      RETURN jsonb_build_object(
        'outcome', 'FAILED', 'code', 'DHCP_RENEW_NOT_APPLICABLE',
        'notApplicable', true
      );
    END IF;
    IF coalesce(p_before #>> '{dhcp,expiresInSeconds}', '') ~ '^\d+(?:\.\d+)?$'
       AND coalesce(p_after #>> '{dhcp,expiresInSeconds}', '') ~ '^\d+(?:\.\d+)?$' THEN
      v_before_expiry := (p_before #>> '{dhcp,expiresInSeconds}')::numeric;
      v_after_expiry := (p_after #>> '{dhcp,expiresInSeconds}')::numeric;
      IF lower(coalesce(p_before #>> '{dhcp,status}', '')) = 'bound'
         AND lower(coalesce(p_after #>> '{dhcp,status}', '')) = 'bound'
         AND p_before #>> '{dhcp,leaseKey}' = p_after #>> '{dhcp,leaseKey}'
         AND v_after_expiry > v_before_expiry THEN
        RETURN jsonb_build_object(
          'outcome', 'SUCCEEDED',
          'leaseExpiresInSeconds', v_after_expiry,
          'previousLeaseExpiresInSeconds', v_before_expiry
        );
      END IF;
    END IF;
  ELSIF p_command.action_type = 'CYCLE_ACCESS_PORT' THEN
    -- `disabledObserved` is produced by the worker process that drove the
    -- disable half. A reconciliation attempt builds a fresh connector, usually
    -- on a different host, and can therefore never re-observe it - which made
    -- the postcondition unsatisfiable for a genuinely healthy port. An earlier
    -- attempt's POST_ACTION observation on THIS command and THIS managed
    -- resource is durable, tenant-scoped, append-only evidence of the same fact,
    -- so it is accepted in place of the live half.
    --
    -- What is deliberately NOT relaxed: `enabledObserved` and `enabled` must
    -- still come from p_after. A recorded disable can never on its own produce
    -- SUCCEEDED, because a port left administratively down would then be
    -- reported as a healthy cycle.
    v_live_disable := p_after #>> '{accessInterface,disabledObserved}' = 'true';
    v_recorded_disable := EXISTS (
      SELECT 1
      FROM public.network_command_observations observation
      WHERE observation.command_id = p_command.id
        AND observation.organization_id = p_command.organization_id
        AND observation.building_id = p_command.building_id
        AND observation.device_id = p_command.device_id
        AND observation.observation_kind = 'POST_ACTION'
        AND observation.observed_at <= p_command.observation_deadline
        AND observation.evidence #>> '{accessInterface,managedResourceId}'
          = p_command.managed_target->>'managedResourceId'
        AND observation.evidence #>> '{accessInterface,immutableKey}'
          = p_command.managed_target->>'immutableKey'
        AND observation.evidence #>> '{accessInterface,disabledObserved}' = 'true'
    );
    v_disable_source := CASE
      WHEN v_live_disable THEN 'LIVE'
      WHEN v_recorded_disable THEN 'RECORDED_POST_ACTION'
      ELSE NULL
    END;
    IF p_after #>> '{accessInterface,managedResourceId}' =
         p_command.managed_target->>'managedResourceId'
       AND p_after #>> '{accessInterface,immutableKey}' =
         p_command.managed_target->>'immutableKey'
       AND v_disable_source IS NOT NULL
       AND p_after #>> '{accessInterface,enabledObserved}' = 'true'
       AND p_after #>> '{accessInterface,enabled}' = 'true' THEN
      RETURN jsonb_build_object(
        'outcome', 'SUCCEEDED',
        'managedResourceId', p_command.managed_target->>'managedResourceId',
        'immutableKey', p_command.managed_target->>'immutableKey',
        'disabledObserved', true, 'enabledObserved', true,
        'disabledObservedSource', v_disable_source
      );
    END IF;
  ELSIF p_command.action_type = 'REBOOT_ROUTER' THEN
    IF coalesce(p_before #>> '{boot,uptimeSeconds}', '') ~ '^\d+(?:\.\d+)?$'
       AND coalesce(p_after #>> '{boot,uptimeSeconds}', '') ~ '^\d+(?:\.\d+)?$' THEN
      v_before_uptime := (p_before #>> '{boot,uptimeSeconds}')::numeric;
      v_after_uptime := (p_after #>> '{boot,uptimeSeconds}')::numeric;
      IF nullif(p_before #>> '{boot,bootId}', '') IS NOT NULL
         AND nullif(p_after #>> '{boot,bootId}', '') IS NOT NULL
         AND p_before #>> '{boot,bootId}' <> p_after #>> '{boot,bootId}'
         AND v_after_uptime >= 0
         AND v_after_uptime < v_before_uptime THEN
        RETURN jsonb_build_object(
          'outcome', 'SUCCEEDED',
          'bootId', p_after #>> '{boot,bootId}',
          'uptimeSeconds', v_after_uptime,
          'previousBootId', p_before #>> '{boot,bootId}',
          'previousUptimeSeconds', v_before_uptime
        );
      END IF;
    END IF;
  ELSIF p_command.action_type = 'CAPTURE_SNAPSHOT' THEN
    IF coalesce(p_after #>> '{snapshot,redactedContentHash}', '') ~ '^[a-f0-9]{64}$'
       AND coalesce(p_after #>> '{snapshot,encryptedArtifactHash}', '') ~ '^[a-f0-9]{64}$'
       AND EXISTS (
         SELECT 1
         FROM public.network_config_snapshots snapshot
         WHERE snapshot.organization_id = p_command.organization_id
           AND snapshot.building_id = p_command.building_id
           AND snapshot.device_id = p_command.device_id
           AND snapshot.command_id = p_command.id
           AND snapshot.content_hash =
             p_after #>> '{snapshot,redactedContentHash}'
           AND snapshot.encrypted_artifact_hash =
             p_after #>> '{snapshot,encryptedArtifactHash}'
       ) THEN
      RETURN jsonb_build_object(
        'outcome', 'SUCCEEDED',
        'redactedContentHash', p_after #>> '{snapshot,redactedContentHash}',
        'encryptedArtifactHash', p_after #>> '{snapshot,encryptedArtifactHash}'
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'UNCERTAIN',
    'code', 'POSTCONDITION_NOT_PROVEN',
    'expected', p_command.expected_postcondition
  );
END;
$fn$;

REVOKE ALL ON FUNCTION
  app_private.network_center_evaluate_postcondition_v1(
    public.network_commands, jsonb, jsonb
  ) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Fenced transition, now implementing the failed post-check invariant.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_private.network_center_transition_command_v1(
  p_worker_id text,
  p_command_id uuid,
  p_lease_token uuid,
  p_fencing_generation bigint,
  p_transition_version bigint,
  p_outcome text,
  p_result jsonb,
  p_rollback jsonb DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_command public.network_commands%ROWTYPE;
  v_before jsonb;
  v_after jsonb;
  v_decision jsonb;
  v_database_outcome text;
  v_result jsonb := coalesce(p_result, '{}'::jsonb) - 'reconciliationDecision';
  v_response jsonb;
  v_escalation jsonb;
  v_post_check_ran boolean;
BEGIN
  p_worker_id := btrim(coalesce(p_worker_id, ''));
  p_outcome := upper(btrim(coalesce(p_outcome, '')));
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_command_id IS NULL OR p_lease_token IS NULL
     OR p_fencing_generation < 1 OR p_transition_version < 1
     OR p_outcome NOT IN (
       'EVALUATE_POSTCONDITION', 'RETRYABLE_FAILURE', 'FAILED',
       'UNCERTAIN', 'CANCELLED_BY_KILL_SWITCH'
     )
     OR jsonb_typeof(v_result) <> 'object'
     OR octet_length(v_result::text) > 65536
     OR (p_rollback IS NOT NULL AND (
       jsonb_typeof(p_rollback) <> 'object'
       OR octet_length(p_rollback::text) > 65536
     ))
     OR p_retry_delay_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'Invalid typed command transition' USING ERRCODE = '22023';
  END IF;

  SELECT command.* INTO v_command
  FROM public.network_commands command
  JOIN public.network_device_leases lease
    ON lease.organization_id = command.organization_id
   AND lease.building_id = command.building_id
   AND lease.device_id = command.device_id
   AND lease.command_id = command.id
   AND lease.lease_token = p_lease_token
   AND lease.lease_owner = p_worker_id
   AND lease.generation = p_fencing_generation
   AND lease.expires_at > clock_timestamp()
  WHERE command.id = p_command_id
    AND command.lease_token = p_lease_token
    AND command.lease_owner = p_worker_id
    AND command.lease_expires_at > clock_timestamp()
    AND command.transition_version = p_transition_version
    AND command.status IN ('LEASED', 'RUNNING', 'RECONCILING')
  FOR UPDATE OF command, lease;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stale command fencing or transition version'
      USING ERRCODE = '55000',
        DETAIL = jsonb_build_object(
          'code', 'NETWORK_CENTER_STALE_TRANSITION',
          'commandId', p_command_id,
          'fencingGeneration', p_fencing_generation,
          'transitionVersion', p_transition_version
        )::text;
  END IF;

  SELECT observation.evidence || jsonb_build_object(
    'observedAt', observation.observed_at
  ) INTO v_before
  FROM public.network_command_observations observation
  WHERE observation.command_id = v_command.id
    AND observation.observation_kind = 'PRE_ACTION'
  ORDER BY observation.transition_version_before, observation.observed_at,
    observation.id
  LIMIT 1;
  v_before := coalesce(v_command.pre_observation, v_before);

  SELECT observation.evidence || jsonb_build_object(
    'observedAt', observation.observed_at
  ) INTO v_after
  FROM public.network_command_observations observation
  WHERE observation.command_id = v_command.id
    AND observation.observation_kind IN ('POST_ACTION', 'RECONCILIATION')
  ORDER BY observation.transition_version_before DESC,
    observation.observed_at DESC, observation.id DESC
  LIMIT 1;

  -- "The post-check ran" is exactly: the worker asked the database to judge what
  -- it observed, or this transition is the verdict of a reconciliation attempt.
  -- Both mean the router was touched and its state is now in question. A plain
  -- transport failure (RETRYABLE_FAILURE / FAILED on a LEASED command that never
  -- got to a post-check) is NOT one of these, and must not pause a building -
  -- an SSH blip on one router would otherwise stop an entire site.
  v_post_check_ran := p_outcome = 'EVALUATE_POSTCONDITION'
    OR v_command.status = 'RECONCILING';

  IF p_outcome = 'EVALUATE_POSTCONDITION' THEN
    v_decision := app_private.network_center_evaluate_postcondition_v1(
      v_command, v_before, v_after
    );
    v_database_outcome := CASE v_decision->>'outcome'
      WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
      WHEN 'FAILED' THEN 'FAILED'
      ELSE 'UNCERTAIN'
    END;
    v_result := v_result || jsonb_build_object(
      'postcondition', v_decision,
      'transitionVersion', p_transition_version + 1
    );
    IF v_database_outcome = 'FAILED'
       AND v_decision ? 'code' AND NOT v_result ? 'code' THEN
      v_result := v_result || jsonb_build_object('code', v_decision->>'code');
    END IF;
  ELSE
    v_database_outcome := p_outcome;
  END IF;

  PERFORM set_config(
    'app.network_center_transition_authority', v_command.id::text, true
  );
  UPDATE public.network_commands command
  SET transition_version = command.transition_version + 1
  WHERE command.id = p_command_id
    AND command.transition_version = p_transition_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stale command transition compare-and-swap'
      USING ERRCODE = '55000';
  END IF;

  IF v_database_outcome = 'SUCCEEDED' THEN
    PERFORM set_config(
      'app.network_center_success_authority', v_command.id::text, true
    );
  END IF;
  v_response := public.network_center_worker_complete_v1(
    p_worker_id, p_command_id, p_lease_token, v_database_outcome,
    v_result, p_rollback, p_retry_delay_seconds
  );

  -- §5 invariant 14, evaluated on the SETTLED status so it also covers a
  -- RETRYABLE_FAILURE that exhausted its attempts, in the transition's own
  -- transaction. A benign "not applicable" (the DHCP renew case) is not a
  -- failed post-check: nothing was changed and nothing is unknown, so it must
  -- never pause a building.
  IF v_post_check_ran
     AND v_response->>'status' = 'FAILED'
     AND NOT coalesce((v_decision->>'notApplicable')::boolean, false) THEN
    v_escalation := app_private.network_center_pause_building_after_failure_v1(
      v_command,
      p_worker_id,
      'COMMAND_POSTCHECK_FAILED',
      'Network Center post-check failed',
      'A Network Center post-check failed, so the device state is not proven. '
        || 'Changes are paused for this building until an operator resumes them.',
      jsonb_build_object(
        'commandId', v_command.id,
        'actionType', v_command.action_type,
        'previousStatus', v_command.status,
        'postcondition', coalesce(v_decision, 'null'::jsonb)
      ),
      clock_timestamp()
    );
  END IF;

  RETURN v_response || jsonb_build_object(
    'transitionVersion', p_transition_version + 1
  ) || CASE
    WHEN v_escalation IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('escalation', v_escalation)
  END;
END;
$fn$;

REVOKE ALL ON FUNCTION
  app_private.network_center_transition_command_v1(
    text, uuid, uuid, bigint, bigint, text, jsonb, jsonb, integer
  ) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1 + 2. Deadline sweeper.
--
-- Settles commands whose observation window closed while they were waiting, into
-- an HONEST terminal state:
--
--   * QUEUED / RETRY_WAIT past deadline -> FAILED. Nothing was ever dispatched,
--     so nothing about the router is unknown. Marking these UNCERTAIN would be a
--     lie AND would wedge the device, because an unresolved UNCERTAIN blocks
--     every later command for that device including REBOOT_ROUTER.
--   * UNCERTAIN past deadline -> FAILED with reconciliation_state UNKNOWN.
--     network_center_record_command_observation_v1 refuses any observation past
--     the deadline, so reconciliation provably can no longer succeed. Releasing
--     the device is required to make recovery possible at all, so the building is
--     paused and a critical incident is opened in the same transaction: the
--     device stops being wedged, but nothing new runs unattended.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_private.network_center_sweep_expired_commands_v1(
  p_now timestamptz DEFAULT clock_timestamp(),
  p_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  c_sweeper_id constant text := 'network-center:deadline-sweeper';
  v_command public.network_commands%ROWTYPE;
  v_attempt_id uuid;
  v_result jsonb;
  v_queued_expired integer := 0;
  v_uncertain_expired integer := 0;
BEGIN
  IF p_now IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Invalid Network Center expiry sweep request'
      USING ERRCODE = '22023';
  END IF;

  FOR v_command IN
    SELECT command.*
    FROM public.network_commands command
    WHERE command.status IN ('QUEUED', 'RETRY_WAIT', 'UNCERTAIN')
      AND command.observation_deadline <= p_now
      AND NOT EXISTS (
        SELECT 1
        FROM public.network_device_leases lease
        WHERE lease.device_id = command.device_id
          AND lease.expires_at > p_now
      )
    ORDER BY command.observation_deadline, command.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  LOOP
    v_result := jsonb_build_object(
      'code', CASE WHEN v_command.status = 'UNCERTAIN'
        THEN 'RECONCILIATION_WINDOW_EXPIRED'
        ELSE 'OBSERVATION_DEADLINE_EXPIRED_BEFORE_DISPATCH' END,
      'observationDeadline', v_command.observation_deadline,
      'previousStatus', v_command.status,
      'sweptAt', p_now
    );

    SELECT attempt.id INTO v_attempt_id
    FROM public.network_command_attempts attempt
    WHERE attempt.command_id = v_command.id
    ORDER BY attempt.attempt_no DESC
    LIMIT 1;

    UPDATE public.network_command_attempts attempt
    SET outcome = 'PERMANENT_FAILURE',
        retryable = false,
        error_code = v_result->>'code',
        error_message = 'Observation window closed before the command could be '
          || 'proven.',
        result = v_result,
        finished_at = p_now
    WHERE attempt.id = v_attempt_id
      AND attempt.finished_at IS NULL;

    INSERT INTO public.network_command_events (
      organization_id, building_id, command_id, attempt_id, event_seq,
      event_kind, occurred_at, worker_id, payload
    ) VALUES (
      v_command.organization_id, v_command.building_id, v_command.id,
      v_attempt_id,
      coalesce((
        SELECT max(event.event_seq) + 1
        FROM public.network_command_events event
        WHERE event.command_id = v_command.id
      ), 1),
      'FAILED', p_now, c_sweeper_id, v_result
    );

    UPDATE public.network_commands command
    SET status = 'FAILED',
        reconciliation_state = CASE
          WHEN v_command.status = 'UNCERTAIN' THEN 'UNKNOWN'
          ELSE command.reconciliation_state
        END,
        result = coalesce(command.result, '{}'::jsonb) || v_result,
        started_at = coalesce(command.started_at, p_now),
        finished_at = p_now,
        updated_at = p_now
    WHERE command.id = v_command.id;

    INSERT INTO public.network_audit_events (
      organization_id, building_id, actor_type, action, target_type, target_id,
      target_display, reason, validation, result, outcome, command_id,
      occurred_at
    ) VALUES (
      v_command.organization_id, v_command.building_id, 'SYSTEM',
      'system.expire_command', 'command', v_command.id,
      jsonb_build_object(
        'deviceId', v_command.device_id,
        'actionType', v_command.action_type
      ),
      'Observation window closed before the command could be proven',
      jsonb_build_object('previousStatus', v_command.status),
      v_result, 'FAILED', v_command.id, p_now
    );

    IF v_command.status = 'UNCERTAIN' THEN
      PERFORM app_private.network_center_pause_building_after_failure_v1(
        v_command,
        c_sweeper_id,
        'RECONCILIATION_WINDOW_EXPIRED',
        'Network Center reconciliation window expired',
        'A command stayed UNCERTAIN past its observation deadline, so its effect '
          || 'on the router can no longer be proven. Changes are paused for this '
          || 'building until an operator resumes them.',
        v_result,
        p_now
      );
      v_uncertain_expired := v_uncertain_expired + 1;
    ELSE
      v_queued_expired := v_queued_expired + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'queuedExpired', v_queued_expired,
    'uncertainExpired', v_uncertain_expired,
    'sweptAt', p_now
  );
END;
$fn$;

REVOKE ALL ON FUNCTION
  app_private.network_center_sweep_expired_commands_v1(timestamptz, integer)
  FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1 + 2 + 5. Legacy private claim helpers.
--
-- public.network_center_worker_claim_v1 is already inert, but these two private
-- helpers still exist in the schema and would silently reintroduce the hole the
-- moment anything re-wired them. They carry the same three predicates as the
-- live v2 path: the observation deadline must leave enough window to record a
-- result, the reconciliation attempt count must be under its cap, and the
-- organization must not be paused.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_private.network_center_claim_commands_v1(
  p_worker_id text,
  p_limit integer DEFAULT 5,
  p_lease_seconds integer DEFAULT 90
)
RETURNS TABLE (
  command_id uuid,
  organization_id uuid,
  building_id uuid,
  device_id uuid,
  interface_id uuid,
  action_type text,
  reason text,
  sanitized_parameters jsonb,
  attempt_no integer,
  lease_token uuid,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  -- An attempt still has to record PRE_ACTION, drive the router and record
  -- POST_ACTION. Claiming a command whose window closes inside this margin
  -- guarantees a real router mutation whose result can never be written down.
  c_claim_min_remaining constant interval := INTERVAL '5 seconds';
  v_now timestamptz := clock_timestamp();
BEGIN
  p_worker_id := btrim(coalesce(p_worker_id, ''));
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_limit NOT BETWEEN 1 AND 20
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'Invalid command claim request' USING ERRCODE = '22023';
  END IF;

  PERFORM app_private.network_center_reclaim_expired_commands_v1(v_now);
  PERFORM app_private.network_center_sweep_expired_commands_v1(v_now);

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT
      command.id,
      command.organization_id,
      command.building_id,
      command.device_id,
      gen_random_uuid() AS token
    FROM public.network_commands command
    WHERE command.status IN ('QUEUED', 'RETRY_WAIT')
      AND command.available_at <= v_now
      AND command.attempt_count < command.max_attempts
      AND command.observation_deadline > v_now + c_claim_min_remaining
      AND NOT app_private.network_center_org_mutations_paused_v1(
        command.organization_id
      )
      AND (
        command.action_type = 'CAPTURE_SNAPSHOT'
        OR EXISTS (
          SELECT 1
          FROM public.network_site_settings settings
          WHERE settings.organization_id = command.organization_id
            AND settings.building_id = command.building_id
            AND NOT settings.changes_paused
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.network_device_leases lease
        WHERE lease.device_id = command.device_id
          AND lease.expires_at > v_now
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.network_commands unresolved
        WHERE unresolved.device_id = command.device_id
          AND unresolved.status = 'UNCERTAIN'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.network_commands earlier
        WHERE earlier.device_id = command.device_id
          AND earlier.status IN ('QUEUED', 'RETRY_WAIT')
          AND earlier.available_at <= v_now
          AND earlier.attempt_count < earlier.max_attempts
          AND earlier.observation_deadline > v_now + c_claim_min_remaining
          AND (
            earlier.priority > command.priority
            OR (
              earlier.priority = command.priority
              AND ROW(earlier.available_at, earlier.created_at, earlier.id)
                  < ROW(command.available_at, command.created_at, command.id)
            )
          )
      )
    ORDER BY
      command.priority DESC, command.available_at, command.created_at,
      command.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ),
  leased AS (
    INSERT INTO public.network_device_leases (
      device_id, organization_id, building_id, command_id, lease_token,
      lease_owner, acquired_at, heartbeat_at, expires_at, generation
    )
    SELECT
      candidate.device_id,
      candidate.organization_id,
      candidate.building_id,
      candidate.id,
      candidate.token,
      p_worker_id,
      v_now,
      v_now,
      v_now + make_interval(secs => p_lease_seconds),
      1
    FROM candidates candidate
    ON CONFLICT ON CONSTRAINT network_device_leases_pkey DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      building_id = EXCLUDED.building_id,
      command_id = EXCLUDED.command_id,
      lease_token = EXCLUDED.lease_token,
      lease_owner = EXCLUDED.lease_owner,
      acquired_at = EXCLUDED.acquired_at,
      heartbeat_at = EXCLUDED.heartbeat_at,
      expires_at = EXCLUDED.expires_at,
      generation = public.network_device_leases.generation + 1
    WHERE public.network_device_leases.expires_at <= v_now
    RETURNING
      public.network_device_leases.device_id,
      public.network_device_leases.command_id,
      public.network_device_leases.lease_token,
      public.network_device_leases.expires_at
  ),
  claimed AS (
    UPDATE public.network_commands command
    SET
      status = 'LEASED',
      lease_token = lease.lease_token,
      lease_owner = p_worker_id,
      lease_expires_at = lease.expires_at,
      attempt_count = command.attempt_count + 1,
      started_at = coalesce(command.started_at, v_now),
      updated_at = v_now
    FROM leased lease
    WHERE command.id = lease.command_id
    RETURNING command.*
  ),
  attempts AS (
    INSERT INTO public.network_command_attempts (
      organization_id, building_id, command_id, device_id, attempt_no,
      worker_id, lease_token, outcome, started_at
    )
    SELECT
      claimed.organization_id,
      claimed.building_id,
      claimed.id,
      claimed.device_id,
      claimed.attempt_count,
      p_worker_id,
      claimed.lease_token,
      'STARTED',
      v_now
    FROM claimed
    RETURNING
      public.network_command_attempts.id,
      public.network_command_attempts.organization_id,
      public.network_command_attempts.building_id,
      public.network_command_attempts.command_id
  ),
  events AS (
    INSERT INTO public.network_command_events (
      organization_id, building_id, command_id, attempt_id, event_seq,
      event_kind, occurred_at, worker_id, payload
    )
    SELECT
      attempts.organization_id,
      attempts.building_id,
      attempts.command_id,
      attempts.id,
      coalesce((
        SELECT max(existing_event.event_seq) + 1
        FROM public.network_command_events existing_event
        WHERE existing_event.command_id = attempts.command_id
      ), 1),
      'LEASED',
      v_now,
      p_worker_id,
      jsonb_build_object(
        'attemptNo', claimed.attempt_count,
        'leaseExpiresAt', claimed.lease_expires_at
      )
    FROM claimed
    JOIN attempts ON attempts.command_id = claimed.id
    RETURNING public.network_command_events.command_id
  )
  SELECT
    claimed.id,
    claimed.organization_id,
    claimed.building_id,
    claimed.device_id,
    claimed.interface_id,
    claimed.action_type,
    claimed.reason,
    claimed.sanitized_parameters,
    claimed.attempt_count,
    claimed.lease_token,
    claimed.lease_expires_at
  FROM claimed
  JOIN attempts ON attempts.command_id = claimed.id
  JOIN events ON events.command_id = claimed.id
  ORDER BY claimed.priority DESC, claimed.created_at, claimed.id;
END;
$fn$;

REVOKE ALL ON FUNCTION
  app_private.network_center_claim_commands_v1(text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.network_center_claim_reconciliation_v1(
  p_worker_id text,
  p_limit integer DEFAULT 5,
  p_lease_seconds integer DEFAULT 90
)
RETURNS TABLE (
  command_id uuid,
  organization_id uuid,
  building_id uuid,
  device_id uuid,
  interface_id uuid,
  action_type text,
  reason text,
  sanitized_parameters jsonb,
  attempt_no integer,
  lease_token uuid,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  c_claim_min_remaining constant interval := INTERVAL '5 seconds';
  c_max_reconciliation_attempts constant integer := 3;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_limit NOT BETWEEN 1 AND 20
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'Invalid reconciliation claim request'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT command.*, gen_random_uuid() AS new_token
    FROM public.network_commands command
    WHERE command.status = 'UNCERTAIN'
      AND command.reconciliation_state = 'REQUIRED'
      AND command.observation_deadline > v_now + c_claim_min_remaining
      AND command.reconciliation_attempt_count < c_max_reconciliation_attempts
      AND NOT app_private.network_center_org_mutations_paused_v1(
        command.organization_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.network_device_leases lease
        WHERE lease.device_id = command.device_id
          AND lease.expires_at > v_now
      )
    ORDER BY command.updated_at, command.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ),
  leases AS (
    INSERT INTO public.network_device_leases (
      device_id, organization_id, building_id, command_id, lease_token,
      lease_owner, acquired_at, heartbeat_at, expires_at, generation
    )
    SELECT
      candidate.device_id, candidate.organization_id, candidate.building_id,
      candidate.id, candidate.new_token, p_worker_id, v_now, v_now,
      v_now + make_interval(secs => p_lease_seconds), 1
    FROM candidates candidate
    ON CONFLICT ON CONSTRAINT network_device_leases_pkey DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      building_id = EXCLUDED.building_id,
      command_id = EXCLUDED.command_id,
      lease_token = EXCLUDED.lease_token,
      lease_owner = EXCLUDED.lease_owner,
      acquired_at = EXCLUDED.acquired_at,
      heartbeat_at = EXCLUDED.heartbeat_at,
      expires_at = EXCLUDED.expires_at,
      generation = public.network_device_leases.generation + 1
    WHERE public.network_device_leases.expires_at <= v_now
    RETURNING public.network_device_leases.*
  ),
  claimed AS (
    UPDATE public.network_commands command
    SET
      status = 'RECONCILING',
      reconciliation_state = 'IN_PROGRESS',
      reconciliation_attempt_count = command.reconciliation_attempt_count + 1,
      lease_token = lease.lease_token,
      lease_owner = p_worker_id,
      lease_expires_at = lease.expires_at,
      updated_at = v_now
    FROM leases lease
    WHERE command.id = lease.command_id
    RETURNING command.*
  ),
  events AS (
    INSERT INTO public.network_command_events (
      organization_id, building_id, command_id, attempt_id, event_seq,
      event_kind, occurred_at, worker_id, payload
    )
    SELECT
      claimed.organization_id, claimed.building_id, claimed.id,
      (
        SELECT attempt.id
        FROM public.network_command_attempts attempt
        WHERE attempt.command_id = claimed.id
        ORDER BY attempt.attempt_no DESC
        LIMIT 1
      ),
      coalesce((
        SELECT max(event.event_seq) + 1
        FROM public.network_command_events event
        WHERE event.command_id = claimed.id
      ), 1),
      'RECONCILIATION_STARTED', v_now, p_worker_id,
      jsonb_build_object(
        'leaseExpiresAt', claimed.lease_expires_at,
        'reconciliationAttempt', claimed.reconciliation_attempt_count
      )
    FROM claimed
    RETURNING public.network_command_events.command_id
  )
  SELECT
    claimed.id, claimed.organization_id, claimed.building_id,
    claimed.device_id, claimed.interface_id, claimed.action_type,
    claimed.reason, claimed.sanitized_parameters, claimed.attempt_count,
    claimed.lease_token, claimed.lease_expires_at
  FROM claimed
  JOIN events ON events.command_id = claimed.id;
END;
$fn$;

REVOKE ALL ON FUNCTION
  app_private.network_center_claim_reconciliation_v1(text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1 + 2 + 5. The live worker claim path.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.network_center_worker_claim_v2(
  p_credential_digest text,
  p_limit integer DEFAULT 5,
  p_lease_seconds integer DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  -- See app_private.network_center_claim_commands_v1 for why a claim needs
  -- headroom rather than a bare "deadline is still in the future".
  c_claim_min_remaining constant interval := INTERVAL '5 seconds';
  -- A reconciliation that keeps failing must not burn the whole observation
  -- window in a claim loop. Past this cap the command waits for the deadline
  -- sweeper (or an operator) instead of taking the device lease again.
  c_max_reconciliation_attempts constant integer := 3;
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_capabilities text[];
  v_now timestamptz := clock_timestamp();
  v_candidate public.network_commands%ROWTYPE;
  v_command public.network_commands%ROWTYPE;
  v_lease public.network_device_leases%ROWTYPE;
  v_attempt_id uuid;
  v_event_seq bigint;
  v_items jsonb := '[]'::jsonb;
  v_claimed integer := 0;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  IF p_limit NOT BETWEEN 1 AND 20
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'Invalid command claim request' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_reclaim_expired_commands_v2(
    v_worker_id, v_now
  );
  -- Runs before any admission decision so a doomed command is settled honestly
  -- rather than merely skipped and left to accumulate.
  PERFORM app_private.network_center_sweep_expired_commands_v1(v_now);

  -- Assignment and managed-resource admission happen in the candidate query,
  -- before any lease mutation. Revocation/protection committed before this lock
  -- makes the command ineligible rather than globally claiming then rejecting.
  FOR v_candidate IN
    SELECT command.*
    FROM public.network_commands command
    JOIN public.network_worker_assignments assignment
      ON assignment.worker_id = v_worker_id
     AND assignment.organization_id = command.organization_id
     AND assignment.building_id = command.building_id
     AND assignment.device_id = command.device_id
     AND assignment.can_execute
     AND assignment.active_from <= v_now
     AND (
       assignment.active_until IS NULL
       OR assignment.active_until > v_now
     )
    JOIN public.network_workers worker
      ON worker.id = assignment.worker_id
     AND worker.status = 'ACTIVE'
     AND 'EXECUTE' = ANY(worker.capabilities)
    JOIN public.network_site_settings settings
      ON settings.organization_id = command.organization_id
     AND settings.building_id = command.building_id
     AND settings.rollout_state = 'EXECUTE'
    WHERE command.status IN ('QUEUED', 'RETRY_WAIT')
      AND command.available_at <= v_now
      AND command.attempt_count < command.max_attempts
      -- A command whose observation window has closed can never record its
      -- result, so executing it would mutate a real router with no way to
      -- write down what happened.
      AND command.observation_deadline > v_now + c_claim_min_remaining
      AND NOT app_private.network_center_org_mutations_paused_v1(
        command.organization_id
      )
      AND (
        command.action_type = 'CAPTURE_SNAPSHOT'
        OR NOT settings.changes_paused
      )
      AND (
        command.action_type <> 'CYCLE_ACCESS_PORT'
        OR EXISTS (
          SELECT 1
          FROM public.network_interfaces interface
          JOIN public.network_managed_resources resource
            ON resource.organization_id = interface.organization_id
           AND resource.building_id = interface.building_id
           AND resource.device_id = interface.device_id
           AND resource.id = interface.managed_resource_id
          WHERE interface.organization_id = command.organization_id
            AND interface.building_id = command.building_id
            AND interface.device_id = command.device_id
            AND interface.id = command.interface_id
            AND interface.interface_role = 'ACCESS'
            AND NOT interface.is_protected
            AND resource.resource_kind = 'INTERFACE'
            AND resource.enrolled_role = 'ACCESS'
            AND resource.enrollment_state = 'ENROLLED'
            AND resource.protected = false
            AND resource.last_verified_at IS NOT NULL
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.network_device_leases active_lease
        WHERE active_lease.device_id = command.device_id
          AND active_lease.expires_at > v_now
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.network_commands unresolved
        WHERE unresolved.device_id = command.device_id
          AND unresolved.status = 'UNCERTAIN'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.network_commands earlier
        WHERE earlier.device_id = command.device_id
          AND earlier.status IN ('QUEUED', 'RETRY_WAIT')
          AND earlier.available_at <= v_now
          AND earlier.attempt_count < earlier.max_attempts
          AND earlier.observation_deadline > v_now + c_claim_min_remaining
          AND (
            earlier.priority > command.priority
            OR (
              earlier.priority = command.priority
              AND ROW(earlier.available_at, earlier.created_at, earlier.id)
                < ROW(command.available_at, command.created_at, command.id)
            )
          )
      )
    ORDER BY command.priority DESC, command.available_at,
      command.created_at, command.id
    FOR UPDATE OF command, assignment, worker, settings SKIP LOCKED
    LIMIT p_limit
  LOOP
    IF v_candidate.action_type = 'CYCLE_ACCESS_PORT' THEN
      PERFORM 1
      FROM public.network_interfaces interface
      JOIN public.network_managed_resources resource
        ON resource.organization_id = interface.organization_id
       AND resource.building_id = interface.building_id
       AND resource.device_id = interface.device_id
       AND resource.id = interface.managed_resource_id
      WHERE interface.organization_id = v_candidate.organization_id
        AND interface.building_id = v_candidate.building_id
        AND interface.device_id = v_candidate.device_id
        AND interface.id = v_candidate.interface_id
        AND interface.interface_role = 'ACCESS'
        AND NOT interface.is_protected
        AND resource.resource_kind = 'INTERFACE'
        AND resource.enrolled_role = 'ACCESS'
        AND resource.enrollment_state = 'ENROLLED'
        AND resource.protected = false
        AND resource.last_verified_at IS NOT NULL
      FOR UPDATE OF interface, resource;
      IF NOT FOUND THEN CONTINUE; END IF;
    END IF;

    INSERT INTO public.network_device_leases (
      device_id, organization_id, building_id, command_id, lease_token,
      lease_owner, acquired_at, heartbeat_at, expires_at, generation
    ) VALUES (
      v_candidate.device_id, v_candidate.organization_id,
      v_candidate.building_id, v_candidate.id, gen_random_uuid(),
      v_worker_key, v_now, v_now,
      v_now + make_interval(secs => p_lease_seconds), 1
    )
    ON CONFLICT (device_id) DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      building_id = EXCLUDED.building_id,
      command_id = EXCLUDED.command_id,
      lease_token = EXCLUDED.lease_token,
      lease_owner = EXCLUDED.lease_owner,
      acquired_at = EXCLUDED.acquired_at,
      heartbeat_at = EXCLUDED.heartbeat_at,
      expires_at = EXCLUDED.expires_at,
      generation = public.network_device_leases.generation + 1
    WHERE public.network_device_leases.expires_at <= v_now
    RETURNING * INTO v_lease;
    IF NOT FOUND THEN CONTINUE; END IF;

    UPDATE public.network_commands command
    SET status = 'LEASED', lease_token = v_lease.lease_token,
        lease_owner = v_worker_key, lease_expires_at = v_lease.expires_at,
        attempt_count = command.attempt_count + 1,
        started_at = coalesce(command.started_at, v_now), updated_at = v_now
    WHERE command.id = v_candidate.id
    RETURNING * INTO v_command;

    INSERT INTO public.network_command_attempts (
      organization_id, building_id, command_id, device_id, attempt_no,
      worker_id, lease_token, outcome, started_at
    ) VALUES (
      v_command.organization_id, v_command.building_id, v_command.id,
      v_command.device_id, v_command.attempt_count, v_worker_key,
      v_command.lease_token, 'STARTED', v_now
    ) RETURNING id INTO v_attempt_id;

    SELECT coalesce(max(event.event_seq) + 1, 1)
    INTO v_event_seq
    FROM public.network_command_events event
    WHERE event.command_id = v_command.id;
    INSERT INTO public.network_command_events (
      organization_id, building_id, command_id, attempt_id, event_seq,
      event_kind, occurred_at, worker_id, payload
    ) VALUES (
      v_command.organization_id, v_command.building_id, v_command.id,
      v_attempt_id, v_event_seq, 'LEASED', v_now, v_worker_key,
      jsonb_build_object(
        'attemptNo', v_command.attempt_count,
        'leaseExpiresAt', v_command.lease_expires_at
      )
    );

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'commandId', v_command.id,
      'organizationId', v_command.organization_id,
      'buildingId', v_command.building_id,
      'deviceId', v_command.device_id,
      'interfaceId', v_command.interface_id,
      'actionType', v_command.action_type,
      'reason', v_command.reason,
      'parameters', v_command.sanitized_parameters,
      'attemptNo', v_command.attempt_count,
      'leaseToken', v_command.lease_token,
      'leaseExpiresAt', v_command.lease_expires_at,
      'reconciliation', false,
      'intentType', v_command.intent_type,
      'managedTarget', v_command.managed_target,
      'preObservation', v_command.pre_observation,
      'expectedPostcondition', v_command.expected_postcondition,
      'observationDeadline', v_command.observation_deadline,
      'transitionVersion', v_command.transition_version,
      'fencingGeneration', v_lease.generation
    ));
    v_claimed := v_claimed + 1;
  END LOOP;

  IF v_claimed < p_limit THEN
    FOR v_candidate IN
      SELECT command.*
      FROM public.network_commands command
      JOIN public.network_worker_assignments assignment
        ON assignment.worker_id = v_worker_id
       AND assignment.organization_id = command.organization_id
       AND assignment.building_id = command.building_id
       AND assignment.device_id = command.device_id
       AND assignment.can_execute
       AND assignment.active_from <= v_now
       AND (
         assignment.active_until IS NULL
         OR assignment.active_until > v_now
       )
      JOIN public.network_workers worker
        ON worker.id = assignment.worker_id
       AND worker.status = 'ACTIVE'
       AND 'EXECUTE' = ANY(worker.capabilities)
      WHERE command.status = 'UNCERTAIN'
        AND command.reconciliation_state = 'REQUIRED'
        -- Past the deadline a reconciliation can never record an observation,
        -- so re-leasing the device would only wedge it for longer.
        AND command.observation_deadline > v_now + c_claim_min_remaining
        AND command.reconciliation_attempt_count
          < c_max_reconciliation_attempts
        AND NOT app_private.network_center_org_mutations_paused_v1(
          command.organization_id
        )
        AND (
          command.action_type <> 'CYCLE_ACCESS_PORT'
          OR EXISTS (
            SELECT 1
            FROM public.network_interfaces interface
            JOIN public.network_managed_resources resource
              ON resource.id = interface.managed_resource_id
             AND resource.organization_id = interface.organization_id
             AND resource.building_id = interface.building_id
             AND resource.device_id = interface.device_id
            WHERE interface.id = command.interface_id
              AND interface.device_id = command.device_id
              AND interface.interface_role = 'ACCESS'
              AND NOT interface.is_protected
              AND resource.enrollment_state = 'ENROLLED'
              AND resource.protected = false
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.network_device_leases active_lease
          WHERE active_lease.device_id = command.device_id
            AND active_lease.expires_at > v_now
        )
      ORDER BY command.updated_at, command.id
      FOR UPDATE OF command, assignment, worker SKIP LOCKED
      LIMIT (p_limit - v_claimed)
    LOOP
      IF v_candidate.action_type = 'CYCLE_ACCESS_PORT' THEN
        PERFORM 1
        FROM public.network_interfaces interface
        JOIN public.network_managed_resources resource
          ON resource.organization_id = interface.organization_id
         AND resource.building_id = interface.building_id
         AND resource.device_id = interface.device_id
         AND resource.id = interface.managed_resource_id
        WHERE interface.organization_id = v_candidate.organization_id
          AND interface.building_id = v_candidate.building_id
          AND interface.device_id = v_candidate.device_id
          AND interface.id = v_candidate.interface_id
          AND interface.interface_role = 'ACCESS'
          AND NOT interface.is_protected
          AND resource.resource_kind = 'INTERFACE'
          AND resource.enrolled_role = 'ACCESS'
          AND resource.enrollment_state = 'ENROLLED'
          AND resource.protected = false
          AND resource.last_verified_at IS NOT NULL
        FOR UPDATE OF interface, resource;
        IF NOT FOUND THEN CONTINUE; END IF;
      END IF;

      INSERT INTO public.network_device_leases (
        device_id, organization_id, building_id, command_id, lease_token,
        lease_owner, acquired_at, heartbeat_at, expires_at, generation
      ) VALUES (
        v_candidate.device_id, v_candidate.organization_id,
        v_candidate.building_id, v_candidate.id, gen_random_uuid(),
        v_worker_key, v_now, v_now,
        v_now + make_interval(secs => p_lease_seconds), 1
      )
      ON CONFLICT (device_id) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        building_id = EXCLUDED.building_id,
        command_id = EXCLUDED.command_id,
        lease_token = EXCLUDED.lease_token,
        lease_owner = EXCLUDED.lease_owner,
        acquired_at = EXCLUDED.acquired_at,
        heartbeat_at = EXCLUDED.heartbeat_at,
        expires_at = EXCLUDED.expires_at,
        generation = public.network_device_leases.generation + 1
      WHERE public.network_device_leases.expires_at <= v_now
      RETURNING * INTO v_lease;
      IF NOT FOUND THEN CONTINUE; END IF;

      UPDATE public.network_commands command
      SET status = 'RECONCILING', reconciliation_state = 'IN_PROGRESS',
          reconciliation_attempt_count =
            command.reconciliation_attempt_count + 1,
          lease_token = v_lease.lease_token, lease_owner = v_worker_key,
          lease_expires_at = v_lease.expires_at, updated_at = v_now
      WHERE command.id = v_candidate.id
      RETURNING * INTO v_command;

      SELECT attempt.id INTO v_attempt_id
      FROM public.network_command_attempts attempt
      WHERE attempt.command_id = v_command.id
      ORDER BY attempt.attempt_no DESC LIMIT 1;
      SELECT coalesce(max(event.event_seq) + 1, 1)
      INTO v_event_seq FROM public.network_command_events event
      WHERE event.command_id = v_command.id;
      INSERT INTO public.network_command_events (
        organization_id, building_id, command_id, attempt_id, event_seq,
        event_kind, occurred_at, worker_id, payload
      ) VALUES (
        v_command.organization_id, v_command.building_id, v_command.id,
        v_attempt_id, v_event_seq, 'RECONCILIATION_STARTED', v_now,
        v_worker_key, jsonb_build_object(
          'leaseExpiresAt', v_command.lease_expires_at,
          'reconciliationAttempt', v_command.reconciliation_attempt_count
        )
      );

      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'commandId', v_command.id,
        'organizationId', v_command.organization_id,
        'buildingId', v_command.building_id,
        'deviceId', v_command.device_id,
        'interfaceId', v_command.interface_id,
        'actionType', v_command.action_type,
        'reason', v_command.reason,
        'parameters', v_command.sanitized_parameters,
        'attemptNo', v_command.attempt_count,
        'leaseToken', v_command.lease_token,
        'leaseExpiresAt', v_command.lease_expires_at,
        'reconciliation', true,
        'reconciliationAttempt', v_command.reconciliation_attempt_count,
        'intentType', v_command.intent_type,
        'managedTarget', v_command.managed_target,
        'preObservation', v_command.pre_observation,
        'expectedPostcondition', v_command.expected_postcondition,
        'observationDeadline', v_command.observation_deadline,
        'transitionVersion', v_command.transition_version,
        'fencingGeneration', v_lease.generation
      ));
      v_claimed := v_claimed + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('items', v_items);
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_worker_claim_v2(
  text, integer, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_claim_v2(
  text, integer, integer
) TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Operator recovery for an UNCERTAIN command.
--
-- Execute-scoped, never worker-reachable: it derives its actor from auth.uid()
-- through app_private.network_center_require_execute_v1, and a worker connection
-- has none. It can only move a command to FAILED - the SUCCEEDED write is still
-- reserved for typed postcondition evaluation by the
-- network_commands_success_authority trigger - and every call lands in the
-- append-only USER audit trail.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.network_center_retire_uncertain_command_v1(
  p_building_id uuid,
  p_command_id uuid,
  p_reason text,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_scope record;
  v_command public.network_commands%ROWTYPE;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_now timestamptz := clock_timestamp();
  v_hash text;
  v_replay jsonb;
  v_attempt_id uuid;
  v_result jsonb;
  v_command_result jsonb;
BEGIN
  IF p_building_id IS NULL OR p_command_id IS NULL OR p_request_id IS NULL
     OR char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'Invalid Network Center retire request'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_scope
  FROM app_private.network_center_require_execute_v1(p_building_id);

  v_hash := encode(extensions.digest(jsonb_build_object(
    'action', 'retire_uncertain_command',
    'buildingId', p_building_id,
    'commandId', p_command_id,
    'reason', v_reason
  )::text, 'sha256'), 'hex');
  v_replay := app_private.network_center_request_replay_v1(
    v_scope.organization_id, v_scope.actor_id, p_request_id, v_hash,
    'retire_uncertain_command'
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  -- The building comes from the caller, but it is never authority: the command
  -- must live in the tenant the guard resolved, and the guard resolved it from
  -- the caller's own permission on that building.
  SELECT command.* INTO v_command
  FROM public.network_commands command
  WHERE command.id = p_command_id
    AND command.organization_id = v_scope.organization_id
    AND command.building_id = p_building_id
    AND command.status = 'UNCERTAIN'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unresolved Network Center command not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.network_device_leases lease
    WHERE lease.device_id = v_command.device_id
      AND lease.expires_at > v_now
  ) THEN
    RAISE EXCEPTION 'Device is leased; retry after the lease expires'
      USING ERRCODE = '55000';
  END IF;

  v_command_result := coalesce(v_command.result, '{}'::jsonb)
    || jsonb_build_object(
      'code', 'OPERATOR_RETIRED_UNCERTAIN',
      'retiredAt', v_now,
      'retiredBy', v_scope.actor_id,
      'retirementReason', v_reason
    );

  SELECT attempt.id INTO v_attempt_id
  FROM public.network_command_attempts attempt
  WHERE attempt.command_id = v_command.id
  ORDER BY attempt.attempt_no DESC
  LIMIT 1;

  UPDATE public.network_command_attempts attempt
  SET outcome = 'PERMANENT_FAILURE',
      retryable = false,
      error_code = 'OPERATOR_RETIRED_UNCERTAIN',
      error_message = left(v_reason, 2000),
      finished_at = v_now
  WHERE attempt.id = v_attempt_id
    AND attempt.finished_at IS NULL;

  INSERT INTO public.network_command_events (
    organization_id, building_id, command_id, attempt_id, event_seq,
    event_kind, occurred_at, actor_id, payload
  ) VALUES (
    v_command.organization_id, v_command.building_id, v_command.id,
    v_attempt_id,
    coalesce((
      SELECT max(event.event_seq) + 1
      FROM public.network_command_events event
      WHERE event.command_id = v_command.id
    ), 1),
    'FAILED', v_now, v_scope.actor_id,
    jsonb_build_object(
      'code', 'OPERATOR_RETIRED_UNCERTAIN',
      'previousStatus', v_command.status,
      'previousReconciliationState', v_command.reconciliation_state
    )
  );

  UPDATE public.network_commands command
  SET status = 'FAILED',
      reconciliation_state = 'UNKNOWN',
      result = v_command_result,
      started_at = coalesce(command.started_at, v_now),
      finished_at = v_now,
      updated_at = v_now
  WHERE command.id = v_command.id;

  v_result := jsonb_build_object(
    'commandId', v_command.id,
    'status', 'FAILED',
    'reconciliationState', 'UNKNOWN',
    'code', 'OPERATOR_RETIRED_UNCERTAIN'
  );
  PERFORM app_private.network_center_append_user_audit_v1(
    v_scope.organization_id, p_building_id, v_scope.actor_id,
    'retire_uncertain_command', 'command', v_command.id,
    jsonb_build_object(
      'buildingName', v_scope.building_name,
      'deviceId', v_command.device_id,
      'actionType', v_command.action_type
    ),
    v_reason,
    jsonb_build_object(
      'permission', 'network_center.execute',
      'previousStatus', v_command.status,
      'previousReconciliationState', v_command.reconciliation_state
    ),
    v_result, 'FAILED', v_command.id, p_request_id, v_hash
  );
  INSERT INTO public.network_outbox_events (
    organization_id, building_id, event_type, aggregate_type, aggregate_id,
    payload, occurred_at
  ) VALUES (
    v_command.organization_id, v_command.building_id,
    'network.command.completed', 'command', v_command.id,
    jsonb_build_object('status', 'FAILED'), v_now
  );
  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_retire_uncertain_command_v1(
  uuid, uuid, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_retire_uncertain_command_v1(
  uuid, uuid, text, uuid
) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Fleet-wide kill switch RPCs.
--
-- Both use the permission-only half of the guard, so the pause can be set and
-- cleared while the fleet is paused. The anchor building is not authority: it is
-- the building the caller proves execute permission on, and the organization is
-- resolved from it server-side.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.network_center_pause_organization_v1(
  p_anchor_building_id uuid,
  p_reason text,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_scope record;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_now timestamptz := clock_timestamp();
  v_hash text;
  v_replay jsonb;
  v_gate public.network_org_mutation_gates%ROWTYPE;
  v_result jsonb;
BEGIN
  IF p_anchor_building_id IS NULL OR p_request_id IS NULL
     OR char_length(v_reason) NOT BETWEEN 8 AND 500 THEN
    RAISE EXCEPTION 'Invalid Network Center organization pause request'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_scope
  FROM app_private.network_center_require_execute_permission_v1(
    p_anchor_building_id
  );

  v_hash := encode(extensions.digest(jsonb_build_object(
    'action', 'pause_organization',
    'buildingId', p_anchor_building_id,
    'reason', v_reason
  )::text, 'sha256'), 'hex');
  v_replay := app_private.network_center_request_replay_v1(
    v_scope.organization_id, v_scope.actor_id, p_request_id, v_hash,
    'pause_organization'
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  INSERT INTO public.network_org_mutation_gates (
    organization_id, mutations_paused, paused_reason, paused_at, paused_by,
    version, updated_at
  ) VALUES (
    v_scope.organization_id, true, v_reason, v_now, v_scope.actor_id, 1, v_now
  )
  ON CONFLICT (organization_id) DO UPDATE SET
    mutations_paused = true,
    paused_reason = EXCLUDED.paused_reason,
    paused_at = EXCLUDED.paused_at,
    paused_by = EXCLUDED.paused_by,
    version = public.network_org_mutation_gates.version + 1,
    updated_at = EXCLUDED.updated_at
  RETURNING * INTO v_gate;

  v_result := jsonb_build_object(
    'organizationId', v_gate.organization_id,
    'mutationsPaused', v_gate.mutations_paused,
    'pausedAt', v_gate.paused_at,
    'version', v_gate.version
  );
  PERFORM app_private.network_center_append_user_audit_v1(
    v_scope.organization_id, p_anchor_building_id, v_scope.actor_id,
    'pause_organization', 'organization', v_scope.organization_id,
    jsonb_build_object('buildingName', v_scope.building_name),
    v_reason,
    jsonb_build_object('permission', 'network_center.execute'),
    v_result, 'SUCCEEDED', NULL, p_request_id, v_hash
  );
  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_pause_organization_v1(
  uuid, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_pause_organization_v1(
  uuid, text, uuid
) TO authenticated;

CREATE OR REPLACE FUNCTION public.network_center_resume_organization_v1(
  p_anchor_building_id uuid,
  p_expected_version bigint,
  p_reason text,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_scope record;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_now timestamptz := clock_timestamp();
  v_hash text;
  v_replay jsonb;
  v_gate public.network_org_mutation_gates%ROWTYPE;
  v_result jsonb;
BEGIN
  IF p_anchor_building_id IS NULL OR p_request_id IS NULL
     OR p_expected_version IS NULL OR p_expected_version < 1
     OR char_length(v_reason) NOT BETWEEN 8 AND 500 THEN
    RAISE EXCEPTION 'Invalid Network Center organization resume request'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_scope
  FROM app_private.network_center_require_execute_permission_v1(
    p_anchor_building_id
  );

  -- Resuming the fleet is the dangerous direction, so it is owner-only. Pausing
  -- deliberately is not: a fail-safe stop must never wait for an owner.
  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_memberships membership
    WHERE membership.organization_id = v_scope.organization_id
      AND membership.user_id = v_scope.actor_id
      AND membership.member_type = 'OWNER'
      AND membership.status = 'ACTIVE'
      AND coalesce(membership.valid_from, '-infinity'::timestamptz) <= v_now
      AND (membership.valid_to IS NULL OR membership.valid_to > v_now)
  ) THEN
    RAISE EXCEPTION 'NETWORK_CENTER_ORG_RESUME_REQUIRES_OWNER'
      USING ERRCODE = '42501';
  END IF;

  v_hash := encode(extensions.digest(jsonb_build_object(
    'action', 'resume_organization',
    'buildingId', p_anchor_building_id,
    'expectedVersion', p_expected_version,
    'reason', v_reason
  )::text, 'sha256'), 'hex');
  v_replay := app_private.network_center_request_replay_v1(
    v_scope.organization_id, v_scope.actor_id, p_request_id, v_hash,
    'resume_organization'
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  SELECT gate.* INTO v_gate
  FROM public.network_org_mutation_gates gate
  WHERE gate.organization_id = v_scope.organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Network Center organization gate not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_gate.version <> p_expected_version THEN
    RAISE EXCEPTION 'Network organization gate changed; reload before resuming'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.network_org_mutation_gates gate
  SET mutations_paused = false,
      paused_reason = NULL,
      paused_at = NULL,
      paused_by = NULL,
      resumed_reason = v_reason,
      resumed_at = v_now,
      resumed_by = v_scope.actor_id,
      version = gate.version + 1,
      updated_at = v_now
  WHERE gate.organization_id = v_scope.organization_id
  RETURNING * INTO v_gate;

  v_result := jsonb_build_object(
    'organizationId', v_gate.organization_id,
    'mutationsPaused', v_gate.mutations_paused,
    'resumedAt', v_gate.resumed_at,
    'version', v_gate.version
  );
  PERFORM app_private.network_center_append_user_audit_v1(
    v_scope.organization_id, p_anchor_building_id, v_scope.actor_id,
    'resume_organization', 'organization', v_scope.organization_id,
    jsonb_build_object('buildingName', v_scope.building_name),
    v_reason,
    jsonb_build_object(
      'permission', 'network_center.execute',
      'requiredMemberType', 'OWNER',
      'expectedVersion', p_expected_version
    ),
    v_result, 'SUCCEEDED', NULL, p_request_id, v_hash
  );
  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_resume_organization_v1(
  uuid, bigint, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_resume_organization_v1(
  uuid, bigint, text, uuid
) TO authenticated;

COMMENT ON TABLE public.network_org_mutation_gates IS
  'Organization-wide Network Center mutation gate; no browser role has direct access and no credential material is stored. Enforced by app_private.network_center_require_execute_v1 and by both worker claim paths.';
COMMENT ON COLUMN public.network_commands.reconciliation_attempt_count IS
  'Bounded reconciliation attempts; past the cap the command waits for the deadline sweeper or an operator instead of re-leasing its device.';
COMMENT ON FUNCTION app_private.network_center_org_mutations_paused_v1(uuid) IS
  'Fail-closed organization mutation gate predicate; an unresolvable tenant counts as paused.';
COMMENT ON FUNCTION
  app_private.network_center_require_execute_permission_v1(uuid) IS
  'Identity and permission half of the execute guard, without the organization gate or rollout state, so the fleet kill switch stays operable while engaged.';
COMMENT ON FUNCTION app_private.network_center_require_execute_v1(uuid) IS
  'Single server-side execute guard: identity, per-building permission, organization mutation gate, then rollout state.';
COMMENT ON FUNCTION
  app_private.network_center_sweep_expired_commands_v1(timestamptz, integer) IS
  'Settles commands whose observation window closed while queued or unresolved into an honest terminal state; an expired UNCERTAIN also opens a critical incident and pauses its building.';
COMMENT ON FUNCTION
  app_private.network_center_pause_building_after_failure_v1(
    public.network_commands, text, text, text, text, jsonb, timestamptz
  ) IS 'Implements design §5 invariant 14: opens a CRITICAL incident and sets changes_paused for the building in the failing transition''s own transaction.';
COMMENT ON FUNCTION public.network_center_retire_uncertain_command_v1(
  uuid, uuid, text, uuid
) IS 'Execute-scoped operator recovery for an UNCERTAIN command; writes the append-only USER audit trail and can only reach FAILED, never SUCCEEDED.';
COMMENT ON FUNCTION public.network_center_pause_organization_v1(
  uuid, text, uuid
) IS 'Fleet-wide Network Center kill switch; execute-scoped and usable while paused.';
COMMENT ON FUNCTION public.network_center_resume_organization_v1(
  uuid, bigint, text, uuid
) IS 'Owner-only CAS resume of the fleet-wide Network Center kill switch.';

COMMIT;

NOTIFY pgrst, 'reload schema';
