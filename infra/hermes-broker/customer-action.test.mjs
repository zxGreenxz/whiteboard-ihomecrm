import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup, id, customerInput, leadInput, binding, USER, ORG, FOREIGN, SESSION, CONNECTION, REQUEST, SCOPE } from './customer-action-fixture.mjs';
import { customerActionInput, customerActionResult, mayUseCustomerAction } from './customer-action-contract.mjs';
import { createCustomerActionReads, createCustomerActionAuth, createCustomerActionService } from './customer-action-adapter.mjs';
const code = expected => error => error.code === expected;
const identity = { row: { organizationId: ORG, userId: USER } };
const empty = { customers: 0, leads: 0, receipts: 0, audits: 0, occurrences: 0 };

test('fixed DTO creates only personal customers or initial unassigned leads and accepts no actor/org/status/foreign keys', () => {
  assert.deepEqual(customerActionInput('customer.create', customerInput), customerInput);
  assert.deepEqual(customerActionInput('lead.create', leadInput), leadInput);
  assert.equal(mayUseCustomerAction({ read: ['customers.create'], action: [] }, 'customer.create'), false);
  assert.equal(mayUseCustomerAction({ action: ['customers.create'] }, 'customer.status'), true);
  assert.equal(mayUseCustomerAction({ action: ['customers.create'] }, 'lead.create'), false);
  assert.equal(mayUseCustomerAction({ action: ['leads.create'] }, 'lead.update'), false);
  for (const patch of [{ organizationId: ORG }, { userId: FOREIGN }, { status: 'CONVERTED' }, { buildingId: FOREIGN }, { assignedStaffId: FOREIGN },
    { customerType: 'ORGANIZATION' }, { vehicles: [] }, { name: '' }, { name: ' x ' }, { phone: '+84900000000' }, { email: 'invalid' }, { notes: 'x'.repeat(4001) }])
    assert.throws(() => customerActionInput('customer.create', { ...customerInput, ...patch }));
  assert.throws(() => customerActionInput('lead.create', { ...leadInput, source: 'ANY' }));
  assert.throws(() => customerActionResult('customer.create', { organizationId: ORG, requestId: REQUEST, kind: 'customer', outcome: 'unknown', record: null }, identity, customerInput));
});

test('canonical create preserves defaults, actual actor, scoped CRM permission, duplicate phone behavior, audit and lead occurrence exactly once', { timeout: 60000 }, async t => {
  const { db, rpc, counts } = await setup(t);
  assert.equal((await db.query('SELECT bool_or(crm_org_wide) value FROM public.fixture_customer_acl')).rows[0].value, false);
  const caps = await rpc(null, 'capabilities', {}); assert.equal(caps.permissions['customers.create'].allowed, true); assert.equal(caps.permissions['leads.create'].allowed, true);
  const customer = await rpc('customer', 'create', customerInput);
  assert.deepEqual(customerActionResult('customer.create', customer, identity, customerInput), customer);
  assert.equal(customer.record.createdBy, USER); assert.equal(customer.record.status, 'WALK_IN'); assert.equal(customer.record.customerType, 'INDIVIDUAL');
  assert.deepEqual(await rpc('customer', 'create', customerInput), customer);
  assert.deepEqual(await rpc('customer', 'status', { requestId: REQUEST }), customer);
  const leadData = { ...leadInput, requestId: id('9') }, lead = await rpc('lead', 'create', leadData);
  assert.deepEqual(customerActionResult('lead.create', lead, identity, leadData), lead);
  assert.equal(lead.record.status, 'B1_LEAD'); assert.equal(lead.record.source, 'ZALO');
  assert.deepEqual(await rpc('lead', 'create', leadData), lead);
  const row = (await db.query('SELECT user_id,organization_id,building_id,room_id,assigned_staff_id,appointment_date,lead_score,openclaw_assignment_revision FROM public.leads')).rows[0];
  assert.deepEqual(row, { user_id: USER, organization_id: ORG, building_id: null, room_id: null, assigned_staff_id: null, appointment_date: null, lead_score: 17, openclaw_assignment_revision: 1 });
  const occurrence = (await db.query('SELECT snapshot FROM public.fixture_occurrences')).rows[0].snapshot;
  assert.equal(occurrence.eventSubtype, 'CREATED'); assert.equal(occurrence.payload.leadId, lead.record.id); assert.equal(occurrence.payload.organizationId, ORG);
  assert.deepEqual(await counts(), { customers: 1, leads: 1, receipts: 2, audits: 2, occurrences: 1 });
  // CRM has no unique phone/identity-number key. A new explicit request remains
  // a new record; idempotency must not turn into guessed business deduplication.
  const duplicate = await rpc('customer', 'create', { ...customerInput, requestId: id('a') }); assert.notEqual(duplicate.record.id, customer.record.id);
  await assert.rejects(rpc('customer', 'create', { ...customerInput, name: 'Đổi ý' }), code('PT409'));
  await assert.rejects(rpc('lead', 'create', leadInput), code('PT409'));
  const audit = (await db.query('SELECT actor_user_id,new_state FROM public.authorization_audit_events LIMIT 1')).rows[0];
  assert.equal(audit.actor_user_id, USER); assert.equal(audit.new_state.actor, USER);
});

