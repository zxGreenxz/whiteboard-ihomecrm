-- =============================================================================
-- Network Center 3/4: incidents, maintenance, redacted snapshots, an immediate
-- (no approval) command queue, leases, immutable evidence, outbox, and worker
-- health. Browser access remains inert until the 4/4 RLS/RPC migration.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.network_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  interface_id uuid,
  fingerprint text NOT NULL,
  incident_type text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  title text NOT NULL,
  summary text NOT NULL,
  availability_impact boolean NOT NULL DEFAULT false,
  opened_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  recovered_at timestamptz,
  resolved_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  occurrence_count integer NOT NULL DEFAULT 1,
  observed_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_incidents_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_incidents_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_incidents_interface_fk
    FOREIGN KEY (organization_id, building_id, device_id, interface_id)
    REFERENCES public.network_interfaces(organization_id, building_id, device_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_incidents_fingerprint_check
    CHECK (char_length(btrim(fingerprint)) BETWEEN 8 AND 200),
  CONSTRAINT network_incidents_type_check
    CHECK (incident_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT network_incidents_severity_check
    CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  CONSTRAINT network_incidents_status_check
    CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RECOVERING', 'RESOLVED')),
  CONSTRAINT network_incidents_text_check
    CHECK (
      char_length(btrim(title)) BETWEEN 3 AND 200
      AND char_length(btrim(summary)) BETWEEN 3 AND 2000
    ),
  CONSTRAINT network_incidents_time_check
    CHECK (
      opened_at <= last_observed_at
      AND (recovered_at IS NULL OR recovered_at >= opened_at)
      AND (resolved_at IS NULL OR resolved_at >= opened_at)
      AND (acknowledged_at IS NULL OR acknowledged_at >= opened_at)
    ),
  CONSTRAINT network_incidents_resolution_check
    CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL)),
  CONSTRAINT network_incidents_ack_check
    CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
  CONSTRAINT network_incidents_occurrence_check
    CHECK (occurrence_count > 0),
  CONSTRAINT network_incidents_values_check
    CHECK (jsonb_typeof(observed_values) = 'object' AND octet_length(observed_values::text) <= 16384),
  CONSTRAINT network_incidents_version_check
    CHECK (version > 0),
  UNIQUE (organization_id, building_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS network_incidents_one_active_fingerprint_uidx
  ON public.network_incidents (organization_id, building_id, fingerprint)
  WHERE status <> 'RESOLVED';

CREATE INDEX IF NOT EXISTS network_incidents_active_idx
  ON public.network_incidents (organization_id, building_id, severity, last_observed_at DESC, id)
  WHERE status <> 'RESOLVED';

CREATE INDEX IF NOT EXISTS network_incidents_device_idx
  ON public.network_incidents (organization_id, building_id, device_id, interface_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS public.network_incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  event_seq bigint NOT NULL,
  event_kind text NOT NULL,
  severity text NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_id uuid,
  worker_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_event_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_incident_events_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_incident_events_incident_fk
    FOREIGN KEY (organization_id, building_id, incident_id)
    REFERENCES public.network_incidents(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_incident_events_seq_check
    CHECK (event_seq > 0),
  CONSTRAINT network_incident_events_kind_check
    CHECK (event_kind IN ('OPENED', 'OBSERVED', 'ESCALATED', 'ACKNOWLEDGED', 'RECOVERED', 'RESOLVED')),
  CONSTRAINT network_incident_events_severity_check
    CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  CONSTRAINT network_incident_events_actor_check
    CHECK (actor_id IS NOT NULL OR worker_id IS NOT NULL),
  CONSTRAINT network_incident_events_worker_check
    CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  CONSTRAINT network_incident_events_details_check
    CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 65536),
  CONSTRAINT network_incident_events_external_key_check
    CHECK (external_event_key IS NULL OR char_length(external_event_key) BETWEEN 8 AND 200),
  UNIQUE (incident_id, event_seq),
  UNIQUE (organization_id, external_event_key)
);

CREATE INDEX IF NOT EXISTS network_incident_events_cursor_idx
  ON public.network_incident_events (organization_id, building_id, occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.network_maintenance_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL,
  created_by uuid NOT NULL,
  request_hash text NOT NULL,
  idempotency_key text NOT NULL,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancellation_reason text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_maintenance_windows_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_maintenance_windows_status_check
    CHECK (status IN ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT network_maintenance_windows_time_check
    CHECK (ends_at > starts_at AND ends_at <= starts_at + INTERVAL '30 days'),
  CONSTRAINT network_maintenance_windows_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 8 AND 1000),
  CONSTRAINT network_maintenance_windows_hash_check
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT network_maintenance_windows_idempotency_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  CONSTRAINT network_maintenance_windows_cancel_check
    CHECK (
      (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
      AND (cancelled_at IS NULL) = (cancelled_by IS NULL)
      AND (cancellation_reason IS NULL OR char_length(btrim(cancellation_reason)) BETWEEN 8 AND 1000)
    ),
  CONSTRAINT network_maintenance_windows_version_check
    CHECK (version > 0),
  UNIQUE (organization_id, building_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS network_maintenance_windows_idempotency_uidx
  ON public.network_maintenance_windows (organization_id, created_by, idempotency_key);

CREATE INDEX IF NOT EXISTS network_maintenance_windows_active_idx
  ON public.network_maintenance_windows (organization_id, building_id, starts_at, ends_at, id)
  WHERE status IN ('SCHEDULED', 'ACTIVE');

CREATE TABLE IF NOT EXISTS public.network_commands (
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
  CONSTRAINT network_commands_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_commands_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_commands_interface_fk
    FOREIGN KEY (organization_id, building_id, device_id, interface_id)
    REFERENCES public.network_interfaces(organization_id, building_id, device_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_commands_action_check
    CHECK (action_type IN ('FLUSH_DNS_CACHE', 'RENEW_DHCP_LEASE', 'CYCLE_ACCESS_PORT', 'REBOOT_ROUTER', 'CAPTURE_SNAPSHOT')),
  CONSTRAINT network_commands_interface_target_check
    CHECK ((action_type = 'CYCLE_ACCESS_PORT') = (interface_id IS NOT NULL)),
  CONSTRAINT network_commands_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 8 AND 1000),
  CONSTRAINT network_commands_parameters_check
    CHECK (jsonb_typeof(sanitized_parameters) = 'object' AND octet_length(sanitized_parameters::text) <= 16384),
  CONSTRAINT network_commands_target_display_check
    CHECK (jsonb_typeof(target_display) = 'object' AND octet_length(target_display::text) <= 16384),
  CONSTRAINT network_commands_hash_check
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT network_commands_idempotency_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  CONSTRAINT network_commands_status_check
    CHECK (status IN (
      'QUEUED', 'LEASED', 'RUNNING', 'RETRY_WAIT', 'UNCERTAIN', 'RECONCILING',
      'SUCCEEDED', 'FAILED', 'CANCELLED_BY_KILL_SWITCH'
    )),
  CONSTRAINT network_commands_priority_check
    CHECK (priority BETWEEN 0 AND 100),
  CONSTRAINT network_commands_attempt_check
    CHECK (attempt_count BETWEEN 0 AND max_attempts AND max_attempts BETWEEN 1 AND 10),
  CONSTRAINT network_commands_lease_check
    CHECK (
      (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
  CONSTRAINT network_commands_active_lease_check
    CHECK (
      (lease_token IS NOT NULL) =
      (status IN ('LEASED', 'RUNNING', 'RECONCILING'))
    ),
  CONSTRAINT network_commands_result_check
    CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536)),
  CONSTRAINT network_commands_rollback_check
    CHECK (rollback IS NULL OR (jsonb_typeof(rollback) = 'object' AND octet_length(rollback::text) <= 65536)),
  CONSTRAINT network_commands_reconciliation_check
    CHECK (reconciliation_state IN ('NONE', 'REQUIRED', 'IN_PROGRESS', 'CONFIRMED', 'FAILED', 'UNKNOWN')),
  CONSTRAINT network_commands_finish_check
    CHECK (
      (status IN ('SUCCEEDED', 'FAILED', 'CANCELLED_BY_KILL_SWITCH')) = (finished_at IS NOT NULL)
      AND (started_at IS NULL OR started_at >= created_at)
      AND (finished_at IS NULL OR (started_at IS NOT NULL AND finished_at >= started_at))
    ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, building_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS network_commands_idempotency_uidx
  ON public.network_commands (organization_id, requested_by, idempotency_key);

CREATE INDEX IF NOT EXISTS network_commands_runnable_idx
  ON public.network_commands (priority DESC, available_at, created_at, id)
  WHERE status IN ('QUEUED', 'RETRY_WAIT');

CREATE INDEX IF NOT EXISTS network_commands_building_cursor_idx
  ON public.network_commands (organization_id, building_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS network_commands_device_status_idx
  ON public.network_commands (organization_id, building_id, device_id, status, created_at, id);

CREATE TABLE IF NOT EXISTS public.network_command_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  command_id uuid NOT NULL,
  device_id uuid NOT NULL,
  attempt_no integer NOT NULL,
  worker_id text NOT NULL,
  lease_token uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'STARTED',
  retryable boolean,
  error_code text,
  error_message text,
  result jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_command_attempts_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_command_attempts_command_fk
    FOREIGN KEY (organization_id, building_id, command_id)
    REFERENCES public.network_commands(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_command_attempts_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_command_attempts_number_check
    CHECK (attempt_no > 0),
  CONSTRAINT network_command_attempts_worker_check
    CHECK (worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  CONSTRAINT network_command_attempts_outcome_check
    CHECK (outcome IN ('STARTED', 'SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'UNCERTAIN', 'ABANDONED')),
  CONSTRAINT network_command_attempts_error_check
    CHECK (
      (error_code IS NULL OR char_length(error_code) <= 100)
      AND (error_message IS NULL OR char_length(error_message) <= 2000)
    ),
  CONSTRAINT network_command_attempts_result_check
    CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536)),
  CONSTRAINT network_command_attempts_time_check
    CHECK (finished_at IS NULL OR finished_at >= started_at),
  UNIQUE (command_id, attempt_no),
  UNIQUE (organization_id, id),
  CONSTRAINT network_command_attempts_org_building_identity_key
    UNIQUE (organization_id, building_id, id)
);

CREATE INDEX IF NOT EXISTS network_command_attempts_command_idx
  ON public.network_command_attempts (organization_id, building_id, command_id, attempt_no DESC);

CREATE TABLE IF NOT EXISTS public.network_command_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  command_id uuid NOT NULL,
  attempt_id uuid,
  event_seq bigint NOT NULL,
  event_kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_id uuid,
  worker_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_command_events_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_command_events_command_fk
    FOREIGN KEY (organization_id, building_id, command_id)
    REFERENCES public.network_commands(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_command_events_attempt_fk
    FOREIGN KEY (organization_id, building_id, attempt_id)
    REFERENCES public.network_command_attempts(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_command_events_seq_check
    CHECK (event_seq > 0),
  CONSTRAINT network_command_events_kind_check
    CHECK (event_kind IN (
      'QUEUED', 'LEASED', 'VALIDATED', 'BACKUP_STARTED', 'BACKUP_COMPLETED',
      'EXECUTION_STARTED', 'EXECUTION_COMPLETED', 'POST_CHECK_STARTED',
      'POST_CHECK_COMPLETED', 'RETRY_SCHEDULED', 'RECONCILIATION_STARTED',
      'RECONCILIATION_COMPLETED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN',
      'CANCELLED_BY_KILL_SWITCH'
    )),
  CONSTRAINT network_command_events_actor_check
    CHECK (actor_id IS NOT NULL OR worker_id IS NOT NULL),
  CONSTRAINT network_command_events_worker_check
    CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  CONSTRAINT network_command_events_payload_check
    CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536),
  UNIQUE (command_id, event_seq),
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS network_command_events_cursor_idx
  ON public.network_command_events (organization_id, building_id, command_id, occurred_at, event_seq);

CREATE TABLE IF NOT EXISTS public.network_device_leases (
  device_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  command_id uuid NOT NULL,
  lease_token uuid NOT NULL,
  lease_owner text NOT NULL,
  acquired_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  CONSTRAINT network_device_leases_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_device_leases_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_device_leases_command_fk
    FOREIGN KEY (organization_id, building_id, command_id)
    REFERENCES public.network_commands(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_device_leases_owner_check
    CHECK (lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  CONSTRAINT network_device_leases_time_check
    CHECK (acquired_at <= heartbeat_at AND heartbeat_at < expires_at),
  CONSTRAINT network_device_leases_generation_check
    CHECK (generation > 0),
  UNIQUE (organization_id, building_id, device_id)
);

CREATE INDEX IF NOT EXISTS network_device_leases_expiry_idx
  ON public.network_device_leases (expires_at, organization_id, building_id, device_id);

CREATE TABLE IF NOT EXISTS public.network_config_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  command_id uuid,
  source text NOT NULL,
  schema_version integer NOT NULL,
  normalized_content jsonb NOT NULL,
  redacted_lines jsonb NOT NULL,
  content_hash text NOT NULL,
  artifact_key text,
  created_by uuid,
  worker_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_config_snapshots_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_config_snapshots_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_config_snapshots_command_fk
    FOREIGN KEY (organization_id, building_id, command_id)
    REFERENCES public.network_commands(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_config_snapshots_source_check
    CHECK (source IN ('MANUAL', 'SCHEDULED', 'PRE_ACTION', 'POST_ACTION')),
  CONSTRAINT network_config_snapshots_schema_check
    CHECK (schema_version > 0),
  CONSTRAINT network_config_snapshots_content_check
    CHECK (jsonb_typeof(normalized_content) = 'object' AND octet_length(normalized_content::text) <= 1048576),
  CONSTRAINT network_config_snapshots_lines_check
    CHECK (jsonb_typeof(redacted_lines) = 'array' AND octet_length(redacted_lines::text) <= 1048576),
  CONSTRAINT network_config_snapshots_hash_check
    CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT network_config_snapshots_artifact_check
    CHECK (
      artifact_key IS NULL
      OR (char_length(artifact_key) BETWEEN 8 AND 500 AND artifact_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]+$')
    ),
  CONSTRAINT network_config_snapshots_actor_check
    CHECK (created_by IS NOT NULL OR worker_id IS NOT NULL),
  CONSTRAINT network_config_snapshots_worker_check
    CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  UNIQUE (organization_id, building_id, id)
);

CREATE INDEX IF NOT EXISTS network_config_snapshots_cursor_idx
  ON public.network_config_snapshots (organization_id, building_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS network_config_snapshots_device_idx
  ON public.network_config_snapshots (organization_id, building_id, device_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.network_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid,
  worker_id text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  target_display jsonb NOT NULL,
  reason text NOT NULL,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text NOT NULL,
  command_id uuid,
  request_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_audit_events_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_audit_events_command_fk
    FOREIGN KEY (organization_id, building_id, command_id)
    REFERENCES public.network_commands(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_audit_events_actor_type_check
    CHECK (actor_type IN ('USER', 'WORKER', 'SYSTEM')),
  CONSTRAINT network_audit_events_actor_check
    CHECK (
      (actor_type = 'USER' AND actor_id IS NOT NULL AND worker_id IS NULL)
      OR (actor_type = 'WORKER' AND actor_id IS NULL AND worker_id IS NOT NULL)
      OR (actor_type = 'SYSTEM' AND actor_id IS NULL AND worker_id IS NULL)
    ),
  CONSTRAINT network_audit_events_worker_check
    CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  CONSTRAINT network_audit_events_action_check
    CHECK (action ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  CONSTRAINT network_audit_events_target_check
    CHECK (target_type ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  CONSTRAINT network_audit_events_target_display_check
    CHECK (jsonb_typeof(target_display) = 'object' AND octet_length(target_display::text) <= 16384),
  CONSTRAINT network_audit_events_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT network_audit_events_payload_check
    CHECK (
      jsonb_typeof(validation) = 'object'
      AND jsonb_typeof(result) = 'object'
      AND octet_length(validation::text) <= 65536
      AND octet_length(result::text) <= 65536
    ),
  CONSTRAINT network_audit_events_outcome_check
    CHECK (outcome IN ('ACCEPTED', 'REJECTED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN', 'OBSERVED')),
  UNIQUE (organization_id, building_id, id)
);

CREATE INDEX IF NOT EXISTS network_audit_events_cursor_idx
  ON public.network_audit_events (organization_id, building_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS network_audit_events_actor_idx
  ON public.network_audit_events (organization_id, actor_id, occurred_at DESC)
  WHERE actor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.network_outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_outbox_events_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_outbox_events_type_check
    CHECK (event_type ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  CONSTRAINT network_outbox_events_aggregate_check
    CHECK (aggregate_type ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  CONSTRAINT network_outbox_events_payload_check
    CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536),
  UNIQUE (organization_id, building_id, id)
);

CREATE INDEX IF NOT EXISTS network_outbox_events_cursor_idx
  ON public.network_outbox_events (organization_id, building_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS public.network_outbox_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_event_id uuid NOT NULL REFERENCES public.network_outbox_events(id) ON DELETE RESTRICT,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_outbox_deliveries_channel_check
    CHECK (channel IN ('IN_APP', 'EMAIL', 'WEBHOOK')),
  CONSTRAINT network_outbox_deliveries_status_check
    CHECK (status IN ('PENDING', 'DELIVERING', 'DELIVERED', 'FAILED', 'DEAD')),
  CONSTRAINT network_outbox_deliveries_attempt_check
    CHECK (attempt_count BETWEEN 0 AND 100),
  CONSTRAINT network_outbox_deliveries_lease_check
    CHECK (
      (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
  CONSTRAINT network_outbox_deliveries_error_check
    CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  CONSTRAINT network_outbox_deliveries_delivered_check
    CHECK ((status = 'DELIVERED') = (delivered_at IS NOT NULL)),
  UNIQUE (outbox_event_id, channel)
);

CREATE INDEX IF NOT EXISTS network_outbox_deliveries_pending_idx
  ON public.network_outbox_deliveries (available_at, id)
  WHERE status IN ('PENDING', 'FAILED');

CREATE TABLE IF NOT EXISTS public.network_worker_heartbeats (
  worker_id text PRIMARY KEY,
  worker_version text NOT NULL,
  capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  queue_age_seconds integer NOT NULL DEFAULT 0,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_worker_heartbeats_id_check
    CHECK (worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  CONSTRAINT network_worker_heartbeats_version_check
    CHECK (char_length(worker_version) BETWEEN 1 AND 100),
  CONSTRAINT network_worker_heartbeats_capabilities_check
    CHECK (cardinality(capabilities) <= 32),
  CONSTRAINT network_worker_heartbeats_status_check
    CHECK (status IN ('ONLINE', 'DEGRADED', 'PAUSED', 'STOPPING')),
  CONSTRAINT network_worker_heartbeats_queue_check
    CHECK (queue_age_seconds BETWEEN 0 AND 31536000),
  CONSTRAINT network_worker_heartbeats_metadata_check
    CHECK (jsonb_typeof(safe_metadata) = 'object' AND octet_length(safe_metadata::text) <= 16384),
  CONSTRAINT network_worker_heartbeats_time_check
    CHECK (started_at <= heartbeat_at)
);

CREATE INDEX IF NOT EXISTS network_worker_heartbeats_freshness_idx
  ON public.network_worker_heartbeats (heartbeat_at DESC, worker_id);

CREATE OR REPLACE FUNCTION app_private.network_center_guard_command_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF ROW(
    NEW.organization_id, NEW.building_id, NEW.device_id, NEW.interface_id,
    NEW.action_type, NEW.reason, NEW.sanitized_parameters, NEW.target_display,
    NEW.requested_by, NEW.request_hash, NEW.idempotency_key, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organization_id, OLD.building_id, OLD.device_id, OLD.interface_id,
    OLD.action_type, OLD.reason, OLD.sanitized_parameters, OLD.target_display,
    OLD.requested_by, OLD.request_hash, OLD.idempotency_key, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Immutable Network Center command fields cannot change'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS network_commands_immutable_fields ON public.network_commands;
CREATE TRIGGER network_commands_immutable_fields
  BEFORE UPDATE ON public.network_commands
  FOR EACH ROW EXECUTE FUNCTION app_private.network_center_guard_command_immutable_v1();

CREATE OR REPLACE FUNCTION app_private.network_center_enqueue_command_v1(
  p_organization_id uuid,
  p_building_id uuid,
  p_device_id uuid,
  p_interface_id uuid,
  p_action_type text,
  p_reason text,
  p_parameters jsonb,
  p_target_display jsonb,
  p_requested_by uuid,
  p_request_hash text,
  p_idempotency_key text,
  p_available_at timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_existing public.network_commands%ROWTYPE;
  v_command_id uuid;
BEGIN
  IF p_organization_id IS NULL OR p_building_id IS NULL OR p_device_id IS NULL
     OR p_requested_by IS NULL OR p_available_at IS NULL THEN
    RAISE EXCEPTION 'Missing command identity' USING ERRCODE = '22023';
  END IF;
  p_action_type := upper(btrim(coalesce(p_action_type, '')));
  p_reason := btrim(coalesce(p_reason, ''));
  p_idempotency_key := btrim(coalesce(p_idempotency_key, ''));
  p_request_hash := lower(btrim(coalesce(p_request_hash, '')));
  p_parameters := coalesce(p_parameters, '{}'::jsonb);

  IF p_action_type NOT IN ('FLUSH_DNS_CACHE', 'RENEW_DHCP_LEASE', 'CYCLE_ACCESS_PORT', 'REBOOT_ROUTER', 'CAPTURE_SNAPSHOT')
     OR char_length(p_reason) NOT BETWEEN 8 AND 1000
     OR p_request_hash !~ '^[a-f0-9]{64}$'
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
     OR jsonb_typeof(p_parameters) <> 'object'
     OR p_target_display IS NULL
     OR jsonb_typeof(p_target_display) <> 'object' THEN
    RAISE EXCEPTION 'Invalid command request' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.network_devices device
    WHERE device.organization_id = p_organization_id
      AND device.building_id = p_building_id
      AND device.id = p_device_id
      AND device.device_kind = 'MIKROTIK'
      AND device.is_active
      AND device.write_capability
  ) THEN
    RAISE EXCEPTION 'Command target is not an active writable MikroTik'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.network_site_settings settings
    WHERE settings.organization_id = p_organization_id
      AND settings.building_id = p_building_id
      AND settings.changes_paused
  ) THEN
    RAISE EXCEPTION 'Network changes are paused for this building'
      USING ERRCODE = '55000';
  END IF;

  IF p_action_type = 'CYCLE_ACCESS_PORT' THEN
    IF p_interface_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.network_interfaces interface
      WHERE interface.organization_id = p_organization_id
        AND interface.building_id = p_building_id
        AND interface.device_id = p_device_id
        AND interface.id = p_interface_id
        AND interface.interface_role = 'ACCESS'
        AND NOT interface.is_protected
        AND interface.is_enabled
    ) THEN
      RAISE EXCEPTION 'Access-port target is invalid or protected'
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_interface_id IS NOT NULL THEN
    RAISE EXCEPTION 'This action does not accept an interface target'
      USING ERRCODE = '22023';
  END IF;

  SELECT command.*
  INTO v_existing
  FROM public.network_commands command
  WHERE command.organization_id = p_organization_id
    AND command.requested_by = p_requested_by
    AND command.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'Idempotency key reused with different command input'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  INSERT INTO public.network_commands (
    organization_id, building_id, device_id, interface_id, action_type, reason,
    sanitized_parameters, target_display, requested_by, request_hash,
    idempotency_key, available_at
  ) VALUES (
    p_organization_id, p_building_id, p_device_id, p_interface_id, p_action_type,
    p_reason, p_parameters, p_target_display, p_requested_by, p_request_hash,
    p_idempotency_key, p_available_at
  )
  ON CONFLICT (organization_id, requested_by, idempotency_key) DO NOTHING
  RETURNING id INTO v_command_id;

  IF v_command_id IS NOT NULL THEN
    RETURN v_command_id;
  END IF;

  SELECT command.*
  INTO v_existing
  FROM public.network_commands command
  WHERE command.organization_id = p_organization_id
    AND command.requested_by = p_requested_by
    AND command.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF NOT FOUND OR v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'Idempotency key conflict'
      USING ERRCODE = '23505';
  END IF;
  RETURN v_existing.id;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_reclaim_expired_commands_v1(
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_command public.network_commands%ROWTYPE;
  v_attempt_id uuid;
  v_next_status text;
  v_event_kind text;
  v_reclaimed integer := 0;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'Reclaim timestamp is required' USING ERRCODE = '22023';
  END IF;

  FOR v_command IN
    SELECT command.*
    FROM public.network_commands command
    WHERE command.status IN ('LEASED', 'RUNNING', 'RECONCILING')
      AND command.lease_expires_at <= p_now
    ORDER BY command.lease_expires_at, command.id
    FOR UPDATE SKIP LOCKED
  LOOP
    v_next_status := CASE
      WHEN v_command.status = 'LEASED'
       AND v_command.attempt_count < v_command.max_attempts THEN 'RETRY_WAIT'
      WHEN v_command.status = 'LEASED' THEN 'FAILED'
      ELSE 'UNCERTAIN'
    END;
    v_event_kind := CASE
      WHEN v_next_status = 'RETRY_WAIT' THEN 'RETRY_SCHEDULED'
      WHEN v_next_status = 'FAILED' THEN 'FAILED'
      ELSE 'UNCERTAIN'
    END;

    UPDATE public.network_command_attempts attempt
    SET
      outcome = CASE
        WHEN v_next_status = 'UNCERTAIN' THEN 'UNCERTAIN'
        ELSE 'ABANDONED'
      END,
      retryable = (v_next_status = 'RETRY_WAIT'),
      error_code = 'LEASE_EXPIRED',
      error_message = CASE
        WHEN v_next_status = 'UNCERTAIN'
          THEN 'Worker lease expired after execution may have started; reconciliation is required.'
        ELSE 'Worker lease expired before completion.'
      END,
      result = jsonb_build_object('leaseExpiredAt', v_command.lease_expires_at),
      finished_at = p_now
    WHERE attempt.command_id = v_command.id
      AND attempt.lease_token = v_command.lease_token
      AND attempt.finished_at IS NULL
    RETURNING attempt.id INTO v_attempt_id;

    INSERT INTO public.network_command_events (
      organization_id, building_id, command_id, attempt_id, event_seq,
      event_kind, occurred_at, worker_id, payload
    ) VALUES (
      v_command.organization_id,
      v_command.building_id,
      v_command.id,
      v_attempt_id,
      coalesce((
        SELECT max(existing_event.event_seq) + 1
        FROM public.network_command_events existing_event
        WHERE existing_event.command_id = v_command.id
      ), 1),
      v_event_kind,
      p_now,
      v_command.lease_owner,
      jsonb_build_object(
        'previousStatus', v_command.status,
        'leaseExpiredAt', v_command.lease_expires_at,
        'nextStatus', v_next_status
      )
    );

    DELETE FROM public.network_device_leases device_lease
    WHERE device_lease.device_id = v_command.device_id
      AND device_lease.command_id = v_command.id
      AND device_lease.lease_token = v_command.lease_token
      AND device_lease.expires_at <= p_now;

    UPDATE public.network_commands command
    SET
      status = CASE
        WHEN v_command.status = 'LEASED'
         AND v_command.attempt_count < v_command.max_attempts THEN 'RETRY_WAIT'
        WHEN v_command.status = 'LEASED' THEN 'FAILED'
        ELSE 'UNCERTAIN'
      END,
      available_at = CASE
        WHEN v_next_status = 'RETRY_WAIT' THEN p_now + INTERVAL '5 seconds'
        ELSE command.available_at
      END,
      lease_token = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      reconciliation_state = CASE
        WHEN v_next_status = 'UNCERTAIN' THEN 'REQUIRED'
        ELSE command.reconciliation_state
      END,
      result = CASE
        WHEN v_next_status = 'FAILED'
          THEN jsonb_build_object('code', 'LEASE_EXPIRED', 'retryExhausted', true)
        ELSE command.result
      END,
      finished_at = CASE WHEN v_next_status = 'FAILED' THEN p_now ELSE NULL END,
      updated_at = p_now
    WHERE command.id = v_command.id;

    v_reclaimed := v_reclaimed + 1;
  END LOOP;

  RETURN v_reclaimed;
END;
$fn$;

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
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  p_worker_id := btrim(coalesce(p_worker_id, ''));
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_limit NOT BETWEEN 1 AND 20
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'Invalid command claim request' USING ERRCODE = '22023';
  END IF;

  PERFORM app_private.network_center_reclaim_expired_commands_v1(v_now);

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
          AND (
            earlier.priority > command.priority
            OR (
              earlier.priority = command.priority
              AND ROW(earlier.available_at, earlier.created_at, earlier.id)
                  < ROW(command.available_at, command.created_at, command.id)
            )
          )
      )
    ORDER BY command.priority DESC, command.available_at, command.created_at, command.id
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

DROP TRIGGER IF EXISTS network_incident_events_append_only ON public.network_incident_events;
CREATE TRIGGER network_incident_events_append_only
  BEFORE UPDATE OR DELETE ON public.network_incident_events
  FOR EACH ROW EXECUTE FUNCTION app_private.network_center_reject_append_only_mutation_v1();

DROP TRIGGER IF EXISTS network_command_events_append_only ON public.network_command_events;
CREATE TRIGGER network_command_events_append_only
  BEFORE UPDATE OR DELETE ON public.network_command_events
  FOR EACH ROW EXECUTE FUNCTION app_private.network_center_reject_append_only_mutation_v1();

DROP TRIGGER IF EXISTS network_config_snapshots_append_only ON public.network_config_snapshots;
CREATE TRIGGER network_config_snapshots_append_only
  BEFORE UPDATE OR DELETE ON public.network_config_snapshots
  FOR EACH ROW EXECUTE FUNCTION app_private.network_center_reject_append_only_mutation_v1();

DROP TRIGGER IF EXISTS network_audit_events_append_only ON public.network_audit_events;
CREATE TRIGGER network_audit_events_append_only
  BEFORE UPDATE OR DELETE ON public.network_audit_events
  FOR EACH ROW EXECUTE FUNCTION app_private.network_center_reject_append_only_mutation_v1();

DROP TRIGGER IF EXISTS network_outbox_events_append_only ON public.network_outbox_events;
CREATE TRIGGER network_outbox_events_append_only
  BEFORE UPDATE OR DELETE ON public.network_outbox_events
  FOR EACH ROW EXECUTE FUNCTION app_private.network_center_reject_append_only_mutation_v1();

DROP TRIGGER IF EXISTS network_incidents_set_updated_at ON public.network_incidents;
CREATE TRIGGER network_incidents_set_updated_at
  BEFORE UPDATE ON public.network_incidents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS network_maintenance_windows_set_updated_at ON public.network_maintenance_windows;
CREATE TRIGGER network_maintenance_windows_set_updated_at
  BEFORE UPDATE ON public.network_maintenance_windows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS network_commands_set_updated_at ON public.network_commands;
CREATE TRIGGER network_commands_set_updated_at
  BEFORE UPDATE ON public.network_commands
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS network_outbox_deliveries_set_updated_at ON public.network_outbox_deliveries;
CREATE TRIGGER network_outbox_deliveries_set_updated_at
  BEFORE UPDATE ON public.network_outbox_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS network_worker_heartbeats_set_updated_at ON public.network_worker_heartbeats;
CREATE TRIGGER network_worker_heartbeats_set_updated_at
  BEFORE UPDATE ON public.network_worker_heartbeats
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.network_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_incident_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_maintenance_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_command_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_command_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_device_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_config_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_outbox_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_worker_heartbeats ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.network_incidents FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_incident_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_maintenance_windows FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_commands FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_command_attempts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_command_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_device_leases FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_config_snapshots FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_audit_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_outbox_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_outbox_deliveries FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_worker_heartbeats FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION app_private.network_center_guard_command_immutable_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_enqueue_command_v1(uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, uuid, text, text, timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_reclaim_expired_commands_v1(timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_claim_commands_v1(text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.network_commands IS
  'Immediate allowlisted Network Center command queue. No approval state; confirmation input is validated by the public RPC and discarded.';
COMMENT ON TABLE public.network_command_events IS
  'Append-only command stage and terminal evidence.';
COMMENT ON TABLE public.network_config_snapshots IS
  'Normalized and redacted snapshots only; raw RouterOS artifacts remain outside browser-readable storage.';
COMMENT ON TABLE public.network_audit_events IS
  'Append-only immutable actor/action/target/outcome history with captured display names.';
COMMENT ON TABLE public.network_outbox_events IS
  'Immutable domain event source; delivery retries live in network_outbox_deliveries.';

COMMIT;

NOTIFY pgrst, 'reload schema';
