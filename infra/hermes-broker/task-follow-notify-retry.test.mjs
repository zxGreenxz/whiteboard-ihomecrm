import test from 'node:test';
import assert from 'node:assert/strict';
import { setupFollow, u, ORG, USER, ASSIGNEE } from './task-follow-fixture.mjs';
import { applyNotifyRetryDigest, notifyRetryDigestSql } from './notify-retry-digest-fixture.mjs';

// 20261015181525_hermes_notify_retry_digest_v1 (1): a reminder/report notice
// whose write fails returns exactly its own mark so the next tick sends it
// again, at most three consecutive failures; the fourth keeps the mark (gives
// up, audited). The executor's overdue notice and the assigner's report keep
// separate marks, so a retry never repeats the side that was already told.
// Every notify call reaches the synthetic pg_net port once (JWT present), so
// push rows count sends even when the bell merges into an unread row.
const iso = offsetMs => new Date(Date.now() + offsetMs).toISOString();
const set = (requestId, jobId, remindBeforeMinutes) => ({ organizationId: ORG, requestId, jobId, objective: 'Theo dõi hạn',
  remindBeforeMinutes, notifyAssigner: true, parentFollowId: null });
const state = async (db, jobId) => (await db.query(`SELECT due_notified_at IS NOT NULL due,overdue_notified_at IS NOT NULL overdue,
  overdue_reported_at IS NOT NULL reported,notify_failures failures FROM app_private.hermes_task_follows WHERE job_id=$1`, [jobId])).rows[0];
const pushes = async (db, user, kind) => (await db.query(`SELECT count(*)::int n FROM public.fixture_push
  WHERE body->>'userId'=$1 AND body->>'tag'=$2`, [user, `hermes-task-${kind}`])).rows[0].n;
const counts = result => [result.notified, result.failed, result.retrying, result.abandoned];
// The recipient's bell write fails (insert or merge), as a lock timeout or a
// broken notification trigger would.
const poison = (db, user) => db.exec(`CREATE OR REPLACE FUNCTION public.fixture_notice_poison() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.user_id='${user}' THEN RAISE EXCEPTION 'fixture notice poison'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER fixture_notice_poison BEFORE INSERT OR UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.fixture_notice_poison();`);
const cure = db => db.exec('DROP TRIGGER fixture_notice_poison ON public.notifications');
const withPush = async f => { await f.db.exec("INSERT INTO public.fixture_jwt VALUES('fixture.service.jwt')"); return f; };
async function overdueJob(f, request) {
  const jobId = await f.job({ deadline: iso(10 * 60_000) });
  await f.action('set', set(u(request), jobId, null));
  await f.db.query("UPDATE public.jobs SET deadline=clock_timestamp()-interval '1 minute' WHERE id=$1", [jobId]);
  return jobId;
}

async function dueRetried(f) {
  const { db } = await withPush(f);
  const jobId = await f.job({ deadline: iso(10 * 60_000) });
  await f.action('set', set(u(1), jobId, 30));
  await poison(db, ASSIGNEE);
  assert.deepEqual(counts(await f.tick()), [0, 1, 1, 0]);
  assert.deepEqual(await state(db, jobId), { due: false, overdue: false, reported: false, failures: 1 }, 'the failed notice returned its mark');
  await cure(db);
  assert.deepEqual(counts(await f.tick()), [1, 0, 0, 0]);
  assert.deepEqual(await state(db, jobId), { due: true, overdue: false, reported: false, failures: 0 }, 'sent: mark set, count back to 0');
  assert.equal(await pushes(db, ASSIGNEE, 'due'), 1);
  assert.equal((await f.tick()).notified, 0, 'not repeated after it went through');
  assert.equal(await pushes(db, ASSIGNEE, 'due'), 1);
}

async function givesUpOnFourth(f) {
  const { db } = await withPush(f);
  const jobId = await f.job({ deadline: iso(10 * 60_000) });
  await f.action('set', set(u(1), jobId, 30));
  await poison(db, ASSIGNEE);
  for (const failures of [1, 2, 3]) {
    assert.deepEqual(counts(await f.tick()), [0, 1, 1, 0], `failure ${failures} is retried`);
    assert.deepEqual(await state(db, jobId), { due: false, overdue: false, reported: false, failures });
  }
  assert.deepEqual(counts(await f.tick()), [0, 1, 0, 1], 'the fourth failure gives up');
  assert.deepEqual(await state(db, jobId), { due: true, overdue: false, reported: false, failures: 0 }, 'mark kept; next notice starts a new count');
  const audit = (await db.query(`SELECT organization_id,resource_id,new_state FROM public.authorization_audit_events
    WHERE event_type='HERMES_TASK_FOLLOW_NOTICE_ABANDONED'`)).rows;
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].organization_id, audit[0].new_state.jobId, audit[0].new_state.kinds, audit[0].new_state.failures], [ORG, jobId, ['due'], 4]);
  await cure(db);
  assert.equal((await f.tick()).notified, 0);
  assert.equal(await pushes(db, ASSIGNEE, 'due'), 0, 'never sent after giving up');
}

