import { readFileSync } from 'node:fs';

export const RESERVATION_DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
const OWNER = 'de6f33f3-349f-4bec-bd3d-106192f6715e';
const PROJECT = 'tryymsxyyckgbrmmvozx';
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function checked(marker: string, roomId: string) {
  if (!/^\[E2E-RESERVATION:[0-9a-f-]{36}\]$/.test(marker) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(roomId)) {
    throw new Error('Invalid reservation DEMO fixture identity');
  }
  return { marker: literal(marker), room: `${literal(roomId)}::uuid` };
}
async function sql<T>(query: string, readOnly = false): Promise<T[]> {
  if (process.env.FLEET_RESERVATION_LIVE !== '1') throw new Error('FLEET_RESERVATION_LIVE=1 is required');
  const vault = readFileSync(new URL('../../CLAUDE.local.md', import.meta.url), 'utf8');
  const pat = process.env.SUPABASE_PAT || vault.match(/\bsbp_[A-Za-z0-9_-]+\b/)?.[0];
  if (!pat) throw new Error('Missing SUPABASE_PAT for DEMO fixture');
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, read_only: readOnly }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`DEMO fixture SQL ${response.status}: ${body.replaceAll(pat, '[REDACTED]').slice(0, 1800)}`);
  return JSON.parse(body) as T[];
}
export interface ReservationLiveFixture {
  voucher_id: string; room_id: string; room_name: string; account_id: string;
  building_id: string; voucher_code: string; today: string;
}

/** Complete owned-fixture snapshot: supplementation must leave this byte-equivalent. */
export async function snapshotReservationFinancialRows(marker: string, roomId: string) {
  const q = checked(marker, roomId);
  const [snapshot] = await sql<{ snapshot: unknown }>(`WITH owned AS (
    SELECT v.id FROM public.income_expenses v JOIN public.rooms r ON r.id=v.room_id
    WHERE r.id=${q.room} AND r.organization_id='${RESERVATION_DEMO_ORG}' AND r.description=${q.marker}
      AND v.organization_id='${RESERVATION_DEMO_ORG}'
  ), postings AS (SELECT p.id FROM public.income_expense_postings p JOIN owned v ON v.id=p.voucher_id)
  SELECT jsonb_build_object(
    'headers',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM public.income_expenses v JOIN owned o ON o.id=v.id),
    'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM public.income_expense_items i JOIN owned o ON o.id=i.income_expense_id),
    'postings',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.income_expense_postings p JOIN postings o ON o.id=p.id),
    'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.income_expense_posting_lines l JOIN postings p ON p.id=l.posting_id)
  ) AS snapshot`, true);
  if (!snapshot) throw new Error('Missing owned voucher snapshot');
  return snapshot.snapshot;
}

/** Test-only cleanup for immutable additions on this exact owned DEMO room. */
export async function cleanupReservationSupplementFixture(marker: string, roomId: string) {
  const q = checked(marker, roomId);
  await sql(`BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
    CREATE TEMP TABLE _owned_supplements ON COMMIT DROP AS
    SELECT s.id FROM public.income_expense_supplements s JOIN public.income_expenses v ON v.id=s.income_expense_id
      JOIN public.rooms r ON r.id=v.room_id
    WHERE r.id=${q.room} AND r.description=${q.marker} AND r.organization_id='${RESERVATION_DEMO_ORG}'
      AND v.organization_id='${RESERVATION_DEMO_ORG}' AND s.organization_id='${RESERVATION_DEMO_ORG}';
    DO $guard$ BEGIN
      IF EXISTS(SELECT 1 FROM public.income_expense_supplements s JOIN _owned_supplements o ON o.id=s.id
        WHERE s.actor_id IS DISTINCT FROM '${OWNER}'::uuid) THEN RAISE EXCEPTION 'Unrelated supplement actor; refuse cleanup'; END IF;
      IF (SELECT count(*) FROM pg_trigger WHERE tgenabled='O' AND
        (tgrelid='public.income_expense_supplements'::regclass AND tgname='ie_supplement_immutable'
         OR tgrelid='app_private.ie_supplement_objects'::regclass AND tgname='ie_supplement_objects_immutable'
         OR tgrelid='app_private.ie_supplement_requests'::regclass AND tgname='ie_supplement_requests_immutable'))<>3
        THEN RAISE EXCEPTION 'Unexpected supplement trigger mode'; END IF;
    END $guard$;
    ALTER TABLE app_private.ie_supplement_requests DISABLE TRIGGER ie_supplement_requests_immutable;
    ALTER TABLE app_private.ie_supplement_objects DISABLE TRIGGER ie_supplement_objects_immutable;
    ALTER TABLE public.income_expense_supplements DISABLE TRIGGER ie_supplement_immutable;
    DELETE FROM app_private.ie_supplement_requests WHERE supplement_id IN(SELECT id FROM _owned_supplements);
    DELETE FROM app_private.ie_supplement_objects WHERE supplement_id IN(SELECT id FROM _owned_supplements);
    DELETE FROM public.income_expense_supplements WHERE id IN(SELECT id FROM _owned_supplements);
    ALTER TABLE app_private.ie_supplement_requests ENABLE TRIGGER ie_supplement_requests_immutable;
    ALTER TABLE app_private.ie_supplement_objects ENABLE TRIGGER ie_supplement_objects_immutable;
    ALTER TABLE public.income_expense_supplements ENABLE TRIGGER ie_supplement_immutable;
    COMMIT;`);
}

