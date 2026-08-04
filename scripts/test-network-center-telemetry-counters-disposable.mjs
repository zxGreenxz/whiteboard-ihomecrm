#!/usr/bin/env node
// Disposable PostgreSQL proof that stored telemetry says what was observed --
// and says nothing when nothing was observed.
//
// WHY THIS FILE EXISTS. After the first sixteen clean poll cycles this project
// has ever had, production held 128 rows in network_interface_samples and not
// one of them carried a byte counter: `sample` was `{}` on every row, because
// app_private.network_center_worker_ingest_legacy_impl_v1 wrote the LITERAL
// '{}'::jsonb into it. The worker sends rxBytes/txBytes/errorCount -- they are
// how network_interface_current holds real, strictly increasing values -- and
// the interface recordset destructures them one CTE above. They had nowhere to
// land and were dropped on the floor. So the CURRENT view was right and the
// HISTORY was empty: the only table that can show a trend recorded that a cycle
// happened and nothing about throughput.
//
// That is the failure mode that survives review, which is why the first
// assertion in every block below is that the row EXISTS AT ALL. A row that
// exists and is empty looks exactly like a row that was written correctly.
//
// The second defect is its mirror image. network_client_current.rx_bytes and
// tx_bytes were NOT NULL DEFAULT 0 and the writer coalesced the absent value to
// 0, so every client row asserted zero traffic AS FACT. The worker never emits
// them: a DHCP lease record carries no counter (measured read-only on the demo
// hEX, RouterOS 7.20.8 -- /ip/dhcp-server/lease/get returns 21 keys and not one
// is a byte or packet count), and every other per-client counter source on that
// hardware is empty or absent. A stored 0 that was never observed also
// manufactures a negative delta the moment a real reading arrives.
//
// Both are repaired by 20260729147000_network_center_telemetry_counter_honesty,
// which this proof picks up through the migration glob rather than by name, so
// deleting or reverting it makes this proof fail rather than silently stop
// covering anything.
//
// Every value asserted here is pushed through the REAL
// network_center_worker_ingest_v2 on a real PostgreSQL 17 cluster built from
// the real unmodified migrations, and read back out of the real tables. The
// cluster is created in TEMP, bound to 127.0.0.1 on an ephemeral port, has no
// restart policy, and its teardown is asserted by evidence (port closed,
// directory gone) by runDisposableLocalClusterMatrix. No Docker, no production
// credential, no remote host, no router.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { runDisposableLocalClusterMatrix } from "./network-center-disposable-db.mjs";

/** Raise together with the SQL whenever an assertion is added. */
export const TELEMETRY_COUNTER_PROOF_INVARIANTS = 29;

const DEMO_ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const PROOF_WORKER_ID = "dddd7000-0000-4000-8000-0000000000c0";
const PROOF_CREDENTIAL_DIGEST = "c".repeat(64);

// The counters below are arbitrary but DISTINCT, so an assertion that reads the
// wrong column or the wrong interface fails instead of coincidentally passing.
const CYCLE_ONE_RX = 1_024;
const CYCLE_ONE_TX = 2_048;
const CYCLE_ONE_ERRORS = 7;
const CYCLE_TWO_RX = 6_024;
const CYCLE_TWO_TX = 9_048;
const OBSERVED_CLIENT_RX = 4_242;
const OBSERVED_CLIENT_TX = 5_353;