test('canonical INSERT/SELECT RLS and org boundary remain effective even when Action guard or superadmin allows', { timeout: 60000 }, async t => {
  const { db, rpc, counts } = await setup(t);
  for (const kind of ['customer', 'lead']) {
    const input = kind === 'customer' ? customerInput : leadInput;
    for (const flag of ['insert_rls', 'select_rls']) {
      await db.exec(`UPDATE public.fixture_customer_acl SET ${flag}=false`);
      await assert.rejects(rpc(kind, 'create', input), code('42501')); assert.deepEqual(await counts(), empty);
      await db.exec(`UPDATE public.fixture_customer_acl SET ${flag}=true`);
    }
  }
  await db.exec(`CREATE FUNCTION public.fixture_foreign_org() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.organization_id='${FOREIGN}';RETURN NEW;END$$;
    CREATE TRIGGER fixture_foreign_org BEFORE INSERT ON public.customers FOR EACH ROW EXECUTE FUNCTION public.fixture_foreign_org();`);
  await assert.rejects(rpc('customer', 'create', customerInput), code('42501')); assert.deepEqual(await counts(), empty);
  await db.exec('DROP TRIGGER fixture_foreign_org ON public.customers');
  await db.exec(`INSERT INTO public.super_admins VALUES('${USER}');UPDATE public.fixture_customer_acl SET insert_rls=false`);
  await assert.rejects(rpc('customer', 'create', customerInput), code('42501')); assert.deepEqual(await counts(), empty);
  await db.exec('UPDATE public.fixture_customer_acl SET insert_rls=true'); await rpc('customer', 'create', customerInput);
  await db.exec('UPDATE public.fixture_customer_acl SET select_rls=false');
  await assert.rejects(rpc('customer', 'status', { requestId: REQUEST }), code('42501'));
  await assert.rejects(rpc('customer', 'create', customerInput), code('42501'));
});

test('live Action, membership, epoch, actual user, session and organization overlay revoke both create and receipt access', { timeout: 60000 }, async t => {
  const { db, rpc, counts } = await setup(t);
  for (const role of ['anon', 'service_role', 'hermes_store_executor']) await assert.rejects(rpc('customer', 'create', customerInput, binding, { role }), code('42501'));
  for (const options of [{ actor: FOREIGN }, { session: FOREIGN }]) await assert.rejects(rpc('customer', 'create', customerInput, binding, options), code('42501'));
  for (const key of ['expectedEpoch', 'expectedPolicyVersion', 'expectedAuthorizationVersion', 'expectedSessionRevision'])
    await assert.rejects(rpc('customer', 'create', customerInput, { ...binding, [key]: 2 }), code('PT409'));
  const cases = [
    ["UPDATE app_private.hermes_connections SET action_capabilities='{}'", "UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['customers.create','leads.create']"],
    ["UPDATE app_private.hermes_org_policies SET action_capabilities='{}'", "UPDATE app_private.hermes_org_policies SET action_capabilities=ARRAY['customers.create','leads.create']"],
    ["UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='customers.create'", "UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='customers.create'"],
    ['UPDATE public.fixture_customer_acl SET allowed=false', 'UPDATE public.fixture_customer_acl SET allowed=true'],
    ['UPDATE public.fixture_customer_acl SET entity_permission=false', 'UPDATE public.fixture_customer_acl SET entity_permission=true'],
    [`UPDATE public.authorization_scopes SET organization_id='${FOREIGN}'`, `UPDATE public.authorization_scopes SET organization_id='${ORG}'`],
    ["UPDATE public.authorization_scopes SET scope_type='BUILDING'", "UPDATE public.authorization_scopes SET scope_type='ORGANIZATION'"],
    [`UPDATE app_private.hermes_connections SET scope_ids=ARRAY['${FOREIGN}'::uuid]`, `UPDATE app_private.hermes_connections SET scope_ids=ARRAY['${SCOPE}'::uuid]`],
    ["UPDATE app_private.hermes_sessions SET expires_at=clock_timestamp()-interval '1 second'", "UPDATE app_private.hermes_sessions SET expires_at=clock_timestamp()+interval '1 hour'"],
    ['UPDATE public.organization_memberships SET revoked_at=clock_timestamp()', 'UPDATE public.organization_memberships SET revoked_at=null'],
  ];
  for (const [deny, restore] of cases) {
    await db.exec(deny); await assert.rejects(rpc('customer', 'create', customerInput), code('42501')); await db.exec(restore); assert.deepEqual(await counts(), empty);
  }
  await rpc('customer', 'create', customerInput);
  await db.exec("UPDATE app_private.hermes_connections SET action_capabilities='{}'");
  await assert.rejects(rpc('customer', 'status', { requestId: REQUEST }), code('42501'));
});

