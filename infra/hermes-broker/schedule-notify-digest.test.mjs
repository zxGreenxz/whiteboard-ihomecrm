import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setupScheduleHealth, SCHEDULE } from './schedule-health-fixture.mjs';
import { notifyRetryDigestSql } from './notify-retry-digest-fixture.mjs';
import { ORG, USER } from '../hermes-zalo-router/private-command-fixture.mjs';

// 20261015181525_hermes_notify_retry_digest_v1 (2): the sweep groups the
// incidents it picks in one pass by (company, schedule owner) into ONE bell
// notice; every incident still records its own attempt, a failing owner write
// does not block another owner, and transient causes still wait 15 minutes.
// Extra schedules are fixture copies of the created one (same connection and
// grant settings, own id/owner); incidents are opened through the real helper.
const OWNER2 = 'a1b2c3d4-1234-4567-8123-123456789abc';
const S2 = 'b2c3d4e5-1234-4567-8123-123456789abc', S3 = 'c3d4e5f6-1234-4567-8123-123456789abc', S4 = 'd4e5f6a7-1234-4567-8123-123456789abc';
const label = id => `Lịch bản tin phòng …${id.slice(-8)}`;

async function prepare(x, owners) {
  const { db } = x;
  await x.manage('create', { requestId: SCHEDULE, settings: x.settings() });
  await db.query('INSERT INTO auth.users VALUES($1) ON CONFLICT DO NOTHING', [OWNER2]);
  await db.query(`INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES($1,$1,$2,'ACTIVE')`, [OWNER2, ORG]);
  for (const [id, owner] of owners) {
    const grant = randomUUID();
    await db.query(`INSERT INTO app_private.hermes_room_schedules(id,user_id,organization_id,connection_id,grant_id,revision,state,last_request_id,last_request_digest)
      SELECT $1,$3,organization_id,connection_id,$2,revision,state,$1,last_request_digest FROM app_private.hermes_room_schedules WHERE id=$4`,
    [id, grant, owner, SCHEDULE]);
    await db.query(`INSERT INTO app_private.hermes_schedule_grants(id,schedule_id,revision,user_id,organization_id,connection_id,binding_id,binding_epoch,
        account_id,settings,request_id,request_digest,created_at,expires_at)
      SELECT $2,$1,revision,$3,organization_id,connection_id,binding_id,binding_epoch,account_id,settings,$1,request_digest,created_at,expires_at
      FROM app_private.hermes_schedule_grants WHERE schedule_id=$4`, [id, grant, owner, SCHEDULE]);
  }
}
const open = (x, schedule, reason = 'user_permission_revoked', kind = 'authority') => x.db.query(
  'SELECT app_private.hermes_schedule_incident_open_v1($1,$2,$3,$4::jsonb)', [schedule, kind, reason, JSON.stringify({ permission: 'chat_zalo.manage_automation' })]);
const marks = async x => (await x.db.query(`SELECT schedule_id,user_id,notified_at IS NOT NULL notified,notify_result,closed_notified_at IS NOT NULL closed_notified
  FROM app_private.hermes_schedule_incidents ORDER BY opened_at,id`)).rows;
const poison = (x, user) => x.db.exec(`CREATE FUNCTION public.fixture_bell_poison() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.user_id='${user}' THEN RAISE EXCEPTION 'fixture bell poison'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER fixture_bell_poison BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.fixture_bell_poison();`);