export function buildTelemetryCounterProofSql({ localProof } = {}) {
  const nonce = String(localProof?.proofNonce ?? "");
  if (!/^[a-f0-9]{32}$/u.test(nonce)) {
    throw new Error(
      "Telemetry counter proof requires the disposable cluster proof nonce",
    );
  }
  return String.raw`
SET TIME ZONE 'UTC';
BEGIN;

-- Bind the run to the cluster it was built for. Without this the proof could be
-- pointed at any database - including production - and would still report PASS.
DO $bind$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app_private.network_center_disposable_proof
    WHERE proof_nonce = '${nonce}'
  ) THEN
    RAISE EXCEPTION
      'Telemetry counter proof is not running on its own disposable cluster';
  END IF;
END;
$bind$;

CREATE TEMP TABLE nct_results (
  name text PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.nct_assert(
  p_name text, p_condition boolean, p_detail text DEFAULT ''
) RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION 'TELEMETRY COUNTER PROOF FAILED [%]: %', p_name, p_detail;
  END IF;
  INSERT INTO pg_temp.nct_results (name) VALUES (p_name);
END;
$assert$;

-- ---------------------------------------------------------------------------
-- Fixture: the authoritative worker, its credential, its assignment, and two
-- interfaces on one seeded DEMO router. Interface A is the one that reports
-- counters; interface B is the bridge-slave case, which reports a link state
-- and nothing else - RouterOS omits rx-error/tx-error entirely for slave=true.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE nct_fixture ON COMMIT DROP AS
SELECT device.organization_id, device.building_id, device.id AS device_id
FROM public.network_devices device
WHERE device.organization_id = '${DEMO_ORGANIZATION_ID}'
  AND device.device_kind = 'MIKROTIK'
  AND device.is_active
ORDER BY device.building_id
LIMIT 1;

DO $fixture_preflight$
BEGIN
  IF (SELECT count(*) FROM nct_fixture) <> 1 THEN
    RAISE EXCEPTION 'Telemetry counter proof requires one seeded DEMO router, found %',
      (SELECT count(*) FROM nct_fixture);
  END IF;
END;
$fixture_preflight$;

INSERT INTO public.network_workers (
  id, worker_key, display_name, status, capabilities
) VALUES (
  '${PROOF_WORKER_ID}', 'nct-telemetry-counter-proof',
  'Telemetry counter proof worker', 'ACTIVE',
  ARRAY['POLL', 'INVENTORY', 'TELEMETRY']::text[]
);

INSERT INTO public.network_worker_credentials (
  worker_id, secret_digest, fingerprint, not_before, expires_at
) VALUES (
  '${PROOF_WORKER_ID}', '${PROOF_CREDENTIAL_DIGEST}'::character(64),
  'sha256:' || substr('${PROOF_CREDENTIAL_DIGEST}', 1, 24),
  clock_timestamp() - INTERVAL '1 minute',
  clock_timestamp() + INTERVAL '1 day'
);

INSERT INTO public.network_worker_assignments (
  worker_id, organization_id, building_id, device_id,
  can_poll, can_inventory, active_from
)
SELECT '${PROOF_WORKER_ID}', fixture.organization_id, fixture.building_id,
  fixture.device_id, true, true, clock_timestamp() - INTERVAL '1 minute'
FROM nct_fixture fixture;

-- ---------------------------------------------------------------------------
-- Schema shape, read out of the catalog. This is what makes "not observed"
-- REPRESENTABLE; without it every assertion below about a NULL counter could
-- be satisfied by a column that simply refused to store anything.
-- ---------------------------------------------------------------------------
DO $schema_shape$
DECLARE
  v_column record;
  v_definition text;
BEGIN
  FOR v_column IN
    SELECT *
    FROM (VALUES
      ('public.network_client_current', 'rx_bytes'),
      ('public.network_client_current', 'tx_bytes'),
      ('public.network_client_sessions', 'rx_bytes'),
      ('public.network_client_sessions', 'tx_bytes')
    ) AS pin(relation, column_name)
  LOOP
    PERFORM pg_temp.nct_assert(
      'not-observed-is-representable-on-' || v_column.relation || '.' || v_column.column_name,
      NOT EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        WHERE attribute.attrelid = to_regclass(v_column.relation)
          AND attribute.attname = v_column.column_name
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND (attribute.attnotnull OR attribute.atthasdef)
      ),
      'the column is still NOT NULL or still carries a DEFAULT, so a stored 0 '
        || 'is indistinguishable from an unobserved counter'
    );
  END LOOP;

  FOR v_column IN
    SELECT *
    FROM (VALUES
      ('public.network_client_current', 'network_client_current_traffic_check'),
      ('public.network_client_sessions', 'network_client_sessions_traffic_check')
    ) AS pin(relation, constraint_name)
  LOOP
    SELECT pg_get_constraintdef(constraint_row.oid) INTO v_definition
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = to_regclass(v_column.relation)
      AND constraint_row.conname = v_column.constraint_name;
    PERFORM pg_temp.nct_assert(
      'traffic-check-admits-an-unobserved-counter-on-' || v_column.relation,
      v_definition IS NOT NULL
      AND position('rx_bytes IS NULL' in v_definition) > 0
      AND position('tx_bytes IS NULL' in v_definition) > 0,
      coalesce(v_definition, '<missing constraint>')
    );
  END LOOP;
END;
$schema_shape$;

-- ---------------------------------------------------------------------------
-- The seam: two real poll cycles through the real ingest RPC.
-- ---------------------------------------------------------------------------
DO $ingest_proof$
DECLARE
  v_org uuid;
  v_building uuid;
  v_router uuid;
  v_interface_a uuid;
  v_interface_b uuid;
  v_cycle_one timestamptz;
  v_cycle_two timestamptz;
  v_sample jsonb;
  v_sample_b jsonb;
  v_current_rx bigint;
  v_row record;
  v_delta bigint;
  v_offender text;
BEGIN
  SELECT organization_id, building_id, device_id
  INTO v_org, v_building, v_router FROM nct_fixture;

  INSERT INTO public.network_interfaces (
    organization_id, building_id, device_id, interface_key, display_name,
    interface_kind, interface_role, sort_order
  ) VALUES
    (v_org, v_building, v_router, 'ether1', 'ether1', 'ETHERNET', 'ACCESS', 1)
  RETURNING id INTO v_interface_a;
  INSERT INTO public.network_interfaces (
    organization_id, building_id, device_id, interface_key, display_name,
    interface_kind, interface_role, sort_order
  ) VALUES
    (v_org, v_building, v_router, 'ether2', 'ether2', 'ETHERNET', 'ACCESS', 2)
  RETURNING id INTO v_interface_b;

  -- ---- cycle one ----------------------------------------------------------
  -- interfaces[0] is the shape the worker really sends for a counting port;
  -- interfaces[1] is the shape it sends for a bridge slave, where RouterOS
  -- omits the counters entirely and errorCountFrom() returns null.
  -- clients[0] is EXACTLY what the worker emits for a DHCP lease: no rxBytes,
  -- no txBytes, because a lease record carries neither.
  -- clients[1] is a hypothetical future producer that DOES observe counters,
  -- which is what keeps the nullable columns from silently becoming
  -- write-only.
  v_cycle_one := clock_timestamp();
  PERFORM public.network_center_worker_ingest_v2(
    '${PROOF_CREDENTIAL_DIGEST}',
    jsonb_build_object(
      'observedAt', v_cycle_one,
      'devices', jsonb_build_array(jsonb_build_object(
        'deviceId', v_router, 'lastSeenAt', v_cycle_one, 'reachable', true,
        'healthStatus', 'HEALTHY', 'identity', 'NCT-CYCLE-ONE',
        'connectionCount', 2
      )),
      'interfaces', jsonb_build_array(
        jsonb_build_object(
          'interfaceId', v_interface_a, 'linkState', 'UP',
          'rxBytes', ${CYCLE_ONE_RX}, 'txBytes', ${CYCLE_ONE_TX},
          'errorCount', ${CYCLE_ONE_ERRORS}
        ),
        jsonb_build_object('interfaceId', v_interface_b, 'linkState', 'DOWN')
      ),
      'clients', jsonb_build_array(
        jsonb_build_object(
          'deviceId', v_router, 'interfaceId', v_interface_a,
          'sessionKey', 'dhcp:nct-lease-no-counters',
          'clientFingerprint', 'nct-lease-no-counters-fingerprint',
          'observedMac', 'bc:fc:e7:64:e3:fb', 'observedIp', '192.168.88.254',
          'hostname', 'NCT-LEASE', 'connectionType', 'UNKNOWN',
          'sessionType', 'DHCP', 'firstSeenAt', v_cycle_one,
          'lastSeenAt', v_cycle_one, 'expiresAt', v_cycle_one + INTERVAL '1 hour',
          'randomizedMac', false
        ),
        jsonb_build_object(
          'deviceId', v_router, 'sessionKey', 'dhcp:nct-observed-counters',
          'clientFingerprint', 'nct-observed-counters-fingerprint',
          'connectionType', 'UNKNOWN', 'sessionType', 'DHCP',
          'rxBytes', ${OBSERVED_CLIENT_RX}, 'txBytes', ${OBSERVED_CLIENT_TX},
          'firstSeenAt', v_cycle_one, 'lastSeenAt', v_cycle_one,
          'expiresAt', v_cycle_one + INTERVAL '1 hour'
        )
      )
    )
  );

  -- =========================================================================
  -- GAP 2 - the history
  -- =========================================================================
  -- Non-vacuity first. Everything after this is meaningless if no sample row
  -- was written, and a suite that skipped this step is how 128 empty rows
  -- passed for working telemetry.
  PERFORM pg_temp.nct_assert(
    'a-sample-row-exists-at-all-for-the-polled-interface',
    EXISTS (
      SELECT 1 FROM public.network_interface_samples sample
      WHERE sample.interface_id = v_interface_a
    ),
    'network_interface_samples has no row for the interface just polled'
  );

  SELECT sample.sample INTO v_sample
  FROM public.network_interface_samples sample
  WHERE sample.interface_id = v_interface_a;

  PERFORM pg_temp.nct_assert(
    'the-sample-payload-is-not-an-empty-object',
    v_sample IS NOT NULL AND v_sample <> '{}'::jsonb,
    'sample=' || coalesce(v_sample::text, '<null>')
  );
  PERFORM pg_temp.nct_assert(
    'the-sample-carries-the-rx-counter-the-worker-sent',
    (v_sample->>'rxBytes')::bigint = ${CYCLE_ONE_RX},
    'sample=' || coalesce(v_sample::text, '<null>')
  );
  PERFORM pg_temp.nct_assert(
    'the-sample-carries-the-tx-counter-the-worker-sent',
    (v_sample->>'txBytes')::bigint = ${CYCLE_ONE_TX},
    'sample=' || coalesce(v_sample::text, '<null>')
  );
  PERFORM pg_temp.nct_assert(
    'the-sample-carries-the-error-count-the-worker-sent',
    (v_sample->>'errorCount')::bigint = ${CYCLE_ONE_ERRORS},
    'sample=' || coalesce(v_sample::text, '<null>')
  );
  PERFORM pg_temp.nct_assert(
    'the-sample-carries-the-link-state-so-a-quiet-cycle-is-never-an-empty-object',
    v_sample->>'linkState' = 'UP',
    'sample=' || coalesce(v_sample::text, '<null>')
  );

  -- The invariant that actually matters: the history agrees with the view that
  -- was already known to be right, for the same observation instant.
  SELECT entry.rx_bytes INTO v_current_rx
  FROM public.network_interface_current entry
  WHERE entry.interface_id = v_interface_a;
  PERFORM pg_temp.nct_assert(
    'the-history-agrees-with-the-current-row-for-the-same-cycle',
    v_current_rx IS NOT NULL
    AND (v_sample->>'rxBytes')::bigint = v_current_rx,
    'current=' || coalesce(v_current_rx::text, '<null>')
      || ' sample=' || coalesce(v_sample->>'rxBytes', '<absent>')
  );

  -- The bridge-slave case: absent, never a fabricated zero. This is the same
  -- distinction network_interface_current.error_count already makes, and it is
  -- only representable because the payload is stripped rather than defaulted.
  SELECT sample.sample INTO v_sample_b
  FROM public.network_interface_samples sample
  WHERE sample.interface_id = v_interface_b;
  PERFORM pg_temp.nct_assert(
    'a-sample-row-exists-at-all-for-the-interface-that-reported-no-counters',
    v_sample_b IS NOT NULL,
    'network_interface_samples has no row for the slave interface'
  );
  PERFORM pg_temp.nct_assert(
    'an-unreported-counter-is-absent-from-the-sample-not-zero',
    NOT (v_sample_b ? 'rxBytes')
    AND NOT (v_sample_b ? 'txBytes')
    AND NOT (v_sample_b ? 'errorCount'),
    'sample=' || coalesce(v_sample_b::text, '<null>')
  );
  PERFORM pg_temp.nct_assert(
    'a-row-that-reported-no-counters-still-records-what-it-did-observe',
    v_sample_b->>'linkState' = 'DOWN',
    'sample=' || coalesce(v_sample_b::text, '<null>')
  );

  -- =========================================================================
  -- GAP 3 - the false zero
  -- =========================================================================
  PERFORM pg_temp.nct_assert(
    'a-client-row-exists-at-all',
    EXISTS (
      SELECT 1 FROM public.network_client_current client
      WHERE client.session_key = 'dhcp:nct-lease-no-counters'
    ),
    'the client half of the batch did not land'
  );

  SELECT client.rx_bytes, client.tx_bytes INTO v_row
  FROM public.network_client_current client
  WHERE client.session_key = 'dhcp:nct-lease-no-counters';
  PERFORM pg_temp.nct_assert(
    'an-unobserved-client-counter-is-null-not-zero',
    v_row.rx_bytes IS NULL AND v_row.tx_bytes IS NULL,
    'rx=' || coalesce(v_row.rx_bytes::text, 'NULL')
      || ' tx=' || coalesce(v_row.tx_bytes::text, 'NULL')
  );

  PERFORM pg_temp.nct_assert(
    'a-client-session-history-row-exists-at-all',
    EXISTS (
      SELECT 1 FROM public.network_client_sessions session
      WHERE session.session_key = 'dhcp:nct-lease-no-counters'
    ),
    'network_client_sessions was not written'
  );
  SELECT session.rx_bytes, session.tx_bytes INTO v_row
  FROM public.network_client_sessions session
  WHERE session.session_key = 'dhcp:nct-lease-no-counters';
  PERFORM pg_temp.nct_assert(
    'an-unobserved-client-counter-is-null-in-the-session-history-too',
    v_row.rx_bytes IS NULL AND v_row.tx_bytes IS NULL,
    'rx=' || coalesce(v_row.rx_bytes::text, 'NULL')
      || ' tx=' || coalesce(v_row.tx_bytes::text, 'NULL')
  );

  -- Nullable must not mean write-only: a producer that DOES observe counters
  -- still gets them stored, verbatim.
  SELECT client.rx_bytes, client.tx_bytes INTO v_row
  FROM public.network_client_current client
  WHERE client.session_key = 'dhcp:nct-observed-counters';
  PERFORM pg_temp.nct_assert(
    'an-observed-client-counter-is-still-stored-verbatim',
    v_row.rx_bytes = ${OBSERVED_CLIENT_RX} AND v_row.tx_bytes = ${OBSERVED_CLIENT_TX},
    'rx=' || coalesce(v_row.rx_bytes::text, 'NULL')
      || ' tx=' || coalesce(v_row.tx_bytes::text, 'NULL')
  );

  -- ---- cycle two ----------------------------------------------------------
  -- Larger interface counters, and the observed client re-polled with NO
  -- counters at all.
  v_cycle_two := clock_timestamp() + INTERVAL '1 second';
  PERFORM public.network_center_worker_ingest_v2(
    '${PROOF_CREDENTIAL_DIGEST}',
    jsonb_build_object(
      'observedAt', v_cycle_two,
      'interfaces', jsonb_build_array(jsonb_build_object(
        'interfaceId', v_interface_a, 'linkState', 'UP',
        'rxBytes', ${CYCLE_TWO_RX}, 'txBytes', ${CYCLE_TWO_TX}
      )),
      'clients', jsonb_build_array(jsonb_build_object(
        'deviceId', v_router, 'sessionKey', 'dhcp:nct-observed-counters',
        'clientFingerprint', 'nct-observed-counters-fingerprint',
        'connectionType', 'UNKNOWN', 'sessionType', 'DHCP',
        'firstSeenAt', v_cycle_one, 'lastSeenAt', v_cycle_two,
        'expiresAt', v_cycle_two + INTERVAL '1 hour'
      ))
    )
  );

  -- THE POINT OF GAP 2: a trend, computed from the history table alone. Before
  -- the fix this query returned nothing at all, because every rxBytes was
  -- absent from every sample.
  PERFORM pg_temp.nct_assert(
    'two-cycles-produce-two-sample-rows',
    (SELECT count(*) FROM public.network_interface_samples sample
      WHERE sample.interface_id = v_interface_a) = 2,
    'sample rows: ' || (SELECT count(*)::text FROM public.network_interface_samples sample
      WHERE sample.interface_id = v_interface_a)
  );
  SELECT max((sample.sample->>'rxBytes')::bigint)
       - min((sample.sample->>'rxBytes')::bigint)
  INTO v_delta
  FROM public.network_interface_samples sample
  WHERE sample.interface_id = v_interface_a;
  PERFORM pg_temp.nct_assert(
    'the-history-alone-yields-the-throughput-delta-between-two-cycles',
    v_delta = ${CYCLE_TWO_RX} - ${CYCLE_ONE_RX},
    'delta=' || coalesce(v_delta::text, '<null - the samples carry no counters>')
  );

  -- A later poll that observes nothing must not erase what was observed
  -- earlier. GREATEST ignores NULL in PostgreSQL - the opposite of most
  -- dialects - which is exactly what makes the cumulative session counter
  -- survive an unobserved cycle. Pinned here because it is load-bearing and
  -- non-obvious.
  SELECT session.rx_bytes, session.tx_bytes INTO v_row
  FROM public.network_client_sessions session
  WHERE session.session_key = 'dhcp:nct-observed-counters';
  PERFORM pg_temp.nct_assert(
    'an-unobserved-cycle-does-not-erase-an-earlier-observed-session-counter',
    v_row.rx_bytes = ${OBSERVED_CLIENT_RX} AND v_row.tx_bytes = ${OBSERVED_CLIENT_TX},
    'rx=' || coalesce(v_row.rx_bytes::text, 'NULL')
      || ' tx=' || coalesce(v_row.tx_bytes::text, 'NULL')
  );

  -- ...while the CURRENT row follows the latest observation, so it reports
  -- "not observed" rather than repeating a stale number as if it were fresh.
  SELECT client.rx_bytes, client.tx_bytes INTO v_row
  FROM public.network_client_current client
  WHERE client.session_key = 'dhcp:nct-observed-counters';
  PERFORM pg_temp.nct_assert(
    'the-current-row-reports-the-latest-observation-including-its-absence',
    v_row.rx_bytes IS NULL AND v_row.tx_bytes IS NULL,
    'rx=' || coalesce(v_row.rx_bytes::text, 'NULL')
      || ' tx=' || coalesce(v_row.tx_bytes::text, 'NULL')
  );

  -- =========================================================================
  -- Catalog sweeps, so a future writer cannot reintroduce either shape.
  --
  -- Comments are stripped before matching. pg_proc.prosrc keeps them, and the
  -- repaired body quotes the defect it removed in its own comment, so a sweep
  -- that reads prose as code flags the fix itself.
  -- =========================================================================
  SELECT string_agg(
    schema_row.nspname || '.' || function_row.proname, ', '
    ORDER BY schema_row.nspname || '.' || function_row.proname
  )
  INTO v_offender
  FROM pg_proc function_row
  JOIN pg_namespace schema_row ON schema_row.oid = function_row.pronamespace
  WHERE schema_row.nspname IN ('public', 'app_private')
    AND function_row.proname LIKE 'network\_%'
    AND function_row.prosrc IS NOT NULL
    AND regexp_replace(function_row.prosrc, '--[^\n]*', '', 'g')
          ~ 'coalesce\("(rx|tx)Bytes", 0\)';
  PERFORM pg_temp.nct_assert(
    'no-live-function-coalesces-a-byte-counter-to-a-fabricated-zero',
    v_offender IS NULL,
    'offenders: ' || coalesce(v_offender, '<none>')
  );

  SELECT string_agg(
    schema_row.nspname || '.' || function_row.proname, ', '
    ORDER BY schema_row.nspname || '.' || function_row.proname
  )
  INTO v_offender
  FROM pg_proc function_row
  JOIN pg_namespace schema_row ON schema_row.oid = function_row.pronamespace
  WHERE schema_row.nspname IN ('public', 'app_private')
    AND function_row.proname LIKE 'network\_%'
    AND function_row.prosrc IS NOT NULL
    AND regexp_replace(function_row.prosrc, '--[^\n]*', '', 'g')
          ~ 'INSERT INTO public\.network_(device|interface)_samples'
    AND regexp_replace(function_row.prosrc, '--[^\n]*', '', 'g')
          ~ '''\{\}''::jsonb';
  PERFORM pg_temp.nct_assert(
    'no-live-function-writes-a-telemetry-sample-as-an-empty-object',
    v_offender IS NULL,
    'offenders: ' || coalesce(v_offender, '<none>')
  );

  -- The definer profile of the replaced writer, read back rather than assumed:
  -- CREATE OR REPLACE silently drops SET search_path, which would leave a
  -- SECURITY DEFINER function resolving names through the caller's path.
  PERFORM pg_temp.nct_assert(
    'the-replaced-writer-kept-its-definer-profile',
    EXISTS (
      SELECT 1 FROM pg_proc proc
      WHERE proc.oid = to_regprocedure(
        'app_private.network_center_worker_ingest_legacy_impl_v1(text,jsonb)'
      )
        AND proc.prosecdef IS TRUE
        AND proc.provolatile = 'v'
        AND proc.proconfig = ARRAY['search_path=pg_catalog, public, app_private']::text[]
    ),
    'the ingest writer lost SECURITY DEFINER, its volatility, or its search_path'
  );
  PERFORM pg_temp.nct_assert(
    'the-replaced-writer-kept-its-empty-grant-surface',
    NOT has_function_privilege('public',
      'app_private.network_center_worker_ingest_legacy_impl_v1(text,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon',
      'app_private.network_center_worker_ingest_legacy_impl_v1(text,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated',
      'app_private.network_center_worker_ingest_legacy_impl_v1(text,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('service_role',
      'app_private.network_center_worker_ingest_legacy_impl_v1(text,jsonb)', 'EXECUTE'),
    'the ingest writer became callable by a role that must not reach it'
  );
END;
$ingest_proof$;

SELECT jsonb_build_object(
  'status', 'PASS',
  'invariants', (SELECT count(*)::integer FROM pg_temp.nct_results),
  'proofNonce', (
    SELECT proof_nonce FROM app_private.network_center_disposable_proof
    WHERE proof_nonce = '${nonce}'
  ),
  'names', (SELECT jsonb_agg(name ORDER BY name) FROM pg_temp.nct_results)
) AS disposable_telemetry_counter_proof;

ROLLBACK;
`;
}