async function eachSideRetriedAlone(f) {
  const { db } = await withPush(f);
  // The assigner's report fails; the executor was told and is not told again.
  const reportFails = await overdueJob(f, 1);
  await poison(db, USER);
  assert.deepEqual(counts(await f.tick()), [1, 1, 1, 0]);
  assert.deepEqual(await state(db, reportFails), { due: false, overdue: true, reported: false, failures: 1 });
  await cure(db);
  assert.deepEqual(counts(await f.tick()), [1, 0, 0, 0]);
  assert.deepEqual(await state(db, reportFails), { due: false, overdue: true, reported: true, failures: 0 });
  assert.deepEqual([await pushes(db, ASSIGNEE, 'overdue'), await pushes(db, USER, 'overdue_report')], [1, 1]);
  // The executor's notice fails; the assigner was told and is not told again.
  const noticeFails = await overdueJob(f, 2);
  await poison(db, ASSIGNEE);
  assert.deepEqual(counts(await f.tick()), [1, 1, 1, 0]);
  assert.deepEqual(await state(db, noticeFails), { due: false, overdue: false, reported: true, failures: 1 });
  await cure(db);
  assert.deepEqual(counts(await f.tick()), [1, 0, 0, 0]);
  assert.deepEqual(await state(db, noticeFails), { due: false, overdue: true, reported: true, failures: 0 });
  assert.deepEqual([await pushes(db, ASSIGNEE, 'overdue'), await pushes(db, USER, 'overdue_report')], [2, 2]);
  assert.equal((await f.tick()).notified, 0);
}

test('a failed reminder returns its mark, the next tick sends it once, success resets the count', { timeout: 120000 },
  async t => dueRetried(await setupFollow(t)));

test('three failures are retried; the fourth keeps the mark, is audited and nothing is sent later', { timeout: 120000 },
  async t => givesUpOnFourth(await setupFollow(t)));

test('executor notice and assigner report retry independently; whoever was told is not told twice', { timeout: 120000 },
  async t => eachSideRetriedAlone(await setupFollow(t)));

test('upgrade: a follow already reported under the shared mark is not reported again', { timeout: 120000 }, async t => {
  const f = await withPush(await setupFollow(t, { retry: null })), { db } = f;
  const jobId = await overdueJob(f, 1);
  assert.equal((await f.tick()).notified, 2, 'review-fix tick: executor + assigner under one mark');
  await applyNotifyRetryDigest(db);
  assert.deepEqual(await state(db, jobId), { due: false, overdue: true, reported: true, failures: 0 }, 'backfilled once, re-run kept it');
  assert.equal((await f.tick()).notified, 0);
  assert.deepEqual([await pushes(db, ASSIGNEE, 'overdue'), await pushes(db, USER, 'overdue_report')], [1, 1]);
});

test('helper and columns stay private; the stored failure count cannot exceed the cap', { timeout: 120000 }, async t => {
  const f = await setupFollow(t), { db } = f;
  const jobId = await f.job({ deadline: iso(10 * 60_000) });
  await f.action('set', set(u(1), jobId, 30));
  assert.equal((await state(db, jobId)).failures, 0);
  for (const role of ['anon', 'authenticated', 'service_role', 'hermes_store_executor']) {
    assert.equal((await db.query("SELECT has_function_privilege($1,'app_private.hermes_task_follow_tick_v1(integer)','EXECUTE') ok", [role])).rows[0].ok, false, role);
    assert.equal((await db.query("SELECT has_table_privilege($1,'app_private.hermes_task_follows','SELECT,UPDATE') ok", [role])).rows[0].ok, false, role);
  }
  await assert.rejects(db.query('UPDATE app_private.hermes_task_follows SET notify_failures=4 WHERE job_id=$1', [jobId]), /check constraint/);
});

// Mutation evidence: each mutant removes one rule and the same scenario that
// passes on the original SQL must then fail (the tests are not vacuous).
const original = notifyRetryDigestSql();
const mutant = (from, to) => {
  const next = original.replace(from, to);
  assert.notEqual(next, original, `mutation anchor not found: ${from}`);
  return next;
};
for (const [name, sql, scenario] of [
  ['a failed notice keeps its mark (no retry)',
    mutant("due_notified_at=CASE WHEN r.kinds ? 'due' THEN NULL ELSE due_notified_at END", 'due_notified_at=due_notified_at'), dueRetried],
  ['success leaves the failure count',
    mutant('SET notify_failures=0\n      WHERE id IN', 'SET notify_failures=notify_failures\n      WHERE id IN'), dueRetried],
  ['the cap gives up one failure early', mutant('IF v_prior<3 THEN', 'IF v_prior<2 THEN'), givesUpOnFourth],
  ['giving up is not audited',
    mutant("PERFORM app_private.append_authz_audit_v1(v_org,'HERMES_TASK_FOLLOW_NOTICE_ABANDONED'", "PERFORM concat(v_org,'HERMES_TASK_FOLLOW_NOTICE_ABANDONED'"), givesUpOnFourth],
  ['a failed report returns the shared overdue mark (executor told twice)',
    mutant("overdue_notified_at=CASE WHEN r.kinds ? 'overdue' THEN", "overdue_notified_at=CASE WHEN r.kinds ?| ARRAY['overdue','overdue_report'] THEN"),
    eachSideRetriedAlone],
]) {
  test(`mutation caught: ${name}`, { timeout: 120000 }, async t => {
    await assert.rejects(scenario(await setupFollow(t, { retry: sql })), assert.AssertionError);
  });
}
