-- =============================================================================
-- Network Center heartbeat: a worker that reaches NOTHING may not report ONLINE.
--
-- 20260729144000 closed one half of the honesty problem: an ONLINE claim is
-- stored and forwarded as DEGRADED whenever failure evidence applies to it. It
-- cannot close the other half, because it reasons only about failures the worker
-- CHOOSES to report, and a worker that never opens a connection reports none.
--
-- MEASURED ON PRODUCTION, 2026-08-03T01:29Z, release b6bade8ab964ec3:
--
--     network_center_admin_worker_release_status_v1
--       status = ONLINE
--       connectionCount = 0, successfulPollCount = 0, failedPollCount = 0
--       expectedConnectionCount = 1          <- the server's own number
--
-- That container's mounted router-credentials.json is `{}` (3 bytes; its secret
-- generation predates the credential map), so it is structurally incapable of
-- reaching any router. It logs `configuredRouters: 0`, polls nothing, and
-- therefore fails nothing. 20260729144000's predicate is
-- `failedPolls > 0`, which is FALSE here, so it never fires; and
-- public.network_worker_building_status carries no poll columns at all, so it
-- repeats the ONLINE verbatim for both DEMO buildings. Every layer agrees, and
-- every layer is wrong, because none of them was comparing the claim against
-- anything.
--
-- 20260729143000 already computes the thing that was missing. It derives
-- `expectedConnectionCount` server-side, under the same predicate
-- public.network_center_worker_list_connections_v2 serves, precisely so a
-- deploying client cannot forge a green gate. deploy-vultr.ps1 compares the
-- reported poll evidence against it once, at promotion. Nothing compared them
-- again afterwards - so a release that PASSED that gate, or was promoted before
-- the gate existed, can drift into reaching nothing and keep reporting ONLINE
-- forever.
--
-- RULE ADDED HERE (monotone, downgrade-only, same shape as 20260729144000):
-- a heartbeat that says ONLINE is stored - and forwarded to the building-status
-- core - as DEGRADED whenever the worker's own successful-poll evidence falls
-- SHORT of the connections the server would serve it:
--
--     coalesce(this heartbeat's successfulPolls,
--              the retained successfulPolls for this release,
--              0)  <  expectedConnectionCount     ->  DEGRADED
--
-- This is the deploy gate's own standard applied continuously rather than once:
-- deploy-vultr.ps1 refuses to promote unless successfulPollCount reaches
-- expectedConnectionCount. Health therefore has ONE definition in this system
-- rather than two that can disagree the moment the gate stops watching.
--
-- SHORTFALL, NOT INEQUALITY - deliberately. The question this guard asks is "is
-- the worker covering the assignment the server gave it", so the only failing
-- direction is coverage that is too small. A report of MORE successes than
-- there are connections is left alone, for two reasons. It is not a health
-- claim: with an empty or shrunken assignment the fleet genuinely has nothing
-- unpolled, and the honest verdict for the BUILDING is still ONLINE even if the
-- worker's own counter is stale - which is exactly what it will be for one cycle
-- after a connection is disabled or a device retired. And it would not buy the
-- anti-forgery property it appears to: the worker is handed its connection list
-- by network_center_worker_list_connections_v2, so a deliberately lying worker
-- already knows the number it would have to match. What it cannot do is claim
-- coverage it never achieved while the server can count what it should have
-- reached, and that is the direction this guard closes.
-- Over-reporting therefore remains a data-quality signal rather than a health
-- signal, and is NOT claimed to be caught here.
--
-- WHY SERVER SIDE, AGAIN. The same argument 20260729144000 made applies with
-- more force here: rollback-vultr.ps1 restarts a PREVIOUS image, and the
-- offending release IS a previous image. A worker-side fix is disarmed by the
-- exact operation an operator reaches for when things are going wrong. And this
-- particular lie needs no bug at all to appear - an empty credential file, a
-- revoked router key, a dead tunnel: every one of them produces a worker that
-- honestly reports zero of everything while the server knows it should be
-- reporting one.
--
-- THE THREE LEGITIMATE STATES THAT MUST NOT BE DOWNGRADED, and how each is kept:
--
--   1. THE CANARY. deploy-vultr.ps1 starts every candidate with
--      EMERGENCY_STOP=true, and it heartbeats PAUSED (then STOPPING when it is
--      torn down). It legitimately completes no successful poll. The guard is
--      gated on `v_status = 'ONLINE'`, so PAUSED and STOPPING are never
--      touched - they are lifecycle states, not health claims, and the deploy
--      flow gates them on their poll counts instead. DEGRADED is likewise left
--      alone: this migration only ever downgrades.
--
--   2. A TRUE GREEN FIELD. A fleet with no configured connections has
--      expectedConnectionCount = 0, and nothing can fall short of zero, so the
--      heartbeat passes through as ONLINE. Zero polls out of zero connections is
--      an honest report, and 20260729143000 exists specifically so that state is
--      PROVABLE rather than waived. Reading it as failure would recreate the
--      first-deploy deadlock that migration was written to break. A green-field
--      worker that has not yet completed any cycle is ONLINE too: the coalesce
--      falls through to 0, and 0 < 0 is false. There is nothing for it to prove.
--
--   3. BEFORE THE FIRST CYCLE COMPLETES. A release that has posted no poll
--      evidence at all, on a fleet where connections ARE configured, comes out
--      DEGRADED - the coalesce falls through to 0, which is short of the
--      expectation.
--      That is the correct answer and it is 20260729144000's design, not a
--      regression of it: a worker that has not yet proved it can reach its
--      routers has not earned ONLINE. It is not sticky. The first heartbeat
--      carrying `successfulPolls = expected` reports ONLINE, because `coalesce`
--      reads the incoming count first and only falls back to the retained one. A
--      restart of an already-healthy release inherits that release's retained
--      evidence and stays ONLINE without waiting for a cycle.
--
-- ACCEPTED, DOCUMENTED TRANSIENT: enabling a new connection raises `expected`
-- immediately, while the worker only learns about it on its next
-- list_connections call. That window reports DEGRADED, which is true - the
-- worker is not yet covering its whole assignment - and it clears itself on the
-- following cycle. 20260729143000 took the same fail-closed-and-loudly position
-- for the deploy gate, deliberately declining to clamp the expectation to what
-- the worker can read back.
--
-- ONE PREDICATE, NOT TWO. The expectation moves into
-- app_private.network_center_worker_expected_connections_v1 and BOTH readers
-- call it. Leaving 20260729143000's copy inline and adding a second one to the
-- heartbeat would create two definitions of "pollable" that must agree forever
-- by hand; this repository has already been bitten several times by exactly that
-- shape. The post-condition below asserts both live bodies still route through
-- the helper, so a later CREATE OR REPLACE cannot silently fork them.
--
-- -----------------------------------------------------------------------------
-- SECOND DEFECT, INDEPENDENT, FIXED HERE TOO:
-- public.network_worker_building_status.started_at can never advance.
--
-- MEASURED ON PRODUCTION at the same instant: both DEMO buildings read
-- started_at = 2026-08-02 14:14:24.476, which is release b689bb5e's start time.
-- Three releases and eleven hours later the promoted worker started at
-- 18:10:32.52 and the column had not moved - and never could have.
--
-- The cause is `started_at = LEAST(existing, EXCLUDED)` in the ON CONFLICT of
-- the building-status upsert. That row is keyed by (organization_id,
-- building_id): it outlives every worker process, every restart and every
-- release, so LEAST pins it to the earliest start ever observed for that
-- building and each later heartbeat re-asserts the pin. An operator reading
-- "up since" is shown the start time of a process that exited hours ago.
--
-- The same LEAST is CORRECT one table over and is left alone:
-- app_private.network_worker_release_heartbeats is keyed by (worker_id,
-- worker_version), so there LEAST means "the earliest start of THIS release",
-- which is a stable identity for one release rather than an ever-older floor.
--
-- Both live writers of the building-status row carry the defect - the v2 core's
-- implementation and the bounded v1 compatibility wrapper - so both are
-- repaired, and a catalog sweep at the end refuses the migration if any live
-- network_* body still writes the LEAST form. Fixing only the reachable one
-- would leave two writers with contradictory semantics for the same column.
--
-- -----------------------------------------------------------------------------
-- WHAT IS DELIBERATELY *NOT* DONE: no poll columns are added to
-- public.network_worker_building_status.
--
-- That table is GRANT SELECT TO authenticated, gated by a permissive
-- can_do_on_building() policy plus the restrictive hide-sandbox policy from
-- 20260729142000, and it is in the supabase_realtime publication. It is the one
-- browser-visible surface in this feature, and 20260729133000 states its
-- contract in its own comment: "contains no worker identity, credential
-- material, metadata, or cross-building join key".
--
-- The question the brief asks - can it honestly report health with no poll
-- columns - has a clean answer once the guard above exists: YES, because the
-- honesty is established UPSTREAM, at the moment the row is written. The core is
-- handed the EFFECTIVE status, so `status` is no longer a claim the table
-- repeats, it is a verdict the server reached by comparing the claim against its
-- own expectation. Publishing connection/successful/failed counts as well would
-- widen a tenant-visible, realtime-replicated surface with fleet-shaped
-- operational detail, to answer a question `status` already answers. The
-- information-leak concern is not hypothetical on this exact table: it is the
-- one row 20260729142000 found to be a REAL, REACHABLE sandbox leak.
--
-- Note also that this evidence is fleet-scoped while the row is building-scoped:
-- a worker serving two buildings with one connection between them has no
-- per-building poll counts to publish. Projecting the fleet verdict onto every
-- assigned building is exactly what 20260729144000 already established, and it
-- is the conservative direction - it can only ever downgrade.
--
-- -----------------------------------------------------------------------------
-- Additive forward fix. Every signature, RETURNS type, LANGUAGE, volatility,
-- SECURITY DEFINER flag, pinned search_path and grant surface is re-declared as
-- production is MEASURED to have it and asserted back out of the catalog below.
-- The two building-status bodies are the reviewed 20260729133000 bodies with one
-- expression replaced: their pre-substitution sha256(prosrc) matches production
-- byte for byte (a5c293de… for the impl, 12043dcc… for the v1 wrapper).
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729146000::bigint);