export async function cleanupReservationSupplementOrphanLinks(marker: string, roomId: string) {
  checked(marker, roomId);
  await sql(`DELETE FROM app_private.storage_object_links l
    WHERE l.bucket_id='income-expense-attachments' AND l.owner_user_id='${OWNER}'
      AND (l.organization_id='${RESERVATION_DEMO_ORG}' OR l.organization_id IS NULL)
      AND l.object_name ~ ${literal(`^${OWNER}/[0-9]+-e2e-reservation-proof-${roomId}-supp[.]png$`)}
      AND NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id=l.bucket_id AND o.name=l.object_name);`);
}

// A fresh DEMO room and an actual receipt through the application's writer for
// undated items. No posting/provenance is fabricated or permission changed.
export async function createReservationLiveFixture(marker: string, roomId: string, receiptDaysAgo: 0 | 2 | 'PREVIOUS_MONTH' = 0): Promise<ReservationLiveFixture> {
  const q = checked(marker, roomId);
  if (![0, 2, 'PREVIOUS_MONTH'].includes(receiptDaysAgo)) throw new Error('Invalid fixture receipt day');
  const receiptDate = receiptDaysAgo === 'PREVIOUS_MONTH'
    ? `(date_trunc('month',public.org_today_v1('${RESERVATION_DEMO_ORG}'))::date-1)`
    : `public.org_today_v1('${RESERVATION_DEMO_ORG}')-${receiptDaysAgo}`;
  await sql(`BEGIN;
SET LOCAL statement_timeout='30s';
SELECT set_config('request.jwt.claim.sub','${OWNER}',true);
DO $seed$
DECLARE b uuid; a uuid; t uuid; v uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM public.rooms WHERE id=${q.room}) THEN RAISE EXCEPTION 'Fixture room already exists'; END IF;
  SELECT building.id, account.id INTO STRICT b,a
  FROM public.buildings building
  JOIN public.organization_memberships m ON m.organization_id=building.organization_id AND m.user_id='${OWNER}'
  JOIN public.cashbook_possession_bindings p ON p.membership_id=m.id AND p.possession_kind='CUSTODIAN'
  JOIN public.accounts account ON account.id=p.cashbook_id AND account.organization_id=building.organization_id
  WHERE building.organization_id='${RESERVATION_DEMO_ORG}' AND building.deleted_at IS NULL AND NOT building.is_virtual
    AND account.deleted_at IS NULL AND NOT account.is_virtual LIMIT 1;
  SELECT id INTO STRICT t FROM public.income_expense_types
  WHERE organization_id='${RESERVATION_DEMO_ORG}' AND type='income' AND is_deposit
    AND NOT COALESCE(system_only,false) LIMIT 1;
  INSERT INTO public.rooms(id,organization_id,building_id,name,description,rent_price,deposit_amount,status)
  VALUES(${q.room},'${RESERVATION_DEMO_ORG}',b,${literal('E2E-R-'+roomId.slice(0,8))},${q.marker},3000000,3000000,'AVAILABLE');
  SELECT (public.ie_compat_insert_v2(
    jsonb_build_object('type','INCOME','name',${q.marker},'building_id',b,'room_id',${q.room},'payer_name',${q.marker},
      'account_id',a,'business_result_accounting',false,'notes',${q.marker},'voucher_date',${receiptDate}),
    jsonb_build_array(jsonb_build_object('income_expense_type_id',t,'description',${q.marker},'quantity',1,'unit_price',3000000,'accounting_class','DEPOSIT'))
  )->>'id')::uuid INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'Receipt was not created'; END IF;
END $seed$;
COMMIT;`);
  const [row] = await sql<ReservationLiveFixture>(`SELECT v.id AS voucher_id,r.id AS room_id,r.name AS room_name,
v.account_id,v.building_id,v.code AS voucher_code,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS today
FROM public.income_expenses v JOIN public.rooms r ON r.id=v.room_id
WHERE v.organization_id='${RESERVATION_DEMO_ORG}' AND r.id=${q.room} AND r.description=${q.marker} AND v.notes=${q.marker};`, true);
  if (!row) throw new Error('Missing committed DEMO receipt');
  return row;
}