test('strict SQL DTO and audit or canonical-trigger failure roll back record, receipt and occurrence', { timeout: 60000 }, async t => {
  const { db, rpc, counts } = await setup(t);
  for (const patch of [{ organizationId: FOREIGN }, { name: '' }, { phone: '1' }, { email: 'bad' }, { status: 'RENTING' }])
    await assert.rejects(rpc('customer', 'create', { ...customerInput, ...patch }), code('22023'));
  await assert.rejects(rpc('lead', 'create', { ...leadInput, source: 'unknown' }), code('22023'));
  await assert.rejects(rpc('customer', 'update', customerInput), code('22023'));
  await db.exec(`CREATE FUNCTION public.fixture_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic_audit_failure';END$$;
    CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON public.authorization_audit_events FOR EACH ROW EXECUTE FUNCTION public.fixture_fail_audit();`);
  await assert.rejects(rpc('lead', 'create', leadInput), /synthetic_audit_failure/); assert.deepEqual(await counts(), empty);
  await db.exec(`DROP TRIGGER fixture_fail_audit ON public.authorization_audit_events;
    CREATE FUNCTION public.fixture_tamper() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.customer_name='Changed';RETURN NEW;END$$;
    CREATE TRIGGER fixture_tamper BEFORE INSERT ON public.leads FOR EACH ROW EXECUTE FUNCTION public.fixture_tamper();`);
  await assert.rejects(rpc('lead', 'create', leadInput), code('PT409')); assert.deepEqual(await counts(), empty);
});

test('unknown or foreign connection receipt cannot open blind retry, while not_found status does not claim failure', { timeout: 60000 }, async t => {
  const { db, rpc, counts } = await setup(t);
  assert.deepEqual(await rpc('customer', 'status', { requestId: REQUEST }), { organizationId: ORG, requestId: REQUEST, kind: 'customer', outcome: 'not_found', record: null });
  await db.query('INSERT INTO app_private.hermes_customer_create_receipts(organization_id,user_id,request_id,connection_id,kind,input) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
    [ORG, USER, REQUEST, CONNECTION, 'customer', JSON.stringify(customerInput)]);
  assert.equal((await rpc('customer', 'status', { requestId: REQUEST })).outcome, 'unknown');
  await assert.rejects(rpc('customer', 'create', customerInput), code('PT409'));
  await db.exec(`INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,credential_ref,intent_digest,intent_expires_at,activation_operation_id,action_capabilities,scope_ids)
    SELECT '${FOREIGN}',assistant_id,organization_id,user_id,'ACTIVE',credential_ref,repeat('c',64),clock_timestamp()+interval '1 minute','${FOREIGN}',action_capabilities,scope_ids
    FROM app_private.hermes_connections WHERE id='${CONNECTION}';
    INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES(repeat('e',64),'${FOREIGN}',clock_timestamp()+interval '10 minutes');`);
  const other = { ...binding, connectionId: FOREIGN, tokenDigest: 'e'.repeat(64) };
  await assert.rejects(rpc('customer', 'create', customerInput, other), code('PT409'));
  await assert.rejects(rpc('customer', 'status', { requestId: REQUEST }, other), code('PT409'));
  const completed = { ...customerInput, requestId: id('9') }; await rpc('customer', 'create', completed);
  await assert.rejects(rpc('customer', 'create', completed, other), code('PT409'));
  await assert.rejects(rpc('customer', 'status', { requestId: completed.requestId }, other), code('PT409'));
  assert.deepEqual(await counts(), { ...empty, customers: 1, receipts: 2, audits: 1 });
});