async function oneOwnerOneNotice(x) {
  await prepare(x, [[S2, USER], [S3, USER]]);
  for (const schedule of [SCHEDULE, S2, S3]) await open(x, schedule);
  assert.equal((await x.sweep()).notified, 3, 'three incidents recorded');
  const notes = await x.notifications();
  assert.equal(notes.length, 1, 'one bell for one owner');
  assert.deepEqual([notes[0].user_id, notes[0].organization_id, notes[0].type, notes[0].channel], [USER, ORG, 'CUSTOM', 'IN_APP']);
  assert.match(notes[0].subject, /3 vấn đề/);
  for (const schedule of [SCHEDULE, S2, S3]) assert.ok(notes[0].content.includes(`${label(schedule)}: tài khoản không còn quyền CRM`), schedule);
  assert.doesNotMatch(notes[0].content, /đã gửi/);
  assert.deepEqual([notes[0].metadata.phase, notes[0].metadata.count, notes[0].metadata.url, notes[0].metadata.reasons],
    ['opened', 3, '/settings/hermes', ['user_permission_revoked']]);
  assert.deepEqual([...notes[0].metadata.scheduleIds].sort(), [SCHEDULE, S2, S3].sort());
  const rows = await marks(x);
  assert.deepEqual(notes[0].metadata.incidentIds, (await x.db.query('SELECT id FROM app_private.hermes_schedule_incidents ORDER BY opened_at,id')).rows.map(row => row.id));
  assert.ok(rows.every(row => row.notified && row.notify_result.bell === true && row.notify_result.incidents === 3), 'every incident marked');
  assert.match(rows[0].notify_result.pushError, /^55000/, 'marked TEST: bell only');
  assert.equal((await x.sweep()).notified, 0);
  assert.equal((await x.notifications()).length, 1, 'never repeated');
}

async function ownersIsolated(x) {
  await prepare(x, [[S2, USER], [S3, OWNER2], [S4, OWNER2]]);
  for (const schedule of [SCHEDULE, S2, S3, S4]) await open(x, schedule);
  await poison(x, OWNER2);
  assert.equal((await x.sweep()).notified, 4);
  const notes = await x.notifications();
  assert.deepEqual(notes.map(note => [note.user_id, note.metadata.count]), [[USER, 2]], 'the failing owner does not block the other');
  const rows = await marks(x);
  assert.ok(rows.every(row => row.notified), 'each attempt is recorded once, never retried in a loop');
  assert.deepEqual(rows.filter(row => row.user_id === OWNER2).map(row => row.notify_result), [{ error: 'P0001' }, { error: 'P0001' }]);
  assert.ok(rows.filter(row => row.user_id === USER).every(row => row.notify_result.bell === true));
}

