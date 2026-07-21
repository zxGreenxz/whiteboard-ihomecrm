#!/usr/bin/env node
/**
 * SEED P3 — chu kỳ tiền tháng:
 *   chỉ số điện/nước (tháng này) + hoá đơn đủ trạng thái + payment + phiếu thu chi.
 * Tòa A = triển lãm (đã thu/quá hạn/thu một phần); Tòa B = bài tập (chưa thu → để người học tự thu rồi reset).
 * Chạy: node scripts/docs-demo/seed-p3.mjs  (chạy sau seed-p2)
 */
import { runSql, sqlLit as L } from './lib.mjs'

const ownerRow = await runSql(`SELECT id FROM auth.users WHERE email='demo.chunha@username.ihomecrm.local';`)
const OWNER = ownerRow?.[0]?.id
if (!OWNER) { console.error('Chưa có demo.chunha'); process.exit(1) }
const O = `'${OWNER}'`

const monthStart = '2026-07-01' // ngày (issue/due/voucher)
const billingMonth = '2026-07'  // billing_month text định dạng YYYY-MM

const rid = (name) => `(SELECT id FROM rooms WHERE name='${name}' AND building_id=(SELECT id FROM buildings WHERE code='${name.startsWith('B') ? 'DEMOB' : 'DEMOA'}'))`
const cid = (name) => `(SELECT id FROM contracts WHERE user_id=${O} AND room_id=${rid(name)} AND status='ACTIVE' LIMIT 1)`
const bid = (name) => `(SELECT id FROM buildings WHERE code='${name.startsWith('B') ? 'DEMOB' : 'DEMOA'}')`
const meter = (name, kind) => `(SELECT id FROM meters WHERE code='DEMO-${name}-${kind}')`

const financeRows = await runSql(`
SELECT id, organization_id
FROM accounts
WHERE code='DEMO01' AND user_id=${O} AND deleted_at IS NULL
LIMIT 1;
`)
const demoAccount = financeRows?.[0]
if (!demoAccount?.id || !demoAccount?.organization_id) {
  console.error('Thiếu sổ quỹ DEMO01 hoặc organization_id')
  process.exit(1)
}
const DEMO_ACCOUNT_ID = L(demoAccount.id)
const DEMO_ORG_ID = L(demoAccount.organization_id)

const paymentTypeRows = await runSql(`
WITH existing AS (
  SELECT id
  FROM income_expense_types
  WHERE user_id=${O}
    AND organization_id=${DEMO_ORG_ID}
    AND type='income'
    AND name='Thu tiền hoá đơn'
  ORDER BY created_at
  LIMIT 1
), inserted AS (
  INSERT INTO income_expense_types (
    name, type, description, user_id, is_restricted, organization_id
  )
  SELECT
    'Thu tiền hoá đơn', 'income', '[DEMO-DOCS] Loại thu cho payment demo',
    ${O}, false, ${DEMO_ORG_ID}
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  RETURNING id
)
SELECT id FROM existing
UNION ALL
SELECT id FROM inserted
LIMIT 1;
`)
const PAYMENT_TYPE_ID = L(paymentTypeRows?.[0]?.id)
if (PAYMENT_TYPE_ID === 'NULL') {
  console.error('Không tạo được loại thu "Thu tiền hoá đơn"')
  process.exit(1)
}

const schemaRows = await runSql(`
SELECT
  (
    SELECT count(*) = 4
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='payments'
      AND column_name IN (
        'received_amount', 'credit_amount', 'change_amount', 'rounding_amount'
      )
  ) AS has_payment_semantics,
  to_regclass('public.invoice_payment_collections') IS NOT NULL
    AND to_regclass('public.invoice_payment_tenders') IS NOT NULL
    AND to_regclass('public.invoice_payment_allocations') IS NOT NULL
    AND to_regclass('public.customer_credit_lots') IS NOT NULL
    AND to_regclass('public.customer_credit_applications') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='customer_credit_applications'
        AND column_name='reversal_excess_amount_id'
    ) AS has_v5_cleanup;
`)
const schema = schemaRows?.[0] || {}
const dbTrue = (value) => value === true || value === 'true' || value === 1 || value === '1'
const hasPaymentSemantics = dbTrue(schema.has_payment_semantics)
const hasV5Cleanup = dbTrue(schema.has_v5_cleanup)
const paymentSemanticColumns = hasPaymentSemantics
  ? ', received_amount, credit_amount, change_amount, rounding_amount'
  : ''