test('committed create with lost HTTP ACK reconciles the original record without a second canonical insert or occurrence', { timeout: 60000 }, async t => {
  const { rpc, counts } = await setup(t); let calls = 0, dispatched = 0;
  const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION })).toString('base64url'), 'signature'].join('.');
  const reads = createCustomerActionReads({ url: 'https://example.invalid/', publishableKey: 'sb_publishable_test', dependencyScope: { track: fn => fn() },
    fetch: async (_url, request) => {
      calls++; const args = JSON.parse(request.body), result = await rpc(args.p_kind, args.p_operation, args.p_input, args.p_binding);
      if (args.p_operation === 'create') throw new Error('synthetic_ack_lost_after_commit');
      return Response.json(result);
    } });
  const options = { signal: new AbortController().signal, onDispatch() { dispatched++; }, onRejected() { assert.fail('committed response is not rejected'); } };
  await assert.rejects(reads.execute('lead.create', { accessToken, binding, input: leadInput }, options), /synthetic_ack_lost_after_commit/);
  assert.equal(calls, 1); assert.equal(dispatched, 1);
  const result = await reads.execute('lead.status', { accessToken, binding, input: { requestId: REQUEST } }, options);
  assert.equal(customerActionResult('lead.status', result, identity, { requestId: REQUEST }).outcome, 'applied');
  assert.equal(calls, 2); assert.equal(dispatched, 1);
  assert.deepEqual(await counts(), { ...empty, leads: 1, receipts: 1, audits: 1, occurrences: 1 });
});

test('SQL API stays invoker, private schema and ledger stay closed, and capabilities never require Hermes Read', { timeout: 60000 }, async t => {
  const { db, rpc } = await setup(t);
  const acl = (await db.query(`SELECT has_schema_privilege('authenticated','app_private','USAGE') usage,
    has_table_privilege('authenticated','app_private.hermes_customer_create_receipts','SELECT') ledger_read,
    has_function_privilege('service_role','public.hermes_customer_create_action_v1(jsonb,text,text,jsonb)','EXECUTE') service_exec,
    (SELECT prosecdef FROM pg_proc WHERE proname='hermes_customer_insert_v1') insert_definer,
    (SELECT prosecdef FROM pg_proc WHERE proname='hermes_customer_create_action_v1') api_definer`)).rows[0];
  assert.deepEqual(acl, { usage: false, ledger_read: false, service_exec: false, insert_definer: false, api_definer: false });
  await db.exec("UPDATE app_private.hermes_connections SET read_capabilities='{}';UPDATE app_private.hermes_org_policies SET read_capabilities='{}'");
  assert.equal((await rpc('customer', 'create', customerInput)).outcome, 'applied');
  const caps = await rpc(null, 'capabilities', {}); assert.equal(caps.permissions['leads.create'].allowed, true);
});

