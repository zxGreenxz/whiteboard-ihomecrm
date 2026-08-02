-- =============================================================================
-- Network Center heartbeat: a worker may not CLAIM health over evidence of
-- failure.
--
-- 20260729136000 COALESCEs the four poll columns on the ON CONFLICT path but
-- writes `status = EXCLUDED.status` outright. That asymmetry is deliberate and
-- correct as far as it goes: the poll columns are OPTIONAL evidence, present
-- only on a heartbeat that actually ran a cycle, so a periodic heartbeat must
-- not blank them; `status` is a NOT NULL scalar that every heartbeat supplies,
-- so there is no "absent" value to coalesce against.
--
-- What that leaves unguarded is a heartbeat whose status CONTRADICTS the
-- evidence in the same row. Measured on the live production worker:
--
--     status = ONLINE, failed_poll_count = 1
--
-- because the 60 s periodic heartbeat sent a hardcoded ONLINE and overwrote the
-- DEGRADED the poll cycle had written 60 seconds earlier. Combined with retry
-- backoff dropping a failing connection out of the cycle entirely, a fleet
-- where every router was unreachable settled into
-- `ONLINE / connections=0 / successful=0 / failed=0` - byte identical to a
-- healthy fleet with nothing provisioned yet.
--
-- The worker-side fix (infra/network-center-worker/src/{polling,main}.ts)
-- derives the periodic status from the last completed cycle and keeps a
-- backed-off connection inside the configured count. This migration is the
-- half that a rollback cannot undo: rollback-vultr.ps1 restarts a PREVIOUS
-- image, and every image built before that fix still contains the hardcoded
-- ONLINE. A client-only fix is therefore disarmed at exactly the moment honest
-- health signalling matters most.
--
-- RULE (monotone, downgrade-only): a heartbeat that says ONLINE is stored - and
-- forwarded to the building-status core - as DEGRADED whenever failure evidence
-- applies to it:
--
--   * this heartbeat carries poll evidence with failedPolls > 0; or
--   * this heartbeat carries NO poll evidence and the retained evidence for
--     this exact (worker, release) already records failures.
--
-- Fresh evidence always supersedes retained evidence, so a router coming back
-- reports ONLINE on the very next cycle heartbeat - `coalesce` reads the
-- incoming count first and only falls back to the stored one.
--
-- The server never UPGRADES. DEGRADED, PAUSED and STOPPING pass through
-- untouched: PAUSED is an operator state, not a health claim (the canary is
-- deliberately PAUSED during a deploy and is gated on its poll counts, not on
-- its status), and silently promoting anything to ONLINE would be the same
-- defect in the other direction.
--
-- Additive forward fix: identical signature, so grants, dependants and the
-- Edge contract are unchanged. This migration owns the function body from here
-- on, which is what makes the stage observable to the rollout tool - the same
-- shape as 20260729140000 and 20260729143000.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729144000::bigint);

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

  -- Retained failure evidence for THIS release. A heartbeat that carries no
  -- poll evidence of its own - the 60 s periodic one - is measured against it.
  SELECT retained.failed_poll_count
  INTO v_retained_failed_poll_count
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

  -- The private core performs validation, authentication, assignment locking and
  -- the scoped building-status upsert. If it fails, no release row is written.
  -- It is handed the EFFECTIVE status, so public.network_worker_building_status
  -- - the row the UI and Realtime read - can never show ONLINE while this
  -- release's own poll evidence records failures.
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

REVOKE ALL ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) TO service_role;

COMMENT ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamptz
) IS
  'Worker heartbeat with bounded release readback. Status is downgrade-only: an ONLINE claim is stored and forwarded as DEGRADED whenever this heartbeat''s own poll evidence, or the retained evidence for the same release, records failed polls.';

COMMIT;

NOTIFY pgrst, 'reload schema';
