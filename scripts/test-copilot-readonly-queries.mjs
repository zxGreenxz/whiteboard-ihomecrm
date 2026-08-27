#!/usr/bin/env node
// Production-like contract probe for the two Copilot read tools.
//
// The disposable cluster is intentionally PostgreSQL-only. PostgREST is not
// part of the local-cluster helper, so this harness proves the same boundary
// in two layers: the source emits FK-qualified relation names, and PostgreSQL
// executes the equivalent tenant-scoped joins against those real constraints.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runDisposableLocalClusterMatrix } from "./network-center-disposable-db.mjs";

export const DEMO_ORG_ID = "dddd0000-0000-4000-8000-000000000001";
export const PROD_ORG_ID = "aaaa0000-0000-4000-8000-000000000001";

const REQUIRED_FOREIGN_KEYS = Object.freeze([
  "contract_customers_customer_id_fkey",
  "contract_customers_contract_id_fkey",
  "contracts_room_id_fkey",
  "rooms_building_id_fkey",
]);

const DIRECT_RELATIONS = Object.freeze([
  ["customers", "rooms"],
  ["customers", "buildings"],
  ["contracts", "buildings"],
  ["contracts", "customers"],
]);

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Remove comments before inspecting the two actual `.select(...)` calls. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

function selectExpression(source, table) {
  const clean = withoutComments(source);
  const match = clean.match(
    new RegExp(
      `\\.from\\(['"]${table}['"]\\)[\\s\\S]*?\\.select\\(([\\s\\S]*?)\\)\\s*\\.`,
      "u",
    ),
  );
  if (!match) throw new Error(`Unable to locate ${table} Copilot select`);
  return match[1];
}

/**
 * Static half of the contract: reject the four historical direct embeds and
 * require every relation hop to carry its explicit FK name.
 */
export function assertSourceContract(source) {
  const selects = {
    customers: selectExpression(source, "customers"),
    contracts: selectExpression(source, "contracts"),
  };
  for (const [table, target] of DIRECT_RELATIONS) {
    const select = selects[table];
    if (new RegExp(`(?:^|[\\s,(:])${target}\\s*\\(`, "u").test(select)) {
      throw new Error(`Direct Copilot relation remains: ${table} -> ${target}`);
    }
  }
  const all = `${selects.customers}\n${selects.contracts}`;
  for (const foreignKey of REQUIRED_FOREIGN_KEYS) {
    if (!all.includes(`!${foreignKey}(`)) {
      throw new Error(`Copilot select is missing FK-qualified hop ${foreignKey}`);
    }
  }
  return true;
}

function buildFixtureSql() {
  // The platform bootstrap deliberately contains only the tables needed by
  // the Network Center migrations. Add the junction table here with the same
  // deployed FK names so the actual join path is exercised, then roll it all
  // back with the rest of the probe transaction.
  return `
CREATE TABLE IF NOT EXISTS public.contract_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  organization_id uuid,
  is_representative boolean NOT NULL DEFAULT false,
  CONSTRAINT contract_customers_contract_id_fkey
    FOREIGN KEY (contract_id) REFERENCES public.contracts(id),
  CONSTRAINT contract_customers_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES public.customers(id)
);

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS contract_number text,
  ADD COLUMN IF NOT EXISTS end_date date;

INSERT INTO public.buildings (id, organization_id, name, code, is_virtual)
VALUES
  ('dddd1000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'COPILOT-DEMO', 'CP-D', false),
  ('aaaa1000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'COPILOT-PROD', 'CP-P', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.rooms (id, organization_id, building_id, name)
VALUES
  ('dddd2000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'CP-D-101'),
  ('aaaa2000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa1000-0000-4000-8000-000000000011', 'CP-P-101')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.customers (id, organization_id, full_name, phone)
VALUES
  ('dddd3000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'Copilot Demo Customer', '0900000011'),
  ('aaaa3000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'Copilot Production Customer', '0900000099')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.contracts (id, organization_id, room_id, status, contract_number, end_date)
VALUES
  ('dddd4000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd2000-0000-4000-8000-000000000011', 'ACTIVE', 'CP-DEMO-001', CURRENT_DATE + 7),
  ('aaaa4000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa2000-0000-4000-8000-000000000011', 'ACTIVE', 'CP-PROD-001', CURRENT_DATE + 7)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.contract_customers (contract_id, customer_id, organization_id, is_representative)
VALUES
  ('dddd4000-0000-4000-8000-000000000011', 'dddd3000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, true),
  ('aaaa4000-0000-4000-8000-000000000011', 'aaaa3000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, true);
`;
}

