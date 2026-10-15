import test from 'node:test';
import assert from 'node:assert/strict';
import { setupFollow, u, ORG, USER, ASSIGNEE } from './task-follow-fixture.mjs';
import { applyNotifyRetryDigest, notifyRetryDigestSql } from './notify-retry-digest-fixture.mjs';

// 20261015185559_hermes_notify_retry_digest_v1 (1): a reminder/report notice
// whose bell write fails returns exactly its own mark so the next tick sends it
// again. Each kind (due / executor overdue / assigner report) has its own count:
// at most three consecutive failures, the fourth keeps the mark (gives up,
// audited in its own subtransaction). A due reminder still waiting for a retry
// when its window closes is given up with an audit, never dropped silently.
// The executor's overdue notice and the assigner's report keep separate marks,
// so a retry never repeats the side that was already told.
// Every notify call reaches the synthetic pg_net port once (JWT present), so
// push rows count sends even when the bell merges into an unread row; failed
// attempts are counted by non-transactional sequences inside the poison.
const iso = offsetMs => new Date(Date.now() + offsetMs).toISOString();
const set = (requestId, jobId, remindBeforeMinutes) => ({ organizationId: ORG, requestId, jobId, objective: 'Theo dõi hạn',
  remindBeforeMinutes, notifyAssigner: true, parentFollowId: null });
const state = async (db, jobId) => (await db.query(`SELECT due_notified_at IS NOT NULL due,overdue_notified_at IS NOT NULL overdue,
  overdue_reported_at IS NOT NULL reported,ARRAY[due_failures,overdue_failures,report_failures] failures
  FROM app_private.hermes_task_follows WHERE job_id=$1`, [jobId])).rows[0];
const pushes = async (db, user, kind) => (await db.query(`SELECT count(*)::int n FROM public.fixture_push
  WHERE body->>'userId'=$1 AND body->>'tag'=$2`, [user, `hermes-task-${kind}`])).rows[0].n;
const attempts = async (db, kind) => Number((await db.query(`SELECT CASE WHEN is_called THEN last_value ELSE 0 END n
  FROM public.fixture_attempt_${kind}`)).rows[0].n);
const audits = async db => (await db.query(`SELECT organization_id,resource_id,new_state FROM public.authorization_audit_events
  WHERE event_type='HERMES_TASK_FOLLOW_NOTICE_ABANDONED' ORDER BY occurred_at,id`)).rows;
const counts = result => [result.notified, result.failed, result.retrying, result.abandoned];
// The recipients' bell write fails (insert or merge), as a lock timeout or a
// broken notification trigger would; each failed attempt is counted per kind.
const poison = (db, users) => db.exec(`
  CREATE SEQUENCE IF NOT EXISTS public.fixture_attempt_due; CREATE SEQUENCE IF NOT EXISTS public.fixture_attempt_overdue;
  CREATE SEQUENCE IF NOT EXISTS public.fixture_attempt_overdue_report;
  CREATE OR REPLACE FUNCTION public.fixture_notice_poison() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.user_id=ANY('{${users.join(',')}}'::uuid[]) THEN
      PERFORM nextval('public.fixture_attempt_'||(NEW.metadata->>'kind'));
      RAISE EXCEPTION 'fixture notice poison';
    END IF; RETURN NEW; END $$;
  CREATE TRIGGER fixture_notice_poison BEFORE INSERT OR UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.fixture_notice_poison();`);
const cure = db => db.exec('DROP TRIGGER fixture_notice_poison ON public.notifications');
const withPush = async f => { await f.db.exec("INSERT INTO public.fixture_jwt VALUES('fixture.service.jwt')"); return f; };
const overdue = (f, jobId) => f.db.query("UPDATE public.jobs SET deadline=clock_timestamp()-interval '1 minute' WHERE id=$1", [jobId]);
async function overdueJob(f, request) {
  const jobId = await f.job({ deadline: iso(10 * 60_000) });
  await f.action('set', set(u(request), jobId, null));
  await overdue(f, jobId);
  return jobId;
}
async function dueJob(f, request) {
  const jobId = await f.job({ deadline: iso(10 * 60_000) });
  await f.action('set', set(u(request), jobId, 30));
  return jobId;
}