test('shared bound-user operation waits for audit recheck, consumes receipt once and never retries lost ACK', async () => {
  const token = 'hc_' + 'x'.repeat(43), tokenDigest = createHash('sha256').update(token).digest('hex'), assistantId = id('5'), expiresAt = 2000000;
  const row = { id: CONNECTION, assistantId, userId: USER, organizationId: ORG, state: 'ACTIVE', epoch: 1, expiresAt, credentialRef: SESSION, tokenDigest };
  const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION })).toString('base64url'), 'signature'].join('.');
  let changed = false, now = 1000000, calls = 0, dispatched = 0; const events = [];
  const service = createCustomerActionService({ clock: () => now, supabase: { url: 'https://example.invalid/', publishableKey: 'sb_publishable_test' }, dependencyScope: { track: fn => fn() },
    authority: { resolve: async () => ({ ...identity, row, effective: { action: ['customers.create'] } }),
      checkUnchanged: async () => { events.push('recheck'); if (changed) throw Object.assign(new Error('changed'), { code: 'context_changed' }); } },
    connectionStore: { readConnection: async () => ({ status: 'active', connection: row, session: { credentialRef: SESSION, revision: 1, expiresAt, envelope: {},
      binding: { assistantId, userId: USER, organizationId: ORG, sessionId: SESSION } }, membership: { membershipId: USER, authorizationVersion: 1 }, policy: { version: 1 } }) },
    crypto: { open: () => ({ accessToken, refreshToken: 'synthetic-refresh', expiresAt }) }, auth: { verifySession: async () => ({ userId: USER, sessionId: SESSION, expiresAt }) },
    fetch: async (url, request) => { calls++; events.push('dispatch'); assert.equal(new URL(url).pathname, '/rest/v1/rpc/hermes_customer_create_action_v1');
      assert.equal(request.headers.authorization, 'Bearer ' + accessToken); const body = JSON.parse(request.body); assert.equal(body.p_kind, 'customer');
      if (body.p_operation === 'create') throw new Error('synthetic_ack_loss');
      return Response.json({ organizationId: ORG, requestId: REQUEST, kind: 'customer', outcome: 'not_found', record: null }); } });
  const options = { signal: new AbortController().signal, onDispatch() { dispatched++; }, onRejected() { assert.fail('ACK loss is not rejection'); } };
  const first = await service.prepareCustomerAction(token, 'customer.create', customerInput, options); events.push('audit'); changed = true;
  await assert.rejects(service.finalizeCustomerAction(token, first, options), code('context_changed')); assert.equal(calls, 0);
  changed = false; const stale = await service.prepareCustomerAction(token, 'customer.create', customerInput, options); now += 30000;
  await assert.rejects(service.finalizeCustomerAction(token, stale, options), code('timeout'));
  const fresh = await service.prepareCustomerAction(token, 'customer.create', customerInput, options); events.push('audit');
  await assert.rejects(service.finalizeCustomerAction(token, fresh, options), /synthetic_ack_loss/);
  assert.deepEqual(events.slice(-3), ['audit', 'recheck', 'dispatch']); assert.equal(calls, 1); assert.equal(dispatched, 1);
  await assert.rejects(service.finalizeCustomerAction(token, fresh, options), code('context_changed'));
  const status = await service.prepareCustomerAction(token, 'customer.status', { requestId: REQUEST }, options);
  assert.equal((await service.finalizeCustomerAction(token, status, options)).outcome, 'not_found'); assert.equal(calls, 2); assert.equal(dispatched, 1);
});

test('capability adapter binds caller, membership, organization and epoch; missing endpoint remains disabled', async () => {
  const base = { membership: { membershipId: USER, authorizationVersion: 1 }, isSuperadmin: false,
    permissions: { read: ['customers.view'], action: [] }, companyCeilings: { read: [], action: [] }, scopesByPermission: {}, epoch: 'base' };
  const cap = { organizationId: ORG, userId: USER, membershipId: USER, authorizationVersion: 1, isSuperadmin: false, policyVersion: 0,
    permissions: { 'customers.create': { allowed: true, companyEnabled: true }, 'leads.create': { allowed: false, companyEnabled: true } } };
  let value = null;
  const auth = createCustomerActionAuth({ baseAuth: { verifySession: async () => ({}), readAuthorization: async () => structuredClone(base) }, reads: { capabilities: async () => value } });
  const request = { organizationId: ORG, userId: USER, accessToken: 'synthetic', signal: new AbortController().signal };
  assert.deepEqual(await auth.readAuthorization(request), base);
  value = cap; const allowed = await auth.readAuthorization(request); assert.deepEqual(allowed.permissions.action, ['customers.create']); assert.notEqual(allowed.epoch, base.epoch);
  for (const patch of [{ userId: FOREIGN }, { organizationId: FOREIGN }, { membershipId: FOREIGN }, { authorizationVersion: 2 },
    { permissions: { ...cap.permissions, 'customers.create': { allowed: true, companyEnabled: false } } }]) {
    value = { ...cap, ...patch }; await assert.rejects(auth.readAuthorization(request), code('context_changed'));
  }
  let rejected = 0;
  const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION })).toString('base64url'), 'signature'].join('.');
  const reads = createCustomerActionReads({ url: 'https://example.invalid/', publishableKey: 'sb_publishable_test', dependencyScope: { track: fn => fn() },
    fetch: async () => Response.json({ code: 'PT409', message: 'changed', details: null, hint: null }, { status: 409 }) });
  await assert.rejects(reads.execute('customer.create', { accessToken, binding, input: customerInput },
    { signal: new AbortController().signal, onDispatch() {}, onRejected() { rejected++; } }), code('context_changed')); assert.equal(rejected, 1);
});
