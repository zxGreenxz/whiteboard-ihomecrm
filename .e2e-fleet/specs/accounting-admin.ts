import { readFileSync } from 'node:fs';

const DEMO_ORG_ID = 'dddd0000-0000-4000-8000-000000000001';
const DEMO_OWNER_EMAIL = 'demo.chunha@username.ihomecrm.local';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AdminConfig {
  pat: string;
  projectRef: string;
}

interface FeatureState {
  feature_key: string;
  mode: string;
  route: string;
  config_version: number | string;
  max_operation_count: number | string;
  max_single_amount_vnd: number | string;
  max_total_amount_vnd: number | string;
  used_count: number | string;
  used_amount: number | string;
}

interface RawPreflightRow {
  schema_ready: boolean;
  actor_id: string | null;
  flags: FeatureState[] | null;
  fixture: {
    building_id: string;
    building_name: string;
    room_id: string;
    room_name: string;
    customer_id: string;
    customer_name: string;
    customer_phone: string;
    receiving_account_id: string;
    receiving_account_name: string;
    fixed_service_names: string[];
    fixed_service_total: number | string;
  } | null;
}

export interface AccountingFixture {
  buildingId: string;
  buildingName: string;
  roomId: string;
  roomName: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  receivingAccountId: string;
  receivingAccountName: string;
  fixedServiceNames: string[];
  fixedServiceTotal: number;
}

export interface AccountingPreflight {
  ready: boolean;
  reason: string;
  managementProjectRef: string;
  actorId: string | null;
  fixture: AccountingFixture | null;
}

export interface AccountingState {
  invoiceTotal: number;
  invoicePaid: number;
  invoiceStatus: string;
  invoiceDeposit: number;
  collectionStatus: string;
  tenderCount: number;
  tenderMethods: string[];
  pnlAllocated: number;
  depositAllocated: number;
  sourcePnl: number;
  sourceDeposit: number;
  reversalPnl: number;
  reversalDeposit: number;
  activeReceiptCount: number;
  reversedPaymentCount: number;
  invalidReversalCount: number;
}

function readOptional(url: URL): string | null {
  try {
    return readFileSync(url, 'utf8');
  } catch {
    return null;
  }
}

function loadAdminConfig(): AdminConfig {
  const localConfig = readOptional(new URL('../../CLAUDE.local.md', import.meta.url));
  const pat =
    process.env.SUPABASE_PAT?.trim() ||
    localConfig?.match(/\bsbp_[A-Za-z0-9_-]+\b/)?.[0];
  if (!pat) {
    throw new Error(
      'Thiếu Supabase PAT: đặt SUPABASE_PAT hoặc cấu hình CLAUDE.local.md để preflight/cleanup E2E.',
    );
  }

  let projectRef = process.env.SUPABASE_PROJECT_REF?.trim();
  if (!projectRef) {
    projectRef = readOptional(new URL('../../supabase/.temp/project-ref', import.meta.url))?.trim();
  }
  if (!projectRef) {
    const linked = readOptional(
      new URL('../../supabase/.temp/linked-project.json', import.meta.url),
    );
    if (linked) {
      try {
        projectRef = JSON.parse(linked).ref;
      } catch {
        projectRef = undefined;
      }
    }
  }
  if (!projectRef || !/^[a-z0-9]+$/i.test(projectRef)) {
    throw new Error('Thiếu hoặc sai SUPABASE_PROJECT_REF cho E2E accounting chain.');
  }
  return { pat, projectRef };
}

function redact(value: string, secret: string): string {
  return value.replaceAll(secret, '[REDACTED]');
}