const paymentSemanticValues = (amount) => hasPaymentSemantics
  ? `, ${amount}, 0, 0, 0`
  : ''
const paymentWriterOpen = hasV5Cleanup
  ? 'SELECT app_private.begin_accounting_chain_write_v1();'
  : ''
const paymentWriterClose = hasV5Cleanup
  ? 'app_private.end_accounting_chain_write_v1() AS writer_closed,'
  : ''

// ===== 0. Dọn P3 cũ =====
const legacyCleanupSql = `
CREATE TEMP TABLE _p3_invoices ON COMMIT DROP AS
SELECT invoice.id
FROM public.invoices invoice
WHERE invoice.user_id=${O}
  AND invoice.notes LIKE '[DEMO-DOCS] %';
ALTER TABLE _p3_invoices ADD PRIMARY KEY (id);

CREATE TEMP TABLE _p3_payments ON COMMIT DROP AS
SELECT payment.id
FROM public.payments payment
WHERE payment.invoice_id IN (SELECT id FROM _p3_invoices);
ALTER TABLE _p3_payments ADD PRIMARY KEY (id);

CREATE TEMP TABLE _p3_vouchers ON COMMIT DROP AS
SELECT voucher.id
FROM public.income_expenses voucher
WHERE voucher.invoice_id IN (SELECT id FROM _p3_invoices)
   OR voucher.payment_id IN (SELECT id FROM _p3_payments)
   OR (
     voucher.user_id=${O}
     AND voucher.notes LIKE '[DEMO-DOCS]%'
   );
ALTER TABLE _p3_vouchers ADD PRIMARY KEY (id);

DELETE FROM app_private.payment_reversals
WHERE original_payment_id IN (SELECT id FROM _p3_payments)
   OR reversal_voucher_id IN (SELECT id FROM _p3_vouchers);
DELETE FROM app_private.income_expense_flow_ownership
WHERE income_expense_id IN (SELECT id FROM _p3_vouchers);
DELETE FROM public.notifications
WHERE invoice_id IN (SELECT id FROM _p3_invoices);
DELETE FROM public.excess_amounts
WHERE source_invoice_id IN (SELECT id FROM _p3_invoices)
   OR source_payment_id IN (SELECT id FROM _p3_payments);
DELETE FROM public.income_expense_items
WHERE income_expense_id IN (SELECT id FROM _p3_vouchers);
DELETE FROM public.income_expenses
WHERE id IN (SELECT id FROM _p3_vouchers);
DELETE FROM public.payments
WHERE id IN (SELECT id FROM _p3_payments);
DELETE FROM public.invoice_items
WHERE invoice_id IN (SELECT id FROM _p3_invoices);
DELETE FROM public.invoice_audit_log
WHERE invoice_id IN (SELECT id FROM _p3_invoices);
DELETE FROM public.invoices
WHERE id IN (SELECT id FROM _p3_invoices);
DELETE FROM public.meter_readings
WHERE user_id=${O} AND notes='[DEMO-DOCS]';
`

