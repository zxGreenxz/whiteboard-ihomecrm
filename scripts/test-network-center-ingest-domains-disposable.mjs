#!/usr/bin/env node
// Disposable PostgreSQL proof that every enumerated value the worker sends to
// the telemetry ingest is a value the database actually accepts.
//
// WHY THIS FILE EXISTS. The worker sent `connectionType: "DHCP"` and
// `sessionType: "LEASE"`. The live domains are
// `connection_type IN (UNKNOWN, ETHERNET, WIFI, VPN)` and
// `session_type IN (UNKNOWN, DHCP, HOTSPOT, STATIC, ARP)`, so BOTH were
// rejected - the two had been swapped, and `LEASE` was never a telemetry value
// in any version of this schema. `network_center_worker_ingest_v2` is ONE
// transaction, so the single bad client row rolled back the devices and
// interfaces with it, and the demo router has exactly one DHCP lease, so the
// batch could never contain zero clients and could never succeed.
//
// It survived four independent layers:
//   1. `RouterClientObservation` was an index signature, so neither literal was
//      typed as anything but `string`;
//   2. no test asserted either value - the fake router answered the lease
//      command with "", so `observation.clients` was `[]` in all 422 tests;
//   3. the Edge function validated array SHAPE and never value DOMAIN;
//   4. `23514` was unmapped in `rpcErrorStatus`, so the failure arrived as a
//      generic 502 and the worker logged the single word `ApiClientError`.
//
// So this proof refuses to restate the allowed values. It reads:
//   - the DOMAINS from `pg_get_constraintdef` on a real PostgreSQL 17 cluster
//     built from the real, unmodified migrations;
//   - the LITERALS the worker emits from `sshConnector.ts` itself;
//   - the domain sets declared by `domain.ts` and by the Edge function's own
//     source;
// and then pushes the emitted literals through the REAL ingest RPC. A test that
// retyped the lists by hand would have passed against the broken worker, which
// is precisely how this defect reached production.
//
// The cluster is created in TEMP, bound to 127.0.0.1 on an ephemeral port, has
// no restart policy, and its teardown is asserted by evidence (port closed,
// directory gone) by runDisposableLocalClusterMatrix. No Docker, no production
// credential, no remote host, no router.
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDisposableLocalClusterMatrix } from "./network-center-disposable-db.mjs";
import {
  readDeclaredDomains,
  readEmittedClientLiterals,
} from "./network-center-source-domains.mjs";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const DEMO_ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const PROOF_WORKER_ID = "dddd7000-0000-4000-8000-0000000000d0";
const PROOF_CREDENTIAL_DIGEST = "d".repeat(64);

/**
 * Assertions that do not depend on how many domains are bound. Raise this only
 * together with the SQL; the per-binding assertions are counted from the binding
 * table itself so adding a binding raises the expectation automatically.
 */
export const FIXED_INGEST_DOMAIN_INVARIANTS = 15;

