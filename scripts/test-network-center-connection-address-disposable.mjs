#!/usr/bin/env node
// Disposable PostgreSQL proof that every Network Center reader hands out a
// management address a client can actually dial.
//
// WHY THIS FILE EXISTS. `inet::text` is backed by network_show(), which always
// appends the netmask, so `'10.77.0.250'::inet::text` is `'10.77.0.250/32'`.
// Three shipped worker-facing readers rendered management_ip that way and the
// worker fed the result straight to ssh2, which tried to RESOLVE the literal
// "10.77.0.250/32" as a hostname and failed in 20 ms without opening a socket.
// The fleet could not poll, inventory or execute anything, and the router logged
// nothing at all.
//
// It survived every gate because NO TEST EVER CROSSED THE SQL-TO-WORKER SEAM
// FOR THIS FIELD: every worker fixture hard-codes a bare IP string it typed
// itself, and no SQL proof asserted the rendered text. The value that broke
// production is a value no fixture could produce.
//
// So this proof deliberately takes the address FROM A REAL `inet` COLUMN,
// THROUGH THE REAL RPC, on a real PostgreSQL cluster built from the real
// unmodified migrations - including 20260729145000, which is picked up by the
// migration glob rather than named here, so deleting or reverting it makes this
// proof fail rather than silently stop covering anything.
//
// The cluster is created in TEMP, bound to 127.0.0.1 on an ephemeral port, has
// no restart policy, and its teardown is asserted by evidence (port closed,
// directory gone) by runDisposableLocalClusterMatrix. No Docker, no production
// credential, no remote host.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { runDisposableLocalClusterMatrix } from "./network-center-disposable-db.mjs";

/** Raise together with the SQL whenever an assertion is added. */
export const CONNECTION_ADDRESS_PROOF_INVARIANTS = 30;

const DEMO_ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const DEMO_OWNER_ID = "de6f33f3-349f-4bec-bd3d-106192f6715e";
const PROOF_WORKER_ID = "dddd7000-0000-4000-8000-000000000001";
const PROOF_CREDENTIAL_DIGEST = "b".repeat(64);

/**
 * The five function signatures repaired by
 * 20260729145000_network_center_connection_host_fix.sql, with the definer
 * profile and grant surface production is measured to have. Asserted here as
 * well as in the migration, because a proof that only reads the migration's own
 * assertions proves the migration ran, not that the database is right.
 */
export const REPAIRED_FUNCTIONS = Object.freeze([
  Object.freeze({
    signature: "public.network_center_worker_list_connections_v2(text,integer)",
    volatility: "v",
    config: ["search_path=pg_catalog"],
    grantees: ["service_role"],
  }),
  Object.freeze({
    signature: "public.network_center_worker_list_connections_v1(text,integer)",
    volatility: "v",
    config: ["search_path=pg_catalog"],
    grantees: ["service_role"],
  }),
  Object.freeze({
    signature: "public.network_center_list_aruba_v1(uuid,integer,uuid,integer)",
    volatility: "s",
    config: ["search_path=pg_catalog, public, app_private"],
    grantees: ["service_role", "authenticated"],
  }),
  Object.freeze({
    signature:
      "public.network_center_list_clients_v1(uuid,timestamp with time zone,uuid,integer)",
    volatility: "s",
    config: ["search_path=pg_catalog, public, app_private"],
    grantees: ["service_role", "authenticated"],
  }),
  Object.freeze({
    signature:
      "app_private.network_center_worker_ingest_legacy_impl_v1(text,jsonb)",
    volatility: "v",
    config: ["search_path=pg_catalog, public, app_private"],
    grantees: [],
  }),
]);

function sqlLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function repairedFunctionRows() {
  return REPAIRED_FUNCTIONS.map((entry) =>
    `      (${sqlLiteral(entry.signature)}, ${sqlLiteral(entry.volatility)}::"char",\n`
    + `       ARRAY[${entry.config.map(sqlLiteral).join(", ")}]::text[],\n`
    + `       ARRAY[${entry.grantees.map(sqlLiteral).join(", ")}]::text[])`
  ).join(",\n");
}