export async function inspectReservationReports(fixture: ReservationLiveFixture, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-f-]{36}$/.test(fixture.building_id) || !/^[0-9a-f-]{36}$/.test(fixture.account_id)) throw new Error('Invalid report fixture scope');
  const day = `${literal(date)}::date`, building = `${literal(fixture.building_id)}::uuid`, account = `${literal(fixture.account_id)}::uuid`;
  // Report authorization locks its organization witness; allow that lock and
  // always roll back this inspection transaction.
  const [result] = await sql<{report: {voucher: {revenue: number; expense: number}; accrual: {revenue: number; expense: number}; cash: {income: number; expense: number}}}>(`BEGIN;
SELECT set_config('request.jwt.claim.sub','${OWNER}',true);
SET LOCAL ROLE authenticated;
SELECT jsonb_build_object(
  'voucher',(SELECT jsonb_build_object('revenue',COALESCE(sum(revenue),0),'expense',COALESCE(sum(expense),0)) FROM public.business_performance_pnl_v1(p_organization_id=>'${RESERVATION_DEMO_ORG}',p_basis=>'VOUCHER_DATE',p_start_date=>${day},p_end_date=>${day},p_building_ids=>ARRAY[${building}])),
  'accrual',(SELECT jsonb_build_object('revenue',COALESCE(sum(revenue),0),'expense',COALESCE(sum(expense),0)) FROM public.business_performance_pnl_v1(p_organization_id=>'${RESERVATION_DEMO_ORG}',p_basis=>'ACCRUAL',p_start_date=>${day},p_end_date=>${day},p_building_ids=>ARRAY[${building}])),
  'cash',(SELECT jsonb_build_object('income',COALESCE(sum(income),0),'expense',COALESCE(sum(expense),0)) FROM public.cashflow_by_day_v2(p_start=>${day},p_end=>${day},p_building_id=>${building},p_account_id=>${account}))) AS report;
ROLLBACK;`);
  if (!result?.report) throw new Error('Missing authenticated financial report result');
  return result.report;
}

