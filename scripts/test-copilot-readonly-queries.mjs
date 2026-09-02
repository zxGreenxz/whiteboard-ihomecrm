#!/usr/bin/env node
// Production-like contract probe for the Copilot read tools.
//
// The disposable cluster is intentionally PostgreSQL-only. PostgREST is not part
// of the local-cluster helper, so this harness proves the boundary in two layers:
// the source reads through the server RPCs, and PostgreSQL executes the equivalent
// tenant-scoped joins against the real constraints.
//
// WHY THE STATIC HALF WAS REWRITTEN (03/09/2026)
//   It used to require FK-qualified PostgREST embeds
//   (`.from('customers').select("...!contract_customers_customer_id_fkey(...)")`).
//   Those calls stopped existing when the customer/contract reads moved behind
//   `copilot_*_v1` RPCs — so `main()` threw "Unable to locate customers Copilot
//   select" before it ever reached PostgreSQL, and the whole harness had been
//   measuring nothing for weeks while still looking like a contract probe.
//   The contract it should assert TODAY is the stronger one: those tables must
//   not be read from the browser at all.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runDisposableLocalClusterMatrix } from "./network-center-disposable-db.mjs";

export const DEMO_ORG_ID = "dddd0000-0000-4000-8000-000000000001";
export const PROD_ORG_ID = "aaaa0000-0000-4000-8000-000000000001";

/**
 * Tables whose tenant boundary is a JOIN away, so a browser query has to guess
 * the relation: contracts carry only `room_id`, vouchers only `building_id`, and
 * customers reach a room through `contract_customers`. Every one of them is read
 * through a server RPC that resolves the scope from `auth.uid()`.
 */
export const TABLES_OFF_LIMITS_TO_THE_BROWSER = Object.freeze([
  "customers",
  "contracts",
  "contract_customers",
  "invoices",
  "income_expenses",
  "income_expense_items",
  "approval_requests",
]);

/** RPC names that must still be called by LITERAL name from the tool sources. */
export const REQUIRED_COPILOT_RPCS = Object.freeze([
  "copilot_customer_search_v1",
  "copilot_expiring_contracts_v1",
  "copilot_contract_search_v1",
  "copilot_contract_detail_v1",
  "copilot_income_expense_search_v1",
  "copilot_pending_requests_v1",
]);

/** Tool sources the static half reads, relative to the repo root. */
export const TOOL_SOURCE_FILES = Object.freeze([
  "src/copilot/tools/registry.ts",
  "src/copilot/tools/nghiepVuTools.ts",
]);

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Talk about the CODE, not about a comment describing the code. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

/**
 * Static half of the contract, in two directions.
 *
 *   forbidden — none of the join-scoped tables may be read from the browser;
 *   required  — every server RPC that replaced them is still called by literal
 *               name (a wrapper hiding the name would make the three RPC gates
 *               blind to it as well).
 *
 * Accepts `{ [file]: source }`; a bare string is treated as registry.ts so older
 * callers keep working.
 */
