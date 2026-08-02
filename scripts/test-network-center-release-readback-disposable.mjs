#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATION_PATH = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260729136000_network_center_worker_release_readback.sql",
);
const OPERATIONAL_SAFETY_MIGRATION_PATH = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260729138000_network_center_operational_safety.sql",
);
export const MIGRATION_PATHS = [
  MIGRATION_PATH,
  OPERATIONAL_SAFETY_MIGRATION_PATH,
];
export const RELEASE_READBACK_INVARIANTS = 22;
export const OPERATIONAL_SAFETY_INVARIANTS = 25;
export const TOTAL_DISPOSABLE_INVARIANTS =
  RELEASE_READBACK_INVARIANTS + OPERATIONAL_SAFETY_INVARIANTS;
const NATIVE_COMMAND_TIMEOUT_MS = 60_000;
const PG_CTL_TIMEOUT_MS = 30_000;
const POSTGRES_VERSION_PROBE_TIMEOUT_MS = 10_000;
const PG_CTL_STDIO = ["ignore", "ignore", "ignore"];
export const DISPOSABLE_PROOF_PROCESS_TIMEOUT_MS =
  (3 * 4 * POSTGRES_VERSION_PROBE_TIMEOUT_MS)
  + (4 * NATIVE_COMMAND_TIMEOUT_MS)
  + (2 * PG_CTL_TIMEOUT_MS)
  + 10_000;

const BOOTSTRAP_SQL = String.raw`
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA app_private;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO service_role;
CREATE TABLE public.network_workers (
  id uuid PRIMARY KEY,
  worker_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL,
  capabilities text[] NOT NULL
);
INSERT INTO public.network_workers VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    'disposable-worker-01',
    'Disposable worker one',
    'ACTIVE',
    ARRAY['HEARTBEAT']::text[]
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'disposable-worker-02',
    'Disposable worker two',
    'ACTIVE',
    ARRAY['HEARTBEAT']::text[]
  );
CREATE TABLE public.network_worker_assignments (
  id uuid PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES public.network_workers(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  device_kind text NOT NULL,
  assignment_version bigint NOT NULL,
  can_poll boolean NOT NULL DEFAULT false,
  can_inventory boolean NOT NULL DEFAULT false,
  can_execute boolean NOT NULL DEFAULT false,
  active_from timestamptz NOT NULL,
  active_until timestamptz
);
INSERT INTO public.network_worker_assignments VALUES
  (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    'MIKROTIK', 1,
    true, false, false, clock_timestamp() - interval '1 day', NULL
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002',
    'MIKROTIK', 7,
    false, true, false, clock_timestamp() - interval '1 day', NULL
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000003',
    '50000000-0000-4000-8000-000000000003',
    'MIKROTIK', 2,
    true, false, false,
    clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day'
  ),
  (
    '30000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000004',
    '50000000-0000-4000-8000-000000000004',
    'MIKROTIK', 1,
    true, false, false, clock_timestamp() - interval '1 day', NULL
  );
CREATE FUNCTION app_private.network_center_authenticate_worker_v2(p_digest text)
RETURNS TABLE(
  worker_id uuid,
  worker_key text,
  worker_status text,
  capabilities text[]
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT worker.id, worker.worker_key, worker.status, worker.capabilities
  FROM public.network_workers worker
  WHERE worker.worker_key = CASE p_digest
    WHEN 'digest-worker-01' THEN 'disposable-worker-01'
    WHEN 'digest-worker-02' THEN 'disposable-worker-02'
  END
$fn$;
CREATE FUNCTION public.network_center_worker_heartbeat_v2(
  p_credential_digest text,
  p_worker_version text,
  p_capabilities text[],
  p_status text,
  p_queue_age_seconds integer,
  p_safe_metadata jsonb,
  p_started_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_assigned_building_count integer;
BEGIN
  IF p_started_at IS NULL OR p_started_at > clock_timestamp() THEN
    RAISE EXCEPTION 'invalid heartbeat' USING ERRCODE = '22023';
  END IF;
  SELECT authenticated.worker_id
  INTO v_worker_id
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  SELECT count(DISTINCT assignment.building_id)::integer
  INTO v_assigned_building_count
  FROM public.network_worker_assignments assignment
  WHERE assignment.worker_id = v_worker_id
    AND assignment.active_from <= clock_timestamp()
    AND (
      assignment.active_until IS NULL
      OR assignment.active_until > clock_timestamp()
    )
    AND (
      assignment.can_poll OR assignment.can_inventory OR assignment.can_execute
    );
  RETURN jsonb_build_object(
    'status', upper(p_status),
    'heartbeatAt', clock_timestamp(),
    'assignedBuildingCount', v_assigned_building_count
  );
END
$fn$;
REVOKE ALL ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) TO service_role;
`;

