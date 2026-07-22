// Shared, money-safe live-DB helpers for the invoice.collection.v5 test harness.
//
// The three sibling scripts
//   - scripts/test-invoice-collection-v5.mjs           (single session, BEGIN/ROLLBACK)
//   - scripts/test-invoice-collection-v5-concurrency.mjs (two committed connections)
//   - scripts/test-invoice-collection-v5-rollback.mjs   (freeze/re-enable rehearsal)
// all import from here so the DEMO-only fixture, flag prelude, assertion
// invariants and reversal-first teardown stay identical across scenarios.
//
// Reuse contract (per rollout convention):
//   - loadSupabaseAdminConfig / executeManagementQuery from apply-accounting-rollout.mjs
//   - only ever WRITE org DEMO 'dddd0000-…0001'; real org is read-only
//   - every statement block SET LOCAL lock_timeout + statement_timeout
//   - executeManagementQuery already redacts the PAT from any error text
//   - callers exit(1) on any failed invariant or skipped required scenario
import {
  loadSupabaseAdminConfig,
  executeManagementQuery,
} from "../apply-accounting-rollout.mjs";

export const DEMO_ORG_ID = "dddd0000-0000-4000-8000-000000000001";
export const REAL_ORG_ID = "aaaa0000-0000-4000-8000-000000000001";
export const DEMO_OWNER_EMAIL = "demo.chunha@username.ihomecrm.local";

export const COLLECTION_KEY = "invoice.collection.v5";
export const REVERSE_KEY = "invoice.collection.reverse.v5";
export const CREDIT_APPLY_KEY = "customer.credit.apply.v1";

// Short, defensive timeouts: these harnesses only ever touch a single DEMO
// invoice, so a long wait means a real lock pathology rather than load.
export const TEST_LOCK_TIMEOUT = "10s";
export const TEST_STATEMENT_TIMEOUT = "2min";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let cachedConfig = null;

/** Load + memoize the Supabase admin config (PAT + project ref). */
export function getConfig() {
  if (!cachedConfig) cachedConfig = loadSupabaseAdminConfig();
  return cachedConfig;
}

/** Run one Management API query and parse the JSON row array it returns. */
export async function runQuery(query, config = getConfig()) {
  const body = await executeManagementQuery(query, config);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(
      `Management API trả JSON không hợp lệ: ${String(body).slice(0, 500)}`,
    );
  }
}

/** Print a redaction-safe failure and exit non-zero (invariant/skip gate). */
export function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

export function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function uuidLiteral(value) {
  if (!UUID_RE.test(String(value))) {
    throw new Error(`UUID không hợp lệ: ${value}`);
  }
  return `${sqlLiteral(value)}::uuid`;
}