-- Fail closed rather than replace something other than what was reviewed.
DO $preflight$
DECLARE
  v_pin record;
  v_secdef boolean;
  v_volatile "char";
  v_config text[];
  v_missing text;
BEGIN
  FOR v_pin IN
    SELECT *
    FROM (VALUES
      ('public.network_center_worker_heartbeat_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)',
       'v'::"char", ARRAY['search_path=pg_catalog']::text[]),
      ('public.network_center_worker_heartbeat_v1(text,text,text[],text,integer,jsonb,timestamp with time zone)',
       'v'::"char", ARRAY['search_path=pg_catalog']::text[]),
      ('app_private.network_center_worker_heartbeat_impl_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)',
       'v'::"char", ARRAY['search_path=pg_catalog']::text[]),
      ('public.network_center_admin_worker_release_status_v1(text,text)',
       's'::"char", ARRAY['search_path=pg_catalog']::text[])
    ) AS pin(signature, volatility, config)
  LOOP
    IF to_regprocedure(v_pin.signature) IS NULL THEN
      RAISE EXCEPTION '% is missing', v_pin.signature USING ERRCODE = '42883';
    END IF;

    -- Identify by OID. pg_get_function_identity_arguments() renders parameter
    -- NAMES too, so comparing it against a type list matches nothing and every
    -- assertion below it becomes vacuous.
    SELECT proc.prosecdef, proc.provolatile, proc.proconfig
    INTO v_secdef, v_volatile, v_config
    FROM pg_proc proc
    WHERE proc.oid = to_regprocedure(v_pin.signature);

    IF v_secdef IS NOT TRUE THEN
      RAISE EXCEPTION '% lost SECURITY DEFINER before the fix', v_pin.signature
        USING ERRCODE = '42501';
    END IF;
    IF v_volatile <> v_pin.volatility THEN
      RAISE EXCEPTION '% volatility is %, not the pinned %',
        v_pin.signature, v_volatile, v_pin.volatility
        USING ERRCODE = '42501';
    END IF;
    IF v_config IS DISTINCT FROM v_pin.config THEN
      RAISE EXCEPTION '% proconfig is %, not the pinned %',
        v_pin.signature, coalesce(v_config::text, '<null>'), v_pin.config::text
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOR v_missing IN
    SELECT relation
    FROM unnest(ARRAY[
      'public.network_device_connections',
      'public.network_devices',
      'public.network_site_settings',
      'public.network_worker_assignments',
      'public.network_workers',
      'public.network_worker_building_status',
      'app_private.network_worker_release_heartbeats'
    ]) AS relation
    WHERE to_regclass(relation) IS NULL
  LOOP
    RAISE EXCEPTION 'Relation % named by this migration is missing', v_missing
      USING ERRCODE = '42P01';
  END LOOP;
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- app_private.network_center_worker_expected_connections_v1(uuid, timestamptz)
--
-- The single definition of "connections PostgreSQL would serve this worker and
-- its polling cycle would actually attempt". Lifted verbatim from
-- 20260729143000's connection_evidence lateral; the only change is that the
-- worker arrives as a parameter instead of an outer join column, so the
-- predicate can be evaluated from the heartbeat as well as from the readback.
--
-- STABLE and read-only on purpose: it is called from a STABLE SECURITY DEFINER
-- function that PostgREST may execute inside a READ ONLY transaction, so it must
-- take no row locks (scripts/check-stable-fn-locks.mjs enforces that class).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.network_center_worker_expected_connections_v1(
  p_worker_id uuid,
  p_now timestamptz
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_expected integer;
BEGIN
  -- NULL in, NULL out - never 0. A 0 here would read as "this worker has
  -- nothing to poll", which is the one answer that makes the honesty guard
  -- accept a claim it could not check. Both callers pass a non-null worker id
  -- from a join key or an authenticated principal, so this branch is defensive
  -- only; it is written in the fail-closed direction on purpose.
  IF p_worker_id IS NULL OR p_now IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*)::integer
  INTO v_expected
  FROM (
    SELECT DISTINCT connection.id
    FROM public.network_device_connections connection
    JOIN public.network_devices device
      ON device.organization_id = connection.organization_id
     AND device.building_id = connection.building_id
     AND device.id = connection.device_id
    JOIN public.network_worker_assignments assignment
      ON assignment.worker_id = p_worker_id
     AND assignment.organization_id = connection.organization_id
     AND assignment.building_id = connection.building_id
     AND assignment.device_id = connection.device_id
     AND assignment.can_poll
     AND assignment.active_from <= p_now
     AND (
       assignment.active_until IS NULL
       OR assignment.active_until > p_now
     )
    JOIN public.network_workers worker
      ON worker.id = assignment.worker_id
     AND worker.status IN ('ACTIVE', 'DRAINING')
     AND 'POLL' = ANY(worker.capabilities)
    LEFT JOIN public.network_site_settings settings
      ON settings.organization_id = connection.organization_id
     AND settings.building_id = connection.building_id
    WHERE connection.is_enabled
      AND device.is_active
      AND device.device_kind = 'MIKROTIK'
      AND connection.transport = 'ROUTEROS_SSH'
      AND coalesce(settings.monitoring_enabled, true)
  ) pollable_connections;
  RETURN v_expected;
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.network_center_worker_expected_connections_v1(
  uuid, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.network_center_worker_expected_connections_v1(
  uuid, timestamptz
) IS
  'Server-derived count of the pollable connections PostgreSQL would serve this worker, under the same predicate network_center_worker_list_connections_v2 uses, narrowed to the MIKROTIK/ROUTEROS_SSH subset the polling cycle attempts. Single source for both the deployment readback and the heartbeat honesty guard.';

-- ---------------------------------------------------------------------------
-- public.network_center_admin_worker_release_status_v1(text, text)
--
-- 20260729143000's body with its connection_evidence lateral replaced by a call
-- to the helper above. Nothing else changes: same signature, same returned
-- keys in the same order, same assignment evidence, same volatility and grants.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.network_center_admin_worker_release_status_v1(
  p_worker_key text,
  p_worker_version text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_release_heartbeat jsonb;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF p_worker_key IS NULL
     OR p_worker_key !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
     OR p_worker_version IS NULL
     OR octet_length(p_worker_version) <> 40
     OR p_worker_version !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'Invalid worker release status request'
      USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object(
    'schemaVersion', 1,
    'workerKey', worker.worker_key,
    'displayName', worker.display_name,
    'workerVersion', heartbeat.worker_version,
    'status', heartbeat.status,
    'heartbeatAt', heartbeat.heartbeat_at,
    'startedAt', heartbeat.started_at,
    'assignedBuildingCount', heartbeat.assigned_building_count,
    'activeAssignedBuildingCount',
      assignment_evidence.active_assigned_building_count,
    'activeAssignmentCount', assignment_evidence.active_assignment_count,
    'activeAssignmentHash', assignment_evidence.active_assignment_hash,
    'expectedConnectionCount',
      app_private.network_center_worker_expected_connections_v1(
        worker.id, v_now
      ),
    'connectionCount', heartbeat.connection_count,
    'successfulPollCount', heartbeat.successful_poll_count,
    'failedPollCount', heartbeat.failed_poll_count,
    'pollObservedAt', heartbeat.poll_observed_at
  )
  INTO v_release_heartbeat
  FROM app_private.network_worker_release_heartbeats heartbeat
  JOIN public.network_workers worker ON worker.id = heartbeat.worker_id
  CROSS JOIN LATERAL (
    WITH effective_assignments AS MATERIALIZED (
      SELECT assignment.organization_id,
        assignment.building_id,
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
          coalesce(
            to_char(
              assignment.active_until AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ),
            '-'
          )
        ) AS canonical_row
      FROM public.network_worker_assignments assignment
      WHERE assignment.worker_id = worker.id
        AND worker.status IN ('ACTIVE', 'DRAINING')
        AND 'HEARTBEAT' = ANY(worker.capabilities)
        AND assignment.active_from <= v_now
        AND (
          assignment.active_until IS NULL
          OR assignment.active_until > v_now
        )
        AND (
          assignment.can_poll OR assignment.can_inventory
          OR assignment.can_execute
        )
    )
    SELECT count(DISTINCT (organization_id, building_id))::integer
        AS active_assigned_building_count,
      count(*)::integer AS active_assignment_count,
      encode(
        extensions.digest(
          convert_to(
            coalesce(string_agg(
              canonical_row,
              E'\n' ORDER BY canonical_row COLLATE "C"
            ), ''),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) AS active_assignment_hash
    FROM effective_assignments
  ) assignment_evidence
  WHERE worker.worker_key = p_worker_key
    AND heartbeat.worker_version = p_worker_version;

  RETURN v_release_heartbeat;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- public.network_center_worker_heartbeat_v2(...)
--
-- 20260729144000's body plus the coverage guard. The failure guard it already
-- carries is left exactly as it was: the two rules are independent and both
-- downgrade-only, so ONLINE now requires BOTH `failedPolls = 0` AND
-- `successfulPolls >= expected` - which is, byte for byte, what the promote gate
-- in deploy-vultr.ps1 demands.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.network_center_worker_heartbeat_v2(
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
  -- Retention bounds. `c_rollback_reachable_releases` is the number of most
  -- recently active releases per worker that stay immune to age-based expiry
  -- because the host may still name them as a rollback target; it must stay
  -- strictly below `c_release_retention_limit` so the hard cap can never evict
  -- a reachable target either.
  c_rollback_reachable_releases constant integer := 5;
  c_release_retention_limit constant integer := 20;
  c_release_retention_max_age constant interval := INTERVAL '30 days';
  v_result jsonb;
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_registry_capabilities text[];
  v_now timestamptz := clock_timestamp();
  v_worker_version text := p_worker_version;
  v_status text := upper(btrim(coalesce(p_status, '')));
  v_assigned_building_count integer;
  v_connection_count integer;
  v_successful_poll_count integer;
  v_failed_poll_count integer;
  v_poll_observed_at timestamptz;
  v_retained_failed_poll_count integer;
  v_retained_successful_poll_count integer;
  v_expected_connection_count integer;
BEGIN
  -- Validate the raw release identity before calling the mutation-capable core.
  -- Trimming or case-folding would let a different deploy artifact claim proof.
  IF p_worker_version IS NULL
     OR octet_length(p_worker_version) <> 40
     OR p_worker_version !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'Invalid worker release version' USING ERRCODE = '22023';
  END IF;

  -- Poll-evidence parsing runs BEFORE the core now, because the effective
  -- status is derived from it and the core is what writes the building status
  -- an operator reads. The block itself is unchanged from 20260729136000; only
  -- its position moved. It stays fail-closed, and it now also fails closed
  -- earlier, before any building-status row is touched.
  IF p_safe_metadata ?| ARRAY[
    'connections', 'successfulPolls', 'failedPolls'
  ] THEN
    -- `?|`/`?&` test key EXISTENCE and ignore the value, so a JSON null passes
    -- both. Left unguarded, `->>` then yields SQL NULL, the integer casts below
    -- raise nothing, and the range comparison evaluates to NULL rather than TRUE
    -- (`NULL NOT BETWEEN ...` is NULL), so PL/pgSQL takes the ELSE branch and
    -- stamps poll_observed_at as if fresh evidence had been supplied. Only the
    -- all-or-nothing poll metrics CHECK then stops the write, and it does so as
    -- an opaque 23514 from inside the INSERT rather than the documented 22023 -
    -- so validation correctness would rest entirely on a storage constraint
    -- that is not part of this guard. Reject JSON null here instead, with the
    -- same clear error as a missing key.
    IF NOT (p_safe_metadata ?& ARRAY[
      'connections', 'successfulPolls', 'failedPolls'
    ])
       OR p_safe_metadata->>'connections' IS NULL
       OR p_safe_metadata->>'successfulPolls' IS NULL
       OR p_safe_metadata->>'failedPolls' IS NULL THEN
      RAISE EXCEPTION 'Incomplete worker poll evidence'
        USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_connection_count := (p_safe_metadata->>'connections')::integer;
      v_successful_poll_count := (p_safe_metadata->>'successfulPolls')::integer;
      v_failed_poll_count := (p_safe_metadata->>'failedPolls')::integer;
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Invalid worker poll evidence'
          USING ERRCODE = '22023';
    END;
    -- Fail closed on any residual NULL: a three-way comparison result is not
    -- TRUE and must never be read as "the range check passed".
    IF v_connection_count IS NULL
       OR v_successful_poll_count IS NULL
       OR v_failed_poll_count IS NULL
       OR v_connection_count NOT BETWEEN 0 AND 500
       OR v_successful_poll_count NOT BETWEEN 0 AND 500
       OR v_failed_poll_count NOT BETWEEN 0 AND 500
       OR v_successful_poll_count + v_failed_poll_count <> v_connection_count THEN
      RAISE EXCEPTION 'Invalid worker poll evidence'
        USING ERRCODE = '22023';
    END IF;
    v_poll_observed_at := v_now;
  END IF;

  -- The worker principal stays derived server-side from the credential digest.
  -- Deriving it here rather than after the core call is what lets the retained
  -- evidence be consulted before the building status is written; the core
  -- authenticates again with the same digest, so the trust boundary is
  -- unchanged and a bad digest still raises 28000 before anything is written.
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_registry_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  IF v_worker_id IS NULL THEN
    RAISE EXCEPTION 'Invalid worker release heartbeat result'
      USING ERRCODE = '22023';
  END IF;

  -- Retained evidence for THIS release. A heartbeat that carries no poll
  -- evidence of its own - the 60 s periodic one - is measured against it.
  SELECT retained.failed_poll_count, retained.successful_poll_count
  INTO v_retained_failed_poll_count, v_retained_successful_poll_count
  FROM app_private.network_worker_release_heartbeats retained
  WHERE retained.worker_id = v_worker_id
    AND retained.worker_version = v_worker_version;

  -- Downgrade only, never upgrade. `coalesce` prefers this heartbeat's own
  -- count, so recovery is reported immediately and only a heartbeat that
  -- brought no evidence inherits the stored verdict.
  IF v_status = 'ONLINE'
     AND coalesce(v_failed_poll_count, v_retained_failed_poll_count, 0) > 0 THEN
    v_status := 'DEGRADED';
  END IF;

  -- Coverage. Failures the worker never attempted are failures it cannot
  -- report, so the claim is also measured against the number of connections
  -- PostgreSQL itself would serve this worker. The expectation is only computed
  -- on the ONLINE path: PAUSED, STOPPING and an already-DEGRADED heartbeat are
  -- never relabelled, and the query is not worth running for them.
  --
  -- Fail closed on a NULL expectation. `0 < NULL` is NULL, PL/pgSQL would take
  -- the ELSE branch, and a guard that cannot compute its own expectation would
  -- silently wave the claim through - the precise failure mode this migration
  -- exists to remove.
  IF v_status = 'ONLINE' THEN
    v_expected_connection_count :=
      app_private.network_center_worker_expected_connections_v1(
        v_worker_id, v_now
      );
    IF v_expected_connection_count IS NULL
       OR coalesce(
         v_successful_poll_count, v_retained_successful_poll_count, 0
       ) < v_expected_connection_count THEN
      v_status := 'DEGRADED';
    END IF;
  END IF;

  -- The private core performs validation, authentication, assignment locking and
  -- the scoped building-status upsert. If it fails, no release row is written.
  -- It is handed the EFFECTIVE status, so public.network_worker_building_status
  -- - the row the UI and Realtime read - can never show ONLINE while this
  -- release's own poll evidence records failures, nor while that evidence falls
  -- short of the connections the server would serve it.
  v_result := app_private.network_center_worker_heartbeat_core_v2(
    p_credential_digest,
    p_worker_version,
    p_capabilities,
    v_status,
    p_queue_age_seconds,
    p_safe_metadata,
    p_started_at
  );

  v_assigned_building_count := nullif(
    v_result->>'assignedBuildingCount', ''
  )::integer;
  -- If the core returned an unusable shape, refuse rather than let a NOT NULL /
  -- CHECK violation decide the outcome.
  IF v_status NOT IN ('ONLINE', 'DEGRADED', 'PAUSED', 'STOPPING')
     OR p_started_at IS NULL
     OR p_started_at > v_now
     OR v_assigned_building_count IS NULL
     OR v_assigned_building_count NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Invalid worker release heartbeat result'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_private.network_worker_release_heartbeats (
    worker_id,
    worker_version,
    status,
    heartbeat_at,
    started_at,
    assigned_building_count,
    connection_count,
    successful_poll_count,
    failed_poll_count,
    poll_observed_at,
    updated_at
  ) VALUES (
    v_worker_id,
    v_worker_version,
    v_status,
    v_now,
    p_started_at,
    v_assigned_building_count,
    v_connection_count,
    v_successful_poll_count,
    v_failed_poll_count,
    v_poll_observed_at,
    v_now
  )
  ON CONFLICT (worker_id, worker_version) DO UPDATE SET
    status = EXCLUDED.status,
    heartbeat_at = EXCLUDED.heartbeat_at,
    started_at = LEAST(
      app_private.network_worker_release_heartbeats.started_at,
      EXCLUDED.started_at
    ),
    assigned_building_count = EXCLUDED.assigned_building_count,
    connection_count = coalesce(
      EXCLUDED.connection_count,
      app_private.network_worker_release_heartbeats.connection_count
    ),
    successful_poll_count = coalesce(
      EXCLUDED.successful_poll_count,
      app_private.network_worker_release_heartbeats.successful_poll_count
    ),
    failed_poll_count = coalesce(
      EXCLUDED.failed_poll_count,
      app_private.network_worker_release_heartbeats.failed_poll_count
    ),
    poll_observed_at = coalesce(
      EXCLUDED.poll_observed_at,
      app_private.network_worker_release_heartbeats.poll_observed_at
    ),
    updated_at = EXCLUDED.updated_at;

  -- Age-based expiry, but never for a release that is still a reachable
  -- rollback target. rollback-vultr.ps1 reads back BOTH the current and the
  -- previous release sha through network_center_admin_worker_release_status_v1
  -- and refuses the rollback when either row is missing. A superseded release
  -- stops heartbeating the instant it is replaced, so its heartbeat_at freezes
  -- at the promotion moment: a plain `heartbeat_at < now - 30 days` purge
  -- deletes the documented recovery evidence 30 days after promotion even
  -- though the host still holds the image and still names it as `previous`,
  -- silently disarming rollback. Ranking by heartbeat_at DESC is exactly
  -- promotion recency, so the newest releases per worker are retained
  -- regardless of age and only releases already displaced beyond the reachable
  -- rollback depth may expire by age. Growth stays bounded by the per-worker
  -- cap below, which evicts by the same rank order and therefore also never
  -- reaches a still-reachable target.
  DELETE FROM app_private.network_worker_release_heartbeats heartbeat
  USING (
    SELECT ranked.worker_id AS worker_id,
      ranked.worker_version AS worker_version,
      row_number() OVER (
        PARTITION BY ranked.worker_id
        ORDER BY ranked.heartbeat_at DESC, ranked.worker_version
      ) AS release_rank
    FROM app_private.network_worker_release_heartbeats ranked
  ) reachable
  WHERE reachable.worker_id = heartbeat.worker_id
    AND reachable.worker_version = heartbeat.worker_version
    AND reachable.release_rank > c_rollback_reachable_releases
    AND heartbeat.heartbeat_at < v_now - c_release_retention_max_age;

  DELETE FROM app_private.network_worker_release_heartbeats heartbeat
  WHERE heartbeat.worker_id = v_worker_id
    AND (heartbeat.worker_id, heartbeat.worker_version) IN (
      SELECT ranked.worker_id, ranked.worker_version
      FROM app_private.network_worker_release_heartbeats ranked
      WHERE ranked.worker_id = v_worker_id
      ORDER BY ranked.heartbeat_at DESC, ranked.worker_version
      OFFSET c_release_retention_limit
    );

  RETURN v_result || jsonb_build_object('workerVersion', v_worker_version);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- app_private.network_center_worker_heartbeat_impl_v2(...)
--
-- The reviewed 20260729133000 body, verbatim, with the building-status
-- `started_at` no longer pinned by LEAST. Nothing else in it changes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.network_center_worker_heartbeat_impl_v2(
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
  v_worker_key text;
  v_worker_status text;
  v_registry_capabilities text[];
  v_now timestamptz := clock_timestamp();
  v_status text := upper(btrim(coalesce(p_status, '')));
  v_building_count integer;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_registry_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;

  IF char_length(btrim(coalesce(p_worker_version, ''))) NOT BETWEEN 1 AND 100
     OR cardinality(coalesce(p_capabilities, ARRAY[]::text[])) > 32
     OR v_status NOT IN ('ONLINE', 'DEGRADED', 'PAUSED', 'STOPPING')
     OR p_queue_age_seconds NOT BETWEEN 0 AND 31536000
     OR p_safe_metadata IS NULL OR jsonb_typeof(p_safe_metadata) <> 'object'
     OR octet_length(p_safe_metadata::text) > 16384
     OR p_started_at IS NULL OR p_started_at > v_now THEN
    RAISE EXCEPTION 'Invalid worker heartbeat' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_assert_safe_json_v1(
    p_safe_metadata, 'worker heartbeat metadata'
  );

  WITH authorized_buildings AS MATERIALIZED (
    SELECT DISTINCT assignment.organization_id, assignment.building_id
    FROM public.network_workers worker
    JOIN public.network_worker_assignments assignment
      ON assignment.worker_id = worker.id
    WHERE worker.id = v_worker_id
      AND worker.status IN ('ACTIVE', 'DRAINING')
      AND 'HEARTBEAT' = ANY(worker.capabilities)
      AND assignment.active_from <= v_now
      AND (
        assignment.active_until IS NULL
        OR assignment.active_until > v_now
      )
      AND (
        assignment.can_poll OR assignment.can_inventory
        OR assignment.can_execute
      )
      AND app_private.network_center_worker_can_access_building_v2(
        v_worker_id, assignment.organization_id,
        assignment.building_id,
        'HEARTBEAT',
        v_now
      )
  ), upserted AS (
    INSERT INTO public.network_worker_building_status (
      organization_id, building_id, status, heartbeat_at,
      queue_age_seconds, started_at, updated_at
    )
    SELECT organization_id, building_id, v_status, v_now,
      p_queue_age_seconds, p_started_at, v_now
    FROM authorized_buildings
    ON CONFLICT (organization_id, building_id) DO UPDATE SET
      status = EXCLUDED.status,
      heartbeat_at = EXCLUDED.heartbeat_at,
      queue_age_seconds = EXCLUDED.queue_age_seconds,
      started_at = EXCLUDED.started_at,
      updated_at = EXCLUDED.updated_at
    RETURNING building_id
  )
  SELECT count(*) INTO v_building_count FROM upserted;

  IF v_building_count = 0 THEN
    RAISE EXCEPTION 'Worker has no active assigned building'
      USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'status', v_status, 'heartbeatAt', v_now,
    'assignedBuildingCount', v_building_count
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- public.network_center_worker_heartbeat_v1(...)
--
-- The bounded legacy compatibility wrapper. It has no Edge route today, so no
-- worker can drive it, but its compatibility snapshot is live (unexpired) and it
-- writes the SAME building-status row. Repaired identically so the column has
-- one meaning regardless of which writer produced it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.network_center_worker_heartbeat_v1(
  p_worker_id text,
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
  v_compat_worker_id uuid;
  v_compat_worker_key text;
  v_now timestamptz := clock_timestamp();
  v_status text := upper(btrim(coalesce(p_status, '')));
  v_count integer;
BEGIN
  SELECT compatibility.worker_id, compatibility.worker_key
  INTO v_compat_worker_id, v_compat_worker_key
  FROM app_private.network_center_compatibility_worker_v1() compatibility;
  IF char_length(btrim(coalesce(p_worker_version, ''))) NOT BETWEEN 1 AND 100
     OR cardinality(coalesce(p_capabilities, ARRAY[]::text[])) > 32
     OR v_status NOT IN ('ONLINE', 'DEGRADED', 'PAUSED', 'STOPPING')
     OR p_queue_age_seconds NOT BETWEEN 0 AND 31536000
     OR p_safe_metadata IS NULL OR jsonb_typeof(p_safe_metadata) <> 'object'
     OR p_started_at IS NULL OR p_started_at > v_now THEN
    RAISE EXCEPTION 'Invalid worker heartbeat' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_assert_safe_json_v1(
    p_safe_metadata, 'worker heartbeat metadata'
  );

  WITH snapshot_assignments AS MATERIALIZED (
    SELECT assignment.organization_id, assignment.building_id
    FROM app_private.network_worker_compatibility_state state
    JOIN public.network_worker_assignments assignment
      ON assignment.worker_id = state.worker_id
    WHERE state.singleton AND state.worker_id = v_compat_worker_id
      AND state.finalized_at IS NULL AND state.expires_at > v_now
      AND assignment.can_poll
      AND assignment.active_from <= v_now
      AND assignment.active_until > v_now
      AND state.assignment_snapshot @> jsonb_build_array(jsonb_build_object(
        'assignmentId', assignment.id,
        'organizationId', assignment.organization_id,
        'buildingId', assignment.building_id,
        'deviceId', assignment.device_id
      ))
  ), upserted AS (
    INSERT INTO public.network_worker_building_status (
      organization_id, building_id, status, heartbeat_at,
      queue_age_seconds, started_at, updated_at
    )
    SELECT DISTINCT organization_id, building_id, v_status, v_now,
      p_queue_age_seconds, p_started_at, v_now
    FROM snapshot_assignments
    ON CONFLICT (organization_id, building_id) DO UPDATE SET
      status = EXCLUDED.status, heartbeat_at = EXCLUDED.heartbeat_at,
      queue_age_seconds = EXCLUDED.queue_age_seconds,
      started_at = EXCLUDED.started_at, updated_at = EXCLUDED.updated_at
    RETURNING building_id
  ) SELECT count(*) INTO v_count FROM upserted;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'Legacy compatibility has no active snapshot assignment'
      USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'status', v_status, 'heartbeatAt', v_now,
    'assignedBuildingCount', v_count
  );
END;
$fn$;

-- The grant surface is re-declared rather than inherited. CREATE OR REPLACE
-- preserves an existing ACL, so this is belt and braces - but a body-only
-- forward fix is exactly the shape that drifts silently, and the assertions
-- below would rather fail the migration than ship a widened definer.
REVOKE ALL ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_heartbeat_v1(
  text, text, text[], text, integer, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_heartbeat_v1(
  text, text, text[], text, integer, jsonb, timestamptz
) TO service_role;

REVOKE ALL ON FUNCTION app_private.network_center_worker_heartbeat_impl_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.network_center_admin_worker_release_status_v1(
  text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_worker_release_status_v1(
  text, text
) TO service_role;

COMMENT ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) IS
  'Worker heartbeat with bounded release readback. Status is downgrade-only: an ONLINE claim is stored and forwarded as DEGRADED whenever this heartbeat''s own poll evidence, or the retained evidence for the same release, records failed polls, or whenever its successful poll count falls short of the server-derived count of connections PostgreSQL would serve this worker.';

COMMENT ON FUNCTION public.network_center_admin_worker_release_status_v1(text, text) IS
  'Service-role-only exact worker and release readback with canonical active-assignment evidence and the server-derived expected pollable connection count the deployment gate compares the reported poll evidence against. The expectation comes from app_private.network_center_worker_expected_connections_v1, the same predicate the heartbeat honesty guard uses.';

-- Post-condition. Everything this migration claims to have preserved is read
-- back out of the catalog, and every repaired token is asserted live. A
-- CREATE OR REPLACE that silently dropped SET search_path would otherwise leave
-- a SECURITY DEFINER function resolving names through the caller's search_path.
DO $runtime_proof$
DECLARE
  v_pin record;
  v_secdef boolean;
  v_volatile "char";
  v_config text[];
  v_src text;
  v_role text;
BEGIN
  FOR v_pin IN
    SELECT *
    FROM (VALUES
      ('public.network_center_worker_heartbeat_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)',
       'v'::"char", ARRAY['search_path=pg_catalog']::text[],
       'network_center_worker_expected_connections_v1',
       ARRAY['service_role']::text[]),
      ('public.network_center_admin_worker_release_status_v1(text,text)',
       's'::"char", ARRAY['search_path=pg_catalog']::text[],
       'network_center_worker_expected_connections_v1',
       ARRAY['service_role']::text[]),
      ('app_private.network_center_worker_heartbeat_impl_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)',
       'v'::"char", ARRAY['search_path=pg_catalog']::text[],
       'started_at = EXCLUDED.started_at',
       ARRAY[]::text[]),
      ('public.network_center_worker_heartbeat_v1(text,text,text[],text,integer,jsonb,timestamp with time zone)',
       'v'::"char", ARRAY['search_path=pg_catalog']::text[],
       'started_at = EXCLUDED.started_at',
       ARRAY['service_role']::text[]),
      ('app_private.network_center_worker_expected_connections_v1(uuid,timestamp with time zone)',
       's'::"char", ARRAY['search_path=pg_catalog']::text[],
       'pollable_connections',
       ARRAY[]::text[])
    ) AS pin(signature, volatility, config, fix_token, grantees)
  LOOP
    SELECT proc.prosecdef, proc.provolatile, proc.proconfig, proc.prosrc
    INTO v_secdef, v_volatile, v_config, v_src
    FROM pg_proc proc
    WHERE proc.oid = to_regprocedure(v_pin.signature);

    IF NOT FOUND
       OR v_secdef IS NOT TRUE
       OR v_volatile <> v_pin.volatility
       OR v_config IS DISTINCT FROM v_pin.config THEN
      RAISE EXCEPTION 'Definer profile of % regressed (secdef=%, volatile=%, config=%)',
        v_pin.signature, v_secdef, v_volatile, coalesce(v_config::text, '<null>')
        USING ERRCODE = '42501';
    END IF;

    IF position(v_pin.fix_token in v_src) = 0 THEN
      RAISE EXCEPTION 'The repaired expression % is not in the live body of %',
        v_pin.fix_token, v_pin.signature
        USING ERRCODE = '22023';
    END IF;

    FOREACH v_role IN ARRAY ARRAY['public', 'anon', 'authenticated', 'service_role']
    LOOP
      IF has_function_privilege(v_role, v_pin.signature, 'EXECUTE')
         <> (v_role = ANY(v_pin.grantees)) THEN
        RAISE EXCEPTION 'Grant surface of % changed for role %',
          v_pin.signature, v_role
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
END;
$runtime_proof$;

-- Catalog sweep, derived from the LIVE catalog rather than a hand-written list:
-- refuse the migration if ANY live function body still pins the building-status
-- start time with LEAST. A writer added later is covered automatically, which a
-- literal two-function list would not be. The sibling
-- app_private.network_worker_release_heartbeats.started_at LEAST is deliberately
-- NOT matched: that row is keyed by release, where taking the earliest start is
-- correct.
DO $started_at_pin_sweep$
DECLARE
  v_offender text;
BEGIN
  SELECT string_agg(
    schema_row.nspname || '.' || function_row.proname, ', '
    ORDER BY schema_row.nspname || '.' || function_row.proname
  )
  INTO v_offender
  FROM pg_proc function_row
  JOIN pg_namespace schema_row ON schema_row.oid = function_row.pronamespace
  WHERE schema_row.nspname IN ('public', 'app_private')
    AND function_row.prosrc IS NOT NULL
    AND function_row.prosrc ~
      'LEAST\(\s*public\.network_worker_building_status\.started_at';
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION
      'A live function still pins public.network_worker_building_status.started_at with LEAST: %',
      v_offender
      USING ERRCODE = '22023';
  END IF;
END;
$started_at_pin_sweep$;

-- Second sweep: the poll expectation must have exactly ONE definition. If a
-- later change re-inlines the predicate into either reader, the helper stops
-- being the single source and the two copies start drifting apart silently.
-- Asserting the helper is REACHED beats asserting the text is absent, so this
-- names the callers rather than hunting for a duplicated query shape.
DO $single_expectation_predicate$
DECLARE
  v_caller text;
  v_src text;
BEGIN
  FOREACH v_caller IN ARRAY ARRAY[
    'public.network_center_admin_worker_release_status_v1(text,text)',
    'public.network_center_worker_heartbeat_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)'
  ]
  LOOP
    SELECT proc.prosrc INTO v_src
    FROM pg_proc proc
    WHERE proc.oid = to_regprocedure(v_caller);
    IF v_src IS NULL
       OR position(
         'app_private.network_center_worker_expected_connections_v1' in v_src
       ) = 0 THEN
      RAISE EXCEPTION
        '% no longer derives the poll expectation from the shared predicate',
        v_caller
        USING ERRCODE = '22023';
    END IF;
    IF position('pollable_connections' in v_src) <> 0 THEN
      RAISE EXCEPTION
        '% carries its own inline copy of the pollable-connection predicate',
        v_caller
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$single_expectation_predicate$;

COMMIT;

NOTIFY pgrst, 'reload schema';