// Faithful subset of the Network Center command plane that
// 20260729138000_network_center_operational_safety.sql builds on. Table shapes,
// CHECK constraints and tenant-scoped foreign keys are copied from the shipped
// migrations, as are the command guard triggers and the completion sink, so the
// migration under test runs against the same constraint surface it will meet in
// production instead of a permissive stand-in.
const OPERATIONAL_SAFETY_BOOTSTRAP_SQL = String.raw`
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql
STABLE
AS $fn$
  SELECT nullif(current_setting('app.disposable_actor', true), '')::uuid
$fn$;

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE public.buildings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  name text NOT NULL,
  deleted_at timestamptz,
  is_virtual boolean NOT NULL DEFAULT false,
  UNIQUE (organization_id, id)
);

CREATE TABLE public.organization_memberships (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL,
  member_type text NOT NULL
    CHECK (member_type IN ('OWNER', 'STAFF', 'SHAREHOLDER', 'PARTNER', 'SERVICE')),
  status text NOT NULL,
  valid_from timestamptz,
  valid_to timestamptz
);

CREATE FUNCTION public.can_do_on_building(
  _table text, _action text, _building_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.buildings building
    JOIN public.organization_memberships membership
      ON membership.organization_id = building.organization_id
     AND membership.user_id = (SELECT auth.uid())
     AND membership.status = 'ACTIVE'
    WHERE building.id = _building_id
      AND building.deleted_at IS NULL
      AND _table = 'network_center'
      AND _action IN ('view', 'execute')
  )
$fn$;

CREATE TABLE public.network_devices (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_kind text NOT NULL CHECK (device_kind IN ('MIKROTIK', 'ARUBA')),
  display_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT network_devices_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id),
  UNIQUE (organization_id, building_id, id)
);

CREATE TABLE public.network_managed_resources (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  resource_kind text NOT NULL
    CHECK (resource_kind IN ('ROUTER', 'INTERFACE', 'MANAGED_USER')),
  stable_key text NOT NULL,
  display_name text NOT NULL,
  enrolled_role text,
  protected boolean NOT NULL DEFAULT true,
  ownership_marker text,
  enrollment_state text NOT NULL DEFAULT 'DISCOVERED'
    CHECK (enrollment_state IN ('DISCOVERED', 'ENROLLED', 'REVOKED')),
  last_verified_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT network_managed_resources_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id),
  UNIQUE (device_id, resource_kind, stable_key),
  UNIQUE (organization_id, building_id, device_id, id)
);

CREATE TABLE public.network_interfaces (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  interface_key text NOT NULL,
  display_name text NOT NULL,
  interface_kind text NOT NULL,
  interface_role text NOT NULL,
  is_protected boolean NOT NULL DEFAULT true,
  is_managed boolean NOT NULL DEFAULT false,
  is_enabled boolean NOT NULL DEFAULT true,
  managed_resource_id uuid,
  display_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT network_interfaces_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id),
  CONSTRAINT network_interfaces_managed_resource_fk
    FOREIGN KEY (organization_id, building_id, device_id, managed_resource_id)
    REFERENCES public.network_managed_resources(
      organization_id, building_id, device_id, id
    ),
  UNIQUE (organization_id, building_id, device_id, id)
);

CREATE TABLE public.network_site_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  building_id uuid NOT NULL,
  monitoring_enabled boolean NOT NULL DEFAULT true,
  changes_paused boolean NOT NULL DEFAULT false,
  poll_interval_seconds integer NOT NULL DEFAULT 60,
  rollout_state text NOT NULL DEFAULT 'OFF'
    CHECK (rollout_state IN ('OFF', 'READ_ONLY', 'EXECUTE')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT network_site_settings_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id),
  UNIQUE (organization_id, building_id)
);

CREATE TABLE public.network_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  interface_id uuid,
  action_type text NOT NULL,
  reason text NOT NULL,
  sanitized_parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_display jsonb NOT NULL,
  requested_by uuid NOT NULL,
  request_hash text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  priority smallint NOT NULL DEFAULT 50,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  result jsonb,
  rollback jsonb,
  reconciliation_state text NOT NULL DEFAULT 'NONE',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  managed_target jsonb,
  intent_type text,
  pre_observation jsonb,
  expected_postcondition jsonb,
  observation_deadline timestamptz,
  transition_version bigint NOT NULL DEFAULT 1,
  CONSTRAINT network_commands_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id),
  CONSTRAINT network_commands_interface_fk
    FOREIGN KEY (organization_id, building_id, device_id, interface_id)
    REFERENCES public.network_interfaces(
      organization_id, building_id, device_id, id
    ),
  CONSTRAINT network_commands_action_check
    CHECK (action_type IN (
      'FLUSH_DNS_CACHE', 'RENEW_DHCP_LEASE', 'CYCLE_ACCESS_PORT',
      'REBOOT_ROUTER', 'CAPTURE_SNAPSHOT'
    )),
  CONSTRAINT network_commands_interface_target_check
    CHECK ((action_type = 'CYCLE_ACCESS_PORT') = (interface_id IS NOT NULL)),
  CONSTRAINT network_commands_status_check
    CHECK (status IN (
      'QUEUED', 'LEASED', 'RUNNING', 'RETRY_WAIT', 'UNCERTAIN', 'RECONCILING',
      'SUCCEEDED', 'FAILED', 'CANCELLED_BY_KILL_SWITCH'
    )),
  CONSTRAINT network_commands_attempt_check
    CHECK (
      attempt_count BETWEEN 0 AND max_attempts
      AND max_attempts BETWEEN 1 AND 10
    ),
  CONSTRAINT network_commands_lease_check
    CHECK (
      (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (
        lease_token IS NOT NULL AND lease_owner IS NOT NULL
        AND lease_expires_at IS NOT NULL
      )
    ),
  CONSTRAINT network_commands_active_lease_check
    CHECK (
      (lease_token IS NOT NULL)
      = (status IN ('LEASED', 'RUNNING', 'RECONCILING'))
    ),
  CONSTRAINT network_commands_result_check
    CHECK (
      result IS NULL
      OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536)
    ),
  CONSTRAINT network_commands_reconciliation_check
    CHECK (reconciliation_state IN (
      'NONE', 'REQUIRED', 'IN_PROGRESS', 'CONFIRMED', 'FAILED', 'UNKNOWN'
    )),
  CONSTRAINT network_commands_finish_check
    CHECK (
      (status IN ('SUCCEEDED', 'FAILED', 'CANCELLED_BY_KILL_SWITCH'))
        = (finished_at IS NOT NULL)
      AND (started_at IS NULL OR started_at >= created_at)
      AND (
        finished_at IS NULL
        OR (started_at IS NOT NULL AND finished_at >= started_at)
      )
    ),
  CONSTRAINT network_commands_typed_intent_check
    CHECK (
      intent_type = action_type
      AND jsonb_typeof(managed_target) = 'object'
      AND jsonb_typeof(expected_postcondition) = 'object'
      AND observation_deadline >= created_at
      AND transition_version > 0
    ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, building_id, id)
);

CREATE TABLE public.network_command_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  command_id uuid NOT NULL,
  device_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  worker_id text NOT NULL
    CHECK (worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  lease_token uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'STARTED'
    CHECK (outcome IN (
      'STARTED', 'SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE',
      'UNCERTAIN', 'ABANDONED'
    )),
  retryable boolean,
  error_code text,
  error_message text,
  result jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  CONSTRAINT network_command_attempts_command_fk
    FOREIGN KEY (organization_id, building_id, command_id)
    REFERENCES public.network_commands(organization_id, building_id, id),
  UNIQUE (organization_id, building_id, id)
);

CREATE TABLE public.network_command_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  command_id uuid NOT NULL,
  attempt_id uuid,
  event_seq bigint NOT NULL CHECK (event_seq > 0),
  event_kind text NOT NULL CHECK (event_kind IN (
    'QUEUED', 'LEASED', 'VALIDATED', 'BACKUP_STARTED', 'BACKUP_COMPLETED',
    'EXECUTION_STARTED', 'EXECUTION_COMPLETED', 'POST_CHECK_STARTED',
    'POST_CHECK_COMPLETED', 'RETRY_SCHEDULED', 'RECONCILIATION_STARTED',
    'RECONCILIATION_COMPLETED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN',
    'CANCELLED_BY_KILL_SWITCH'
  )),
  occurred_at timestamptz NOT NULL,
  actor_id uuid,
  worker_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT network_command_events_command_fk
    FOREIGN KEY (organization_id, building_id, command_id)
    REFERENCES public.network_commands(organization_id, building_id, id),
  CONSTRAINT network_command_events_attempt_fk
    FOREIGN KEY (organization_id, building_id, attempt_id)
    REFERENCES public.network_command_attempts(organization_id, building_id, id),
  CONSTRAINT network_command_events_actor_check
    CHECK (actor_id IS NOT NULL OR worker_id IS NOT NULL),
  CONSTRAINT network_command_events_worker_check
    CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  UNIQUE (command_id, event_seq)
);

CREATE TABLE public.network_command_observations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  command_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  device_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  lease_token uuid NOT NULL,
  fencing_generation bigint NOT NULL CHECK (fencing_generation > 0),
  transition_version_before bigint NOT NULL CHECK (transition_version_before > 0),
  observation_kind text NOT NULL CHECK (
    observation_kind IN ('PRE_ACTION', 'POST_ACTION', 'RECONCILIATION')
  ),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_hash character(64) NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  worker_id text NOT NULL
    CHECK (worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  CONSTRAINT network_command_observations_scope_fk
    FOREIGN KEY (organization_id, building_id, command_id)
    REFERENCES public.network_commands(organization_id, building_id, id),
  CONSTRAINT network_command_observations_attempt_fk
    FOREIGN KEY (organization_id, building_id, attempt_id)
    REFERENCES public.network_command_attempts(organization_id, building_id, id),
  UNIQUE (command_id, id)
);

CREATE TABLE public.network_device_leases (
  device_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  command_id uuid NOT NULL,
  lease_token uuid NOT NULL,
  lease_owner text NOT NULL
    CHECK (lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  acquired_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  CONSTRAINT network_device_leases_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id),
  CONSTRAINT network_device_leases_command_fk
    FOREIGN KEY (organization_id, building_id, command_id)
    REFERENCES public.network_commands(organization_id, building_id, id),
  CONSTRAINT network_device_leases_time_check
    CHECK (acquired_at <= heartbeat_at AND heartbeat_at < expires_at),
  UNIQUE (organization_id, building_id, device_id)
);

CREATE TABLE public.network_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  interface_id uuid,
  fingerprint text NOT NULL
    CHECK (char_length(btrim(fingerprint)) BETWEEN 8 AND 200),
  incident_type text NOT NULL CHECK (incident_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  severity text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RECOVERING', 'RESOLVED')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 200),
  summary text NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 3 AND 2000),
  availability_impact boolean NOT NULL DEFAULT false,
  opened_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  recovered_at timestamptz,
  resolved_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  observed_values jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (
      jsonb_typeof(observed_values) = 'object'
      AND octet_length(observed_values::text) <= 16384
    ),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_incidents_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id),
  CONSTRAINT network_incidents_time_check
    CHECK (opened_at <= last_observed_at),
  CONSTRAINT network_incidents_resolution_check
    CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL)),
  UNIQUE (organization_id, building_id, id)
);

CREATE UNIQUE INDEX network_incidents_one_active_fingerprint_uidx
  ON public.network_incidents (organization_id, building_id, fingerprint)
  WHERE status <> 'RESOLVED';

CREATE TABLE public.network_incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  event_seq bigint NOT NULL CHECK (event_seq > 0),
  event_kind text NOT NULL CHECK (event_kind IN (
    'OPENED', 'OBSERVED', 'ESCALATED', 'ACKNOWLEDGED', 'RECOVERED', 'RESOLVED'
  )),
  severity text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  occurred_at timestamptz NOT NULL,
  actor_id uuid,
  worker_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT network_incident_events_incident_fk
    FOREIGN KEY (organization_id, building_id, incident_id)
    REFERENCES public.network_incidents(organization_id, building_id, id),
  CONSTRAINT network_incident_events_actor_check
    CHECK (actor_id IS NOT NULL OR worker_id IS NOT NULL),
  UNIQUE (incident_id, event_seq)
);

CREATE TABLE public.network_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('USER', 'WORKER', 'SYSTEM')),
  actor_id uuid,
  worker_id text,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  target_type text NOT NULL CHECK (target_type ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  target_id uuid,
  target_display jsonb NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text NOT NULL CHECK (outcome IN (
    'ACCEPTED', 'REJECTED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN', 'OBSERVED'
  )),
  command_id uuid,
  request_id uuid,
  request_hash text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_audit_events_actor_check
    CHECK (
      (actor_type = 'USER' AND actor_id IS NOT NULL AND worker_id IS NULL)
      OR (actor_type = 'WORKER' AND actor_id IS NULL AND worker_id IS NOT NULL)
      OR (actor_type = 'SYSTEM' AND actor_id IS NULL AND worker_id IS NULL)
    ),
  CONSTRAINT network_audit_events_command_fk
    FOREIGN KEY (organization_id, building_id, command_id)
    REFERENCES public.network_commands(organization_id, building_id, id)
);

CREATE TABLE public.network_outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE public.network_config_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  command_id uuid,
  content_hash character(64) NOT NULL,
  encrypted_artifact_hash character(64)
);

-- Copied verbatim from 20260729132000: only typed SQL postcondition evaluation
-- may write SUCCEEDED, and the typed intent fields are frozen after insert.
CREATE FUNCTION app_private.network_center_guard_command_success_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_transition_authority text := current_setting(
    'app.network_center_transition_authority', true
  );
  v_success_authority text := current_setting(
    'app.network_center_success_authority', true
  );
BEGIN
  IF ROW(
    NEW.managed_target, NEW.intent_type,
    NEW.expected_postcondition, NEW.observation_deadline
  ) IS DISTINCT FROM ROW(
    OLD.managed_target, OLD.intent_type,
    OLD.expected_postcondition, OLD.observation_deadline
  ) THEN
    RAISE EXCEPTION 'Typed command intent fields cannot change'
      USING ERRCODE = '55000';
  END IF;
  IF (
    NEW.pre_observation IS DISTINCT FROM OLD.pre_observation
    OR NEW.transition_version IS DISTINCT FROM OLD.transition_version
  ) AND v_transition_authority IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'Command observation state requires fenced SQL transition'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'SUCCEEDED'
     AND OLD.status IS DISTINCT FROM 'SUCCEEDED'
     AND v_success_authority IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'Only typed SQL postcondition evaluation may write SUCCEEDED'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER network_commands_success_authority
  BEFORE UPDATE ON public.network_commands
  FOR EACH ROW EXECUTE FUNCTION
    app_private.network_center_guard_command_success_v1();

-- Copied from 20260729132000 so managed_target / expected_postcondition /
-- observation_deadline are derived by the real trigger rather than seeded.
CREATE FUNCTION app_private.network_center_guard_managed_command_target_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_resource public.network_managed_resources%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.pre_observation := NULL;
    NEW.transition_version := 1;
  END IF;
  NEW.intent_type := NEW.action_type;
  NEW.managed_target := jsonb_strip_nulls(jsonb_build_object(
    'deviceId', NEW.device_id,
    'interfaceId', NEW.interface_id
  ));
  NEW.expected_postcondition := CASE NEW.action_type
    WHEN 'FLUSH_DNS_CACHE' THEN jsonb_build_object('kind', 'DNS_COMMAND_ACK')
    WHEN 'RENEW_DHCP_LEASE' THEN jsonb_build_object(
      'kind', 'DHCP_BOUND_LEASE_NEWER_EXPIRY',
      'notApplicableCode', 'DHCP_RENEW_NOT_APPLICABLE'
    )
    WHEN 'CYCLE_ACCESS_PORT' THEN jsonb_build_object(
      'kind', 'IMMUTABLE_ACCESS_INTERFACE_CYCLE'
    )
    WHEN 'REBOOT_ROUTER' THEN jsonb_build_object(
      'kind', 'NEW_BOOT_IDENTITY_AND_UPTIME'
    )
    ELSE jsonb_build_object(
      'kind', 'REDACTED_AND_ENCRYPTED_SNAPSHOT_HASHES'
    )
  END;
  NEW.observation_deadline := coalesce(NEW.observation_deadline, NEW.created_at +
    CASE NEW.action_type
      WHEN 'REBOOT_ROUTER' THEN INTERVAL '10 minutes'
      WHEN 'CYCLE_ACCESS_PORT' THEN INTERVAL '3 minutes'
      WHEN 'CAPTURE_SNAPSHOT' THEN INTERVAL '10 minutes'
      ELSE INTERVAL '2 minutes'
    END
  );

  IF NEW.action_type <> 'CYCLE_ACCESS_PORT' THEN RETURN NEW; END IF;

  SELECT resource.* INTO v_resource
    FROM public.network_interfaces interface
    JOIN public.network_managed_resources resource
      ON resource.organization_id = interface.organization_id
     AND resource.building_id = interface.building_id
     AND resource.device_id = interface.device_id
     AND resource.id = interface.managed_resource_id
    WHERE interface.organization_id = NEW.organization_id
      AND interface.building_id = NEW.building_id
      AND interface.device_id = NEW.device_id
      AND interface.id = NEW.interface_id
      AND interface.is_managed
      AND interface.is_enabled
      AND interface.interface_kind = 'ETHERNET'
      AND interface.interface_role = 'ACCESS'
      AND interface.is_protected = false
      AND resource.resource_kind = 'INTERFACE'
      AND resource.stable_key = interface.interface_key
      AND resource.enrollment_state = 'ENROLLED'
      AND resource.enrolled_role = 'ACCESS'
      AND resource.protected = false
    FOR KEY SHARE OF resource
  ;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Managed access interface is required'
      USING ERRCODE = '42501';
  END IF;
  NEW.managed_target := NEW.managed_target || jsonb_build_object(
    'managedResourceId', v_resource.id,
    'immutableKey', v_resource.stable_key
  );
  NEW.expected_postcondition := NEW.expected_postcondition || jsonb_build_object(
    'managedResourceId', v_resource.id,
    'immutableKey', v_resource.stable_key
  );
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER network_commands_managed_target_guard
  BEFORE INSERT OR UPDATE OF
    organization_id, building_id, device_id, interface_id, action_type
  ON public.network_commands
  FOR EACH ROW EXECUTE FUNCTION
    app_private.network_center_guard_managed_command_target_v1();

CREATE FUNCTION app_private.network_center_assert_safe_json_v1(
  p_value jsonb,
  p_context text DEFAULT 'Network Center payload',
  p_depth integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  RETURN;
END;
$fn$;

CREATE FUNCTION app_private.network_center_reclaim_expired_commands_v1(
  p_now timestamptz
)
RETURNS integer
LANGUAGE sql
SET search_path TO 'pg_catalog'
AS $fn$ SELECT 0 $fn$;

CREATE FUNCTION app_private.network_center_reclaim_expired_commands_v2(
  p_worker_id uuid,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS integer
LANGUAGE sql
SET search_path TO 'pg_catalog'
AS $fn$ SELECT 0 $fn$;

-- Copied verbatim from 20260729040000.
CREATE FUNCTION app_private.network_center_request_replay_v1(
  p_organization_id uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_request_hash text,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_existing public.network_audit_events%ROWTYPE;
BEGIN
  SELECT audit.* INTO v_existing
  FROM public.network_audit_events audit
  WHERE audit.organization_id = p_organization_id
    AND audit.actor_type = 'USER'
    AND audit.actor_id = p_actor_id
    AND audit.request_id = p_request_id
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_existing.action IS DISTINCT FROM p_action
     OR v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'Idempotency key reused with different Network Center input'
      USING ERRCODE = '23505';
  END IF;
  RETURN v_existing.result;
END;
$fn$;

-- Copied verbatim from 20260729040000.
CREATE FUNCTION app_private.network_center_append_user_audit_v1(
  p_organization_id uuid,
  p_building_id uuid,
  p_actor_id uuid,
  p_action text,
  p_target_type text,
  p_target_id uuid,
  p_target_display jsonb,
  p_reason text,
  p_validation jsonb,
  p_result jsonb,
  p_outcome text,
  p_command_id uuid,
  p_request_id uuid,
  p_request_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.network_audit_events (
    organization_id, building_id, actor_type, actor_id, action, target_type,
    target_id, target_display, reason, validation, result, outcome, command_id,
    request_id, request_hash
  ) VALUES (
    p_organization_id, p_building_id, 'USER', p_actor_id, p_action,
    p_target_type, p_target_id, p_target_display, p_reason,
    coalesce(p_validation, '{}'::jsonb), coalesce(p_result, '{}'::jsonb),
    p_outcome, p_command_id, p_request_id, p_request_hash
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$fn$;

-- Copied verbatim from 20260729135000: the authoritative completion sink and the
-- fail-closed legacy entry point the fenced transition calls into.
CREATE FUNCTION app_private.network_center_complete_command_internal_v2(
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
     OR p_retry_delay_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'Invalid command completion' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_assert_safe_json_v1(
    v_result, 'command result'
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
        finished_at = v_now
    WHERE id = v_attempt_id;
  END IF;

  SELECT coalesce(max(event.event_seq) + 1, 1)
  INTO v_seq
  FROM public.network_command_events event
  WHERE event.command_id = p_command_id;
  INSERT INTO public.network_command_events (
    organization_id, building_id, command_id, attempt_id, event_seq,
    event_kind, occurred_at, worker_id, payload
  ) VALUES (
    v_command.organization_id, v_command.building_id, p_command_id,
    v_attempt_id, v_seq, v_event, v_now, p_worker_id,
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
    organization_id, building_id, actor_type, worker_id, action, target_type,
    target_id, target_display, reason, validation, result, outcome, command_id
  ) VALUES (
    v_command.organization_id, v_command.building_id, 'WORKER', p_worker_id,
    lower(v_command.action_type), 'device', v_command.device_id,
    v_command.target_display, v_command.reason,
    jsonb_build_object('attemptCount', v_command.attempt_count), v_response,
    CASE v_status
      WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
      WHEN 'UNCERTAIN' THEN 'UNCERTAIN'
      ELSE 'FAILED'
    END,
    p_command_id
  );
  INSERT INTO public.network_outbox_events (
    organization_id, building_id, event_type, aggregate_type, aggregate_id,
    payload, occurred_at
  ) VALUES (
    v_command.organization_id, v_command.building_id,
    'network.command.completed', 'command', p_command_id,
    jsonb_build_object('status', v_status), v_now
  );
  RETURN v_response;
END;
$fn$;

CREATE FUNCTION public.network_center_worker_complete_v1(
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
    p_worker_id, p_command_id, p_lease_token, p_outcome, p_result,
    p_rollback, p_retry_delay_seconds
  );
END;
$fn$;

-- A third worker that actually carries EXECUTE, without disturbing the two
-- HEARTBEAT-only workers the release readback proof depends on.
INSERT INTO public.network_workers VALUES (
  '10000000-0000-4000-8000-00000000000e',
  'disposable-worker-exec',
  'Disposable execute worker',
  'ACTIVE',
  ARRAY['HEARTBEAT', 'EXECUTE']::text[]
);

CREATE OR REPLACE FUNCTION app_private.network_center_authenticate_worker_v2(
  p_digest text
)
RETURNS TABLE(
  worker_id uuid,
  worker_key text,
  worker_status text,
  capabilities text[]
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT worker.id, worker.worker_key, worker.status, worker.capabilities
  FROM public.network_workers worker
  WHERE worker.worker_key = CASE p_digest
    WHEN 'digest-worker-01' THEN 'disposable-worker-01'
    WHEN 'digest-worker-02' THEN 'disposable-worker-02'
    WHEN 'digest-worker-exec' THEN 'disposable-worker-exec'
  END
$fn$;

INSERT INTO public.organizations VALUES
  ('40000000-0000-4000-8000-0000000000aa', 'Disposable org A'),
  ('40000000-0000-4000-8000-0000000000bb', 'Disposable org B');

INSERT INTO public.buildings (id, organization_id, name) VALUES
  ('20000000-0000-4000-8000-0000000000a1',
   '40000000-0000-4000-8000-0000000000aa', 'A1 primary'),
  ('20000000-0000-4000-8000-0000000000a2',
   '40000000-0000-4000-8000-0000000000aa', 'A2 postcheck'),
  ('20000000-0000-4000-8000-0000000000a3',
   '40000000-0000-4000-8000-0000000000aa', 'A3 expiry'),
  ('20000000-0000-4000-8000-0000000000a4',
   '40000000-0000-4000-8000-0000000000aa', 'A4 not applicable'),
  ('20000000-0000-4000-8000-0000000000a5',
   '40000000-0000-4000-8000-0000000000aa', 'A5 transport'),
  ('20000000-0000-4000-8000-0000000000b1',
   '40000000-0000-4000-8000-0000000000bb', 'B1 other tenant');

INSERT INTO public.organization_memberships (
  id, organization_id, user_id, member_type, status
) VALUES
  ('90000000-0000-4000-8000-00000000000a',
   '40000000-0000-4000-8000-0000000000aa',
   '60000000-0000-4000-8000-00000000000a', 'OWNER', 'ACTIVE'),
  ('90000000-0000-4000-8000-00000000005a',
   '40000000-0000-4000-8000-0000000000aa',
   '60000000-0000-4000-8000-00000000005a', 'STAFF', 'ACTIVE'),
  ('90000000-0000-4000-8000-00000000000b',
   '40000000-0000-4000-8000-0000000000bb',
   '60000000-0000-4000-8000-00000000000b', 'OWNER', 'ACTIVE');

INSERT INTO public.network_site_settings (
  organization_id, building_id, rollout_state
)
SELECT building.organization_id, building.id, 'EXECUTE'
FROM public.buildings building;

INSERT INTO public.network_devices (
  id, organization_id, building_id, device_kind, display_name
) VALUES
  ('50000000-0000-4000-8000-0000000000d1',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a1', 'MIKROTIK', 'expired queue router'),
  ('50000000-0000-4000-8000-0000000000d2',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a1', 'MIKROTIK', 'live queue router'),
  ('50000000-0000-4000-8000-0000000000d3',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a1', 'MIKROTIK', 'reconcile cap router'),
  ('50000000-0000-4000-8000-0000000000d4',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a3', 'MIKROTIK', 'stuck uncertain router'),
  ('50000000-0000-4000-8000-0000000000d5',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a1', 'MIKROTIK', 'operator retire router'),
  ('50000000-0000-4000-8000-0000000000d6',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a1', 'MIKROTIK', 'port cycle router'),
  ('50000000-0000-4000-8000-0000000000d7',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a2', 'MIKROTIK', 'postcheck router'),
  ('50000000-0000-4000-8000-0000000000d8',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a1', 'MIKROTIK', 'kill switch router'),
  ('50000000-0000-4000-8000-0000000000d9',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a4', 'MIKROTIK', 'dhcp router'),
  ('50000000-0000-4000-8000-0000000000da',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a5', 'MIKROTIK', 'transport router'),
  ('50000000-0000-4000-8000-0000000000db',
   '40000000-0000-4000-8000-0000000000bb',
   '20000000-0000-4000-8000-0000000000b1', 'MIKROTIK', 'other tenant router');

INSERT INTO public.network_managed_resources (
  id, organization_id, building_id, device_id, resource_kind, stable_key,
  display_name, enrolled_role, protected, ownership_marker, enrollment_state,
  last_verified_at
) VALUES (
  '80000000-0000-4000-8000-0000000000e2',
  '40000000-0000-4000-8000-0000000000aa',
  '20000000-0000-4000-8000-0000000000a1',
  '50000000-0000-4000-8000-0000000000d6',
  'INTERFACE', 'ether2', 'ether2', 'ACCESS', false,
  'routeros-default-name', 'ENROLLED', clock_timestamp()
);

INSERT INTO public.network_interfaces (
  id, organization_id, building_id, device_id, interface_key, display_name,
  interface_kind, interface_role, is_protected, is_managed, is_enabled,
  managed_resource_id
) VALUES (
  '70000000-0000-4000-8000-0000000000e2',
  '40000000-0000-4000-8000-0000000000aa',
  '20000000-0000-4000-8000-0000000000a1',
  '50000000-0000-4000-8000-0000000000d6',
  'ether2', 'ether2', 'ETHERNET', 'ACCESS', false, true, true,
  '80000000-0000-4000-8000-0000000000e2'
);

INSERT INTO public.network_worker_assignments (
  id, worker_id, organization_id, building_id, device_id, device_kind,
  assignment_version, can_poll, can_inventory, can_execute, active_from
)
SELECT
  ('a0000000-0000-4000-8000-' || lpad(to_hex(4096 + row_number() OVER (
    ORDER BY device.id
  )), 12, '0'))::uuid,
  '10000000-0000-4000-8000-00000000000e',
  device.organization_id, device.building_id, device.id, 'MIKROTIK', 1,
  true, true, true, clock_timestamp() - interval '1 day'
FROM public.network_devices device;
`;

