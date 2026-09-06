import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doiChieuSo } from '../copilot-ledger-audit.mjs';

const org = 'dddd0000-0000-4000-8000-000000000001';
const bounds = { org, days: 14, since: '2026-09-01T00:00:00.000Z', until: '2026-09-06T00:00:00.000Z' };
const registry = [{ action_id: 'future.new_action', executor_kind: 'direct_l5_v1', risk: 'L5', grantable: false, pin_always: false }];
const row = (i, extra = {}) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, created_at: '2026-09-03T00:00:00.000001Z', organization_id: org,
  event: 'step_done', action_id: 'future.new_action', consent_kind: 'step_up', plan_id: 'plan', step_no: i,
  plan_present: true, plan_actor_matches: true, plan_org_matches: true, plan_consent_matches: true,
  consent_evidence: 'valid', entity_evidence: 'match', audit_present: true, audit_matches: true,
  action_executions: 1, step_links: 1, duplicate_executions: false, has_after_digest: true, idempotent: false, ...extra });
function source(rows = [], opts = {}) {
  return { async table() { return []; }, async rpc(jwt, name, args) {
    if (name === 'copilot_action_ledger_list_v1') return { status: 200, body: rows.slice(0, 200) };
    if (name === 'copilot_plan_get_v1') return { status: 200, body: { organization_id: org } };
    const all = args.p_stream === 'ledger' ? rows : (opts.audit ?? []);
    const filtered = all.filter(r => r.created_at >= args.p_since && r.created_at < args.p_until && (!args.p_after_id || r.created_at > args.p_after_at || (r.created_at === args.p_after_at && r.id > args.p_after_id)));
    return { status: 200, body: { version: 1, registry: opts.registry === undefined ? registry : opts.registry,
      total: all.length, missing_step_ledger: opts.missingSteps ?? 0, rows: filtered.slice(0, 200) } };
  } };
}
test('new DB L5 action cannot escape consent checks', async () => {
  const r = await doiChieuSo(source([row(1, { consent_kind: 'click' })]), 'jwt', bounds);
  assert.equal(r.counts.unintendedWrite, 1);
});
test('all 451 equal-microsecond rows are inspected exactly once', async () => {
  const rows = Array.from({ length: 451 }, (_, i) => row(i + 1, { consent_kind: i === 450 ? 'click' : 'step_up' }));
  const r = await doiChieuSo(source(rows), 'jwt', bounds);
  assert.equal(r.ledgerRowsInWindow, 451); assert.equal(r.counts.unintendedWrite, 1);
});
test('valid step-up evidence is clean but never claims a canary duration', async () => {
  const r = await doiChieuSo(source([row(1)]), 'jwt', bounds);
  assert.equal(r.status, 'clean'); assert.equal(r.canaryDurationVerified, false);
});
for (const bad of [null, [], [{}]]) test(`missing/malformed registry ${JSON.stringify(bad)} cannot green`, async () => {
  const r = await doiChieuSo(source([], { registry: bad }), 'jwt', bounds);
  assert.equal(r.status, 'incomplete');
});
for (const change of [{ plan_present: false }, { entity_evidence: 'unreadable' }, { consent_evidence: 'missing' }, { has_after_digest: false }]) {
  test(`missing historical source evidence cannot green: ${JSON.stringify(change)}`, async () => {
    const r = await doiChieuSo(source([row(1, change)]), 'jwt', bounds);
    assert.equal(r.status, 'incomplete'); assert.ok(r.counts.incomplete > 0);
  });
}
test('actor and org mismatches are proven violations', async () => {
  const r = await doiChieuSo(source([row(1, { plan_actor_matches: false, plan_org_matches: false })]), 'jwt', bounds);
  assert.equal(r.counts.wrongActor, 1); assert.equal(r.counts.wrongOrg, 1); assert.equal(r.status, 'violations');
});
test('standing grant requires eligible action and evidence; pin_always overrides eligibility', async () => {
  const eligible = [{ ...registry[0], grantable: true }];
  const r = await doiChieuSo(source([row(1, { consent_kind: 'standing_grant' })], { registry: eligible }), 'jwt', bounds);
  assert.equal(r.status, 'clean');
  const bad = await doiChieuSo(source([row(1, { consent_kind: 'standing_grant' })], { registry: [{ ...eligible[0], pin_always: true }] }), 'jwt', bounds);
  assert.equal(bad.counts.unintendedWrite, 1);
});
test('sequential runs cannot reuse old registry or entity evidence', async () => {
  assert.equal((await doiChieuSo(source([row(1)]), 'jwt', bounds)).status, 'clean');
  const r = await doiChieuSo(source([row(1, { entity_evidence: 'mismatch' })]), 'other-jwt', bounds);
  assert.equal(r.counts.wrongOrg, 1);
});
test('wrapper click consent is not plan consent; engine replay is not another execution', async () => {
  const r = await doiChieuSo(source([row(1, { event: 'action_executed', consent_kind: 'click' }), row(2, { idempotent: true })]), 'jwt', bounds);
  assert.equal(r.status, 'clean'); assert.equal(r.counts.duplicate, 0);
});
test('missing ledger counterpart and duplicated execution are distinguished', async () => {
  const r = await doiChieuSo(source([row(1, { duplicate_executions: true })], { missingSteps: 1 }), 'jwt', bounds);
  assert.equal(r.counts.duplicate, 1); assert.ok(r.counts.incomplete > 0);
});
test('missing consent kind is historical incompleteness, not proven misuse', async () => {
  const r = await doiChieuSo(source([row(1, { consent_kind: null })]), 'jwt', bounds);
  assert.equal(r.status, 'incomplete'); assert.equal(r.counts.unintendedWrite, 0);
});
test('actor mismatch on plan lifecycle events is checked too', async () => {
  const r = await doiChieuSo(source([row(1, { event: 'plan_approved', plan_actor_matches: false })]), 'jwt', bounds);
  assert.equal(r.counts.wrongActor, 1);
});
test('partial page, source error and missing count metadata cannot green', async () => {
  for (const client of [
    { rpc: async () => ({ status: 403 }) },
    { rpc: async () => ({ status: 200, body: { version: 1, registry, rows: [], total: 5, missing_step_ledger: 0 } }) },
    { rpc: async () => ({ status: 200, body: { version: 1, registry, rows: [] } }) },
  ]) assert.equal((await doiChieuSo(client, 'jwt', bounds)).status, 'incomplete');
});
test('audit stream pages beyond 200 and unknown audit actions cannot green', async () => {
  const audit = Array.from({length: 251}, (_, i) => row(i+1, { audit_id: `audit-${i}`, duplicate_key: i === 250, action_executions:1,step_links:1 }));
  const r = await doiChieuSo(source([], { audit }), 'jwt', bounds);
  assert.equal(r.auditRowsInWindow,251); assert.equal(r.counts.duplicate,1);
  const missing = await doiChieuSo(source([], {audit: [row(1,{action_id:'removed.action',duplicate_key:false})]}),'jwt',bounds);
  assert.equal(missing.status,'incomplete');
});
for (const step_links of [undefined, 'unknown', '1', -1, 0, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
  test(`audit rejects malformed step_links ${String(step_links)}`, async () => {
    const r = await doiChieuSo(source([], { audit: [row(1, {duplicate_key:false,step_links})] }), 'jwt', bounds);
    assert.equal(r.status, 'incomplete', 'malformed coverage must be incomplete');
  });
}
test('external queue consent cannot be skipped and pending is not success', async () => {
  const bad = await doiChieuSo(source([row(1,{event:'step_unknown_effect',consent_kind:'click',external_effect_status:'pending'})]),'jwt',bounds);
  assert.equal(bad.counts.unintendedWrite,1,'external consent must be checked');
  const pending = await doiChieuSo(source([row(1,{event:'step_unknown_effect',external_effect_status:'pending'})]),'jwt',bounds);
  assert.equal(pending.status,'incomplete','pending effect must not be clean success');
  assert.equal(pending.externalEffects.pending,1);
});

const legacyRegistry = [...registry,{action_id:'income_expense.create_draft',executor_kind:'nonce_abi_v1',risk:'L4',grantable:false,pin_always:false}];
const legacyAudit = extra => row(1,{event:undefined,action_id:'income_expense.create_draft',audit_tool:'tao_phieu_thu_chi_nhap',identity_mapping:'legacy_income_expense_draft_v1',duplicate_key:false,step_links:0,...extra});
test('legacy classification requires explicit server mapping and never adds L5 coverage',async()=>{
  for(const identity_mapping of [null,undefined,'unknown']) {
    const r=await doiChieuSo(source([],{registry:legacyRegistry,audit:[legacyAudit({identity_mapping})]}),'jwt',bounds);
    assert.equal(r.status,'incomplete'); assert.equal(r.knownLegacyL4.auditRows,0);
  }
  const r=await doiChieuSo(source([],{registry:legacyRegistry,audit:[legacyAudit({})]}),'jwt',bounds);
  assert.equal(r.status,'clean'); assert.deepEqual(r.directL5Actions,['future.new_action']);
  assert.equal(r.knownLegacyL4.auditRows,1); assert.equal(r.canaryDurationVerified,false);
});
for(const action_executions of [undefined,'1',0,2,-1,1.2]) test(`legacy historical coverage fails closed: ${action_executions}`,async()=>{
  const r=await doiChieuSo(source([],{registry:legacyRegistry,audit:[legacyAudit({action_executions})]}),'jwt',bounds);
  assert.equal(r.status,'incomplete','historical legacy gap must not green');
});
test('legacy canonical ledger preserves forward audit actor and org findings',async()=>{
  const r=await doiChieuSo(source([row(1,{action_id:'income_expense.create_draft',audit_matches:false,audit_actor_matches:false,audit_org_matches:false})],{registry:legacyRegistry}),'jwt',bounds);
  assert.equal(r.counts.wrongActor,1); assert.equal(r.counts.wrongOrg,1);
});
