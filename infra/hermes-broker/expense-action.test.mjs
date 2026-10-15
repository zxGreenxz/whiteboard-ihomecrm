import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { setup, ACTION_PATH, binding, token, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, CASHBOOK, FOREIGN_CASHBOOK, CATEGORY, RESTRICTED_CATEGORY, HIDDEN_CATEGORY,
  USER, ORG, FOREIGN, SESSION, ASSISTANT } from './finance-fixture.mjs';
import { EXPENSE_ACTION_TOOLS, EXPENSE_ACTIONS, expenseActionInput, expenseActionOperation, expenseActionResult, mayUseExpenseAction } from './expense-action-contract.mjs';
import { createExpenseActionAuth, createExpenseActionReads, createExpenseActionService } from './expense-action-adapter.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

const code = expected => error => error.code === expected;
const identity = { row: { organizationId: ORG, userId: USER } };
// Synthetic fixture amounts only.
const create = (extra = {}) => ({ requestId: randomUUID(), buildingId: BUILDING, roomId: ROOM, cashbookId: CASHBOOK, voucherDate: '2026-10-15',
  name: 'Sửa điện phòng', vendor: null, lines: [{ categoryId: CATEGORY, amount: 150000, description: 'Thay ổ cắm' }], ...extra });
const nothingWritten = async (env, before) => assert.deepEqual(await env.counts(), before, 'no voucher, receipt or audit');
const enableApproveOverlay = db => db.exec(`UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='income_expenses.approve';
  UPDATE app_private.hermes_connections SET action_capabilities=action_capabilities||ARRAY['income_expenses.approve'];
  UPDATE app_private.hermes_org_policies SET action_capabilities=action_capabilities||ARRAY['income_expenses.approve'];`);