async function dueRetried(f) {
  const { db } = await withPush(f);
  const jobId = await dueJob(f, 1);
  await poison(db, [ASSIGNEE]);
  assert.deepEqual(counts(await f.tick()), [0, 1, 1, 0]);
  assert.deepEqual(await state(db, jobId), { due: false, overdue: false, reported: false, failures: [1, 0, 0] }, 'the failed notice returned its mark');
  await cure(db);
  assert.deepEqual(counts(await f.tick()), [1, 0, 0, 0]);
  assert.deepEqual(await state(db, jobId), { due: true, overdue: false, reported: false, failures: [0, 0, 0] }, 'sent: mark set, count back to 0');
  assert.equal(await pushes(db, ASSIGNEE, 'due'), 1);
  assert.equal((await f.tick()).notified, 0, 'not repeated after it went through');
  assert.equal(await pushes(db, ASSIGNEE, 'due'), 1);
}

async function givesUpOnFourth(f) {
  const { db } = await withPush(f);
  const jobId = await dueJob(f, 1);
  await poison(db, [ASSIGNEE]);
  for (const failures of [1, 2, 3]) {
    assert.deepEqual(counts(await f.tick()), [0, 1, 1, 0], `failure ${failures} is retried`);
    assert.deepEqual(await state(db, jobId), { due: false, overdue: false, reported: false, failures: [failures, 0, 0] });
  }
  assert.deepEqual(counts(await f.tick()), [0, 1, 0, 1], 'the fourth failure gives up');
  assert.equal(await attempts(db, 'due'), 4);
  assert.deepEqual(await state(db, jobId), { due: true, overdue: false, reported: false, failures: [0, 0, 0] }, 'mark kept; next notice starts a new count');
  const rows = await audits(db);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].organization_id, rows[0].resource_id, rows[0].new_state],
    [ORG, (await db.query('SELECT id FROM app_private.hermes_task_follows WHERE job_id=$1', [jobId])).rows[0].id,
      { jobId, kinds: ['due'], failures: 4, reason: 'retry_limit' }]);
  await cure(db);
  assert.equal((await f.tick()).notified, 0);
  assert.equal(await pushes(db, ASSIGNEE, 'due'), 0, 'never sent after giving up');
}

// Review P2: the reminder's failures must not eat the overdue notice's retries,
// and a reminder whose window closed while waiting is audited, not dropped.
async function countsPerKind(f) {
  const { db } = await withPush(f);
  const jobId = await dueJob(f, 1);
  await poison(db, [ASSIGNEE]);
  assert.deepEqual(counts(await f.tick()), [0, 1, 1, 0]);
  assert.deepEqual(counts(await f.tick()), [0, 1, 1, 0]);
  await overdue(f, jobId);
  // Window closed: the waiting reminder is given up (audited); the executor's
  // overdue notice fails on its own count; the assigner's report goes through.
  assert.deepEqual(counts(await f.tick()), [1, 1, 1, 1]);
  assert.deepEqual((await audits(db)).map(row => row.new_state), [{ jobId, kinds: ['due'], failures: 2, reason: 'window_closed' }]);
  assert.deepEqual(counts(await f.tick()), [0, 1, 1, 0]);
  assert.deepEqual(counts(await f.tick()), [0, 1, 1, 0]);
  assert.deepEqual(counts(await f.tick()), [0, 1, 0, 1], 'the overdue notice had its own four attempts');
  assert.deepEqual([await attempts(db, 'due'), await attempts(db, 'overdue')], [2, 4]);
  assert.deepEqual((await audits(db)).map(row => [row.new_state.kinds, row.new_state.reason]), [[['due'], 'window_closed'], [['overdue'], 'retry_limit']]);
  assert.deepEqual(await state(db, jobId), { due: true, overdue: true, reported: true, failures: [0, 0, 0] });
  assert.deepEqual([await pushes(db, ASSIGNEE, 'due'), await pushes(db, ASSIGNEE, 'overdue'), await pushes(db, USER, 'overdue_report')], [0, 0, 1]);
  await cure(db);
  assert.equal((await f.tick()).notified, 0, 'nothing left to send');
}