export async function inspectReservationLiveFixture(marker: string, roomId: string) {
  const q = checked(marker, roomId);
  const [row] = await sql<{ cash: number; retained: number; refund: number; effective_paid: number; holding: boolean; room_status: string; source_amount: number; source_pnl: boolean; settlements: number }>(`
WITH source AS (SELECT id,total_amount,business_result_accounting FROM public.income_expenses WHERE organization_id='${RESERVATION_DEMO_ORG}' AND room_id=${q.room} AND notes=${q.marker}),
settlement AS (SELECT s.* FROM public.reservation_deposit_settlements s JOIN source v ON v.id=s.source_voucher_id),
vouchers AS (SELECT id FROM source UNION SELECT sv.voucher_id FROM public.reservation_settlement_vouchers sv JOIN settlement s ON s.id=sv.settlement_id)
SELECT (SELECT COALESCE(sum(l.signed_amount),0) FROM public.income_expense_posting_lines l JOIN public.income_expense_postings p ON p.id=l.posting_id WHERE p.voucher_id IN(SELECT id FROM vouchers))::numeric AS cash,
(SELECT COALESCE(sum(retained_amount),0) FROM settlement)::numeric AS retained,
(SELECT COALESCE(sum(refund_amount),0) FROM settlement)::numeric AS refund,
(SELECT COALESCE(-sum(l.signed_amount),0) FROM public.income_expense_posting_lines l JOIN public.income_expense_postings p ON p.id=l.posting_id JOIN public.reservation_settlement_vouchers sv ON sv.voucher_id=p.voucher_id WHERE sv.kind='REFUND' AND sv.settlement_id IN(SELECT id FROM settlement))::numeric AS effective_paid,
EXISTS(SELECT 1 FROM source WHERE id NOT IN(SELECT source_voucher_id FROM settlement)) AS holding,
(SELECT status FROM public.rooms WHERE id=${q.room}) AS room_status,
(SELECT total_amount FROM source) AS source_amount,(SELECT business_result_accounting FROM source) AS source_pnl,
(SELECT count(*)::int FROM settlement) AS settlements;`, true);
  if (!row) throw new Error('Missing fixture state');
  for (const key of ['cash', 'retained', 'refund', 'effective_paid', 'source_amount'] as const) {
    const amount = Number(row[key]);
    if (!Number.isSafeInteger(amount)) throw new Error(`Invalid fixture money: ${key}`);
    row[key] = amount;
  }
  return row;
}