export function assertSourceContract(sourceByFile) {
  const entries =
    typeof sourceByFile === "string"
      ? { "src/copilot/tools/registry.ts": sourceByFile }
      : (sourceByFile ?? {});
  const files = Object.entries(entries);
  if (files.length === 0) {
    // Zero sources is a broken measurement, not a clean one.
    throw new Error("Copilot source contract: no tool source was read");
  }

  const cleaned = [];
  for (const [file, raw] of files) {
    const clean = withoutComments(String(raw));
    cleaned.push(clean);
    for (const table of TABLES_OFF_LIMITS_TO_THE_BROWSER) {
      if (new RegExp(`\\.from\\(['"]${table}['"]\\)`, "u").test(clean)) {
        throw new Error(
          `Direct browser read of ${table} in ${file}: its tenant boundary is a join away, use the server RPC`,
        );
      }
    }
  }

  const all = cleaned.join("\n");
  for (const rpcName of REQUIRED_COPILOT_RPCS) {
    if (!new RegExp(`['"]${rpcName}['"]`, "u").test(all)) {
      throw new Error(`Copilot tools no longer call ${rpcName} by literal name`);
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

-- G1-C1 surface: the contract-detail and voucher reads. Same approach as the
-- junction table above — declare only the columns the join path needs, keeping
-- the DEPLOYED foreign-key names so the probe exercises the real constraint.
CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  contract_id uuid NOT NULL,
  billing_month text,
  total_amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'UNPAID',
  invoice_number text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CONSTRAINT invoices_contract_id_fkey
    FOREIGN KEY (contract_id) REFERENCES public.contracts(id)
);

CREATE TABLE IF NOT EXISTS public.income_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  code text,
  name text NOT NULL,
  type text NOT NULL,
  total_amount numeric NOT NULL DEFAULT 0,
  approval_status text NOT NULL DEFAULT 'UNAPPROVED',
  posting_status text,
  has_restricted_item boolean NOT NULL DEFAULT false,
  voucher_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CONSTRAINT income_expenses_building_id_fkey
    FOREIGN KEY (building_id) REFERENCES public.buildings(id)
);

INSERT INTO public.invoices (id, organization_id, contract_id, billing_month, total_amount, status, invoice_number)
VALUES
  ('dddd5000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd4000-0000-4000-8000-000000000011', '2026-07', 5500000, 'PAID', 'CP-DEMO-INV-1'),
  ('aaaa5000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa4000-0000-4000-8000-000000000011', '2026-07', 7700000, 'PAID', 'CP-PROD-INV-1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.income_expenses (id, organization_id, building_id, code, name, type, total_amount, approval_status, has_restricted_item, voucher_date)
VALUES
  ('dddd6000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'CP-D-PC-1', 'Tien dien thang 7', 'EXPENSE', 1200000, 'UNAPPROVED', false, CURRENT_DATE),
  ('dddd6000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'CP-D-PC-2', 'Hang muc han che', 'EXPENSE', 9900000, 'UNAPPROVED', true, CURRENT_DATE),
  ('aaaa6000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa1000-0000-4000-8000-000000000011', 'CP-P-PC-1', 'Phieu cong ty khac', 'EXPENSE', 3300000, 'APPROVED', false, CURRENT_DATE)
ON CONFLICT (id) DO NOTHING;
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
      'rooms_building_id_fkey',
      'invoices_contract_id_fkey',
      'income_expenses_building_id_fkey'
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
contract_search_rows AS (
  -- Join path of copilot_contract_search_v1: contracts -> rooms -> buildings,
  -- with the building set standing in for the server-resolved scope.
  SELECT ct.id
  FROM public.contracts ct
  JOIN public.rooms r
    ON r.id = ct.room_id
   AND r.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND r.deleted_at IS NULL
  JOIN public.buildings b
    ON b.id = r.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
  WHERE ct.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND ct.deleted_at IS NULL
    AND lower(coalesce(ct.contract_number, '')) LIKE '%cp-demo%'
),
contract_detail_invoices AS (
  -- Join path of copilot_contract_detail_v1: five latest invoices of ONE contract.
  SELECT i.invoice_number
  FROM public.invoices i
  WHERE i.contract_id = 'dddd4000-0000-4000-8000-000000000011'
    AND i.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND i.deleted_at IS NULL
  ORDER BY i.billing_month DESC, i.created_at DESC
  LIMIT 5
),
voucher_rows AS (
  -- Join path of copilot_income_expense_search_v1, with restricted categories
  -- excluded the way the RPC excludes them for an actor without
  -- income_expenses.restricted_view.
  SELECT ie.id, ie.code
  FROM public.income_expenses ie
  JOIN public.buildings b
    ON b.id = ie.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
  WHERE ie.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND ie.deleted_at IS NULL
    AND NOT coalesce(ie.has_restricted_item, false)
),
voucher_restricted AS (
  SELECT ie.id
  FROM public.income_expenses ie
  WHERE ie.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND coalesce(ie.has_restricted_item, false)
),
voucher_wrong_org AS (
  -- The other company's voucher must not surface through the DEMO building set.
  SELECT ie.id
  FROM public.income_expenses ie
  JOIN public.buildings b
    ON b.id = ie.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  WHERE ie.organization_id = ${sqlLiteral(PROD_ORG_ID)}::uuid
),
checks AS (
  SELECT 'customers.positive'::text AS case_id, (SELECT count(*) = 1 FROM customer_rows) AS passed
  UNION ALL SELECT 'customers.empty', (SELECT count(*) = 0 FROM customer_empty)
  UNION ALL SELECT 'contracts.positive', (SELECT count(*) = 1 AND max(full_name) = 'Copilot Demo Customer' FROM contract_rows)
  UNION ALL SELECT 'contracts.empty', (SELECT count(*) = 0 FROM contract_empty)
  UNION ALL SELECT 'schema.fk_names', (SELECT count(*) = 6 FROM fk_names)
  UNION ALL SELECT 'schema.direct_relations_absent', (SELECT count(*) = 0 FROM direct_fk)
  UNION ALL SELECT 'tenant.wrong_org_excluded',
    ((SELECT count(*) FROM customer_wrong_org) = 0
      AND (SELECT count(*) FROM cross_org_join) = 0)
  UNION ALL SELECT 'contract_search.positive', (SELECT count(*) = 1 FROM contract_search_rows)
  UNION ALL SELECT 'contract_detail.invoices', (SELECT count(*) = 1 AND max(invoice_number) = 'CP-DEMO-INV-1' FROM contract_detail_invoices)
  UNION ALL SELECT 'vouchers.positive', (SELECT count(*) = 1 AND max(code) = 'CP-D-PC-1' FROM voucher_rows)
  UNION ALL SELECT 'vouchers.restricted_excluded',
    ((SELECT count(*) FROM voucher_restricted) = 1
      AND NOT EXISTS (SELECT 1 FROM voucher_rows v JOIN voucher_restricted r ON r.id = v.id))
  UNION ALL SELECT 'vouchers.wrong_org_excluded', (SELECT count(*) = 0 FROM voucher_wrong_org)
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
    Number(verdict.assertion_count) !== 12 ||
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
  const sourceByFile = Object.fromEntries(
    await Promise.all(
      TOOL_SOURCE_FILES.map(async (file) => [file, await readFile(resolve(repoRoot, file), "utf8")]),
    ),
  );
  assertSourceContract(sourceByFile);
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