const ASSERTION_SQL = String.raw`
SET ROLE service_role;
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-01', repeat('a', 40), ARRAY['polling'], 'PAUSED', 0,
  jsonb_build_object(
    'connections', 2,
    'successfulPolls', 2,
    'failedPolls', 0
  ),
  clock_timestamp() - interval '1 minute'
);
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-01', repeat('b', 40), ARRAY['polling'], 'PAUSED', 0,
  jsonb_build_object(
    'connections', 2,
    'successfulPolls', 1,
    'failedPolls', 1
  ),
  clock_timestamp() - interval '1 minute'
);
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-01', repeat('a', 40), ARRAY['polling'], 'PAUSED', 0,
  jsonb_build_object('source', 'periodic'),
  clock_timestamp() - interval '1 minute'
);
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-02', repeat('a', 40), ARRAY['polling'], 'ONLINE', 0,
  jsonb_build_object(
    'connections', 1,
    'successfulPolls', 1,
    'failedPolls', 0
  ),
  clock_timestamp() - interval '1 minute'
);
SELECT public.network_center_admin_release_status_v1(100);
RESET ROLE;
DO $keyed_readback$
DECLARE
  v_release_a jsonb;
  v_release_b jsonb;
  v_missing_release_status jsonb;
  v_other_worker_release_status jsonb;
  v_expected_assignment_hash text;
  v_previous_assignment_hash text;
  v_mutated_release_status jsonb;
BEGIN
  v_release_a := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-01', repeat('a', 40)
  );
  v_release_b := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-01', repeat('b', 40)
  );
  v_missing_release_status := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-01', repeat('f', 40)
  );
  v_other_worker_release_status := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-02', repeat('a', 40)
  );
  SELECT encode(extensions.digest(convert_to(string_agg(
    concat_ws(
      '|',
      'network-worker-assignment-v1',
      assignment.id::text,
      assignment.worker_id::text,
      assignment.organization_id::text,
      assignment.building_id::text,
      assignment.device_id::text,
      assignment.device_kind,
      assignment.assignment_version::text,
      CASE WHEN assignment.can_poll THEN '1' ELSE '0' END,
      CASE WHEN assignment.can_inventory THEN '1' ELSE '0' END,
      CASE WHEN assignment.can_execute THEN '1' ELSE '0' END,
      to_char(
        assignment.active_from AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      coalesce(to_char(
        assignment.active_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ), '-')
    ),
    E'\n' ORDER BY concat_ws(
      '|',
      'network-worker-assignment-v1',
      assignment.id::text,
      assignment.worker_id::text,
      assignment.organization_id::text,
      assignment.building_id::text,
      assignment.device_id::text,
      assignment.device_kind,
      assignment.assignment_version::text,
      CASE WHEN assignment.can_poll THEN '1' ELSE '0' END,
      CASE WHEN assignment.can_inventory THEN '1' ELSE '0' END,
      CASE WHEN assignment.can_execute THEN '1' ELSE '0' END,
      to_char(
        assignment.active_from AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      coalesce(to_char(
        assignment.active_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ), '-')
    ) COLLATE "C"
  ), 'UTF8'), 'sha256'), 'hex')
  INTO v_expected_assignment_hash
  FROM public.network_worker_assignments assignment
  WHERE assignment.worker_id = '10000000-0000-4000-8000-000000000001'
    AND assignment.active_from <= statement_timestamp()
    AND (assignment.active_until IS NULL OR assignment.active_until > statement_timestamp())
    AND (assignment.can_poll OR assignment.can_inventory OR assignment.can_execute);
  IF v_release_a IS NULL
     OR (v_release_a->>'schemaVersion')::integer <> 1
     OR v_release_a->>'workerKey' <> 'disposable-worker-01'
     OR v_release_a->>'workerVersion' <> repeat('a', 40) THEN
    RAISE EXCEPTION 'exact keyed release positive readback failed';
  END IF;
  IF (v_release_a->>'assignedBuildingCount')::integer <> 1
     OR (v_release_a->>'activeAssignedBuildingCount')::integer <> 1
     OR (v_release_a->>'activeAssignmentCount')::integer <> 2
     OR v_release_a->>'activeAssignmentHash' <> v_expected_assignment_hash THEN
    RAISE EXCEPTION 'two active assignment rows for one building were not preserved';
  END IF;

  v_previous_assignment_hash := v_release_a->>'activeAssignmentHash';

  -- A same-building device swap changes the full-row digest, not either count.
  UPDATE public.network_worker_assignments assignment
  SET device_id = '50000000-0000-4000-8000-000000000005'
  WHERE assignment.id = '30000000-0000-4000-8000-000000000001';
  v_mutated_release_status := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-01', repeat('a', 40)
  );
  IF (v_mutated_release_status->>'activeAssignedBuildingCount')::integer <> 1
     OR (v_mutated_release_status->>'activeAssignmentCount')::integer <> 2
     OR v_mutated_release_status->>'activeAssignmentHash' = v_previous_assignment_hash THEN
    RAISE EXCEPTION 'same-building device swap was not detected';
  END IF;
  v_previous_assignment_hash := v_mutated_release_status->>'activeAssignmentHash';

  -- A capability change is part of canonical assignment identity.
  UPDATE public.network_worker_assignments assignment
  SET can_inventory = false,
      can_execute = true
  WHERE assignment.id = '30000000-0000-4000-8000-000000000002';
  v_mutated_release_status := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-01', repeat('a', 40)
  );
  IF (v_mutated_release_status->>'activeAssignedBuildingCount')::integer <> 1
     OR (v_mutated_release_status->>'activeAssignmentCount')::integer <> 2
     OR v_mutated_release_status->>'activeAssignmentHash' = v_previous_assignment_hash THEN
    RAISE EXCEPTION 'capability change was not detected';
  END IF;
  v_previous_assignment_hash := v_mutated_release_status->>'activeAssignmentHash';

  -- An assignment ID/version/window change is also digest-visible while active.
  UPDATE public.network_worker_assignments assignment
  SET id = '30000000-0000-4000-8000-000000000005',
      assignment_version = assignment.assignment_version + 1,
      active_from = clock_timestamp() - interval '2 hours',
      active_until = clock_timestamp() + interval '1 day'
  WHERE assignment.id = '30000000-0000-4000-8000-000000000002';
  v_mutated_release_status := public.network_center_admin_worker_release_status_v1(
    'disposable-worker-01', repeat('a', 40)
  );
  IF (v_mutated_release_status->>'activeAssignedBuildingCount')::integer <> 1
     OR (v_mutated_release_status->>'activeAssignmentCount')::integer <> 2
     OR v_mutated_release_status->>'activeAssignmentHash' = v_previous_assignment_hash THEN
    RAISE EXCEPTION 'assignment ID/version/window change was not detected';
  END IF;
  IF (v_release_a->>'successfulPollCount')::integer <> 2
     OR (v_release_b->>'successfulPollCount')::integer <> 1
     OR (v_release_b->>'failedPollCount')::integer <> 1 THEN
    RAISE EXCEPTION 'exact release-version isolation failed';
  END IF;
  IF v_other_worker_release_status->>'workerKey' <> 'disposable-worker-02'
     OR (v_other_worker_release_status->>'activeAssignedBuildingCount')::integer <> 1
     OR (v_other_worker_release_status->>'activeAssignmentCount')::integer <> 1
     OR v_other_worker_release_status->>'activeAssignmentHash' = v_expected_assignment_hash THEN
    RAISE EXCEPTION 'exact worker isolation failed';
  END IF;
  IF v_missing_release_status IS NOT NULL THEN
    RAISE EXCEPTION 'missing exact release did not return SQL NULL';
  END IF;
END
$keyed_readback$;
SET ROLE service_role;
DO $deny$
DECLARE
  v_denied boolean := false;
BEGIN
  BEGIN
    PERFORM count(*)
    FROM app_private.network_worker_release_heartbeats;
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'direct private-table read was allowed';
  END IF;
END
$deny$;
RESET ROLE;
DO $assertions$
DECLARE
  v_status jsonb;
BEGIN
  IF (SELECT count(*) FROM app_private.network_worker_release_heartbeats) <> 3 THEN
    RAISE EXCEPTION 'version-keyed rows missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_version = repeat('a', 40)
      AND heartbeat.connection_count = 2
      AND heartbeat.successful_poll_count = 2
      AND heartbeat.failed_poll_count = 0
      AND heartbeat.poll_observed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'periodic heartbeat erased successful poll evidence';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_version = repeat('b', 40)
      AND heartbeat.connection_count = 2
      AND heartbeat.successful_poll_count = 1
      AND heartbeat.failed_poll_count = 1
  ) THEN
    RAISE EXCEPTION 'failed poll evidence missing';
  END IF;
  v_status := public.network_center_admin_release_status_v1(100);
  IF jsonb_array_length(v_status->'releaseHeartbeats') <> 3 THEN
    RAISE EXCEPTION 'release status row count mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_status->'releaseHeartbeats') item
    WHERE NOT (item ?& ARRAY[
      'workerKey', 'workerVersion', 'status', 'connectionCount',
      'successfulPollCount', 'failedPollCount', 'pollObservedAt'
    ])
      OR item ?| ARRAY['credentialDigest', 'safeMetadata', 'secretDigest']
  ) THEN
    RAISE EXCEPTION 'release status shape is unsafe';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.network_center_admin_release_status_v1(integer)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.network_center_admin_release_status_v1(integer)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.network_center_admin_release_status_v1(integer)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.network_center_admin_worker_release_status_v1(text,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.network_center_admin_worker_release_status_v1(text,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.network_center_admin_worker_release_status_v1(text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'release status ACL mismatch';
  END IF;
  BEGIN
    PERFORM public.network_center_worker_heartbeat_v2(
      'digest-worker-01', repeat('c', 40), ARRAY['polling'], 'PAUSED', 0,
      jsonb_build_object('connections', 1, 'successfulPolls', 1),
      clock_timestamp() - interval '1 minute'
    );
    RAISE EXCEPTION 'partial poll evidence was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
END
$assertions$;
DO $null_poll_evidence$
DECLARE
  v_worker_id uuid := '10000000-0000-4000-8000-000000000001';
  v_before_poll_observed_at timestamptz;
  v_after_poll_observed_at timestamptz;
  v_rejected boolean;
BEGIN
  SELECT heartbeat.poll_observed_at
  INTO v_before_poll_observed_at
  FROM app_private.network_worker_release_heartbeats heartbeat
  WHERE heartbeat.worker_id = v_worker_id
    AND heartbeat.worker_version = repeat('a', 40);
  IF v_before_poll_observed_at IS NULL THEN
    RAISE EXCEPTION 'null poll evidence proof needs a genuine poll baseline';
  END IF;

  -- JSON null satisfies both ?| and ?&, casts to SQL NULL without raising, and
  -- makes the range guard evaluate to NULL instead of TRUE, so poll_observed_at
  -- is stamped as if fresh evidence had been supplied. Unguarded, only the
  -- all-or-nothing storage CHECK stops the write, and it raises an opaque 23514
  -- from inside the INSERT instead of the documented 22023. Require the guard
  -- itself to fail closed.
  v_rejected := false;
  BEGIN
    PERFORM public.network_center_worker_heartbeat_v2(
      'digest-worker-01', repeat('a', 40), ARRAY['polling'], 'PAUSED', 0,
      jsonb_build_object(
        'connections', NULL, 'successfulPolls', NULL, 'failedPolls', NULL
      ),
      clock_timestamp() - interval '1 minute'
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'JSON null poll evidence was accepted on an existing release';
  END IF;

  SELECT heartbeat.poll_observed_at
  INTO v_after_poll_observed_at
  FROM app_private.network_worker_release_heartbeats heartbeat
  WHERE heartbeat.worker_id = v_worker_id
    AND heartbeat.worker_version = repeat('a', 40)
    AND heartbeat.connection_count = 2
    AND heartbeat.successful_poll_count = 2
    AND heartbeat.failed_poll_count = 0;
  IF v_after_poll_observed_at IS DISTINCT FROM v_before_poll_observed_at THEN
    RAISE EXCEPTION 'rejected null poll heartbeat refreshed poll freshness';
  END IF;

  -- On a first-seen release the all-or-nothing table CHECK would raise 23514,
  -- which is neither the documented error nor a guarantee once any column
  -- default changes. Require the explicit fail-closed 22023 and no row.
  v_rejected := false;
  BEGIN
    PERFORM public.network_center_worker_heartbeat_v2(
      'digest-worker-01', repeat('d', 40), ARRAY['polling'], 'PAUSED', 0,
      jsonb_build_object(
        'connections', NULL, 'successfulPolls', NULL, 'failedPolls', NULL
      ),
      clock_timestamp() - interval '1 minute'
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'JSON null poll evidence was accepted on a fresh release';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = v_worker_id
      AND heartbeat.worker_version = repeat('d', 40)
  ) THEN
    RAISE EXCEPTION 'a rejected null poll heartbeat still wrote a release row';
  END IF;

  v_rejected := false;
  BEGIN
    PERFORM public.network_center_worker_heartbeat_v2(
      'digest-worker-01', repeat('a', 40), ARRAY['polling'], 'PAUSED', 0,
      jsonb_build_object(
        'connections', 2, 'successfulPolls', NULL, 'failedPolls', 0
      ),
      clock_timestamp() - interval '1 minute'
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'a single JSON null poll count was accepted';
  END IF;
END
$null_poll_evidence$;
-- Release 'b' was superseded by 'a', so its heartbeat_at froze at the promotion
-- instant. The host still holds its image and still names it as previous;
-- rollback-vultr.ps1 reads it back by sha (Get-ReleaseStatus, no missing-row
-- tolerance) and refuses the rollback when the row is gone.
UPDATE app_private.network_worker_release_heartbeats heartbeat
SET started_at = statement_timestamp() - interval '46 days',
    heartbeat_at = statement_timestamp() - interval '45 days',
    poll_observed_at = statement_timestamp() - interval '45 days',
    updated_at = statement_timestamp() - interval '45 days'
WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000001'
  AND heartbeat.worker_version = repeat('b', 40);
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-01', repeat('a', 40), ARRAY['polling'], 'PAUSED', 0,
  jsonb_build_object('connections', 2, 'successfulPolls', 2, 'failedPolls', 0),
  clock_timestamp() - interval '1 minute'
);
DO $reachable_rollback_target_retained$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000001'
      AND heartbeat.worker_version = repeat('b', 40)
  ) THEN
    RAISE EXCEPTION 'retention expired a still-reachable rollback target';
  END IF;
END
$reachable_rollback_target_retained$;
-- Displace 'b' beyond the reachable rollback depth with five newer-but-also-
-- expired releases so age-based collection still has something to reclaim.
INSERT INTO app_private.network_worker_release_heartbeats (
  worker_id, worker_version, status, heartbeat_at, started_at,
  assigned_building_count, updated_at
)
SELECT '10000000-0000-4000-8000-000000000001',
  repeat(filler.version_digit, 40),
  'PAUSED',
  clock_timestamp() - interval '31 days'
    - (filler.ordinal * interval '1 minute'),
  clock_timestamp() - interval '40 days',
  1,
  clock_timestamp() - interval '31 days'
FROM (VALUES ('0', 0), ('1', 1), ('2', 2), ('3', 3), ('4', 4))
  AS filler(version_digit, ordinal);
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-01', repeat('a', 40), ARRAY['polling'], 'PAUSED', 0,
  jsonb_build_object('connections', 2, 'successfulPolls', 2, 'failedPolls', 0),
  clock_timestamp() - interval '1 minute'
);
DO $displaced_release_collected$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000001'
      AND heartbeat.worker_version IN (repeat('b', 40), repeat('4', 40))
  ) THEN
    RAISE EXCEPTION 'expired releases beyond the reachable depth were not collected';
  END IF;
  IF (
    SELECT count(*)
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000001'
  ) <> 5 THEN
    RAISE EXCEPTION 'reachable rollback window is not exactly bounded';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000002'
      AND heartbeat.worker_version = repeat('a', 40)
  ) THEN
    RAISE EXCEPTION 'age-based collection deleted another worker''s release row';
  END IF;
END
$displaced_release_collected$;
-- Fresh releases never age out, so the per-worker hard cap is their only bound.
INSERT INTO app_private.network_worker_release_heartbeats (
  worker_id, worker_version, status, heartbeat_at, started_at,
  assigned_building_count, updated_at
)
SELECT '10000000-0000-4000-8000-000000000002',
  lpad(to_hex(4096 + series.ordinal), 40, '0'),
  'PAUSED',
  clock_timestamp() - (series.ordinal * interval '1 minute'),
  clock_timestamp() - interval '2 hours',
  1,
  clock_timestamp()
FROM generate_series(1, 24) AS series(ordinal);
SELECT public.network_center_worker_heartbeat_v2(
  'digest-worker-02', repeat('a', 40), ARRAY['polling'], 'ONLINE', 0,
  jsonb_build_object('connections', 1, 'successfulPolls', 1, 'failedPolls', 0),
  clock_timestamp() - interval '1 minute'
);
DO $fresh_release_growth_bounded$
BEGIN
  IF (
    SELECT count(*)
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000002'
  ) <> 20 THEN
    RAISE EXCEPTION 'fresh release growth is not bounded by the per-worker cap';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000002'
      AND heartbeat.worker_version = repeat('a', 40)
  ) THEN
    RAISE EXCEPTION 'the live release was evicted by the per-worker cap';
  END IF;
  IF (
    SELECT count(*)
    FROM app_private.network_worker_release_heartbeats heartbeat
    WHERE heartbeat.worker_id = '10000000-0000-4000-8000-000000000001'
  ) <> 5 THEN
    RAISE EXCEPTION 'another worker''s cap eviction changed the reachable window';
  END IF;
END
$fresh_release_growth_bounded$;
SELECT jsonb_build_object(
  'status', 'PASS',
  'invariants', 22
) AS disposable_release_proof;
`;

