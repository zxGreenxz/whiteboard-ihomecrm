import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setupFollow, followPath, u, ORG, USER, ASSIGNEE, OTHER } from './task-follow-fixture.mjs';

// Mutation evidence for the authority checks: each mutant removes one guard and
// the same probe that the original SQL denies must then succeed. A probe that
// still fails on its mutant would be a vacuous test.
const original = readFileSync(followPath, 'utf8');
const md5 = value => createHash('md5').update(value).digest('hex');
const iso = offsetMs => new Date(Date.now() + offsetMs).toISOString();
const mutate = (from, to) => {
  const next = original.replace(from, to);
  assert.notEqual(next, original, `mutation anchor not found: ${from}`);
  return next;
};
const probes = [
  { name: 'progress party check (no acting on behalf of others)',
    sql: mutate(/\n\s*OR \(p_operation='progress' AND c\.user_id IS DISTINCT FROM j\.assignee_id AND c\.user_id IS DISTINCT FROM j\.user_id\)/, ''),
    async run({ action, job }) {
      const foreign = await job({ creator: OTHER, assignee: OTHER });
      return action('progress', { organizationId: ORG, requestId: u(1), jobId: foreign, note: 'Làm thay', expectedNoteDigest: md5('') });
    } },
  { name: 'Hermes action overlay (registry/company/connection)',
    sql: mutate("OR NOT app_private.hermes_task_follow_capable_v1(c,v_capability,'action',v_capability)", ''),
    async run({ db, action, job }) {
      const id = await job();
      await db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='tasks.delete'");
      return action('cancel', { organizationId: ORG, requestId: u(2), jobId: id, reason: 'Thử' });
    } },
  { name: 'explicit company of the connection',
    sql: mutate("IF p_input->>'organizationId' IS DISTINCT FROM c.organization_id::text\n    OR NOT app_private.hermes_task_follow_capable_v1(c,v_capability",
      "IF NOT app_private.hermes_task_follow_capable_v1(c,v_capability"),
    async run({ action, job }) {
      const id = await job({ deadline: iso(3600_000) });
      return action('set', { organizationId: u(77), requestId: u(3), jobId: id, objective: 'Theo dõi', remindBeforeMinutes: null, notifyAssigner: true, parentFollowId: null });
    } },
  { name: 'reverse delegation loop guard',
    sql: mutate('IF j.assignee_id<>c.user_id AND j.assignee_id IN (', 'IF false AND j.assignee_id IN ('),
    async run({ action, job }) {
      const down = await job({ deadline: iso(3600_000) });
      await action('set', { organizationId: ORG, requestId: u(4), jobId: down, objective: 'Theo dõi', remindBeforeMinutes: null, notifyAssigner: true, parentFollowId: null });
      const back = await job({ creator: ASSIGNEE, assignee: USER });
      return action('set', { organizationId: ORG, requestId: u(5), jobId: back, objective: 'Giao ngược', remindBeforeMinutes: null, notifyAssigner: true, parentFollowId: null }, 'assignee');
    } },
  { name: 'canonical write stays SECURITY INVOKER under CRM RLS',
    sql: mutate(/(FUNCTION app_private\.hermes_task_follow_apply_v1\(p_step jsonb\)\nRETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY) INVOKER/, '$1 DEFINER'),
    async run({ db, action, job }) {
      const id = await job();
      await db.exec(`UPDATE public.fixture_perm SET rls_blocked=true WHERE user_id='${USER}' AND permission='tasks.delete'`);
      return action('cancel', { organizationId: ORG, requestId: u(6), jobId: id, reason: 'RLS' });
    } },
  { name: 'standing grant recheck at every reminder tick',
    sql: mutate('v_reason:=app_private.hermes_task_follow_grant_v1(f);', 'v_reason:=NULL;'),
    async run({ db, action, job, tick }) {
      const id = await job({ deadline: iso(10 * 60_000) });
      await action('set', { organizationId: ORG, requestId: u(7), jobId: id, objective: 'Nhắc', remindBeforeMinutes: 30, notifyAssigner: true, parentFollowId: null });
      await db.exec(`DELETE FROM public.fixture_perm WHERE user_id='${USER}' AND permission='tasks.create'`);
      await tick();
      const sent = (await db.query(`SELECT count(*)::int n FROM public.notifications WHERE metadata->>'kind'='due'`)).rows[0].n;
      if (sent > 0) return 'notified after revoke';
      throw new Error('hermes_task_denied: no reminder after revoke');
    } },
];

for (const probe of probes) {
  test(`mutation: ${probe.name}`, { timeout: 60000 }, async t => {
    await t.test('original SQL denies', async () => {
      await assert.rejects(probe.run(await setupFollow(t)), /denied|loop|context_changed/);
    });
    await t.test('mutant lets the probe through (test is not vacuous)', async () => {
      await probe.run(await setupFollow(t, { sql: probe.sql }));
    });
  });
}
