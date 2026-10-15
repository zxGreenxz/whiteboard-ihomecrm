import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, id, USER, ORG, FOREIGN, SCOPE, CONNECTION } from './customer-action-fixture.mjs';
import { installV7, member, baseOptions } from './customer-options-fixture.mjs';
import { connectionOptions } from './connection-options.mjs';

const BUILDING_SCOPE = id('9'), BUILDING = id('8'), FOREIGN_SCOPE = id('c'), MALFORMED_SCOPE = id('a');
const orgScope = { scopeId: SCOPE, scopeType: 'ORGANIZATION', label: 'Toàn tổ chức', buildingId: null, areaId: null, cashbookId: null };

test('v7 refuses to install before v6/customer capability exists', { timeout: 60000 }, async t => {
  const { db } = await setup(t);
  await assert.rejects(db.exec(readFileSync('supabase/migrations/20261015191139_hermes_customer_options_v7.sql', 'utf8')), /hermes_customer_options_requires_v6/);
  await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT to_regprocedure('public.hermes_connection_options_v7(uuid)')::text fn")).rows[0].fn, null);
});

test('v7 offers Khách hàng actions only from registry ∩ company ceiling ∩ current CRM grant ∩ Toàn tổ chức scope', { timeout: 90000 }, async t => {
  const { db } = await setup(t);
  const { base, call } = await installV7(db);
  const policyBefore = (await db.query('SELECT * FROM app_private.hermes_org_policies')).rows;
  const grants = (await db.query(`SELECT has_function_privilege('authenticated','app_private.hermes_customer_extend_options_v1(jsonb,text)','EXECUTE') hook,
    has_function_privilege('anon','public.hermes_connection_options_v7(uuid)','EXECUTE') anon,
    has_function_privilege('hermes_store_executor','public.hermes_connection_options_v7(uuid)','EXECUTE') executor,
    has_function_privilege('authenticated','public.hermes_org_policy_options_v7(uuid)','EXECUTE')
      AND has_function_privilege('authenticated','public.hermes_connection_options_v7(uuid)','EXECUTE')
      AND has_function_privilege('authenticated','public.hermes_connection_context_v7(uuid)','EXECUTE') wrappers`)).rows[0];
  assert.deepEqual(grants, { hook: false, anon: false, executor: false, wrappers: true });

  // Company policy picker: registry-enabled keys become choices; v6 choices are kept.
  await base('org_options', { ...member, choices: { read: [], action: ['tasks.create'] } });
  assert.deepEqual((await call('hermes_org_policy_options_v7', ORG)).choices.action, ['tasks.create', 'customers.create', 'leads.create']);
  await base('org_options', { ...member, choices: { read: [], action: ['customers.create'] } });
  assert.deepEqual((await call('hermes_org_policy_options_v7', ORG)).choices.action, ['customers.create', 'leads.create'], 'no duplicate choice');

  await base('connection_options', baseOptions);
  const options = await call('hermes_connection_options_v7', ORG);
  assert.deepEqual(options.action, ['customers.create', 'leads.create']);
  assert.deepEqual(options.scopes, [orgScope]);
  assert.deepEqual(connectionOptions(options, ORG, USER).action, ['customers.create', 'leads.create'], 'broker contract accepts the projection');
  assert.deepEqual((await db.query('SELECT public.hermes_connection_options_v6($1::uuid) r', [ORG])).rows[0].r, baseOptions, 'v6 stays the unchanged legacy reply');
  // v6 choices are kept and the same scope is not duplicated.
  await base('connection_options', { ...baseOptions, action: ['tasks.create'], scopes: [orgScope] });
  const merged = await call('hermes_connection_options_v7', ORG);
  assert.deepEqual(merged.action, ['tasks.create', 'customers.create', 'leads.create']); assert.deepEqual(merged.scopes, [orgScope]);

  await base('connection_options', baseOptions);
  const offered = async () => (await call('hermes_connection_options_v7', ORG)).action;
  await db.exec("UPDATE public.fixture_customer_acl SET allowed=false WHERE permission='leads.create'");
  assert.deepEqual(await offered(), ['customers.create'], 'CRM leads.create revoked hides only the lead action');
  await db.exec('UPDATE public.fixture_customer_acl SET allowed=false');
  assert.deepEqual(await call('hermes_connection_options_v7', ORG), baseOptions, 'without CRM grant nothing is offered, not even the scope');
  await db.exec("UPDATE public.fixture_customer_acl SET allowed=true;UPDATE public.fixture_customer_acl SET entity_permission=false WHERE permission='customers.create'");
  assert.deepEqual(await offered(), ['leads.create'], 'entity create access is required, not only the context flag');
  await db.exec('UPDATE public.fixture_customer_acl SET allowed=true,entity_permission=true');

  await db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='customers.create'");
  assert.deepEqual(await offered(), ['leads.create'], 'registry off hides the action');
  await base('org_options', { ...member, choices: { read: [], action: [] } });
  assert.deepEqual((await call('hermes_org_policy_options_v7', ORG)).choices.action, ['leads.create']);
  await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='customers.create'");

  await db.exec("UPDATE app_private.hermes_org_policies SET action_capabilities=ARRAY['leads.create']");
  assert.deepEqual(await offered(), ['leads.create'], 'company ceiling without customers.create hides it');
  await db.exec("UPDATE app_private.hermes_org_policies SET action_capabilities=ARRAY['customers.create','leads.create']");

  // A company that allows only a building (or another company's) scope cannot offer unassigned records.
  await db.exec(`INSERT INTO public.authorization_scopes VALUES('${BUILDING_SCOPE}','${ORG}','BUILDING','${BUILDING}',null,null),
    ('${FOREIGN_SCOPE}','${FOREIGN}','ORGANIZATION',null,null,null)`);
  await db.exec(`INSERT INTO public.authorization_scopes VALUES('${MALFORMED_SCOPE}','${ORG}','BUILDING',null,null,null)`);
  await db.exec(`UPDATE app_private.hermes_org_policies SET scope_ids=ARRAY['${BUILDING_SCOPE}'::uuid,'${FOREIGN_SCOPE}'::uuid,'${MALFORMED_SCOPE}'::uuid]`);
  assert.deepEqual(await call('hermes_connection_options_v7', ORG), baseOptions, 'building-only, buildingless non-org or foreign scope never qualifies');
  await db.exec(`UPDATE app_private.hermes_org_policies SET scope_ids=ARRAY['${SCOPE}'::uuid,'${BUILDING_SCOPE}'::uuid]`);
  assert.deepEqual((await call('hermes_connection_options_v7', ORG)).scopes, [orgScope], 'only the Toàn tổ chức scope is added');
  await db.exec(`UPDATE app_private.hermes_org_policies SET scope_ids=ARRAY['${SCOPE}'::uuid]`);

  await db.exec('UPDATE app_private.hermes_org_policies SET enabled=false');
  assert.deepEqual(await offered(), [], 'company policy off hides every customer action');
  await db.exec('UPDATE app_private.hermes_org_policies SET enabled=true');
  const disabled = { ...baseOptions, enabled: false };
  await base('connection_options', disabled);
  assert.deepEqual(await call('hermes_connection_options_v7', ORG), disabled);

  // Context: only keys this connection restricts to, within the ceiling and its own saved Toàn tổ chức scope.
  const context = { id: CONNECTION, ...member, policyVersion: 1, state: 'active', scopeIds: [SCOPE],
    restrictions: { read: [], action: ['customers.create'] }, companyCeilings: { read: [], action: ['customers.create', 'leads.create'] },
    effective: { read: [], action: [] } };
  const effective = async value => { await base('context', value); return (await call('hermes_connection_context_v7', CONNECTION)).effective.action; };
  assert.deepEqual(await effective(context), ['customers.create']);
  assert.deepEqual(await effective({ ...context, restrictions: { read: [], action: ['customers.create', 'leads.create'] } }), ['customers.create', 'leads.create']);
  assert.deepEqual(await effective({ ...context, scopeIds: [] }), [], 'without its own Toàn tổ chức scope nothing is effective');
  assert.deepEqual(await effective({ ...context, scopeIds: [BUILDING_SCOPE] }), []);
  assert.deepEqual(await effective({ ...context, companyCeilings: { read: [], action: [] } }), []);
  await db.exec("UPDATE public.fixture_customer_acl SET allowed=false WHERE permission='customers.create'");
  assert.deepEqual(await effective(context), [], 'live CRM revoke removes the effective key');
  await db.exec('UPDATE public.fixture_customer_acl SET allowed=true');

  // Fences: another caller, stale membership or stale policy never get an answer.
  await base('connection_options', baseOptions);
  await assert.rejects(call('hermes_connection_options_v7', ORG, { actor: FOREIGN }), error => error.code === '42501');
  await base('connection_options', { ...baseOptions, membershipId: ORG });
  await assert.rejects(call('hermes_connection_options_v7', ORG), error => error.code === 'PT409');
  await base('connection_options', { ...baseOptions, policyVersion: 9 });
  await assert.rejects(call('hermes_connection_options_v7', ORG), error => error.code === 'PT409');
  // The company picker has no capability reader behind it: its own fences must hold.
  await base('org_options', { ...member, membershipId: ORG, choices: { read: [], action: [] } });
  await assert.rejects(call('hermes_org_policy_options_v7', ORG), error => error.code === 'PT409');
  await base('org_options', { ...member, userId: FOREIGN, choices: { read: [], action: [] } });
  await assert.rejects(call('hermes_org_policy_options_v7', ORG), error => error.code === '42501', 'a reply about another user is refused');
  await base('connection_options', baseOptions);
  await assert.rejects(call('hermes_connection_options_v7', ORG, { role: 'anon' }), error => error.code === '42501');
  assert.deepEqual((await db.query('SELECT * FROM app_private.hermes_org_policies')).rows, policyBefore, 'the options layer never writes policy');
});