async function runSql<T>(query: string, config = loadAdminConfig()): Promise<T[]> {
  const { pat, projectRef } = config;
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Supabase Management SQL lỗi ${response.status}: ${redact(body, pat).slice(0, 3000)}`,
    );
  }
  try {
    return JSON.parse(body) as T[];
  } catch {
    throw new Error(`Supabase Management SQL trả JSON không hợp lệ: ${body.slice(0, 500)}`);
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function uuidLiteral(value: string): string {
  if (!UUID_RE.test(value)) throw new Error(`UUID fixture không hợp lệ: ${value}`);
  return `${sqlLiteral(value)}::uuid`;
}

function number(value: number | string | null | undefined): number {
  return Number(value) || 0;
}

/**
 * Soft-delete sổ quỹ do fixture E2E tạo (đúng cách app xoá sổ). Chỉ nhận tên
 * mang tiền tố fixture và chỉ đụng org DEMO — sổ thật không thể lọt vào.
 */
export async function cleanupFleetCashbook(name: string): Promise<void> {
  if (!name.startsWith('E2E Fleet ')) {
    throw new Error(`Từ chối dọn sổ quỹ không thuộc fixture E2E: ${name}`);
  }
  await runSql(`
UPDATE public.accounts
SET deleted_at = now()
WHERE organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  AND name = ${sqlLiteral(name)}
  AND deleted_at IS NULL;
`);
}

export async function getAccountingPreflight(
  plannedRent: number,
  plannedDeposit: number,
): Promise<AccountingPreflight> {
  const adminConfig = loadAdminConfig();
  const rows = await runSql<RawPreflightRow>(`
WITH params AS (
  SELECT
    ${sqlLiteral(DEMO_ORG_ID)}::uuid AS organization_id,
    (SELECT id FROM auth.users WHERE email = ${sqlLiteral(DEMO_OWNER_EMAIL)}) AS actor_id
),
schema_state AS (
  SELECT
    to_regprocedure('public.create_contract_v2(jsonb,text)') IS NOT NULL
    AND to_regprocedure('public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)') IS NOT NULL
    AND to_regprocedure('public.reverse_invoice_collection_v5(uuid,date,text,text)') IS NOT NULL
    AND to_regprocedure('app_private.count_invalid_payment_reversals_v1(uuid)') IS NOT NULL
    AND to_regclass('public.active_payment_receipts') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_income_expense_layer_stats'
    )
    AND EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fa_monthly_pnl_accrual'
    ) AS ready
),
feature_state AS (
  SELECT
    feature.feature_key,
    feature.mode,
    app_private.evaluate_feature_route(feature.feature_key, params.organization_id) AS route,
    feature.config_version,
    feature.max_operation_count,
    feature.max_single_amount_vnd,
    feature.max_total_amount_vnd,
    count(operation.id) AS used_count,
    COALESCE(sum(operation.amount_vnd), 0) AS used_amount
  FROM params
  JOIN app_private.server_feature_flags feature
    ON feature.feature_key IN (
      'contract.create.v2',
      'invoice.collection.v5',
      'invoice.collection.reverse.v5'
    )
  LEFT JOIN app_private.server_feature_flag_operations operation
    ON operation.feature_key = feature.feature_key
   AND operation.config_version = feature.config_version
  GROUP BY feature.feature_key, feature.mode, feature.config_version,
           feature.max_operation_count, feature.max_single_amount_vnd,
           feature.max_total_amount_vnd, params.organization_id
),
eligible_room AS (
  SELECT
    building.id AS building_id,
    building.name AS building_name,
    room.id AS room_id,
    room.name AS room_name,
    account.id AS receiving_account_id,
    account.name AS receiving_account_name,
    COALESCE((
      SELECT jsonb_agg(service.name ORDER BY service.name)
      FROM public.building_services link
      JOIN public.services service ON service.id = link.service_id
      WHERE link.building_id = building.id
        AND link.is_active
        AND service.type <> 'METER_READING'
        AND COALESCE(link.unit_price_override, service.unit_price, 0) > 0
    ), '[]'::jsonb) AS fixed_service_names,
    COALESCE((
      SELECT sum(COALESCE(link.unit_price_override, service.unit_price, 0))
      FROM public.building_services link
      JOIN public.services service ON service.id = link.service_id
      WHERE link.building_id = building.id
        AND link.is_active
        AND service.type <> 'METER_READING'
    ), 0) AS fixed_service_total
  FROM params
  JOIN public.buildings building
    ON building.organization_id = params.organization_id
   AND building.deleted_at IS NULL
   AND NOT building.is_virtual
  JOIN public.rooms room
    ON room.building_id = building.id
   AND room.deleted_at IS NULL
   AND room.status = 'AVAILABLE'
  JOIN public.accounts account
    ON account.id = building.default_account_id_tt
   AND account.organization_id = params.organization_id
   AND account.deleted_at IS NULL
   AND NOT account.is_virtual
  WHERE params.actor_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.contracts contract
      WHERE contract.room_id = room.id
        AND contract.deleted_at IS NULL
        AND contract.status = 'ACTIVE'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.income_expenses voucher
      WHERE voucher.room_id = room.id
        AND voucher.contract_id IS NULL
        AND voucher.deleted_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.invoices invoice
      WHERE invoice.room_id = room.id
        AND invoice.deleted_at IS NULL
        AND invoice.billing_month = to_char(public.vn_local_date(clock_timestamp()), 'YYYY-MM')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.income_expenses voucher
      WHERE voucher.room_id = room.id
        AND voucher.deleted_at IS NULL
        AND to_char(voucher.voucher_date, 'YYYY-MM') =
            to_char(public.vn_local_date(clock_timestamp()), 'YYYY-MM')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.room_reservation_holds hold
      WHERE hold.room_id = room.id
        AND hold.status = 'PENDING_APPROVAL'
    )
    AND COALESCE((
      SELECT allowed FROM app_private.authorize_tenant_action_v3(
        params.actor_id, params.organization_id, 'contracts.create', building.id, NULL
      )
    ), false)
    AND COALESCE((
      SELECT allowed FROM app_private.authorize_tenant_action_v3(
        params.actor_id, params.organization_id, 'invoices.create', building.id, NULL
      )
    ), false)
    AND COALESCE((
      SELECT allowed FROM app_private.authorize_tenant_action_v3(
        params.actor_id, params.organization_id, 'thu_tien.collect', building.id, account.id
      )
    ), false)
    AND COALESCE((
      SELECT allowed FROM app_private.authorize_tenant_action_v3(
        params.actor_id, params.organization_id, 'thu_tien.undo', building.id, account.id
      )
    ), false)
  ORDER BY building.name, room.name
  LIMIT 1
),
customer AS (
  SELECT id, full_name, phone
  FROM params
  JOIN public.customers customer
    ON customer.organization_id = params.organization_id
   AND customer.deleted_at IS NULL
  ORDER BY customer.full_name, customer.id
  LIMIT 1
)
SELECT
  (SELECT ready FROM schema_state) AS schema_ready,
  (SELECT actor_id FROM params) AS actor_id,
  COALESCE((SELECT jsonb_agg(to_jsonb(feature_state) ORDER BY feature_key) FROM feature_state), '[]'::jsonb) AS flags,
  (
    SELECT jsonb_build_object(
      'building_id', room.building_id,
      'building_name', room.building_name,
      'room_id', room.room_id,
      'room_name', room.room_name,
      'customer_id', customer.id,
      'customer_name', customer.full_name,
      'customer_phone', customer.phone,
      'receiving_account_id', room.receiving_account_id,
      'receiving_account_name', room.receiving_account_name,
      'fixed_service_names', room.fixed_service_names,
      'fixed_service_total', room.fixed_service_total
    )
    FROM eligible_room room CROSS JOIN customer
  ) AS fixture;
