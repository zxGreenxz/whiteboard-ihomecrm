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
import { readFileSync } from "node:fs";
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
  // G1-C2. The first four carry a NULLABLE `building_id`, so the browser would
  // have to decide for itself who a row with no building belongs to; `materials`
  // carries no building column at all and is company-scoped only. That decision
  // lives in `authorized_scope_v3`, server-side, and nowhere else.
  "leads",
  "meter_readings",
  "vehicles",
  "jobs",
  "materials",
  // G1-C3. The report pages are where the raw browser reads actually live
  // today (src/hooks/reports/*): a room is only in scope through its
  // building, an extension/termination only through its contract, a booking
  // deposit only through a NULLABLE room, and an expense line only through
  // its voucher. Every one of those is a relation a browser embed guesses.
  "rooms",
  "deposits",
  "contract_extensions",
  "contract_terminations",
  "income_expense_items",
  "income_expense_types",
  // The cash rollups read POSTING truth. A browser query there would have to
  // decide for itself which cashbooks the caller may see the money of --
  // exactly the leak 20260730101000 closed inside the server functions.
  "income_expense_postings",
  "income_expense_posting_lines",
  // G1-C4. Payroll reaches its subject through staff_id and its company
  // through a NULLABLE column; profit reaches the tenant through a building;
  // a Zalo conversation reaches it through a NULLABLE room; and every network
  // row is only in scope through the building it belongs to. Four more
  // relations a browser embed would have to guess.
  "salary_monthly",
  "profit_monthly",
  "profit_allocations",
  "shareholders",
  "zalo_conversations",
  "zalo_messages",
  "network_devices",
  "network_device_current",
  "network_incidents",
  "network_client_current",
]);

/** RPC names that must still be called by LITERAL name from the tool sources. */
export const REQUIRED_COPILOT_RPCS = Object.freeze([
  "copilot_customer_search_v1",
  "copilot_expiring_contracts_v1",
  "copilot_contract_search_v1",
  "copilot_contract_detail_v1",
  "copilot_income_expense_search_v1",
  "copilot_pending_requests_v1",
  "copilot_lead_search_v1",
  "copilot_meter_readings_v1",
  "copilot_vehicle_search_v1",
  "copilot_tasks_v1",
  "copilot_material_stock_v1",
  // G1-C3 — the ten report pages.
  "copilot_report_vacant_rooms_v1",
  "copilot_report_renewals_v1",
  "copilot_report_terminations_v1",
  "copilot_report_new_leases_v1",
  "copilot_report_expense_ratio_v1",
  "copilot_report_daily_cashbook_v1",
  "copilot_report_cash_flow_v1",
  "copilot_report_payment_schedule_v1",
  "copilot_report_overpayment_v1",
  "copilot_report_deposits_v1",
  // G1-C4 — bon mien nhay cam.
  "copilot_salary_summary_v1",
  "copilot_shareholder_profit_v1",
  "copilot_zalo_conversations_v1",
  "copilot_network_status_v1",
  // G1-D2 — bo nho dai han. Ba ham nay SECURITY INVOKER (RLS own-row lo phan
  // ranh gioi), nhung chung van thuoc danh sach nay vi ly do THU HAI cua no:
  // ten RPC phai duoc goi bang chuoi viet thang tu nguon tool, neu khong ba cua
  // chan bien RPC deu mu voi chung.
  "copilot_memory_upsert_v1",
  "copilot_memory_forget_v1",
  "copilot_memory_list_v1",
]);

/**
 * Tool sources the static half reads, relative to the repo root.
 *
 * `writeTools.ts` BELONGS HERE even though it is the write tool. Leaving it out
 * scoped the invariant to fit the code that happened to satisfy it: the one file
 * allowed to touch these tables was also the one file nobody looked at, so a new
 * `.from('contracts')` written there would have passed in silence. Its single
 * legitimate direct read is carried by an explicit exemption below instead.
 */
export const TOOL_SOURCE_FILES = Object.freeze([
  "src/copilot/tools/registry.ts",
  "src/copilot/tools/nghiepVuTools.ts",
  "src/copilot/tools/writeTools.ts",
  // `memoryTools.ts` goi RPC qua `memoryClient.ts`, nen ca hai deu duoc quet:
  // bo file client ra ngoai se de mot duong `.from()` moi viet o do khong ai
  // nhin — dung lo hong ma viec them `writeTools.ts` vao day da dong lai.
  "src/copilot/tools/memoryTools.ts",
  "src/copilot/memoryClient.ts",
]);

/**
 * Narrow, per-CALL exemptions from the forbidden-table rule.
 *
 * `occurrences` is what makes this an exemption for ONE call instead of a
 * blanket pass for the file+table pair: a second `.from('income_expenses')` in
 * writeTools.ts changes the count and fails, exactly like a brand new table
 * would. An entry whose call has disappeared also fails — a leftover exemption
 * is a door held open for whoever writes the next query.
 */
export const DIRECT_READ_EXEMPTIONS = Object.freeze([
  Object.freeze({
    file: "src/copilot/tools/writeTools.ts",
    table: "income_expenses",
    occurrences: 1,
    reason:
      "doc lai 1 dong vua tao theo id (.select('code').eq('id', id)) de cau tra loi mang ma phieu tra cuu duoc; RLS gac, khong co bo loc nao do client dat",
  }),
]);

/** Windows checkouts hand back backslashes; the exemption keys are POSIX. */
function normalizeFileKey(file) {
  return String(file).split("\\").join("/");
}

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
  const scannedFiles = new Set(files.map(([file]) => normalizeFileKey(file)));
  const directReads = new Map();
  for (const [file, raw] of files) {
    const clean = withoutComments(String(raw));
    cleaned.push(clean);
    const fileKey = normalizeFileKey(file);
    for (const table of TABLES_OFF_LIMITS_TO_THE_BROWSER) {
      const hits = clean.match(new RegExp(`\\.from\\(['"]${table}['"]\\)`, "gu")) ?? [];
      if (hits.length === 0) continue;
      const key = `${fileKey}::${table}`;
      directReads.set(key, hits.length);
      const exemption = DIRECT_READ_EXEMPTIONS.find(
        (entry) => `${entry.file}::${entry.table}` === key,
      );
      if (!exemption) {
        throw new Error(
          `Direct browser read of ${table} in ${file}: its tenant boundary is a join away, use the server RPC`,
        );
      }
      if (hits.length !== exemption.occurrences) {
        throw new Error(
          `Direct browser read of ${table} in ${file}: the exemption covers ${exemption.occurrences} call(s) (${exemption.reason}) but ${hits.length} were found`,
        );
      }
    }
  }

  // Only provable when the exemption's own file was actually scanned: a caller
  // handing over a synthetic subset has not looked at it and cannot judge it.
  for (const entry of DIRECT_READ_EXEMPTIONS) {
    const key = `${entry.file}::${entry.table}`;
    if (scannedFiles.has(entry.file) && !directReads.has(key)) {
      throw new Error(
        `Stale exemption ${key}: the call it covers is gone, delete the entry instead of leaving the door open`,
      );
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
  ADD COLUMN IF NOT EXISTS end_date date,
  ADD COLUMN IF NOT EXISTS actual_end_date date;

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

-- G1-C2 surface. Same approach as above: declare only the columns the scope path
-- needs and keep the DEPLOYED foreign-key names, so the probe exercises the real
-- constraint. The building_id column stays NULLABLE on purpose in the first four:
-- the row with no building is the case those RPCs have to decide, and a NOT NULL
-- column here would have made that case untestable.
CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  building_id uuid,
  room_id uuid,
  customer_name text NOT NULL,
  phone text,
  status text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CONSTRAINT leads_building_id_fkey
    FOREIGN KEY (building_id) REFERENCES public.buildings(id)
);

CREATE TABLE IF NOT EXISTS public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  building_id uuid,
  room_id uuid,
  customer_id uuid,
  license_plate text,
  owner_name text,
  vehicle_type text NOT NULL DEFAULT 'MOTORBIKE',
  deleted_at timestamptz,
  CONSTRAINT vehicles_building_id_fkey
    FOREIGN KEY (building_id) REFERENCES public.buildings(id)
);

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  building_id uuid,
  room_id uuid,
  assignee_id uuid,
  code text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'IN_PROGRESS',
  priority text NOT NULL DEFAULT 'NORMAL',
  deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT jobs_building_id_fkey
    FOREIGN KEY (building_id) REFERENCES public.buildings(id)
);

CREATE TABLE IF NOT EXISTS public.meter_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  building_id uuid,
  room_id uuid,
  meter_type text NOT NULL,
  settlement_month text,
  reading_date date NOT NULL DEFAULT CURRENT_DATE,
  previous_reading numeric(10,2) NOT NULL DEFAULT 0,
  current_reading numeric(10,2) NOT NULL,
  consumption numeric(10,2) GENERATED ALWAYS AS ((current_reading - previous_reading)) STORED,
  status text NOT NULL DEFAULT 'UNAPPROVED',
  deleted_at timestamptz,
  CONSTRAINT meter_readings_building_id_fkey
    FOREIGN KEY (building_id) REFERENCES public.buildings(id)
);

