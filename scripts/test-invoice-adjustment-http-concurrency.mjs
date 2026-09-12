// Post-deploy only: independent real-JWT HTTP requests against a DEMO fixture.
// No flag changes. Canonical reversals precede exact-ID revision fixture cleanup.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadSupabaseAdminConfig } from './apply-accounting-rollout.mjs';
import { DEMO_ORG_ID, DEMO_OWNER_EMAIL, runQuery, fixtureInvoiceSql, fixtureMarker,
  newRunId, sqlLiteral, uuidLiteral, committedFixtureTeardownSql,
  committedAdjustmentFixtureTeardownSql } from './lib/v5-collection-harness.mjs';

if (!process.argv.includes('--execute')) {
  console.log('Prepared only. Use --execute after the reviewed adjustment migration is deployed.');
  process.exit(0);
}
const config = loadSupabaseAdminConfig({ readFile: (path, encoding) => readFileSync(
  String(path).includes('CLAUDE.local.md') && process.env.IHOMECRM_SECRET_FILE
    ? process.env.IHOMECRM_SECRET_FILE : path, encoding) });
const query = sql => runQuery(sql, config);
const migration = readFileSync(new URL('../supabase/migrations/20260912065909_invoice_adjustment_atomic_revisions.sql', import.meta.url), 'utf8');
assert.equal(createHash('sha256').update(migration).digest('hex'),
  'a7ae6673c7a7510260bcd4659499973750c32d9cfae19c6ae831d7c7331db2ae', 'Expected reviewed migration bytes');