`, adminConfig);

  const row = rows[0];
  if (!row) {
    return {
      ready: false,
      reason: 'Preflight SQL không trả dữ liệu.',
      managementProjectRef: adminConfig.projectRef,
      actorId: null,
      fixture: null,
    };
  }

  const rawFixture = row.fixture;
  const fixture: AccountingFixture | null = rawFixture
    ? {
        buildingId: rawFixture.building_id,
        buildingName: rawFixture.building_name,
        roomId: rawFixture.room_id,
        roomName: rawFixture.room_name,
        customerId: rawFixture.customer_id,
        customerName: rawFixture.customer_name,
        customerPhone: rawFixture.customer_phone,
        receivingAccountId: rawFixture.receiving_account_id,
        receivingAccountName: rawFixture.receiving_account_name,
        fixedServiceNames: rawFixture.fixed_service_names ?? [],
        fixedServiceTotal: number(rawFixture.fixed_service_total),
      }
    : null;

  const reasons: string[] = [];
  if (!row.schema_ready) reasons.push('thiếu RPC/view accounting rollout hoặc RPC kiểm chứng lợi nhuận');
  if (!row.actor_id) reasons.push(`không tìm thấy ${DEMO_OWNER_EMAIL}`);
  if (!fixture) reasons.push('không có phòng/khách/sổ quỹ DEMO đủ điều kiện và quyền');

  const flags = row.flags ?? [];
  const byKey = new Map(flags.map((flag) => [flag.feature_key, flag]));
  for (const key of [
    'contract.create.v2',
    'invoice.collection.v5',
    'invoice.collection.reverse.v5',
  ]) {
    const flag = byKey.get(key);
    if (!flag) reasons.push(`feature ${key} chưa được cấu hình`);
    else if (flag.route !== 'CANONICAL') reasons.push(`feature ${key} đang ở route ${flag.route}`);
  }

  if (fixture) {
    const estimatedAmount = plannedRent + plannedDeposit + fixture.fixedServiceTotal;
    for (const key of ['contract.create.v2', 'invoice.collection.v5']) {
      const flag = byKey.get(key);
      if (!flag || flag.mode !== 'CANARY') continue;
      const countRemaining = number(flag.max_operation_count) - number(flag.used_count);
      const amountRemaining = number(flag.max_total_amount_vnd) - number(flag.used_amount);
      if (countRemaining < 1) reasons.push(`canary ${key} đã hết lượt`);
      if (number(flag.max_single_amount_vnd) < estimatedAmount) {
        reasons.push(`canary ${key} không đủ hạn mức mỗi lần cho ${estimatedAmount}đ`);
      }
      if (amountRemaining < estimatedAmount) {
        reasons.push(`canary ${key} không đủ hạn mức tổng còn lại cho ${estimatedAmount}đ`);
      }
    }
  }

  return {
    ready: reasons.length === 0,
    reason: reasons.length === 0 ? 'Accounting rollout DEMO sẵn sàng.' : reasons.join('; '),
    managementProjectRef: adminConfig.projectRef,
    actorId: row.actor_id,
    fixture,
  };
}

export async function inspectAccountingState(
  invoiceId: string,
  collectionId: string,
): Promise<AccountingState> {
  const rows = await runSql<Record<string, unknown>>(`