const OPERATIONAL_SAFETY_ASSERTION_SQL = String.raw`
-- =============================================================================
-- Item 1: a doomed command is never dispatched, and the sweeper settles it.
-- =============================================================================
INSERT INTO public.network_commands (
  id, organization_id, building_id, device_id, action_type, reason,
  target_display, requested_by, request_hash, idempotency_key, status,
  created_at, observation_deadline
) VALUES
  ('c0000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a1',
   '50000000-0000-4000-8000-0000000000d1',
   'FLUSH_DNS_CACHE', 'window closed while queued', '{}'::jsonb,
   '60000000-0000-4000-8000-00000000000a', repeat('a', 64),
   'disposable-expired-0001', 'QUEUED',
   clock_timestamp() - interval '10 minutes',
   clock_timestamp() - interval '8 minutes'),
  ('c0000000-0000-4000-8000-000000000002',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a1',
   '50000000-0000-4000-8000-0000000000d2',
   'FLUSH_DNS_CACHE', 'still inside its window', '{}'::jsonb,
   '60000000-0000-4000-8000-00000000000a', repeat('b', 64),
   'disposable-live-0002', 'QUEUED',
   clock_timestamp(), clock_timestamp() + interval '2 minutes');

DO $item1_deadline_and_sweeper$
DECLARE
  c_expired constant uuid := 'c0000000-0000-4000-8000-000000000001';
  c_live constant uuid := 'c0000000-0000-4000-8000-000000000002';
  v_claim jsonb;
  v_claimed uuid[];
  v_command public.network_commands%ROWTYPE;
BEGIN
  v_claim := public.network_center_worker_claim_v2('digest-worker-exec', 5, 90);
  SELECT coalesce(array_agg((item->>'commandId')::uuid), '{}'::uuid[])
  INTO v_claimed
  FROM jsonb_array_elements(v_claim->'items') item;

  -- 1. The already-doomed command is never leased; the live one still is.
  IF c_expired = ANY(v_claimed) THEN
    RAISE EXCEPTION 'a command past its observation deadline was still claimed';
  END IF;
  IF NOT (c_live = ANY(v_claimed)) THEN
    RAISE EXCEPTION 'the deadline predicate also blocked a healthy command';
  END IF;

  SELECT command.* INTO v_command
  FROM public.network_commands command WHERE command.id = c_expired;
  -- 2. It is settled honestly: FAILED, never UNCERTAIN (an unresolved
  --    UNCERTAIN would wedge every later command for that device).
  IF v_command.status <> 'FAILED'
     OR v_command.reconciliation_state <> 'NONE'
     OR v_command.finished_at IS NULL
     OR v_command.started_at IS NULL
     OR v_command.result->>'code'
       <> 'OBSERVATION_DEADLINE_EXPIRED_BEFORE_DISPATCH' THEN
    RAISE EXCEPTION 'expired queued command was not settled honestly: % / %',
      v_command.status, v_command.result;
  END IF;

  -- 3. The sweep is evidenced in the append-only command log and audit trail.
  IF NOT EXISTS (
    SELECT 1 FROM public.network_command_events event
    WHERE event.command_id = c_expired
      AND event.event_kind = 'FAILED'
      AND event.worker_id = 'network-center:deadline-sweeper'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.network_audit_events audit
    WHERE audit.command_id = c_expired
      AND audit.actor_type = 'SYSTEM'
      AND audit.action = 'system.expire_command'
      AND audit.outcome = 'FAILED'
  ) THEN
    RAISE EXCEPTION 'expiry sweep left no durable evidence';
  END IF;

  -- 4. Nothing was dispatched, so nothing is unknown: no building is paused.
  IF EXISTS (
    SELECT 1 FROM public.network_site_settings settings
    WHERE settings.building_id = '20000000-0000-4000-8000-0000000000a1'
      AND settings.changes_paused
  ) THEN
    RAISE EXCEPTION 'a never-dispatched expiry paused its building';
  END IF;
END
$item1_deadline_and_sweeper$;

INSERT INTO public.network_commands (
  id, organization_id, building_id, device_id, action_type, reason,
  target_display, requested_by, request_hash, idempotency_key, status,
  created_at, observation_deadline
) VALUES (
  'c0000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-0000000000aa',
  '20000000-0000-4000-8000-0000000000a1',
  '50000000-0000-4000-8000-0000000000d3',
  'FLUSH_DNS_CACHE', 'legacy claim helper expiry', '{}'::jsonb,
  '60000000-0000-4000-8000-00000000000a', repeat('c', 64),
  'disposable-legacy-0003', 'QUEUED',
  clock_timestamp() - interval '10 minutes',
  clock_timestamp() - interval '9 minutes'
);

DO $item1_legacy_claim_helper$
DECLARE
  c_legacy constant uuid := 'c0000000-0000-4000-8000-000000000003';
  v_rows integer;
BEGIN
  -- 5. The private legacy claim helper carries the same predicate, so re-wiring
  --    it can never reintroduce the hole.
  SELECT count(*) INTO v_rows
  FROM app_private.network_center_claim_commands_v1(
    'disposable-worker-exec', 5, 90
  ) claim
  WHERE claim.command_id = c_legacy;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'the legacy claim helper leased a doomed command';
  END IF;
  IF (
    SELECT command.status FROM public.network_commands command
    WHERE command.id = c_legacy
  ) <> 'FAILED' THEN
    RAISE EXCEPTION 'the legacy claim helper did not sweep the doomed command';
  END IF;
END
$item1_legacy_claim_helper$;

-- =============================================================================
-- Item 2: bounded reconciliation, automatic retirement, operator recovery.
-- =============================================================================
INSERT INTO public.network_commands (
  id, organization_id, building_id, device_id, action_type, reason,
  target_display, requested_by, request_hash, idempotency_key, status,
  reconciliation_state, attempt_count, started_at, created_at,
  observation_deadline
) VALUES (
  'c0000000-0000-4000-8000-000000000010',
  '40000000-0000-4000-8000-0000000000aa',
  '20000000-0000-4000-8000-0000000000a1',
  '50000000-0000-4000-8000-0000000000d3',
  'FLUSH_DNS_CACHE', 'unresolved and reconcilable', '{}'::jsonb,
  '60000000-0000-4000-8000-00000000000a', repeat('d', 64),
  'disposable-uncertain-0010', 'UNCERTAIN', 'REQUIRED', 1,
  clock_timestamp() - interval '50 seconds', clock_timestamp() - interval '1 minute',
  clock_timestamp() + interval '30 minutes'
);

DO $item2_reconciliation_cap$
DECLARE
  c_uncertain constant uuid := 'c0000000-0000-4000-8000-000000000010';
  v_claim jsonb;
  v_attempts integer[] := '{}'::integer[];
  v_claimed boolean;
  v_claims boolean[] := '{}'::boolean[];
  v_round integer;
BEGIN
  FOR v_round IN 1..4 LOOP
    v_claim := public.network_center_worker_claim_v2('digest-worker-exec', 5, 90);
    SELECT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_claim->'items') item
      WHERE (item->>'commandId')::uuid = c_uncertain
        AND (item->>'reconciliation')::boolean
    ) INTO v_claimed;
    v_claims := v_claims || v_claimed;
    v_attempts := v_attempts || (
      SELECT command.reconciliation_attempt_count
      FROM public.network_commands command WHERE command.id = c_uncertain
    );
    -- Simulate a reconciliation attempt that once again proves nothing.
    DELETE FROM public.network_device_leases lease
    WHERE lease.command_id = c_uncertain;
    UPDATE public.network_commands command
    SET status = 'UNCERTAIN', reconciliation_state = 'REQUIRED',
        lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
        updated_at = clock_timestamp()
    WHERE command.id = c_uncertain AND command.status = 'RECONCILING';
  END LOOP;

  -- 6. Reconciliation is bounded: three attempts, then the loop stops.
  IF v_claims <> ARRAY[true, true, true, false]
     OR v_attempts <> ARRAY[1, 2, 3, 3] THEN
    RAISE EXCEPTION 'reconciliation attempts were not bounded: % / %',
      v_claims, v_attempts;
  END IF;
END
$item2_reconciliation_cap$;

INSERT INTO public.network_commands (
  id, organization_id, building_id, device_id, action_type, reason,
  target_display, requested_by, request_hash, idempotency_key, status,
  reconciliation_state, attempt_count, started_at, created_at,
  observation_deadline
) VALUES
  ('c0000000-0000-4000-8000-000000000020',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a3',
   '50000000-0000-4000-8000-0000000000d4',
   'FLUSH_DNS_CACHE', 'unresolved past its window', '{}'::jsonb,
   '60000000-0000-4000-8000-00000000000a', repeat('e', 64),
   'disposable-stuck-0020', 'UNCERTAIN', 'REQUIRED', 1,
   clock_timestamp() - interval '14 minutes',
   clock_timestamp() - interval '15 minutes',
   clock_timestamp() - interval '5 minutes');

INSERT INTO public.network_commands (
  id, organization_id, building_id, device_id, action_type, reason,
  target_display, requested_by, request_hash, idempotency_key, status,
  created_at, observation_deadline
) VALUES (
  'c0000000-0000-4000-8000-000000000021',
  '40000000-0000-4000-8000-0000000000aa',
  '20000000-0000-4000-8000-0000000000a3',
  '50000000-0000-4000-8000-0000000000d4',
  'REBOOT_ROUTER', 'recovery reboot blocked by the wedge', '{}'::jsonb,
  '60000000-0000-4000-8000-00000000000a', repeat('f', 64),
  'disposable-reboot-0021', 'QUEUED',
  clock_timestamp(), clock_timestamp() + interval '10 minutes'
);

DO $item2_expired_uncertain$
DECLARE
  c_stuck constant uuid := 'c0000000-0000-4000-8000-000000000020';
  c_reboot constant uuid := 'c0000000-0000-4000-8000-000000000021';
  c_building constant uuid := '20000000-0000-4000-8000-0000000000a3';
  v_claim jsonb;
  v_command public.network_commands%ROWTYPE;
BEGIN
  v_claim := public.network_center_worker_claim_v2('digest-worker-exec', 5, 90);

  SELECT command.* INTO v_command
  FROM public.network_commands command WHERE command.id = c_stuck;
  -- 7. Past the deadline reconciliation can never succeed, so it is retired
  --    automatically - and to a terminal state, not back to UNCERTAIN.
  IF v_command.status <> 'FAILED'
     OR v_command.reconciliation_state <> 'UNKNOWN'
     OR v_command.result->>'code' <> 'RECONCILIATION_WINDOW_EXPIRED' THEN
    RAISE EXCEPTION 'expired UNCERTAIN was not retired: % / % / %',
      v_command.status, v_command.reconciliation_state, v_command.result;
  END IF;

  -- 8. The router state is genuinely unknown, so the building is paused and a
  --    critical incident is opened rather than silently released.
  IF NOT EXISTS (
    SELECT 1 FROM public.network_site_settings settings
    WHERE settings.building_id = c_building AND settings.changes_paused
  ) OR NOT EXISTS (
    SELECT 1 FROM public.network_incidents incident
    WHERE incident.building_id = c_building
      AND incident.device_id = '50000000-0000-4000-8000-0000000000d4'
      AND incident.incident_type = 'RECONCILIATION_WINDOW_EXPIRED'
      AND incident.severity = 'CRITICAL'
      AND incident.status = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'expired UNCERTAIN retirement did not fail closed';
  END IF;
  IF (
    SELECT command.status FROM public.network_commands command
    WHERE command.id = c_reboot
  ) <> 'QUEUED' THEN
    RAISE EXCEPTION 'a paused building still admitted a new action';
  END IF;

  -- 9. Once an operator resumes the building the device is provably unwedged:
  --    the REBOOT the UNCERTAIN used to block is now claimable.
  UPDATE public.network_site_settings settings
  SET changes_paused = false, version = settings.version + 1
  WHERE settings.building_id = c_building;
  v_claim := public.network_center_worker_claim_v2('digest-worker-exec', 5, 90);
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_claim->'items') item
    WHERE (item->>'commandId')::uuid = c_reboot
  ) THEN
    RAISE EXCEPTION 'the device stayed wedged after the UNCERTAIN was retired';
  END IF;
END
$item2_expired_uncertain$;

INSERT INTO public.network_commands (
  id, organization_id, building_id, device_id, action_type, reason,
  target_display, requested_by, request_hash, idempotency_key, status,
  reconciliation_state, attempt_count, started_at, created_at,
  observation_deadline
) VALUES (
  'c0000000-0000-4000-8000-000000000030',
  '40000000-0000-4000-8000-0000000000aa',
  '20000000-0000-4000-8000-0000000000a1',
  '50000000-0000-4000-8000-0000000000d5',
  'FLUSH_DNS_CACHE', 'operator retires this by hand', '{}'::jsonb,
  '60000000-0000-4000-8000-00000000000a', repeat('1', 64),
  'disposable-operator-0030', 'UNCERTAIN', 'REQUIRED', 1,
  clock_timestamp() - interval '50 seconds', clock_timestamp() - interval '1 minute',
  clock_timestamp() + interval '30 minutes'
);

DO $item2_operator_retire$
DECLARE
  c_command constant uuid := 'c0000000-0000-4000-8000-000000000030';
  c_building constant uuid := '20000000-0000-4000-8000-0000000000a1';
  c_owner constant uuid := '60000000-0000-4000-8000-00000000000a';
  c_other_owner constant uuid := '60000000-0000-4000-8000-00000000000b';
  c_request constant uuid := 'f0000000-0000-4000-8000-000000000030';
  v_first jsonb;
  v_replay jsonb;
  v_command public.network_commands%ROWTYPE;
  v_audit_rows integer;
  v_denied text;
BEGIN
  PERFORM set_config('app.disposable_actor', c_owner::text, true);
  v_first := public.network_center_retire_uncertain_command_v1(
    c_building, c_command, 'Router verified healthy by hand', c_request
  );

  SELECT command.* INTO v_command
  FROM public.network_commands command WHERE command.id = c_command;
  -- 10. The command reaches a terminal state and the USER audit trail records
  --     who retired it and why.
  IF v_first->>'status' <> 'FAILED'
     OR v_command.status <> 'FAILED'
     OR v_command.reconciliation_state <> 'UNKNOWN'
     OR v_command.result->>'code' <> 'OPERATOR_RETIRED_UNCERTAIN'
     OR NOT EXISTS (
       SELECT 1 FROM public.network_audit_events audit
       WHERE audit.command_id = c_command
         AND audit.actor_type = 'USER'
         AND audit.actor_id = c_owner
         AND audit.action = 'retire_uncertain_command'
         AND audit.reason = 'Router verified healthy by hand'
     ) THEN
    RAISE EXCEPTION 'operator retirement was not audited: % / %',
      v_command.status, v_command.result;
  END IF;

  -- 11. Replaying the same request is idempotent and does not double-audit.
  SELECT count(*) INTO v_audit_rows
  FROM public.network_audit_events audit
  WHERE audit.request_id = c_request;
  v_replay := public.network_center_retire_uncertain_command_v1(
    c_building, c_command, 'Router verified healthy by hand', c_request
  );
  IF v_replay IS DISTINCT FROM v_first
     OR v_audit_rows <> 1
     OR (
       SELECT count(*) FROM public.network_audit_events audit
       WHERE audit.request_id = c_request
     ) <> 1 THEN
    RAISE EXCEPTION 'operator retirement is not replay safe';
  END IF;

  -- 12. A worker credential can never reach it: no EXECUTE for the worker role
  --     and no user principal means the shared guard refuses outright.
  IF has_function_privilege(
       'service_role',
       'public.network_center_retire_uncertain_command_v1(uuid,uuid,text,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.network_center_retire_uncertain_command_v1(uuid,uuid,text,uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.network_center_retire_uncertain_command_v1(uuid,uuid,text,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'operator retirement ACL is worker reachable';
  END IF;
  PERFORM set_config('app.disposable_actor', '', true);
  v_denied := NULL;
  BEGIN
    PERFORM public.network_center_retire_uncertain_command_v1(
      c_building, c_command, 'Worker principal attempt', gen_random_uuid()
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := SQLERRM;
  END;
  IF v_denied IS NULL THEN
    RAISE EXCEPTION 'a principal without a user identity retired a command';
  END IF;

  -- 13. Another tenant's owner cannot reach into this organization.
  PERFORM set_config('app.disposable_actor', c_other_owner::text, true);
  v_denied := NULL;
  BEGIN
    PERFORM public.network_center_retire_uncertain_command_v1(
      c_building, c_command, 'Cross tenant attempt', gen_random_uuid()
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := SQLERRM;
  END;
  IF v_denied IS NULL THEN
    RAISE EXCEPTION 'a foreign tenant retired a command';
  END IF;
  PERFORM set_config('app.disposable_actor', '', true);
END
$item2_operator_retire$;

-- =============================================================================
-- Item 3: cross-host reconciliation evidence for CYCLE_ACCESS_PORT.
-- =============================================================================
INSERT INTO public.network_commands (
  id, organization_id, building_id, device_id, interface_id, action_type,
  reason, target_display, requested_by, request_hash, idempotency_key, status,
  reconciliation_state, attempt_count, started_at, created_at,
  observation_deadline
) VALUES
  ('c0000000-0000-4000-8000-000000000040',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a1',
   '50000000-0000-4000-8000-0000000000d6',
   '70000000-0000-4000-8000-0000000000e2',
   'CYCLE_ACCESS_PORT', 'cycle with recorded disable evidence', '{}'::jsonb,
   '60000000-0000-4000-8000-00000000000a', repeat('2', 64),
   'disposable-cycle-0040', 'UNCERTAIN', 'NONE', 1,
   clock_timestamp() - interval '50 seconds', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '60 minutes'),
  ('c0000000-0000-4000-8000-000000000041',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a1',
   '50000000-0000-4000-8000-0000000000d6',
   '70000000-0000-4000-8000-0000000000e2',
   'CYCLE_ACCESS_PORT', 'cycle without any recorded evidence', '{}'::jsonb,
   '60000000-0000-4000-8000-00000000000a', repeat('3', 64),
   'disposable-cycle-0041', 'UNCERTAIN', 'NONE', 1,
   clock_timestamp() - interval '50 seconds', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '60 minutes');

INSERT INTO public.network_command_attempts (
  id, organization_id, building_id, command_id, device_id, attempt_no,
  worker_id, lease_token, outcome, started_at
) VALUES (
  'b0000000-0000-4000-8000-000000000040',
  '40000000-0000-4000-8000-0000000000aa',
  '20000000-0000-4000-8000-0000000000a1',
  'c0000000-0000-4000-8000-000000000040',
  '50000000-0000-4000-8000-0000000000d6', 1,
  'disposable-worker-exec', 'e0000000-0000-4000-8000-000000000040',
  'UNCERTAIN', clock_timestamp() - interval '1 minute'
);

INSERT INTO public.network_command_observations (
  id, organization_id, building_id, command_id, attempt_id, device_id,
  attempt_no, lease_token, fencing_generation, transition_version_before,
  observation_kind, evidence, evidence_hash, observed_at, worker_id
) VALUES (
  'd0000000-0000-4000-8000-000000000040',
  '40000000-0000-4000-8000-0000000000aa',
  '20000000-0000-4000-8000-0000000000a1',
  'c0000000-0000-4000-8000-000000000040',
  'b0000000-0000-4000-8000-000000000040',
  '50000000-0000-4000-8000-0000000000d6', 1,
  'e0000000-0000-4000-8000-000000000040', 1, 1, 'POST_ACTION',
  jsonb_build_object('accessInterface', jsonb_build_object(
    'managedResourceId', '80000000-0000-4000-8000-0000000000e2',
    'immutableKey', 'ether2',
    'disabledObserved', true
  )),
  encode(extensions.digest('disposable-cycle-post-action', 'sha256'), 'hex'),
  clock_timestamp() - interval '40 seconds', 'disposable-worker-exec'
);

DO $item3_cross_host_evidence$
DECLARE
  c_with_evidence constant uuid := 'c0000000-0000-4000-8000-000000000040';
  c_without_evidence constant uuid := 'c0000000-0000-4000-8000-000000000041';
  c_resource constant text := '80000000-0000-4000-8000-0000000000e2';
  v_command public.network_commands%ROWTYPE;
  v_other public.network_commands%ROWTYPE;
  v_before jsonb;
  v_decision jsonb;
BEGIN
  SELECT command.* INTO v_command
  FROM public.network_commands command WHERE command.id = c_with_evidence;
  SELECT command.* INTO v_other
  FROM public.network_commands command WHERE command.id = c_without_evidence;
  IF v_command.managed_target->>'managedResourceId' <> c_resource THEN
    RAISE EXCEPTION 'managed target was not derived by the real guard';
  END IF;
  v_before := jsonb_build_object(
    'observedAt', clock_timestamp() - interval '50 seconds'
  );

  -- 14. A different host cannot re-observe the disable half, but an earlier
  --     attempt's recorded POST_ACTION disable on this command and resource is
  --     durable evidence of the same fact.
  v_decision := app_private.network_center_evaluate_postcondition_v1(
    v_command, v_before,
    jsonb_build_object(
      'observedAt', clock_timestamp(),
      'accessInterface', jsonb_build_object(
        'managedResourceId', c_resource, 'immutableKey', 'ether2',
        'enabledObserved', true, 'enabled', true
      )
    )
  );
  IF v_decision->>'outcome' <> 'SUCCEEDED'
     OR v_decision->>'disabledObservedSource' <> 'RECORDED_POST_ACTION' THEN
    RAISE EXCEPTION 'recorded disable evidence was not accepted: %', v_decision;
  END IF;

  -- 15. The live "enabled" readback is still mandatory: a recorded disable can
  --     never on its own manufacture SUCCEEDED.
  v_decision := app_private.network_center_evaluate_postcondition_v1(
    v_command, v_before,
    jsonb_build_object(
      'observedAt', clock_timestamp(),
      'accessInterface', jsonb_build_object(
        'managedResourceId', c_resource, 'immutableKey', 'ether2',
        'enabledObserved', true, 'enabled', false
      )
    )
  );
  IF v_decision->>'outcome' <> 'UNCERTAIN' THEN
    RAISE EXCEPTION 'a recorded disable manufactured SUCCEEDED: %', v_decision;
  END IF;
  v_decision := app_private.network_center_evaluate_postcondition_v1(
    v_command, v_before,
    jsonb_build_object(
      'observedAt', clock_timestamp(),
      'accessInterface', jsonb_build_object(
        'managedResourceId', c_resource, 'immutableKey', 'ether2',
        'enabled', true
      )
    )
  );
  IF v_decision->>'outcome' <> 'UNCERTAIN' THEN
    RAISE EXCEPTION 'a missing live enabledObserved still succeeded: %',
      v_decision;
  END IF;

  -- 16. Recorded evidence never leaks between commands, even on the same
  --     device and the same managed resource.
  v_decision := app_private.network_center_evaluate_postcondition_v1(
    v_other, v_before,
    jsonb_build_object(
      'observedAt', clock_timestamp(),
      'accessInterface', jsonb_build_object(
        'managedResourceId', c_resource, 'immutableKey', 'ether2',
        'enabledObserved', true, 'enabled', true
      )
    )
  );
  IF v_decision->>'outcome' <> 'UNCERTAIN' THEN
    RAISE EXCEPTION 'recorded evidence leaked to another command: %', v_decision;
  END IF;

  -- 17. The live single-host path is unchanged and still reports its source.
  v_decision := app_private.network_center_evaluate_postcondition_v1(
    v_other, v_before,
    jsonb_build_object(
      'observedAt', clock_timestamp(),
      'accessInterface', jsonb_build_object(
        'managedResourceId', c_resource, 'immutableKey', 'ether2',
        'disabledObserved', true, 'enabledObserved', true, 'enabled', true
      )
    )
  );
  IF v_decision->>'outcome' <> 'SUCCEEDED'
     OR v_decision->>'disabledObservedSource' <> 'LIVE' THEN
    RAISE EXCEPTION 'the live disable path regressed: %', v_decision;
  END IF;
END
$item3_cross_host_evidence$;

-- =============================================================================
-- Item 4: a failed post-check opens a critical incident AND pauses its building.
-- =============================================================================
INSERT INTO public.network_commands (
  id, organization_id, building_id, device_id, action_type, reason,
  target_display, requested_by, request_hash, idempotency_key, status,
  reconciliation_state, attempt_count, max_attempts, lease_token, lease_owner,
  lease_expires_at, started_at, created_at, observation_deadline
) VALUES
  ('c0000000-0000-4000-8000-000000000050',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a2',
   '50000000-0000-4000-8000-0000000000d7',
   'REBOOT_ROUTER', 'reconciliation concludes the reboot failed', '{}'::jsonb,
   '60000000-0000-4000-8000-00000000000a', repeat('4', 64),
   'disposable-postcheck-0050', 'RECONCILING', 'IN_PROGRESS', 1, 1,
   'e0000000-0000-4000-8000-000000000050', 'disposable-worker-exec',
   clock_timestamp() + interval '5 minutes',
   clock_timestamp() - interval '2 minutes',
   clock_timestamp() - interval '3 minutes',
   clock_timestamp() + interval '8 minutes'),
  ('c0000000-0000-4000-8000-000000000060',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a4',
   '50000000-0000-4000-8000-0000000000d9',
   'RENEW_DHCP_LEASE', 'dhcp renew is simply not applicable', '{}'::jsonb,
   '60000000-0000-4000-8000-00000000000a', repeat('5', 64),
   'disposable-dhcp-0060', 'LEASED', 'NONE', 1, 1,
   'e0000000-0000-4000-8000-000000000060', 'disposable-worker-exec',
   clock_timestamp() + interval '5 minutes',
   clock_timestamp() - interval '50 seconds',
   clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '5 minutes'),
  ('c0000000-0000-4000-8000-000000000070',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a5',
   '50000000-0000-4000-8000-0000000000da',
   'FLUSH_DNS_CACHE', 'ssh transport failed before any post-check', '{}'::jsonb,
   '60000000-0000-4000-8000-00000000000a', repeat('6', 64),
   'disposable-transport-0070', 'LEASED', 'NONE', 1, 1,
   'e0000000-0000-4000-8000-000000000070', 'disposable-worker-exec',
   clock_timestamp() + interval '5 minutes',
   clock_timestamp() - interval '50 seconds',
   clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '5 minutes');

INSERT INTO public.network_device_leases (
  device_id, organization_id, building_id, command_id, lease_token, lease_owner,
  acquired_at, heartbeat_at, expires_at, generation
) VALUES
  ('50000000-0000-4000-8000-0000000000d7',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a2',
   'c0000000-0000-4000-8000-000000000050',
   'e0000000-0000-4000-8000-000000000050', 'disposable-worker-exec',
   clock_timestamp(), clock_timestamp(),
   clock_timestamp() + interval '5 minutes', 1),
  ('50000000-0000-4000-8000-0000000000d9',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a4',
   'c0000000-0000-4000-8000-000000000060',
   'e0000000-0000-4000-8000-000000000060', 'disposable-worker-exec',
   clock_timestamp(), clock_timestamp(),
   clock_timestamp() + interval '5 minutes', 1),
  ('50000000-0000-4000-8000-0000000000da',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a5',
   'c0000000-0000-4000-8000-000000000070',
   'e0000000-0000-4000-8000-000000000070', 'disposable-worker-exec',
   clock_timestamp(), clock_timestamp(),
   clock_timestamp() + interval '5 minutes', 1);

INSERT INTO public.network_command_attempts (
  id, organization_id, building_id, command_id, device_id, attempt_no,
  worker_id, lease_token, outcome, started_at
) VALUES
  ('b0000000-0000-4000-8000-000000000050',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a2',
   'c0000000-0000-4000-8000-000000000050',
   '50000000-0000-4000-8000-0000000000d7', 1, 'disposable-worker-exec',
   'e0000000-0000-4000-8000-000000000050', 'STARTED',
   clock_timestamp() - interval '2 minutes'),
  ('b0000000-0000-4000-8000-000000000060',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a4',
   'c0000000-0000-4000-8000-000000000060',
   '50000000-0000-4000-8000-0000000000d9', 1, 'disposable-worker-exec',
   'e0000000-0000-4000-8000-000000000060', 'STARTED',
   clock_timestamp() - interval '1 minute'),
  ('b0000000-0000-4000-8000-000000000070',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a5',
   'c0000000-0000-4000-8000-000000000070',
   '50000000-0000-4000-8000-0000000000da', 1, 'disposable-worker-exec',
   'e0000000-0000-4000-8000-000000000070', 'STARTED',
   clock_timestamp() - interval '1 minute');

INSERT INTO public.network_command_observations (
  id, organization_id, building_id, command_id, attempt_id, device_id,
  attempt_no, lease_token, fencing_generation, transition_version_before,
  observation_kind, evidence, evidence_hash, observed_at, worker_id
) VALUES
  ('d0000000-0000-4000-8000-000000000060',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a4',
   'c0000000-0000-4000-8000-000000000060',
   'b0000000-0000-4000-8000-000000000060',
   '50000000-0000-4000-8000-0000000000d9', 1,
   'e0000000-0000-4000-8000-000000000060', 1, 1, 'PRE_ACTION',
   jsonb_build_object('dhcp', jsonb_build_object('status', 'bound')),
   encode(extensions.digest('disposable-dhcp-pre', 'sha256'), 'hex'),
   clock_timestamp() - interval '50 seconds', 'disposable-worker-exec'),
  ('d0000000-0000-4000-8000-000000000061',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a4',
   'c0000000-0000-4000-8000-000000000060',
   'b0000000-0000-4000-8000-000000000060',
   '50000000-0000-4000-8000-0000000000d9', 1,
   'e0000000-0000-4000-8000-000000000060', 1, 1, 'POST_ACTION',
   jsonb_build_object('dhcp', jsonb_build_object('notApplicable', true)),
   encode(extensions.digest('disposable-dhcp-post', 'sha256'), 'hex'),
   clock_timestamp() - interval '10 seconds', 'disposable-worker-exec');

DO $item4_failed_postcheck_pauses_building$
DECLARE
  v_response jsonb;
  v_command public.network_commands%ROWTYPE;
BEGIN
  -- 18. A reconciliation that concludes FAILED means the router state is not
  --     proven, so the building is paused and a CRITICAL incident is opened in
  --     the transition's own transaction.
  v_response := app_private.network_center_transition_command_v1(
    'disposable-worker-exec', 'c0000000-0000-4000-8000-000000000050',
    'e0000000-0000-4000-8000-000000000050', 1, 1, 'FAILED',
    jsonb_build_object('code', 'POST_CHECK_MISMATCH')
  );
  SELECT command.* INTO v_command
  FROM public.network_commands command
  WHERE command.id = 'c0000000-0000-4000-8000-000000000050';
  IF v_command.status <> 'FAILED'
     OR NOT EXISTS (
       SELECT 1 FROM public.network_site_settings settings
       WHERE settings.building_id = '20000000-0000-4000-8000-0000000000a2'
         AND settings.changes_paused
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.network_incidents incident
       WHERE incident.building_id = '20000000-0000-4000-8000-0000000000a2'
         AND incident.incident_type = 'COMMAND_POSTCHECK_FAILED'
         AND incident.severity = 'CRITICAL'
         AND incident.status = 'OPEN'
     )
     OR v_response->'escalation'->>'changesPaused' <> 'true' THEN
    RAISE EXCEPTION 'a failed post-check did not pause its building: % / %',
      v_command.status, v_response;
  END IF;

  -- 19. A benign not-applicable outcome is not a failed post-check and must
  --     never stop a site.
  v_response := app_private.network_center_transition_command_v1(
    'disposable-worker-exec', 'c0000000-0000-4000-8000-000000000060',
    'e0000000-0000-4000-8000-000000000060', 1, 1, 'EVALUATE_POSTCONDITION',
    '{}'::jsonb
  );
  IF v_response->>'status' <> 'FAILED'
     OR v_response ? 'escalation'
     OR EXISTS (
       SELECT 1 FROM public.network_site_settings settings
       WHERE settings.building_id = '20000000-0000-4000-8000-0000000000a4'
         AND settings.changes_paused
     )
     OR EXISTS (
       SELECT 1 FROM public.network_incidents incident
       WHERE incident.building_id = '20000000-0000-4000-8000-0000000000a4'
     ) THEN
    RAISE EXCEPTION 'a not-applicable DHCP renew paused its building: %',
      v_response;
  END IF;

  -- 20. A transport failure that never reached a post-check must not stop a
  --     site either; one SSH blip cannot take a building offline.
  v_response := app_private.network_center_transition_command_v1(
    'disposable-worker-exec', 'c0000000-0000-4000-8000-000000000070',
    'e0000000-0000-4000-8000-000000000070', 1, 1, 'FAILED',
    jsonb_build_object('code', 'SSH_CONNECT_FAILED')
  );
  IF v_response->>'status' <> 'FAILED'
     OR v_response ? 'escalation'
     OR EXISTS (
       SELECT 1 FROM public.network_site_settings settings
       WHERE settings.building_id = '20000000-0000-4000-8000-0000000000a5'
         AND settings.changes_paused
     )
     OR EXISTS (
       SELECT 1 FROM public.network_incidents incident
       WHERE incident.building_id = '20000000-0000-4000-8000-0000000000a5'
     ) THEN
    RAISE EXCEPTION 'a transport failure paused its building: %', v_response;
  END IF;
END
$item4_failed_postcheck_pauses_building$;

-- =============================================================================
-- Item 5: fleet-wide kill switch with an owner-only resume.
-- =============================================================================
INSERT INTO public.network_commands (
  id, organization_id, building_id, device_id, action_type, reason,
  target_display, requested_by, request_hash, idempotency_key, status,
  created_at, observation_deadline
) VALUES
  ('c0000000-0000-4000-8000-000000000080',
   '40000000-0000-4000-8000-0000000000aa',
   '20000000-0000-4000-8000-0000000000a1',
   '50000000-0000-4000-8000-0000000000d8',
   'FLUSH_DNS_CACHE', 'queued while the fleet is stopped', '{}'::jsonb,
   '60000000-0000-4000-8000-00000000000a', repeat('7', 64),
   'disposable-killswitch-0080', 'QUEUED',
   clock_timestamp(), clock_timestamp() + interval '30 minutes'),
  ('c0000000-0000-4000-8000-000000000090',
   '40000000-0000-4000-8000-0000000000bb',
   '20000000-0000-4000-8000-0000000000b1',
   '50000000-0000-4000-8000-0000000000db',
   'FLUSH_DNS_CACHE', 'another tenant keeps running', '{}'::jsonb,
   '60000000-0000-4000-8000-00000000000b', repeat('8', 64),
   'disposable-othertenant-0090', 'QUEUED',
   clock_timestamp(), clock_timestamp() + interval '30 minutes');

DO $item5_fleet_kill_switch$
DECLARE
  c_owner constant uuid := '60000000-0000-4000-8000-00000000000a';
  c_staff constant uuid := '60000000-0000-4000-8000-00000000005a';
  c_other_owner constant uuid := '60000000-0000-4000-8000-00000000000b';
  c_building constant uuid := '20000000-0000-4000-8000-0000000000a1';
  c_other_building constant uuid := '20000000-0000-4000-8000-0000000000b1';
  c_paused_command constant uuid := 'c0000000-0000-4000-8000-000000000080';
  c_other_command constant uuid := 'c0000000-0000-4000-8000-000000000090';
  v_pause jsonb;
  v_resume jsonb;
  v_claim jsonb;
  v_denied text;
  v_scope record;
BEGIN
  PERFORM set_config('app.disposable_actor', c_owner::text, true);
  v_pause := public.network_center_pause_organization_v1(
    c_building, 'Fleet-wide incident drill', gen_random_uuid()
  );
  IF (v_pause->>'mutationsPaused')::boolean IS NOT TRUE
     OR (v_pause->>'version')::bigint <> 1 THEN
    RAISE EXCEPTION 'organization pause did not engage: %', v_pause;
  END IF;

  -- 21. The gate lives inside the one guard every execute-scoped RPC already
  --     passes through, so no RPC path can go around it.
  v_denied := NULL;
  BEGIN
    PERFORM * FROM app_private.network_center_require_execute_v1(c_building);
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := SQLERRM;
  END;
  IF v_denied IS DISTINCT FROM 'NETWORK_CENTER_ORG_PAUSED' THEN
    RAISE EXCEPTION 'the shared execute guard ignored the organization gate: %',
      v_denied;
  END IF;
  v_denied := NULL;
  BEGIN
    PERFORM public.network_center_retire_uncertain_command_v1(
      c_building, c_paused_command, 'Attempt during the pause',
      gen_random_uuid()
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := SQLERRM;
  END;
  IF v_denied IS DISTINCT FROM 'NETWORK_CENTER_ORG_PAUSED' THEN
    RAISE EXCEPTION 'an execute-scoped RPC bypassed the organization gate: %',
      v_denied;
  END IF;

  -- 22. One organization's kill switch never touches another tenant: their
  --     guard still passes and their queued work still drains.
  PERFORM set_config('app.disposable_actor', c_other_owner::text, true);
  SELECT * INTO v_scope
  FROM app_private.network_center_require_execute_v1(c_other_building);
  IF v_scope.organization_id <> '40000000-0000-4000-8000-0000000000bb' THEN
    RAISE EXCEPTION 'another tenant was caught by the organization gate';
  END IF;
  v_claim := public.network_center_worker_claim_v2('digest-worker-exec', 5, 90);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_claim->'items') item
    WHERE (item->>'commandId')::uuid = c_paused_command
  ) THEN
    RAISE EXCEPTION 'a paused organization still dispatched work';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_claim->'items') item
    WHERE (item->>'commandId')::uuid = c_other_command
  ) THEN
    RAISE EXCEPTION 'a paused organization stopped another tenant';
  END IF;

  -- 23. Resuming is the dangerous direction, so it is owner-only.
  PERFORM set_config('app.disposable_actor', c_staff::text, true);
  v_denied := NULL;
  BEGIN
    PERFORM public.network_center_resume_organization_v1(
      c_building, 1, 'Staff tries to resume', gen_random_uuid()
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := SQLERRM;
  END;
  IF v_denied IS DISTINCT FROM 'NETWORK_CENTER_ORG_RESUME_REQUIRES_OWNER' THEN
    RAISE EXCEPTION 'a non-owner resumed the fleet: %', v_denied;
  END IF;

  -- 24. The owner resumes under CAS and both the guard and the claim path
  --     recover.
  PERFORM set_config('app.disposable_actor', c_owner::text, true);
  v_resume := public.network_center_resume_organization_v1(
    c_building, 1, 'Incident drill complete', gen_random_uuid()
  );
  IF (v_resume->>'mutationsPaused')::boolean IS NOT FALSE
     OR (v_resume->>'version')::bigint <> 2 THEN
    RAISE EXCEPTION 'owner resume did not clear the gate: %', v_resume;
  END IF;
  SELECT * INTO v_scope
  FROM app_private.network_center_require_execute_v1(c_building);
  IF v_scope.organization_id <> '40000000-0000-4000-8000-0000000000aa' THEN
    RAISE EXCEPTION 'the execute guard stayed closed after a resume';
  END IF;
  v_claim := public.network_center_worker_claim_v2('digest-worker-exec', 5, 90);
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_claim->'items') item
    WHERE (item->>'commandId')::uuid = c_paused_command
  ) THEN
    RAISE EXCEPTION 'work did not resume after the kill switch was cleared';
  END IF;
  PERFORM set_config('app.disposable_actor', '', true);

  -- 25. No browser or worker role can read the gate or drive the kill switch.
  IF has_table_privilege('anon', 'public.network_org_mutation_gates', 'SELECT')
     OR has_table_privilege(
       'authenticated', 'public.network_org_mutation_gates', 'SELECT'
     )
     OR has_table_privilege(
       'service_role', 'public.network_org_mutation_gates', 'SELECT'
     )
     OR has_function_privilege(
       'service_role',
       'public.network_center_pause_organization_v1(uuid,text,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.network_center_resume_organization_v1(uuid,bigint,text,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.network_center_resume_organization_v1(uuid,bigint,text,uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.network_center_pause_organization_v1(uuid,text,uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.network_center_resume_organization_v1(uuid,bigint,text,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'organization gate ACL is not fail closed';
  END IF;
END
$item5_fleet_kill_switch$;

SELECT jsonb_build_object(
  'status', 'PASS',
  'invariants', 47
) AS disposable_operational_safety_proof;
`;