async function eachSideRetriedAlone(f) {
  const { db } = await withPush(f);
  // The assigner's report fails; the executor was told and is not told again.
  const reportFails = await overdueJob(f, 1);
  await poison(db, [USER]);
  assert.deepEqual(counts(await f.tick()), [1, 1, 1, 0]);
  assert.deepEqual(await state(db, reportFails), { due: false, overdue: true, reported: false, failures: [0, 0, 1] });
  await cure(db);
  assert.deepEqual(counts(await f.tick()), [1, 0, 0, 0]);
  assert.deepEqual(await state(db, reportFails), { due: false, overdue: true, reported: true, failures: [0, 0, 0] });
  assert.deepEqual([await pushes(db, ASSIGNEE, 'overdue'), await pushes(db, USER, 'overdue_report')], [1, 1]);
  // The executor's notice fails; the assigner was told and is not told again.
  const noticeFails = await overdueJob(f, 2);
  await poison(db, [ASSIGNEE]);
  assert.deepEqual(counts(await f.tick()), [1, 1, 1, 0]);
  assert.deepEqual(await state(db, noticeFails), { due: false, overdue: false, reported: true, failures: [0, 1, 0] });
  await cure(db);
  assert.deepEqual(counts(await f.tick()), [1, 0, 0, 0]);
  assert.deepEqual(await state(db, noticeFails), { due: false, overdue: true, reported: true, failures: [0, 0, 0] });
  assert.deepEqual([await pushes(db, ASSIGNEE, 'overdue'), await pushes(db, USER, 'overdue_report')], [2, 2]);
  assert.equal((await f.tick()).notified, 0);
}

async function bothSidesInOneTick(f) {
  const { db } = await withPush(f);
  const jobId = await overdueJob(f, 1);
  await poison(db, [USER, ASSIGNEE]);
  assert.deepEqual(counts(await f.tick()), [0, 2, 2, 0]);
  assert.deepEqual(await state(db, jobId), { due: false, overdue: false, reported: false, failures: [0, 1, 1] });
  await cure(db);
  assert.deepEqual(counts(await f.tick()), [2, 0, 0, 0]);
  assert.deepEqual(await state(db, jobId), { due: false, overdue: true, reported: true, failures: [0, 0, 0] });
  assert.deepEqual([await pushes(db, ASSIGNEE, 'overdue'), await pushes(db, USER, 'overdue_report')], [1, 1]);
}

async function groupOfFollows(f) {
  const { db } = await withPush(f);
  const first = await dueJob(f, 1), second = await dueJob(f, 2);
  await poison(db, [ASSIGNEE]);
  assert.deepEqual(counts(await f.tick()), [0, 1, 2, 0], 'one failed notice, both follows retried');
  for (const jobId of [first, second]) assert.deepEqual(await state(db, jobId), { due: false, overdue: false, reported: false, failures: [1, 0, 0] });
  await cure(db);
  assert.deepEqual(counts(await f.tick()), [1, 0, 0, 0]);
  for (const jobId of [first, second]) assert.deepEqual(await state(db, jobId), { due: true, overdue: false, reported: false, failures: [0, 0, 0] });
  const notes = (await db.query(`SELECT metadata FROM public.notifications WHERE metadata->>'kind'='due'`)).rows;
  assert.deepEqual(notes.map(row => row.metadata.jobs.map(item => item.jobId).sort()), [[first, second].sort()], 'one notice for the group');
  assert.equal(await pushes(db, ASSIGNEE, 'due'), 1);
}

async function auditFailureKeepsDecision(f) {
  const { db } = await withPush(f);
  const jobId = await dueJob(f, 1);
  await poison(db, [ASSIGNEE]);
  for (let n = 0; n < 3; n++) await f.tick();
  await db.exec(`ALTER FUNCTION app_private.append_authz_audit_v1(uuid,text,text,uuid,jsonb,jsonb,text) RENAME TO fixture_audit_real;
    CREATE FUNCTION app_private.append_authz_audit_v1(p_organization_id uuid,p_event_type text,p_resource_type text,p_resource_id uuid,
      p_old_state jsonb DEFAULT NULL,p_new_state jsonb DEFAULT NULL,p_reason text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'canceling statement due to lock timeout' USING ERRCODE='55P03'; END $$;`);
  const fourth = await f.tick().catch(error => assert.fail(`a failing audit aborted the tick: ${error.message}`));
  assert.deepEqual(counts(fourth), [0, 2, 0, 1], 'the notice and the audit failed; the give-up still counts');
  assert.deepEqual(await state(db, jobId), { due: true, overdue: false, reported: false, failures: [0, 0, 0] }, 'give-up decision kept');
  await db.exec(`DROP FUNCTION app_private.append_authz_audit_v1(uuid,text,text,uuid,jsonb,jsonb,text);
    ALTER FUNCTION app_private.fixture_audit_real(uuid,text,text,uuid,jsonb,jsonb,text) RENAME TO append_authz_audit_v1;`);
  await cure(db);
  assert.deepEqual(counts(await f.tick()), [0, 0, 0, 0], 'no re-send and no second give-up');
  assert.equal(await attempts(db, 'due'), 4);
}