/** Embed an arbitrary JS value as a jsonb literal. */
export function jsonbLiteral(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

export function numberOf(value) {
  return Number(value) || 0;
}

/** Deterministic, ASCII-safe idempotency key (8-200 chars per the RPC guard). */
export function idempotencyKey(prefix, run) {
  const safePrefix = String(prefix).replace(/[^A-Za-z0-9._:-]/g, "-");
  return `${safePrefix}-${run}`.slice(0, 200);
}

/** A short, unique run id used for markers + idempotency keys within one run. */
export function newRunId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/** The DEMO fixture marker embedded in invoice.notes so teardown is scoped. */
export function fixtureMarker(runId) {
  return `[E2E-V5-HARNESS:${runId}]`;
}

/**
 * JWT claims for a DEMO actor, matching the shape the accounting chain test
 * uses so auth.uid() and RLS resolve the acting owner.
 */
export function actorClaimsJson(actorId) {
  return JSON.stringify({
    sub: actorId,
    role: "authenticated",
    email: "v5-collection-harness@example.test",
    user_metadata: { full_name: "V5 Collection Harness" },
  });
}

/**
 * SQL prelude (run inside an open transaction, still as postgres) that forces
 * both collection routes to CANONICAL *for DEMO only* by enrolling DEMO while
 * SHADOW (no activation assert) and then flipping to CANARY. Credit-apply is
 * pinned SHADOW so the CREDIT overpay path stays fail-closed. Everything here
 * is rolled back by the caller — it never persists a flag change.
 */
export function forceDemoCanaryPreludeSql({ creditMode = "SHADOW" } = {}) {
  const org = uuidLiteral(DEMO_ORG_ID);
  return `
-- 1) Attestation + caps, enroll DEMO while SHADOW so the enrollment trigger
--    skips assert_accounting_feature_activation_v1, then flip to CANARY.
UPDATE app_private.server_feature_flags
   SET mode = 'SHADOW',
       force_freeze = false,
       config_version = config_version + 100000,
       starts_at = clock_timestamp() - interval '1 hour',
       ends_at = clock_timestamp() + interval '1 day',
       max_operation_count = 1000,
       max_single_amount_vnd = 1000000000,
       max_total_amount_vnd = 100000000000,
       commit_sha = repeat('a', 40),
       migration_sha256 = repeat('a', 64),
       maintenance_window_id = 'v5-harness',
       approval_reference = 'v5-harness',
       updated_at = clock_timestamp()
 WHERE feature_key IN (${sqlLiteral(COLLECTION_KEY)}, ${sqlLiteral(REVERSE_KEY)});

INSERT INTO app_private.server_feature_flag_canary_orgs (
  feature_key, organization_id, added_by
)
SELECT feature_key, ${org},
       (SELECT id FROM auth.users WHERE email = ${sqlLiteral(DEMO_OWNER_EMAIL)})
FROM (VALUES (${sqlLiteral(COLLECTION_KEY)}), (${sqlLiteral(REVERSE_KEY)}))
  AS f(feature_key)
ON CONFLICT (feature_key, organization_id) DO NOTHING;

UPDATE app_private.server_feature_flags
   SET mode = 'CANARY', updated_at = clock_timestamp()
 WHERE feature_key IN (${sqlLiteral(COLLECTION_KEY)}, ${sqlLiteral(REVERSE_KEY)});

-- 2) Keep customer credit fail-closed for the CREDIT-rejection scenario.
UPDATE app_private.server_feature_flags
   SET mode = ${sqlLiteral(creditMode)}, force_freeze = false,
       updated_at = clock_timestamp()
 WHERE feature_key = ${sqlLiteral(CREDIT_APPLY_KEY)};

DO $prelude_check$
DECLARE
  v_collection text := app_private.evaluate_feature_route(${sqlLiteral(COLLECTION_KEY)}, ${org});
  v_reverse text := app_private.evaluate_feature_route(${sqlLiteral(REVERSE_KEY)}, ${org});
BEGIN
  IF v_collection <> 'CANONICAL' OR v_reverse <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Prelude không bật được canary DEMO: collection=%, reverse=%',
      v_collection, v_reverse;
  END IF;
END
$prelude_check$;
`;
}

/**
 * SQL (run inside the open transaction as postgres) that resolves the DEMO
 * actor + an eligible ACTIVE contract with a real receiving account, a second
 * real account (multi-tender) and a virtual account (change/rounding), then
 * inserts a fresh APPROVED fixture invoice (REVENUE + DEPOSIT items) attached
 * to that contract. All ids are stashed in transaction-local GUCs under the
 * `v5h.*` namespace for the assertion blocks to read via current_setting().
 *
 * @param billingMonth 'YYYY-MM' unique far-future month to avoid collisions.
 */
export function fixtureInvoiceSql({ marker, billingMonth, rent, deposit }) {
  const org = uuidLiteral(DEMO_ORG_ID);
  const total = rent + deposit;
  return `
DO $v5h_fixture$
DECLARE
  v_org constant uuid := ${org};
  v_actor uuid;
  v_contract uuid;
  v_owner uuid;
  v_building uuid;
  v_room uuid;
  v_account_tm uuid;
  v_account_tk uuid;
  v_virtual_account uuid;
  v_cross_org_account uuid;
  v_invoice uuid;
BEGIN
  SELECT id INTO v_actor FROM auth.users WHERE email = ${sqlLiteral(DEMO_OWNER_EMAIL)};
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy DEMO owner % để chạy harness', ${sqlLiteral(DEMO_OWNER_EMAIL)};
  END IF;

  SELECT contract_row.id, contract_row.user_id, room_row.building_id, contract_row.room_id
    INTO v_contract, v_owner, v_building, v_room
  FROM public.contracts contract_row
  JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  JOIN public.buildings building_row ON building_row.id = room_row.building_id
  WHERE contract_row.organization_id = v_org
    AND contract_row.deleted_at IS NULL
    AND contract_row.status = 'ACTIVE'
    AND room_row.deleted_at IS NULL
    AND building_row.deleted_at IS NULL
    AND NOT building_row.is_virtual
    AND COALESCE((
      SELECT allowed FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', building_row.id, NULL
      )
    ), false)
    AND NOT EXISTS (
      SELECT 1 FROM public.invoices invoice_row
      WHERE invoice_row.contract_id = contract_row.id
        AND invoice_row.billing_month = ${sqlLiteral(billingMonth)}
        AND invoice_row.deleted_at IS NULL
    )
  ORDER BY contract_row.id
  LIMIT 1;

  IF v_contract IS NULL THEN
    RAISE EXCEPTION 'Không có hợp đồng DEMO đủ điều kiện + quyền thu tiền cho harness';
  END IF;

  SELECT account_row.id INTO v_account_tm
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
    AND COALESCE((
      SELECT allowed FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_building, account_row.id
      )
    ), false)
  ORDER BY account_row.is_default DESC, account_row.id
  LIMIT 1;

  SELECT account_row.id INTO v_account_tk
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual AND account_row.id <> v_account_tm
    AND COALESCE((
      SELECT allowed FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_building, account_row.id
      )
    ), false)
  ORDER BY account_row.is_default DESC, account_row.id
  LIMIT 1;
  -- Multi-tender can legally reuse one real account when only one exists.
  v_account_tk := COALESCE(v_account_tk, v_account_tm);

  SELECT account_row.id INTO v_virtual_account
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org AND account_row.deleted_at IS NULL
    AND account_row.is_virtual
  ORDER BY account_row.id
  LIMIT 1;

  SELECT account_row.id INTO v_cross_org_account
  FROM public.accounts account_row
  WHERE account_row.organization_id <> v_org AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
  ORDER BY account_row.organization_id, account_row.id
  LIMIT 1;

  IF v_account_tm IS NULL OR v_virtual_account IS NULL THEN
    RAISE EXCEPTION 'DEMO thiếu sổ quỹ thật/ảo cho harness';
  END IF;

  INSERT INTO public.invoices (
    organization_id, user_id, contract_id, building_id, room_id, kind,
    billing_month, issue_date, due_date, status, subtotal, total_amount, notes
  ) VALUES (
    v_org, v_owner, v_contract, v_building, v_room, 'MONTHLY',
    ${sqlLiteral(billingMonth)}, ${sqlLiteral(`${billingMonth}-01`)},
    ${sqlLiteral(`${billingMonth}-10`)}, 'APPROVED',
    ${total}, ${total}, ${sqlLiteral(marker)}
  ) RETURNING id INTO v_invoice;

  INSERT INTO public.invoice_items (
    invoice_id, accounting_class, type, description,
    unit_price, quantity, coefficient, amount, sort_order
  ) VALUES
    (v_invoice, 'REVENUE', 'RENT', 'Harness revenue', ${rent}, 1, 1, ${rent}, 1),
    (v_invoice, 'DEPOSIT', 'OTHER', 'Harness deposit', ${deposit}, 1, 1, ${deposit}, 2);

  PERFORM public.recompute_invoice_for_id(v_invoice);

  PERFORM set_config('v5h.actor', v_actor::text, true);
  PERFORM set_config('v5h.contract', v_contract::text, true);
  PERFORM set_config('v5h.building', v_building::text, true);
  PERFORM set_config('v5h.room', v_room::text, true);
  PERFORM set_config('v5h.invoice', v_invoice::text, true);
  PERFORM set_config('v5h.account_tm', v_account_tm::text, true);
  PERFORM set_config('v5h.account_tk', v_account_tk::text, true);
  PERFORM set_config('v5h.virtual_account', v_virtual_account::text, true);
  PERFORM set_config('v5h.cross_org_account',
    COALESCE(v_cross_org_account::text, ''), true);
END
$v5h_fixture$;
`;
}

/**
 * SQL prelude that promotes the current session to the resolved DEMO actor.
 * Must run AFTER fixtureInvoiceSql (which stashes v5h.actor) and inside the
 * same transaction, right before any public.record/reverse RPC call.
 */
export function actAsFixtureActorSql() {
  return `
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', current_setting('v5h.actor'),
    'role', 'authenticated',
    'email', 'v5-collection-harness@example.test',
    'user_metadata', jsonb_build_object('full_name', 'V5 Collection Harness')
  )::text,
  true
);
SET LOCAL ROLE authenticated;
`;
}

/**
 * Reversal-first, marker-scoped teardown of a committed DEMO fixture invoice.
 * Money effects are unwound by reverse_invoice_collection_v5 BEFORE any row is
 * removed; only the now-neutralised fixture scaffolding (invoice + its own
 * collections/tenders/allocations/payments/vouchers/items) is then deleted,
 * scoped strictly by the fixture marker. The pre-existing contract is left
 * untouched. Refuses to run on a non-fixture marker or the real org.
 */
export function committedFixtureTeardownSql({ marker, actorId }) {
  const org = uuidLiteral(DEMO_ORG_ID);
  // Marker-strict scope helpers. Reversal vouchers carry invoice_id = NULL and
  // link only via payment_collection_id, so the voucher scope is BOTH the
  // fixture invoice and its collections; payments always carry invoice_id.
  const invSel = `SELECT id FROM public.invoices
      WHERE organization_id = ${org} AND notes = ${sqlLiteral(marker)}`;
  const collSel = `SELECT collection.id FROM public.invoice_payment_collections collection
      WHERE collection.invoice_id IN (${invSel})`;
  const vchSel = `SELECT voucher.id FROM public.income_expenses voucher
      WHERE voucher.invoice_id IN (${invSel})
         OR voucher.payment_collection_id IN (${collSel})`;
  const paySel = `SELECT payment.id FROM public.payments payment
      WHERE payment.invoice_id IN (${invSel})`;
  return `
BEGIN;
SET LOCAL lock_timeout = ${sqlLiteral(TEST_LOCK_TIMEOUT)};
SET LOCAL statement_timeout = ${sqlLiteral(TEST_STATEMENT_TIMEOUT)};

DO $v5h_teardown$
DECLARE
  v_org constant uuid := ${org};
  v_actor constant uuid := ${uuidLiteral(actorId)};
  v_marker constant text := ${sqlLiteral(marker)};
  v_invoice uuid;
  v_collection record;
BEGIN
  IF v_marker NOT LIKE '[E2E-V5-HARNESS:%' THEN
    RAISE EXCEPTION 'Từ chối teardown: marker % không thuộc harness', v_marker;
  END IF;

  SELECT invoice_row.id INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.organization_id = v_org
    AND invoice_row.notes = v_marker;
  IF v_invoice IS NULL THEN
    RETURN; -- nothing committed / already cleaned
  END IF;

  -- Promote to the DEMO actor so reverse_invoice_collection_v5 authorizes.
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_actor, 'role', 'authenticated',
    'email', 'v5-collection-harness@example.test'
  )::text, true);

  -- Reverse newest-first (LIFO) so money is unwound, not hard-deleted. The
  -- reverse RPC forbids a reversal date earlier than the collection date, and
  -- fixtures are dated far in the future (2094), so reverse on the later of the
  -- collection date and today rather than an unconditional "today".
  FOR v_collection IN
    SELECT collection.id AS id, collection.collection_date AS collection_date
    FROM public.invoice_payment_collections collection
    WHERE collection.invoice_id = v_invoice
      AND collection.status = 'ACTIVE'
    ORDER BY collection.created_at DESC, collection.id DESC
  LOOP
    PERFORM public.reverse_invoice_collection_v5(
      v_collection.id,
      GREATEST(v_collection.collection_date, public.vn_local_date(clock_timestamp())),
      'Harness teardown reversal',
      'v5h-teardown-' || replace(v_collection.id::text, '-', '')
    );
  END LOOP;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
END
$v5h_teardown$;

-- Remove the neutralised fixture scaffolding (privileged). The money effects
-- were already unwound by the reversal loop above via the sanctioned reverse
-- RPC; what remains is inert, marker-scoped fixture scaffolding. Two layers of
-- guard sit in the way of removing the canonical rows:
--   1) Lifecycle-freeze guards on income_expenses/items are ENABLE-ORIGIN, so
--      session_replication_role = replica (SET LOCAL, connection-scoped and
--      auto-reverting at COMMIT) suspends them and the FK RI triggers, letting
--      the fixture subtree be deleted in any order.
--   2) The flow-ownership ledger tables carry ENABLE-ALWAYS immutability
--      triggers that fire even under replica; a fixture voucher cannot be
--      removed while its ownership row (a RESTRICT FK back to the voucher)
--      survives, so those two guards are disabled for the delete and restored
--      ENABLE ALWAYS immediately afterwards.
-- The append-only canonical_write_operations ledger is intentionally left in
-- place: it has no FK to the fixture and is keyed by the (fresh) invoice /
-- collection id, so old rows are inert and never collide with a later run.
SET LOCAL session_replication_role = replica;

DO $v5h_guard_off$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid = 'app_private.income_expense_flow_ownership'::regclass
               AND tgname = 'a00_flow_ownership_immutable' AND NOT tgisinternal) THEN
    ALTER TABLE app_private.income_expense_flow_ownership
      DISABLE TRIGGER a00_flow_ownership_immutable;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid = 'app_private.income_expense_flow_ownership_events'::regclass
               AND tgname = 'a00_flow_events_immutable' AND NOT tgisinternal) THEN
    ALTER TABLE app_private.income_expense_flow_ownership_events
      DISABLE TRIGGER a00_flow_events_immutable;
  END IF;
END
$v5h_guard_off$;

-- Canonical flow ownership + its append-only event log first (RESTRICT FK back
-- to the vouchers deleted below).
DELETE FROM app_private.income_expense_flow_ownership_events e
WHERE e.income_expense_id IN (${vchSel});

DELETE FROM app_private.income_expense_flow_ownership o
WHERE o.income_expense_id IN (${vchSel});

-- Reversal bookkeeping for the fixture payments.
DELETE FROM app_private.payment_reversals pr
WHERE pr.original_payment_id IN (${paySel});

DELETE FROM public.invoice_payment_allocations allocation
WHERE allocation.collection_id IN (${collSel});

DELETE FROM public.income_expense_items item
WHERE item.income_expense_id IN (${vchSel});

DELETE FROM public.invoice_payment_tenders tender
WHERE tender.collection_id IN (${collSel});

-- Customer-credit artefacts (only present when a fixture kept CREDIT).
DELETE FROM public.excess_amounts x
WHERE x.source_invoice_id IN (${invSel})
   OR x.credit_lot_id IN (
     SELECT lot.id FROM public.customer_credit_lots lot
     WHERE lot.source_collection_id IN (${collSel}));

DELETE FROM public.customer_credit_lots lot
WHERE lot.source_collection_id IN (${collSel});

-- Vouchers (both the invoice-scoped collection vouchers and the reversal
-- vouchers, which carry invoice_id = NULL and link only by collection).
DELETE FROM public.income_expenses voucher
WHERE voucher.invoice_id IN (${invSel})
   OR voucher.payment_collection_id IN (${collSel});

DELETE FROM public.payments payment
WHERE payment.invoice_id IN (${invSel});

DELETE FROM public.invoice_payment_collections collection
WHERE collection.invoice_id IN (${invSel});

DELETE FROM public.invoice_items item
WHERE item.invoice_id IN (${invSel});

DELETE FROM public.invoices invoice_row
WHERE invoice_row.organization_id = ${org} AND invoice_row.notes = ${sqlLiteral(marker)};

-- Restore the ENABLE-ALWAYS immutability guards to their prior state.
DO $v5h_guard_on$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid = 'app_private.income_expense_flow_ownership'::regclass
               AND tgname = 'a00_flow_ownership_immutable' AND NOT tgisinternal) THEN
    ALTER TABLE app_private.income_expense_flow_ownership
      ENABLE ALWAYS TRIGGER a00_flow_ownership_immutable;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid = 'app_private.income_expense_flow_ownership_events'::regclass
               AND tgname = 'a00_flow_events_immutable' AND NOT tgisinternal) THEN
    ALTER TABLE app_private.income_expense_flow_ownership_events
      ENABLE ALWAYS TRIGGER a00_flow_events_immutable;
  END IF;
END
$v5h_guard_on$;

DO $v5h_verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.invoices
    WHERE organization_id = ${org} AND notes = ${sqlLiteral(marker)}
  ) THEN
    RAISE EXCEPTION 'Teardown harness còn sót fixture marker %', ${sqlLiteral(marker)};
  END IF;
END
$v5h_verify$;

COMMIT;
`;
}

/**
 * Assert the per-collection money invariants (PL §B2) against a record RPC
 * response object. Throws on any violation.
 */
export function assertRecordMoneyInvariants(response, label) {
  const gross = numberOf(response.gross_amount);
  const applied = numberOf(response.applied_amount);
  const change = numberOf(response.change_amount);
  const credit = numberOf(response.credit_amount);
  const rounding = numberOf(response.rounding_amount);

  for (const [name, value] of Object.entries({
    gross,
    applied,
    change,
    credit,
    rounding,
  })) {
    if (!Number.isFinite(value)) throw new Error(`${label}: ${name} không hữu hạn`);
    if (value < 0) throw new Error(`${label}: ${name} âm (${value})`);
    if (Math.round(value * 100) !== value * 100) {
      throw new Error(`${label}: ${name} vượt 2 chữ số thập phân (${value})`);
    }
  }
  // gross = retained + change; retained = applied + credit
  if (Math.abs(gross - (applied + change + credit)) >= 0.01) {
    throw new Error(
      `${label}: gross(${gross}) != applied(${applied}) + change(${change}) + credit(${credit})`,
    );
  }
  if (applied <= 0) throw new Error(`${label}: applied phải > 0`);
}
