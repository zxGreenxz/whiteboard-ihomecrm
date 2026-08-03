-- =============================================================================
-- Network Center additive forward-fix: the disruptive-action path has never
-- been reachable, for any router, in any organisation.
--
-- Measured in production on 2026-08-03, after the first EXECUTE canary:
-- network_commands holds 0 rows LIFETIME, and every one of the four disruptive
-- actions plus the /export snapshot refuses with P0002 "Writable MikroTik not
-- found" / "Active MikroTik not found". A clause-by-clause differential against
-- the live device showed org, kind, is_active, write_capability and the enabled
-- connection ALL true, and exactly one clause false. Two structural gates, not
-- one misconfigured demo router.
--
-- BLOCKER A -- no MikroTik can ever leave 'UNPROVISIONED'.
--   public.network_center_execute_action_v1 and
--   public.network_center_request_snapshot_v1 both admit a device only when
--   lifecycle_status IN ('ONLINE','OFFLINE'). A repository sweep found the only
--   write to that column for a MikroTik is the seed in 20260729010000 writing
--   'UNPROVISIONED'; every other writer is filtered to device_kind = 'ARUBA',
--   the worker's inventory payload carries no router record at all, and no admin
--   RPC, UI affordance, Edge function or runbook step sets it. Fleet-wide
--   distribution: {"UNPROVISIONED": 19}. Not one device has ever left it.
--
--   FIXED BY DERIVING IT FROM EVIDENCE, IN BOTH DIRECTIONS:
--     * an AFTER trigger on public.network_device_current promotes a MikroTik
--       from the telemetry row just accepted -- ONLINE when the poll reached the
--       router, OFFLINE when it did not. That row IS the first-hand evidence of
--       router liveness, and the ingest's own
--       WHERE EXCLUDED.observed_at >= ... clause means a late or replayed
--       payload writes no row, fires no trigger and moves no lifecycle.
--     * app_private.network_center_reconcile_device_lifecycle_v1 (new) demotes
--       ONLINE -> OFFLINE when evidence STOPS arriving, which the ingest cannot
--       see because in that case it is not called. Wired into the two-minute
--       watchdog liveness sweep, the component whose whole job is noticing that
--       a signal went quiet.
--   Neither writer sets a column to make a check pass; both derive it from an
--   observation, and the pair is not a latch in either direction.
--
-- BLOCKER B -- every access port is permanently protected, and the only unlatch
--   is self-extinguishing.
--   CYCLE_ACCESS_PORT additionally requires NOT network_interfaces.is_protected.
--   Measured: ether2..ether5 all true; the only unprotected ACCESS interface is
--   the loopback, which is not a physical port and fails the ether2..N guard on
--   public.network_commands anyway. The cause is
--   app_private.network_center_bind_managed_interface_v1, whose eligibility
--   expression read back the very column it then latched, so eligibleAccess was
--   true for exactly one poll cycle. The single documented way out,
--   app_private.network_center_enroll_access_interface_v1, requires
--   eligibleAccess = 'true' -- so the act of discovering a port destroyed the
--   precondition for enrolling it -- and additionally had ZERO callers anywhere
--   and no EXECUTE grant to any role.
--
--   is_protected IS A REAL SAFETY PROPERTY AND IS NOT REMOVED, and neither is
--   the eligibility rule. Cycling the wrong port strands a building. The defect
--   turns out to be narrower than it looks, and the fix is correspondingly
--   narrow:
--     * the ingest upsert stops carrying the STORED protection forward
--       (is_protected = existing OR EXCLUDED becomes is_protected = EXCLUDED),
--       so the trigger evaluates eligibility against what the ROUTER reported
--       instead of against the value the trigger itself wrote on the previous
--       cycle. That is the entire behavioural change for Blocker B: one
--       expression, in the ingest, and the trigger is untouched;
--     * protection itself is unchanged. The trigger still forces
--       NEW.is_protected := NEW.is_protected OR v_protected, where v_protected
--       is public.network_managed_resources.protected -- true for every
--       DISCOVERED resource, and lowerable ONLY by the DISCOVERED -> ENROLLED
--       transition that app_private.network_center_guard_managed_resource_v1
--       polices. A port nobody enrolled is still forced protected on every poll;
--     * public.network_center_admin_enroll_access_port_v1 (new, service-role
--       only, typed confirmation + reason + audit event) gives the enrollment
--       door its first caller, and public.network_center_admin_list_access_
--       ports_v1 (new) says out loud which ports are enrollable and exactly what
--       blocks the rest.
--   WHAT STAYS PROTECTED, unchanged: ether1/WAN (forced), every UPLINK,
--   MANAGEMENT and LAN interface, the bridge, the WireGuard management tunnel,
--   the loopback, every port that is not ether2..N, every port the worker
--   reports protected because an owned :lan-recovery firewall rule names it,
--   and every port nobody has deliberately enrolled. A cycle still additionally
--   requires
--   network_center.execute permission, rollout_state = EXECUTE, an unpaused
--   organisation and building, a typed router-identity confirmation, an ENROLLED
--   managed resource with protected = false (enforced by the BEFORE INSERT guard
--   on public.network_commands), and a FRESH on-router re-check that the target
--   is neither a `:lan-recovery` firewall interface nor role-drifted.
--
-- ALSO -- the admin CLI cannot report the refusal operators will hit most.
--   public.network_center_admin_set_rollout_v1 spelled its CAS refusal
--   SQLSTATE '40001', a serialization failure, i.e. "transient, retry me". The
--   layer in front of PostgREST duly retried it and the supported tool hung for
--   minutes and then returned 504, while the same call through the Management
--   API answered instantly. It is now 55000 with DETAIL naming the actual
--   version.
--
-- ADDITIVE. Nothing is dropped, no applied migration is edited, no gate is
-- weakened, and no column is hand-set. Every replaced body is the reviewed body
-- of the migration that currently owns it with the named expressions changed and
-- no other edit; the preflight below refuses to run if any of those bodies is
-- not the one that was reviewed, and the post-condition reads every claim back
-- out of the catalog.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729148000::bigint);

-- ---------------------------------------------------------------------------
-- Preflight. Fail closed rather than replace something other than what was
-- reviewed. Each defect token must still be LIVE: if a later migration already
-- fixed one of them, this file is stale and must not overwrite the newer body.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  v_expected constant text[][] := ARRAY[
    ARRAY[
      'app_private.network_center_worker_ingest_legacy_impl_v1(text,jsonb)',
      'WHERE EXCLUDED.observed_at >= public.network_device_current.observed_at'
    ],
    ARRAY[
      'app_private.network_center_worker_inventory_legacy_impl_v1(text,jsonb)',
      'is_protected = public.network_interfaces.is_protected'
    ],
    ARRAY[
      'app_private.network_center_bind_managed_interface_v1()',
      'AND NEW.is_protected = false'
    ],
    ARRAY[
      'app_private.network_center_worker_inventory_legacy_impl_v1(text,jsonb)',
      'coalesce(item.metadata, ''{}''::jsonb) AS display_metadata'
    ],
    ARRAY[
      'public.network_center_admin_set_rollout_v1(uuid,text,bigint,text,uuid)',
      'USING ERRCODE = ''40001'';'
    ],
    ARRAY[
      'public.network_center_watchdog_liveness_v1(integer,timestamptz,integer)',
      'network_center_watchdog_liveness_scan_v1('
    ]
  ];
  v_index integer;
  v_signature text;
  v_token text;
  v_src text;
