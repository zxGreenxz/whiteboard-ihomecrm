import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { setupFollow, u, ORG, USER, ASSIGNEE, CONNECTION } from './task-follow-fixture.mjs';
import { reviewFixesSql } from './review-fixes-fixture.mjs';

// 20261015130000_hermes_review_fixes_v1: applied twice by setupFollow after the
// batch file. Mutation evidence lives in task-follow-mutation.test.mjs.
const iso = offsetMs => new Date(Date.now() + offsetMs).toISOString();
const set = (requestId, jobId) => ({ organizationId: ORG, requestId, jobId, objective: 'Nhắc trước hạn',
  remindBeforeMinutes: 30, notifyAssigner: true, parentFollowId: null });
const follow = async (db, jobId) => (await db.query(`SELECT state,close_reason,due_notified_at IS NOT NULL due
  FROM app_private.hermes_task_follows WHERE job_id=$1`, [jobId])).rows[0];
const notices = async (db, kind) => (await db.query(`SELECT user_id,metadata FROM public.notifications
  WHERE metadata->>'event'='HERMES_TASK' AND metadata->>'kind'=$1 ORDER BY created_at,id`, [kind])).rows;

test('migration refuses to run before the 20261015 batch', async () => {
  const db = new PGlite();
  try { await assert.rejects(db.exec(reviewFixesSql()), /hermes_review_fixes_requires_20261015_batch/); }
  finally { await db.close(); }
});

test('P2-1: each reminder tick rechecks the Hermes Read tasks.view grant; losing it closes the follow silently', { timeout: 120000 }, async t => {
  const f = await setupFollow(t), { db } = f;
  // Control: with every grant intact the same follow is reminded (not vacuous).
  const control = await f.job({ deadline: iso(10 * 60_000) });
  await f.action('set', set(u(1), control));
  assert.equal((await f.tick()).notified, 1);
  assert.deepEqual(await follow(db, control), { state: 'ACTIVE', close_reason: null, due: true });
  let request = 10;
  for (const [label, revoke, restore] of [
    ['registry kill switch', "UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='tasks.view'",
      "UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='tasks.view'"],
    ['company ceiling', "UPDATE app_private.hermes_org_policies SET read_capabilities='{}'",
      "UPDATE app_private.hermes_org_policies SET read_capabilities=ARRAY['tasks.view']"],
    ['connection overlay', `UPDATE app_private.hermes_connections SET read_capabilities='{}' WHERE id='${CONNECTION}'`,
      `UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['tasks.view'] WHERE id='${CONNECTION}'`],
  ]) {
    const jobId = await f.job({ deadline: iso(10 * 60_000), title: label });
    await f.action('set', set(u(request++), jobId));
    const before = (await notices(db, 'due')).length;
    await db.exec(revoke);
    const result = await f.tick();
    assert.equal(result.failed, 0, label);
    assert.deepEqual(await follow(db, jobId), { state: 'REVOKED', close_reason: 'permission_lost', due: false }, label);
    assert.equal((await notices(db, 'due')).length, before, `${label}: no reminder after the Read grant is gone`);
    const audit = (await db.query(`SELECT count(*)::int n FROM public.authorization_audit_events
      WHERE event_type='HERMES_TASK_FOLLOW_REVOKED' AND new_state->>'jobId'=$1`, [jobId])).rows[0].n;
    assert.equal(audit, 1, label);
    await db.exec(restore);
  }
});

test('P3a: a failing follow or notice is isolated, retried next tick; a busy company is skipped, not waited on', { timeout: 120000 }, async t => {
  const f = await setupFollow(t), { db } = f;
  const poisoned = await f.job({ deadline: iso(10 * 60_000), title: 'Việc lỗi' });
  const healthy = await f.job({ deadline: iso(10 * 60_000), title: 'Việc lành' });
  await f.action('set', set(u(1), poisoned)); await f.action('set', set(u(2), healthy));
  await db.exec(`CREATE FUNCTION public.fixture_poison() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.job_id='${poisoned}' AND NEW.due_notified_at IS DISTINCT FROM OLD.due_notified_at THEN RAISE EXCEPTION 'fixture poison'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER fixture_poison BEFORE UPDATE ON app_private.hermes_task_follows FOR EACH ROW EXECUTE FUNCTION public.fixture_poison();`);
  const first = await f.tick();
  assert.deepEqual([first.checked, first.failed, first.notified, first.skippedOrganizations], [2, 1, 1, 0]);
  assert.equal((await follow(db, healthy)).due, true);
  assert.equal((await follow(db, poisoned)).due, false, 'the failed follow rolled back its own marks only');
  let due = await notices(db, 'due');
  assert.deepEqual(due.map(row => row.metadata.jobs.map(item => item.jobId)), [[healthy]], 'its pending reminder is dropped, not sent');
  await db.exec('DROP TRIGGER fixture_poison ON app_private.hermes_task_follows');
  const second = await f.tick();
  assert.deepEqual([second.failed, second.notified], [0, 1]);
  due = await notices(db, 'due');
  assert.deepEqual(due.map(row => row.metadata.jobs.map(item => item.jobId).sort()), [[healthy, poisoned].sort()], 'retried and merged into the unread notice');

  // A failing notice for one recipient does not stop the other recipient.
  await db.query(`UPDATE public.jobs SET deadline=clock_timestamp()-interval '1 minute' WHERE id=ANY($1::uuid[])`, [[poisoned, healthy]]);
  await db.exec(`CREATE FUNCTION public.fixture_notice_poison() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${USER}' THEN RAISE EXCEPTION 'fixture notice poison'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fixture_notice_poison BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.fixture_notice_poison();`);
  const third = await f.tick();
  assert.deepEqual([third.failed, third.notified], [1, 1]);
  assert.deepEqual((await notices(db, 'overdue')).map(row => row.user_id), [ASSIGNEE]);
  assert.deepEqual(await notices(db, 'overdue_report'), []);
  await db.exec('DROP TRIGGER fixture_notice_poison ON public.notifications');

  // Busy company row (lock_timeout): skipped this tick, nothing touched.
  const later = await f.job({ deadline: iso(10 * 60_000), title: 'Việc sau' });
  await f.action('set', set(u(3), later));
  await db.exec(`ALTER FUNCTION app_private.lock_org_for_decision_v1(uuid) RENAME TO fixture_lock_org;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(o uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'canceling statement due to lock timeout' USING ERRCODE='55P03'; END $$;`);
  const busy = await f.tick();
  assert.deepEqual([busy.checked, busy.skippedOrganizations, busy.notified], [0, 1, 0]);
  assert.equal((await follow(db, later)).due, false);
  await db.exec(`DROP FUNCTION app_private.lock_org_for_decision_v1(uuid);
    ALTER FUNCTION app_private.fixture_lock_org(uuid) RENAME TO lock_org_for_decision_v1;`);
  assert.equal((await f.tick()).skippedOrganizations, 0);
  assert.equal((await follow(db, later)).due, true);
});

test('P3d: notification recipients need an ACTIVE company as well as an active membership', { timeout: 120000 }, async t => {
  const f = await setupFollow(t), { db } = f;
  const member = async () => (await db.query('SELECT app_private.hermes_task_follow_member_v1($1,$2) ok', [ORG, ASSIGNEE])).rows[0].ok;
  assert.equal(await member(), true);
  await db.query("UPDATE public.organizations SET status='SUSPENDED' WHERE id=$1", [ORG]);
  assert.equal(await member(), false);
  await db.query("UPDATE public.organizations SET status='ACTIVE' WHERE id=$1", [ORG]);
  assert.equal(await member(), true);
});