WITH target_payments AS (
  SELECT payment.id, payment.reversed_at
  FROM public.payments payment
  WHERE payment.invoice_id = ${uuidLiteral(invoiceId)}
    AND payment.collection_id = ${uuidLiteral(collectionId)}
), target_allocations AS (
  SELECT allocation.accounting_class, allocation.amount
  FROM public.invoice_payment_allocations allocation
  WHERE allocation.collection_id = ${uuidLiteral(collectionId)}
), source_items AS (
  SELECT item.accounting_class, item.amount
  FROM public.income_expense_items item
  JOIN public.income_expenses voucher ON voucher.id = item.income_expense_id
  WHERE voucher.payment_collection_id = ${uuidLiteral(collectionId)}
    AND voucher.type = 'INCOME'
), reversal_items AS (
  SELECT item.accounting_class, item.amount
  FROM public.income_expense_items item
  JOIN public.income_expenses voucher ON voucher.id = item.income_expense_id
  WHERE voucher.payment_collection_id = ${uuidLiteral(collectionId)}
    AND voucher.type = 'EXPENSE'
    AND voucher.system_source = 'invoice.collection.reverse.v5'
)
SELECT
  invoice.total_amount AS invoice_total,
  invoice.paid_amount AS invoice_paid,
  invoice.status AS invoice_status,
  COALESCE((
    SELECT sum(item.amount) FROM public.invoice_items item
    WHERE item.invoice_id = invoice.id AND item.accounting_class = 'DEPOSIT'
  ), 0) AS invoice_deposit,
  collection.status AS collection_status,
  (SELECT count(*) FROM public.invoice_payment_tenders tender WHERE tender.collection_id = collection.id) AS tender_count,
  COALESCE((
    SELECT jsonb_agg(tender.payment_method ORDER BY tender.line_index)
    FROM public.invoice_payment_tenders tender WHERE tender.collection_id = collection.id
  ), '[]'::jsonb) AS tender_methods,
  COALESCE((SELECT sum(amount) FROM target_allocations WHERE accounting_class = 'PNL'), 0) AS pnl_allocated,
  COALESCE((SELECT sum(amount) FROM target_allocations WHERE accounting_class = 'DEPOSIT'), 0) AS deposit_allocated,
  COALESCE((SELECT sum(amount) FROM source_items WHERE accounting_class = 'PNL'), 0) AS source_pnl,
  COALESCE((SELECT sum(amount) FROM source_items WHERE accounting_class = 'DEPOSIT'), 0) AS source_deposit,
  COALESCE((SELECT sum(amount) FROM reversal_items WHERE accounting_class = 'PNL'), 0) AS reversal_pnl,
  COALESCE((SELECT sum(amount) FROM reversal_items WHERE accounting_class = 'DEPOSIT'), 0) AS reversal_deposit,
  (SELECT count(*) FROM public.active_payment_receipts receipt WHERE receipt.invoice_id = invoice.id) AS active_receipt_count,
  (SELECT count(*) FROM target_payments WHERE reversed_at IS NOT NULL) AS reversed_payment_count,
  COALESCE((
    SELECT sum(app_private.count_invalid_payment_reversals_v1(payment.id))
    FROM target_payments payment
  ), 0) AS invalid_reversal_count