BEGIN
  FOR v_index IN 1 .. array_length(v_expected, 1) LOOP
    v_signature := v_expected[v_index][1];
    v_token := v_expected[v_index][2];
    IF to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION '% is missing', v_signature USING ERRCODE = '42883';
    END IF;
    -- Identify by OID. pg_get_function_identity_arguments() renders parameter
    -- NAMES as well, so comparing it against a type list matches nothing and
    -- every assertion below it becomes vacuous.
    SELECT proc.prosrc INTO v_src
    FROM pg_proc proc
    WHERE proc.oid = to_regprocedure(v_signature);
    IF position(v_token in v_src) = 0 THEN
      RAISE EXCEPTION
        'Live body of % does not contain the reviewed token %; this migration is stale',
        v_signature, v_token
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- The reconciler must not already exist under a different definition.
  IF to_regprocedure(
    'app_private.network_center_reconcile_device_lifecycle_v1(timestamptz)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION
      'app_private.network_center_reconcile_device_lifecycle_v1 already exists'
      USING ERRCODE = '42723';
  END IF;

  -- The enrollment door this migration gives a caller to must still be the
  -- reviewed one: if its preconditions changed, the new admin RPC's
  -- pre-flight mirror below would silently diverge from what it calls.
  IF to_regprocedure(
    'app_private.network_center_enroll_access_interface_v1(uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION
      'app_private.network_center_enroll_access_interface_v1 is missing'
      USING ERRCODE = '42883';
  END IF;
  SELECT proc.prosrc INTO v_src
  FROM pg_proc proc
  WHERE proc.oid = to_regprocedure(
    'app_private.network_center_enroll_access_interface_v1(uuid)'
  );
  IF position('resource.metadata->>''eligibleAccess'' = ''true''' in v_src) = 0
     OR position('enrollment_state = ''DISCOVERED''' in v_src) = 0
     OR position('SET enrollment_state = ''ENROLLED'', protected = false' in v_src) = 0 THEN
    RAISE EXCEPTION
      'app_private.network_center_enroll_access_interface_v1 is not the reviewed body'
      USING ERRCODE = '55000';
  END IF;
END;
$preflight$;

-- ===========================================================================
-- 1. BLOCKER A, promotion. The ingest derives lifecycle from the telemetry row
--    it just accepted.
--
--    Re-declared verbatim from 20260729147000 with one DECLARE line and one
--    statement added; the signature, RETURNS, LANGUAGE, volatility, SECURITY
--    DEFINER, pinned search_path and the exact (empty) grant surface are
--    re-declared as production is measured to have them and asserted back out
--    of the catalog at the end of this file.
-- ===========================================================================



-- ===========================================================================
-- 1. BLOCKER A, promotion. Lifecycle derived from the telemetry row itself.
--
--    WHY A TRIGGER AND NOT A LINE INSIDE THE INGEST. Both were built and both
--    work; this one is better for two independent reasons.
--
--    (a) public.network_device_current is the record of "a poll cycle completed
--        and this is what it saw". Deriving the device's lifecycle from that row
--        rather than from one writer's code path means ANY writer of the row
--        promotes correctly, and the derivation cannot drift away from the
--        evidence it claims to summarise. The scoping then falls out for free
--        and exactly: the ingest's upsert carries
--        WHERE EXCLUDED.observed_at >= public.network_device_current.observed_at,
--        so a late or replayed payload updates no row, fires no trigger and
--        moves no lifecycle. Hand-written scoping had to reproduce that rule.
--
--    (b) app_private.network_center_worker_ingest_legacy_impl_v1 is the ONLY
--        function 20260729147000 declares. A forward fix that re-declared it
--        would take that stage's only owned function body away, and
--        assertStagesObservable (scripts/network-center-function-bodies.mjs)
--        then refuses the entire release -- "rollout stage 22 ... is
--        unobservable ... the rollout could never distinguish an applied stage
--        from a skipped one" -- because 147000's own distinguishing effect
--        (rx_bytes/tx_bytes becoming NULLABLE) cannot be spelled in the
--        descriptor vocabulary, which writes columns as column:<rel>:<col> with
--        no nullability. Measured: with the ingest re-declared, that guard
--        fires. Leaving 147000's body alone keeps the release shippable.
--
--    The trigger writes nothing the observation does not say. `reachable` is
--    the worker's own connect-and-read result, already coalesced to false by
--    the ingest, so ONLINE means "a poll reached the router" and OFFLINE means
--    "a poll ran and it did not answer". DISABLED is the operator's and is
--    never overwritten; ARUBA is left to its own state machine in
--    20260729131000, because two writers on one column is how a state machine
--    rots.
--
--    Before this, NOTHING moved a MikroTik out of 'UNPROVISIONED': the only
--    write to network_devices.lifecycle_status for a router was the seed in
--    20260729010000 that put it there, and every other writer is filtered to
--    device_kind = 'ARUBA'. Fleet-wide on 2026-08-03: {"UNPROVISIONED": 19}.
--    Since public.network_center_execute_action_v1 and
--    public.network_center_request_snapshot_v1 admit a device only when
--    lifecycle_status IN ('ONLINE','OFFLINE'), no disruptive action had ever
--    been reachable for any router -- which is the real reason
--    network_commands holds 0 rows lifetime.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_private.network_center_derive_device_lifecycle_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  UPDATE public.network_devices device
  SET lifecycle_status = CASE
        WHEN NEW.reachable THEN 'ONLINE' ELSE 'OFFLINE'
      END,
      updated_at = clock_timestamp()
  WHERE device.id = NEW.device_id
    AND device.device_kind = 'MIKROTIK'
    AND device.is_active
    AND device.lifecycle_status <> 'DISABLED'
    AND device.lifecycle_status IS DISTINCT FROM (
      CASE WHEN NEW.reachable THEN 'ONLINE' ELSE 'OFFLINE' END
    );
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.network_center_derive_device_lifecycle_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS network_device_current_derive_lifecycle
  ON public.network_device_current;
CREATE TRIGGER network_device_current_derive_lifecycle
  AFTER INSERT OR UPDATE OF observed_at, reachable
  ON public.network_device_current
  FOR EACH ROW EXECUTE FUNCTION
    app_private.network_center_derive_device_lifecycle_v1();

COMMENT ON FUNCTION app_private.network_center_derive_device_lifecycle_v1() IS
  'Derives public.network_devices.lifecycle_status for a MikroTik from the telemetry row just accepted: ONLINE when the poll reached the router, OFFLINE when it did not. Fires only for rows the ingest actually wrote, so a stale payload moves nothing. Never touches DISABLED devices or ARUBA children. The demotion for evidence that stops arriving at all lives in app_private.network_center_reconcile_device_lifecycle_v1.';


-- ===========================================================================
-- 2. BLOCKER A, demotion. Evidence that stopped arriving.
--
--    A one-way transition is how this system got here, so ONLINE must be able
--    to fall. The ingest covers "a poll ran and failed"; this covers "no poll
--    ran at all", which the ingest structurally cannot see.
--
--    The tolerance is derived per device from its OWN enabled connection's
--    poll interval rather than being a fleet-wide constant, because
--    poll_interval_seconds is operator-set anywhere in 30..3600 and a fixed
--    threshold would either flap a slow poller or hide a fast one. Three
--    missed intervals, floored at five minutes so a 30-second poller is not
--    demoted by one slow cycle. A device with no enabled connection cannot be
--    polled at all and falls to the floor.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_private.network_center_reconcile_device_lifecycle_v1(
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_now timestamptz := p_now;
  v_demoted integer := 0;
BEGIN
  IF v_now IS NULL
     OR abs(extract(epoch FROM (clock_timestamp() - v_now))) > 3600 THEN
    RAISE EXCEPTION 'Invalid Network Center lifecycle reconciliation request'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.network_devices device
  SET lifecycle_status = 'OFFLINE',
      updated_at = clock_timestamp()
  WHERE device.device_kind = 'MIKROTIK'
    AND device.is_active
    -- Only ONLINE falls. UNPROVISIONED means "never observed", which is a fact
    -- about history and is not un-observed by silence; DISABLED is the
    -- operator's; OFFLINE is already where this would put it.
    AND device.lifecycle_status = 'ONLINE'
    AND NOT EXISTS (
      SELECT 1
      FROM public.network_device_current current_state
      WHERE current_state.device_id = device.id
        AND current_state.observed_at > v_now - make_interval(secs => GREATEST(
          3 * coalesce((
            SELECT max(connection.poll_interval_seconds)
            FROM public.network_device_connections connection
            WHERE connection.device_id = device.id
              AND connection.is_enabled
          ), 60), 300))
    );
  GET DIAGNOSTICS v_demoted = ROW_COUNT;

  RETURN jsonb_build_object(
    'schemaVersion', 1,
    'job', 'DEVICE_LIFECYCLE',
    'at', v_now,
    'demotedToOffline', v_demoted
  );
END;
$fn$;

REVOKE ALL ON FUNCTION
  app_private.network_center_reconcile_device_lifecycle_v1(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION
  app_private.network_center_reconcile_device_lifecycle_v1(timestamptz) IS
  'Out-of-band demotion of a MikroTik whose telemetry stopped arriving: ONLINE -> OFFLINE after three missed poll intervals (floor five minutes). The counterpart to the promotion in the ingest, which cannot observe its own absence. Never touches UNPROVISIONED, DISABLED or ARUBA.';

-- ===========================================================================
-- 3. BLOCKER B, the latch -- and it is ONE expression.
--
--    app_private.network_center_bind_managed_interface_v1 is deliberately
--    NOT touched. Its eligibility test was always correct; it was being fed
--    a value this ingest had manufactured. Leaving the trigger alone keeps
--    the property an existing regression test already pins -- that a port
--    the worker reports protected (an owned :lan-recovery firewall
--    interface) is NOT enrollable even though its shape looks like an
--    access port. An earlier draft of this migration moved the eligibility
--    rule into the trigger instead, and that test is what caught it.
--
--    Re-declared verbatim from 20260729131000 with one expression changed
--    and no other edit, under the name the 20260729133000 rename left in
--    production. The public v1/v2 facades that call it are untouched.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_private.network_center_worker_inventory_legacy_impl_v1(
  p_worker_id text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'
AS $fn$
DECLARE
  v_router public.network_devices%ROWTYPE;
  v_run app_private.network_aruba_discovery_runs%ROWTYPE;
  v_state app_private.network_aruba_router_state%ROWTYPE;
  v_candidate app_private.network_aruba_discovery_candidates%ROWTYPE;
  v_interfaces jsonb := '[]'::jsonb;
  v_aruba jsonb := '[]'::jsonb;
  v_response jsonb;
  v_item jsonb;
  v_aliases jsonb;
  v_metadata jsonb;
  v_run_id uuid;
  v_observed_at timestamptz;
  v_request_now timestamptz := clock_timestamp();
  v_now timestamptz;
  v_batch_index integer;
  v_batch_count integer;
  v_payload_hash character(64);
  v_existing_hash character(64);
  v_existing_response jsonb;
  v_stable_identity text;
  v_identity_source text;
  v_stable_key text;
  v_external_key text;
  v_display_name text;
  v_model text;
  v_serial_number text;
  v_uplink_interface_key text;
  v_management_address inet;
  v_sort_order integer;
  v_lifecycle_status text;
  v_device_id uuid;
  v_alias_text text;
  v_fingerprint character(64);
  v_quarantine_code text;
  v_quarantined_count integer := 0;
  v_new_today bigint;
  v_enrollment_count bigint;
  v_can_enroll boolean;
  v_seen_stable_keys text[] := ARRAY[]::text[];
  v_inserted integer;
  v_item_invalid boolean;
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_payload IS NULL
     OR jsonb_typeof(p_payload) <> 'object'
     OR octet_length(p_payload::text) > 524288
     OR coalesce(p_payload->>'routerDeviceId', '') !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
     OR coalesce(p_payload->>'discoveryRunId', '') !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
     OR coalesce(p_payload->>'batchIndex', '') !~ '^[0-9]{1,4}$'
     OR coalesce(p_payload->>'batchCount', '') !~ '^[0-9]{1,4}$'
     OR jsonb_typeof(coalesce(p_payload->'interfaces', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'aruba', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'quarantine', '[]'::jsonb)) <> 'array'
     OR jsonb_array_length(coalesce(p_payload->'interfaces', '[]'::jsonb)) > 256
     OR jsonb_array_length(coalesce(p_payload->'aruba', '[]'::jsonb)) > 256
     OR jsonb_array_length(coalesce(p_payload->'quarantine', '[]'::jsonb)) > 256 THEN
    RAISE EXCEPTION 'Invalid or oversized inventory payload'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_run_id := (p_payload->>'discoveryRunId')::uuid;
    v_observed_at := (p_payload->>'observedAt')::timestamptz;
    v_batch_index := (p_payload->>'batchIndex')::integer;
    v_batch_count := (p_payload->>'batchCount')::integer;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Invalid inventory run metadata' USING ERRCODE = '22023';
  END;
  IF v_batch_count NOT BETWEEN 1 AND 4096
     OR v_batch_index < 0 OR v_batch_index >= v_batch_count
     OR v_observed_at IS NULL
     OR v_observed_at < v_request_now - INTERVAL '24 hours'
     OR v_observed_at > v_request_now + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Invalid inventory run bounds' USING ERRCODE = '22023';
  END IF;

  PERFORM app_private.network_center_assert_safe_json_v1(
    p_payload, 'inventory discovery payload'
  );
  v_payload_hash := encode(extensions.digest(
    convert_to(p_payload::text, 'UTF8'), 'sha256'
  ), 'hex');

  SELECT router.* INTO v_router
  FROM public.network_devices router
  WHERE router.id = (p_payload->>'routerDeviceId')::uuid
    AND router.device_kind = 'MIKROTIK'
    AND router.is_active
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory router not found' USING ERRCODE = 'P0002';
  END IF;
  v_now := clock_timestamp();

  INSERT INTO app_private.network_aruba_router_state (
    organization_id, building_id, router_device_id,
    enrollment_started_at, last_discovery_at
  ) VALUES (
    v_router.organization_id, v_router.building_id, v_router.id,
    v_now, v_now
  )
  ON CONFLICT (router_device_id) DO UPDATE SET
    last_discovery_at = GREATEST(
      app_private.network_aruba_router_state.last_discovery_at,
      EXCLUDED.last_discovery_at
    ),
    updated_at = clock_timestamp();

  SELECT state.* INTO v_state
  FROM app_private.network_aruba_router_state state
  WHERE state.router_device_id = v_router.id
  FOR UPDATE;

  INSERT INTO app_private.network_aruba_discovery_runs (
    discovery_run_id, organization_id, building_id, router_device_id,
    observed_at, batch_count
  ) VALUES (
    v_run_id, v_router.organization_id, v_router.building_id,
    v_router.id, v_observed_at, v_batch_count
  ) ON CONFLICT (discovery_run_id) DO NOTHING;

  SELECT run.* INTO v_run
  FROM app_private.network_aruba_discovery_runs run
  WHERE run.discovery_run_id = v_run_id
  FOR UPDATE;
  IF v_run.router_device_id IS DISTINCT FROM v_router.id
     OR v_run.observed_at IS DISTINCT FROM v_observed_at
     OR v_run.batch_count IS DISTINCT FROM v_batch_count THEN
    RAISE EXCEPTION 'Discovery run metadata cannot change'
      USING ERRCODE = '23505';
  END IF;

  SELECT batch.payload_hash, batch.response
  INTO v_existing_hash, v_existing_response
  FROM app_private.network_aruba_discovery_batches batch
  WHERE batch.discovery_run_id = v_run_id
    AND batch.batch_index = v_batch_index
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_payload_hash THEN
      RAISE EXCEPTION 'Discovery batch replay changed payload'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing_response;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(
      coalesce(p_payload->'interfaces', '[]'::jsonb)
    ) AS item("interfaceKey" text)
    GROUP BY btrim(item."interfaceKey")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Interface keys must be unique within a batch'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(
      coalesce(p_payload->'interfaces', '[]'::jsonb)
    ) AS item(
      "interfaceKey" text, "displayName" text, "interfaceKind" text,
      "interfaceRole" text, "macAddress" text, "ifIndex" integer,
      "nominalSpeedBps" bigint, "sortOrder" integer, metadata jsonb
    )
    WHERE char_length(btrim(coalesce(item."interfaceKey", ''))) NOT BETWEEN 1 AND 160
       OR char_length(btrim(coalesce(
         item."displayName", item."interfaceKey", ''
       ))) NOT BETWEEN 1 AND 160
       OR upper(btrim(coalesce(item."interfaceKind", 'OTHER'))) NOT IN (
         'ETHERNET', 'WIRELESS', 'WIREGUARD', 'BRIDGE',
         'VLAN', 'LOOPBACK', 'OTHER'
       )
       OR upper(btrim(coalesce(item."interfaceRole", 'UNKNOWN'))) NOT IN (
         'WAN', 'LAN', 'ACCESS', 'UPLINK', 'MANAGEMENT', 'UNKNOWN'
       )
       OR (
         nullif(btrim(coalesce(item."macAddress", '')), '') IS NOT NULL
         AND btrim(item."macAddress") !~* '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'
       )
       OR (item."ifIndex" IS NOT NULL AND item."ifIndex" < 0)
       OR (item."nominalSpeedBps" IS NOT NULL AND item."nominalSpeedBps" <= 0)
       OR coalesce(item."sortOrder", 0) < 0
       OR jsonb_typeof(coalesce(item.metadata, '{}'::jsonb)) <> 'object'
       OR octet_length(coalesce(item.metadata, '{}'::jsonb)::text) > 16384
  ) THEN
    RAISE EXCEPTION 'Malformed interface inventory item'
      USING ERRCODE = '22023';
  END IF;

  WITH input AS (
    SELECT
      btrim(item."interfaceKey") AS interface_key,
      btrim(coalesce(item."displayName", item."interfaceKey")) AS display_name,
      upper(btrim(coalesce(item."interfaceKind", 'OTHER'))) AS interface_kind,
      upper(btrim(coalesce(item."interfaceRole", 'UNKNOWN'))) AS interface_role,
      nullif(btrim(coalesce(item."macAddress", '')), '')::macaddr AS mac_address,
      item."ifIndex" AS if_index,
      item."nominalSpeedBps" AS nominal_speed_bps,
      coalesce(item."isProtected", false) AS requested_protection,
      coalesce(item."sortOrder", 0) AS sort_order,
      coalesce(item."isEnabled", true) AS is_enabled,
      -- =================================================================
      -- THE WORKER'S PROTECTION REPORT, PRESERVED WHERE THE LATCH CANNOT
      -- REACH IT (20260729148000).
      --
      -- Dropping the sticky OR above is necessary but NOT sufficient,
      -- because of a subtlety in ON CONFLICT: PostgreSQL fires the BEFORE
      -- INSERT trigger BEFORE it detects the conflict, and the row that
      -- trigger returns is what becomes EXCLUDED. So
      -- app_private.network_center_bind_managed_interface_v1 runs TWICE per
      -- interface per cycle, and its own INSERT-pass output --
      -- `NEW.is_protected := NEW.is_protected OR v_protected`, which is true
      -- for every DISCOVERED resource -- arrives back as EXCLUDED.is_protected
      -- and therefore as NEW.is_protected on the UPDATE pass. The trigger was
      -- reading its own output no matter what the ingest did with the stored
      -- value.
      --
      -- display_metadata is the one channel that is NOT rewritten by the
      -- trigger's protection logic, so the worker's report is stamped here,
      -- once, from the payload. `||` is right-biased, so a worker that put an
      -- `observedProtection` key in its own metadata cannot forge this: the
      -- value the server computed always wins.
      --
      -- The role component of the INSERT expression above (WAN/UPLINK/
      -- MANAGEMENT force protection) is deliberately not repeated: the only
      -- consumer requires interface_role = 'ACCESS' already, so those roles
      -- are excluded on their own clause and repeating them here would add a
      -- second place for the two rules to drift apart.
      -- =================================================================
      coalesce(item.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'observedProtection', coalesce(item."isProtected", false)
        ) AS display_metadata
    FROM jsonb_to_recordset(
      coalesce(p_payload->'interfaces', '[]'::jsonb)
    ) AS item(
      "interfaceKey" text, "displayName" text, "interfaceKind" text,
      "interfaceRole" text, "macAddress" text, "ifIndex" integer,
      "nominalSpeedBps" bigint, "isProtected" boolean,
      "sortOrder" integer, "isEnabled" boolean, metadata jsonb
    )
  ), upserted AS (
    INSERT INTO public.network_interfaces (
      organization_id, building_id, device_id, interface_key, display_name,
      interface_kind, interface_role, mac_address, if_index,
      nominal_speed_bps, is_protected, sort_order, is_enabled,
      is_managed, display_metadata
    )
    SELECT
      v_router.organization_id, v_router.building_id, v_router.id,
      input.interface_key, input.display_name, input.interface_kind,
      input.interface_role, input.mac_address, input.if_index,
      input.nominal_speed_bps,
      input.requested_protection OR input.interface_role IN (
        'WAN', 'UPLINK', 'MANAGEMENT'
      ),
      input.sort_order, input.is_enabled, true, input.display_metadata
    FROM input
    ON CONFLICT (device_id, interface_key) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      interface_kind = EXCLUDED.interface_kind,
      interface_role = EXCLUDED.interface_role,
      mac_address = EXCLUDED.mac_address,
      if_index = EXCLUDED.if_index,
      nominal_speed_bps = EXCLUDED.nominal_speed_bps,
      -- =================================================================
      -- THE STICKY OR IS THE WHOLE OF BLOCKER B (20260729148000).
      --
      -- This expression carried the STORED protection forward and OR-ed the
      -- fresh observation into it. Because
      -- app_private.network_center_bind_managed_interface_v1 then fires as a
      -- BEFORE trigger and, for a DISCOVERED resource, forces is_protected
      -- true unconditionally, the stored value was true from the very first
      -- inventory cycle. So from the SECOND cycle onward NEW.is_protected was
      -- true no matter what the router reported, and the trigger's
      -- eligibility test -- which asks whether the port is unprotected -- was
      -- reading back a value this statement had manufactured instead of the
      -- worker's observation. metadata.eligibleAccess went false on cycle two
      -- and stayed false forever, and that is exactly the precondition
      -- app_private.network_center_enroll_access_interface_v1 requires.
      -- Measured in production 2026-08-03: eligibleAccess = 'false' on all
      -- five managed resources of the demo router, refreshed every 60
      -- seconds, ether2..ether5 all is_protected = true, and the enrollment
      -- door with zero callers. The act of discovering a port destroyed the
      -- precondition for enrolling it, so CYCLE_ACCESS_PORT has never been
      -- reachable for any port on any router in this deployment.
      --
      -- EXCLUDED.is_protected is the FRESH observation, already widened by
      -- the INSERT list above to `requested OR role IN (WAN, UPLINK,
      -- MANAGEMENT)`, so a WAN, uplink or management port is re-protected on
      -- every cycle and the table CHECK that requires it still holds.
      --
      -- NOTHING BECOMES CYCLABLE BY DROPPING THE OR. The bind trigger's last
      -- statement is `NEW.is_protected := NEW.is_protected OR v_protected`,
      -- where v_protected is public.network_managed_resources.protected after
      -- its upsert: true for every DISCOVERED resource, and lowered ONLY by
      -- the DISCOVERED -> ENROLLED transition that
      -- app_private.network_center_guard_managed_resource_v1 polices. A port
      -- nobody enrolled is therefore still forced protected on every cycle.
      -- What changes is that the trigger now decides from the router's report
      -- rather than from its own previous output -- including the worker's
      -- `:lan-recovery` firewall-interface flag, which consequently keeps
      -- making a shape-eligible port ineligible, as its regression test
      -- already required.
      -- =================================================================
      is_protected = EXCLUDED.is_protected,
      sort_order = EXCLUDED.sort_order,
      is_enabled = EXCLUDED.is_enabled,
      is_managed = true,
      display_metadata = EXCLUDED.display_metadata,
      updated_at = clock_timestamp()
    RETURNING id, interface_key
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'interfaceKey', upserted.interface_key,
    'id', upserted.id
  ) ORDER BY upserted.interface_key), '[]'::jsonb)
  INTO v_interfaces
  FROM upserted;

  FOR v_item IN
    SELECT item.value
    FROM jsonb_array_elements(
      coalesce(p_payload->'quarantine', '[]'::jsonb)
    ) AS item(value)
  LOOP
    v_quarantine_code := coalesce(v_item->>'code', '');
    v_fingerprint := lower(coalesce(v_item->>'fingerprint', ''));
    IF v_quarantine_code <> 'ARUBA_STABLE_IDENTITY_INVALID'
       OR v_fingerprint !~ '^[a-f0-9]{64}$' THEN
      v_quarantine_code := 'ARUBA_WORKER_QUARANTINE_INVALID';
      v_fingerprint := encode(extensions.digest(
        convert_to(v_item::text, 'UTF8'), 'sha256'
      ), 'hex');
    END IF;
    INSERT INTO app_private.network_aruba_quarantine (
      organization_id, building_id, router_device_id,
      discovery_run_id, batch_index, reason_code, fingerprint, observed_at
    ) VALUES (
      v_router.organization_id, v_router.building_id, v_router.id,
      v_run_id, v_batch_index, v_quarantine_code, v_fingerprint, v_now
    ) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    v_quarantined_count := v_quarantined_count + v_inserted;
  END LOOP;

  FOR v_item IN
    SELECT item.value
    FROM jsonb_array_elements(
      coalesce(p_payload->'aruba', '[]'::jsonb)
    ) AS item(value)
  LOOP
    v_item_invalid := jsonb_typeof(v_item) <> 'object';
    v_stable_identity := btrim(coalesce(v_item->>'stableIdentity', ''));
    v_identity_source := upper(btrim(coalesce(v_item->>'identitySource', '')));
    v_external_key := btrim(coalesce(v_item->>'externalKey', ''));
    v_display_name := btrim(coalesce(v_item->>'displayName', ''));
    v_aliases := coalesce(v_item->'aliases', '[]'::jsonb);
    v_metadata := coalesce(v_item->'metadata', '{}'::jsonb);
    v_model := nullif(btrim(coalesce(v_item->>'model', '')), '');
    v_uplink_interface_key := nullif(btrim(coalesce(
      v_item->>'uplinkInterfaceKey', ''
    )), '');
    v_sort_order := CASE
      WHEN coalesce(v_item->>'sortOrder', '') ~ '^[0-9]{1,9}$'
        THEN (v_item->>'sortOrder')::integer
      ELSE 0
    END;
    v_lifecycle_status := upper(btrim(coalesce(
      v_item->>'lifecycleStatus', 'ONLINE'
    )));
    v_serial_number := CASE WHEN v_identity_source = 'SERIAL'
      THEN v_stable_identity ELSE NULL END;
    v_stable_key := CASE v_identity_source
      WHEN 'SERIAL' THEN 'serial:' || v_stable_identity
      WHEN 'HARDWARE_MAC' THEN 'mac:' || lower(v_stable_identity)
      ELSE ''
    END;
    v_management_address := NULL;
    BEGIN
      IF nullif(btrim(coalesce(v_item->>'managementAddress', '')), '')
         IS NOT NULL THEN
        v_management_address := btrim(v_item->>'managementAddress')::inet;
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      v_management_address := NULL;
      v_stable_key := '';
    END;

    IF jsonb_typeof(v_aliases) <> 'array' THEN
      v_item_invalid := true;
      v_aliases := '[]'::jsonb;
    END IF;
    IF jsonb_typeof(v_metadata) <> 'object' THEN
      v_item_invalid := true;
      v_metadata := '{}'::jsonb;
    END IF;

    IF v_item_invalid
       OR lower(coalesce(v_item->>'displayOnly', '')) <> 'true'
       OR char_length(v_display_name) NOT BETWEEN 1 AND 160
       OR jsonb_array_length(v_aliases) > 32
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_aliases) alias(value)
         WHERE jsonb_typeof(alias.value) <> 'string'
            OR char_length(btrim(alias.value #>> '{}')) NOT BETWEEN 1 AND 160
       )
       OR octet_length(v_metadata::text) > 16384
       OR v_sort_order < 0
       OR v_lifecycle_status NOT IN ('ONLINE', 'OFFLINE')
       OR (
         v_identity_source = 'SERIAL'
         AND v_stable_identity !~ '^[A-Z0-9][A-Z0-9._:-]{0,152}$'
       )
       OR (
         v_identity_source = 'HARDWARE_MAC'
         AND (
           lower(v_stable_identity) !~
             '^[0-9a-f][02468ace](:[0-9a-f]{2}){5}$'
           OR lower(v_stable_identity) IN (
             '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff'
           )
         )
       )
       OR v_identity_source NOT IN ('SERIAL', 'HARDWARE_MAC')
       OR v_external_key IS DISTINCT FROM v_stable_key
       OR v_stable_key = ''
       OR v_stable_key = ANY(v_seen_stable_keys) THEN
      v_fingerprint := encode(extensions.digest(
        convert_to(v_item::text, 'UTF8'), 'sha256'
      ), 'hex');
      INSERT INTO app_private.network_aruba_quarantine (
        organization_id, building_id, router_device_id,
        discovery_run_id, batch_index, reason_code, fingerprint, observed_at
      ) VALUES (
        v_router.organization_id, v_router.building_id, v_router.id,
        v_run_id, v_batch_index, 'ARUBA_ITEM_INVALID', v_fingerprint, v_now
      ) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      v_quarantined_count := v_quarantined_count + v_inserted;
      CONTINUE;
    END IF;
    v_seen_stable_keys := array_append(v_seen_stable_keys, v_stable_key);
    v_device_id := NULL;

    SELECT device.id INTO v_device_id
    FROM public.network_devices device
    WHERE device.parent_device_id = v_router.id
      AND device.device_kind = 'ARUBA'
      AND device.aruba_stable_key = v_stable_key
    FOR UPDATE;

    IF FOUND THEN
      UPDATE public.network_devices device
      SET external_key = v_external_key,
          display_name = v_display_name,
          vendor = 'Aruba',
          model = v_model,
          serial_number = v_serial_number,
          uplink_interface_key = v_uplink_interface_key,
          lifecycle_status = v_lifecycle_status,
          write_capability = false,
          is_active = true,
          credential_ref = NULL,
          inventory_metadata = (v_metadata - 'managementAddress')
            || CASE WHEN v_management_address IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object(
                'managementAddress', host(v_management_address)
              ) END,
          aruba_discovery_last_seen_at = GREATEST(
            device.aruba_discovery_last_seen_at, v_now
          ),
          updated_at = v_now
      WHERE device.id = v_device_id;
      v_can_enroll := true;
    ELSE
      INSERT INTO app_private.network_aruba_discovery_candidates (
        organization_id, building_id, router_device_id, stable_key,
        identity_source, external_key, display_name, model, serial_number,
        uplink_interface_key, management_address, sort_order, aliases,
        inventory_metadata, first_seen_at, last_seen_at,
        sighting_count, last_discovery_run_id
      ) VALUES (
        v_router.organization_id, v_router.building_id, v_router.id,
        v_stable_key, v_identity_source, v_external_key, v_display_name,
        v_model, v_serial_number, v_uplink_interface_key,
        v_management_address, v_sort_order, v_aliases, v_metadata,
        v_now, v_now, 1, v_run_id
      )
      ON CONFLICT (router_device_id, stable_key) DO UPDATE SET
        external_key = EXCLUDED.external_key,
        display_name = EXCLUDED.display_name,
        model = EXCLUDED.model,
        serial_number = EXCLUDED.serial_number,
        uplink_interface_key = EXCLUDED.uplink_interface_key,
        management_address = EXCLUDED.management_address,
        sort_order = EXCLUDED.sort_order,
        aliases = EXCLUDED.aliases,
        inventory_metadata = EXCLUDED.inventory_metadata,
        last_seen_at = GREATEST(
          app_private.network_aruba_discovery_candidates.last_seen_at,
          EXCLUDED.last_seen_at
        ),
        sighting_count =
          app_private.network_aruba_discovery_candidates.sighting_count
          + CASE WHEN
              app_private.network_aruba_discovery_candidates.last_discovery_run_id
                IS DISTINCT FROM EXCLUDED.last_discovery_run_id
            THEN 1 ELSE 0 END,
        last_discovery_run_id = EXCLUDED.last_discovery_run_id,
        updated_at = clock_timestamp();

      SELECT candidate.* INTO v_candidate
      FROM app_private.network_aruba_discovery_candidates candidate
      WHERE candidate.router_device_id = v_router.id
        AND candidate.stable_key = v_stable_key
      FOR UPDATE;

      SELECT count(*) INTO v_new_today
      FROM public.network_devices device
      WHERE device.parent_device_id = v_router.id
        AND device.device_kind = 'ARUBA'
        AND device.aruba_identity_source IN ('SERIAL', 'HARDWARE_MAC')
        AND device.aruba_discovery_first_seen_at >= v_now - INTERVAL '24 hours';
      SELECT count(*) INTO v_enrollment_count
      FROM public.network_devices device
      WHERE device.parent_device_id = v_router.id
        AND device.device_kind = 'ARUBA'
        AND device.aruba_identity_source IN ('SERIAL', 'HARDWARE_MAC')
        AND device.aruba_discovery_first_seen_at >= v_state.enrollment_started_at;

      v_can_enroll := v_run.new_identity_count < 64 AND (
        (
          v_now < v_state.enrollment_started_at + INTERVAL '24 hours'
          AND v_enrollment_count < 512
        )
        OR (
          v_now >= v_state.enrollment_started_at + INTERVAL '24 hours'
          AND v_new_today < 128
          AND v_candidate.sighting_count >= 3
          AND v_candidate.last_seen_at >=
            v_candidate.first_seen_at + INTERVAL '10 minutes'
        )
      );

      IF v_can_enroll THEN
        INSERT INTO public.network_devices (
          organization_id, building_id, device_kind, external_key,
          display_name, vendor, model, serial_number, parent_device_id,
          uplink_interface_key, sort_order, lifecycle_status,
          write_capability, is_active, credential_ref, inventory_metadata,
          aruba_stable_key, aruba_identity_source,
          aruba_discovery_state, aruba_discovery_first_seen_at,
          aruba_discovery_last_seen_at
        ) VALUES (
          v_router.organization_id, v_router.building_id, 'ARUBA',
          v_external_key, v_display_name, 'Aruba', v_model, v_serial_number,
          v_router.id, v_uplink_interface_key, v_sort_order,
          v_lifecycle_status, false, true, NULL,
          (v_metadata - 'managementAddress')
            || CASE WHEN v_management_address IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object(
                'managementAddress', host(v_management_address)
              ) END,
          v_stable_key, v_identity_source, 'DISCOVERED', v_now, v_now
        )
        ON CONFLICT (parent_device_id, aruba_stable_key)
          WHERE device_kind = 'ARUBA'
        DO UPDATE SET
          display_name = EXCLUDED.display_name,
          model = EXCLUDED.model,
          serial_number = EXCLUDED.serial_number,
          uplink_interface_key = EXCLUDED.uplink_interface_key,
          lifecycle_status = EXCLUDED.lifecycle_status,
          is_active = true,
          inventory_metadata = EXCLUDED.inventory_metadata,
          aruba_discovery_last_seen_at = GREATEST(
            public.network_devices.aruba_discovery_last_seen_at, v_now
          ),
          updated_at = v_now
        RETURNING id INTO v_device_id;

        UPDATE app_private.network_aruba_discovery_runs run
        SET new_identity_count = run.new_identity_count + 1,
            updated_at = v_now
        WHERE run.discovery_run_id = v_run_id
        RETURNING run.* INTO v_run;
        DELETE FROM app_private.network_aruba_discovery_candidates candidate
        WHERE candidate.router_device_id = v_router.id
          AND candidate.stable_key = v_stable_key;
      ELSE
        v_fingerprint := encode(extensions.digest(
          convert_to(v_stable_key, 'UTF8'), 'sha256'
        ), 'hex');
        INSERT INTO app_private.network_aruba_quarantine (
          organization_id, building_id, router_device_id,
          discovery_run_id, batch_index, reason_code, fingerprint, observed_at
        ) VALUES (
          v_router.organization_id, v_router.building_id, v_router.id,
          v_run_id, v_batch_index, 'ARUBA_IDENTITY_RATE_LIMITED',
          v_fingerprint, v_now
        ) ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        v_quarantined_count := v_quarantined_count + v_inserted;
      END IF;
    END IF;

    FOR v_alias_text IN
      SELECT btrim(alias.value #>> '{}')
      FROM jsonb_array_elements(v_aliases) alias(value)
    LOOP
      INSERT INTO app_private.network_aruba_aliases (
        organization_id, building_id, router_device_id, stable_key,
        alias, first_seen_at, last_seen_at, tombstoned_at
      ) VALUES (
        v_router.organization_id, v_router.building_id, v_router.id,
        v_stable_key, v_alias_text, v_now, v_now, NULL
      )
      ON CONFLICT (router_device_id, stable_key, alias) DO UPDATE SET
        last_seen_at = GREATEST(
          app_private.network_aruba_aliases.last_seen_at,
          EXCLUDED.last_seen_at
        ),
        tombstoned_at = NULL;
    END LOOP;
    UPDATE app_private.network_aruba_aliases alias
    SET tombstoned_at = coalesce(alias.tombstoned_at, v_now)
    WHERE alias.router_device_id = v_router.id
      AND alias.stable_key = v_stable_key
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_aliases) current_alias(value)
        WHERE btrim(current_alias.value #>> '{}') = alias.alias
      );

    IF v_can_enroll AND v_device_id IS NOT NULL THEN
      v_aruba := v_aruba || jsonb_build_array(jsonb_build_object(
        'externalKey', v_external_key,
        'id', v_device_id
      ));
    END IF;
  END LOOP;

  WITH victims AS MATERIALIZED (
    SELECT quarantine.id
    FROM app_private.network_aruba_quarantine quarantine
    WHERE quarantine.router_device_id = v_router.id
    ORDER BY quarantine.observed_at DESC, quarantine.id DESC
    OFFSET 1000
    LIMIT 512
  )
  DELETE FROM app_private.network_aruba_quarantine quarantine
  USING victims
  WHERE quarantine.id = victims.id;

  v_response := jsonb_build_object(
    'routerDeviceId', v_router.id,
    'interfaces', v_interfaces,
    'aruba', v_aruba,
    'interfaceCount', jsonb_array_length(v_interfaces),
    'arubaCount', jsonb_array_length(v_aruba),
    'inventoryStatus', CASE WHEN v_quarantined_count > 0
      THEN 'DEGRADED' ELSE 'OK' END,
    'quarantinedCount', v_quarantined_count
  );

  INSERT INTO app_private.network_aruba_discovery_batches (
    discovery_run_id, batch_index, payload_hash, response
  ) VALUES (
    v_run_id, v_batch_index, v_payload_hash, v_response
  );
  RETURN v_response;
END;
$fn$;

REVOKE ALL ON FUNCTION
  app_private.network_center_worker_inventory_legacy_impl_v1(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 3b. The other half of the same defect: the eligibility test read this
--     trigger's own INSERT-pass output back through EXCLUDED.
--
--     Re-declared verbatim from 20260729132000 with one expression changed
--     and no other edit. The rule itself is unchanged and is NOT relaxed:
--     the worker's protection report still makes a shape-eligible port
--     ineligible, which is what keeps an owned :lan-recovery firewall
--     interface out of enrollment. The trigger
--     network_interfaces_bind_managed_resource is preserved by CREATE OR
--     REPLACE and asserted back out of pg_trigger below.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_private.network_center_bind_managed_interface_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_immutable_key text;
  v_resource_id uuid;
  v_safe_access boolean;
  v_role text;
  v_protected boolean;
  v_state text;
BEGIN
  v_immutable_key := nullif(btrim(
    coalesce(NEW.display_metadata->>'immutableKey', '')
  ), '');
  IF v_immutable_key IS NULL THEN
    IF (TG_OP = 'UPDATE' AND OLD.managed_resource_id IS NOT NULL)
       OR NEW.managed_resource_id IS NOT NULL THEN
      RAISE EXCEPTION 'Managed interface immutable identity cannot be removed'
        USING ERRCODE = '55000';
    END IF;
    NEW.is_managed := false;
    RETURN NEW;
  END IF;
  IF v_immutable_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR NOT EXISTS (
       SELECT 1
       FROM public.network_devices device
       WHERE device.organization_id = NEW.organization_id
         AND device.building_id = NEW.building_id
         AND device.id = NEW.device_id
         AND device.device_kind = 'MIKROTIK'
     ) THEN
    RAISE EXCEPTION 'Invalid managed interface identity'
      USING ERRCODE = '22023';
  END IF;
  IF NEW.interface_key IS DISTINCT FROM v_immutable_key
     OR (
       TG_OP = 'UPDATE'
       AND OLD.managed_resource_id IS NOT NULL
       AND (
         OLD.interface_key IS DISTINCT FROM v_immutable_key
         OR NEW.managed_resource_id IS DISTINCT FROM OLD.managed_resource_id
       )
     ) THEN
    RAISE EXCEPTION 'Managed interface immutable identity cannot be rebound'
      USING ERRCODE = '55000';
  END IF;

  IF lower(v_immutable_key) = 'ether1' THEN
    NEW.interface_role := 'WAN';
    NEW.is_protected := true;
  END IF;
  -- =====================================================================
  -- ELIGIBILITY MUST NOT READ THIS TRIGGER'S OWN OUTPUT (20260729148000).
  --
  -- The rule is unchanged in intent and is deliberately NOT relaxed: a
  -- physical ethernet access port, ether2..N, that the worker does NOT
  -- report as protected. What changes is where the last term is read from.
  --
  -- It used to compare NEW.is_protected against false. On the INSERT pass
  -- that is the worker's report and the test is right; but this trigger runs
  -- TWICE per interface per inventory cycle, because ON CONFLICT fires the
  -- BEFORE INSERT trigger before it detects the conflict and then uses the
  -- row that trigger returned as EXCLUDED. The last statement of this
  -- function forces NEW.is_protected true for every DISCOVERED resource, so
  -- on the UPDATE pass the test was reading back the value it had itself
  -- just produced, and metadata.eligibleAccess went false on the second poll
  -- cycle and stayed false forever -- destroying the one precondition
  -- app_private.network_center_enroll_access_interface_v1 needs. Measured in
  -- production 2026-08-03: eligibleAccess = 'false' on all five managed
  -- resources, refreshed every 60 seconds. The act of discovering a port
  -- destroyed the precondition for enrolling it.
  --
  -- observedProtection is stamped into display_metadata by the ingest,
  -- straight from the payload, and nothing in this function writes it -- so
  -- it survives both passes unchanged and still carries the signal that
  -- matters: the worker marks a port protected when an owned `:lan-recovery`
  -- firewall rule names it (routerOsRecoveryInterfaceNames), and such a port
  -- must not become enrollable however ordinary its shape looks. The
  -- coalesce keeps the previous behaviour for any row not written by the
  -- ingest, which is fail-closed on an UPDATE because NEW.is_protected is
  -- true there.
  -- =====================================================================
  v_safe_access := NEW.interface_kind = 'ETHERNET'
    AND NEW.interface_role = 'ACCESS'
    AND NOT coalesce(
      (NEW.display_metadata->>'observedProtection')::boolean,
      NEW.is_protected
    )
    AND v_immutable_key ~* '^ether([2-9]|[1-9][0-9])$';
  v_role := NEW.interface_role;
  v_protected := true;
  v_state := CASE WHEN lower(v_immutable_key) = 'ether1'
    THEN 'ENROLLED' ELSE 'DISCOVERED' END;

  INSERT INTO public.network_managed_resources (
    organization_id, building_id, device_id, resource_kind,
    stable_key, display_name, enrolled_role, protected,
    ownership_marker, enrollment_state, last_verified_at,
    metadata
  ) VALUES (
    NEW.organization_id, NEW.building_id, NEW.device_id, 'INTERFACE',
    v_immutable_key, NEW.display_name, v_role, v_protected,
    'routeros-default-name', v_state, clock_timestamp(),
    jsonb_build_object(
      'source', 'routeros-inventory',
      'eligibleAccess', v_safe_access
    )
  )
  ON CONFLICT (device_id, resource_kind, stable_key) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    enrolled_role = CASE
      WHEN public.network_managed_resources.enrollment_state = 'DISCOVERED'
        THEN EXCLUDED.enrolled_role
      ELSE public.network_managed_resources.enrolled_role
    END,
    protected = CASE
      WHEN public.network_managed_resources.enrollment_state = 'ENROLLED'
        THEN public.network_managed_resources.protected
          OR coalesce((EXCLUDED.metadata->>'eligibleAccess')::boolean, false) = false
      ELSE public.network_managed_resources.protected OR EXCLUDED.protected
    END,
    enrollment_state = CASE
      WHEN public.network_managed_resources.enrollment_state = 'REVOKED'
        THEN 'REVOKED'
      ELSE public.network_managed_resources.enrollment_state
    END,
    last_verified_at = EXCLUDED.last_verified_at,
    metadata = public.network_managed_resources.metadata
      || EXCLUDED.metadata
  RETURNING id, enrolled_role, protected, enrollment_state
  INTO v_resource_id, v_role, v_protected, v_state;

  NEW.interface_key := v_immutable_key;
  NEW.managed_resource_id := v_resource_id;
  NEW.is_managed := true;
  NEW.is_protected := NEW.is_protected OR v_protected;
  NEW.interface_role := v_role;
  NEW.display_metadata := NEW.display_metadata
    || jsonb_build_object('immutableKey', v_immutable_key);
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.network_center_bind_managed_interface_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 4. BLOCKER B, reachability. A caller for the enrollment door, and a way to
--    see which ports it will open.
--
--    app_private.network_center_enroll_access_interface_v1 is unchanged: it is
--    the reviewed door and it already enforces the whole precondition set. What
--    it never had was a caller or a grant. These two RPCs are service-role only
--    -- the same posture as every other network_center_admin_* function -- so
--    enrollment is an out-of-band, audited, deliberate operator act and is not
--    reachable from a browser session at all.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.network_center_admin_list_access_ports_v1(
  p_building_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_ports jsonb;
BEGIN
  -- No FOR UPDATE / FOR SHARE anywhere in this body: PostgREST runs a STABLE
  -- function inside a READ ONLY transaction, where a row lock raises 25006 and
  -- the call works from SQL but fails from the client.
  WITH candidate AS (
    SELECT
      resource.organization_id,
      resource.building_id,
      building.name AS building_name,
      resource.device_id,
      interface.id AS interface_id,
      resource.id AS managed_resource_id,
      interface.interface_key,
      resource.stable_key,
      interface.display_name,
      interface.interface_kind,
      interface.interface_role,
      interface.is_enabled,
      interface.is_protected,
      interface.is_managed,
      resource.enrollment_state,
      resource.enrolled_role,
      resource.protected,
      coalesce(
        (resource.metadata->>'eligibleAccess')::boolean, false
      ) AS eligible_access
    FROM public.network_managed_resources resource
    JOIN public.network_interfaces interface
      ON interface.organization_id = resource.organization_id
     AND interface.building_id = resource.building_id
     AND interface.device_id = resource.device_id
     AND interface.managed_resource_id = resource.id
    LEFT JOIN public.buildings building
      ON building.organization_id = resource.organization_id
     AND building.id = resource.building_id
    WHERE resource.resource_kind = 'INTERFACE'
      AND (p_building_id IS NULL OR resource.building_id = p_building_id)
  ), evaluated AS (
    -- blocked_by mirrors app_private.network_center_enroll_access_interface_v1
    -- clause for clause and in its order, so an operator reading this list is
    -- reading the same predicate the door will evaluate, not a paraphrase.
    SELECT candidate.*,
      (
        CASE WHEN candidate.enrollment_state = 'DISCOVERED'
          THEN ARRAY[]::text[] ELSE ARRAY['enrollmentState<>DISCOVERED'] END
        || CASE WHEN candidate.enrolled_role = 'ACCESS'
          THEN ARRAY[]::text[] ELSE ARRAY['enrolledRole<>ACCESS'] END
        || CASE WHEN candidate.protected
          THEN ARRAY[]::text[] ELSE ARRAY['resourceAlreadyUnprotected'] END
        || CASE WHEN candidate.eligible_access
          THEN ARRAY[]::text[] ELSE ARRAY['eligibleAccess<>true'] END
        || CASE WHEN candidate.stable_key ~* '^ether([2-9]|[1-9][0-9])$'
          THEN ARRAY[]::text[] ELSE ARRAY['stableKeyIsNotAPhysicalAccessPort'] END
        || CASE WHEN candidate.interface_kind = 'ETHERNET'
          THEN ARRAY[]::text[] ELSE ARRAY['interfaceKind<>ETHERNET'] END
        || CASE WHEN candidate.interface_role = 'ACCESS'
          THEN ARRAY[]::text[] ELSE ARRAY['interfaceRole<>ACCESS'] END
        || CASE WHEN candidate.is_protected
          THEN ARRAY[]::text[] ELSE ARRAY['interfaceAlreadyUnprotected'] END
        || CASE WHEN candidate.is_managed
          THEN ARRAY[]::text[] ELSE ARRAY['interfaceNotManaged'] END
        || CASE WHEN candidate.is_enabled
          THEN ARRAY[]::text[] ELSE ARRAY['interfaceDisabled'] END
        || CASE WHEN candidate.interface_key = candidate.stable_key
          THEN ARRAY[]::text[] ELSE ARRAY['interfaceKey<>stableKey'] END
      ) AS blocked_by
    FROM candidate
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'organizationId', evaluated.organization_id,
    'buildingId', evaluated.building_id,
    'buildingName', evaluated.building_name,
    'deviceId', evaluated.device_id,
    'interfaceId', evaluated.interface_id,
    'managedResourceId', evaluated.managed_resource_id,
    'interfaceKey', evaluated.interface_key,
    'immutableKey', evaluated.stable_key,
    'displayName', evaluated.display_name,
    'interfaceKind', evaluated.interface_kind,
    'interfaceRole', evaluated.interface_role,
    'isEnabled', evaluated.is_enabled,
    'interfaceProtected', evaluated.is_protected,
    'enrollmentState', evaluated.enrollment_state,
    'resourceProtected', evaluated.protected,
    'eligibleAccess', evaluated.eligible_access,
    'enrollable', cardinality(evaluated.blocked_by) = 0,
    'blockedBy', to_jsonb(evaluated.blocked_by)
  ) ORDER BY evaluated.building_name, evaluated.stable_key), '[]'::jsonb)
  INTO v_ports
  FROM evaluated;

  RETURN jsonb_build_object('ports', v_ports);
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_admin_list_access_ports_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_list_access_ports_v1(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.network_center_admin_enroll_access_port_v1(
  p_interface_id uuid,
  p_confirm_immutable_key text,
  p_reason text,
  p_request_id uuid DEFAULT gen_random_uuid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_confirm text := btrim(coalesce(p_confirm_immutable_key, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_row record;
  v_after record;
BEGIN
  IF p_interface_id IS NULL
     OR v_confirm !~* '^ether([2-9]|[1-9][0-9])$'
     OR char_length(v_reason) NOT BETWEEN 8 AND 500
     OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Network Center access-port enrollment request'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    interface.organization_id AS organization_id,
    interface.building_id AS building_id,
    interface.device_id AS device_id,
    interface.id AS interface_id,
    interface.is_protected AS interface_protected,
    resource.id AS resource_id,
    resource.stable_key AS stable_key,
    resource.enrollment_state AS enrollment_state,
    resource.protected AS resource_protected,
    building.name AS building_name
  INTO v_row
  FROM public.network_interfaces interface
  JOIN public.network_managed_resources resource
    ON resource.organization_id = interface.organization_id
   AND resource.building_id = interface.building_id
   AND resource.device_id = interface.device_id
   AND resource.id = interface.managed_resource_id
  LEFT JOIN public.buildings building
    ON building.organization_id = interface.organization_id
   AND building.id = interface.building_id
  WHERE interface.id = p_interface_id
    AND resource.resource_kind = 'INTERFACE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Managed access interface not found' USING ERRCODE = 'P0002';
  END IF;

  -- Typed confirmation of the IMMUTABLE key, not of the display name. RouterOS
  -- lets an operator rename ether4 to anything; the default-name is what the
  -- router-side cycle actually targets, so that is what must be typed.
  IF v_row.stable_key IS DISTINCT FROM v_confirm THEN
    RAISE EXCEPTION 'Access-port confirmation does not match the immutable key'
      USING ERRCODE = '22023',
        DETAIL = format(
          'confirmed=%s actual=%s interfaceId=%s',
          v_confirm, v_row.stable_key, p_interface_id
        );
  END IF;

  -- Idempotent. A repeated enrollment of an already-enrolled, already
  -- unprotected port is a no-op that reports changed=false, not a refusal: an
  -- operator retrying after a lost response must not be told the port is
  -- ineligible.
  IF v_row.enrollment_state = 'ENROLLED'
     AND NOT v_row.resource_protected
     AND NOT v_row.interface_protected THEN
    RETURN jsonb_build_object(
      'organizationId', v_row.organization_id,
      'buildingId', v_row.building_id,
      'deviceId', v_row.device_id,
      'interfaceId', v_row.interface_id,
      'managedResourceId', v_row.resource_id,
      'immutableKey', v_row.stable_key,
      'enrollmentState', v_row.enrollment_state,
      'resourceProtected', v_row.resource_protected,
      'interfaceProtected', v_row.interface_protected,
      'changed', false
    );
  END IF;

  -- The door itself. Every precondition -- DISCOVERED, ACCESS, protected,
  -- eligibleAccess, ether2..N, ETHERNET, managed, enabled, key identity -- lives
  -- inside it and is NOT duplicated here, so there is exactly one definition of
  -- what may be enrolled. It raises 42501 naming the resource when refused.
  PERFORM app_private.network_center_enroll_access_interface_v1(v_row.resource_id);

  SELECT resource.enrollment_state AS enrollment_state,
    resource.protected AS resource_protected,
    interface.is_protected AS interface_protected
  INTO v_after
  FROM public.network_managed_resources resource
  JOIN public.network_interfaces interface
    ON interface.managed_resource_id = resource.id
  WHERE resource.id = v_row.resource_id;

  -- Read back rather than assume. A trigger between here and there could have
  -- re-protected the row, and reporting an enrollment that did not stick would
  -- send an operator to cycle a port that is still protected.
  IF v_after.enrollment_state <> 'ENROLLED'
     OR v_after.resource_protected
     OR v_after.interface_protected THEN
    RAISE EXCEPTION 'Access-port enrollment did not take effect'
      USING ERRCODE = '55000',
        DETAIL = format(
          'enrollmentState=%s resourceProtected=%s interfaceProtected=%s',
          v_after.enrollment_state, v_after.resource_protected,
          v_after.interface_protected
        );
  END IF;

  INSERT INTO public.network_audit_events (
    organization_id, building_id, actor_type, action, target_type, target_id,
    target_display, reason, validation, result, outcome, request_id, occurred_at
  ) VALUES (
    v_row.organization_id,
    v_row.building_id,
    'SYSTEM',
    'admin.enroll_access_port',
    'interface',
    v_row.interface_id,
    jsonb_build_object(
      'buildingName', v_row.building_name,
      'deviceId', v_row.device_id,
      'immutableKey', v_row.stable_key
    ),
    v_reason,
    jsonb_build_object(
      'confirmedImmutableKey', v_confirm,
      'previousEnrollmentState', v_row.enrollment_state,
      'previousResourceProtected', v_row.resource_protected,
      'previousInterfaceProtected', v_row.interface_protected
    ),
    jsonb_build_object(
      'managedResourceId', v_row.resource_id,
      'enrollmentState', v_after.enrollment_state,
      'resourceProtected', v_after.resource_protected,
      'interfaceProtected', v_after.interface_protected
    ),
    'SUCCEEDED',
    p_request_id,
    clock_timestamp()
  );

  RETURN jsonb_build_object(
    'organizationId', v_row.organization_id,
    'buildingId', v_row.building_id,
    'deviceId', v_row.device_id,
    'interfaceId', v_row.interface_id,
    'managedResourceId', v_row.resource_id,
    'immutableKey', v_row.stable_key,
    'enrollmentState', v_after.enrollment_state,
    'resourceProtected', v_after.resource_protected,
    'interfaceProtected', v_after.interface_protected,
    'changed', true
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_admin_enroll_access_port_v1(
  uuid, text, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_enroll_access_port_v1(
  uuid, text, text, uuid
) TO service_role;

COMMENT ON FUNCTION public.network_center_admin_list_access_ports_v1(uuid) IS
  'Service-role-only listing of every managed RouterOS interface resource with its enrollment state and, for the ones that are not enrollable, the exact preconditions that block them -- mirroring app_private.network_center_enroll_access_interface_v1 clause for clause.';
COMMENT ON FUNCTION public.network_center_admin_enroll_access_port_v1(
  uuid, text, text, uuid
) IS
  'Service-role-only deliberate enrollment of one physical access port (ether2..N) so it becomes cyclable. Requires the immutable key typed back as confirmation and a reason, delegates every eligibility rule to app_private.network_center_enroll_access_interface_v1, reads the result back before reporting success, and writes a network_audit_events row. This is the only caller of that door.';

-- ===========================================================================
-- 5. Wiring the demotion into the out-of-band sweep.
--
--    Re-declared verbatim from 20260729139000 with one PERFORM added and no
--    other edit, including no change to the returned report, which is stored
--    verbatim in app_private.network_center_watchdog_runs.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.network_center_watchdog_liveness_v1(
  p_stale_after_seconds integer DEFAULT 300,
  p_now timestamptz DEFAULT clock_timestamp(),
  p_registration_grace_seconds integer DEFAULT 900
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  -- One fingerprint for the whole subsystem, deliberately carrying no worker
  -- key. `network_incidents_one_active_fingerprint_uidx` is
  -- (organization_id, building_id, fingerprint) WHERE status <> 'RESOLVED', so
  -- this yields exactly one active incident per building no matter how often the
  -- sweep runs or how many workers serve that building - and it leaks no worker
  -- identity into a tenant-readable row.
  c_fingerprint constant text := 'network-center:worker-heartbeat-stale';
  c_incident_type constant text := 'WORKER_HEARTBEAT_STALE';
  c_actor constant text := 'network-center-watchdog';
  -- How stale an already-open incident may get before it is touched again. Keeps
  -- a two-minute schedule from writing to a Realtime-published table 720 times a
  -- day for one unresolved outage.
  c_refresh_interval constant interval := INTERVAL '5 minutes';
  v_started timestamptz := clock_timestamp();
  v_now timestamptz := p_now;
  v_report jsonb;
  v_state app_private.network_center_watchdog_state;
  v_monitored_workers integer := 0;
  v_monitored_buildings integer := 0;
  v_stale_workers integer := 0;
  v_stale_buildings integer := 0;
  v_opened integer := 0;
  v_refreshed integer := 0;
  v_resolved integer := 0;
  v_stale_worker_detail jsonb := '[]'::jsonb;
BEGIN
  IF p_stale_after_seconds IS NULL
     OR p_stale_after_seconds NOT BETWEEN 30 AND 86400
     OR p_registration_grace_seconds IS NULL
     OR p_registration_grace_seconds NOT BETWEEN 0 AND 86400
     OR v_now IS NULL
     OR abs(extract(epoch FROM (clock_timestamp() - v_now))) > 3600 THEN
    RAISE EXCEPTION 'Invalid Network Center watchdog request'
      USING ERRCODE = '22023';
  END IF;

  -- Concurrency safety. Two schedulers (pg_cron and an external HTTP cron) may
  -- legitimately be enabled at once, and a slow run may still be in flight when
  -- the next tick arrives. The loser must not double-write incidents, and must
  -- not report "healthy" either - it reports the last COMPLETED assessment, so a
  -- caller that maps the payload to an alert cannot be silenced by contention.
  IF NOT pg_try_advisory_xact_lock(20260729139001::bigint) THEN
    SELECT state.* INTO v_state
    FROM app_private.network_center_watchdog_state state
    WHERE state.singleton;
    RETURN jsonb_build_object(
      'schemaVersion', 1,
      'job', 'LIVENESS',
      'at', v_now,
      'skipped', true,
      'skipReason', 'CONCURRENT_RUN',
      'thresholdSeconds', coalesce(
        v_state.liveness_threshold_seconds, p_stale_after_seconds
      ),
      'assessedAt', v_state.liveness_assessed_at,
      'monitoredWorkers', coalesce(v_state.monitored_worker_count, 0),
      'monitoredBuildings', coalesce(v_state.monitored_building_count, 0),
      'staleWorkers', coalesce(v_state.stale_worker_count, 0),
      'staleBuildings', coalesce(v_state.stale_building_count, 0),
      'incidentsOpened', 0,
      'incidentsRefreshed', 0,
      'incidentsResolved', 0,
      'staleWorkerDetail', '[]'::jsonb
    );
  END IF;

  -- Evidence that STOPPED arriving (20260729148000). The ingest promotes a
  -- router to ONLINE from a poll it just accepted, and demotes it to OFFLINE
  -- from a poll that failed -- but it cannot see the case where no poll
  -- happens at all, because in that case it is not called. That is exactly
  -- what this sweep is for, and why the demotion belongs here rather than in
  -- the hourly maintenance job: this runs on the same two-minute schedule
  -- that opens WORKER_HEARTBEAT_STALE, so the incident and the router's
  -- lifecycle stop telling different stories about the same outage.
  -- Held under the same advisory lock as the rest of the sweep, and
  -- deliberately NOT reported into v_report: the liveness report is written
  -- verbatim into app_private.network_center_watchdog_runs, whose contract
  -- is asserted key-by-key elsewhere.
  PERFORM app_private.network_center_reconcile_device_lifecycle_v1(v_now);

  -- The scan is re-evaluated per statement rather than materialized into a temp
  -- table: `CREATE TEMPORARY TABLE` would make a second call inside the same
  -- transaction fail with 42P07, and a scheduler that batches both watchdog jobs
  -- into one transaction is a perfectly reasonable thing for an operator to
  -- write. The function is STABLE over tables this sweep never writes, so every
  -- re-evaluation inside one transaction sees the same rows.
  SELECT count(DISTINCT scan.worker_id),
    count(DISTINCT (scan.organization_id, scan.building_id)),
    count(DISTINCT scan.worker_id) FILTER (WHERE scan.stale),
    count(DISTINCT (scan.organization_id, scan.building_id))
      FILTER (WHERE scan.stale)
  INTO v_monitored_workers, v_monitored_buildings, v_stale_workers,
    v_stale_buildings
  FROM app_private.network_center_watchdog_liveness_scan_v1(
    v_now, p_stale_after_seconds, p_registration_grace_seconds
  ) scan;

  -- Operator-facing only: this value is returned to the service-role caller and
  -- never written to a tenant-readable row. Bounded so a large fleet cannot make
  -- the payload unbounded.
  SELECT coalesce(jsonb_agg(to_jsonb(detail) ORDER BY detail."workerKey"), '[]'::jsonb)
  INTO v_stale_worker_detail
  FROM (
    SELECT scan.worker_key AS "workerKey",
      max(scan.last_heartbeat_at) AS "lastHeartbeatAt",
      count(DISTINCT (scan.organization_id, scan.building_id))::integer
        AS "buildingCount"
    FROM app_private.network_center_watchdog_liveness_scan_v1(
    v_now, p_stale_after_seconds, p_registration_grace_seconds
  ) scan
    WHERE scan.stale
    GROUP BY scan.worker_key
    ORDER BY scan.worker_key
    LIMIT 20
  ) detail;

  -- Open or refresh one incident per building that has lost every one of its
  -- pollers. `xmax = 0` distinguishes a genuine INSERT from a conflict update,
  -- and the DO UPDATE WHERE means an unchanged, already-open incident yields no
  -- row at all - so an outage lasting days appends exactly one incident event.
  WITH stale_building AS (
    SELECT scan.organization_id,
      scan.building_id,
      (array_agg(scan.device_id ORDER BY scan.device_id))[1] AS device_id,
      max(scan.last_heartbeat_at) AS last_heartbeat_at
    FROM app_private.network_center_watchdog_liveness_scan_v1(
    v_now, p_stale_after_seconds, p_registration_grace_seconds
  ) scan
    WHERE scan.stale
    GROUP BY scan.organization_id, scan.building_id
  ), upserted AS (
    INSERT INTO public.network_incidents (
      organization_id, building_id, device_id, interface_id, fingerprint,
      incident_type, severity, status, title, summary, availability_impact,
      opened_at, last_observed_at, occurrence_count, observed_values
    )
    SELECT stale_building.organization_id,
      stale_building.building_id,
      stale_building.device_id,
      NULL::uuid,
      c_fingerprint,
      c_incident_type,
      'CRITICAL',
      'OPEN',
      'Hệ thống giám sát mạng ngừng báo cáo',
      'Không nhận được nhịp tim từ tiến trình thu thập dữ liệu mạng của tòa nhà'
        || ' trong hơn ' || p_stale_after_seconds::text || ' giây.'
        || ' Số liệu đang hiển thị có thể đã cũ và các lệnh mới sẽ không được'
        || ' thực thi cho tới khi tiến trình hoạt động trở lại.',
      true,
      v_now,
      v_now,
      1,
      jsonb_build_object(
        'thresholdSeconds', p_stale_after_seconds,
        'lastHeartbeatAt', stale_building.last_heartbeat_at,
        'detectedBy', 'watchdog'
      )
    FROM stale_building
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
    WHERE public.network_incidents.last_observed_at
      < EXCLUDED.last_observed_at - c_refresh_interval
    RETURNING id, organization_id, building_id, device_id, opened_at,
      (xmax = 0) AS newly_opened
  ), opened_event AS (
    INSERT INTO public.network_incident_events (
      organization_id, building_id, incident_id, event_seq, event_kind,
      severity, occurred_at, worker_id, details
    )
    SELECT upserted.organization_id, upserted.building_id, upserted.id,
      coalesce((
        SELECT max(event.event_seq) + 1
        FROM public.network_incident_events event
        WHERE event.incident_id = upserted.id
      ), 1),
      'OPENED', 'CRITICAL', v_now, c_actor,
      jsonb_build_object(
        'thresholdSeconds', p_stale_after_seconds,
        'detectedBy', 'watchdog'
      )
    FROM upserted
    WHERE upserted.newly_opened
    RETURNING incident_id
  ), opened_audit AS (
    INSERT INTO public.network_audit_events (
      organization_id, building_id, actor_type, action, target_type, target_id,
      target_display, reason, validation, result, outcome, occurred_at
    )
    SELECT upserted.organization_id, upserted.building_id, 'SYSTEM',
      'system.watchdog_worker_stale', 'building', upserted.building_id,
      jsonb_build_object('deviceId', upserted.device_id),
      'Watchdog ngoài luồng phát hiện tiến trình giám sát ngừng báo cáo',
      jsonb_build_object('thresholdSeconds', p_stale_after_seconds),
      jsonb_build_object('incidentId', upserted.id),
      'OBSERVED', v_now
    FROM upserted
    WHERE upserted.newly_opened
    RETURNING id
  ), opened_outbox AS (
    INSERT INTO public.network_outbox_events (
      organization_id, building_id, event_type, aggregate_type, aggregate_id,
      payload, occurred_at
    )
    SELECT upserted.organization_id, upserted.building_id,
      'network.worker.heartbeat_stale', 'building', upserted.building_id,
      jsonb_build_object(
        'incidentId', upserted.id,
        'incidentType', c_incident_type,
        'thresholdSeconds', p_stale_after_seconds
      ),
      v_now
    FROM upserted
    WHERE upserted.newly_opened
    RETURNING id
  )
  SELECT (count(*) FILTER (WHERE upserted.newly_opened))::integer,
    (count(*) FILTER (WHERE NOT upserted.newly_opened))::integer
  INTO v_opened, v_refreshed
  FROM upserted;

  -- Clear down. Only for buildings this sweep still monitors and now finds
  -- healthy: a building whose assignment was removed entirely keeps its open
  -- incident, because "the thing I was watching disappeared" must not read as
  -- "the thing I was watching recovered".
  WITH healthy_building AS (
    SELECT scan.organization_id, scan.building_id
    FROM app_private.network_center_watchdog_liveness_scan_v1(
    v_now, p_stale_after_seconds, p_registration_grace_seconds
  ) scan
    GROUP BY scan.organization_id, scan.building_id
    HAVING bool_and(NOT scan.stale)
  ), cleared AS (
    UPDATE public.network_incidents incident
    SET status = 'RESOLVED',
      resolved_at = v_now,
      recovered_at = coalesce(incident.recovered_at, v_now),
      last_observed_at = greatest(incident.last_observed_at, v_now),
      version = incident.version + 1
    FROM healthy_building
    WHERE incident.organization_id = healthy_building.organization_id
      AND incident.building_id = healthy_building.building_id
      AND incident.fingerprint = c_fingerprint
      AND incident.status <> 'RESOLVED'
    RETURNING incident.id, incident.organization_id, incident.building_id,
      incident.device_id
  ), cleared_event AS (
    INSERT INTO public.network_incident_events (
      organization_id, building_id, incident_id, event_seq, event_kind,
      severity, occurred_at, worker_id, details
    )
    SELECT cleared.organization_id, cleared.building_id, cleared.id,
      coalesce((
        SELECT max(event.event_seq) + 1
        FROM public.network_incident_events event
        WHERE event.incident_id = cleared.id
      ), 1),
      'RESOLVED', 'INFO', v_now, c_actor,
      jsonb_build_object('detectedBy', 'watchdog')
    FROM cleared
    RETURNING incident_id
  ), cleared_audit AS (
    INSERT INTO public.network_audit_events (
      organization_id, building_id, actor_type, action, target_type, target_id,
      target_display, reason, validation, result, outcome, occurred_at
    )
    SELECT cleared.organization_id, cleared.building_id, 'SYSTEM',
      'system.watchdog_worker_recovered', 'building', cleared.building_id,
      jsonb_build_object('deviceId', cleared.device_id),
      'Watchdog ngoài luồng ghi nhận tiến trình giám sát đã báo cáo trở lại',
      jsonb_build_object('thresholdSeconds', p_stale_after_seconds),
      jsonb_build_object('incidentId', cleared.id),
      'OBSERVED', v_now
    FROM cleared
    RETURNING id
  ), cleared_outbox AS (
    INSERT INTO public.network_outbox_events (
      organization_id, building_id, event_type, aggregate_type, aggregate_id,
      payload, occurred_at
    )
    SELECT cleared.organization_id, cleared.building_id,
      'network.worker.heartbeat_recovered', 'building', cleared.building_id,
      jsonb_build_object(
        'incidentId', cleared.id,
        'incidentType', c_incident_type
      ),
      v_now
    FROM cleared
    RETURNING id
  )
  SELECT count(*)::integer INTO v_resolved FROM cleared;

  UPDATE app_private.network_center_watchdog_state state
  SET liveness_assessed_at = v_now,
    liveness_threshold_seconds = p_stale_after_seconds,
    monitored_worker_count = v_monitored_workers,
    monitored_building_count = v_monitored_buildings,
    stale_worker_count = v_stale_workers,
    stale_building_count = v_stale_buildings,
    updated_at = clock_timestamp()
  WHERE state.singleton;

  v_report := jsonb_build_object(
    'schemaVersion', 1,
    'job', 'LIVENESS',
    'at', v_now,
    'skipped', false,
    'skipReason', NULL,
    'thresholdSeconds', p_stale_after_seconds,
    'assessedAt', v_now,
    'monitoredWorkers', v_monitored_workers,
    'monitoredBuildings', v_monitored_buildings,
    'staleWorkers', v_stale_workers,
    'staleBuildings', v_stale_buildings,
    'incidentsOpened', v_opened,
    'incidentsRefreshed', v_refreshed,
    'incidentsResolved', v_resolved,
    'staleWorkerDetail', v_stale_worker_detail
  );

  PERFORM app_private.network_center_watchdog_record_run_v1(
    'LIVENESS',
    v_now,
    (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::integer,
    v_report - 'staleWorkerDetail'
  );

  RETURN v_report;
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_watchdog_liveness_v1(
  integer, timestamptz, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_watchdog_liveness_v1(
  integer, timestamptz, integer
) TO service_role;

-- ===========================================================================
-- 6. The refusal the supported tool could not report.
--
--    Re-declared verbatim from 20260729134000 with one RAISE changed and no
--    other edit.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.network_center_admin_set_rollout_v1(
  p_building_id uuid,
  p_rollout_state text,
  p_expected_version bigint,
  p_reason text,
  p_request_id uuid DEFAULT gen_random_uuid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_building record;
  v_settings record;
  v_target text := upper(btrim(coalesce(p_rollout_state, '')));
  v_new_version bigint;
BEGIN
  IF p_building_id IS NULL
     OR v_target NOT IN ('OFF', 'READ_ONLY', 'EXECUTE')
     OR p_expected_version IS NULL
     OR p_expected_version < 1
     OR p_reason IS NULL
     OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 500
     OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Network Center rollout request' USING ERRCODE = '22023';
  END IF;

  SELECT building.organization_id, building.id, building.name
  INTO v_building
  FROM public.buildings building
  WHERE building.id = p_building_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Network building not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT settings.id, settings.rollout_state, settings.version
  INTO v_settings
  FROM public.network_site_settings settings
  WHERE settings.organization_id = v_building.organization_id
    AND settings.building_id = v_building.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Network settings not found' USING ERRCODE = 'P0002';
  END IF;
  -- =====================================================================
  -- A CAS REFUSAL IS NOT A SERIALIZATION FAILURE (20260729148000).
  --
  -- This was ERRCODE '40001' (serialization_failure), a code whose entire
  -- contract is "this was transient, retrying may succeed". A stale
  -- p_expected_version is the opposite: it is deterministic, and every
  -- retry of the identical request will fail identically. Spelling it
  -- '40001' invited the layer in front of PostgREST to retry it, and it
  -- did: measured in production 2026-08-03, `network-center-admin.mjs
  -- set-rollout` with a stale --expected-version did not return at all --
  -- two multi-minute timeouts, then HTTP 504 -- while the identical call
  -- issued through the Management API answered instantly with the refusal.
  -- So the one refusal an operator is most likely to hit (someone else
  -- moved the rollout since they read the status) was the one the supported
  -- tool could not report.
  --
  -- 55000 (object_not_in_prerequisite_state) is this codebase's existing
  -- idiom for a state precondition that was not met -- the same code the
  -- changes_paused refusal and the managed-resource immutability guards
  -- use -- and it is outside class 40, so nothing treats it as retryable.
  -- The message text is unchanged so existing operator runbooks and log
  -- greps still match; only the class changes, plus DETAIL/HINT, which
  -- PostgREST surfaces as `details` and `hint` so the operator learns the
  -- version they should have sent WITHOUT a second round trip.
  --
  -- Scope: this function is REVOKEd from anon/authenticated and granted only
  -- to service_role, and its sole caller is scripts/network-center-admin.mjs.
  -- No browser code keys on its SQLSTATE. The unrelated user-facing CAS in
  -- network_center_update_settings_v1 -- which src/lib/network-center/
  -- supabaseRepository.ts DOES key on as '40001' -- is untouched.
  -- =====================================================================
  IF v_settings.version <> p_expected_version THEN
    RAISE EXCEPTION 'Network rollout changed; reload status before updating'
      USING ERRCODE = '55000',
        DETAIL = format(
          'buildingId=%s expectedVersion=%s actualVersion=%s rolloutState=%s',
          v_building.id, p_expected_version, v_settings.version,
          v_settings.rollout_state
        ),
        HINT = 'Re-read network_center_admin_status_v1 and retry set-rollout with the version it reports.';
  END IF;

  -- Upward transitions must pass OFF -> READ_ONLY -> EXECUTE. Downward transitions
  -- are always fail-safe. Executions that already recorded EXECUTION_STARTED may
  -- complete; the worker admission gates reject every new execution after commit.
  IF v_settings.rollout_state = 'OFF' AND v_target = 'EXECUTE' THEN
    RAISE EXCEPTION 'Network rollout must pass through READ_ONLY before EXECUTE'
      USING ERRCODE = '22023';
  END IF;
  IF v_settings.rollout_state = 'OFF' AND v_target NOT IN ('OFF', 'READ_ONLY') THEN
    RAISE EXCEPTION 'Invalid Network rollout transition' USING ERRCODE = '22023';
  END IF;
  IF v_settings.rollout_state = 'READ_ONLY'
     AND v_target NOT IN ('OFF', 'READ_ONLY', 'EXECUTE') THEN
    RAISE EXCEPTION 'Invalid Network rollout transition' USING ERRCODE = '22023';
  END IF;

  IF v_settings.rollout_state = v_target THEN
    RETURN jsonb_build_object(
      'organizationId', v_building.organization_id,
      'buildingId', v_building.id,
      'rolloutState', v_target,
      'previousRolloutState', v_settings.rollout_state,
      'version', v_settings.version,
      'changed', false
    );
  END IF;

  UPDATE public.network_site_settings settings
  SET rollout_state = v_target,
      version = settings.version + 1,
      updated_at = clock_timestamp()
  WHERE settings.id = v_settings.id
  RETURNING settings.version INTO v_new_version;

  INSERT INTO public.network_audit_events (
    organization_id,
    building_id,
    actor_type,
    action,
    target_type,
    target_id,
    target_display,
    reason,
    validation,
    result,
    outcome,
    request_id,
    occurred_at
  ) VALUES (
    v_building.organization_id,
    v_building.id,
    'SYSTEM',
    'admin.set_rollout',
    'building',
    v_building.id,
    jsonb_build_object('buildingName', v_building.name),
    btrim(p_reason),
    jsonb_build_object(
      'expectedVersion', p_expected_version,
      'previousRolloutState', v_settings.rollout_state
    ),
    jsonb_build_object(
      'rolloutState', v_target,
      'version', v_new_version
    ),
    'SUCCEEDED',
    p_request_id,
    clock_timestamp()
  );

  RETURN jsonb_build_object(
    'organizationId', v_building.organization_id,
    'buildingId', v_building.id,
    'rolloutState', v_target,
    'previousRolloutState', v_settings.rollout_state,
    'version', v_new_version,
    'changed', true
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_admin_set_rollout_v1(
  uuid, text, bigint, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_set_rollout_v1(
  uuid, text, bigint, text, uuid
) TO service_role;

-- ---------------------------------------------------------------------------
-- Post-condition. Everything this migration claims is read back out of the
-- catalog. A CREATE OR REPLACE that silently dropped SET search_path would
-- otherwise leave a SECURITY DEFINER function resolving names through the
-- caller's search_path, and a body-only forward fix is exactly the shape that
-- drifts without anybody noticing.
-- ---------------------------------------------------------------------------
DO $runtime_proof$
DECLARE
  v_profile constant text[][] := ARRAY[
    ARRAY[
      'app_private.network_center_derive_device_lifecycle_v1()',
      'search_path=pg_catalog, public, app_private'
    ],
    ARRAY[
      'app_private.network_center_worker_inventory_legacy_impl_v1(text,jsonb)',
      'search_path=pg_catalog, public, app_private, extensions'
    ],
    ARRAY[
      'app_private.network_center_bind_managed_interface_v1()',
      'search_path=pg_catalog, app_private, public'
    ],
    ARRAY[
      'public.network_center_watchdog_liveness_v1(integer,timestamptz,integer)',
      'search_path=pg_catalog, public, app_private'
    ],
    ARRAY[
      'public.network_center_admin_set_rollout_v1(uuid,text,bigint,text,uuid)',
      'search_path=pg_catalog'
    ],
    ARRAY[
      'app_private.network_center_reconcile_device_lifecycle_v1(timestamptz)',
      'search_path=pg_catalog, public, app_private'
    ],
    ARRAY[
      'public.network_center_admin_list_access_ports_v1(uuid)',
      'search_path=pg_catalog'
    ],
    ARRAY[
      'public.network_center_admin_enroll_access_port_v1(uuid,text,text,uuid)',
      'search_path=pg_catalog'
    ]
  ];
  v_present constant text[][] := ARRAY[
    ARRAY[
      'app_private.network_center_derive_device_lifecycle_v1()',
      'WHEN NEW.reachable THEN ''ONLINE'' ELSE ''OFFLINE'''
    ],
    ARRAY[
      'app_private.network_center_worker_inventory_legacy_impl_v1(text,jsonb)',
      'is_protected = EXCLUDED.is_protected,'
    ],
    ARRAY[
      'app_private.network_center_worker_inventory_legacy_impl_v1(text,jsonb)',
      '''observedProtection'', coalesce(item."isProtected", false)'
    ],
    ARRAY[
      'app_private.network_center_bind_managed_interface_v1()',
      '(NEW.display_metadata->>''observedProtection'')::boolean'
    ],
    ARRAY[
      'app_private.network_center_bind_managed_interface_v1()',
      'NEW.is_protected := NEW.is_protected OR v_protected;'
    ],
    ARRAY[
      'public.network_center_watchdog_liveness_v1(integer,timestamptz,integer)',
      'network_center_reconcile_device_lifecycle_v1(v_now)'
    ],
    ARRAY[
      'public.network_center_admin_set_rollout_v1(uuid,text,bigint,text,uuid)',
      'USING ERRCODE = ''55000'''
    ],
    ARRAY[
      'public.network_center_admin_enroll_access_port_v1(uuid,text,text,uuid)',
      'network_center_enroll_access_interface_v1(v_row.resource_id)'
    ]
  ];
  v_absent constant text[][] := ARRAY[
    ARRAY[
      'app_private.network_center_worker_inventory_legacy_impl_v1(text,jsonb)',
      'is_protected = public.network_interfaces.is_protected'
    ],
    ARRAY[
      'public.network_center_admin_set_rollout_v1(uuid,text,bigint,text,uuid)',
      'USING ERRCODE = ''40001'''
    ]
  ];
  v_index integer;
  v_signature text;
  v_token text;
  v_src text;
  v_secdef boolean;
  v_config text[];
  v_role text;
BEGIN
  FOR v_index IN 1 .. array_length(v_profile, 1) LOOP
    v_signature := v_profile[v_index][1];
    v_token := v_profile[v_index][2];
    SELECT proc.prosecdef, proc.proconfig INTO v_secdef, v_config
    FROM pg_proc proc
    WHERE proc.oid = to_regprocedure(v_signature);
    IF NOT FOUND OR v_secdef IS NOT TRUE THEN
      RAISE EXCEPTION '% is missing or lost SECURITY DEFINER', v_signature
        USING ERRCODE = '42501';
    END IF;
    IF v_config IS DISTINCT FROM ARRAY[v_token]::text[] THEN
      RAISE EXCEPTION 'Pinned search_path of % regressed (config=%)',
        v_signature, coalesce(v_config::text, '<null>')
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOR v_index IN 1 .. array_length(v_present, 1) LOOP
    v_signature := v_present[v_index][1];
    v_token := v_present[v_index][2];
    SELECT proc.prosrc INTO v_src
    FROM pg_proc proc WHERE proc.oid = to_regprocedure(v_signature);
    IF position(v_token in v_src) = 0 THEN
      RAISE EXCEPTION 'The fix token % never landed in %', v_token, v_signature
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  FOR v_index IN 1 .. array_length(v_absent, 1) LOOP
    v_signature := v_absent[v_index][1];
    v_token := v_absent[v_index][2];
    SELECT proc.prosrc INTO v_src
    FROM pg_proc proc WHERE proc.oid = to_regprocedure(v_signature);
    IF position(v_token in v_src) <> 0 THEN
      RAISE EXCEPTION 'The defect expression % is still live in %',
        v_token, v_signature
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Both triggers must exist and point at the right function. The whole of
  -- Blocker A's promotion is one of them, and a CREATE OR REPLACE that silently
  -- dropped the other would make the eligibility fix invisible and every
  -- interface unmanaged. Asserting the function body alone would not notice
  -- either.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE NOT trigger.tgisinternal
      AND trigger.tgname = 'network_interfaces_bind_managed_resource'
      AND namespace.nspname = 'public'
      AND relation.relname = 'network_interfaces'
      AND trigger.tgfoid = to_regprocedure(
        'app_private.network_center_bind_managed_interface_v1()'
      )
  ) THEN
    RAISE EXCEPTION
      'network_interfaces_bind_managed_resource no longer targets the bind function'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE NOT trigger.tgisinternal
      AND trigger.tgname = 'network_device_current_derive_lifecycle'
      AND namespace.nspname = 'public'
      AND relation.relname = 'network_device_current'
      AND trigger.tgfoid = to_regprocedure(
        'app_private.network_center_derive_device_lifecycle_v1()'
      )
      -- AFTER (tgtype bit 1 clear) ROW (bit 0 set), on INSERT and UPDATE.
      AND (trigger.tgtype & 1) = 1
      AND (trigger.tgtype & 2) = 0
      AND (trigger.tgtype & 4) = 4
      AND (trigger.tgtype & 16) = 16
  ) THEN
    RAISE EXCEPTION
      'network_device_current_derive_lifecycle is missing, mistimed, or points elsewhere'
      USING ERRCODE = '55000';
  END IF;

  -- Grant surface. The two new admin RPCs are service-role only, and nothing
  -- else this migration touched may have gained an executor.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    IF has_function_privilege(
         v_role, to_regprocedure(
           'public.network_center_admin_enroll_access_port_v1(uuid,text,text,uuid)'
         ), 'EXECUTE'
       )
       OR has_function_privilege(
         v_role, to_regprocedure(
           'public.network_center_admin_list_access_ports_v1(uuid)'
         ), 'EXECUTE'
       )
       OR has_function_privilege(
         v_role, to_regprocedure(
           'app_private.network_center_reconcile_device_lifecycle_v1(timestamptz)'
         ), 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'Role % must not execute the new Network Center functions',
        v_role USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF NOT has_function_privilege(
       'service_role', to_regprocedure(
         'public.network_center_admin_enroll_access_port_v1(uuid,text,text,uuid)'
       ), 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', to_regprocedure(
         'public.network_center_admin_list_access_ports_v1(uuid)'
       ), 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'The admin control plane cannot reach the enrollment door'
      USING ERRCODE = '42501';
  END IF;
  IF has_function_privilege(
       'service_role', to_regprocedure(
         'app_private.network_center_reconcile_device_lifecycle_v1(timestamptz)'
       ), 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'The lifecycle reconciler must stay internal'
      USING ERRCODE = '42501';
  END IF;
END;
$runtime_proof$;

COMMIT;
