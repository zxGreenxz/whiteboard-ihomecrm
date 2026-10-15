import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { installGroupSendSql } from '../hermes-zalo-router/group-send-sql-fixture.mjs';
import { setupMount, token } from './group-preview-fixture.mjs';
import { createHash } from 'node:crypto';
import { ORG, USER, INSTANCE, SESSION, ACCOUNT, FOREIGN } from '../hermes-zalo-router/private-command-fixture.mjs';
import { scheduleInput } from './schedule-contract.mjs';
import { tickHermesSchedules } from '../../worker/lib/hermes-schedule.js';
const migration = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
const migrationRoot = new URL('../../supabase/migrations/', import.meta.url);
const candidates = readdirSync(migrationRoot).filter(name => /^\d{14}_hermes_room_schedule_v1\.sql$/.test(name));
assert.equal(candidates.length, 1, 'one forward schedule migration');
const draft = readFileSync(new URL(candidates[0], migrationRoot), 'utf8');
const REQUEST = '56789012-1234-4567-8123-123456789abc';
const NEXT = '67890123-1234-4567-8123-123456789abc';
test('schedule transport rejects impersonation, incomplete grants and duplicate targets', () => {
  const now = Date.now(), settings = { template: 'rooms_public_text_v1', buildingIds: [REQUEST], conversationIds: [NEXT], weekdays: [1, 2],
    time: '08:30', timeZone: 'Asia/Ho_Chi_Minh', maxRooms: 20, maxMessagesPerDay: 2, expiresAt: new Date(now + 86400000).toISOString() };
  assert.equal(scheduleInput('create', { requestId: REQUEST, settings }, now).settings.time, '08:30');
  for (const bad of [{ requestId: REQUEST, settings, actor: USER }, { requestId: REQUEST, settings: { ...settings, conversationIds: [NEXT, NEXT] } },
    { requestId: REQUEST, settings: { ...settings, expiresAt: new Date(now + 31 * 86400000).toISOString() } },
    { requestId: REQUEST, settings: { ...settings, timeZone: 'invalid' } }]) assert.throws(() => scheduleInput('create', bad, now));
});
test('one existing scheduler tick issues one run per candidate and never retries an unknown outcome', async () => {
  const calls = [], db = { async rpc(name, input) { calls.push({ name, input }); return name.endsWith('due_v1')
    ? { data: [{ scheduleId: REQUEST, revision: 1 }, { scheduleId: NEXT, revision: 3 }] }
    : input.p_schedule_id === REQUEST ? { error: { code: 'network' } } : { data: { status: 'already_run' } }; } };
  assert.deepEqual(await tickHermesSchedules({ db, instanceId: INSTANCE }), [
    { scheduleId: REQUEST, status: 'unverified' }, { scheduleId: NEXT, status: 'already_run' },
  ]);
  // One run attempt each, then one maintenance sweep (its invalid reply is only logged).
  assert.deepEqual(calls.map(call => call.name), ['hermes_room_schedule_due_v1', 'hermes_room_schedule_run_v2',
    'hermes_room_schedule_run_v2', 'hermes_room_schedule_sweep_v1']);
});
test('actual draft SQL: current rights, grant lifecycle, current rooms and provider revocation', { timeout: 60000 }, async t => {
  const hooks = {}, x = await setupMount(t, hooks), { f, BUILDING, GROUP } = x, db = f.db;
  Object.assign(x, await installGroupSendSql(x));
  await db.exec(migration('20261013095000_hermes_zalo_private_reply_v1'));
  await db.exec(migration('20261014000503_hermes_optional_org_policy_v1'));
  await db.exec(migration('20261014000538_hermes_external_group_connector_v1'));
  await db.exec(`CREATE FUNCTION app_private.org_timezone_v1(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'Asia/Ho_Chi_Minh'::text$$;
    ALTER TABLE public.fixture_authority ADD COLUMN manage_schedule boolean DEFAULT true;
    INSERT INTO app_private.hermes_capabilities VALUES('chat_zalo.manage_automation','action',true);
    UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['chat_zalo.send','chat_zalo.manage_automation'];
    UPDATE app_private.hermes_org_policies SET action_capabilities=ARRAY['chat_zalo.send','chat_zalo.manage_automation'];
    CREATE OR REPLACE FUNCTION app_private.authorize_tenant_action_v3(p_actor uuid,p_organization_id uuid,p_permission_key text,p_building_id uuid DEFAULT NULL,p_cashbook_id uuid DEFAULT NULL)
      RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz,evaluated_at timestamptz,decision_reason text)
      LANGUAGE sql AS $$SELECT p_actor='${USER}'::uuid AND p_organization_id='${ORG}'::uuid AND CASE p_permission_key
        WHEN 'chat_zalo.send' THEN send_zalo AND org_wide WHEN 'chat_zalo.view' THEN view_zalo AND org_wide
        WHEN 'chat_zalo.manage_automation' THEN manage_schedule AND org_wide WHEN 'rooms.view' THEN rooms AND p_building_id='${BUILDING}'::uuid ELSE false END,
        version,NULL::timestamptz,clock_timestamp(),'fixture'::text FROM public.fixture_authority$$;`);
  await db.exec(draft); await db.exec(draft);
  const binding = { ...x.baseline, tokenDigest: createHash('sha256').update(token).digest('hex') }; delete binding.commandId; delete binding.claimId;
  const temporal = (await db.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI') time,
    extract(isodow FROM clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::integer weekday`)).rows[0];
  const settings = () => ({ template: 'rooms_public_text_v1', buildingIds: [BUILDING], conversationIds: [GROUP], weekdays: [temporal.weekday],
    time: temporal.time, timeZone: 'Asia/Ho_Chi_Minh', maxRooms: 20, maxMessagesPerDay: 8, expiresAt: new Date(Date.now() + 86400000).toISOString() });
  // The production worker renews its 30-second lease independently. This SQL
  // fixture has no background worker: explicitly supply a live heartbeat at
  // each boundary instead of letting a long history test expire later cases.
  const heartbeat = () => db.exec('UPDATE public.zalo_worker_lease SET heartbeat_at=clock_timestamp()');
  const provider = x.provider;
  x.provider = async (...args) => { await heartbeat(); return provider(...args); };
  async function manage(operation, input, liveWorker = true) {
    if (liveWorker) await heartbeat();
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session',$2,false)", [USER, SESSION]);
    return f.rpc('public.hermes_room_schedule_manage_v1', { binding, operation, input }, 'authenticated');
  }
  async function worker(name, params, liveWorker = true) {
    if (liveWorker) await heartbeat();
    await db.exec('SAVEPOINT schedule_worker; SET LOCAL ROLE service_role');
    await db.query("SELECT set_config('request.jwt.claim.role','service_role',true)");
    try { const result = await db.query(`SELECT public.${name}(${params.map((_, i) => '$' + (i + 1)).join(',')}) result`, params);
      await db.exec('RELEASE SAVEPOINT schedule_worker'); return result.rows[0].result;
    } catch (error) { await db.exec('ROLLBACK TO SAVEPOINT schedule_worker; RELEASE SAVEPOINT schedule_worker'); throw error; }
    finally { await db.exec('RESET ROLE'); }
  }
  const run = () => worker('hermes_room_schedule_run_v1', [REQUEST, 1, INSTANCE]);
  const each = (name, body) => t.test(name, () => f.rollbackCase(async () => { await heartbeat(); await body(); }));
  await each('expired worker heartbeat still denies create and execution; explicit renewal restores admission', async () => {
    const stale = () => db.exec("UPDATE public.zalo_worker_lease SET heartbeat_at=clock_timestamp()-interval '31 seconds'");
    await stale();
    await assert.rejects(() => manage('create', { requestId: REQUEST, settings: settings() }, false), error => error.code === '42501');
    await manage('create', { requestId: REQUEST, settings: settings() });
    await stale();
    await assert.rejects(() => worker('hermes_room_schedule_run_v1', [REQUEST, 1, INSTANCE], false), error => error.code === '42501');
    assert.equal((await run()).status, 'queued');
  });
  await each('create, list, queue once with Copilot disabled and no DM command', async () => {
    const input = { requestId: REQUEST, settings: settings() };
    assert.equal((await manage('create', input)).schedule.state, 'ACTIVE');
    assert.deepEqual(await manage('create', input), await manage('create', input));
    assert.equal((await manage('list', {})).schedules.length, 1);
    assert.deepEqual(await worker('hermes_room_schedule_due_v1', [INSTANCE, [ORG]]), [{ scheduleId: REQUEST, revision: 1 }]);
    assert.equal((await run()).status, 'queued');
    assert.equal((await run()).status, 'already_run');
    assert.deepEqual(await worker('hermes_room_schedule_due_v1', [INSTANCE, [ORG]]), []);
    assert.equal((await db.query('SELECT count(*)::integer n FROM public.zalo_send_queue')).rows[0].n, 1);
  });
  await each('bounded keyset history remains readable past 100 revoked schedules', async () => {
    for (let index=0;index<102;index++) {
      const scheduleId='10000000-0000-4000-8000-'+index.toString(16).padStart(12,'0');
      const revokeId='20000000-0000-4000-8000-'+index.toString(16).padStart(12,'0');
      await manage('create',{requestId:scheduleId,settings:settings()});
      await manage('revoke',{requestId:revokeId,scheduleId,expectedRevision:1});
    }
    const seen=new Set(); let cursor=null;
    // v1 keyset SQL; the broker contract now validates manage_v2 output
    // (schedule-health-sql.test.mjs covers that page shape end to end).
    do { const input=scheduleInput('list',{limit:20,cursor}), page=await manage('list',input);
      assert.ok(page.schedules.length<=20); assert.ok(page.nextCursor===null||page.nextCursor===page.schedules.at(-1).scheduleId);
      for(const row of page.schedules) { assert.equal(seen.has(row.scheduleId),false); seen.add(row.scheduleId); }
      cursor=page.nextCursor;
    } while(cursor);
    assert.equal(seen.size,102);
  });
  await each('due candidate progress rotates beyond a failed first 100 without revoking grants', async () => {
    await manage('create',{requestId:REQUEST,settings:settings()});
    await db.exec(`INSERT INTO app_private.hermes_room_schedules(id,user_id,organization_id,connection_id,grant_id,revision,state,last_request_id,last_request_digest)
      SELECT ('10000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,user_id,organization_id,connection_id,grant_id,revision,state,last_request_id,last_request_digest
      FROM app_private.hermes_room_schedules CROSS JOIN generate_series(1,101) n WHERE id='${REQUEST}'`);
    await db.exec(`WITH copies AS (INSERT INTO app_private.hermes_schedule_grants(schedule_id,revision,user_id,organization_id,connection_id,binding_id,binding_epoch,account_id,settings,request_id,request_digest,expires_at)
      SELECT s.id,g.revision,g.user_id,g.organization_id,g.connection_id,g.binding_id,g.binding_epoch,g.account_id,
        jsonb_set(g.settings,'{conversationIds}','["${NEXT}"]'),g.request_id,g.request_digest,g.expires_at
      FROM app_private.hermes_room_schedules s JOIN app_private.hermes_schedule_grants g ON g.id=s.grant_id WHERE s.id<>'${REQUEST}' RETURNING id,schedule_id)
      UPDATE app_private.hermes_room_schedules s SET grant_id=c.id FROM copies c WHERE s.id=c.schedule_id`);
    const first=await worker('hermes_room_schedule_due_v1',[INSTANCE,[ORG]]);
    assert.equal(first.length,100); assert.equal(first.some(row=>row.scheduleId===REQUEST),false);
    await assert.rejects(worker('hermes_room_schedule_run_v1',[first[0].scheduleId,1,INSTANCE]),error=>error.code==='42501');
    const second=await worker('hermes_room_schedule_due_v1',[INSTANCE,[ORG]]);
    assert.equal(second.some(row=>row.scheduleId===REQUEST),true);
    assert.equal((await run()).status,'queued');
    assert.equal((await db.query("SELECT count(*)::integer n FROM app_private.hermes_room_schedules WHERE state='ACTIVE'")).rows[0].n,102);
  });
  await each('current manage/send/read denial stops execution', async () => {
    await manage('create', { requestId: REQUEST, settings: settings() });
    for (const column of ['manage_schedule', 'send_zalo', 'rooms', 'view_zalo']) {
      await db.exec(`UPDATE public.fixture_authority SET ${column}=false`);
      await assert.rejects(run, error => error.code === '42501');
      await db.exec(`UPDATE public.fixture_authority SET ${column}=true`);
    }
  });
  await each('current public room price reaches the existing provider gate and generic admission stays denied', async () => {
    await manage('create', { requestId: REQUEST, settings: settings() });
    await db.exec('UPDATE public.rooms SET rent_price=6000000');
    assert.equal((await run()).status, 'queued');
    const job = (await db.query('SELECT id,payload FROM public.zalo_send_queue')).rows[0];
    assert.match(job.payload.body, /6\.000\.000 đ\/tháng/);
    await db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$1 WHERE id=$2", [INSTANCE, job.id]);
    assert.equal(await x.provider(job.id, {}, true), false);
    assert.equal(await x.provider(job.id, { body: job.payload.body, ownUid: '1'.repeat(40) }), true);
    assert.equal(await x.provider(job.id, { body: job.payload.body, ownUid: '1'.repeat(40) }), false);
  });
  await each('update replaces grant evidence, denies stale revisions and invalidates queued old grants', async () => {
    const original = settings();
    await manage('create', { requestId: REQUEST, settings: original });
    assert.equal((await run()).status, 'queued');
    const updated = await manage('update', { requestId: NEXT, scheduleId: REQUEST, expectedRevision: 1, settings: { ...original, maxRooms: 19 } });
    assert.equal(updated.schedule.revision, 2);
    assert.equal((await db.query('SELECT count(*)::integer n FROM app_private.hermes_schedule_grants')).rows[0].n, 2);
    const job = (await db.query('SELECT id,payload FROM public.zalo_send_queue')).rows[0];
    await db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$1 WHERE id=$2", [INSTANCE, job.id]);
    await assert.rejects(() => x.provider(job.id, { body: job.payload.body, ownUid: '1'.repeat(40) }), error => error.code === '42501');
    assert.equal((await worker('hermes_room_schedule_run_v1', [REQUEST, 2, INSTANCE])).status, 'already_run');
    await assert.rejects(() => manage('update', { requestId: x.ROOM, scheduleId: REQUEST, expectedRevision: 1, settings: original }), error => error.code === 'PT409');
  });
  await each('expired grant cannot queue or reach provider', async () => {
    // Only this rollback case substitutes the clock operand of the three
    // expiry guards with an explicit SQL clock port. Their predicates, actual
    // grant data, immutable triggers, queue/provider path and other clocks are
    // unchanged. No short wall-clock deadline must survive CREATE under load.
    await db.exec(`CREATE FUNCTION app_private.fixture_schedule_expiry_clock() RETURNS timestamptz LANGUAGE sql AS $$
      SELECT current_setting('hermes_fixture.expiry_clock')::timestamptz$$;
      SELECT set_config('hermes_fixture.expiry_clock',clock_timestamp()::text,true);`);
    for (const name of ['public.hermes_room_schedule_run_v1', 'app_private.hermes_schedule_current_v1', 'app_private.hermes_schedule_summary_v1']) {
      const definition = draft.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}[\\s\\S]*?\\$fn\\$;`))?.[0];
      assert.ok(definition?.includes('g.expires_at<=clock_timestamp()'), `actual expiry guard: ${name}`);
      await db.exec(definition.replaceAll('g.expires_at<=clock_timestamp()', 'g.expires_at<=app_private.fixture_schedule_expiry_clock()'));
    }
    await manage('create', { requestId: REQUEST, settings: settings() });
    const queued = await run(); assert.equal(queued.status, 'queued');
    await db.exec(`SELECT set_config('hermes_fixture.expiry_clock',expires_at::text,true)
      FROM app_private.hermes_schedule_grants WHERE schedule_id='${REQUEST}'`);
    assert.deepEqual(await run(), { status: 'skipped', reason: 'inactive_or_changed' });
    assert.equal((await manage('list', {})).schedules[0].state, 'EXPIRED');
    const job = (await db.query('SELECT id,payload FROM public.zalo_send_queue')).rows[0];
    await db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$1 WHERE id=$2", [INSTANCE, job.id]);
    await assert.rejects(() => x.provider(job.id, { body: job.payload.body, ownUid: '1'.repeat(40) }), error => error.code === '42501');
  });
  await each('recipient cadence spreads groups without a second scheduler or duplicated queue job', async () => {
    await db.query(`INSERT INTO public.zalo_conversations(id,account_id,organization_id,thread_type,thread_id,peer_name,user_id)
      VALUES($1,$2,$3,'group','988','Second synthetic group',$4)`, [NEXT, ACCOUNT, ORG, FOREIGN]);
    await manage('create', { requestId: REQUEST, settings: { ...settings(), conversationIds: [GROUP, NEXT] } });
    assert.equal((await run()).status, 'queued');
    assert.deepEqual(await run(), { status: 'skipped', reason: 'recipient_spacing' });
    assert.equal((await db.query('SELECT count(*)::integer n FROM public.zalo_send_queue')).rows[0].n, 1);
  });
  await each('restart after the catch-up window records missed targets and queues nothing', async () => {
    // Pick a real timezone whose local hour is at least 04, independent of the
    // machine clock. The fixture org timezone is an explicit synthetic port.
    const zone = ['UTC', 'Etc/GMT+12'].find(timeZone => Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date())) >= 4);
    await db.exec(`CREATE OR REPLACE FUNCTION app_private.org_timezone_v1(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT '${zone}'::text$$`);
    const day = (await db.query('SELECT extract(isodow FROM clock_timestamp() AT TIME ZONE $1)::integer AS weekday', [zone])).rows[0].weekday;
    await manage('create', { requestId: REQUEST, settings: { ...settings(), timeZone: zone, weekdays: [day], time: '00:00' } });
    assert.deepEqual(await run(), { status: 'skipped', reason: 'missed_window' });
    assert.equal((await run()).status, 'already_run');
    assert.equal((await db.query('SELECT count(*)::integer n FROM public.zalo_send_queue')).rows[0].n, 0);
    assert.deepEqual(await worker('hermes_room_schedule_due_v1', [INSTANCE, [ORG]]), []);
  });
  await each('revoke invalidates an already queued dispatch before provider admission', async () => {
    await manage('create', { requestId: REQUEST, settings: settings() });
    const receipt = await run(); assert.equal(receipt.status, 'queued');
    const revoked = await manage('revoke', { requestId: NEXT, scheduleId: REQUEST, expectedRevision: 1 });
    assert.equal(revoked.schedule.state, 'REVOKED');
    const job = (await db.query('SELECT id FROM public.zalo_send_queue')).rows[0].id;
    await db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$1 WHERE id=$2", [INSTANCE, job]);
    await assert.rejects(() => x.provider(job), error => error.code === '42501');
    assert.equal((await db.query('SELECT provider_started_at FROM public.zalo_send_queue WHERE id=$1', [job])).rows[0].provider_started_at, null);
  });
  await each('legacy schedule ownership overlap fails closed', async () => {
    await db.query("INSERT INTO public.zalo_automations(organization_id,kind,enabled,config) VALUES($1,'broadcast_vacant',true,$2)", [ORG, JSON.stringify({ recipients: [GROUP] })]);
    await assert.rejects(() => manage('create', { requestId: REQUEST, settings: settings() }), error => error.code === 'PT409');
  });
  await each('legacy reactivation is blocked by active ownership and then by undrained jobs after revocation', async () => {
    await manage('create', { requestId: REQUEST, settings: settings() });
    const insert = () => db.query("INSERT INTO public.zalo_automations(organization_id,kind,enabled,config) VALUES($1,'broadcast_vacant',true,$2)", [ORG, JSON.stringify({ recipients: [GROUP] })]);
    await db.exec('SAVEPOINT legacy_owner');
    await assert.rejects(insert, error => error.code === 'PT409');
    await db.exec('ROLLBACK TO SAVEPOINT legacy_owner; RELEASE SAVEPOINT legacy_owner');
    await run();
    await manage('revoke', { requestId: NEXT, scheduleId: REQUEST, expectedRevision: 1 });
    await db.exec('SAVEPOINT legacy_owner');
    await assert.rejects(insert, error => error.code === 'PT409');
    await db.exec('ROLLBACK TO SAVEPOINT legacy_owner; RELEASE SAVEPOINT legacy_owner');
    await db.exec(`UPDATE public.zalo_send_queue SET status='failed',result='{"outcome":"unknown","requires_reconciliation":true}'::jsonb`);
    assert.equal((await manage('list', {})).schedules[0].lastRuns[0].deliveryStatus, 'unknown');
    await db.exec('SAVEPOINT legacy_owner');
    await assert.rejects(insert, error => error.code === 'PT409');
    await db.exec('ROLLBACK TO SAVEPOINT legacy_owner; RELEASE SAVEPOINT legacy_owner');
    await assert.rejects(() => manage('create', { requestId: x.ROOM, settings: settings() }), error => error.code === 'PT409');
    await db.exec("UPDATE public.zalo_send_queue SET result='{}'::jsonb");
    await insert();
  });
  // The session-bound mount now calls manage_v2; its end-to-end receipt test
  // lives with the forward migrations in schedule-health-sql.test.mjs.
});