function executableName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function candidatePostgresBins(environment = process.env) {
  const configured = environment.POSTGRES_BIN?.trim();
  return [
    configured || null,
    process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\17\\bin" : null,
    process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\16\\bin" : null,
  ].filter(Boolean);
}

export function assertSupportedPostgresVersion(name, versionOutput) {
  const match = String(versionOutput).match(/\bPostgreSQL\)?\s+(\d+)(?:\.\d+)?/u);
  if (!match) {
    throw new Error(
      `${name} did not report a valid PostgreSQL version; PostgreSQL 16+ is required`,
    );
  }
  const major = Number.parseInt(match[1], 10);
  if (major < 16) {
    throw new Error(`${name} requires PostgreSQL 16+ (reported major ${major})`);
  }
  return major;
}

function probePostgresBinary(name, binary) {
  const probe = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: POSTGRES_VERSION_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (probe.status !== 0) return false;
  assertSupportedPostgresVersion(name, probe.stdout || probe.stderr);
  return true;
}

function resolveBinary(name, environment = process.env) {
  for (const directory of candidatePostgresBins(environment)) {
    const candidate = join(directory, executableName(name));
    if (existsSync(candidate) && probePostgresBinary(name, candidate)) return candidate;
  }
  const command = executableName(name);
  if (probePostgresBinary(name, command)) return command;
  throw new Error(`${name} is unavailable; set POSTGRES_BIN to a PostgreSQL 16+ bin directory`);
}