function buildCopilotReadonlyQueriesSql({ localProof } = {}) {
  if (!localProof) throw new Error("Copilot query probe requires local cluster proof");
  const proof = `
SELECT 1
FROM app_private.network_center_disposable_proof
WHERE proof_nonce = ${sqlLiteral(localProof.proofNonce)}
  AND migration_manifest_sha256 = ${sqlLiteral(localProof.migrationManifestSha256)}
  AND migration_count = ${Number(localProof.migrationCount)}
  AND network_center_migration_count = ${Number(localProof.networkCenterMigrationCount)}`;
  return `BEGIN;
SET LOCAL statement_timeout = '2min';
${buildFixtureSql()}

DO $copilot_preflight$
BEGIN
  IF NOT EXISTS (${proof}) THEN
    RAISE EXCEPTION 'local cluster proof does not match this run';
  END IF;
END
$copilot_preflight$;

WITH fk_names AS (
  SELECT conname
  FROM pg_constraint
  WHERE connamespace = 'public'::regnamespace
    AND conname = ANY(ARRAY[
      'contract_customers_customer_id_fkey',
      'contract_customers_contract_id_fkey',
      'contracts_room_id_fkey',
      'rooms_building_id_fkey'
    ])
),
direct_fk AS (
  SELECT source.relname AS source_table, target.relname AS target_table
  FROM pg_constraint constraint_row
  JOIN pg_class source ON source.oid = constraint_row.conrelid
  JOIN pg_class target ON target.oid = constraint_row.confrelid
  JOIN (VALUES
    ('customers', 'rooms'),
    ('customers', 'buildings'),
    ('contracts', 'buildings'),
    ('contracts', 'customers')
  ) forbidden(source_table, target_table)
    ON forbidden.source_table = source.relname
   AND forbidden.target_table = target.relname
),
customer_rows AS (
  SELECT c.id
  FROM public.customers c
  JOIN public.contract_customers cc
    ON cc.customer_id = c.id
  JOIN public.contracts ct
    ON ct.id = cc.contract_id
   AND ct.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  JOIN public.rooms r
    ON r.id = ct.room_id
   AND r.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  JOIN public.buildings b
    ON b.id = r.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  WHERE c.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND c.full_name ILIKE '%Demo Customer%'
),
customer_empty AS (
  SELECT c.id
  FROM public.customers c
  WHERE c.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND c.full_name ILIKE '%does-not-exist%'
),
contract_rows AS (
  SELECT ct.id, c.full_name, b.name AS building_name
  FROM public.contracts ct
  JOIN public.rooms r
    ON r.id = ct.room_id
   AND r.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  JOIN public.buildings b
    ON b.id = r.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  JOIN public.contract_customers cc
    ON cc.contract_id = ct.id
   AND cc.is_representative
  JOIN public.customers c
    ON c.id = cc.customer_id
   AND c.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  WHERE ct.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND ct.status = 'ACTIVE'
    AND ct.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
),
contract_empty AS (
  SELECT ct.id
  FROM public.contracts ct
  WHERE ct.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND ct.end_date > CURRENT_DATE + 365
),
customer_wrong_org AS (
  SELECT c.id
  FROM public.customers c
  WHERE c.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND c.full_name ILIKE '%Production Customer%'
),
cross_org_join AS (
  SELECT c.id
  FROM public.customers c
  JOIN public.contract_customers cc ON cc.customer_id = c.id
  JOIN public.contracts ct ON ct.id = cc.contract_id
  WHERE c.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND ct.organization_id = ${sqlLiteral(PROD_ORG_ID)}::uuid
),
checks AS (
  SELECT 'customers.positive'::text AS case_id, (SELECT count(*) = 1 FROM customer_rows) AS passed
  UNION ALL SELECT 'customers.empty', (SELECT count(*) = 0 FROM customer_empty)
  UNION ALL SELECT 'contracts.positive', (SELECT count(*) = 1 AND max(full_name) = 'Copilot Demo Customer' FROM contract_rows)
  UNION ALL SELECT 'contracts.empty', (SELECT count(*) = 0 FROM contract_empty)
  UNION ALL SELECT 'schema.fk_names', (SELECT count(*) = 4 FROM fk_names)
  UNION ALL SELECT 'schema.direct_relations_absent', (SELECT count(*) = 0 FROM direct_fk)
  UNION ALL SELECT 'tenant.wrong_org_excluded',
    ((SELECT count(*) FROM customer_wrong_org) = 0
      AND (SELECT count(*) FROM cross_org_join) = 0)
)
SELECT jsonb_build_object(
  'passed', bool_and(passed),
  'assertion_count', count(*),
  'failed_count', count(*) FILTER (WHERE NOT passed),
  'assertions', jsonb_agg(jsonb_build_object('case_id', case_id, 'passed', passed) ORDER BY case_id)
) AS verdict
FROM checks;
ROLLBACK;`;
}

export function parseCopilotReadonlyQueriesVerdict(output) {
  const candidates = String(output)
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
    .filter((entry) => entry && Array.isArray(entry.assertions));
  if (candidates.length !== 1) {
    throw new Error(`Copilot query probe returned ${candidates.length} verdicts; expected one`);
  }
  const verdict = candidates[0];
  if (
    verdict.passed !== true ||
    Number(verdict.failed_count) !== 0 ||
    Number(verdict.assertion_count) !== 7 ||
    verdict.assertions.some((assertion) => assertion?.passed !== true)
  ) {
    throw new Error(`Copilot readonly query contract failed: ${JSON.stringify(verdict)}`);
  }
  return verdict;
}

export async function main(
  argv = process.argv.slice(2),
  { repoRoot = resolve(fileURLToPath(new URL("../", import.meta.url))), runLocalCluster = runDisposableLocalClusterMatrix, log = console.log } = {},
) {
  const mode = argv.find((arg) => arg.startsWith("--"));
  if (mode === "--help" || mode === "-h") {
    log("Usage: node scripts/test-copilot-readonly-queries.mjs --local-cluster");
    return;
  }
  if (mode !== "--local-cluster") {
    throw new Error("Choose --local-cluster (the probe never targets production)");
  }
  const registryPath = resolve(repoRoot, "src/copilot/tools/registry.ts");
  assertSourceContract(await readFile(registryPath, "utf8"));
  const verdict = await runLocalCluster({
    repoRoot,
    buildSql: buildCopilotReadonlyQueriesSql,
    parseVerdict: parseCopilotReadonlyQueriesVerdict,
    includeFleetFixtures: false,
  });
  log(`Copilot readonly query contract passed (${verdict.assertion_count} assertions, transaction rolled back and cluster destroyed).`);
  return verdict;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