// Reusable controls; the mutation test proves each can turn red.
const checks = {
  async pending(env) {
    await env.db.exec('UPDATE public.fixture_writer SET threshold=100000');
    try {
      const input = create(), before = await env.counts();
      const result = await env.expense('create', expenseActionInput('expense.create', input));
      assert.equal(result.outcome, 'applied'); assert.equal(result.voucher.approvalStatus, 'UNAPPROVED', 'ladder threshold keeps it pending');
      assert.deepEqual(expenseActionResult('expense.create', result, identity, input), result);
      assert.deepEqual(await env.counts(), { vouchers: before.vouchers + 1, receipts: before.receipts + 1, audits: before.audits + 1 });
      assert.deepEqual(await env.expense('create', input), result, 'same requestId replays the receipt');
      assert.deepEqual(await env.expense('status', { requestId: input.requestId }), result);
      await assert.rejects(env.expense('create', { ...input, lines: [{ ...input.lines[0], amount: 160000 }] }), code('PT409'), 'changed intent');
      assert.equal((await env.counts()).vouchers, before.vouchers + 1);
    } finally { await env.db.exec('UPDATE public.fixture_writer SET threshold=null'); }
  },
  async approverWithoutOverlay(env) {
    await env.db.query('INSERT INTO public.fixture_approvers VALUES($1)', [BUILDING]);
    try { const before = await env.counts(); await assert.rejects(env.expense('create', create()), code('42501')); await nothingWritten(env, before); }
    finally { await env.db.exec('DELETE FROM public.fixture_approvers'); }
  },
  async overlayBuilding(env) {
    const before = await env.counts();
    await assert.rejects(env.expense('create', create({ buildingId: OTHER_BUILDING, roomId: OTHER_ROOM })), code('42501'), 'CRM allows, Hermes overlay does not');
    await nothingWritten(env, before);
  },
  async registry(env) {
    await env.db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='income_expenses.create'");
    try { const before = await env.counts(); await assert.rejects(env.expense('create', create()), code('42501')); await nothingWritten(env, before); }
    finally { await env.db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='income_expenses.create'"); }
  },
  async connection(env) {
    await env.db.exec("UPDATE app_private.hermes_connections SET action_capabilities=array_remove(action_capabilities,'income_expenses.create')");
    try { const before = await env.counts(); await assert.rejects(env.expense('create', create()), code('42501')); await nothingWritten(env, before); }
    finally { await env.db.exec("UPDATE app_private.hermes_connections SET action_capabilities=action_capabilities||ARRAY['income_expenses.create']"); }
  },
  async category(env) {
    const before = await env.counts();
    for (const categoryId of [RESTRICTED_CATEGORY, HIDDEN_CATEGORY])
      await assert.rejects(env.expense('create', create({ lines: [{ categoryId, amount: 1000, description: null }] })), code('22023'));
    await nothingWritten(env, before);
  },
};

test('expense contract: fixed tools, exact input, integer VND, no approval/bank/actor fields; result bound to the request', () => {
  assert.deepEqual(EXPENSE_ACTION_TOOLS.map(tool => tool.name), ['crm_expense_input_options', 'crm_expense_create', 'crm_expense_status']);
  assert.deepEqual(EXPENSE_ACTIONS, ['income_expenses.create', 'income_expenses.approve']);
  assert.equal(mayUseExpenseAction({ action: ['income_expenses.approve'] }, 'expense.create'), false, 'approve overlay alone grants no tool');
  assert.equal(mayUseExpenseAction({ action: ['income_expenses.create'] }, expenseActionOperation('crm_expense_create')), true);
  const input = create();
  assert.deepEqual(expenseActionInput('expense.create', input), input);
  for (const changed of [{ ...input, approvalStatus: 'APPROVED' }, { ...input, receiveBankAccount: '0123' }, { ...input, organizationId: FOREIGN },
    { ...input, name: 'x\ny' }, { ...input, name: ' x' }, { ...input, voucherDate: '2026-02-30' }, { ...input, lines: [] },
    { ...input, lines: Array.from({ length: 21 }, () => input.lines[0]) }, { ...input, lines: [{ ...input.lines[0], amount: 1.5 }] },
    { ...input, lines: [{ ...input.lines[0], amount: '150000' }] }, { ...input, lines: [{ ...input.lines[0], amount: 0 }] },
    { ...input, lines: [{ ...input.lines[0], amount: 9_999_999_999_999 }, { ...input.lines[0], amount: 1 }] }, { ...input, lines: [{ ...input.lines[0], tax: 1 }] }])
    assert.throws(() => expenseActionInput('expense.create', changed), JSON.stringify(changed).slice(0, 80));
  for (const options of [{ kind: 'rooms' }, { kind: 'buildings', buildingId: BUILDING }, { kind: 'accounts' }, { kind: 'cashbooks', limit: 51 }])
    assert.throws(() => expenseActionInput('expense.options', options));
  const voucher = { id: randomUUID(), code: 'PC-1', buildingId: BUILDING, roomId: ROOM, cashbookId: CASHBOOK, voucherDate: input.voucherDate,
    totalAmount: '150000.00', approvalStatus: 'UNAPPROVED', lineCount: 1, createdBy: USER };
  const result = { organizationId: ORG, requestId: input.requestId, outcome: 'applied', voucher };
  assert.deepEqual(expenseActionResult('expense.create', result, identity, input), result);
  for (const changed of [{ ...voucher, buildingId: OTHER_BUILDING }, { ...voucher, totalAmount: '150001.00' }, { ...voucher, createdBy: FOREIGN },
    { ...voucher, approvalStatus: 'CANCELLED' }, { ...voucher, accountNumber: '1' }, { ...voucher, lineCount: 2 }])
    assert.throws(() => expenseActionResult('expense.create', { ...result, voucher: changed }, identity, input));
  assert.throws(() => expenseActionResult('expense.create', { ...result, outcome: 'not_found', voucher: null }, identity, input), 'create never reports not_found');
  const labels = { organizationId: ORG, kind: 'cashbooks', buildingId: null, items: [{ id: CASHBOOK, label: 'Quỹ 0123456789' }], nextCursor: null };
  assert.throws(() => expenseActionResult('expense.options', labels, identity, expenseActionInput('expense.options', { kind: 'cashbooks' })), 'account-like digits');
});

test('expense SQL: canonical writer port, overlay/CRM/registry/approval controls, durable receipt; no live writer or JWT proof', { timeout: 120000 }, async t => {
  const env = await setup(t), { db, expense, counts } = env;
  await t.test('choices are labels within CRM create scope and the Hermes overlay; cashbook numbers are masked', async () => {
    const options = kind => expense('options', expenseActionInput('expense.options', { kind, ...(kind === 'rooms' ? { buildingId: BUILDING } : {}) }));
    assert.deepEqual((await options('buildings')).items, [{ id: BUILDING, label: 'Toà A' }]);
    assert.deepEqual((await options('rooms')).items, [{ id: ROOM, label: 'P101' }]);
    assert.deepEqual((await options('categories')).items, [{ id: CATEGORY, label: 'Sửa chữa' }]);
    const cashbooks = await options('cashbooks');
    assert.deepEqual(cashbooks.items, [{ id: CASHBOOK, label: 'Quỹ VCB ***' }]);
    assert.deepEqual(expenseActionResult('expense.options', cashbooks, identity, expenseActionInput('expense.options', { kind: 'cashbooks' })), cashbooks);
    await assert.rejects(expense('options', expenseActionInput('expense.options', { kind: 'rooms', buildingId: OTHER_BUILDING })), code('42501'));
  });
  await t.test('below-threshold machine approval follows the ladder; threshold keeps pending; receipt replays exactly', async () => {
    const before = await counts(), input = create();
    const approved = await expense('create', input);
    assert.equal(approved.voucher.approvalStatus, 'APPROVED', 'org rule (no threshold) approves at birth, not Hermes');
    assert.equal((await counts()).vouchers, before.vouchers + 1);
    const audit = (await db.query("SELECT new_state FROM public.authorization_audit_events WHERE event_type='HERMES_EXPENSE_CREATED' ORDER BY occurred_at DESC LIMIT 1")).rows[0].new_state;
    assert.equal(audit.approveOverlay, false); assert.equal(audit.requestId, input.requestId);
    await checks.pending(env);
    const unknownId = randomUUID();
    assert.deepEqual(await expense('status', { requestId: unknownId }), { organizationId: ORG, requestId: unknownId, outcome: 'not_found', voucher: null });
    assert.deepEqual(await expense('status', { requestId: input.requestId }), approved);
  });
  await t.test('approve-capable maker needs the approve overlay; with it the canonical ladder may approve', async () => {
    await checks.approverWithoutOverlay(env);
    await enableApproveOverlay(db);
    await db.query('INSERT INTO public.fixture_approvers VALUES($1)', [BUILDING]);
    await db.exec('UPDATE public.fixture_writer SET threshold=1');
    try { assert.equal((await expense('create', create())).voucher.approvalStatus, 'APPROVED'); }
    finally { await db.exec(`DELETE FROM public.fixture_approvers; UPDATE public.fixture_writer SET threshold=null;
      UPDATE app_private.hermes_connections SET action_capabilities=array_remove(action_capabilities,'income_expenses.approve');
      UPDATE app_private.hermes_org_policies SET action_capabilities=array_remove(action_capabilities,'income_expenses.approve');
      UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='income_expenses.approve';`); }
  });
  await t.test('overlay building, registry, connection, CRM grant, category, cashbook and organization deny without writing', async () => {
    await checks.overlayBuilding(env); await checks.registry(env); await checks.connection(env); await checks.category(env);
    const before = await counts();
    await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='income_expenses.create'");
    await assert.rejects(expense('create', create()), code('42501'));
    await db.exec("UPDATE public.fixture_acl SET allowed=true WHERE permission='income_expenses.create'");
    await assert.rejects(expense('create', create({ cashbookId: FOREIGN_CASHBOOK })), code('42501'), 'cashbook not held by the actor');
    await assert.rejects(expense('create', create({ buildingId: FOREIGN, roomId: null })), code('42501'), 'other organization');
    await assert.rejects(expense('create', create({ roomId: OTHER_ROOM })), code('22023'), 'room outside the building');
    await db.exec("UPDATE public.fixture_writer SET rejected_message='Sổ quỹ đã khoá tại ngày phiếu'");
    await assert.rejects(expense('create', create()), code('22023'), 'writer business rejection is definitive');
    await db.exec('UPDATE public.fixture_writer SET rejected_message=null');
    await nothingWritten(env, before);
  });
  await t.test('roles, actor, provider session, binding versions, offboarding and token revocation fail closed', async () => {
    for (const role of ['anon', 'service_role']) await assert.rejects(expense('create', create(), binding, { role }), /permission denied/);
    await assert.rejects(expense('create', create(), binding, { actor: FOREIGN }), code('42501'));
    await assert.rejects(expense('create', create(), binding, { session: FOREIGN }), code('42501'));
    for (const key of ['connectionId', 'expectedMembershipId', 'expectedEpoch', 'expectedPolicyVersion', 'expectedAuthorizationVersion', 'expectedSessionRevision'])
      await assert.rejects(expense('create', create(), { ...binding, [key]: typeof binding[key] === 'number' ? 2 : FOREIGN }), code('PT409'));
    await db.query('INSERT INTO public.fixture_offboarded VALUES($1)', [USER]);
    await assert.rejects(expense('create', create()), code('42501')); await db.exec('DELETE FROM public.fixture_offboarded');
    await assert.rejects(expense('create', { ...create(), approvalStatus: 'APPROVED' }), code('22023'), 'SQL also rejects unknown keys');
    await db.exec('UPDATE app_private.hermes_connection_tokens SET revoked_at=clock_timestamp()');
    await assert.rejects(expense('status', { requestId: randomUUID() }), code('42501'));
  });
});

test('expense SQL mutations: dropping Hermes-only controls turns a check red; post-writer approval fence works alone', { timeout: 300000 }, async t => {
  const candidate = readFileSync(ACTION_PATH, 'utf8');
  const pre = 'IF v_maker_can_approve AND NOT v_approve_overlay THEN', post = "IF v_row.approval_status='APPROVED' AND NOT v_approve_overlay AND";
  for (const [label, replacements, check] of [
    // The first occurrence fences room choices; the last one fences create.
    ['overlay building check removed from create', [['IF NOT(v_building=ANY(v_buildings)) THEN', 'IF false THEN', 'last']], 'overlayBuilding'],
    ['approval overlay removed before and after the writer', [[pre, 'IF false THEN'], [post, 'IF false AND']], 'approverWithoutOverlay'],
    ['registry kill switch ignored', [["WHERE capability=action_key AND mode='action' AND enabled FOR SHARE", "WHERE capability=action_key AND mode='action' FOR SHARE"]], 'registry'],
    ['connection action restriction ignored', [['OR NOT(action_key=ANY(c.action_capabilities))', '']], 'connection'],
    ['restricted category accepted', [['AND NOT COALESCE(t.is_restricted,false)', '']], 'category'],
    ['receipt intent check removed', [['IF receipt.input IS DISTINCT FROM p_input THEN', 'IF false THEN']], 'pending'],
  ]) {
    await t.test(label, async t2 => {
      let sql = candidate;
      for (const [before, after, occurrence] of replacements) {
        const at = occurrence === 'last' ? sql.lastIndexOf(before) : sql.indexOf(before);
        assert.ok(at >= 0, `mutation applies: ${before}`); sql = sql.slice(0, at) + after + sql.slice(at + before.length);
      }
      const env = await setup(t2, { action: sql });
      await assert.rejects(checks[check](env), { code: 'ERR_ASSERTION' }, `${label} must be detected by ${check}`);
    });
  }
  await t.test('only the pre-writer approval check removed: the post-writer fence still rolls everything back', async t2 => {
    const env = await setup(t2, { action: candidate.replace(pre, 'IF false THEN') });
    await checks.approverWithoutOverlay(env);
  });
});

test('expense service composes bound user JWT, action capabilities and write-uncertainty callbacks', { timeout: 120000 }, async t => {
  const env = await setup(t), { db, call } = env, events = [];
  const expiresAt = (Math.floor(Date.now() / 1000) + 3600) * 1000;
  const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION, exp: expiresAt / 1000 })).toString('base64url'), 'signature'].join('.');
  const crypto = createSessionCrypto({ activeKeyVersion: 'test', keys: new Map([['test', randomBytes(32)]]) }); t.after(() => crypto.destroy());
  const envelope = crypto.seal({ accessToken, refreshToken: 'SYNTHETIC_REFRESH', expiresAt }, { assistantId: ASSISTANT, userId: USER, organizationId: ORG, sessionId: SESSION });
  await db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0)', [JSON.stringify(envelope), expiresAt]);
  const dependencyScope = createDependencyScope(); t.after(() => dependencyScope.close());
  const fetch = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer ' + accessToken);
    const name = new URL(url).pathname, args = JSON.parse(options.body); events.push(name);
    try {
      if (name === '/rest/v1/rpc/hermes_expense_capabilities_v1') return Response.json(await call('SELECT public.hermes_expense_capabilities_v1($1::uuid) result', [args.p_organization_id]));
      assert.equal(name, '/rest/v1/rpc/hermes_expense_action_v1');
      return Response.json(await call('SELECT public.hermes_expense_action_v1($1::jsonb,$2::text,$3::jsonb) result', [JSON.stringify(args.p_binding), args.p_operation, JSON.stringify(args.p_input)]));
    } catch (error) { return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: error.code === '42501' ? 403 : error.code === 'PT409' ? 409 : 400 }); }
  };
  const supabase = { url: 'https://example.invalid/', publishableKey: 'sb_publishable_test' };
  const baseAuth = { async verifySession() { return { userId: USER, sessionId: SESSION, expiresAt }; }, async readAuthorization() { return {
    userId: USER, isSuperadmin: false, activeOrganizationIds: [ORG], epoch: 'synthetic-base', membership: { organizationId: ORG, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null, membershipId: USER, authorizationVersion: 1 },
    permissions: { read: [], action: [] }, companyCeilings: { read: [], action: [] }, scopesByPermission: {} }; } };
  const auth = createExpenseActionAuth({ baseAuth, reads: createExpenseActionReads({ ...supabase, fetch, dependencyScope }) });
  const merged = await auth.readAuthorization({ accessToken, userId: USER, organizationId: ORG, signal: new AbortController().signal });
  assert.deepEqual(merged.permissions.action, ['income_expenses.create']); assert.deepEqual(merged.companyCeilings.action, ['income_expenses.create']);
  const connectionStore = createDurableConnectionStore({ transport: { async call(operation, payload) { return env.rpc('app_private.hermes_store_read_connection_v1', payload); } } });
  const authority = createDurableAuthority({ connectionStore, crypto, auth });
  const service = createExpenseActionService({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch });
  const signal = new AbortController().signal, dispatched = [];
  const input = create();
  const receipt = await service.prepareExpenseAction(token, 'expense.create', input, { signal });
  const result = await service.finalizeExpenseAction(token, receipt, { signal, onDispatch() { dispatched.push('dispatch'); }, onRejected() { dispatched.push('rejected'); } });
  assert.equal(result.voucher.buildingId, BUILDING); assert.deepEqual(dispatched, ['dispatch']); assert.equal(events.at(-1), '/rest/v1/rpc/hermes_expense_action_v1');
  const denied = await service.prepareExpenseAction(token, 'expense.create', create({ buildingId: OTHER_BUILDING, roomId: null }), { signal });
  await assert.rejects(service.finalizeExpenseAction(token, denied, { signal, onDispatch() { dispatched.push('dispatch'); }, onRejected() { dispatched.push('rejected'); } }), code('forbidden'));
  assert.deepEqual(dispatched.slice(-2), ['dispatch', 'rejected'], 'a definitive 42501 is not an unknown outcome');
  const status = await service.prepareExpenseAction(token, 'expense.status', { requestId: input.requestId }, { signal });
  assert.deepEqual(await service.finalizeExpenseAction(token, status, { signal }), result);
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='income_expenses.create'");
  await assert.rejects(service.prepareExpenseAction(token, 'expense.create', create(), { signal }), code('forbidden'), 'revoked CRM grant removes the tool');
});