export function expectedInvariants(bindings) {
  const perBinding = bindings.length * 2
    + bindings.filter((binding) => binding.workerSymbol !== null).length;
  return FIXED_INGEST_DOMAIN_INVARIANTS + perBinding;
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function sqlTextArray(members) {
  if (members === null) return "NULL::text[]";
  return `ARRAY[${[...members].sort().map(sqlLiteral).join(", ")}]::text[]`;
}

function bindingRows(domains) {
  return domains.map((binding) =>
    `      (${sqlLiteral(binding.field)}, ${sqlLiteral(binding.table)},\n`
    + `       ${sqlLiteral(binding.column)}, ${sqlTextArray(binding.edgeMembers)},\n`
    + `       ${sqlTextArray(binding.workerMembers)})`
  ).join(",\n");
}

export function buildIngestDomainProofSql({
  localProof,
  emitted,
  domains,
} = {}) {
  const nonce = String(localProof?.proofNonce ?? "");
  if (!/^[a-f0-9]{32}$/u.test(nonce)) {
    throw new Error(
      "Ingest domain proof requires the disposable cluster proof nonce",
    );
  }
  if (!emitted?.connectionType || !emitted?.sessionType) {
    throw new Error(
      "Ingest domain proof requires the literals read from the connector source",
    );
  }
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error("Ingest domain proof requires at least one domain binding");
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
      'Ingest domain proof is not running on its own disposable cluster';
  END IF;
END;
$bind$;

CREATE TEMP TABLE ncd_results (
  name text PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
) ON COMMIT DROP;

CREATE TEMP TABLE ncd_measurements (
  key text PRIMARY KEY,
  value text
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.ncd_assert(
  p_name text, p_condition boolean, p_detail text DEFAULT ''
) RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION 'INGEST DOMAIN PROOF FAILED [%]: %', p_name, p_detail;
  END IF;
  INSERT INTO pg_temp.ncd_results (name) VALUES (p_name);
END;
$assert$;

-- THE ONLY AUTHORITY IN THIS FILE. The accepted values are read out of the
-- catalog of the cluster this run just built from the real migrations, never
-- named here. "conkey = ARRAY[attnum]" keeps it to single-column CHECKs, so a
-- composite constraint that merely mentions the column cannot widen the answer.
-- Returns NULL when no such constraint exists, and every caller treats NULL as
-- a failure rather than as an empty domain.
CREATE FUNCTION pg_temp.ncd_catalog_domain(p_table regclass, p_column text)
RETURNS text[] LANGUAGE sql STABLE AS $domain$
  SELECT array_agg(DISTINCT member ORDER BY member)
  FROM pg_catalog.pg_constraint constraint_row
  JOIN pg_catalog.pg_attribute column_row
    ON column_row.attrelid = constraint_row.conrelid
   AND column_row.attname = p_column
   AND column_row.attnum > 0
   AND NOT column_row.attisdropped
  CROSS JOIN LATERAL regexp_matches(
    pg_catalog.pg_get_constraintdef(constraint_row.oid),
    '''([^'']*)''::text',
    'g'
  ) AS captured(parts)
  CROSS JOIN LATERAL unnest(captured.parts) AS member
  WHERE constraint_row.conrelid = p_table
    AND constraint_row.contype = 'c'
    AND constraint_row.conkey = ARRAY[column_row.attnum]
    AND pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%= ANY (ARRAY[%'
$domain$;

-- The NAME of the single-column enumerated CHECK that governs a column, read
-- from the catalog. Postgres reports the violated constraint by name, and the
-- names do not follow the column ("connection_type" is policed by
-- "network_client_current_type_check"), so pattern-matching the name would be a
-- guess. This makes "the failure named the right column" a comparison between
-- two catalog facts.
CREATE FUNCTION pg_temp.ncd_constraint_for(p_table regclass, p_column text)
RETURNS text LANGUAGE sql STABLE AS $named$
  SELECT constraint_row.conname::text
  FROM pg_catalog.pg_constraint constraint_row
  JOIN pg_catalog.pg_attribute column_row
    ON column_row.attrelid = constraint_row.conrelid
   AND column_row.attname = p_column
   AND column_row.attnum > 0
   AND NOT column_row.attisdropped
  WHERE constraint_row.conrelid = p_table
    AND constraint_row.contype = 'c'
    AND constraint_row.conkey = ARRAY[column_row.attnum]
    AND pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%= ANY (ARRAY[%';
$named$;

-- Which (table, column) pairs anywhere in "public" admit a given literal. This
-- is how the corrected mapping is CONFIRMED rather than assumed: "DHCP" must
-- turn out to be legal in exactly one place, and it must be a session type.
CREATE FUNCTION pg_temp.ncd_columns_admitting(p_value text)
RETURNS text LANGUAGE sql STABLE AS $admits$
  SELECT string_agg(DISTINCT label, ', ' ORDER BY label)
  FROM (
    SELECT table_row.relname || '.' || column_row.attname AS label
    FROM pg_catalog.pg_constraint constraint_row
    JOIN pg_catalog.pg_class table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_catalog.pg_namespace schema_row
      ON schema_row.oid = table_row.relnamespace
    JOIN pg_catalog.pg_attribute column_row
      ON column_row.attrelid = constraint_row.conrelid
     AND column_row.attnum = ANY (constraint_row.conkey)
    WHERE schema_row.nspname = 'public'
      AND constraint_row.contype = 'c'
      AND constraint_row.conkey = ARRAY[column_row.attnum]
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
          LIKE '%''' || p_value || '''::text%'
  ) matched;
$admits$;

-- ---------------------------------------------------------------------------
-- Layer 1 and layer 3: every TypeScript restatement, against the catalog.
-- ---------------------------------------------------------------------------
DO $declared_domains$
DECLARE
  v_binding record;
  v_catalog text[];
BEGIN
  FOR v_binding IN
    SELECT *
    FROM (VALUES
${bindingRows(domains)}
    ) AS binding(field, table_name, column_name, edge_members, worker_members)
  LOOP
    v_catalog := pg_temp.ncd_catalog_domain(
      v_binding.table_name::regclass, v_binding.column_name
    );
    PERFORM pg_temp.ncd_assert(
      'catalog-declares-a-domain-for-' || v_binding.table_name || '.' || v_binding.column_name,
      v_catalog IS NOT NULL AND array_length(v_catalog, 1) > 0,
      'no single-column enumerated CHECK found; the proof cannot read this domain'
    );
    PERFORM pg_temp.ncd_assert(
      'edge-domain-matches-catalog-for-' || v_binding.table_name || '.' || v_binding.column_name,
      v_binding.edge_members = v_catalog,
      'edge=' || v_binding.edge_members::text || ' catalog=' || v_catalog::text
    );
    IF v_binding.worker_members IS NOT NULL THEN
      PERFORM pg_temp.ncd_assert(
        'worker-domain-matches-catalog-for-' || v_binding.table_name || '.' || v_binding.column_name,
        v_binding.worker_members = v_catalog,
        'worker=' || v_binding.worker_members::text || ' catalog=' || v_catalog::text
      );
    END IF;
  END LOOP;
END;
$declared_domains$;

-- ---------------------------------------------------------------------------
-- The defect itself: the literals the shipping connector assigns.
-- ---------------------------------------------------------------------------
DO $emitted_literals$
DECLARE
  v_connection_domain text[] := pg_temp.ncd_catalog_domain(
    'public.network_client_current'::regclass, 'connection_type'
  );
  v_session_domain text[] := pg_temp.ncd_catalog_domain(
    'public.network_client_current'::regclass, 'session_type'
  );
BEGIN
  PERFORM pg_temp.ncd_assert(
    'worker-emits-a-connection-type-the-schema-accepts',
    ${sqlLiteral(emitted.connectionType)} = ANY (v_connection_domain),
    'emitted=' || ${sqlLiteral(emitted.connectionType)}
      || ' domain=' || v_connection_domain::text
  );
  PERFORM pg_temp.ncd_assert(
    'worker-emits-a-session-type-the-schema-accepts',
    ${sqlLiteral(emitted.sessionType)} = ANY (v_session_domain),
    'emitted=' || ${sqlLiteral(emitted.sessionType)}
      || ' domain=' || v_session_domain::text
  );
  -- The corrected mapping, derived. "DHCP" is legal in exactly one column in
  -- the whole schema and that column is a SESSION type, which is what makes
  -- "the two were swapped" a measurement rather than a reading of the diff.
  PERFORM pg_temp.ncd_assert(
    'dhcp-is-legal-only-as-a-session-type',
    pg_temp.ncd_columns_admitting('DHCP') = 'network_client_current.session_type',
    'admitted by: ' || coalesce(pg_temp.ncd_columns_admitting('DHCP'), '<nowhere>')
  );
  -- And "LEASE" is not a telemetry value at all: the only column that admits it
  -- is a link SOURCE, which the ingest never writes.
  PERFORM pg_temp.ncd_assert(
    'lease-is-not-a-telemetry-value-in-this-schema',
    pg_temp.ncd_columns_admitting('LEASE') = 'network_client_links.source',
    'admitted by: ' || coalesce(pg_temp.ncd_columns_admitting('LEASE'), '<nowhere>')
  );
END;
$emitted_literals$;

-- ---------------------------------------------------------------------------
-- Fixture: the authoritative worker, its credential, its assignments, and two
-- interfaces on one seeded DEMO router.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE ncd_fixture ON COMMIT DROP AS
SELECT device.organization_id, device.building_id, device.id AS device_id
FROM public.network_devices device
WHERE device.organization_id = '${DEMO_ORGANIZATION_ID}'
  AND device.device_kind = 'MIKROTIK'
  AND device.is_active
ORDER BY device.building_id
LIMIT 1;

DO $fixture_preflight$
BEGIN
  IF (SELECT count(*) FROM ncd_fixture) <> 1 THEN
    RAISE EXCEPTION 'Ingest domain proof requires one seeded DEMO router, found %',
      (SELECT count(*) FROM ncd_fixture);
  END IF;
END;
$fixture_preflight$;

INSERT INTO public.network_workers (
  id, worker_key, display_name, status, capabilities
) VALUES (
  '${PROOF_WORKER_ID}', 'ncd-ingest-domain-proof',
  'Ingest domain proof worker', 'ACTIVE',
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
FROM ncd_fixture fixture;

DO $ingest_proof$
DECLARE
  v_org uuid;
  v_building uuid;
  v_router uuid;
  v_interface_a uuid;
  v_interface_b uuid;
  v_now timestamptz;
  v_sqlstate text;
  v_constraint text;
BEGIN
  SELECT organization_id, building_id, device_id
  INTO v_org, v_building, v_router FROM ncd_fixture;

  INSERT INTO public.network_interfaces (
    organization_id, building_id, device_id, interface_key, display_name,
    interface_kind, interface_role, sort_order
  ) VALUES
    (v_org, v_building, v_router, 'ether2', 'ether2', 'ETHERNET', 'ACCESS', 1)
  RETURNING id INTO v_interface_a;
  INSERT INTO public.network_interfaces (
    organization_id, building_id, device_id, interface_key, display_name,
    interface_kind, interface_role, sort_order
  ) VALUES
    (v_org, v_building, v_router, 'ether3', 'ether3', 'ETHERNET', 'ACCESS', 2)
  RETURNING id INTO v_interface_b;

  -- -------------------------------------------------------------------------
  -- The seam. The two literals below are the ones read out of sshConnector.ts,
  -- interpolated verbatim: this call is the poll that failed in production,
  -- run against a real database built from the real migrations.
  -- -------------------------------------------------------------------------
  v_now := clock_timestamp();
  BEGIN
    PERFORM public.network_center_worker_ingest_v2(
      '${PROOF_CREDENTIAL_DIGEST}',
      jsonb_build_object(
        'observedAt', v_now,
        'devices', jsonb_build_array(jsonb_build_object(
          'deviceId', v_router, 'lastSeenAt', v_now, 'reachable', true,
          'healthStatus', 'HEALTHY', 'identity', 'NCD-CLEAN-BATCH',
          'connectionCount', 1
        )),
        'interfaces', jsonb_build_array(jsonb_build_object(
          'interfaceId', v_interface_a, 'linkState', 'UP',
          'rxBytes', 1024, 'txBytes', 2048
        )),
        'clients', jsonb_build_array(jsonb_build_object(
          'deviceId', v_router, 'interfaceId', v_interface_a,
          'sessionKey', 'dhcp:ncd-emitted-session',
          'clientFingerprint', 'ncd-emitted-fingerprint',
          'observedMac', 'bc:fc:e7:64:e3:fb', 'observedIp', '192.168.88.254',
          'hostname', 'NCD-CLIENT',
          'connectionType', ${sqlLiteral(emitted.connectionType)},
          'sessionType', ${sqlLiteral(emitted.sessionType)},
          'firstSeenAt', v_now, 'lastSeenAt', v_now,
          'expiresAt', v_now + INTERVAL '1 hour', 'randomizedMac', false
        ))
      )
    );
  EXCEPTION WHEN others THEN
    -- runLocalNative keeps only the TAIL of psql stderr, so an unhandled
    -- violation arrives with its ERROR line already cut off. Re-raise compactly.
    RAISE EXCEPTION 'the literals the connector emits were REJECTED by the real ingest: % / %',
      SQLSTATE, SQLERRM;
  END;

  PERFORM pg_temp.ncd_assert(
    'real-ingest-stores-the-emitted-client',
    EXISTS (
      SELECT 1 FROM public.network_client_current client
      WHERE client.session_key = 'dhcp:ncd-emitted-session'
        AND client.connection_type = ${sqlLiteral(emitted.connectionType)}
        AND client.session_type = ${sqlLiteral(emitted.sessionType)}
    ),
    'the ingest RPC did not persist the client row'
  );
  PERFORM pg_temp.ncd_assert(
    'real-ingest-stores-the-client-session-history-row',
    EXISTS (
      SELECT 1 FROM public.network_client_sessions session
      WHERE session.session_key = 'dhcp:ncd-emitted-session'
        AND session.connection_type = ${sqlLiteral(emitted.connectionType)}
    ),
    'network_client_sessions has its own connection_type CHECK and was not written'
  );
  PERFORM pg_temp.ncd_assert(
    'real-ingest-stores-the-interface-telemetry-in-the-same-call',
    EXISTS (
      SELECT 1 FROM public.network_interface_current entry
      WHERE entry.interface_id = v_interface_a AND entry.link_state = 'UP'
    ),
    'the interface half of the batch did not land'
  );
  PERFORM pg_temp.ncd_assert(
    'real-ingest-stores-the-device-telemetry-in-the-same-call',
    EXISTS (
      SELECT 1 FROM public.network_device_current entry
      WHERE entry.device_id = v_router AND entry.identity_name = 'NCD-CLEAN-BATCH'
    ),
    'the device half of the batch did not land'
  );

  -- -------------------------------------------------------------------------
  -- The pre-fix values, one at a time, so each failure names its own column.
  -- -------------------------------------------------------------------------
  v_now := clock_timestamp();
  v_sqlstate := NULL;
  v_constraint := NULL;
  BEGIN
    PERFORM public.network_center_worker_ingest_v2(
      '${PROOF_CREDENTIAL_DIGEST}',
      jsonb_build_object(
        'observedAt', v_now,
        'clients', jsonb_build_array(jsonb_build_object(
          'deviceId', v_router, 'sessionKey', 'dhcp:ncd-prefix-connection',
          'clientFingerprint', 'ncd-prefix-connection-fingerprint',
          'connectionType', 'DHCP',
          'sessionType', ${sqlLiteral(emitted.sessionType)},
          'firstSeenAt', v_now, 'lastSeenAt', v_now,
          'expiresAt', v_now + INTERVAL '1 hour'
        ))
      )
    );
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE,
      v_constraint = CONSTRAINT_NAME;
  END;
  PERFORM pg_temp.ncd_assert(
    'pre-fix-connection-type-is-refused-by-the-database',
    v_sqlstate = '23514'
    AND v_constraint = pg_temp.ncd_constraint_for(
      'public.network_client_current'::regclass, 'connection_type'
    ),
    'sqlstate=' || coalesce(v_sqlstate, '<accepted>')
      || ' constraint=' || coalesce(v_constraint, '<none>')
      || ' expected=' || coalesce(pg_temp.ncd_constraint_for(
           'public.network_client_current'::regclass, 'connection_type'
         ), '<none>')
  );
  INSERT INTO pg_temp.ncd_measurements (key, value)
  VALUES ('connectionTypeConstraint', coalesce(v_constraint, ''));

  v_now := clock_timestamp();
  v_sqlstate := NULL;
  v_constraint := NULL;
  BEGIN
    PERFORM public.network_center_worker_ingest_v2(
      '${PROOF_CREDENTIAL_DIGEST}',
      jsonb_build_object(
        'observedAt', v_now,
        'clients', jsonb_build_array(jsonb_build_object(
          'deviceId', v_router, 'sessionKey', 'dhcp:ncd-prefix-session',
          'clientFingerprint', 'ncd-prefix-session-fingerprint',
          'connectionType', ${sqlLiteral(emitted.connectionType)},
          'sessionType', 'LEASE',
          'firstSeenAt', v_now, 'lastSeenAt', v_now,
          'expiresAt', v_now + INTERVAL '1 hour'
        ))
      )
    );
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE,
      v_constraint = CONSTRAINT_NAME;
  END;
  PERFORM pg_temp.ncd_assert(
    'pre-fix-session-type-is-refused-by-the-database',
    v_sqlstate = '23514'
    AND v_constraint = pg_temp.ncd_constraint_for(
      'public.network_client_current'::regclass, 'session_type'
    ),
    'sqlstate=' || coalesce(v_sqlstate, '<accepted>')
      || ' constraint=' || coalesce(v_constraint, '<none>')
      || ' expected=' || coalesce(pg_temp.ncd_constraint_for(
           'public.network_client_current'::regclass, 'session_type'
         ), '<none>')
  );
  -- The SQLSTATE is MEASURED here and handed back to the runner, which then
  -- feeds it through the real Edge handler. That is what binds layer 4 to
  -- reality instead of to the assumption that a domain error is always 23514.
  PERFORM pg_temp.ncd_assert(
    'an-out-of-domain-value-raises-a-check-violation',
    v_sqlstate = '23514',
    'sqlstate=' || coalesce(v_sqlstate, '<accepted>')
  );
  INSERT INTO pg_temp.ncd_measurements (key, value)
  VALUES ('outOfDomainSqlstate', coalesce(v_sqlstate, '')),
         ('sessionTypeConstraint', coalesce(v_constraint, ''));

  -- -------------------------------------------------------------------------
  -- Blast radius. One bad client row, alongside telemetry that is entirely
  -- valid, in a single call - which is exactly the production payload.
  -- -------------------------------------------------------------------------
  v_now := clock_timestamp();
  v_sqlstate := NULL;
  BEGIN
    PERFORM public.network_center_worker_ingest_v2(
      '${PROOF_CREDENTIAL_DIGEST}',
      jsonb_build_object(
        'observedAt', v_now,
        'devices', jsonb_build_array(jsonb_build_object(
          'deviceId', v_router, 'lastSeenAt', v_now, 'reachable', true,
          'healthStatus', 'HEALTHY', 'identity', 'NCD-POISONED-BATCH',
          'connectionCount', 2
        )),
        'interfaces', jsonb_build_array(jsonb_build_object(
          'interfaceId', v_interface_b, 'linkState', 'UP',
          'rxBytes', 9999, 'txBytes', 8888
        )),
        'clients', jsonb_build_array(
          jsonb_build_object(
            'deviceId', v_router, 'sessionKey', 'dhcp:ncd-innocent-neighbour',
            'clientFingerprint', 'ncd-innocent-neighbour-fingerprint',
            'connectionType', ${sqlLiteral(emitted.connectionType)},
            'sessionType', ${sqlLiteral(emitted.sessionType)},
            'firstSeenAt', v_now, 'lastSeenAt', v_now,
            'expiresAt', v_now + INTERVAL '1 hour'
          ),
          jsonb_build_object(
            'deviceId', v_router, 'sessionKey', 'dhcp:ncd-poison-row',
            'clientFingerprint', 'ncd-poison-row-fingerprint',
            'connectionType', ${sqlLiteral(emitted.connectionType)},
            'sessionType', 'LEASE',
            'firstSeenAt', v_now, 'lastSeenAt', v_now,
            'expiresAt', v_now + INTERVAL '1 hour'
          )
        )
      )
    );
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
  END;

  PERFORM pg_temp.ncd_assert(
    'one-bad-client-row-rolls-back-the-interface-telemetry',
    v_sqlstate = '23514'
    AND NOT EXISTS (
      SELECT 1 FROM public.network_interface_current entry
      WHERE entry.interface_id = v_interface_b
    ),
    'interface telemetry survived a rejected client row; the transaction scope changed'
  );
  PERFORM pg_temp.ncd_assert(
    'one-bad-client-row-rolls-back-the-device-telemetry',
    NOT EXISTS (
      SELECT 1 FROM public.network_device_current entry
      WHERE entry.device_id = v_router AND entry.identity_name = 'NCD-POISONED-BATCH'
    ),
    'device telemetry from the rejected batch persisted'
  );
  PERFORM pg_temp.ncd_assert(
    'one-bad-client-row-rolls-back-the-good-client-beside-it',
    NOT EXISTS (
      SELECT 1 FROM public.network_client_current client
      WHERE client.session_key = 'dhcp:ncd-innocent-neighbour'
    ),
    'a valid client row survived a batch that failed'
  );

  -- The rollback must be scoped to the failed call, not sticky: a clean batch
  -- immediately afterwards has to persist, or "rejected once" would mean
  -- "broken until restart".
  v_now := clock_timestamp();
  PERFORM public.network_center_worker_ingest_v2(
    '${PROOF_CREDENTIAL_DIGEST}',
    jsonb_build_object(
      'observedAt', v_now,
      'interfaces', jsonb_build_array(jsonb_build_object(
        'interfaceId', v_interface_b, 'linkState', 'DOWN'
      ))
    )
  );
  PERFORM pg_temp.ncd_assert(
    'a-clean-batch-after-a-rejected-one-still-persists',
    EXISTS (
      SELECT 1 FROM public.network_interface_current entry
      WHERE entry.interface_id = v_interface_b AND entry.link_state = 'DOWN'
    ),
    'the ingest stayed broken after one rejected batch'
  );
END;
$ingest_proof$;

SELECT jsonb_build_object(
  'status', 'PASS',
  'invariants', (SELECT count(*)::integer FROM pg_temp.ncd_results),
  'proofNonce', (
    SELECT proof_nonce FROM app_private.network_center_disposable_proof
    WHERE proof_nonce = '${nonce}'
  ),
  'emitted', jsonb_build_object(
    'connectionType', ${sqlLiteral(emitted.connectionType)},
    'sessionType', ${sqlLiteral(emitted.sessionType)}
  ),
  'measurements', (
    SELECT jsonb_object_agg(key, value) FROM pg_temp.ncd_measurements
  ),
  'names', (SELECT jsonb_agg(name ORDER BY name) FROM pg_temp.ncd_results)
) AS disposable_ingest_domain_proof;

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

export function parseIngestDomainProofVerdict(
  output,
  { expectedLocalProof, expectedInvariants: expected } = {},
) {
  const verdict = parseProofVerdict(output);
  if (
    verdict?.status !== "PASS"
    || verdict?.invariants !== expected
    || verdict?.proofNonce !== expectedLocalProof?.proofNonce
  ) {
    throw new Error(
      "Disposable ingest domain proof did not return the expected PASS "
        + `verdict: ${JSON.stringify(verdict)}`,
    );
  }
  if (
    !Array.isArray(verdict.names)
    || new Set(verdict.names).size !== expected
  ) {
    throw new Error(
      "Disposable ingest domain proof returned a malformed assertion "
        + `ledger: ${JSON.stringify(verdict?.names)}`,
    );
  }
  if (verdict.measurements?.outOfDomainSqlstate !== "23514") {
    throw new Error(
      "Disposable ingest domain proof did not measure a check violation: "
        + `${JSON.stringify(verdict.measurements)}`,
    );
  }
  return verdict;
}

/**
 * Layer 4, bound to the measurement rather than to an assumption: the SQLSTATE
 * the database ACTUALLY raised for an out-of-domain telemetry value is fed
 * through the REAL Edge handler, which must answer a 4xx that names the code
 * rather than the 502 that made this defect cost a three-system log
 * correlation.
 */
export async function assertEdgeMapsMeasuredSqlstate(
  sqlstate,
  { repoRoot = DEFAULT_REPO_ROOT } = {},
) {
  const module = await import(
    pathToFileURL(
      resolve(repoRoot, "supabase/functions/network-center-worker/index.ts"),
    ).href
  );
  const handler = module.createWorkerHandler({
    getEnv: () => undefined,
    rpc: async () => ({ data: null, error: { code: sqlstate } }),
  });
  const response = await handler(
    new Request("https://proof.invalid/network-center-worker/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-network-worker-secret": "s".repeat(48),
      },
      body: JSON.stringify({
        payload: { observedAt: new Date().toISOString(), clients: [] },
      }),
    }),
  );
  const body = await response.json();
  if (response.status < 400 || response.status >= 500) {
    throw new Error(
      `The Edge maps the measured SQLSTATE ${sqlstate} to ${response.status}; `
        + "a domain error must not degrade to a generic backend failure",
    );
  }
  if (body?.code !== sqlstate) {
    throw new Error(
      `The Edge did not name the SQLSTATE it received: ${JSON.stringify(body)}`,
    );
  }
  return { status: response.status, code: body.code };
}

export async function runIngestDomainProof({
  environment = process.env,
  repoRoot = DEFAULT_REPO_ROOT,
} = {}) {
  const emitted = readEmittedClientLiterals(repoRoot);
  const domains = readDeclaredDomains(repoRoot);
  const expected = expectedInvariants(domains);
  const verdict = await runDisposableLocalClusterMatrix({
    buildSql: ({ localProof }) =>
      buildIngestDomainProofSql({ localProof, emitted, domains }),
    parseVerdict: (output, context) =>
      parseIngestDomainProofVerdict(output, {
        ...context,
        expectedInvariants: expected,
      }),
    environment,
    repoRoot,
  });
  const edge = await assertEdgeMapsMeasuredSqlstate(
    verdict.measurements.outOfDomainSqlstate,
    { repoRoot },
  );
  return { ...verdict, expectedInvariants: expected, edge };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    throw new Error(
      "Usage: node scripts/test-network-center-ingest-domains-disposable.mjs [--dry-run]",
    );
  }
  if (args[0] === "--dry-run") {
    const emitted = readEmittedClientLiterals(DEFAULT_REPO_ROOT);
    const domains = readDeclaredDomains(DEFAULT_REPO_ROOT);
    buildIngestDomainProofSql({
      localProof: { proofNonce: "0".repeat(32) },
      emitted,
      domains,
    });
    process.stdout.write(
      `Disposable ingest domain proof dry-run passed; emitted connectionType=${emitted.connectionType} `
        + `sessionType=${emitted.sessionType}; ${expectedInvariants(domains)} invariants expected; `
        + "no PostgreSQL process was started.\n",
    );
    return;
  }
  const verdict = await runIngestDomainProof();
  process.stdout.write(
    "Disposable PostgreSQL ingest domain proof PASS: "
      + `${verdict.invariants}/${verdict.expectedInvariants} invariants; `
      + `out-of-domain SQLSTATE ${verdict.measurements.outOfDomainSqlstate} `
      + `maps to HTTP ${verdict.edge.status}.\n`,
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