// Explicitly scoped DEMO teardown. The one ALWAYS ownership trigger is restored
// to its original mode inside the same transaction; schema is unchanged at
// commit. Retain append-only canonical/audit events as other fleet helpers do.
export async function cleanupReservationLiveFixture(marker: string, roomId: string, dryRun = false) {
  const q = checked(marker, roomId);
  await sql(`BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='5s';
CREATE TEMP TABLE _reservation_fixture_rooms ON COMMIT DROP AS SELECT id FROM public.rooms
WHERE id=${q.room} AND organization_id='${RESERVATION_DEMO_ORG}' AND description=${q.marker};
CREATE TEMP TABLE _reservation_fixture_settlements ON COMMIT DROP AS SELECT s.id FROM public.reservation_deposit_settlements s
JOIN public.income_expenses v ON v.id=s.source_voucher_id WHERE v.room_id IN(SELECT id FROM _reservation_fixture_rooms) AND v.notes=${q.marker};
CREATE TEMP TABLE _reservation_fixture_vouchers ON COMMIT DROP AS
SELECT id FROM public.income_expenses WHERE room_id IN(SELECT id FROM _reservation_fixture_rooms) AND notes=${q.marker}
UNION SELECT voucher_id FROM public.reservation_settlement_vouchers WHERE settlement_id IN(SELECT id FROM _reservation_fixture_settlements);
CREATE TEMP TABLE _reservation_fixture_postings ON COMMIT DROP AS SELECT id FROM public.income_expense_postings WHERE voucher_id IN(SELECT id FROM _reservation_fixture_vouchers);
DO $guard$ BEGIN
IF EXISTS(SELECT 1 FROM public.income_expenses WHERE id IN(SELECT id FROM _reservation_fixture_vouchers) AND (organization_id IS DISTINCT FROM '${RESERVATION_DEMO_ORG}'::uuid OR contract_id IS NOT NULL OR invoice_id IS NOT NULL))
 OR EXISTS(SELECT 1 FROM public.income_expenses WHERE room_id IN(SELECT id FROM _reservation_fixture_rooms) AND id NOT IN(SELECT id FROM _reservation_fixture_vouchers))
 OR EXISTS(SELECT 1 FROM public.contracts WHERE room_id IN(SELECT id FROM _reservation_fixture_rooms)) THEN RAISE EXCEPTION 'Fixture acquired unrelated data; refuse cleanup'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='app_private.income_expense_flow_ownership'::regclass AND tgname='a00_flow_ownership_immutable' AND tgenabled='A') THEN RAISE EXCEPTION 'Ownership trigger mode changed'; END IF;
END $guard$;
SET LOCAL session_replication_role=replica;
ALTER TABLE app_private.income_expense_flow_ownership DISABLE TRIGGER a00_flow_ownership_immutable;
DELETE FROM app_private.income_expense_flow_ownership WHERE income_expense_id IN(SELECT id FROM _reservation_fixture_vouchers) AND organization_id='${RESERVATION_DEMO_ORG}';
ALTER TABLE app_private.income_expense_flow_ownership ENABLE ALWAYS TRIGGER a00_flow_ownership_immutable;
DELETE FROM app_private.reservation_refund_operations WHERE settlement_id IN(SELECT id FROM _reservation_fixture_settlements);
DELETE FROM app_private.reservation_settlement_write_tokens WHERE settlement_id IN(SELECT id FROM _reservation_fixture_settlements);
DELETE FROM public.reservation_settlement_vouchers WHERE settlement_id IN(SELECT id FROM _reservation_fixture_settlements);
DELETE FROM public.reservation_deposit_settlements WHERE id IN(SELECT id FROM _reservation_fixture_settlements);
DELETE FROM public.income_expense_posting_evidence WHERE posting_id IN(SELECT id FROM _reservation_fixture_postings);
DELETE FROM public.income_expense_posting_lines WHERE posting_id IN(SELECT id FROM _reservation_fixture_postings);
DELETE FROM public.income_expense_postings WHERE id IN(SELECT id FROM _reservation_fixture_postings);
DELETE FROM public.reservation_hold_deadlines WHERE income_expense_id IN(SELECT id FROM _reservation_fixture_vouchers);
DELETE FROM public.income_expense_items WHERE income_expense_id IN(SELECT id FROM _reservation_fixture_vouchers);
DELETE FROM public.approval_requests WHERE subject_type='INCOME_EXPENSE' AND subject_id IN(SELECT id FROM _reservation_fixture_vouchers) AND organization_id='${RESERVATION_DEMO_ORG}';
DELETE FROM public.income_expenses WHERE id IN(SELECT id FROM _reservation_fixture_vouchers);
DELETE FROM public.room_price_history WHERE room_id IN(SELECT id FROM _reservation_fixture_rooms);
DELETE FROM public.rooms WHERE id IN(SELECT id FROM _reservation_fixture_rooms);
SET LOCAL session_replication_role=origin;
-- Storage HTTP deletion removes the file; its private organization link is
-- retained separately. Remove only this fixture's deleted DEMO upload link.
DELETE FROM app_private.storage_object_links l
WHERE l.bucket_id='income-expense-attachments' AND l.owner_user_id='${OWNER}'
  AND (l.organization_id='${RESERVATION_DEMO_ORG}' OR l.organization_id IS NULL)
  AND l.object_name ~ ${literal(`^${OWNER}/[0-9]+-e2e-reservation-proof-${roomId}[.]png$`)}
  AND NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id=l.bucket_id AND o.name=l.object_name);
DO $verify$ DECLARE k record; leftover boolean; BEGIN
  -- Every incoming FK to a removed identity must be clear, even when a future
  -- writer adds another child table unknown to the explicit deletion list.
  FOR k IN SELECT n.nspname,c.relname,a.attname,parent.relname AS parent_name
    FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class parent ON parent.oid=fk.confrelid
    JOIN LATERAL unnest(fk.conkey,fk.confkey) keys(child,parent) ON true
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=keys.child
    JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=keys.parent AND pa.attname='id'
    WHERE fk.contype='f' AND fk.confrelid IN('public.rooms'::regclass,'public.income_expenses'::regclass,'public.reservation_deposit_settlements'::regclass,'public.income_expense_postings'::regclass)
  LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I WHERE %I IN(SELECT id FROM %I))',k.nspname,k.relname,k.attname,
      CASE k.parent_name WHEN 'rooms' THEN '_reservation_fixture_rooms' WHEN 'income_expenses' THEN '_reservation_fixture_vouchers' WHEN 'income_expense_postings' THEN '_reservation_fixture_postings' ELSE '_reservation_fixture_settlements' END) INTO leftover;
    IF leftover THEN RAISE EXCEPTION 'Cleanup left FK in %.%',k.nspname,k.relname; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.rooms WHERE id=${q.room}) OR EXISTS(SELECT 1 FROM public.income_expenses WHERE notes=${q.marker}) THEN RAISE EXCEPTION 'Fixture remains'; END IF;
END $verify$;
${dryRun ? 'ROLLBACK' : 'COMMIT'};`);
}