for (const signature of [
  'public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text)',
  'public.review_invoice_adjustment_v2(uuid,bigint)',
  'app_private.proved_legacy_invoice_pnl_v2(uuid,uuid)',
]) {
  const name = signature.slice(0, signature.indexOf('('));
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert(start >= 0, `Missing reviewed function ${name}`);
  const bodyStart = migration.indexOf('AS $$', start) + 5;
  const bodyEnd = migration.indexOf('$$', bodyStart);
  assert(bodyStart > start && bodyEnd > bodyStart);
  const expected = createHash('md5').update(migration.slice(bodyStart, bodyEnd)).digest('hex');
  const deployed = (await query(`SELECT md5(p.prosrc) AS digest FROM pg_proc p WHERE p.oid=to_regprocedure(${sqlLiteral(signature)});`))[0];
  assert.equal(deployed?.digest, expected, `Reviewed function ${name} is not deployed; no fixture created`);
}
const origin = `https://${config.projectRef}.supabase.co`;
const localEnv = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  ?? localEnv.match(/^VITE_SUPABASE_PUBLISHABLE_KEY=["']?([^"'\r\n]+)/m)?.[1];
const password = process.env.IHOMECRM_DEMO_PASSWORD ?? process.env.FLEET_PASS_CHUNHA;
assert(key && password, 'Missing DEMO credentials/public API key; no fixture created');
const pre = (await query(`SELECT
  to_regprocedure('public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamptz,text)') IS NOT NULL AS deployed,
  (SELECT id FROM auth.users WHERE email=${sqlLiteral(DEMO_OWNER_EMAIL)}) AS actor_id,
  public.org_today_v1('${DEMO_ORG_ID}') AS today,
  app_private.evaluate_feature_route('invoice.collection.v5','${DEMO_ORG_ID}') AS collect_route,
  app_private.evaluate_feature_route('invoice.collection.reverse.v5','${DEMO_ORG_ID}') AS reverse_route;`))[0];
assert.equal(pre.deployed, true, 'Adjustment v2 is not deployed; no fixture created');
assert.equal(pre.collect_route, 'CANONICAL');
assert.equal(pre.reverse_route, 'CANONICAL');
const login = await fetch(`${origin}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: DEMO_OWNER_EMAIL, password }), signal: AbortSignal.timeout(30000),
});
assert(login.ok, `DEMO login failed (${login.status}); no fixture created`);
const session = await login.json();
assert.equal(session.user?.id, pre.actor_id);
const roleSessions = {};
for (const [role, email, rolePassword] of [
  ['manager', 'demo.quanly@username.ihomecrm.local', process.env.FLEET_PASS_QUANLY],
  ['accountant', 'demo.ketoan@username.ihomecrm.local', process.env.FLEET_PASS_KETOAN],
]) {
  assert(rolePassword, `Missing DEMO ${role} credentials; no fixture created`);
  const response = await fetch(`${origin}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: rolePassword }), signal: AbortSignal.timeout(30000),
  });
  assert(response.ok, `DEMO ${role} login failed (${response.status}); no fixture created`);
  roleSessions[role] = await response.json();
}
async function rpc(name, payload, authenticated = true, accessToken = session.access_token) {
  const response = await fetch(`${origin}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(45000),
  });
  return { ok: response.ok, status: response.status, body: await response.json() };
}
function success(result, label) {
  assert(result.ok, `${label}: HTTP ${result.status} ${result.body.code ?? ''} ${result.body.message ?? ''}`);
  return result.body;
}
async function requestPair(...requests) {
  const settled = await Promise.allSettled(requests);
  const rejected = settled.filter(result => result.status === 'rejected');
  if (rejected.length) throw new AggregateError(rejected.map(result => result.reason), 'Concurrent requests failed after both settled');
  return settled.map(result => result.value);
}
const run = newRunId(), marker = fixtureMarker(`adjustment-http-${run}`), month = '2097-10';
let fixture;
const trackedCollections = [];
const idList = ids => ids.map(uuidLiteral).join(',');
const invoiceState = async () => (await query(`SELECT i.*,
  (SELECT jsonb_agg(to_jsonb(line) ORDER BY line.sort_order,line.id) FROM public.invoice_items line WHERE line.invoice_id=i.id) AS items,
  (SELECT count(*) FROM public.invoice_adjustments a WHERE a.invoice_id=i.id) AS revisions
  FROM public.invoices i WHERE i.id=${uuidLiteral(fixture.invoice_id)} AND i.organization_id='${DEMO_ORG_ID}';`))[0];
const document = (rent, deposit) => [
  { type: 'RENT', accounting_class: 'REVENUE', description: 'HTTP fixture rent', unit_price: rent, quantity: 1, coefficient: 1, sort_order: 1 },
  { type: 'OTHER', accounting_class: 'DEPOSIT', description: 'HTTP fixture deposit', unit_price: deposit, quantity: 1, coefficient: 1, sort_order: 2 },
];
function adjustment(state, rent, deposit, suffix) {
  return { p_invoice_id: fixture.invoice_id, p_after_items: document(rent, deposit),
    p_discount_amount: 0, p_discount_notes: null, p_notes: marker,
    p_reason: `DEMO HTTP concurrency ${suffix}`, p_expected_revision: Number(state.adjustment_revision),
    p_expected_paid_amount: Number(state.paid_amount), p_expected_updated_at: state.updated_at,
    p_idempotency_key: `adjustment-http-${run}-${suffix}` };
}
function collection(state, amount, suffix) {
  return { p_invoice_id: fixture.invoice_id, p_collection_date: pre.today,
    p_tenders: [{ payment_method: 'TM', gross_amount: amount, account_id: fixture.account_id }],
    p_overpay_action: 'REJECT', p_allow_rounding: false, p_notes: marker, p_receipt_image_url: null,
    p_expected_paid_amount: Number(state.paid_amount), p_idempotency_key: `adjustment-http-${run}-${suffix}` };
}
const history = async collectionId => (await query(`SELECT
  (SELECT count(*) FROM public.payments p WHERE p.collection_id=${uuidLiteral(collectionId)}) AS payments,
  (SELECT count(*) FROM public.finance_invoice_component_allocations a WHERE a.collection_id=${uuidLiteral(collectionId)}) AS allocations,
  (SELECT count(*) FROM public.income_expense_postings p JOIN public.income_expenses v ON v.id=p.voucher_id WHERE v.payment_collection_id=${uuidLiteral(collectionId)}) AS postings,
  (SELECT count(*) FROM public.income_expense_posting_lines l JOIN public.income_expense_postings p ON p.id=l.posting_id JOIN public.income_expenses v ON v.id=p.voucher_id WHERE v.payment_collection_id=${uuidLiteral(collectionId)}) AS lines,
  (SELECT coalesce(sum(l.signed_amount),0) FROM public.income_expense_posting_lines l JOIN public.income_expense_postings p ON p.id=l.posting_id JOIN public.income_expenses v ON v.id=p.voucher_id WHERE v.payment_collection_id=${uuidLiteral(collectionId)} AND l.account_id=${uuidLiteral(fixture.account_id)}) AS cash_amount,
  md5(jsonb_build_object(
    'payments',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.payments p WHERE p.collection_id=${uuidLiteral(collectionId)}),
    'allocations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.finance_invoice_component_allocations a WHERE a.collection_id=${uuidLiteral(collectionId)}),
    'postings',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.income_expense_postings p JOIN public.income_expenses v ON v.id=p.voucher_id WHERE v.payment_collection_id=${uuidLiteral(collectionId)}),
    'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.income_expense_posting_lines l JOIN public.income_expense_postings p ON p.id=l.posting_id JOIN public.income_expenses v ON v.id=p.voucher_id WHERE v.payment_collection_id=${uuidLiteral(collectionId)})
  )::text) AS digest;`))[0];

try {
  const rows = await query(`BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';
    ${fixtureInvoiceSql({ marker, billingMonth: month, rent: 100000, deposit: 20000 })}
    INSERT INTO public.cashbook_possession_bindings(organization_id,cashbook_id,membership_id,possession_kind,valid_from,reason)
    SELECT m.organization_id,current_setting('v5h.account_tm')::uuid,m.id,'KNOWER',now()-interval '1 minute',${sqlLiteral(marker)}
    FROM public.organization_memberships m WHERE m.organization_id='${DEMO_ORG_ID}'
      AND m.user_id=current_setting('v5h.actor')::uuid AND m.status='ACTIVE'
      AND NOT app_private.ie_has_cashbook_possession_v1(m.organization_id,current_setting('v5h.account_tm')::uuid,m.id);
    SELECT current_setting('v5h.invoice') AS invoice_id,current_setting('v5h.account_tm') AS account_id,
      current_setting('v5h.building') AS building_id; COMMIT;`);
  fixture = rows.find(row => row.invoice_id);
  assert(fixture);
  for (const [role, expectedAccess, expectedApprove] of [['manager', false, false], ['accountant', true, false]]) {
    const permission = (await query(`BEGIN;
      SELECT set_config('request.jwt.claims',jsonb_build_object('sub',${uuidLiteral(roleSessions[role].user.id)},'role','authenticated')::text,true);
      SET LOCAL ROLE authenticated;
      SELECT public.can_access_building(${uuidLiteral(fixture.building_id)}) AS can_access,
        public.can_do_on_building('invoices','approve',${uuidLiteral(fixture.building_id)}) AS can_approve;
      ROLLBACK;`)).find(row => 'can_access' in row);
    assert.equal(permission?.can_access, expectedAccess, `Fixture must exercise the DEMO ${role} building scope`);
    assert.equal(permission?.can_approve, expectedApprove, `Fixture must exercise the DEMO ${role} review denial`);
  }
  const beforeDenied = await invoiceState();
  const outsideBuilding = await rpc('adjust_invoice_v2', adjustment(beforeDenied, 80000, 30000, 'cross-building'), true, roleSessions.manager.access_token);
  assert.equal(outsideBuilding.ok, false); assert.equal(outsideBuilding.body.code, '42501');
  assert.deepEqual(await invoiceState(), beforeDenied, 'Denied building edit changed invoice');
  const first = success(await rpc('record_invoice_collection_v5', collection(await invoiceState(), 50000, 'initial-payment')), 'Initial collection');
  trackedCollections.push(first.collection_id);
  const original = await history(first.collection_id);
  assert(Number(original.payments) > 0 && Number(original.allocations) > 0 && Number(original.postings) > 0 && Number(original.lines) > 0, 'History proof must be nonempty');
  assert.equal(Number(original.cash_amount), 50000, 'Initial cash posting must prove the collected amount');
  assert.deepEqual(await query(`SELECT c.component_kind,sum(a.amount)::bigint AS amount,m.adjustment_revision
    FROM public.finance_invoice_component_allocations a JOIN public.finance_invoice_components c ON c.id=a.component_id
    JOIN public.invoice_payment_collections p ON p.id=a.collection_id
    JOIN public.finance_invoice_component_manifests m ON m.id=p.component_manifest_id
    WHERE a.collection_id=${uuidLiteral(first.collection_id)} GROUP BY c.component_kind,m.adjustment_revision;`),
  [{ component_kind: 'CURRENT_CHARGE', amount: 50000, adjustment_revision: 0 }], 'Initial allocation must be pinned to revision zero');

  const request = adjustment(await invoiceState(), 80000, 30000, 'same-key');
  const omittedNotes = { ...request };
  delete omittedNotes.p_discount_notes;
  const same = await requestPair(rpc('adjust_invoice_v2', omittedNotes), rpc('adjust_invoice_v2', request));
  assert.deepEqual(success(same[0], 'same-key A'), success(same[1], 'same-key B'));
  assert.equal(Number((await invoiceState()).revisions), 1);
  const mismatch = await rpc('adjust_invoice_v2', { ...request, p_discount_amount: 1000 });
  assert.equal(mismatch.ok, false); assert.equal(mismatch.body.code, '23505');
  const denied = await rpc('adjust_invoice_v2', request, false);
  assert.equal(denied.ok, false); assert.equal(denied.body.code, '42501');
  console.log('PASS same-key independent HTTP replay, payload mismatch, anonymous deny');

  const beforeRace = await invoiceState();
  const competing = await requestPair(
    rpc('adjust_invoice_v2', adjustment(beforeRace, 90000, 30000, 'compete-a')),
    rpc('adjust_invoice_v2', adjustment(beforeRace, 100000, 30000, 'compete-b')),
  );
  assert.equal(competing.filter(result => result.ok).length, 1, 'Exactly one stale adjustment may win');
  assert.equal(competing.find(result => !result.ok).body.code, '40001');
  assert.equal(Number((await invoiceState()).revisions), 2);
  console.log('PASS different-key competing adjustments: one revision, one stale conflict');

  const state = await invoiceState();
  const [edit, pay] = await requestPair(
    rpc('adjust_invoice_v2', adjustment(state, 60000, 60000, 'edit-vs-pay')),
    rpc('record_invoice_collection_v5', collection(state, 40000, 'pay-vs-edit')),
  );
  const collected = success(pay, 'Payment vs adjustment');
  trackedCollections.push(collected.collection_id);
  if (!edit.ok) assert.equal(edit.body.code, '40001');
  const afterRace = await invoiceState();
  assert.equal(Number(afterRace.paid_amount), 90000);
  assert.equal(Number(afterRace.revisions), edit.ok ? 3 : 2);
  const parts = await query(`SELECT c.component_kind,sum(a.amount)::bigint AS amount
    FROM public.finance_invoice_component_allocations a JOIN public.finance_invoice_components c ON c.id=a.component_id
    WHERE a.collection_id=${uuidLiteral(collected.collection_id)} GROUP BY c.component_kind ORDER BY c.component_kind;`);
  assert.deepEqual(parts, edit.ok
    ? [{ component_kind: 'CURRENT_CHARGE', amount: 10000 }, { component_kind: 'CURRENT_DEPOSIT', amount: 30000 }]
    : [{ component_kind: 'CURRENT_CHARGE', amount: 40000 }]);
  const pin = (await query(`SELECT m.adjustment_revision FROM public.invoice_payment_collections c
    JOIN public.finance_invoice_component_manifests m ON m.id=c.component_manifest_id WHERE c.id=${uuidLiteral(collected.collection_id)};`))[0];
  assert.equal(Number(pin.adjustment_revision), Number(afterRace.adjustment_revision));
  assert.deepEqual(await history(first.collection_id), original, 'Original payment/allocation/posting history changed');
  console.log('PASS adjustment vs collection: valid serial order, exact component allocation and immutable original history');

  const latest = (await query(`SELECT id,revision,to_jsonb(a)-'review_status'-'checked_by'-'checked_at' AS snapshot
    FROM public.invoice_adjustments a WHERE invoice_id=${uuidLiteral(fixture.invoice_id)} ORDER BY revision DESC LIMIT 1;`))[0];
  const deniedReview = await rpc('review_invoice_adjustment_v2', { p_adjustment_id: latest.id, p_expected_revision: Number(latest.revision) }, true, roleSessions.accountant.access_token);
  assert.equal(deniedReview.ok, false); assert.equal(deniedReview.body.code, '42501');
  assert.equal((await invoiceState()).adjustment_review_status, 'PENDING', 'Forbidden review changed state');
  const checked = success(await rpc('review_invoice_adjustment_v2', { p_adjustment_id: latest.id, p_expected_revision: Number(latest.revision) }), 'Review');
  assert.equal(checked.review_status, 'CHECKED');
  const reviewed = (await query(`SELECT to_jsonb(a)-'review_status'-'checked_by'-'checked_at' AS snapshot
    FROM public.invoice_adjustments a WHERE id=${uuidLiteral(latest.id)};`))[0];
  assert.deepEqual(reviewed.snapshot, latest.snapshot, 'Review changed immutable adjustment document');
  assert.equal((await invoiceState()).adjustment_review_status, 'CHECKED');
  assert.deepEqual(await history(first.collection_id), original);
  console.log('PASS real-JWT cross-building/review denial; owner review preserves document and money history');

  await assert.rejects(query(committedFixtureTeardownSql({ marker, actorId: pre.actor_id })), /lịch sử điều chỉnh\/cấn trừ/);
  await assert.rejects(query(committedAdjustmentFixtureTeardownSql({ marker, actorId: pre.actor_id, invoiceId: '00000000-0000-4000-8000-000000000001' })), /invoice ID không khớp marker/);
  assert.equal(Number((await invoiceState()).paid_amount), 90000, 'Rejected cleanup must roll back all reversals');
  console.log('PASS cleanup guards: ordinary helper and wrong invoice ID fail without changing money');
} finally {
  // Discover by unique marker even if a committed setup response was lost.
  const existing = await query(`SELECT id FROM public.invoices WHERE organization_id='${DEMO_ORG_ID}' AND notes=${sqlLiteral(marker)};`);
  assert(existing.length <= 1, 'Ambiguous fixture marker; refusing cleanup');
  if (fixture?.invoice_id) {
    const exact = await query(`SELECT id,notes,organization_id FROM public.invoices WHERE id=${uuidLiteral(fixture.invoice_id)};`);
    assert(exact.length === 0 || (exact[0].organization_id === DEMO_ORG_ID && exact[0].notes === marker),
      `Fixture ${fixture.invoice_id} still exists but lost its identity marker; cleanup refused and requires recovery`);
    assert(existing.length === 0 || existing[0].id === fixture.invoice_id, 'Marker points to another invoice; cleanup refused');
  }
  if (existing.length) {
    const invoiceId = existing[0].id;
    const collections = await query(`SELECT id FROM public.invoice_payment_collections WHERE invoice_id=${uuidLiteral(invoiceId)};`);
    const vouchers = await query(`SELECT id FROM public.income_expenses WHERE invoice_id=${uuidLiteral(invoiceId)}
      OR payment_collection_id IN(SELECT id FROM public.invoice_payment_collections WHERE invoice_id=${uuidLiteral(invoiceId)});`);
    await query(committedAdjustmentFixtureTeardownSql({ marker, actorId: pre.actor_id, invoiceId }));
    for (const table of ['invoices', 'invoice_adjustments', 'invoice_items', 'invoice_payment_collections', 'payments',
      'finance_invoice_component_allocations', 'finance_invoice_components', 'finance_invoice_component_manifests']) {
      const column = table === 'invoices' ? 'id' : 'invoice_id';
      assert.deepEqual(await query(`SELECT ${column} FROM public.${table} WHERE ${column}=${uuidLiteral(invoiceId)}`), [], `Leftover ${table}`);
    }
    if (collections.length) {
      for (const table of ['invoice_payment_tenders', 'invoice_payment_allocations', 'finance_invoice_component_allocations']) {
        assert.deepEqual(await query(`SELECT collection_id FROM public.${table} WHERE collection_id IN(${idList(collections.map(row => row.id))})`), [], `Leftover ${table}`);
      }
    }
    if (vouchers.length) {
      assert.deepEqual(await query(`SELECT id FROM public.income_expense_postings WHERE voucher_id IN(${idList(vouchers.map(row => row.id))})`), []);
      assert.deepEqual(await query(`SELECT income_expense_id FROM app_private.income_expense_cancellations WHERE income_expense_id IN(${idList(vouchers.map(row => row.id))})`), []);
    }
  }
  await query(`DELETE FROM public.cashbook_possession_bindings WHERE organization_id='${DEMO_ORG_ID}' AND reason=${sqlLiteral(marker)};`);
  console.log(`DEMO fixture reversed and cleaned; ${trackedCollections.length} tracked collections, audit chains retained`);
}
