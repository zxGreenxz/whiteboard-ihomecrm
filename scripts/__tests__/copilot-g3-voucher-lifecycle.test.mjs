import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../copilot-golden-browser-evidence.mjs';
const module = await import('../copilot-g3-voucher-lifecycle.mjs').catch(() => ({}));
const actor = '11111111-1111-4111-8111-111111111111';
const org = 'dddd0000-0000-4000-8000-000000000001';
const id = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const sha = 'a'.repeat(40);
function harness(caseNo = 3, options = {}) {
  assert.equal(typeof module.openG3Lifecycle, 'function', 'owned lifecycle must exist');
  const directory = mkdtempSync(join(tmpdir(), 'g3-test-'));
  const store = module.createG3FileStore({ directory });
  const attempt = module.createG3Attempt({ actorId: actor, caseNo, sourceSha: sha, buildSha: sha, runId: '100', runAttempt: '1', workflow: 'copilot-e2e.yml' });
  const calls = []; let plan; let voucher; let request;
  const canonical = { organization_id: org, type: 'EXPENSE', name: attempt.marker, amount: 1000, building_id: id(4), type_id: id(5), voucher_date: '2026-09-08' };
  const clone = value => structuredClone(value);
  const ok = body => ({ status: 200, body: clone(body) });
  let client = {
    async rpc(name, args) {
      calls.push({ name, args: clone(args) });
      const journal = JSON.parse(readFileSync(join(directory, 'journal.json'), 'utf8'));
      assert.equal(journal.operations.at(-1).outcome, 'intent', 'intent is durable before dispatch');
      if (name === 'copilot_preview_income_expense_v1') return ok({ canonical: options.wrongCanonical ? { ...canonical, name: 'historical marker' } : canonical });
      if (name === 'copilot_plan_create_v1') {
        plan = { ok: true, plan_id: id(1), organization_id: org, client_request_id: attempt.requestKey, plan_status: 'DRAFT', plan_version: 1, plan_digest: 'b'.repeat(64), da_ton_tai: false, created_at: new Date().toISOString(), consent_nonce: 'never-persist-this', step_count: caseNo === 3 ? 2 : 1, steps: [{ step_no: 1, action_id: 'income_expense.create_draft', status: 'PENDING', outcome: null, ref_step: null }, ...(caseNo === 3 ? [{ step_no: 2, action_id: 'income_expense.nop_ho_so', status: 'PENDING', outcome: null, ref_step: 1 }] : [])], ledger: [{ event: 'plan_created', plan_id: id(1), user_id: actor, organization_id: org, outcome: { client_request_id: attempt.requestKey } }] };
        if (options.replay) plan.da_ton_tai = true;
        if (options.absentCreate) { plan = undefined; throw Error('secret body'); }
        if (options.lostCreate) throw Error('secret body');
        return ok(plan);
      }
      if (name === 'copilot_plan_approve_v1') { plan.plan_status = 'APPROVED'; plan.plan_version = 2; return ok(plan); }
      if (name === 'copilot_plan_execute_step_v1') {
        if (options.hold && calls.filter(c => c.name === name).length === 2) await options.hold;
        const step = plan.steps[args.p_step_no - 1];
        if (step.status === 'DONE') return { status: 409, body: { code: '55000', message: 'plan_not_approved' } };
        if (args.p_step_no === 1) {
          voucher = { payment_id: null, payment_collection_id: null, salary_staff_id: null, shareholder_id: null, profit_manager_id: null, reversal_of_income_expense_id: null, handover_id: null, handover_transfer_id: null, posting_id: null, posted_at_v2: null, repeat_cycle: 'NONE', repeat_count: 0, repeat_infinity: false, repeat_auto_approve: false, repeat_next_date: null, repeat_parent_id: null, repeat_remaining: 0, id: id(2), organization_id: org, user_id: actor, name: attempt.marker, type: 'EXPENSE', total_amount: 1000, building_id: id(4), voucher_date: '2026-09-08', created_at: new Date().toISOString(), deleted_at: null, account_id: null, contract_id: null, invoice_id: null, room_id: null, system_source: null, active_posting_id_v2: null, reversed_by_posting_id: null, approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', posting_mode: 'CASHBOOK', review_state: 'DRAFT', approval_version: 1, posting_version: 1, items: [{ id: id(6), organization_id: org, income_expense_id: id(2), income_expense_type_id: id(5), description: attempt.marker, quantity: 1, unit_price: 1000 }] };
          step.outcome = { entity_table: 'income_expenses', entity_id: id(2) };
        } else if (!options.submitFails) {
          request = { id: id(3), subject_id: id(2), subject_type: 'FINANCIAL_VOUCHER', state: 'PENDING_APPROVAL', version: 1, is_maker: true, can_decide: false };
          step.outcome = { entity_table: 'approval_requests', entity_id: id(3) };
        }
        step.status = options.submitFails && args.p_step_no === 2 ? 'FAILED' : 'DONE';
        plan.plan_version++;
        plan.plan_status = step.status === 'FAILED' ? 'FAILED' : args.p_step_no === plan.step_count ? 'DONE' : 'APPROVED';
        if (step.status === 'DONE') plan.ledger.push({ event: 'step_done', step_no: args.p_step_no, action_id: step.action_id, plan_id: id(1), user_id: actor, organization_id: org, ...step.outcome, outcome: { idempotent: false } });
        if (options.lostExecute === args.p_step_no) throw Error('private response');
        return ok({ ok: step.status === 'DONE', step, plan_status: plan.plan_status, plan_version: plan.plan_version });
      }
      if (name === 'copilot_plan_cancel_v1') { plan.plan_status = 'CANCELLED'; plan.plan_version++; if (options.lostPlanCancel) throw Error('response lost'); return ok({ ok: true, plan_id: plan.plan_id }); }
      if (name === 'withdraw_financial_request_v1') {
        assert.equal(args.p_request_id, id(3)); assert.equal(request.state, 'PENDING_APPROVAL'); request.state = 'CANCELLED'; request.version++;
        if (options.lostWithdraw) throw Error('private response');
        return ok({ request_id: id(3), state: 'CANCELLED' });
      }
      if (name === 'cancel_income_expense_flex_v1') {
        assert.notEqual(request?.state, 'PENDING_APPROVAL', 'withdraw must precede cancel');
        assert.equal(args.p_voucher, id(2)); assert.equal(args.p_expected_approval_version, 1); assert.equal(args.p_expected_posting_version, 1);
        if (options.cancelRejects) return { status: 409, body: { code: '40001' } };
        voucher.approval_status = 'CANCELLED'; voucher.review_state = 'RESOLVED'; voucher.cancellation_kind = 'CANCELLED_UNPOSTED'; voucher.approval_version++;
        if (options.lostCancel) throw Error('private response');
        return ok({ id: id(2), changed: true, cancellation_kind: 'CANCELLED_UNPOSTED', reversal_posting_id: null });
      }
      throw Error(`unexpected RPC ${name}`);
    },
    async readPlan() { return clone(plan); }, async discoverPlans() { return plan ? [clone(plan)] : []; },
    async readVoucher() { return clone(voucher); }, async readPending() { return request?.state === 'PENDING_APPROVAL' ? [clone(request)] : []; }, async readRequest() { return clone(request); },
    async readMode() { return [{ organization_id: org, strict_mode: false }]; },
    async readAudit() { return [{ entity_id: id(2), entity_table: 'income_expenses', organization_id: org, user_id: actor, payload: canonical }]; },
    async verifyHistory(input) { return { kind: 'g3-history-authority-v1', complete: true, organizationId: org, voucherId: id(2), voucherDigest: input.voucherDigest, postingCount: 0, linkedEffectCount: 0, measuredAt: new Date().toISOString(), authorityDigest: 'c'.repeat(64) }; },
  };
  if (options.rest) {
    const model = client;
    client = module.createG3AppClient({ apiOrigin: 'https://test.supabase.co', actorId: actor, credentialProvider: async () => ({ actorId: actor, accessToken: 'test-token', apikey: 'test-key' }), verifyHistory: model.verifyHistory,
      fetch: async (url, init) => {
        assert.equal(init.headers.Authorization, 'Bearer test-token'); assert.equal(init.headers.apikey, 'test-key'); assert.equal(init.headers['Accept-Profile'], 'public'); assert.equal(init.redirect, 'error');
        const route = new URL(url), name = route.pathname.split('/').at(-1); let result;
        if (name === 'ai_write_audit') { assert.equal(init.method, 'GET'); assert.equal(route.searchParams.get('organization_id'), `eq.${org}`); assert.equal(route.searchParams.get('entity_id'), `eq.${id(2)}`); result = ok(await model.readAudit()); }
        else {
          assert.equal(init.method, 'POST'); assert.equal(init.headers['Content-Profile'], 'public'); const args = JSON.parse(init.body);
          if (name === 'copilot_plan_get_v1') { assert.deepEqual(args, { p_plan_id: id(1) }); result = ok(await model.readPlan()); }
          else if (name === 'get_income_expense_detail_v2') { assert.deepEqual(args, { p_id: id(2) }); result = ok(await model.readVoucher()); }
          else if (name === 'list_ie_accounting_standard_v1') { assert.deepEqual(args, {}); result = ok(await model.readMode()); }
          else if (name === 'list_my_pending_approvals_compat_v2') { assert.deepEqual(args, {}); result = ok(await model.readPending()); }
          else if (name === 'get_approval_request_detail_compat_v2') { assert.deepEqual(args, { p_request_id: id(3) }); result = ok(await model.readRequest()); }
          else result = await model.rpc(name, args);
        }
        return { status: result.status, ok: result.status === 200, json: async () => result.body };
      },
    });
  }
  const lifecycle = module.openG3Lifecycle({ attempt, store, client });
  return { lifecycle, attempt, store, client, calls, directory, get plan() { return plan; }, get voucher() { return voucher; }, get request() { return request; } };
}
async function execute(h, count = 2) { await h.lifecycle.create(); await h.lifecycle.approve({ nonce: 'secret', digest: h.plan.plan_digest, version: 1 }); for (let step = 1; step <= count; step++) await h.lifecycle.execute(step, step + 1); }
const cleanupCalls = h => h.calls.filter(c => /withdraw_financial|cancel_income/.test(c.name)).map(c => c.name);
test('same-day attempts create distinct normalized payloads and exact request keys', () => {
  const a = harness(8), b = harness(8); assert.notEqual(a.attempt.marker, b.attempt.marker); assert.match(a.attempt.marker, /g3:8:[0-9a-f-]{36}$/); assert.notEqual(a.attempt.requestKey, b.attempt.requestKey);
});
test('case 3 withdraws exact pending request before CAS cancel and persists released final receipt', async () => {
  const h = harness(); await execute(h); const r = await h.lifecycle.cleanup();
  assert.deepEqual(cleanupCalls(h), ['withdraw_financial_request_v1', 'cancel_income_expense_flex_v1']);
  assert.equal(r.state, 'finalized'); assert.equal(r.lockReleased, true); assert.equal(h.request.version, 2); assert.equal(h.voucher.approval_version, 2); assert.equal(existsSync(join(h.directory, 'lock.json')), false);
  assert.equal(readFileSync(join(h.directory, 'journal.json'), 'utf8').includes('never-persist-this'), false);
});
test('expected submit failure cleans voucher with no request mutation', async () => { const h = harness(3, { submitFails: true }); await execute(h); await h.lifecycle.cleanup(); assert.deepEqual(cleanupCalls(h), ['cancel_income_expense_flex_v1']); });
test('case 8 waits for both issued transports before cleanup, keeps one create', async () => {
  let release; const hold = new Promise(resolve => { release = resolve; }); const h = harness(8, { hold });
  await execute(h, 0); const pair = h.lifecycle.executePair(1, 2); const cleaning = h.lifecycle.cleanup();
  await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(cleanupCalls(h), []); release();
  await pair; await cleaning; assert.equal(h.plan.ledger.filter(r => r.event === 'step_done').length, 1); assert.equal(cleanupCalls(h).length, 1);
});
test('replayed create is never owned and cannot trigger a later mutation', async () => { const h = harness(8, { replay: true }); await assert.rejects(h.lifecycle.create()); await assert.rejects(h.lifecycle.cleanup()); assert.deepEqual(cleanupCalls(h), []); assert.equal(h.calls.length, 2); });
for (const options of [{ lostCreate: true }, { lostExecute: 1 }, { lostExecute: 2 }, { lostWithdraw: true }, { lostCancel: true }]) test(`lost response reconciles exact committed effect without duplicate RPC: ${JSON.stringify(options)}`, async () => {
  const h = harness(3, options); try { await execute(h); } catch { /* business remains failed */ } await h.lifecycle.cleanup(); assert.equal(h.calls.filter(c => c.name === 'copilot_plan_create_v1').length, 1); assert.ok(h.calls.filter(c => c.name === 'cancel_income_expense_flex_v1').length <= 1); assert.ok(h.calls.filter(c => c.name === 'withdraw_financial_request_v1').length <= 1);
});
for (const [field, value] of [['user_id', id(9)], ['organization_id', id(9)], ['name', 'E2E G3 ke hoach 2 buoc'], ['approval_status', 'APPROVED'], ['posting_status', 'POSTED'], ['active_posting_id_v2', id(9)], ['contract_id', id(9)], ['deleted_at', '2026-09-08'], ['total_amount', 2000], ['approval_version', 3]]) test(`changed/foreign ${field} stops before any compensation`, async () => {
  const h = harness(); await execute(h); h.voucher[field] = value; await assert.rejects(h.lifecycle.cleanup()); assert.deepEqual(cleanupCalls(h), []); assert.ok(existsSync(join(h.directory, 'lock.json')));
});
test('wrong request maker, subject or extra pending request blocks cancellation', async () => {
  for (const change of [r => { r.is_maker = false; }, r => { r.subject_id = id(9); }, r => { r.version = 4; }]) { const h = harness(); await execute(h); change(h.request); await assert.rejects(h.lifecycle.cleanup()); assert.deepEqual(cleanupCalls(h), []); }
  const h = harness(); await execute(h); h.client.readPending = async () => [h.request, { ...h.request, id: id(9) }]; await assert.rejects(h.lifecycle.cleanup()); assert.deepEqual(cleanupCalls(h), []);
});
test('business assertion failure still cleans and retains failure alongside cleanup category', async () => {
  const h = harness(8); await assert.rejects(h.lifecycle.run(async () => { await execute(h, 1); throw Error('original business assertion'); }), /original business assertion/); assert.equal(h.voucher.approval_status, 'CANCELLED');
  const broken = harness(8, { cancelRejects: true }); await assert.rejects(broken.lifecycle.run(async () => { await execute(broken, 1); throw Error('original'); }), error => error instanceof AggregateError && error.errors[0].message === 'original' && error.errors[1].message === 'g3_cleanup_unresolved');
});
test('missing authoritative history never masquerades as RLS proof or finalized acceptance', async () => { const h = harness(8); await execute(h, 1); h.client.verifyHistory = async () => null; await assert.rejects(h.lifecycle.cleanup()); assert.notEqual(h.store.load().state, 'finalized'); });
test('final write and lock release failures retain unresolved ownership and block new setup', async () => {
  for (const failure of ['save', 'release']) { const h = harness(8); await execute(h, 1); const original = h.store[failure]; h.store[failure] = (...args) => { if (failure === 'release' || args[0].state === 'finalized') throw Error('disk failure'); return original(...args); }; await assert.rejects(h.lifecycle.cleanup()); assert.notEqual(h.store.load().state, 'finalized'); assert.throws(() => module.openG3Lifecycle({ attempt: h.attempt, client: h.client, store: module.createG3FileStore({ directory: h.directory }) })); }
});
test('recovery before first write cannot create approve or execute', async () => {
  const h = harness(8); renameSync(join(h.directory, 'lock.json'), join(h.directory, 'quarantined-lock.json'));
  const recovery = module.openG3Lifecycle({ attempt: h.attempt, client: h.client, store: module.createG3FileStore({ directory: h.directory }), recovery: true });
  await assert.rejects(recovery.create()); await assert.rejects(recovery.approve({})); await assert.rejects(recovery.execute(1, 2)); await recovery.cleanup(); assert.deepEqual(h.calls, []);
});
test('REST adapter uses authenticated public RPC contract and preserves exact audit cursor precision', async () => {
  assert.equal(typeof module.createG3AppClient, 'function'); const calls = [];
  const client = module.createG3AppClient({ apiOrigin: 'https://test.supabase.co', actorId: actor, credentialProvider: async () => ({ actorId: actor, accessToken: 'test-token', apikey: 'test-key' }), fetch: async (url, init) => { calls.push({ url, init }); return { status: 200, ok: true, json: async () => ({ id: id(2) }) }; } });
  await client.rpc('cancel_income_expense_flex_v1', { p_voucher: id(2), p_reason: 'g3 cleanup', p_expected_approval_version: 1, p_expected_posting_version: 1 });
  assert.equal(calls[0].url, 'https://test.supabase.co/rest/v1/rpc/cancel_income_expense_flex_v1'); assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token'); assert.equal(calls[0].init.headers['Content-Profile'], 'public'); assert.equal(JSON.parse(calls[0].init.body).p_expected_posting_version, 1);
});
test('real REST lifecycle preserves withdrawal then dual-CAS cancellation and both version changes', async () => { const h = harness(3, { rest: true }); await execute(h); await h.lifecycle.cleanup(); assert.deepEqual(cleanupCalls(h), ['withdraw_financial_request_v1', 'cancel_income_expense_flex_v1']); assert.equal(h.request.version, 2); assert.equal(h.voucher.approval_version, 2); });
test('lost create with absent or duplicate discovery stays unresolved and never retries creation', async () => {
  for (const duplicate of [false, true]) { const h = harness(8, { absentCreate: !duplicate, lostCreate: duplicate }); await assert.rejects(h.lifecycle.create()); if (duplicate) h.client.discoverPlans = async () => [h.plan, h.plan]; await assert.rejects(h.lifecycle.cleanup()); assert.equal(h.calls.length, 2); assert.deepEqual(cleanupCalls(h), []); }
});
test('wrong step ledger entity/actor/action and unknown effects block every cleanup mutation', async () => {
  for (const change of [p => { p.ledger.at(-1).user_id = id(9); }, p => { p.ledger.at(-1).entity_id = id(9); }, p => { p.ledger.at(-1).action_id = 'income_expense.annotate'; }, p => { p.steps[0].status = 'UNKNOWN_EFFECT'; }, p => { p.ledger.push({ event: 'step_unknown_effect' }); }]) {
    const h = harness(8); await execute(h, 1); change(h.plan); const before = h.calls.length; await assert.rejects(h.lifecycle.cleanup()); assert.equal(h.calls.length, before);
  }
});
test('strict mode and stale/closed-period cancellation never retry or refresh CAS', async () => {
  const h = harness(8); await execute(h, 1); h.client.readMode = async () => [{ organization_id: org, strict_mode: true }]; await assert.rejects(h.lifecycle.cleanup()); assert.deepEqual(cleanupCalls(h), []);
  const blocked = harness(8, { cancelRejects: true }); await execute(blocked, 1); await assert.rejects(blocked.lifecycle.cleanup()); await assert.rejects(blocked.lifecycle.cleanup()); assert.equal(cleanupCalls(blocked).length, 1);
});
test('lost plan cancellation response is reconciled by exact terminal plan on recovery', async () => { const h = harness(8, { lostPlanCancel: true }); await h.lifecycle.create(); await assert.rejects(h.lifecycle.cleanup()); await h.lifecycle.cleanup(); assert.equal(h.calls.filter(c => c.name === 'copilot_plan_cancel_v1').length, 1); });
test('release-receipt failure cannot admit a successor and recovery cannot turn business green', async () => {
  const h = harness(8); await execute(h, 1); h.store.completeReleased = () => { throw Error('disk failure'); }; await assert.rejects(h.lifecycle.cleanup());
  assert.throws(() => module.openG3Lifecycle({ attempt: h.attempt, client: h.client, store: module.createG3FileStore({ directory: h.directory }) }));
  const recovery = module.openG3Lifecycle({ attempt: h.attempt, client: h.client, store: module.createG3FileStore({ directory: h.directory }), recovery: true }); await recovery.cleanup(); assert.equal(recovery.journal().business, 'interrupted');
});
test('canonical normalization cannot substitute a historical marker before plan creation', async () => { const h = harness(8, { wrongCanonical: true }); await assert.rejects(h.lifecycle.create()); assert.equal(h.calls.filter(c => c.name === 'copilot_plan_create_v1').length, 0); });
test('partial withdrawal is retained when cancellation fails and is never submitted or withdrawn again', async () => { const h = harness(3, { cancelRejects: true }); await execute(h); await assert.rejects(h.lifecycle.cleanup()); assert.equal(h.request.state, 'CANCELLED'); assert.equal(h.voucher.approval_status, 'UNAPPROVED'); await assert.rejects(h.lifecycle.cleanup()); assert.equal(h.calls.filter(c => c.name === 'withdraw_financial_request_v1').length, 1); assert.equal(h.calls.filter(c => c.name === 'copilot_plan_execute_step_v1').length, 2); });
test('discovery preserves microsecond cursor and refuses incomplete pages without calling create', async () => {
  const calls = []; const stamp = '2026-09-08T00:00:00.123456+00:00';
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: id(100 + i), created_at: stamp, organization_id: org, plan_id: null }));
  const client = module.createG3AppClient({ apiOrigin: 'https://test.supabase.co', actorId: actor, credentialProvider: async () => ({ actorId: actor, accessToken: 'test', apikey: 'key' }), fetch: async (url, init) => { const args = JSON.parse(init.body); calls.push({ url, args }); return { status: 200, json: async () => calls.length === 1 ? { version: 1, rows, total: 201 } : { version: 1, rows: [], total: 201 } }; } });
  await assert.rejects(client.discoverPlans({ startedAt: '2026-09-08T00:00:00Z', requestKey: 'g3:8:test' })); assert.equal(calls.length, 2); assert.equal(calls[1].args.p_after_at, stamp); assert.equal(calls[1].args.p_after_id, id(299)); assert.ok(calls.every(c => c.url.endsWith('/rpc/copilot_ledger_audit_page_v1')));
});