const v5CleanupSql = `
CREATE TEMP TABLE _p3_invoices ON COMMIT DROP AS
SELECT invoice.id
FROM public.invoices invoice
WHERE invoice.user_id=${O}
  AND invoice.notes LIKE '[DEMO-DOCS] %';
ALTER TABLE _p3_invoices ADD PRIMARY KEY (id);

CREATE TEMP TABLE _p3_collections ON COMMIT DROP AS
SELECT collection.id
FROM public.invoice_payment_collections collection
WHERE collection.invoice_id IN (SELECT id FROM _p3_invoices);
ALTER TABLE _p3_collections ADD PRIMARY KEY (id);

CREATE TEMP TABLE _p3_tenders ON COMMIT DROP AS
SELECT tender.id
FROM public.invoice_payment_tenders tender
WHERE tender.collection_id IN (SELECT id FROM _p3_collections);
ALTER TABLE _p3_tenders ADD PRIMARY KEY (id);

CREATE TEMP TABLE _p3_payments ON COMMIT DROP AS
SELECT payment.id
FROM public.payments payment
WHERE payment.invoice_id IN (SELECT id FROM _p3_invoices)
   OR payment.collection_id IN (SELECT id FROM _p3_collections)
   OR payment.tender_id IN (SELECT id FROM _p3_tenders);
ALTER TABLE _p3_payments ADD PRIMARY KEY (id);

INSERT INTO _p3_payments (id)
SELECT tender.payment_id
FROM public.invoice_payment_tenders tender
WHERE tender.id IN (SELECT id FROM _p3_tenders)
  AND tender.payment_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE _p3_vouchers ON COMMIT DROP AS
WITH RECURSIVE fixture_voucher AS (
  SELECT voucher.id
  FROM public.income_expenses voucher
  WHERE voucher.invoice_id IN (SELECT id FROM _p3_invoices)
     OR voucher.payment_id IN (SELECT id FROM _p3_payments)
     OR voucher.payment_collection_id IN (SELECT id FROM _p3_collections)
     OR voucher.id IN (
       SELECT tender.voucher_id
       FROM public.invoice_payment_tenders tender
       WHERE tender.id IN (SELECT id FROM _p3_tenders)
         AND tender.voucher_id IS NOT NULL
     )
     OR (
       voucher.user_id=${O}
       AND voucher.notes LIKE '[DEMO-DOCS]%'
     )

  UNION

  SELECT child.id
  FROM public.income_expenses child
  JOIN fixture_voucher parent
    ON child.reversal_of_income_expense_id = parent.id
)
SELECT id FROM fixture_voucher;
ALTER TABLE _p3_vouchers ADD PRIMARY KEY (id);

CREATE TEMP TABLE _p3_excess ON COMMIT DROP AS
SELECT excess.id
FROM public.excess_amounts excess
WHERE excess.source_invoice_id IN (SELECT id FROM _p3_invoices)
   OR excess.source_payment_id IN (SELECT id FROM _p3_payments);
ALTER TABLE _p3_excess ADD PRIMARY KEY (id);

CREATE TEMP TABLE _p3_credit_lots ON COMMIT DROP AS
SELECT lot.id
FROM public.customer_credit_lots lot
WHERE lot.source_collection_id IN (SELECT id FROM _p3_collections)
   OR lot.source_tender_id IN (SELECT id FROM _p3_tenders)
   OR lot.source_payment_id IN (SELECT id FROM _p3_payments)
   OR lot.source_excess_amount_id IN (SELECT id FROM _p3_excess);
ALTER TABLE _p3_credit_lots ADD PRIMARY KEY (id);

DO $credit_boundary$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.customer_credit_applications application
    WHERE (
      application.invoice_id IN (SELECT id FROM _p3_invoices)
      OR application.excess_amount_id IN (SELECT id FROM _p3_excess)
      OR application.reversal_excess_amount_id IN (SELECT id FROM _p3_excess)
    )
      AND application.credit_lot_id NOT IN (SELECT id FROM _p3_credit_lots)
  ) THEN
    RAISE EXCEPTION
      'P3 cleanup blocked: a non-P3 credit lot is applied to DEMO-DOCS data';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.customer_credit_applications application
    WHERE application.credit_lot_id IN (SELECT id FROM _p3_credit_lots)
      AND (
        (
          application.invoice_id IS NOT NULL
          AND application.invoice_id NOT IN (SELECT id FROM _p3_invoices)
        )
        OR (
          application.excess_amount_id IS NOT NULL
          AND application.excess_amount_id NOT IN (SELECT id FROM _p3_excess)
        )
        OR (
          application.reversal_excess_amount_id IS NOT NULL
          AND application.reversal_excess_amount_id NOT IN (SELECT id FROM _p3_excess)
        )
      )
  ) THEN
    RAISE EXCEPTION
      'P3 cleanup blocked: DEMO-DOCS credit was consumed outside the fixture';
  END IF;
END
$credit_boundary$;

SELECT app_private.begin_accounting_chain_write_v1();

UPDATE public.payments
SET collection_id=NULL,
    tender_id=NULL,
    reversed_by_collection_id=NULL
WHERE id IN (SELECT id FROM _p3_payments);

UPDATE public.income_expenses
SET payment_collection_id=NULL,
    reversal_of_income_expense_id=NULL
WHERE id IN (SELECT id FROM _p3_vouchers);

UPDATE public.excess_amounts
SET credit_lot_id=NULL
WHERE id IN (SELECT id FROM _p3_excess);

DELETE FROM public.customer_credit_applications application
WHERE application.credit_lot_id IN (SELECT id FROM _p3_credit_lots)
   OR application.invoice_id IN (SELECT id FROM _p3_invoices)
   OR application.excess_amount_id IN (SELECT id FROM _p3_excess)
   OR application.reversal_excess_amount_id IN (SELECT id FROM _p3_excess);
DELETE FROM public.invoice_payment_allocations allocation
WHERE allocation.collection_id IN (SELECT id FROM _p3_collections)
   OR allocation.tender_id IN (SELECT id FROM _p3_tenders)
   OR allocation.voucher_id IN (SELECT id FROM _p3_vouchers);
DELETE FROM app_private.payment_reversals
WHERE original_payment_id IN (SELECT id FROM _p3_payments)
   OR reversal_voucher_id IN (SELECT id FROM _p3_vouchers);
DELETE FROM app_private.income_expense_flow_ownership
WHERE income_expense_id IN (SELECT id FROM _p3_vouchers);
DELETE FROM public.customer_credit_lots
WHERE id IN (SELECT id FROM _p3_credit_lots);
DELETE FROM public.excess_amounts
WHERE id IN (SELECT id FROM _p3_excess);
DELETE FROM public.invoice_payment_tenders
WHERE id IN (SELECT id FROM _p3_tenders);
DELETE FROM public.income_expense_items
WHERE income_expense_id IN (SELECT id FROM _p3_vouchers);
DELETE FROM public.income_expenses
WHERE id IN (SELECT id FROM _p3_vouchers);
DELETE FROM public.payments
WHERE id IN (SELECT id FROM _p3_payments);
DELETE FROM public.invoice_payment_collections
WHERE id IN (SELECT id FROM _p3_collections);
DELETE FROM app_private.canonical_write_operations operation
WHERE operation.subject_scope IN (SELECT id::text FROM _p3_invoices)
   OR operation.subject_scope IN (SELECT id::text FROM _p3_collections)
   OR operation.subject_id IN (
     SELECT id FROM _p3_collections
     UNION SELECT id FROM _p3_vouchers
     UNION SELECT id FROM _p3_payments
   );

SELECT app_private.end_accounting_chain_write_v1();

DELETE FROM public.notifications
WHERE invoice_id IN (SELECT id FROM _p3_invoices);
DELETE FROM public.invoice_items
WHERE invoice_id IN (SELECT id FROM _p3_invoices);
DELETE FROM public.invoice_audit_log
WHERE invoice_id IN (SELECT id FROM _p3_invoices);
DELETE FROM public.invoices
WHERE id IN (SELECT id FROM _p3_invoices);
DELETE FROM public.meter_readings
WHERE user_id=${O} AND notes='[DEMO-DOCS]';
`