test('a failed reminder returns its mark, the next tick sends it once, success resets the count', { timeout: 120000 },
  async t => dueRetried(await setupFollow(t)));

test('three failures are retried; the fourth keeps the mark, is audited and nothing is sent later', { timeout: 120000 },
  async t => givesUpOnFourth(await setupFollow(t)));

test('reminder and overdue notice have separate counts; a closed reminder window is audited, not dropped', { timeout: 120000 },
  async t => countsPerKind(await setupFollow(t)));

test('executor notice and assigner report retry independently; whoever was told is not told twice', { timeout: 120000 },
  async t => eachSideRetriedAlone(await setupFollow(t)));

test('both sides failing in one tick are both retried once', { timeout: 120000 },
  async t => bothSidesInOneTick(await setupFollow(t)));

test('a failed group returns the marks of all its follows and resends them in one notice', { timeout: 120000 },
  async t => groupOfFollows(await setupFollow(t)));

test('a failing abandon audit does not undo the stored give-up', { timeout: 120000 },
  async t => auditFailureKeepsDecision(await setupFollow(t)));

test('upgrade: a follow already reported under the shared mark is not reported again', { timeout: 120000 }, async t => {
  const f = await withPush(await setupFollow(t, { retry: null })), { db } = f;
  const jobId = await overdueJob(f, 1);
  assert.equal((await f.tick()).notified, 2, 'review-fix tick: executor + assigner under one mark');
  await applyNotifyRetryDigest(db);
  assert.deepEqual(await state(db, jobId), { due: false, overdue: true, reported: true, failures: [0, 0, 0] }, 'backfilled once, re-run kept it');
  assert.equal((await f.tick()).notified, 0);
  assert.deepEqual([await pushes(db, ASSIGNEE, 'overdue'), await pushes(db, USER, 'overdue_report')], [1, 1]);
});

test('upgrade: a notice not yet sent stays pending and is sent once', { timeout: 120000 }, async t => {
  const f = await withPush(await setupFollow(t, { retry: null })), { db } = f;
  const jobId = await f.job({ deadline: iso(10 * 60_000) });
  await f.action('set', set(u(1), jobId, null));
  assert.equal((await f.tick()).notified, 0, 'not overdue yet');
  await applyNotifyRetryDigest(db);
  assert.deepEqual(await state(db, jobId), { due: false, overdue: false, reported: false, failures: [0, 0, 0] });
  await overdue(f, jobId);
  assert.deepEqual(counts(await f.tick()), [2, 0, 0, 0]);
  assert.deepEqual([await pushes(db, ASSIGNEE, 'overdue'), await pushes(db, USER, 'overdue_report')], [1, 1]);
});

test('upgrade from the TEST-only draft: shared count dropped, a pending report retry is kept', { timeout: 120000 }, async t => {
  const f = await withPush(await setupFollow(t, { retry: null })), { db } = f;
  const jobId = await overdueJob(f, 1);
  assert.equal((await f.tick()).notified, 2);
  // Draft 20261015181525 state: its own report mark (left NULL here = a report
  // retry pending) and the shared notify_failures count.
  await db.exec(`ALTER TABLE app_private.hermes_task_follows ADD COLUMN overdue_reported_at timestamptz;
    ALTER TABLE app_private.hermes_task_follows ADD COLUMN notify_failures integer NOT NULL DEFAULT 0 CHECK(notify_failures BETWEEN 0 AND 3);
    UPDATE app_private.hermes_task_follows SET notify_failures=1;`);
  await applyNotifyRetryDigest(db);
  const columns = (await db.query(`SELECT array_agg(attname::text ORDER BY attname) c FROM pg_attribute WHERE attrelid='app_private.hermes_task_follows'::regclass
    AND attname IN ('notify_failures','due_failures','overdue_failures','report_failures','overdue_reported_at') AND NOT attisdropped`)).rows[0].c;
  assert.deepEqual(columns, ['due_failures', 'overdue_failures', 'overdue_reported_at', 'report_failures']);
  assert.deepEqual(await state(db, jobId), { due: false, overdue: true, reported: false, failures: [0, 0, 0] }, 'existing column is not re-backfilled');
  assert.deepEqual(counts(await f.tick()), [1, 0, 0, 0], 'only the pending report is sent');
  assert.deepEqual([await pushes(db, ASSIGNEE, 'overdue'), await pushes(db, USER, 'overdue_report')], [1, 2]);
});