export function parseProofVerdict(output) {
  const verdicts = String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) =>
      entry !== null && typeof entry === "object"
      && Object.hasOwn(entry, "invariants")
    );
  return verdicts.at(-1) ?? null;
}

export function parseTelemetryCounterProofVerdict(
  output,
  { expectedLocalProof } = {},
) {
  const verdict = parseProofVerdict(output);
  if (
    verdict?.status !== "PASS"
    || verdict?.invariants !== TELEMETRY_COUNTER_PROOF_INVARIANTS
    || verdict?.proofNonce !== expectedLocalProof?.proofNonce
  ) {
    throw new Error(
      "Disposable telemetry counter proof did not return the expected PASS "
        + `verdict: ${JSON.stringify(verdict)}`,
    );
  }
  if (
    !Array.isArray(verdict.names)
    || new Set(verdict.names).size !== TELEMETRY_COUNTER_PROOF_INVARIANTS
  ) {
    throw new Error(
      "Disposable telemetry counter proof returned a malformed assertion "
        + `ledger: ${JSON.stringify(verdict?.names)}`,
    );
  }
  return verdict;
}

export async function runTelemetryCounterProof({
  environment = process.env,
} = {}) {
  return runDisposableLocalClusterMatrix({
    buildSql: buildTelemetryCounterProofSql,
    parseVerdict: parseTelemetryCounterProofVerdict,
    environment,
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    throw new Error(
      "Usage: node scripts/test-network-center-telemetry-counters-disposable.mjs [--dry-run]",
    );
  }
  if (args[0] === "--dry-run") {
    buildTelemetryCounterProofSql({
      localProof: { proofNonce: "0".repeat(32) },
    });
    process.stdout.write(
      "Disposable telemetry counter proof dry-run passed; no PostgreSQL "
        + "process was started.\n",
    );
    return;
  }
  const verdict = await runTelemetryCounterProof();
  process.stdout.write(
    "Disposable PostgreSQL telemetry counter proof PASS: "
      + `${verdict.invariants}/${TELEMETRY_COUNTER_PROOF_INVARIANTS} invariants.\n`,
  );
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}