await runSql(hasV5Cleanup ? v5CleanupSql : legacyCleanupSql)
console.log('✓ Dọn P3 cũ')

// ===== 1. Chỉ số điện/nước tháng này cho các phòng có HĐ (điện +120, nước +8) =====
const readRooms = ['A101', 'A102', 'A103', 'A104', 'A105', 'B101']
await runSql(
  readRooms
    .flatMap((r) => [
      `INSERT INTO meter_readings (user_id, meter_id, current_reading, reading_date, meter_type, status, notes) VALUES (${O}, ${meter(r, 'D')}, 1120, '${monthStart}', 'ELECTRICITY', 'APPROVED', '[DEMO-DOCS]');`,
      `INSERT INTO meter_readings (user_id, meter_id, current_reading, reading_date, meter_type, status, notes) VALUES (${O}, ${meter(r, 'N')}, 108, '${monthStart}', 'WATER', 'APPROVED', '[DEMO-DOCS]');`,
    ])
    .join('\n')
)
console.log('✓ Chỉ số điện/nước tháng này (6 phòng × 2)')

// ===== 2. Hoá đơn đủ trạng thái =====
// tiền: RENT + điện(120×3500=420k) + nước(8×15000=120k) + rác 30k ≈ rent+570k
// [phòng, status, dueOffset(ngày so với 1/7), paid(0/partial/full)]
const invoices = [
  { room: 'A101', rent: 3500000, status: 'PAID', bm: billingMonth, issue: monthStart, due: '2026-07-10', pay: 4070000 },
  { room: 'A102', rent: 4000000, status: 'PARTIAL_PAID', bm: billingMonth, issue: monthStart, due: '2026-07-10', pay: 2000000 },
  { room: 'A103', rent: 4500000, status: 'PAID', bm: billingMonth, issue: monthStart, due: '2026-07-10', pay: 5070000 },
  { room: 'A105', rent: 4500000, status: 'OVERDUE', bm: '2026-06', issue: '2026-06-01', due: '2026-06-15', pay: 0, prevDebt: 1000000 },
  { room: 'B101', rent: 5000000, status: 'APPROVED', bm: billingMonth, issue: monthStart, due: '2026-07-15', pay: 0 },
]
for (const inv of invoices) {
  const svc = 570000 // điện+nước+rác gộp cho gọn
  const total = inv.rent + svc + (inv.prevDebt || 0)
  const r = await runSql(`
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, billing_month, issue_date, due_date, status, subtotal, total_amount, previous_debt, notes)
    VALUES (${O}, ${cid(inv.room)}, ${bid(inv.room)}, ${rid(inv.room)}, '${inv.bm}', '${inv.issue}', '${inv.due}', '${inv.status}', ${inv.rent + svc}, ${total}, ${inv.prevDebt || 0}, '[DEMO-DOCS] ${inv.room}')
    RETURNING id;`)
  const invId = r[0].id
  await runSql(`
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, amount, sort_order) VALUES
      ('${invId}', 'RENT', 'Tiền nhà tháng 7/2026', ${inv.rent}, 1, ${inv.rent}, 1),
      ('${invId}', 'SERVICE', 'Tiền điện (120 kWh)', 3500, 120, 420000, 2),
      ('${invId}', 'SERVICE', 'Tiền nước (8 m3)', 15000, 8, 120000, 3),
      ('${invId}', 'SERVICE', 'Tiền rác', 30000, 1, 30000, 4);`)
  if (inv.pay > 0) {
    await runSql(`
${paymentWriterOpen}
WITH inserted_payment AS (
  INSERT INTO payments (
    user_id, organization_id, invoice_id, amount, payment_method, payment_date, notes${paymentSemanticColumns}
  )
  SELECT
    ${O}, invoice.organization_id, invoice.id, ${inv.pay}, 'TM',
    '${monthStart}', '[DEMO-DOCS] Thu tiền'${paymentSemanticValues(inv.pay)}
  FROM invoices invoice
  WHERE invoice.id='${invId}'
  RETURNING id, user_id, organization_id, invoice_id, amount, payment_date
), inserted_voucher AS (
  INSERT INTO income_expenses (
    user_id, organization_id, type, name, building_id, room_id, contract_id,
    account_id, invoice_id, payment_id, voucher_date, total_amount,
    approval_status, approved_by, approved_at, notes, system_source
  )
  SELECT
    payment.user_id, payment.organization_id, 'INCOME', 'DEMO Thu tiền hoá đơn',
    invoice.building_id, invoice.room_id, invoice.contract_id,
    ${DEMO_ACCOUNT_ID}, invoice.id, payment.id, payment.payment_date, payment.amount,
    'APPROVED', ${O}, now(), '[DEMO-DOCS] Thu tiền', 'invoice.payment'
  FROM inserted_payment payment
  JOIN invoices invoice ON invoice.id=payment.invoice_id
  RETURNING id, organization_id, total_amount, voucher_date
), inserted_item AS (
  INSERT INTO income_expense_items (
  income_expense_id, organization_id, income_expense_type_id, description,
  quantity, unit_price, amount, start_date, end_date
  )
  SELECT
    voucher.id, voucher.organization_id, ${PAYMENT_TYPE_ID}, 'Thu tiền hoá đơn',
    1, voucher.total_amount, voucher.total_amount,
    voucher.voucher_date, voucher.voucher_date
  FROM inserted_voucher voucher
  RETURNING id
)
SELECT ${paymentWriterClose} inserted.item_count
FROM (SELECT count(*)::int AS item_count FROM inserted_item) inserted;
`)
  }
  console.log(`  ✓ HĐ ${inv.room} ${inv.status} (total ${total.toLocaleString('vi')}đ, đã thu ${inv.pay.toLocaleString('vi')}đ)`)
}