test('schedule incident notices are grouped per owner in one sweep', { timeout: 300000 }, async t => {
  const x = await setupScheduleHealth(t, { reconcile: true });

  await x.each('three incidents of one owner: one notice naming each schedule and its reason; all three marked', () => oneOwnerOneNotice(x));

  await x.each('two owners in one company: one notice each', async () => {
    await prepare(x, [[S2, USER], [S3, OWNER2], [S4, OWNER2]]);
    for (const schedule of [SCHEDULE, S2, S3, S4]) await open(x, schedule);
    assert.equal((await x.sweep()).notified, 4);
    const notes = await x.notifications();
    assert.deepEqual(notes.map(note => [note.user_id, note.metadata.count]).sort(), [[OWNER2, 2], [USER, 2]].sort());
    for (const note of notes) assert.match(note.subject, /2 vấn đề/);
    assert.ok((await marks(x)).every(row => row.notified && row.notify_result.incidents === 2));
  });

  await x.each('one owner failing to write the bell does not block another owner', () => ownersIsolated(x));

  await x.each('recovery of several schedules of one owner is one notice', async () => {
    await prepare(x, [[S2, USER], [S3, USER]]);
    for (const schedule of [SCHEDULE, S2, S3]) await open(x, schedule);
    await x.sweep();
    for (const schedule of [SCHEDULE, S2, S3]) {
      await x.db.query("SELECT app_private.hermes_schedule_incident_close_v1($1,ARRAY['authority','run'],'{}'::text[],'recovered')", [schedule]);
    }
    assert.equal((await x.sweep()).notified, 3);
    const notes = await x.notifications();
    assert.equal(notes.length, 2);
    assert.match(notes[1].subject, /đã chạy lại \(3 lịch\)/);
    assert.equal(notes[1].metadata.phase, 'recovered');
    for (const schedule of [SCHEDULE, S2, S3]) assert.ok(notes[1].content.includes(label(schedule)), schedule);
    assert.doesNotMatch(notes[1].content, /đã gửi/);
    assert.ok((await marks(x)).every(row => row.closed_notified));
    await x.sweep();
    assert.equal((await x.notifications()).length, 2);
  });

  await x.each('a transient cause still waits 15 minutes; a single incident keeps the v1 notice', async () => {
    await prepare(x, [[S2, USER]]);
    await open(x, SCHEDULE);
    await open(x, S2, 'zalo_sender_unavailable');
    assert.equal((await x.sweep()).notified, 1);
    let notes = await x.notifications();
    assert.deepEqual([notes.length, notes[0].metadata.reason, notes[0].metadata.scheduleId], [1, 'user_permission_revoked', SCHEDULE], 'v1 shape for one');
    await x.ageRow("UPDATE app_private.hermes_schedule_incidents SET opened_at=opened_at-interval '16 minutes' WHERE reason='zalo_sender_unavailable'");
    assert.equal((await x.sweep()).notified, 1);
    notes = await x.notifications();
    assert.deepEqual([notes.length, notes[1].metadata.reason], [2, 'zalo_sender_unavailable']);
  });

  await t.test('the digest helper stays private and refuses mixed or oversized groups', async () => {
    for (const role of ['anon', 'authenticated', 'service_role', 'hermes_store_executor']) {
      assert.equal((await x.db.query("SELECT has_function_privilege($1,'app_private.hermes_schedule_notify_v2(uuid[],text)','EXECUTE') ok", [role])).rows[0].ok, false, role);
    }
    await x.f.rollbackCase(async () => {
      await x.heartbeat();
      await prepare(x, [[S2, OWNER2]]);
      for (const schedule of [SCHEDULE, S2]) await open(x, schedule);
      const ids = (await x.db.query('SELECT id FROM app_private.hermes_schedule_incidents ORDER BY opened_at,id')).rows.map(row => row.id);
      const call = async (list, phase = 'opened') => (await x.db.query('SELECT app_private.hermes_schedule_notify_v2($1::uuid[],$2) r', [list, phase])).rows[0].r;
      assert.deepEqual(await call(ids), { skipped: 'invalid' }, 'two owners never share a notice');
      assert.deepEqual(await call([ids[0], ids[0]]), { skipped: 'invalid' });
      assert.deepEqual(await call(Array.from({ length: 21 }, () => randomUUID())), { skipped: 'invalid' });
      assert.deepEqual(await call(ids, 'other'), { skipped: 'invalid' });
      assert.equal((await x.notifications()).length, 0);
    });
  });
});

// Mutation evidence: the same scenario that passes on the original SQL must
// fail on each mutant (not vacuous).
const original = notifyRetryDigestSql();
const mutant = (from, to) => {
  const next = original.replace(from, to);
  assert.notEqual(next, original, `mutation anchor not found: ${from}`);
  return next;
};
for (const [name, sql, scenario] of [
  ['one notice per incident instead of per owner',
    mutant('GROUP BY picked.organization_id,picked.user_id ORDER BY min(picked.opened_at)',
      'GROUP BY picked.organization_id,picked.user_id,picked.id ORDER BY min(picked.opened_at)'), oneOwnerOneNotice],
  ['only the first incident of a group is marked',
    mutant('notify_result=v_result WHERE id=ANY(v_group.ids)', 'notify_result=v_result WHERE id=v_group.ids[1]'), oneOwnerOneNotice],
  ['an owner write failure is not isolated',
    mutant("BEGIN v_result:=app_private.hermes_schedule_notify_v2(v_group.ids,'opened');\n    EXCEPTION WHEN OTHERS THEN v_result:=jsonb_build_object('error',SQLSTATE); END;",
      "v_result:=app_private.hermes_schedule_notify_v2(v_group.ids,'opened');"), ownersIsolated],
]) {
  test(`mutation caught: ${name}`, { timeout: 300000 }, async t => {
    const x = await setupScheduleHealth(t, { reconcile: true, digest: sql });
    await assert.rejects(x.f.rollbackCase(async () => { await x.heartbeat(); await scenario(x); }));
  });
}