FROM public.invoices invoice
JOIN public.invoice_payment_collections collection
  ON collection.id = ${uuidLiteral(collectionId)}
 AND collection.invoice_id = invoice.id
WHERE invoice.id = ${uuidLiteral(invoiceId)}
  AND invoice.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid;
`);
  const row = rows[0];
  if (!row) throw new Error('Không tìm thấy invoice/collection E2E trong org DEMO.');
  return {
    invoiceTotal: number(row.invoice_total as string),
    invoicePaid: number(row.invoice_paid as string),
    invoiceStatus: String(row.invoice_status ?? ''),
    invoiceDeposit: number(row.invoice_deposit as string),
    collectionStatus: String(row.collection_status ?? ''),
    tenderCount: number(row.tender_count as string),
    tenderMethods: (row.tender_methods as string[]) ?? [],
    pnlAllocated: number(row.pnl_allocated as string),
    depositAllocated: number(row.deposit_allocated as string),
    sourcePnl: number(row.source_pnl as string),
    sourceDeposit: number(row.source_deposit as string),
    reversalPnl: number(row.reversal_pnl as string),
    reversalDeposit: number(row.reversal_deposit as string),
    activeReceiptCount: number(row.active_receipt_count as string),
    reversedPaymentCount: number(row.reversed_payment_count as string),
    invalidReversalCount: number(row.invalid_reversal_count as string),
  };
}

export async function cleanupAccountingFixture(
  marker: string,
  contractId: string | null,
): Promise<void> {
  if (!marker.startsWith('[E2E-ACCOUNTING:')) {
    throw new Error('Từ chối cleanup accounting khi marker không thuộc fixture E2E.');
  }
  const contractIdLiteral = contractId ? uuidLiteral(contractId) : 'NULL::uuid';

  await runSql(`
BEGIN;
SET LOCAL statement_timeout = '2min';

CREATE TEMP TABLE _e2e_cleanup_input ON COMMIT DROP AS
SELECT ${contractIdLiteral} AS contract_id;

CREATE TEMP TABLE _e2e_contracts ON COMMIT DROP AS
SELECT contract.id, contract.room_id
FROM public.contracts contract
WHERE contract.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  AND contract.notes = ${sqlLiteral(marker)}
  AND (
    (SELECT contract_id FROM _e2e_cleanup_input) IS NULL
    OR contract.id = (SELECT contract_id FROM _e2e_cleanup_input)
  );
ALTER TABLE _e2e_contracts ADD PRIMARY KEY (id);