export function buildConnectionAddressProofSql({ localProof } = {}) {
  const nonce = String(localProof?.proofNonce ?? "");
  if (!/^[a-f0-9]{32}$/u.test(nonce)) {
    throw new Error(
      "Connection address proof requires the disposable cluster proof nonce",
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
      'Connection address proof is not running on its own disposable cluster';
  END IF;
END;
$bind$;

CREATE TEMP TABLE nca_results (
  name text PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.nca_assert(
  p_name text, p_condition boolean, p_detail text DEFAULT ''
) RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION 'CONNECTION ADDRESS PROOF FAILED [%]: %', p_name, p_detail;
  END IF;
  INSERT INTO pg_temp.nca_results (name) VALUES (p_name);
END;
$assert$;

-- The contract the worker actually needs: ssh2 hands this value to its resolver,
-- so the string must be a bare address. A value that survives a round trip via
-- inet without gaining a mask is exactly that, and this expresses it without
-- naming '/' - a value like '10.0.0.5 ' or '10.0.0.5/32' both fail it.
CREATE FUNCTION pg_temp.nca_is_dialable(p_value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $dialable$
DECLARE
  v_parsed inet;
BEGIN
  IF p_value IS NULL THEN RETURN false; END IF;
  BEGIN
    v_parsed := p_value::inet;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  RETURN host(v_parsed) = p_value;
END;
$dialable$;

-- ---------------------------------------------------------------------------
-- Fixture. Two DEMO routers already exist from the disposable seed; this adds
-- the authoritative worker, its credential, poll assignments, and one real
-- connection row per router whose management_ip is a genuine inet value.
-- Nothing here writes a management address as text.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE nca_fixture ON COMMIT DROP AS
SELECT
  device.organization_id,
  device.building_id,
  device.id AS device_id,
  (row_number() OVER (ORDER BY device.building_id))::integer AS ordinal
FROM public.network_devices device
WHERE device.organization_id = '${DEMO_ORGANIZATION_ID}'
  AND device.device_kind = 'MIKROTIK'
  AND device.is_active;

DO $fixture_preflight$
BEGIN
  IF (SELECT count(*) FROM nca_fixture) <> 2 THEN
    RAISE EXCEPTION
      'Connection address proof requires exactly two seeded DEMO routers, found %',
      (SELECT count(*) FROM nca_fixture);
  END IF;
END;
$fixture_preflight$;

INSERT INTO public.network_workers (
  id, worker_key, display_name, status, capabilities
) VALUES (
  '${PROOF_WORKER_ID}', 'nca-address-proof',
  'Connection address proof worker', 'ACTIVE',
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
SELECT
  '${PROOF_WORKER_ID}', fixture.organization_id, fixture.building_id,
  fixture.device_id, true, true, clock_timestamp() - INTERVAL '1 minute'
FROM nca_fixture fixture;

-- Router 1 stores a plain host address (production's shape). Router 2 stores a
-- NON-MAXIMAL mask, which the table permits - there is no masklen constraint -
-- and which is precisely where abbrev() and text() would both still be wrong.
INSERT INTO public.network_device_connections (
  organization_id, building_id, device_id, transport, management_ip,
  management_port, credential_ref, host_key_fingerprint,
  poll_interval_seconds, connect_timeout_ms, is_enabled
)
SELECT
  fixture.organization_id, fixture.building_id, fixture.device_id,
  'ROUTEROS_SSH',
  CASE fixture.ordinal
    WHEN 1 THEN '10.77.0.250'::inet
    ELSE '10.77.0.251/24'::inet
  END,
  22, 'router/nca-' || fixture.ordinal,
  'SHA256:aMf65l8oO9iw/x8ZUtPJ9g9lbUKDhTfwPEllQ6UvQgg',
  60, 8000, true
FROM nca_fixture fixture;

DO $address_proof$
DECLARE
  v_router_a uuid;
  v_router_b uuid;
  v_building_a uuid;
  v_org uuid;
  v_page jsonb;
  v_item jsonb;
  v_stored inet;
  v_aruba_id uuid;
  v_interface_id uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT device_id, building_id, organization_id
  INTO v_router_a, v_building_a, v_org
  FROM nca_fixture WHERE ordinal = 1;
  SELECT device_id INTO v_router_b FROM nca_fixture WHERE ordinal = 2;

  -- -------------------------------------------------------------------------
  -- Mechanism, measured on the PostgreSQL this run is actually using rather
  -- than quoted from documentation. These four are the whole defect.
  -- -------------------------------------------------------------------------
  PERFORM pg_temp.nca_assert(
    'inet-cast-to-text-always-appends-the-netmask',
    ('10.77.0.250'::inet)::text = '10.77.0.250/32'
    AND ('2001:db8::1'::inet)::text = '2001:db8::1/128',
    'inet::text no longer renders a prefix; the defect premise changed'
  );
  PERFORM pg_temp.nca_assert(
    'host-drops-the-netmask-for-every-family-and-mask',
    host('10.77.0.250'::inet) = '10.77.0.250'
    AND host('10.77.0.251/24'::inet) = '10.77.0.251'
    AND host('2001:db8::1'::inet) = '2001:db8::1'
    AND host('2001:db8::1/64'::inet) = '2001:db8::1',
    'host() did not reduce an inet to a bare address'
  );
  PERFORM pg_temp.nca_assert(
    'abbrev-and-text-are-not-acceptable-substitutes-for-host',
    abbrev('10.77.0.251/24'::inet) = '10.77.0.251/24'
    AND text('10.77.0.250'::inet) = '10.77.0.250/32'
    AND NOT pg_temp.nca_is_dialable(abbrev('10.77.0.251/24'::inet))
    AND NOT pg_temp.nca_is_dialable(text('10.77.0.250'::inet)),
    'abbrev()/text() unexpectedly produced a dialable address'
  );
  -- This is why three sessions of correct-looking readbacks hid the defect:
  -- to_jsonb uses inet_out, which suppresses a maximal mask.
  PERFORM pg_temp.nca_assert(
    'to-jsonb-hides-the-defect-which-is-why-readbacks-looked-right',
    to_jsonb('10.77.0.250'::inet) = '"10.77.0.250"'::jsonb
    AND (row_to_json(connection.*)::jsonb ->> 'management_ip') = '10.77.0.250'
  , 'to_jsonb(inet) started rendering a prefix')
  FROM public.network_device_connections connection
  WHERE connection.device_id = v_router_a;

  -- -------------------------------------------------------------------------
  -- The seam itself: the address the WORKER receives, taken from the real inet
  -- column through the real authoritative RPC.
  -- -------------------------------------------------------------------------
  v_page := public.network_center_worker_list_connections_v2(
    '${PROOF_CREDENTIAL_DIGEST}', 100
  );
  PERFORM pg_temp.nca_assert(
    'list-connections-v2-returns-both-assigned-routers',
    jsonb_array_length(v_page -> 'items') = 2,
    v_page::text
  );

  SELECT item INTO v_item
  FROM jsonb_array_elements(v_page -> 'items') item
  WHERE (item ->> 'deviceId')::uuid = v_router_a;
  SELECT connection.management_ip INTO v_stored
  FROM public.network_device_connections connection
  WHERE connection.device_id = v_router_a;

  PERFORM pg_temp.nca_assert(
    'list-connections-v2-hands-the-worker-a-dialable-address',
    pg_temp.nca_is_dialable(v_item ->> 'managementIp'),
    'managementIp=' || coalesce(v_item ->> 'managementIp', '<null>')
  );
  PERFORM pg_temp.nca_assert(
    'list-connections-v2-address-equals-host-of-the-stored-inet',
    (v_item ->> 'managementIp') = host(v_stored)
    AND (v_item ->> 'managementIp') <> v_stored::text,
    'managementIp=' || coalesce(v_item ->> 'managementIp', '<null>')
      || ' stored=' || v_stored::text
  );

  SELECT item INTO v_item
  FROM jsonb_array_elements(v_page -> 'items') item
  WHERE (item ->> 'deviceId')::uuid = v_router_b;
  PERFORM pg_temp.nca_assert(
    'list-connections-v2-drops-a-non-maximal-stored-mask',
    (v_item ->> 'managementIp') = '10.77.0.251'
    AND pg_temp.nca_is_dialable(v_item ->> 'managementIp'),
    'managementIp=' || coalesce(v_item ->> 'managementIp', '<null>')
  );

  -- Every item, not just the two inspected above: no reader may emit anything
  -- ssh2 cannot resolve, whatever the row happens to hold.
  PERFORM pg_temp.nca_assert(
    'every-list-connections-v2-item-is-dialable',
    NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_page -> 'items') item
      WHERE NOT pg_temp.nca_is_dialable(item ->> 'managementIp')
    ),
    v_page::text
  );

  -- IPv6 through the same seam. A /128 is the v6 analogue of the /32 that broke
  -- production, and inet::text renders it identically wrongly.
  UPDATE public.network_device_connections
  SET management_ip = '2001:db8::250'::inet
  WHERE device_id = v_router_a;
  v_page := public.network_center_worker_list_connections_v2(
    '${PROOF_CREDENTIAL_DIGEST}', 100
  );
  SELECT item INTO v_item
  FROM jsonb_array_elements(v_page -> 'items') item
  WHERE (item ->> 'deviceId')::uuid = v_router_a;
  PERFORM pg_temp.nca_assert(
    'list-connections-v2-returns-a-dialable-ipv6-address',
    (v_item ->> 'managementIp') = '2001:db8::250'
    AND pg_temp.nca_is_dialable(v_item ->> 'managementIp'),
    'managementIp=' || coalesce(v_item ->> 'managementIp', '<null>')
  );
  UPDATE public.network_device_connections
  SET management_ip = '10.77.0.250'::inet
  WHERE device_id = v_router_a;

  -- -------------------------------------------------------------------------
  -- The legacy compatibility reader carries the same defect and is still
  -- granted to service_role until the cutover is finalized.
  -- -------------------------------------------------------------------------
  v_page := public.network_center_worker_list_connections_v1(
    'legacy-v1-compat', 100
  );
  PERFORM pg_temp.nca_assert(
    'list-connections-v1-hands-the-worker-a-dialable-address',
    jsonb_array_length(v_page -> 'items') = 2
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_page -> 'items') item
      WHERE NOT pg_temp.nca_is_dialable(item ->> 'managementIp')
    ),
    v_page::text
  );

  -- -------------------------------------------------------------------------
  -- Browser-facing readers. list_aruba_v1 coalesces the connection address with
  -- inventory_metadata->>'managementAddress', which is written through host();
  -- before the fix the SAME UI field rendered '10.77.0.252/32' when a
  -- connection row existed and '10.77.0.252' when it did not.
  -- -------------------------------------------------------------------------
  INSERT INTO public.super_admins (user_id) VALUES ('${DEMO_OWNER_ID}')
  ON CONFLICT (user_id) DO NOTHING;
  PERFORM set_config('request.jwt.claim.sub', '${DEMO_OWNER_ID}', true);

  INSERT INTO public.network_devices (
    organization_id, building_id, device_kind, external_key, display_name,
    vendor, parent_device_id, sort_order, lifecycle_status, write_capability,
    is_active, inventory_metadata, aruba_stable_key, aruba_identity_source,
    aruba_discovery_state, aruba_discovery_first_seen_at,
    aruba_discovery_last_seen_at
  ) VALUES (
    v_org, v_building_a, 'ARUBA', 'serial:NCAADDR1', 'NCA Aruba',
    'Aruba', v_router_a, 0, 'ONLINE', false, true,
    jsonb_build_object('managementAddress', host('10.77.0.253'::inet)),
    'serial:NCAADDR1', 'SERIAL', 'DISCOVERED', v_now, v_now
  ) RETURNING id INTO v_aruba_id;

  INSERT INTO public.network_device_connections (
    organization_id, building_id, device_id, transport, management_ip,
    management_port, credential_ref, poll_interval_seconds,
    connect_timeout_ms, is_enabled
  ) VALUES (
    v_org, v_building_a, v_aruba_id, 'DISPLAY_ONLY', '10.77.0.252'::inet,
    443, 'router/nca-aruba', 60, 8000, true
  );

  v_page := public.network_center_list_aruba_v1(v_building_a, NULL, NULL, 50);
  SELECT item INTO v_item
  FROM jsonb_array_elements(v_page -> 'items') item
  WHERE (item ->> 'id')::uuid = v_aruba_id;
  PERFORM pg_temp.nca_assert(
    'list-aruba-v1-renders-a-bare-connection-address',
    (v_item ->> 'address') = '10.77.0.252'
    AND pg_temp.nca_is_dialable(v_item ->> 'address'),
    'address=' || coalesce(v_item ->> 'address', '<null>')
  );

  -- Same device, connection disabled: the coalesce falls through to the
  -- metadata string. Both branches must now render the same shape.
  UPDATE public.network_device_connections
  SET is_enabled = false WHERE device_id = v_aruba_id;
  v_page := public.network_center_list_aruba_v1(v_building_a, NULL, NULL, 50);
  SELECT item INTO v_item
  FROM jsonb_array_elements(v_page -> 'items') item
  WHERE (item ->> 'id')::uuid = v_aruba_id;
  PERFORM pg_temp.nca_assert(
    'list-aruba-v1-agrees-with-its-own-metadata-fallback',
    (v_item ->> 'address') = '10.77.0.253'
    AND pg_temp.nca_is_dialable(v_item ->> 'address'),
    'address=' || coalesce(v_item ->> 'address', '<null>')
  );
  UPDATE public.network_device_connections
  SET is_enabled = true WHERE device_id = v_aruba_id;

  -- -------------------------------------------------------------------------
  -- Client telemetry. network_client_current.observed_ip is inet, and both the
  -- browser list and the persisted session history rendered it through ::text.
  -- Written through the real authoritative ingest RPC, not by hand.
  -- -------------------------------------------------------------------------
  INSERT INTO public.network_interfaces (
    organization_id, building_id, device_id, interface_key, display_name,
    interface_kind, interface_role, sort_order
  ) VALUES (
    v_org, v_building_a, v_router_a, 'ether2', 'ether2', 'ETHERNET',
    'ACCESS', 1
  ) RETURNING id INTO v_interface_id;

  BEGIN
  PERFORM public.network_center_worker_ingest_v2(
    '${PROOF_CREDENTIAL_DIGEST}',
    jsonb_build_object(
      'observedAt', v_now,
      'clients', jsonb_build_array(jsonb_build_object(
        'deviceId', v_router_a,
        'interfaceId', v_interface_id,
        'sessionKey', 'dhcp:nca-address-proof-session',
        'clientFingerprint', 'nca-address-proof-fingerprint',
        'observedMac', 'bc:fc:e7:64:e3:fb',
        'observedIp', '192.168.88.254',
        'hostname', 'NCA-PROOF-CLIENT',
        'connectionType', 'ETHERNET',
        'sessionType', 'DHCP',
        'firstSeenAt', v_now,
        'lastSeenAt', v_now,
        'expiresAt', v_now + INTERVAL '1 hour',
        'randomizedMac', false
      ))
    )
  );
  EXCEPTION WHEN others THEN
    -- runLocalNative keeps only the TAIL of psql stderr, so an unhandled
    -- constraint violation here arrives with its ERROR line already cut off and
    -- only the CONTEXT dump visible. Re-raise compactly so the next person sees
    -- the actual SQLSTATE instead of 200 lines of the CTE that failed.
    RAISE EXCEPTION 'connection address proof ingest failed: % / %', SQLSTATE, SQLERRM;
  END;

  PERFORM pg_temp.nca_assert(
    'client-ingest-stores-observed-ip-as-a-real-inet',
    EXISTS (
      SELECT 1 FROM public.network_client_current client
      WHERE client.session_key = 'dhcp:nca-address-proof-session'
        AND client.observed_ip = '192.168.88.254'::inet
    ),
    'the ingest RPC did not persist the client row'
  );
  PERFORM pg_temp.nca_assert(
    'client-session-address-history-holds-a-dialable-address',
    (
      SELECT bool_and(pg_temp.nca_is_dialable(address #>> '{}'))
      FROM public.network_client_sessions session,
        LATERAL jsonb_array_elements(session.address_history) address
      WHERE session.session_key = 'dhcp:nca-address-proof-session'
    ),
    (
      SELECT session.address_history::text
      FROM public.network_client_sessions session
      WHERE session.session_key = 'dhcp:nca-address-proof-session'
    )
  );
  -- The compaction routine de-duplicates address_history by raw JSON string, so
  -- a '/32' variant and a bare variant of the same address were kept as two
  -- distinct entries forever.
  PERFORM pg_temp.nca_assert(
    'client-session-address-history-has-exactly-one-entry',
    (
      SELECT jsonb_array_length(session.address_history)
      FROM public.network_client_sessions session
      WHERE session.session_key = 'dhcp:nca-address-proof-session'
    ) = 1,
    'address_history did not collapse to a single rendering'
  );

  v_page := public.network_center_list_clients_v1(v_building_a, NULL, NULL, 50);
  SELECT item INTO v_item
  FROM jsonb_array_elements(v_page -> 'items') item
  WHERE (item ->> 'sessionIdentity') = 'dhcp:nca-address-proof-session';
  PERFORM pg_temp.nca_assert(
    'list-clients-v1-renders-a-bare-client-address',
    (v_item ->> 'address') = '192.168.88.254'
    AND pg_temp.nca_is_dialable(v_item ->> 'address'),
    'address=' || coalesce(v_item ->> 'address', '<null>')
  );
  -- macaddr::text is NOT the same defect: macaddr_out and the text cast render
  -- identically, so the neighbouring cast is correct and must stay correct.
  PERFORM pg_temp.nca_assert(
    'macaddr-rendering-is-unaffected',
    (v_item ->> 'macAddress') = 'bc:fc:e7:64:e3:fb',
    'macAddress=' || coalesce(v_item ->> 'macAddress', '<null>')
  );

  PERFORM set_config('request.jwt.claim.sub', '', true);
END;
$address_proof$;

-- ---------------------------------------------------------------------------
-- Catalog sweeps. These are read from pg_attribute rather than from a token
-- list, so an inet column added later is covered without anyone remembering to
-- extend the test.
-- ---------------------------------------------------------------------------
DO $catalog_sweep$
DECLARE
  v_offender text;
  v_pin record;
  v_secdef boolean;
  v_volatile "char";
  v_config text[];
  v_role text;
  v_grant_ok boolean;
BEGIN
  SELECT string_agg(DISTINCT offender.label, ', ' ORDER BY offender.label)
  INTO v_offender
  FROM (
    SELECT schema_row.nspname || '.' || function_row.proname
      || ' (' || address_column.attname || ')' AS label
    FROM pg_attribute address_column
    JOIN pg_class table_row ON table_row.oid = address_column.attrelid
    JOIN pg_namespace table_schema ON table_schema.oid = table_row.relnamespace
    CROSS JOIN LATERAL (
      SELECT proc.proname, proc.pronamespace
      FROM pg_proc proc
      WHERE proc.prosrc IS NOT NULL
        AND proc.proname LIKE 'network\_%'
        AND proc.prosrc ~ ('(^|[^A-Za-z_0-9$"])' || address_column.attname || '::text')
    ) function_row
    JOIN pg_namespace schema_row ON schema_row.oid = function_row.pronamespace
    WHERE address_column.attnum > 0
      AND NOT address_column.attisdropped
      AND address_column.atttypid IN ('inet'::regtype, 'cidr'::regtype)
      AND table_schema.nspname IN ('public', 'app_private')
      AND table_row.relkind IN ('r', 'p', 'v', 'm')
      AND schema_row.nspname IN ('public', 'app_private')
  ) offender;
  PERFORM pg_temp.nca_assert(
    'no-live-function-casts-an-inet-column-to-text',
    v_offender IS NULL,
    coalesce(v_offender, '')
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
    AND function_row.prosrc ~ '"(observedIp|managementIp|managementAddress)"::text';
  PERFORM pg_temp.nca_assert(
    'no-live-function-casts-an-inet-recordset-field-to-text',
    v_offender IS NULL,
    coalesce(v_offender, '')
  );

  -- The forward fix must not have been smuggled in by dropping a definer pin.
  FOR v_pin IN
    SELECT *
    FROM (VALUES
${repairedFunctionRows()}
    ) AS pin(signature, volatility, config, grantees)
  LOOP
    SELECT proc.prosecdef, proc.provolatile, proc.proconfig
    INTO v_secdef, v_volatile, v_config
    FROM pg_proc proc
    WHERE proc.oid = to_regprocedure(v_pin.signature);
    PERFORM pg_temp.nca_assert(
      'definer-profile-preserved-' || split_part(v_pin.signature, '(', 1),
      v_secdef IS TRUE
      AND v_volatile = v_pin.volatility
      AND v_config IS NOT DISTINCT FROM v_pin.config,
      coalesce(v_config::text, '<null>') || ' volatile=' || coalesce(v_volatile::text, '<null>')
    );
    v_grant_ok := true;
    FOREACH v_role IN ARRAY ARRAY['public', 'anon', 'authenticated', 'service_role']
    LOOP
      IF has_function_privilege(v_role, v_pin.signature, 'EXECUTE')
         <> (v_role = ANY(v_pin.grantees)) THEN
        v_grant_ok := false;
      END IF;
    END LOOP;
    PERFORM pg_temp.nca_assert(
      'grant-surface-preserved-' || split_part(v_pin.signature, '(', 1),
      v_grant_ok,
      v_pin.signature
    );
  END LOOP;
END;
$catalog_sweep$;

SELECT jsonb_build_object(
  'status', 'PASS',
  'invariants', (SELECT count(*)::integer FROM pg_temp.nca_results),
  'proofNonce', (
    SELECT proof_nonce FROM app_private.network_center_disposable_proof
    WHERE proof_nonce = '${nonce}'
  ),
  'names', (SELECT jsonb_agg(name ORDER BY name) FROM pg_temp.nca_results)
) AS disposable_connection_address_proof;

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

export function parseConnectionAddressProofVerdict(
  output,
  { expectedLocalProof } = {},
) {
  const verdict = parseProofVerdict(output);
  if (
    verdict?.status !== "PASS"
    || verdict?.invariants !== CONNECTION_ADDRESS_PROOF_INVARIANTS
    || verdict?.proofNonce !== expectedLocalProof?.proofNonce
  ) {
    throw new Error(
      "Disposable connection address proof did not return the expected PASS "
        + `verdict: ${JSON.stringify(verdict)}`,
    );
  }
  if (
    !Array.isArray(verdict.names)
    || new Set(verdict.names).size !== CONNECTION_ADDRESS_PROOF_INVARIANTS
  ) {
    throw new Error(
      "Disposable connection address proof returned a malformed assertion "
        + `ledger: ${JSON.stringify(verdict?.names)}`,
    );
  }
  return verdict;
}

export async function runConnectionAddressProof({
  environment = process.env,
} = {}) {
  return runDisposableLocalClusterMatrix({
    buildSql: buildConnectionAddressProofSql,
    parseVerdict: parseConnectionAddressProofVerdict,
    environment,
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    throw new Error(
      "Usage: node scripts/test-network-center-connection-address-disposable.mjs [--dry-run]",
    );
  }
  if (args[0] === "--dry-run") {
    buildConnectionAddressProofSql({
      localProof: { proofNonce: "0".repeat(32) },
    });
    process.stdout.write(
      "Disposable connection address proof dry-run passed; no PostgreSQL "
        + "process was started.\n",
    );
    return;
  }
  const verdict = await runConnectionAddressProof();
  process.stdout.write(
    "Disposable PostgreSQL connection address proof PASS: "
      + `${verdict.invariants}/${CONNECTION_ADDRESS_PROOF_INVARIANTS} invariants.\n`,
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