test('helper and columns stay private; a stored failure count cannot exceed the cap', { timeout: 120000 }, async t => {
  const f = await setupFollow(t), { db } = f;
  const jobId = await dueJob(f, 1);
  assert.deepEqual((await state(db, jobId)).failures, [0, 0, 0]);
  for (const role of ['anon', 'authenticated', 'service_role', 'hermes_store_executor']) {
    assert.equal((await db.query("SELECT has_function_privilege($1,'app_private.hermes_task_follow_tick_v1(integer)','EXECUTE') ok", [role])).rows[0].ok, false, role);
    assert.equal((await db.query("SELECT has_table_privilege($1,'app_private.hermes_task_follows','SELECT,UPDATE') ok", [role])).rows[0].ok, false, role);
  }
  for (const column of ['due_failures', 'overdue_failures', 'report_failures']) {
    await assert.rejects(db.query(`UPDATE app_private.hermes_task_follows SET ${column}=4 WHERE job_id=$1`, [jobId]), /check constraint/, column);
  }
});

// Mutation evidence: each mutant removes one rule and the same scenario that
// passes on the original SQL must then fail on an assertion (not vacuous).
const original = notifyRetryDigestSql();
const mutant = (from, to) => {
  const next = original.replace(from, to);
  assert.notEqual(next, original, `mutation anchor not found: ${from}`);
  return next;
};
for (const [name, sql, scenario] of [
  ['a failed notice keeps its mark (no retry)',
    mutant("due_notified_at=CASE WHEN r.kinds ? 'due' AND v_due<3 THEN NULL ELSE due_notified_at END", 'due_notified_at=due_notified_at'), dueRetried],
  ['success leaves the failure count',
    mutant("due_failures=CASE WHEN o.kinds ? 'due' THEN 0 ELSE t.due_failures END", 'due_failures=t.due_failures'), dueRetried],
  ['the cap gives up one failure early',
    mutant('SELECT t.organization_id,t.job_id,t.due_failures,t.overdue_failures', 'SELECT t.organization_id,t.job_id,t.due_failures+1,t.overdue_failures'),
    givesUpOnFourth],
  ['giving up is not audited',
    mutant("PERFORM app_private.append_authz_audit_v1((r.a->>'org')::uuid,'HERMES_TASK_FOLLOW_NOTICE_ABANDONED'",
      "PERFORM concat((r.a->>'org')::uuid,'HERMES_TASK_FOLLOW_NOTICE_ABANDONED'"), givesUpOnFourth],
  ['a reminder whose window closed while waiting is dropped silently',
    mutant('IF f.due_failures>0 AND f.due_notified_at IS NULL AND v_now>=j.deadline THEN', 'IF false THEN'), countsPerKind],
  ['a failed report returns the shared overdue mark (executor told twice)',
    mutant("overdue_notified_at=CASE WHEN r.kinds ? 'overdue' AND v_over<3 THEN NULL",
      "overdue_notified_at=CASE WHEN r.kinds ?| ARRAY['overdue','overdue_report'] AND v_over<3 THEN NULL"), eachSideRetriedAlone],
  ['a failing audit aborts the decision',
    mutant("    EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;\n      RAISE WARNING 'hermes_task_follow_tick_v1: abandon audit for follow % not written (%)',r.a->>'id',SQLSTATE;\n",
      ''), auditFailureKeepsDecision],
]) {
  test(`mutation caught: ${name}`, { timeout: 120000 }, async t => {
    await assert.rejects(scenario(await setupFollow(t, { retry: sql })), assert.AssertionError);
  });
}