DO $guard$
BEGIN
  IF (SELECT contract_id FROM _e2e_cleanup_input) IS NULL THEN
    IF (SELECT count(*) FROM _e2e_contracts) > 1 THEN
      RAISE EXCEPTION 'Accounting E2E cleanup marker matched multiple DEMO contracts';
    END IF;
  ELSE
    IF (SELECT count(*) FROM _e2e_contracts) <> 1 THEN
      RAISE EXCEPTION 'Accounting E2E cleanup could not find the exact committed contract';
    END IF;

    IF (
      SELECT count(*)
      FROM public.contracts contract
      WHERE contract.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
        AND contract.notes = ${sqlLiteral(marker)}
    ) <> 1 THEN
      RAISE EXCEPTION 'Accounting E2E cleanup marker is not unique inside the DEMO org';
    END IF;
  END IF;
END
$guard$;

CREATE TEMP TABLE _e2e_invoices ON COMMIT DROP AS
SELECT invoice.id
FROM public.invoices invoice
WHERE invoice.contract_id IN (SELECT id FROM _e2e_contracts);
ALTER TABLE _e2e_invoices ADD PRIMARY KEY (id);

CREATE TEMP TABLE _e2e_collections ON COMMIT DROP AS
SELECT collection.id
FROM public.invoice_payment_collections collection
WHERE collection.invoice_id IN (SELECT id FROM _e2e_invoices)
   OR collection.contract_id IN (SELECT id FROM _e2e_contracts);
ALTER TABLE _e2e_collections ADD PRIMARY KEY (id);

CREATE TEMP TABLE _e2e_tenders ON COMMIT DROP AS
SELECT tender.id
FROM public.invoice_payment_tenders tender
WHERE tender.collection_id IN (SELECT id FROM _e2e_collections);
ALTER TABLE _e2e_tenders ADD PRIMARY KEY (id);

CREATE TEMP TABLE _e2e_payments ON COMMIT DROP AS
SELECT payment.id
FROM public.payments payment
WHERE payment.invoice_id IN (SELECT id FROM _e2e_invoices)
   OR payment.collection_id IN (SELECT id FROM _e2e_collections)
   OR payment.tender_id IN (SELECT id FROM _e2e_tenders);
ALTER TABLE _e2e_payments ADD PRIMARY KEY (id);

INSERT INTO _e2e_payments (id)
SELECT tender.payment_id
FROM public.invoice_payment_tenders tender
WHERE tender.id IN (SELECT id FROM _e2e_tenders)
  AND tender.payment_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE _e2e_vouchers ON COMMIT DROP AS
WITH RECURSIVE fixture_voucher AS (
  SELECT voucher.id
  FROM public.income_expenses voucher
  WHERE voucher.contract_id IN (SELECT id FROM _e2e_contracts)
     OR voucher.invoice_id IN (SELECT id FROM _e2e_invoices)
     OR voucher.payment_id IN (SELECT id FROM _e2e_payments)
     OR voucher.payment_collection_id IN (SELECT id FROM _e2e_collections)
     OR voucher.id IN (
       SELECT tender.voucher_id FROM public.invoice_payment_tenders tender
       WHERE tender.id IN (SELECT id FROM _e2e_tenders)
         AND tender.voucher_id IS NOT NULL
     )
  UNION
  SELECT child.id
  FROM public.income_expenses child
  JOIN fixture_voucher parent ON child.reversal_of_income_expense_id = parent.id
)
SELECT id FROM fixture_voucher;
ALTER TABLE _e2e_vouchers ADD PRIMARY KEY (id);

CREATE TEMP TABLE _e2e_excess ON COMMIT DROP AS
SELECT excess.id
FROM public.excess_amounts excess
WHERE excess.contract_id IN (SELECT id FROM _e2e_contracts)
   OR excess.source_invoice_id IN (SELECT id FROM _e2e_invoices)
   OR excess.source_payment_id IN (SELECT id FROM _e2e_payments);
ALTER TABLE _e2e_excess ADD PRIMARY KEY (id);

