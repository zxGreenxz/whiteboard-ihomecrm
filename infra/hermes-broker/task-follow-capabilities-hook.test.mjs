import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupFollow, USER, ORG, SCOPE } from './task-follow-fixture.mjs';

const hook = readFileSync('supabase/migrations/20261015110200_hermes_task_follow_capabilities_hook.sql', 'utf8');
const member = { userId: USER, organizationId: ORG, membershipId: USER, authorizationVersion: 1, isSuperadmin: false };

test('capabilities hook only adds enabled choices/effective keys and never writes policy', { timeout: 60000 }, async t => {
  const { db } = await setupFollow(t);
  await db.exec("ALTER TABLE public.buildings ADD COLUMN name text; ALTER TABLE public.areas ADD COLUMN name text; UPDATE public.buildings SET name='Tòa A'");
  await db.exec(hook); await db.exec(hook);
  const grants = (await db.query(`SELECT has_function_privilege('authenticated','app_private.hermes_task_follow_extend_options_v1(jsonb,text)','EXECUTE') hook,
    has_function_privilege('authenticated','public.hermes_connection_options_v6(uuid)','EXECUTE') wrapper`)).rows[0];
  assert.deepEqual(grants, { hook: false, wrapper: true });
  async function extend(result, kind, actor = USER) {
    await db.exec('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true)", [actor]);
    try { const value = (await db.query('SELECT app_private.hermes_task_follow_extend_options_v1($1::jsonb,$2) result', [JSON.stringify(result), kind])).rows[0].result;
      await db.exec('COMMIT'); return value; } catch (error) { await db.exec('ROLLBACK'); throw error; }
  }
  const policyBefore = (await db.query('SELECT * FROM app_private.hermes_org_policies')).rows;

  const org = await extend({ ...member, choices: { read: [], action: ['tasks.create'] } }, 'org_options');
  assert.deepEqual(org.choices.action, ['tasks.create', 'tasks.edit', 'tasks.delete']);
  assert.deepEqual(org.choices.read, [], 'supervise is not offered while its registry row is absent');

  const options = await extend({ ...member, policyVersion: 1, enabled: true, read: [], action: [], scopes: [] }, 'connection_options');
  assert.deepEqual(options.action, ['tasks.edit', 'tasks.delete']);
  assert.deepEqual(options.scopes.map(scope => scope.scopeId), [SCOPE]);
  const disabled = await extend({ ...member, policyVersion: 1, enabled: false, read: [], action: [], scopes: [] }, 'connection_options');
  assert.deepEqual(disabled.action, []);

  const context = await extend({ ...member, policyVersion: 1, scopeIds: [SCOPE], restrictions: { read: [], action: ['tasks.edit'] },
    companyCeilings: { read: [], action: ['tasks.edit', 'tasks.delete'] }, effective: { read: [], action: [] } }, 'context');
  assert.deepEqual(context.effective.action, ['tasks.edit'], 'only keys the connection itself restricts to');

  await db.exec(`DELETE FROM public.fixture_perm WHERE user_id='${USER}' AND permission='tasks.delete'`);
  const narrowed = await extend({ ...member, policyVersion: 1, enabled: true, read: [], action: [], scopes: [] }, 'connection_options');
  assert.deepEqual(narrowed.action, ['tasks.edit'], 'live CRM permission removes the choice');

  await assert.rejects(extend({ ...member, membershipId: ORG, choices: { read: [], action: [] } }, 'org_options'), /context_changed/);
  await assert.rejects(extend({ ...member, policyVersion: 9, enabled: true, read: [], action: [], scopes: [] }, 'connection_options'), /context_changed/);
  await assert.rejects(extend({ ...member, choices: { read: [], action: [] } }, 'org_options', ORG), /denied/);
  assert.deepEqual((await db.query('SELECT * FROM app_private.hermes_org_policies')).rows, policyBefore);
});