function runNative(
  file,
  args,
  {
    input,
    quiet = false,
    stdio,
    timeoutMs = NATIVE_COMMAND_TIMEOUT_MS,
  } = {},
) {
  const options = {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  };
  if (input !== undefined) options.input = input;
  if (stdio !== undefined) options.stdio = stdio;
  const result = spawnSync(file, args, options);
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "native command failed")
      .trim()
      .slice(-4_000);
    const outcome = result.error?.code === "ETIMEDOUT"
      ? `timed out after ${timeoutMs}ms`
      : `failed (${result.status ?? result.error?.code ?? "unknown"})`;
    throw new Error(`${basename(file)} ${outcome}: ${detail}`, {
      cause: result.error,
    });
  }
  if (!quiet && result.stderr?.trim()) process.stderr.write(result.stderr);
  return result.stdout ?? "";
}

export function assertDisposableClusterPath(cluster, tempDirectory = tmpdir()) {
  const resolvedTempDirectory = resolve(tempDirectory);
  const resolvedCluster = resolve(cluster);
  if (
    dirname(resolvedCluster) !== resolvedTempDirectory
    || !/^network-center-pg-[A-Za-z0-9_-]+$/u.test(basename(resolvedCluster))
  ) {
    throw new Error(
      `Refusing destructive cleanup outside a disposable TEMP cluster: ${resolvedCluster}`,
    );
  }
  return resolvedCluster;
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
  if (!Number.isSafeInteger(port)) throw new Error("Could not reserve a loopback port");
  return port;
}