// ===== 3. Phiếu thu chi standalone (không gắn hoá đơn) =====
const typeInc = `(SELECT id FROM income_expense_types WHERE name='DEMO Thu Khác' AND user_id=${O} LIMIT 1)`
const typeExp = `(SELECT id FROM income_expense_types WHERE name='DEMO Chi Đặc Biệt' AND user_id=${O} LIMIT 1)`
const r1 = await runSql(`INSERT INTO income_expenses (user_id, type, name, building_id, voucher_date, total_amount, approval_status, account_id, payer_name, notes)
  VALUES (${O}, 'EXPENSE', 'DEMO Chi sửa chữa tháng 7', ${bid('A101')}, '${monthStart}', 500000, 'APPROVED', ${DEMO_ACCOUNT_ID}, 'Thợ sửa demo', '[DEMO-DOCS]') RETURNING id;`)
await runSql(`INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, amount) VALUES ('${r1[0].id}', ${typeExp}, 'Sửa vòi nước A101', 1, 500000, 500000);`)
const r2 = await runSql(`INSERT INTO income_expenses (user_id, type, name, building_id, voucher_date, total_amount, approval_status, account_id, payer_name, notes)
  VALUES (${O}, 'INCOME', 'DEMO Thu phí phạt trễ hạn', ${bid('B101')}, '${monthStart}', 200000, 'APPROVED', ${DEMO_ACCOUNT_ID}, 'DEMO Đặng Văn Giang', '[DEMO-DOCS]') RETURNING id;`)