CREATE TABLE IF NOT EXISTS public.material_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  name text NOT NULL
);

-- category_id and material_categories are here because the LIVE half below
-- executes the SHIPPED body of copilot_material_stock_v1, which LEFT JOINs the
-- category table. A fixture that only carried the columns the hand-written
-- replication needed would make the real body fail to parse, and a probe that
-- cannot run the function proves nothing about the function.
CREATE TABLE IF NOT EXISTS public.materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  category_id uuid,
  code text,
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'cai',
  on_hand numeric NOT NULL DEFAULT 0,
  reorder_level numeric NOT NULL DEFAULT 0,
  avg_unit_cost numeric NOT NULL DEFAULT 0,
  deleted_at timestamptz
);

INSERT INTO public.leads (id, organization_id, building_id, room_id, customer_name, phone, status)
VALUES
  ('dddd7000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'dddd2000-0000-4000-8000-000000000011', 'Copilot Demo Lead', '0900000021', 'B2_APPOINTMENT'),
  ('dddd7000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, NULL, NULL, 'Copilot Demo Lead No Building', '0900000022', 'B1_LEAD'),
  ('aaaa7000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa1000-0000-4000-8000-000000000011', NULL, 'Copilot Production Lead', '0900000023', 'B1_LEAD')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.vehicles (id, organization_id, building_id, room_id, license_plate, owner_name, vehicle_type)
VALUES
  ('dddd8000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'dddd2000-0000-4000-8000-000000000011', '59P1-12345', 'Copilot Demo Owner', 'MOTORBIKE'),
  ('aaaa8000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa1000-0000-4000-8000-000000000011', NULL, '59P1-99999', 'Copilot Production Owner', 'CAR')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.jobs (id, organization_id, building_id, room_id, code, title, status)
VALUES
  ('dddd9000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'dddd2000-0000-4000-8000-000000000011', 'CP-D-JOB-1', 'Sua voi nuoc', 'IN_PROGRESS'),
  ('dddd9000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', NULL, 'CP-D-JOB-2', 'Da xong', 'COMPLETED'),
  ('aaaa9000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa1000-0000-4000-8000-000000000011', NULL, 'CP-P-JOB-1', 'Viec cong ty khac', 'IN_PROGRESS')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.meter_readings (id, organization_id, building_id, room_id, meter_type, settlement_month, previous_reading, current_reading, status)
VALUES
  ('dddda000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'dddd2000-0000-4000-8000-000000000011', 'ELECTRICITY', '2026-07', 100, 175, 'UNAPPROVED'),
  ('dddda000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'dddd2000-0000-4000-8000-000000000011', 'WATER', '2026-07', 10, 15, 'APPROVED'),
  ('dddda000-0000-4000-8000-000000000013', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'dddd2000-0000-4000-8000-000000000011', 'ELECTRICITY', '2026-06', 40, 100, 'APPROVED'),
  ('aaaaa000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa1000-0000-4000-8000-000000000011', NULL, 'ELECTRICITY', '2026-07', 0, 999, 'UNAPPROVED')
ON CONFLICT (id) DO NOTHING;


-- G1-C3 surface: the report pages. Same approach again — only the columns the
-- scope path needs, and the DEPLOYED foreign-key names.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS building_id uuid,
  ADD COLUMN IF NOT EXISTS room_id uuid,
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS paid_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining_amount numeric;

CREATE TABLE IF NOT EXISTS public.contract_extensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  contract_id uuid NOT NULL,
  extension_date date NOT NULL,
  new_end_date date,
  new_rent_price numeric,
  status text NOT NULL DEFAULT 'APPROVED',
  CONSTRAINT contract_extensions_contract_id_fkey
    FOREIGN KEY (contract_id) REFERENCES public.contracts(id)
);

CREATE TABLE IF NOT EXISTS public.contract_terminations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  contract_id uuid NOT NULL,
  termination_type text,
  termination_date date,
  refund_amount numeric,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT contract_terminations_contract_id_fkey
    FOREIGN KEY (contract_id) REFERENCES public.contracts(id)
);

-- The room_id column stays NULLABLE on purpose: a booking deposit taken before
-- a room was chosen is the case copilot_report_deposits_v1 has to decide, and a
-- NOT NULL column here would have made that case untestable.
CREATE TABLE IF NOT EXISTS public.deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  room_id uuid,
  tenant_id uuid,
  code text,
  amount numeric NOT NULL DEFAULT 0,
  deposit_date date NOT NULL DEFAULT CURRENT_DATE,
  hold_until date,
  status text NOT NULL DEFAULT 'PENDING',
  deleted_at timestamptz,
  CONSTRAINT deposits_room_id_fkey
    FOREIGN KEY (room_id) REFERENCES public.rooms(id)
);

-- A second DEMO room with NO active contract — the vacant one — plus the ended
-- contract that dates its vacancy.
INSERT INTO public.rooms (id, organization_id, building_id, name)
VALUES ('dddd2000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'CP-D-102')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.contracts (id, organization_id, room_id, status, contract_number, end_date)
VALUES ('dddd4000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd2000-0000-4000-8000-000000000012', 'TERMINATED', 'CP-ENDED-002', CURRENT_DATE - 30)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.contract_extensions (id, organization_id, contract_id, extension_date, new_end_date, new_rent_price, status)
VALUES
  ('ddddc000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd4000-0000-4000-8000-000000000011', CURRENT_DATE - 5, CURRENT_DATE + 370, 5500000, 'APPROVED'),
  ('ddddc000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd4000-0000-4000-8000-000000000011', CURRENT_DATE - 4, CURRENT_DATE + 380, 5600000, 'DRAFT')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.contract_terminations (id, organization_id, contract_id, termination_type, termination_date, refund_amount)
VALUES ('ddddd000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd4000-0000-4000-8000-000000000012', 'EARLY', CURRENT_DATE - 30, 1500000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.deposits (id, organization_id, room_id, code, amount, deposit_date, hold_until, status)
VALUES
  ('ddade000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd2000-0000-4000-8000-000000000012', 'CP-D-DC-1', 3000000, CURRENT_DATE - 3, CURRENT_DATE + 7, 'CONFIRMED'),
  ('ddade000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, NULL, 'CP-D-DC-2', 2000000, CURRENT_DATE - 2, NULL, 'PENDING'),
  ('aaade000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa2000-0000-4000-8000-000000000011', 'CP-P-DC-1', 9000000, CURRENT_DATE - 1, NULL, 'CONFIRMED')
ON CONFLICT (id) DO NOTHING;

-- Posting truth for the two cash rollups. Only the columns the scope path needs,
-- plus the cashbook the line lands on: the boundary being probed here is
-- "whose money may this caller see", which lives on the LINE, not on the voucher.
CREATE TABLE IF NOT EXISTS public.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  name text,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.income_expense_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  voucher_id uuid,
  event_kind text NOT NULL,
  posted_on date NOT NULL
);

CREATE TABLE IF NOT EXISTS public.income_expense_posting_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  posting_id uuid NOT NULL,
  account_id uuid NOT NULL,
  signed_amount numeric NOT NULL,
  CONSTRAINT income_expense_posting_lines_posting_id_fkey
    FOREIGN KEY (posting_id) REFERENCES public.income_expense_postings(id)
);

INSERT INTO public.accounts (id, organization_id, name)
VALUES
  ('ddac0000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'CP-D-SO-NHIN-DUOC'),
  ('ddac0000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'CP-D-SO-KHONG-NHIN-DUOC'),
  ('aaac0000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'CP-P-SO')
ON CONFLICT (id) DO NOTHING;

-- P1 + P2 are the pair that makes posting truth different from voucher truth: a
-- voucher posted and then REVERSED. Summing the voucher would count it once, in
-- full; summing the lines nets it to zero.
INSERT INTO public.income_expense_postings (id, organization_id, voucher_id, event_kind, posted_on)
VALUES
  ('ddaf0000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, NULL, 'POSTING',    CURRENT_DATE - 1),
  ('ddaf0000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, NULL, 'REVERSAL',   CURRENT_DATE - 1),
  ('ddaf0000-0000-4000-8000-000000000013', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd6000-0000-4000-8000-000000000011', 'POSTING', CURRENT_DATE - 1),
  ('ddaf0000-0000-4000-8000-000000000014', ${sqlLiteral(DEMO_ORG_ID)}::uuid, NULL, 'POSTING',    CURRENT_DATE - 1),
  ('ddaf0000-0000-4000-8000-000000000015', ${sqlLiteral(DEMO_ORG_ID)}::uuid, NULL, 'ADJUSTMENT', CURRENT_DATE - 1),
  ('ddaf0000-0000-4000-8000-000000000016', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd6000-0000-4000-8000-000000000012', 'POSTING', CURRENT_DATE - 1),
  ('aaaf0000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, NULL, 'POSTING',    CURRENT_DATE - 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.income_expense_posting_lines (id, organization_id, posting_id, account_id, signed_amount)
VALUES
  ('ddb00000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'ddaf0000-0000-4000-8000-000000000011', 'ddac0000-0000-4000-8000-000000000011',  5000000),
  ('ddb00000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'ddaf0000-0000-4000-8000-000000000012', 'ddac0000-0000-4000-8000-000000000011', -5000000),
  ('ddb00000-0000-4000-8000-000000000013', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'ddaf0000-0000-4000-8000-000000000013', 'ddac0000-0000-4000-8000-000000000011', -1200000),
  ('ddb00000-0000-4000-8000-000000000014', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'ddaf0000-0000-4000-8000-000000000014', 'ddac0000-0000-4000-8000-000000000012',  9000000),
  ('ddb00000-0000-4000-8000-000000000015', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'ddaf0000-0000-4000-8000-000000000015', 'ddac0000-0000-4000-8000-000000000011',  7000000),
  ('ddb00000-0000-4000-8000-000000000016', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'ddaf0000-0000-4000-8000-000000000016', 'ddac0000-0000-4000-8000-000000000011', -9900000),
  ('aab00000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaf0000-0000-4000-8000-000000000011', 'aaac0000-0000-4000-8000-000000000011',  3300000)
ON CONFLICT (id) DO NOTHING;

-- One overdue invoice, one upcoming, one overpaid, and one belonging to the
-- other company through its building.
INSERT INTO public.invoices (id, organization_id, contract_id, building_id, room_id, billing_month, due_date, total_amount, paid_amount, remaining_amount, status, invoice_number)
VALUES
  ('dddd5000-0000-4000-8000-000000000021', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd4000-0000-4000-8000-000000000012', 'dddd1000-0000-4000-8000-000000000011', 'dddd2000-0000-4000-8000-000000000011', '2026-06', CURRENT_DATE - 3, 5000000, 2000000, 3000000, 'PARTIAL_PAID', 'CP-DEMO-INV-OVERDUE'),
  ('dddd5000-0000-4000-8000-000000000022', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd4000-0000-4000-8000-000000000012', 'dddd1000-0000-4000-8000-000000000011', 'dddd2000-0000-4000-8000-000000000011', '2026-08', CURRENT_DATE + 7, 4000000, 0, 4000000, 'APPROVED', 'CP-DEMO-INV-UPCOMING'),
  ('dddd5000-0000-4000-8000-000000000023', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd4000-0000-4000-8000-000000000012', 'dddd1000-0000-4000-8000-000000000011', 'dddd2000-0000-4000-8000-000000000011', '2026-05', CURRENT_DATE - 40, 5000000, 6000000, 0, 'PAID', 'CP-DEMO-INV-OVERPAID'),
  ('aaaa5000-0000-4000-8000-000000000021', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa4000-0000-4000-8000-000000000011', 'aaaa1000-0000-4000-8000-000000000011', 'aaaa2000-0000-4000-8000-000000000011', '2026-08', CURRENT_DATE + 5, 7000000, 0, 7000000, 'APPROVED', 'CP-PROD-INV-UPCOMING')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.materials (id, organization_id, code, name, unit, on_hand, reorder_level, avg_unit_cost)
VALUES
  ('ddddb000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'CP-D-VT-1', 'Bong den LED', 'cai', 2, 10, 50000),
  ('ddddb000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'CP-D-VT-2', 'Voi nuoc', 'cai', 40, 5, 120000),
  ('aaaab000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'CP-P-VT-1', 'Vat tu cong ty khac', 'cai', 1, 99, 1000),
  -- Subject of the LIKE-escape assertions: one name really containing '%' and
  -- one really containing '_'. Without them, searching for '%' would match
  -- everything either way and the escape would be untestable.
  ('ddddb000-0000-4000-8000-000000000013', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'CP-D-VT-3', 'Xi mang giam 50% con lai', 'bao', 7, 3, 90000),
  ('ddddb000-0000-4000-8000-000000000014', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'CP-D-VT-4', 'Ong nhua a_b noi', 'cai', 9, 4, 30000)
ON CONFLICT (id) DO NOTHING;

-- G1-C4 surface: the four SENSITIVE domains. The Network Center tables are NOT
-- declared here — they are created by the real migrations the disposable cluster
-- replays, so the inserts below run against their actual CHECK constraints and
-- composite foreign keys. The other four are stubs with the DEPLOYED foreign-key
-- names, same approach as every block above.
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY,
  organization_id uuid,
  full_name text NOT NULL
);

-- 'user_id' (owner of the payroll row) and 'staff_id' (the person the money
-- belongs to) are DIFFERENT columns and the fixture makes them differ on purpose:
-- that difference is the whole point of the own-row assertion below.
CREATE TABLE IF NOT EXISTS public.salary_monthly (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  user_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  period_month date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  gross_total numeric NOT NULL DEFAULT 0,
  take_home numeric NOT NULL DEFAULT 0,
  paid numeric NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.shareholders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  name text NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.profit_monthly (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  period_month date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  computed_profit numeric NOT NULL DEFAULT 0,
  adjusted_profit numeric NOT NULL DEFAULT 0,
  management_salary numeric NOT NULL DEFAULT 0,
  shareholder_allocated_amount numeric NOT NULL DEFAULT 0,
  unallocated_profit numeric NOT NULL DEFAULT 0,
  is_stale boolean NOT NULL DEFAULT false,
  CONSTRAINT profit_monthly_building_id_fkey
    FOREIGN KEY (building_id) REFERENCES public.buildings(id)
);

-- The profit-manager twin of the shareholder tables. It exists here because the
-- self-restriction has TWO arms (profit_monthly_self_select and
-- profit_monthly_self_manager) and a probe that only builds one of them cannot
-- tell a missing arm from an empty one.
CREATE TABLE IF NOT EXISTS public.profit_managers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  auth_user_id uuid,
  name text NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.profit_manager_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  profit_monthly_id uuid NOT NULL,
  manager_id uuid NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  CONSTRAINT profit_manager_allocations_profit_monthly_id_fkey
    FOREIGN KEY (profit_monthly_id) REFERENCES public.profit_monthly(id),
  CONSTRAINT profit_manager_allocations_manager_id_fkey
    FOREIGN KEY (manager_id) REFERENCES public.profit_managers(id)
);

CREATE TABLE IF NOT EXISTS public.profit_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  profit_monthly_id uuid NOT NULL,
  shareholder_id uuid NOT NULL,
  percent numeric NOT NULL DEFAULT 0,
  amount numeric NOT NULL DEFAULT 0,
  CONSTRAINT profit_allocations_profit_monthly_id_fkey
    FOREIGN KEY (profit_monthly_id) REFERENCES public.profit_monthly(id),
  CONSTRAINT profit_allocations_shareholder_id_fkey
    FOREIGN KEY (shareholder_id) REFERENCES public.shareholders(id)
);

-- 'room_id' stays NULLABLE on purpose: a conversation with no room is the case
-- copilot_zalo_conversations_v1 has to decide, and a NOT NULL column here would
-- have made that case untestable.
CREATE TABLE IF NOT EXISTS public.zalo_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  room_id uuid,
  peer_name text NOT NULL,
  peer_phone text,
  unread_count integer NOT NULL DEFAULT 0,
  marked_unread boolean NOT NULL DEFAULT false,
  is_pinned boolean NOT NULL DEFAULT false,
  last_message_at timestamptz,
  last_message_text text,
  CONSTRAINT zalo_conversations_room_id_fkey
    FOREIGN KEY (room_id) REFERENCES public.rooms(id)
);

INSERT INTO public.profiles (id, organization_id, full_name)
VALUES
  ('ddd10000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'Copilot Demo Manager A'),
  ('ddd10000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'Copilot Demo Manager B')
ON CONFLICT (id) DO NOTHING;

-- Manager A OWNS both DEMO payroll rows ('user_id') but is the SUBJECT of only
-- one ('staff_id'). Reading own-row by 'user_id' therefore returns two rows and
-- by 'staff_id' returns one — which is exactly the leak the RPC must not have.
INSERT INTO public.salary_monthly (id, organization_id, user_id, staff_id, period_month, status, gross_total, take_home, paid)
VALUES
  ('ddd20000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'ddd10000-0000-4000-8000-000000000011', 'ddd10000-0000-4000-8000-000000000011', '2026-08-01', 'LOCKED', 11000000, 7800000, 5000000),
  ('ddd20000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'ddd10000-0000-4000-8000-000000000011', 'ddd10000-0000-4000-8000-000000000012', '2026-08-01', 'DRAFT',  9000000, 6000000, 0),
  ('aaa20000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'ddd10000-0000-4000-8000-000000000011', 'ddd10000-0000-4000-8000-000000000011', '2026-08-01', 'DRAFT', 50000000, 44000000, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.shareholders (id, organization_id, name)
VALUES
  ('ddd30000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'Copilot Demo Shareholder'),
  -- The CO-OWNER. 20260713110400 grants shareholder_profit.view to both of them,
  -- and RLS (profit_alloc_self_select) is what stops each from reading the
  -- other's payout on the screen. A SECURITY DEFINER function has to do that
  -- itself, so the fixture needs someone to leak TO.
  ('ddd30000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'Copilot Demo Co-Shareholder'),
  ('aaa30000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'Copilot Production Shareholder')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profit_monthly (id, organization_id, building_id, period_month, status, computed_profit, adjusted_profit, management_salary, shareholder_allocated_amount, unallocated_profit, is_stale)
VALUES
  ('ddd40000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', '2026-07-01', 'LOCKED', 40000000, 39000000, 5000000, 27300000, 6700000, true),
  -- A NEWER month with no allocation for our shareholder at all. If the default
  -- period ignored the self-restriction it would land here, and the answer would
  -- silently be about a month the caller may not read.
  ('ddd40000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', '2026-08-01', 'DRAFT', 10000000, 10000000, 0, 0, 10000000, false),
  ('aaa40000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa1000-0000-4000-8000-000000000011', '2026-07-01', 'LOCKED', 90000000, 90000000, 9000000, 63000000, 18000000, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profit_allocations (id, organization_id, profit_monthly_id, shareholder_id, percent, amount)
VALUES
  ('ddd50000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'ddd40000-0000-4000-8000-000000000011', 'ddd30000-0000-4000-8000-000000000011', 70, 27300000),
  ('ddd50000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'ddd40000-0000-4000-8000-000000000011', 'ddd30000-0000-4000-8000-000000000012', 30, 11700000),
  ('aaa50000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaa40000-0000-4000-8000-000000000011', 'aaa30000-0000-4000-8000-000000000011', 70, 63000000)
ON CONFLICT (id) DO NOTHING;

-- Four conversations, and the third one is the trap: it belongs to DEMO but its
-- room belongs to the OTHER company, so a LEFT JOIN alone gives it the same
-- 'b.id IS NULL' as a conversation with no room at all.
INSERT INTO public.zalo_conversations (id, organization_id, room_id, peer_name, peer_phone, unread_count, last_message_at, last_message_text)
VALUES
  ('ddd60000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd2000-0000-4000-8000-000000000011', 'Copilot Demo Peer Room', '0900000031', 2, clock_timestamp(), 'Tin cuoi cua khach co phong'),
  ('ddd60000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, NULL, 'Copilot Demo Peer No Room', '0900000032', 0, clock_timestamp(), 'Tin cuoi cua khach chua co phong'),
  ('ddd60000-0000-4000-8000-000000000013', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'aaaa2000-0000-4000-8000-000000000011', 'Copilot Demo Peer Foreign Room', '0900000033', 5, clock_timestamp(), 'Phong nay thuoc cong ty khac'),
  ('aaa60000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa2000-0000-4000-8000-000000000011', 'Copilot Production Peer', '0900000034', 9, clock_timestamp(), 'Hoi thoai cong ty khac')
ON CONFLICT (id) DO NOTHING;

-- Network Center: real tables, real CHECK constraints, real composite FKs. The
-- ARUBA device exists so the "router" join proves it picks MIKROTIK and not
-- simply "the first device in the building".
INSERT INTO public.network_devices (id, organization_id, building_id, device_kind, external_key, display_name, vendor, is_active, lifecycle_status, model)
VALUES
  ('ddd70000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'MIKROTIK', 'cp-d-rb-1', 'CP-D-RB-1', 'MikroTik', true, 'ONLINE', 'hAP ax2'),
  ('aaa70000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa1000-0000-4000-8000-000000000011', 'MIKROTIK', 'cp-p-rb-1', 'CP-P-RB-1', 'MikroTik', true, 'ONLINE', 'hAP ax2')
ON CONFLICT (id) DO NOTHING;

-- The access point is inserted in its OWN statement, with its parent already set:
-- network_center_guard_aruba_parent_v1() rejects an ARUBA row whose parent is not
-- a MikroTik in the same building, and the parent must therefore exist first.
INSERT INTO public.network_devices (id, organization_id, building_id, device_kind, external_key, display_name, vendor, is_active, lifecycle_status, model, write_capability, parent_device_id, aruba_stable_key, aruba_identity_source, aruba_discovery_state, aruba_discovery_first_seen_at, aruba_discovery_last_seen_at)
VALUES
  ('ddd70000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'ARUBA', 'cp-d-ap-1', 'CP-D-AP-1', 'Aruba', true, 'ONLINE', 'AP-505', false, 'ddd70000-0000-4000-8000-000000000011', 'serial:CPDAP1', 'SERIAL', 'DISCOVERED', clock_timestamp(), clock_timestamp())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.network_device_current (device_id, organization_id, building_id, observed_at, reachable, health_status, last_seen_at, pppoe_state, connection_count, cpu_pct, update_seq)
VALUES
  ('ddd70000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', clock_timestamp(), false, 'OFFLINE', clock_timestamp() - interval '1 hour', 'DOWN', 0, 12, 1),
  ('aaa70000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa1000-0000-4000-8000-000000000011', clock_timestamp(), true, 'HEALTHY', clock_timestamp(), 'UP', 40, 8, 1)
ON CONFLICT (device_id) DO NOTHING;

INSERT INTO public.network_incidents (id, organization_id, building_id, device_id, fingerprint, incident_type, severity, status, title, summary, opened_at, last_observed_at, resolved_at)
VALUES
  ('ddd80000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'ddd70000-0000-4000-8000-000000000011', 'cp-d-inc-open-1', 'DEVICE_UNREACHABLE', 'CRITICAL', 'OPEN', 'Router mat ket noi', 'Router khong phan hoi tu 1 gio truoc', clock_timestamp() - interval '1 hour', clock_timestamp(), NULL),
  ('ddd80000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'ddd70000-0000-4000-8000-000000000011', 'cp-d-inc-done-1', 'DEVICE_UNREACHABLE', 'WARNING', 'RESOLVED', 'Su co da xu ly', 'Da khoi phuc tu hom qua', clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day', clock_timestamp() - interval '1 day'),
  ('aaa80000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa1000-0000-4000-8000-000000000011', 'aaa70000-0000-4000-8000-000000000011', 'cp-p-inc-open-1', 'DEVICE_UNREACHABLE', 'CRITICAL', 'OPEN', 'Su co cong ty khac', 'Khong duoc lot vao cau tra loi cua DEMO', clock_timestamp() - interval '1 hour', clock_timestamp(), NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.network_client_current (id, organization_id, building_id, device_id, session_key, client_fingerprint, connection_type, session_type, first_seen_at, last_seen_at, observed_at, expires_at, update_seq)
VALUES
  ('ddd90000-0000-4000-8000-000000000011', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'ddd70000-0000-4000-8000-000000000011', 'cp-d-sess-001', 'cp-d-client-001', 'WIFI', 'DHCP', clock_timestamp() - interval '2 hours', clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', 1),
  ('ddd90000-0000-4000-8000-000000000012', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'ddd70000-0000-4000-8000-000000000011', 'cp-d-sess-002', 'cp-d-client-002', 'ETHERNET', 'DHCP', clock_timestamp() - interval '2 hours', clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '2 hours', 1),
  ('ddd90000-0000-4000-8000-000000000013', ${sqlLiteral(DEMO_ORG_ID)}::uuid, 'dddd1000-0000-4000-8000-000000000011', 'ddd70000-0000-4000-8000-000000000011', 'cp-d-sess-003', 'cp-d-client-003', 'WIFI', 'DHCP', clock_timestamp() - interval '5 hours', clock_timestamp() - interval '4 hours', clock_timestamp() - interval '4 hours', clock_timestamp() - interval '3 hours', 1),
  ('aaa90000-0000-4000-8000-000000000011', ${sqlLiteral(PROD_ORG_ID)}::uuid, 'aaaa1000-0000-4000-8000-000000000011', 'aaa70000-0000-4000-8000-000000000011', 'cp-p-sess-001', 'cp-p-client-001', 'WIFI', 'DHCP', clock_timestamp() - interval '2 hours', clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', 1)
ON CONFLICT (id) DO NOTHING;
`;
}

/** Migration mang bản vá đang được kiểm. */
export const HARDENING_MIGRATION_PATH =
  "supabase/migrations/20260903050215_copilot_read_rpc_hardening_v2.sql";

/**
 * Thân nguyên văn của một hàm trong file migration.
 *
 * Nửa "live" bên dưới KHÔNG chép lại logic — nó nạp CHÍNH đoạn SQL sắp lên
 * production rồi gọi thật. Một bản chép tay sẽ trôi khỏi bản gốc đúng vào ngày
 * bản gốc hỏng, và đó là lúc phép đo cần đúng nhất.
 */
export function trichThanHam(source, ten, schema) {
  const moc = `CREATE OR REPLACE FUNCTION ${schema}.${ten}(`;
  const start = source.indexOf(moc);
  if (start < 0) throw new Error(`Không tìm thấy ${schema}.${ten} trong migration`);
  const ket = source.indexOf("\n$fn$;", start);
  if (ket < 0) throw new Error(`Không tìm thấy điểm đóng của ${schema}.${ten}`);
  return source.slice(start, ket + "\n$fn$;".length);
}

/**
 * Nửa THỰC THI: chạy đúng thân hàm của migration trên cluster dùng-một-lần.
 *
 * VÌ SAO PHẢI STUB BA THỨ
 *   Cluster này chỉ replay nhóm migration Network Center trên một platform
 *   bootstrap, nên `authorized_scope_v3`, `copilot_org_scope_buildings_v1` và
 *   `auth.uid()` thật KHÔNG có ở đây (`auth.uid()` của shim luôn trả NULL, tức
 *   mọi RPC dừng ở dòng đầu tiên và không dòng nào sau đó được đo).
 *
 *   Nên ba thứ đó được thay bằng bản điều khiển bằng GUC — CHỈ ba thứ đó. Thân
 *   hàm được kiểm là bản nguyên văn của migration, dữ liệu là fixture thật, và
 *   thứ đang đo chính là điều cần đo: với một phạm vi quyền cho trước, hàm này
 *   trả gì và có RAISE không.
 *
 *   Điều này KHÔNG phủ: bản thân `authorized_scope_v3` (đã có bộ test riêng) và
 *   việc gấp dấu bằng `extensions.unaccent` (stub dùng nhánh `lower()` — đúng
 *   nhánh mà migration cài trên cluster không có unaccent).
 */
function buildLiveRpcProbeSql(migrationSql) {
  const likeEscape = trichThanHam(migrationSql, "copilot_like_escape_v1", "app_private");
  const flagHelper = trichThanHam(migrationSql, "copilot_page_flag_allows_v1", "app_private");
  const materialStock = trichThanHam(migrationSql, "copilot_material_stock_v1", "public");
  return `
CREATE SCHEMA IF NOT EXISTS app_private;

-- Ba stub điều khiển bằng GUC. Không cái nào giả lập luật quyền — chúng chỉ
-- BƠM một phạm vi đã biết vào, để câu hỏi còn lại là câu hỏi về thân hàm.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $probe$ SELECT NULLIF(current_setting('copilot.actor', true), '')::uuid $probe$;

CREATE OR REPLACE FUNCTION app_private.authorized_scope_v3(p_permission_key text, p_org uuid)
RETURNS TABLE(org_wide boolean, building_ids uuid[], cashbook_ids uuid[])
LANGUAGE sql STABLE
AS $probe$
  SELECT
    COALESCE(NULLIF(current_setting('copilot.org_wide', true), ''), 'false')::boolean,
    CASE
      WHEN COALESCE(current_setting('copilot.buildings', true), '') = '' THEN '{}'::uuid[]
      ELSE string_to_array(current_setting('copilot.buildings', true), ',')::uuid[]
    END,
    '{}'::uuid[];
$probe$;

-- Bản thật KHÔNG raise khi thiếu quyền — nó trả mảng rỗng. Stub giữ đúng nết đó,
-- vì chính nết đó là lỗ hổng A1 mà hàng rào mới phải bù.
CREATE OR REPLACE FUNCTION public.copilot_org_scope_buildings_v1(p_permission_key text, p_organization_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql STABLE
AS $probe$
DECLARE v uuid[];
BEGIN
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  SELECT s.building_ids INTO v FROM app_private.authorized_scope_v3(p_permission_key, p_organization_id) s;
  RETURN COALESCE(v, '{}'::uuid[]);
END
$probe$;

-- Nhánh KHÔNG-unaccent của 20260902193151, nguyên văn.
CREATE OR REPLACE FUNCTION app_private.copilot_fold_text_v1(p_text text)
RETURNS text LANGUAGE sql STABLE
AS $probe$ SELECT lower(coalesce($1, '')) $probe$;

CREATE TABLE IF NOT EXISTS public.copilot_feature_flags (
  scope text NOT NULL,
  contract_id text NOT NULL,
  state text NOT NULL DEFAULT 'disabled',
  canary_org uuid,
  expires_at timestamptz,
  PRIMARY KEY (scope, contract_id)
);
INSERT INTO public.copilot_feature_flags (scope, contract_id, state, canary_org, expires_at)
VALUES
  ('page', 'copilot.sensitive.salary'            , 'disabled', NULL, NULL),
  ('page', 'copilot.sensitive.shareholder-profit', 'shadow'  , NULL, NULL),
  ('page', 'copilot.sensitive.network'           , 'enabled' , NULL, NULL),
  ('page', 'probe.canary.khac'                   , 'enabled' , ${sqlLiteral(PROD_ORG_ID)}::uuid, NULL),
  ('page', 'probe.canary.dung'                   , 'enabled' , ${sqlLiteral(DEMO_ORG_ID)}::uuid, NULL),
  ('page', 'probe.het.han'                       , 'enabled' , NULL, now() - interval '1 day')
ON CONFLICT (scope, contract_id) DO NOTHING;

-- === Ba thân hàm NGUYÊN VĂN từ migration =====================================
${likeEscape}

${flagHelper}

${materialStock}
-- =============================================================================

CREATE TEMP TABLE copilot_live_checks (case_id text PRIMARY KEY, passed boolean NOT NULL) ON COMMIT DROP;

DO $live$
DECLARE
  v_org uuid := ${sqlLiteral(DEMO_ORG_ID)}::uuid;
  v_toa text := 'dddd1000-0000-4000-8000-000000000011';
  v_ra jsonb;
  v_ma text;
BEGIN
  PERFORM set_config('copilot.actor', 'dddd9999-0000-4000-8000-000000000001', true);

  -- A1. Thành viên ACTIVE nhưng KHÔNG có mảnh quyền materials.view nào: bản cũ
  -- (chỉ PERFORM helper) trả TRỌN kho; bản mới phải RAISE 42501.
  PERFORM set_config('copilot.org_wide', 'false', true);
  PERFORM set_config('copilot.buildings', '', true);
  BEGIN
    v_ra := public.copilot_material_stock_v1(v_org, NULL, 20);
    INSERT INTO copilot_live_checks VALUES ('live.material_stock.no_grant_denied', false);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_ma = RETURNED_SQLSTATE;
    INSERT INTO copilot_live_checks VALUES ('live.material_stock.no_grant_denied', v_ma = '42501');
  END;

  -- Cùng một hàm, cùng dữ liệu, chỉ khác phạm vi: org-wide phải ĐỌC ĐƯỢC. Không
  -- có nhánh này thì "luôn luôn raise" cũng làm assertion trên xanh.
  PERFORM set_config('copilot.org_wide', 'true', true);
  v_ra := public.copilot_material_stock_v1(v_org, NULL, 20);
  INSERT INTO copilot_live_checks VALUES (
    'live.material_stock.org_wide_reads',
    (v_ra -> 'tong_hop' ->> 'so_mat_hang')::int = 4
      AND (v_ra ->> 'so_luong')::int = 4
      AND NOT (v_ra -> 'vat_tu')::text LIKE '%Vat tu cong ty khac%'
  );

  -- Mot manh quyen theo TOA cung du de hoi: bang materials khong co truc toa, va
  -- RLS cua no la ranh gioi CONG TY. Hang rao moi khong duoc chat hon man hinh.
  PERFORM set_config('copilot.org_wide', 'false', true);
  PERFORM set_config('copilot.buildings', v_toa, true);
  v_ra := public.copilot_material_stock_v1(v_org, NULL, 20);
  INSERT INTO copilot_live_checks VALUES (
    'live.material_stock.building_grant_reads',
    (v_ra -> 'tong_hop' ->> 'so_mat_hang')::int = 4
  );

  -- A6. '%' trong câu tìm phải là KÝ TỰ, không phải ký tự đại diện.
  v_ra := public.copilot_material_stock_v1(v_org, '50%', 20);
  INSERT INTO copilot_live_checks VALUES (
    'live.material_stock.percent_is_literal',
    (v_ra ->> 'so_luong')::int = 1
      AND (v_ra -> 'vat_tu' -> 0 ->> 'ma') = 'CP-D-VT-3'
  );
  v_ra := public.copilot_material_stock_v1(v_org, 'a_b', 20);
  INSERT INTO copilot_live_checks VALUES (
    'live.material_stock.underscore_is_literal',
    (v_ra ->> 'so_luong')::int = 1
      AND (v_ra -> 'vat_tu' -> 0 ->> 'ma') = 'CP-D-VT-4'
  );
  -- Dấu backslash cuối câu từng làm LIKE ném 22025. Giờ nó chỉ là không-khớp.
  BEGIN
    v_ra := public.copilot_material_stock_v1(v_org, 'abc\\', 20);
    INSERT INTO copilot_live_checks VALUES (
      'live.material_stock.trailing_backslash_no_22025', (v_ra ->> 'so_luong')::int = 0);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO copilot_live_checks VALUES ('live.material_stock.trailing_backslash_no_22025', false);
  END;

  -- Tổ chức sai vẫn phải trả 22023, không phải 42501: mã lỗi là thứ giao diện
  -- dùng để phân biệt "chọn nhầm công ty" với "không có quyền".
  BEGIN
    v_ra := public.copilot_material_stock_v1('00000000-0000-4000-8000-000000000000'::uuid, NULL, 20);
    INSERT INTO copilot_live_checks VALUES ('live.material_stock.bad_org_is_22023', false);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_ma = RETURNED_SQLSTATE;
    INSERT INTO copilot_live_checks VALUES ('live.material_stock.bad_org_is_22023', v_ma = '22023');
  END;

  -- A5. Cửa cờ, năm hướng.
  INSERT INTO copilot_live_checks VALUES
    ('live.flag.disabled_denies',
      app_private.copilot_page_flag_allows_v1('copilot.sensitive.salary', v_org) = false),
    ('live.flag.shadow_allows',
      app_private.copilot_page_flag_allows_v1('copilot.sensitive.shareholder-profit', v_org) = true),
    ('live.flag.enabled_allows',
      app_private.copilot_page_flag_allows_v1('copilot.sensitive.network', v_org) = true),
    ('live.flag.missing_row_denies',
      app_private.copilot_page_flag_allows_v1('copilot.khong.co.dong.nao', v_org) = false),
    ('live.flag.foreign_canary_denies',
      app_private.copilot_page_flag_allows_v1('probe.canary.khac', v_org) = false
        AND app_private.copilot_page_flag_allows_v1('probe.canary.dung', v_org) = true),
    ('live.flag.expired_denies',
      app_private.copilot_page_flag_allows_v1('probe.het.han', v_org) = false);

  -- Helper escape: ba ký tự, backslash trước.
  INSERT INTO copilot_live_checks VALUES
    ('live.like_escape.three_metacharacters',
      app_private.copilot_like_escape_v1('a%b_c\\d') = 'a\\%b\\_c\\\\d'
        AND app_private.copilot_like_escape_v1(NULL) = '');
END
$live$;
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
  const migrationSql = readFileSync(
    resolve(fileURLToPath(new URL("../", import.meta.url)), HARDENING_MIGRATION_PATH),
    "utf8",
  ).replace(/\r\n/gu, "\n");
  return `BEGIN;
SET LOCAL statement_timeout = '2min';
${buildFixtureSql()}
${buildLiveRpcProbeSql(migrationSql)}

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
      'income_expenses_building_id_fkey',
      'leads_building_id_fkey',
      'vehicles_building_id_fkey',
      'jobs_building_id_fkey',
      'meter_readings_building_id_fkey',
      'profit_monthly_building_id_fkey',
      'profit_allocations_profit_monthly_id_fkey',
      'profit_allocations_shareholder_id_fkey',
      'zalo_conversations_room_id_fkey',
      'profit_manager_allocations_profit_monthly_id_fkey',
      'profit_manager_allocations_manager_id_fkey'
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
lead_rows_org_wide AS (
  -- Join path of copilot_lead_search_v1 for an ORGANIZATION-wide reader: the row
  -- attached to a building in scope AND the row attached to no building at all.
  SELECT l.id
  FROM public.leads l
  LEFT JOIN public.buildings b
    ON b.id = l.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
  WHERE l.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND l.deleted_at IS NULL
    AND (b.id IS NOT NULL OR (l.building_id IS NULL AND true))
),
lead_rows_building_only AS (
  -- Same reader, but scoped to BUILDINGS: the unattached lead disappears, and
  -- that is the whole point of carrying org_wide into the predicate.
  SELECT l.id
  FROM public.leads l
  LEFT JOIN public.buildings b
    ON b.id = l.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
  WHERE l.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND l.deleted_at IS NULL
    AND (b.id IS NOT NULL OR (l.building_id IS NULL AND false))
),
lead_wrong_org AS (
  -- A LEFT JOIN on its own would let the other company's lead through as
  -- "b.id IS NULL". It must not: its building_id is NOT NULL.
  SELECT l.id
  FROM public.leads l
  LEFT JOIN public.buildings b
    ON b.id = l.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  WHERE l.organization_id = ${sqlLiteral(PROD_ORG_ID)}::uuid
    AND (b.id IS NOT NULL OR (l.building_id IS NULL AND true))
),
vehicle_rows AS (
  SELECT v.license_plate
  FROM public.vehicles v
  LEFT JOIN public.buildings b
    ON b.id = v.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
  WHERE v.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND v.deleted_at IS NULL
    AND (b.id IS NOT NULL OR (v.building_id IS NULL AND true))
    AND lower(coalesce(v.license_plate, '')) LIKE '%59p1-12345%'
),
job_open_rows AS (
  SELECT j.code
  FROM public.jobs j
  LEFT JOIN public.buildings b
    ON b.id = j.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
  WHERE j.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND (b.id IS NOT NULL OR (j.building_id IS NULL AND true))
    AND j.status = 'IN_PROGRESS'
),
meter_period_rows AS (
  -- One settlement month only. The June row of the same meter must not leak in,
  -- or every consumption total the model reports would be double-counted.
  SELECT mr.meter_type, mr.consumption
  FROM public.meter_readings mr
  LEFT JOIN public.buildings b
    ON b.id = mr.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
  WHERE mr.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND mr.deleted_at IS NULL
    AND mr.settlement_month = '2026-07'
    AND (b.id IS NOT NULL OR (mr.building_id IS NULL AND true))
),
material_rows AS (
  -- No building column at all: the company column IS the boundary.
  SELECT m.id, m.on_hand, m.reorder_level
  FROM public.materials m
  WHERE m.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND m.deleted_at IS NULL
),
vacant_room_rows AS (
  -- Join path of copilot_report_vacant_rooms_v1: a room is vacant when no ACTIVE
  -- contract points at it. The room WITH an active contract must not appear.
  SELECT rm.id, rm.name, ket.effective_end
  FROM public.rooms rm
  JOIN public.buildings b
    ON b.id = rm.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT max(COALESCE(ct.actual_end_date, ct.end_date)) AS effective_end
    FROM public.contracts ct
    WHERE ct.room_id = rm.id
      AND ct.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
      AND ct.deleted_at IS NULL
      AND ct.status IN ('TERMINATED', 'EXPIRED')
  ) ket ON true
  WHERE rm.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND rm.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.contracts ct2
      WHERE ct2.room_id = rm.id
        AND ct2.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
        AND ct2.deleted_at IS NULL
        AND ct2.status = 'ACTIVE'
    )
),
renewal_rows AS (
  -- Only APPROVED/COMPLETED extensions count; a DRAFT extension is not a renewal.
  SELECT ex.id
  FROM public.contract_extensions ex
  JOIN public.contracts ct
    ON ct.id = ex.contract_id
   AND ct.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND ct.deleted_at IS NULL
  JOIN public.rooms rm
    ON rm.id = ct.room_id
   AND rm.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  JOIN public.buildings b
    ON b.id = rm.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  WHERE ex.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND ex.status IN ('APPROVED', 'COMPLETED')
),
termination_denominator AS (
  -- Denominator of the termination rate, inside the SAME building scope as the
  -- numerator. The other company contract must never reach it.
  SELECT ct.id
  FROM public.contracts ct
  JOIN public.rooms rm
    ON rm.id = ct.room_id
   AND rm.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  JOIN public.buildings b
    ON b.id = rm.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  WHERE ct.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND ct.deleted_at IS NULL
    AND ct.status <> 'DRAFT'
),
payment_schedule_rows AS (
  SELECT i.invoice_number, i.due_date
  FROM public.invoices i
  JOIN public.buildings b
    ON b.id = i.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
  WHERE i.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND i.deleted_at IS NULL
    AND i.status <> 'CANCELLED'
    AND i.due_date IS NOT NULL
    AND i.due_date <= CURRENT_DATE + 30
    AND COALESCE(i.remaining_amount, i.total_amount - COALESCE(i.paid_amount, 0)) > 0
),
overpaid_rows AS (
  SELECT i.invoice_number
  FROM public.invoices i
  JOIN public.buildings b
    ON b.id = i.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  WHERE i.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND i.deleted_at IS NULL
    AND COALESCE(i.paid_amount, 0) > i.total_amount
),
deposit_rows_org_wide AS (
  -- Same shape as the lead probe: the deposit attached to a room in scope AND
  -- the deposit attached to no room at all.
  SELECT d.id
  FROM public.deposits d
  LEFT JOIN public.rooms rm
    ON rm.id = d.room_id
   AND rm.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  LEFT JOIN public.buildings b
    ON b.id = rm.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
  WHERE d.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND d.deleted_at IS NULL
    AND (b.id IS NOT NULL OR (d.room_id IS NULL AND true))
),
deposit_rows_building_only AS (
  SELECT d.id
  FROM public.deposits d
  LEFT JOIN public.rooms rm
    ON rm.id = d.room_id
   AND rm.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  LEFT JOIN public.buildings b
    ON b.id = rm.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
  WHERE d.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND d.deleted_at IS NULL
    AND (b.id IS NOT NULL OR (d.room_id IS NULL AND false))
),
cash_day_rows AS (
  -- Join path of copilot_report_daily_cashbook_v1 AFTER the fix: posting lines,
  -- POSTING + REVERSAL only, bounded by the cashbooks whose MONEY the caller may
  -- see. The visible set stands in for the two server helpers.
  SELECT
    p.posted_on AS ngay,
    COALESCE(sum(pl.signed_amount)  FILTER (WHERE pl.signed_amount > 0), 0) AS thu,
    COALESCE(sum(-pl.signed_amount) FILTER (WHERE pl.signed_amount < 0), 0) AS chi
  FROM public.income_expense_posting_lines pl
  JOIN public.income_expense_postings p
    ON p.id = pl.posting_id
   AND p.organization_id = pl.organization_id
  LEFT JOIN public.income_expenses ie
    ON ie.id = p.voucher_id
   AND ie.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  LEFT JOIN public.buildings b
    ON b.id = ie.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
  WHERE pl.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND p.event_kind IN ('POSTING', 'REVERSAL')
    AND p.posted_on BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE
    AND pl.account_id = ANY(ARRAY['ddac0000-0000-4000-8000-000000000011'::uuid])
    AND (b.id IS NOT NULL OR (ie.building_id IS NULL AND true))
    AND NOT COALESCE(ie.has_restricted_item, false)
  GROUP BY p.posted_on
),
cash_day_rows_restricted_ok AS (
  -- Same reader, but allowed to see restricted categories: the excluded voucher
  -- reappears. Two numbers that must differ, or the exclusion is not happening.
  SELECT COALESCE(sum(-pl.signed_amount) FILTER (WHERE pl.signed_amount < 0), 0) AS chi
  FROM public.income_expense_posting_lines pl
  JOIN public.income_expense_postings p
    ON p.id = pl.posting_id
   AND p.organization_id = pl.organization_id
  WHERE pl.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND p.event_kind IN ('POSTING', 'REVERSAL')
    AND p.posted_on BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE
    AND pl.account_id = ANY(ARRAY['ddac0000-0000-4000-8000-000000000011'::uuid])
),
cash_lines_seen AS (
  -- Every line the scoped query above could have touched, for the exclusion
  -- checks: an assertion that only looks at totals cannot tell "excluded" from
  -- "netted against something else".
  SELECT pl.signed_amount
  FROM public.income_expense_posting_lines pl
  JOIN public.income_expense_postings p
    ON p.id = pl.posting_id
   AND p.organization_id = pl.organization_id
  WHERE pl.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND p.event_kind IN ('POSTING', 'REVERSAL')
    AND pl.account_id = ANY(ARRAY['ddac0000-0000-4000-8000-000000000011'::uuid])
),
salary_own_by_staff AS (
  -- Own-row branch of copilot_salary_summary_v1, keyed the way the RPC keys it.
  SELECT sm.id
  FROM public.salary_monthly sm
  WHERE sm.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND sm.period_month = '2026-08-01'
    AND sm.staff_id = 'ddd10000-0000-4000-8000-000000000011'
),
salary_own_by_user AS (
  -- The same branch written the WRONG way round. Manager A owns both DEMO rows,
  -- so this returns the colleague's pay as well. Two different numbers, and only
  -- one of them is "your own row".
  SELECT sm.id
  FROM public.salary_monthly sm
  WHERE sm.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND sm.period_month = '2026-08-01'
    AND sm.user_id = 'ddd10000-0000-4000-8000-000000000011'
),
salary_org_wide AS (
  SELECT sm.id, pr.full_name
  FROM public.salary_monthly sm
  LEFT JOIN public.profiles pr ON pr.id = sm.staff_id
  WHERE sm.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND sm.period_month = '2026-08-01'
),
profit_rows AS (
  -- Join path of copilot_shareholder_profit_v1: profit_monthly -> buildings, with
  -- the building set standing in for the server-resolved scope.
  SELECT pm.id, pm.adjusted_profit
  FROM public.profit_monthly pm
  JOIN public.buildings b
    ON b.id = pm.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
   AND b.id = ANY(ARRAY['dddd1000-0000-4000-8000-000000000011'::uuid])
  WHERE pm.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND pm.period_month = '2026-07-01'
),
profit_allocation_rows AS (
  SELECT sh.name, sum(pa.amount) AS amount
  FROM public.profit_allocations pa
  JOIN profit_rows pr ON pr.id = pa.profit_monthly_id
  JOIN public.shareholders sh
    ON sh.id = pa.shareholder_id
   AND sh.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND sh.deleted_at IS NULL
  WHERE pa.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  GROUP BY sh.name
),
profit_alloc_rows_shareholder AS (
  -- The NON-management branch: shareholder ddd3…011 asking for the same month.
  -- 'v_quan_ly' is false, so the allocation list carries
  -- 'pa.shareholder_id = v_co_dong_id' — the co-owner must not appear.
  SELECT sh.name, pa.amount
  FROM public.profit_allocations pa
  JOIN profit_rows pr ON pr.id = pa.profit_monthly_id
  JOIN public.shareholders sh
    ON sh.id = pa.shareholder_id
   AND sh.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND sh.deleted_at IS NULL
  WHERE pa.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND pa.shareholder_id = 'ddd30000-0000-4000-8000-000000000011'
),
profit_months_shareholder AS (
  -- Months a plain shareholder may be shown: mirrors profit_monthly_self_select
  -- (and its profit-manager twin). The 2026-08 month has no allocation of theirs
  -- and must fall out — including out of the DEFAULT-period choice.
  SELECT pm.id, pm.period_month
  FROM public.profit_monthly pm
  JOIN public.buildings b
    ON b.id = pm.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
   AND b.id = ANY(ARRAY['dddd1000-0000-4000-8000-000000000011'::uuid])
  WHERE pm.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND (
      EXISTS (
        SELECT 1
        FROM public.profit_allocations pa1
        WHERE pa1.profit_monthly_id = pm.id
          AND pa1.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
          AND pa1.shareholder_id = 'ddd30000-0000-4000-8000-000000000011'
      )
      OR EXISTS (
        SELECT 1
        FROM public.profit_manager_allocations pma1
        WHERE pma1.profit_monthly_id = pm.id
          AND pma1.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
          AND pma1.manager_id = NULL::uuid
      )
    )
),
zalo_rows_org_wide AS (
  -- Join path of copilot_zalo_conversations_v1 for an ORGANIZATION-wide reader:
  -- the conversation attached to a room in scope AND the one attached to no room.
  -- The conversation whose room belongs to the OTHER company must fall out.
  SELECT c.id
  FROM public.zalo_conversations c
  LEFT JOIN public.rooms rm
    ON rm.id = c.room_id
   AND rm.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND rm.deleted_at IS NULL
  LEFT JOIN public.buildings b
    ON b.id = rm.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
   AND b.id = ANY(ARRAY['dddd1000-0000-4000-8000-000000000011'::uuid])
  WHERE c.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND (b.id IS NOT NULL OR (c.room_id IS NULL AND true))
),
zalo_rows_building_only AS (
  -- The same reader WITHOUT an organization-wide grant: the conversation with no
  -- room disappears, because nobody granted them the company.
  SELECT c.id
  FROM public.zalo_conversations c
  LEFT JOIN public.rooms rm
    ON rm.id = c.room_id
   AND rm.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND rm.deleted_at IS NULL
  LEFT JOIN public.buildings b
    ON b.id = rm.building_id
   AND b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND b.deleted_at IS NULL
   AND b.id = ANY(ARRAY['dddd1000-0000-4000-8000-000000000011'::uuid])
  WHERE c.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND (b.id IS NOT NULL OR (c.room_id IS NULL AND false))
),
network_rows AS (
  -- Join path of copilot_network_status_v1: buildings -> MIKROTIK router ->
  -- current sample, with the open-incident and active-client counts alongside.
  SELECT
    b.id AS building_id,
    rt.display_name AS router_name,
    cur.reachable,
    cur.health_status,
    (SELECT count(*)
       FROM public.network_incidents ni
      WHERE ni.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
        AND ni.building_id = b.id
        AND ni.status <> 'RESOLVED') AS open_incidents,
    (SELECT count(*)
       FROM public.network_client_current nc
      WHERE nc.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
        AND nc.building_id = b.id
        AND nc.expires_at > statement_timestamp()) AS active_clients
  FROM public.buildings b
  LEFT JOIN public.network_devices rt
    ON rt.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
   AND rt.building_id = b.id
   AND rt.device_kind = 'MIKROTIK'
   AND rt.is_active
  LEFT JOIN public.network_device_current cur
    ON cur.device_id = rt.id
   AND cur.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  WHERE b.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
    AND b.deleted_at IS NULL
    AND b.is_virtual = false
    AND b.id = ANY(ARRAY['dddd1000-0000-4000-8000-000000000011'::uuid])
),
checks AS (
  SELECT 'customers.positive'::text AS case_id, (SELECT count(*) = 1 FROM customer_rows) AS passed
  UNION ALL SELECT 'customers.empty', (SELECT count(*) = 0 FROM customer_empty)
  UNION ALL SELECT 'contracts.positive', (SELECT count(*) = 1 AND max(full_name) = 'Copilot Demo Customer' FROM contract_rows)
  UNION ALL SELECT 'contracts.empty', (SELECT count(*) = 0 FROM contract_empty)
  UNION ALL SELECT 'schema.fk_names', (SELECT count(*) = 16 FROM fk_names)
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
  UNION ALL SELECT 'leads.null_building_needs_org_wide',
    ((SELECT count(*) FROM lead_rows_org_wide) = 2
      AND (SELECT count(*) FROM lead_rows_building_only) = 1)
  UNION ALL SELECT 'leads.wrong_org_excluded', (SELECT count(*) = 0 FROM lead_wrong_org)
  UNION ALL SELECT 'vehicles.positive', (SELECT count(*) = 1 AND max(license_plate) = '59P1-12345' FROM vehicle_rows)
  UNION ALL SELECT 'tasks.open_positive', (SELECT count(*) = 1 AND max(code) = 'CP-D-JOB-1' FROM job_open_rows)
  UNION ALL SELECT 'meter_readings.period_scoped',
    ((SELECT count(*) FROM meter_period_rows) = 2
      AND (SELECT COALESCE(sum(consumption), 0) FROM meter_period_rows WHERE meter_type = 'ELECTRICITY') = 75)
  -- Bốn: hai món gốc, cộng hai món mang ký tự đại diện của LIKE mà nửa THỰC
  -- THI dùng làm chủ thể cho phép đo escape.
  UNION ALL SELECT 'materials.positive', (SELECT count(*) = 4 FROM material_rows)
  UNION ALL SELECT 'materials.below_reorder', (SELECT count(*) = 1 FROM material_rows WHERE on_hand < reorder_level)
  UNION ALL SELECT 'materials.wrong_org_excluded',
    (NOT EXISTS (SELECT 1 FROM material_rows m WHERE m.id = 'aaaab000-0000-4000-8000-000000000011'))
  UNION ALL SELECT 'vacant_rooms.occupied_excluded',
    ((SELECT count(*) FROM vacant_room_rows) = 1
      AND (SELECT max(name) FROM vacant_room_rows) = 'CP-D-102')
  UNION ALL SELECT 'vacant_rooms.days_vacant_from_last_ended_contract',
    ((SELECT max(effective_end) FROM vacant_room_rows) = CURRENT_DATE - 30)
  UNION ALL SELECT 'renewals.draft_extension_excluded', (SELECT count(*) = 1 FROM renewal_rows)
  UNION ALL SELECT 'terminations.denominator_scoped_to_same_buildings',
    ((SELECT count(*) FROM termination_denominator) = 2
      AND NOT EXISTS (SELECT 1 FROM termination_denominator t
                      WHERE t.id = 'aaaa4000-0000-4000-8000-000000000011'))
  UNION ALL SELECT 'payment_schedule.overdue_and_upcoming_split',
    ((SELECT count(*) FROM payment_schedule_rows) = 2
      AND (SELECT count(*) FROM payment_schedule_rows WHERE due_date < CURRENT_DATE) = 1
      AND NOT EXISTS (SELECT 1 FROM payment_schedule_rows p
                      WHERE p.invoice_number = 'CP-PROD-INV-UPCOMING'))
  UNION ALL SELECT 'payment_schedule.settled_invoice_excluded',
    (NOT EXISTS (SELECT 1 FROM payment_schedule_rows p
                 WHERE p.invoice_number = 'CP-DEMO-INV-OVERPAID'))
  UNION ALL SELECT 'overpayment.positive',
    ((SELECT count(*) FROM overpaid_rows) = 1
      AND (SELECT max(invoice_number) FROM overpaid_rows) = 'CP-DEMO-INV-OVERPAID')
  UNION ALL SELECT 'deposits.null_room_needs_org_wide',
    ((SELECT count(*) FROM deposit_rows_org_wide) = 2
      AND (SELECT count(*) FROM deposit_rows_building_only) = 1)
  UNION ALL SELECT 'cash_flow.posting_truth_counts_the_reversal',
    ((SELECT count(*) FROM cash_day_rows) = 1
      AND (SELECT max(thu) FROM cash_day_rows) = 5000000
      AND (SELECT max(chi) FROM cash_day_rows) = 6200000)
  UNION ALL SELECT 'cash_flow.invisible_cashbook_and_other_org_excluded',
    (NOT EXISTS (SELECT 1 FROM cash_lines_seen l WHERE l.signed_amount IN (9000000, 3300000)))
  UNION ALL SELECT 'cash_flow.non_posting_event_excluded',
    (NOT EXISTS (SELECT 1 FROM cash_lines_seen l WHERE l.signed_amount = 7000000))
  UNION ALL SELECT 'cash_flow.restricted_voucher_excluded_from_day_total',
    ((SELECT max(chi) FROM cash_day_rows) = 6200000
      AND (SELECT chi FROM cash_day_rows_restricted_ok) = 16100000)
  UNION ALL SELECT 'salary.own_row_is_staff_id_not_user_id',
    ((SELECT count(*) FROM salary_own_by_staff) = 1
      AND (SELECT count(*) FROM salary_own_by_user) = 2
      AND (SELECT max(id::text) FROM salary_own_by_staff) = 'ddd20000-0000-4000-8000-000000000011')
  UNION ALL SELECT 'salary.org_wide_sees_colleagues_and_not_other_org',
    ((SELECT count(*) FROM salary_org_wide) = 2
      AND (SELECT count(*) FROM salary_org_wide WHERE full_name IS NULL) = 0
      AND NOT EXISTS (SELECT 1 FROM salary_org_wide s WHERE s.id = 'aaa20000-0000-4000-8000-000000000011'))
  UNION ALL SELECT 'shareholder_profit.building_scoped',
    ((SELECT count(*) FROM profit_rows) = 1
      AND (SELECT max(adjusted_profit) FROM profit_rows) = 39000000
      AND NOT EXISTS (SELECT 1 FROM profit_rows p WHERE p.id = 'aaa40000-0000-4000-8000-000000000011'))
  UNION ALL SELECT 'shareholder_profit.plain_shareholder_sees_only_own_payout',
    ((SELECT count(*) FROM profit_alloc_rows_shareholder) = 1
      AND (SELECT max(amount) FROM profit_alloc_rows_shareholder) = 27300000
      AND NOT EXISTS (SELECT 1 FROM profit_alloc_rows_shareholder a
                      WHERE a.name = 'Copilot Demo Co-Shareholder'))
  UNION ALL SELECT 'shareholder_profit.plain_shareholder_month_set_and_default',
    ((SELECT count(*) FROM profit_months_shareholder) = 1
      AND (SELECT max(period_month) FROM profit_months_shareholder) = DATE '2026-07-01'
      AND (SELECT max(pm.period_month) FROM public.profit_monthly pm
            WHERE pm.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid) = DATE '2026-08-01')
  UNION ALL SELECT 'shareholder_profit.allocations_follow_the_scoped_months',
    ((SELECT count(*) FROM profit_allocation_rows) = 2
      AND (SELECT sum(amount) FROM profit_allocation_rows) = 39000000
      AND NOT EXISTS (SELECT 1 FROM profit_allocation_rows a WHERE a.name = 'Copilot Production Shareholder'))
  UNION ALL SELECT 'zalo.null_room_needs_org_wide',
    ((SELECT count(*) FROM zalo_rows_org_wide) = 2
      AND (SELECT count(*) FROM zalo_rows_building_only) = 1)
  UNION ALL SELECT 'zalo.foreign_room_is_not_treated_as_no_room',
    (NOT EXISTS (SELECT 1 FROM zalo_rows_org_wide z WHERE z.id = 'ddd60000-0000-4000-8000-000000000013')
      AND NOT EXISTS (SELECT 1 FROM zalo_rows_org_wide z WHERE z.id = 'aaa60000-0000-4000-8000-000000000011'))
  UNION ALL SELECT 'network.router_is_the_mikrotik_not_any_device',
    ((SELECT count(*) FROM network_rows) = 1
      AND (SELECT max(router_name) FROM network_rows) = 'CP-D-RB-1'
      AND (SELECT bool_and(NOT reachable) FROM network_rows)
      AND (SELECT max(health_status) FROM network_rows) = 'OFFLINE')
  UNION ALL SELECT 'network.open_incidents_exclude_resolved_and_other_org',
    ((SELECT max(open_incidents) FROM network_rows) = 1)
  UNION ALL SELECT 'network.active_clients_exclude_expired_and_other_org',
    ((SELECT max(active_clients) FROM network_rows) = 2)
  -- Nửa THỰC THI: mười ba dòng dưới đây do chính thân hàm của migration sinh ra,
  -- không phải do câu SQL chép tay ở trên. Xem buildLiveRpcProbeSql().
  UNION ALL SELECT case_id, passed FROM copilot_live_checks
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
    Number(verdict.assertion_count) !== 57 ||
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