export async function runDisposableReleaseProof({ environment = process.env } = {}) {
  const binaries = Object.fromEntries(
    ["initdb", "pg_ctl", "psql"].map((name) => [name, resolveBinary(name, environment)]),
  );
  const port = await reserveLoopbackPort();
  const cluster = assertDisposableClusterPath(
    await mkdtemp(join(tmpdir(), "network-center-pg-")),
  );
  const logPath = join(cluster, "postgres.log");
  let proofError = null;
  let startAttempted = false;
  let started = false;
  const connectionArgs = [
    "-X", "-v", "ON_ERROR_STOP=1",
    "-h", "127.0.0.1", "-p", String(port),
    "-U", "postgres", "-d", "postgres",
  ];
  try {
    runNative(binaries.initdb, [
      "-D", cluster,
      "--auth=trust",
      "--username=postgres",
      "--encoding=UTF8",
      "--no-locale",
    ], { quiet: true });
    startAttempted = true;
    runNative(binaries.pg_ctl, [
      "-D", cluster,
      "-l", logPath,
      "-o", `-p ${port} -h 127.0.0.1`,
      "-w", "start",
    ], {
      quiet: true,
      stdio: PG_CTL_STDIO,
      timeoutMs: PG_CTL_TIMEOUT_MS,
    });
    started = true;
    runNative(binaries.psql, connectionArgs, {
      input: `${BOOTSTRAP_SQL}\n${OPERATIONAL_SAFETY_BOOTSTRAP_SQL}`,
      quiet: true,
    });
    const migrations = await Promise.all(
      MIGRATION_PATHS.map((path) => readFile(path, "utf8")),
    );
    runNative(binaries.psql, connectionArgs, {
      input: migrations.join("\n"),
      quiet: true,
    });
    const output = runNative(
      binaries.psql,
      ["-q", "-t", "-A", ...connectionArgs],
      {
        input: `${ASSERTION_SQL}\n${OPERATIONAL_SAFETY_ASSERTION_SQL}`,
        quiet: true,
      },
    );
    // The readback assertions also print an admin status payload whose nested
    // rows carry a "status" key, so verdicts are identified by the "invariants"
    // field they alone declare rather than by a substring match.
    const verdicts = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry !== null && typeof entry === "object"
        && Object.hasOwn(entry, "invariants"));
    const verdict = verdicts.at(-1) ?? null;
    if (
      verdicts.length !== 2
      || verdicts.some((entry) => entry?.status !== "PASS")
      || verdicts[0]?.invariants !== RELEASE_READBACK_INVARIANTS
      || verdict?.invariants !== TOTAL_DISPOSABLE_INVARIANTS
    ) {
      throw new Error("Disposable release proof did not return the expected PASS verdict");
    }
    return verdict;
  } catch (error) {
    proofError = error;
    throw error;
  } finally {
    let cleanupError = null;
    let safeToRemove = !startAttempted;
    if (startAttempted) {
      try {
        assertDisposableClusterPath(cluster);
        runNative(binaries.pg_ctl, ["-D", cluster, "-m", "fast", "-w", "stop"], {
          quiet: true,
          stdio: PG_CTL_STDIO,
          timeoutMs: PG_CTL_TIMEOUT_MS,
        });
        safeToRemove = true;
      } catch (error) {
        safeToRemove = !existsSync(join(cluster, "postmaster.pid"));
        if (!safeToRemove || started) cleanupError = error;
      }
    }
    if (safeToRemove) {
      try {
        await rm(assertDisposableClusterPath(cluster), { recursive: true, force: true });
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) {
      const cleanupMessage = `Disposable PostgreSQL cleanup failed: ${cleanupError.message}`;
      if (proofError) {
        throw new Error(`${proofError.message}; ${cleanupMessage}`, {
          cause: new AggregateError([proofError, cleanupError]),
        });
      }
      throw new Error(cleanupMessage, { cause: cleanupError });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    throw new Error("Usage: node scripts/test-network-center-release-readback-disposable.mjs [--dry-run]");
  }
  if (args[0] === "--dry-run") {
    await Promise.all(MIGRATION_PATHS.map((path) => readFile(path, "utf8")));
    process.stdout.write(
      "Disposable release proof dry-run passed; no PostgreSQL process was started.\n",
    );
    return;
  }
  const verdict = await runDisposableReleaseProof();
  process.stdout.write(
    `Disposable PostgreSQL release migration proof PASS: `
      + `${verdict.invariants}/${TOTAL_DISPOSABLE_INVARIANTS} invariants.\n`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}