CREATE TEMP TABLE _e2e_credit_lots ON COMMIT DROP AS
SELECT lot.id
FROM public.customer_credit_lots lot
WHERE lot.contract_id IN (SELECT id FROM _e2e_contracts)
   OR lot.source_collection_id IN (SELECT id FROM _e2e_collections)
   OR lot.source_tender_id IN (SELECT id FROM _e2e_tenders)
   OR lot.source_payment_id IN (SELECT id FROM _e2e_payments)
   OR lot.source_excess_amount_id IN (SELECT id FROM _e2e_excess);
ALTER TABLE _e2e_credit_lots ADD PRIMARY KEY (id);

DO $credit_boundary$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.customer_credit_applications application
    WHERE (
      application.invoice_id IN (SELECT id FROM _e2e_invoices)
      OR application.excess_amount_id IN (SELECT id FROM _e2e_excess)
      OR application.reversal_excess_amount_id IN (SELECT id FROM _e2e_excess)
    )
      AND application.credit_lot_id NOT IN (SELECT id FROM _e2e_credit_lots)
  ) THEN
    RAISE EXCEPTION 'Accounting E2E cleanup crossed into a non-fixture credit lot';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.customer_credit_applications application
    WHERE application.credit_lot_id IN (SELECT id FROM _e2e_credit_lots)
      AND (
        (application.invoice_id IS NOT NULL AND application.invoice_id NOT IN (SELECT id FROM _e2e_invoices))
        OR (application.excess_amount_id IS NOT NULL AND application.excess_amount_id NOT IN (SELECT id FROM _e2e_excess))
        OR (application.reversal_excess_amount_id IS NOT NULL AND application.reversal_excess_amount_id NOT IN (SELECT id FROM _e2e_excess))
      )
  ) THEN
    RAISE EXCEPTION 'Accounting E2E credit was consumed outside the fixture';
  END IF;
END
$credit_boundary$;

CREATE TEMP TABLE _e2e_canonical ON COMMIT DROP AS
SELECT operation.organization_id, operation.operation, operation.subject_scope,
       operation.actor_id, operation.idempotency_key
FROM app_private.canonical_write_operations operation
WHERE operation.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  AND (
    (
      operation.operation = 'contract.create.v2'
      AND operation.subject_id IN (SELECT id FROM _e2e_contracts)
    )
    OR (
      operation.operation = 'invoice.collection.v5'
      AND operation.subject_id IN (SELECT id FROM _e2e_collections)
      AND operation.subject_scope IN (SELECT id::text FROM _e2e_invoices)
    )
    OR (
      operation.operation = 'invoice.collection.reverse.v5'
      AND operation.subject_id IN (SELECT id FROM _e2e_collections)
      AND operation.subject_scope IN (SELECT id::text FROM _e2e_collections)
    )
  );

DELETE FROM app_private.server_feature_flag_operations feature_operation
USING _e2e_canonical operation
WHERE operation.operation IN ('contract.create.v2', 'invoice.collection.v5')
  AND feature_operation.feature_key = operation.operation
  AND feature_operation.organization_id = operation.organization_id
  AND feature_operation.operation_key = md5(concat_ws(
    '|', operation.operation, operation.organization_id::text,
    operation.subject_scope, operation.actor_id::text, operation.idempotency_key
  ));

SELECT app_private.begin_accounting_chain_write_v1();

UPDATE public.payments
SET collection_id = NULL, tender_id = NULL, reversed_by_collection_id = NULL
WHERE id IN (SELECT id FROM _e2e_payments);

UPDATE public.income_expenses
SET payment_collection_id = NULL, reversal_of_income_expense_id = NULL
WHERE id IN (SELECT id FROM _e2e_vouchers);

UPDATE public.excess_amounts
SET credit_lot_id = NULL
WHERE id IN (SELECT id FROM _e2e_excess);

DELETE FROM public.customer_credit_applications application
WHERE application.credit_lot_id IN (SELECT id FROM _e2e_credit_lots)
   OR application.invoice_id IN (SELECT id FROM _e2e_invoices)
   OR application.excess_amount_id IN (SELECT id FROM _e2e_excess)
   OR application.reversal_excess_amount_id IN (SELECT id FROM _e2e_excess);
DELETE FROM public.invoice_payment_allocations allocation
WHERE allocation.collection_id IN (SELECT id FROM _e2e_collections)
   OR allocation.tender_id IN (SELECT id FROM _e2e_tenders)
   OR allocation.voucher_id IN (SELECT id FROM _e2e_vouchers);