await runSql(`INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, amount) VALUES ('${r2[0].id}', ${typeInc}, 'Phí phạt', 1, 200000, 200000);`)
console.log('✓ 2 phiếu thu chi standalone (1 chi sửa chữa, 1 thu phí phạt)')

// ===== Báo cáo =====
const rep = await runSql(`
SELECT 'meter_readings' t, count(*)::int n FROM meter_readings WHERE user_id=${O}
UNION ALL SELECT 'invoices', count(*)::int FROM invoices WHERE user_id=${O}
UNION ALL SELECT 'invoice PAID', count(*)::int FROM invoices WHERE user_id=${O} AND status='PAID'
UNION ALL SELECT 'invoice PARTIAL', count(*)::int FROM invoices WHERE user_id=${O} AND status='PARTIAL_PAID'
UNION ALL SELECT 'invoice OVERDUE', count(*)::int FROM invoices WHERE user_id=${O} AND status='OVERDUE'
UNION ALL SELECT 'invoice chưa thu', count(*)::int FROM invoices WHERE user_id=${O} AND status='APPROVED'
UNION ALL SELECT 'payments', count(*)::int FROM payments WHERE user_id=${O}
UNION ALL SELECT 'income_expenses', count(*)::int FROM income_expenses WHERE user_id=${O};
`)
console.table(rep)
