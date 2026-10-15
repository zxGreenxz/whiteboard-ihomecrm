import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setupFollow, u, USER, ORG, ASSIGNEE, OTHER, FOREIGN, CONNECTION, BUILDING, binding2 } from './task-follow-fixture.mjs';
import { input as createInput } from './task-fixture.mjs';

const md5 = value => createHash('md5').update(value).digest('hex');
const list = (role, extra = {}) => ({ organizationId: ORG, role, assigneeUserId: null, status: 'open', limit: 20, offset: 0, ...extra });
const set = (requestId, jobId, extra = {}) => ({ organizationId: ORG, requestId, jobId, objective: 'Theo dõi đến khi xong và báo tôi',
  remindBeforeMinutes: 60, notifyAssigner: true, parentFollowId: null, ...extra });
const iso = offsetMs => new Date(Date.now() + offsetMs).toISOString();
const notices = async (db, user) => (await db.query(`SELECT subject,content,metadata,push_state,job_id FROM public.notifications
  WHERE user_id=$1 AND metadata->>'event'='HERMES_TASK' ORDER BY created_at,id`, [user])).rows;

test('task follow SQL: tracking, progress, cancel and standing reminders under live CRM ∩ Hermes authority', { timeout: 120000 }, async t => {
  const f = await setupFollow(t);
  const { db, action, read, web, tick, job, capabilities } = f;

  await t.test('new capabilities install disabled and grant no table access', async () => {
    const registry = (await db.query(`SELECT capability,enabled FROM app_private.hermes_capabilities WHERE capability IN ('tasks.edit','tasks.delete') ORDER BY 1`)).rows;
    assert.equal(registry.length, 2);
    const leaks = (await db.query(`SELECT has_table_privilege('authenticated','app_private.hermes_task_follows','SELECT') follows,
      has_function_privilege('authenticated','app_private.hermes_task_follow_tick_v1(integer)','EXECUTE') tick,
      has_function_privilege('anon','public.hermes_task_follow_action_v1(jsonb,text,jsonb)','EXECUTE') anon`)).rows[0];
    assert.deepEqual(leaks, { follows: false, tick: false, anon: false });
    const caps = await capabilities();
    assert.equal(caps.permissions['tasks.edit'].allowed, true);
    assert.equal(caps.permissions['tasks.delete'].allowed, true);
    assert.deepEqual(caps.permissions['tasks.delete'].buildingIds.length, 1);
  });

  const J1 = await job({ title: 'Sửa vòi nước', deadline: iso(30 * 60_000) });
  let F1;
  await t.test('set follow records actor/executor provenance and replays idempotently', async () => {
    const first = await action('set', set(u(1), J1));
    F1 = first.follow;
    assert.equal(first.outcome, 'applied');
    assert.equal(F1.assignerUserId, USER); assert.equal(F1.executorUserId, ASSIGNEE); assert.equal(F1.mode, 'self');
    assert.deepEqual(await action('set', set(u(1), J1)), first);
    await assert.rejects(action('set', set(u(1), J1, { objective: 'Mục tiêu khác' })), /intent_changed/);
    await assert.rejects(action('set', set(u(2), J1)), /follow_exists/);
    const audit = (await db.query(`SELECT new_state FROM public.authorization_audit_events WHERE event_type='HERMES_TASK_FOLLOW_SET'`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].new_state.actor, USER); assert.equal(audit[0].new_state.executor, ASSIGNEE);
  });

  await t.test('company must be explicit and caller-supplied actor fields are rejected', async () => {
    await assert.rejects(action('set', set(u(3), J1, { organizationId: FOREIGN })), /denied/);
    await assert.rejects(action('set', { ...set(u(3), J1), assignerUserId: OTHER }), /invalid/);
    await assert.rejects(read({ ...list('team'), organizationId: FOREIGN }), /denied/);
  });

  await t.test('lists: assigned_by_me, assigned_to_me (executor sees envelope) and team filter', async () => {
    const mine = await read(list('assigned_by_me'));
    assert.deepEqual(mine.items.map(item => item.id), [J1]);
    assert.equal(mine.items[0].follows[0].id, F1.id);
    assert.equal(mine.items[0].assigneeName, 'Recipient');
    const theirs = await read(list('assigned_to_me'), 'assignee');
    assert.deepEqual(theirs.items.map(item => item.id), [J1]);
    assert.equal(theirs.items[0].follows[0].objective, 'Theo dõi đến khi xong và báo tôi');
    const team = await read(list('team', { assigneeUserId: OTHER }));
    assert.equal(team.items.length, 0);
    await assert.rejects(read(list('assigned_by_me', { assigneeUserId: OTHER })), /invalid/);
  });

  await t.test('progress by executor updates the CRM note through RLS and reports to the assigner (merged)', async () => {
    await assert.rejects(action('progress', { organizationId: ORG, requestId: u(10), jobId: J1, note: 'Đã thay gioăng', expectedNoteDigest: md5('x') }, 'assignee'), /context_changed/);
    const done = await action('progress', { organizationId: ORG, requestId: u(11), jobId: J1, note: 'Đã thay gioăng\nchờ keo khô', expectedNoteDigest: md5('') }, 'assignee');
    assert.equal(done.notified, 1);
    assert.equal((await db.query('SELECT completion_description FROM public.jobs WHERE id=$1', [J1])).rows[0].completion_description, 'Đã thay gioăng\nchờ keo khô');
    await action('progress', { organizationId: ORG, requestId: u(12), jobId: J1, note: 'Xong phần ống', expectedNoteDigest: md5('Đã thay gioăng\nchờ keo khô') }, 'assignee');
    const userNotices = await notices(db, USER);
    assert.equal(userNotices.length, 1, 'unread progress notices for one job are merged');
    assert.match(userNotices[0].content, /Xong phần ống/);
    assert.equal(userNotices[0].push_state, 'SKIPPED');
    assert.match(userNotices[0].metadata.pushError, /marked test database/);
  });

  await t.test('progress is limited to the job parties and to CRM RLS (tasks.edit)', async () => {
    const foreignJob = await job({ creator: OTHER, assignee: OTHER });
    await assert.rejects(action('progress', { organizationId: ORG, requestId: u(13), jobId: foreignJob, note: 'Làm thay', expectedNoteDigest: md5('') }), /denied/);
    await db.exec(`UPDATE public.fixture_perm SET rls_blocked=true WHERE user_id='${ASSIGNEE}' AND permission='tasks.edit'`);
    await assert.rejects(action('progress', { organizationId: ORG, requestId: u(14), jobId: J1, note: 'Bị RLS chặn', expectedNoteDigest: md5('Xong phần ống') }, 'assignee'), /denied/);
    await db.exec(`UPDATE public.fixture_perm SET rls_blocked=false`);
    assert.equal((await db.query('SELECT count(*)::int n FROM app_private.hermes_task_follow_receipts WHERE request_id=$1', [u(14)])).rows[0].n, 0);
  });

  await t.test('loops: reverse delegation up the chain is refused; a parent must be addressed to the actor', async () => {
    const back = await job({ creator: ASSIGNEE, assignee: USER, deadline: iso(3600_000) });
    await assert.rejects(action('set', set(u(20), back, { remindBeforeMinutes: null }), 'assignee'), /loop/);
    await assert.rejects(action('set', set(u(21), back, { remindBeforeMinutes: null, parentFollowId: F1.id }), 'assignee'), /loop/);
    const onward = await job({ creator: ASSIGNEE, assignee: OTHER });
    const child = await action('set', set(u(22), onward, { remindBeforeMinutes: null, parentFollowId: F1.id }), 'assignee');
    assert.equal(child.follow.depth, 1); assert.equal(child.follow.mode, 'self');
    await assert.rejects(action('set', set(u(23), onward, { remindBeforeMinutes: null, parentFollowId: F1.id })), /parent_invalid/);
  });

  await t.test('task-create ledger quota blocks ping-pong and self-assign storms', async () => {
    for (let i = 0; i < 10; i++) {
      await db.query(`INSERT INTO app_private.hermes_task_create_receipts(organization_id,user_id,request_id,connection_id,input)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [ORG, i % 2 ? USER : ASSIGNEE, u(900 + i), CONNECTION, JSON.stringify({ assigneeId: i % 2 ? ASSIGNEE : USER })]);
    }
    await assert.rejects(f.rpc('create', { ...createInput, requestId: u(950) }), /loop_blocked/);
    assert.equal((await f.rpc('create', { ...createInput, requestId: u(951), assigneeId: null })).outcome, 'applied', 'an unassigned job is not a pair');
    for (let i = 0; i < 24; i++) {
      await db.query(`INSERT INTO app_private.hermes_task_create_receipts(organization_id,user_id,request_id,connection_id,input)
        VALUES($1,$2,$3,$4,'{}'::jsonb)`, [ORG, USER, u(960 + i), CONNECTION]);
    }
    await assert.rejects(f.rpc('create', { ...createInput, requestId: u(990), assigneeId: null }), /quota_exceeded/);
    await db.exec(`UPDATE app_private.hermes_task_create_receipts SET started_at=started_at-interval '2 hours'`);
    assert.equal((await f.rpc('create', { ...createInput, requestId: u(991) })).outcome, 'applied', 'quota is a rolling hour');
  });

  await t.test('stop needs current version and only the assigner; web stop is always available', async () => {
    const J2 = await job({ deadline: iso(7200_000) });
    const own = (await action('set', set(u(30), J2))).follow;
    await assert.rejects(action('stop', { organizationId: ORG, requestId: u(31), followId: own.id, expectedVersion: 2 }), /context_changed/);
    await assert.rejects(action('stop', { organizationId: ORG, requestId: u(32), followId: own.id, expectedVersion: 1 }, 'assignee'), /denied/);
    await assert.rejects(web('hermes_my_task_follow_stop_v1', { followId: own.id, expectedVersion: 1 }, 'assignee'), /denied/);
    const stopped = await web('hermes_my_task_follow_stop_v1', { followId: own.id, expectedVersion: 1 });
    assert.equal(stopped.state, 'cancelled');
    const closed = await web('hermes_my_task_follows_v1', { role: 'assigned_by_me', state: 'closed', offset: 0 });
    assert.equal(closed.items.find(item => item.id === own.id).closeReason, 'stopped');
    const executorView = await web('hermes_my_task_follows_v1', { role: 'assigned_to_me', state: 'active', offset: 0 }, 'assignee');
    assert.ok(executorView.items.some(item => item.id === F1.id && item.jobStatus === 'IN_PROGRESS'));
  });

  await t.test('tick: due reminder, overdue for both parties, merged per recipient, push via pg_net when JWT exists', async () => {
    const J3 = await job({ title: 'Kiểm tra điện', deadline: iso(20 * 60_000) });
    await action('set', set(u(40), J3, { remindBeforeMinutes: 30 }));
    await db.exec('INSERT INTO public.fixture_jwt VALUES (\'service.jwt.value\')');
    const first = await tick();
    assert.ok(first.checked >= 2);
    const due = (await notices(db, ASSIGNEE)).filter(n => n.metadata.kind === 'due');
    assert.equal(due.length, 1, 'two due jobs for one executor become one notification');
    assert.equal(due[0].metadata.count, 2);
    assert.equal(due[0].push_state, null);
    assert.match(due[0].content, /\(hạn \d{2}:\d{2} \d{2}\/\d{2}\)/);
    assert.ok((await db.query('SELECT count(*)::int n FROM public.fixture_push')).rows[0].n >= 1);
    assert.deepEqual(await tick().then(r => r.notified), 0, 'second tick does not repeat');
    await db.query(`UPDATE public.jobs SET deadline=clock_timestamp()-interval '1 minute' WHERE id=ANY($1::uuid[])`, [[J1, J3]]);
    await tick();
    assert.equal((await notices(db, ASSIGNEE)).filter(n => n.metadata.kind === 'overdue').length, 1);
    assert.equal((await notices(db, USER)).filter(n => n.metadata.kind === 'overdue_report').length, 1);
  });

  await t.test('tick rechecks authority: CRM revoke closes standing grants without notifying', async () => {
    await db.exec(`DELETE FROM public.fixture_perm WHERE user_id='${USER}' AND permission='tasks.create'`);
    const before = (await notices(db, USER)).length;
    const result = await tick();
    assert.ok(result.closed >= 1);
    const revoked = (await db.query(`SELECT state,close_reason FROM app_private.hermes_task_follows WHERE assigner_user_id=$1 AND state<>'CANCELLED'`, [USER])).rows;
    assert.ok(revoked.every(row => row.state === 'REVOKED' && row.close_reason === 'permission_lost'));
    assert.equal((await notices(db, USER)).length, before);
    const view = await web('hermes_my_task_follows_v1', { role: 'assigned_by_me', state: 'closed', offset: 0 });
    assert.ok(view.items.filter(item => item.state === 'revoked').every(item => item.jobStatus === 'UNKNOWN' && item.deadline === null));
    await db.exec(`INSERT INTO public.fixture_perm(user_id,permission,building_id) VALUES('${USER}','tasks.create','${BUILDING}')`);
  });

  await t.test('cancel deletes only clean open jobs through RLS, closes follows and notifies the executor', async () => {
    const J4 = await job({ title: 'Dọn kho', deadline: iso(86400_000) });
    await action('set', set(u(50), J4, { remindBeforeMinutes: null }));
    await db.query('INSERT INTO public.material_usages(job_id) VALUES($1)', [J4]);
    await assert.rejects(action('cancel', { organizationId: ORG, requestId: u(51), jobId: J4, reason: 'Không cần nữa' }), /cancel_blocked/);
    await db.query('DELETE FROM public.material_usages WHERE job_id=$1', [J4]);
    await assert.rejects(action('cancel', { organizationId: ORG, requestId: u(52), jobId: J4, reason: 'Không cần nữa' }, 'assignee'), /denied/);
    const cancelled = await action('cancel', { organizationId: ORG, requestId: u(53), jobId: J4, reason: 'Không cần nữa' });
    assert.equal(cancelled.job.status, 'DELETED'); assert.equal(cancelled.closedFollows, 1); assert.equal(cancelled.notified, 1);
    assert.equal((await db.query('SELECT count(*)::int n FROM public.jobs WHERE id=$1', [J4])).rows[0].n, 0);
    assert.deepEqual(await action('cancel', { organizationId: ORG, requestId: u(53), jobId: J4, reason: 'Không cần nữa' }), cancelled);
    const notice = (await notices(db, ASSIGNEE)).find(n => n.metadata.kind === 'cancelled');
    assert.match(notice.content, /Không cần nữa/); assert.equal(notice.job_id, null);
    const audit = (await db.query(`SELECT new_state FROM public.authorization_audit_events WHERE event_type='HERMES_TASK_CANCELLED'`)).rows[0].new_state;
    assert.equal(audit.actor, USER); assert.equal(audit.executor, ASSIGNEE);
    const completed = await job({ status: 'COMPLETED' });
    await assert.rejects(action('cancel', { organizationId: ORG, requestId: u(54), jobId: completed, reason: 'Xoá lương' }), /context_changed/);
    await db.exec(`UPDATE public.fixture_perm SET rls_blocked=true WHERE user_id='${USER}' AND permission='tasks.delete'`);
    const J5 = await job();
    await assert.rejects(action('cancel', { organizationId: ORG, requestId: u(55), jobId: J5, reason: 'RLS' }), /denied/);
    assert.equal((await db.query('SELECT count(*)::int n FROM public.jobs WHERE id=$1', [J5])).rows[0].n, 1);
  });

  await t.test('Hermes capability gates: registry off or connection without action denies', async () => {
    const J6 = await job();
    await db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='tasks.delete'");
    await db.exec(`UPDATE public.fixture_perm SET rls_blocked=false`);
    await assert.rejects(action('cancel', { organizationId: ORG, requestId: u(60), jobId: J6, reason: 'Thử' }), /denied/);
    await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='tasks.delete'");
    const J7 = await job({ creator: ASSIGNEE });
    await db.exec(`UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['tasks.create'] WHERE id='${binding2.connectionId}'`);
    await assert.rejects(action('progress', { organizationId: ORG, requestId: u(62), jobId: J7, note: 'Ghi chú', expectedNoteDigest: md5('') }, 'assignee'), /denied/);
    await db.exec(`UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['tasks.create','tasks.edit'] WHERE id='${binding2.connectionId}'`);
    assert.equal((await action('progress', { organizationId: ORG, requestId: u(63), jobId: J7, note: 'Ghi chú', expectedNoteDigest: md5('') }, 'assignee')).outcome, 'applied');
  });
});