DELETE FROM public.contract_deposit_links link
WHERE link.contract_id IN (SELECT id FROM _e2e_contracts)
   OR link.income_expense_id IN (SELECT id FROM _e2e_vouchers);
DELETE FROM app_private.payment_reversals reversal
WHERE reversal.original_payment_id IN (SELECT id FROM _e2e_payments)
   OR reversal.reversal_voucher_id IN (SELECT id FROM _e2e_vouchers);
DELETE FROM app_private.income_expense_flow_ownership ownership
WHERE ownership.income_expense_id IN (SELECT id FROM _e2e_vouchers);
DELETE FROM public.customer_credit_lots lot
WHERE lot.id IN (SELECT id FROM _e2e_credit_lots);
DELETE FROM public.excess_amounts excess
WHERE excess.id IN (SELECT id FROM _e2e_excess);
DELETE FROM public.invoice_payment_tenders tender
WHERE tender.id IN (SELECT id FROM _e2e_tenders);
DELETE FROM public.income_expense_items item
WHERE item.income_expense_id IN (SELECT id FROM _e2e_vouchers);
DELETE FROM public.income_expenses voucher
WHERE voucher.id IN (SELECT id FROM _e2e_vouchers);
DELETE FROM public.payments payment
WHERE payment.id IN (SELECT id FROM _e2e_payments);
DELETE FROM public.invoice_payment_collections collection
WHERE collection.id IN (SELECT id FROM _e2e_collections);

-- Finance V2 (24/07): canonical_write_operations là ledger APPEND-ONLY —
-- guard_canonical_write_operation() chặn DELETE (55000) kể cả replica role.
-- Dòng audit ledger của fixture là vô hại (không FK treo, không đụng balance)
-- nên KHÔNG xoá nữa; xoá sẽ làm cleanup nổ và bỏ lại toàn bộ rác phía trên.

SELECT app_private.end_accounting_chain_write_v1();

DELETE FROM public.notifications notification
WHERE notification.invoice_id IN (SELECT id FROM _e2e_invoices)
   OR notification.contract_id IN (SELECT id FROM _e2e_contracts);
-- invoice_audit_log (26/07): trigger a00_audit_append_only chặn DELETE (55000)
-- — cùng án lệ canonical_write_operations phía trên. Bảng KHÔNG có FK tới
-- invoices nên dòng audit mồ côi của fixture vô hại; xoá sẽ làm cleanup nổ
-- và rollback toàn bộ (bỏ lại contract/invoice/collection rác trong org DEMO).
DELETE FROM public.invoice_items item
WHERE item.invoice_id IN (SELECT id FROM _e2e_invoices);
DELETE FROM public.invoices invoice
WHERE invoice.id IN (SELECT id FROM _e2e_invoices);
UPDATE public.room_reservation_holds hold
SET contract_id = NULL, status = 'EXPIRED'
WHERE hold.contract_id IN (SELECT id FROM _e2e_contracts);
DELETE FROM public.contracts contract
WHERE contract.id IN (SELECT id FROM _e2e_contracts);
UPDATE public.rooms room
SET status = 'AVAILABLE'
WHERE room.id IN (SELECT room_id FROM _e2e_contracts)
  AND NOT EXISTS (
    SELECT 1 FROM public.contracts contract
    WHERE contract.room_id = room.id
      AND contract.deleted_at IS NULL
      AND contract.status = 'ACTIVE'
  );

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.contracts contract
    WHERE contract.id = (SELECT contract_id FROM _e2e_cleanup_input)
      AND contract.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
  ) THEN
    RAISE EXCEPTION 'Accounting E2E cleanup failed to remove the committed contract';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.contracts contract
    WHERE contract.organization_id = ${sqlLiteral(DEMO_ORG_ID)}::uuid
      AND contract.notes = ${sqlLiteral(marker)}
  ) THEN
    RAISE EXCEPTION 'Accounting E2E cleanup left the fixture marker behind';
  END IF;
END
$verify$;

COMMIT;
`);
}
