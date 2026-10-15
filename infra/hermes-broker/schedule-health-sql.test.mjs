import test from 'node:test';
import assert from 'node:assert/strict';
import { setupScheduleHealth, SCHEDULE, NEXT, candidate } from './schedule-health-fixture.mjs';
import { ORG, USER, ACCOUNT, FOREIGN, INSTANCE, SESSION } from '../hermes-zalo-router/private-command-fixture.mjs';
import { token } from './group-preview-fixture.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createScheduleMount } from './schedule-mount.mjs';
import { scheduleInput, scheduleResult } from './schedule-contract.mjs';

const code = expected => error => error.code === expected;
const OTHER = '78901234-1234-4567-8123-123456789abc', LEGACY = '89012345-1234-4567-8123-123456789abc', SEND = '9abcdef0-1234-4567-8123-123456789abc';
const uid40 = '1'.repeat(40);
const ZONED = 'abcdef01-1234-4567-8123-123456789abc';

test('schedule health SQL: durable blocked evidence, owner notice, recipient split, policy mode, reconciliation', { timeout: 300000 }, async t => {
  const hooks = {}, x = await setupScheduleHealth(t, { reconcile: true, hooks }), { db } = x;
  const create = (settings = x.settings(), requestId = SCHEDULE) => x.manage('create', { requestId, settings });
  const processing = jobId => db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$1 WHERE id=$2", [INSTANCE, jobId]);
  const insertLegacyUnknown = () => db.query(`INSERT INTO public.zalo_send_queue(id,user_id,organization_id,account_id,conversation_id,channel,payload,status,result,last_error)
    VALUES($1,$2,$3,$4,$5,'personal',$6::jsonb,'failed',$7::jsonb,'UNKNOWN_EFFECT: worker dừng khi chưa xác nhận kết quả; không gửi lại tự động')`,
  [LEGACY, FOREIGN, ORG, ACCOUNT, x.GROUP, JSON.stringify({ tu_dong: true, type: 'text', body: 'Bản tin phòng cũ' }), JSON.stringify({ outcome: 'unknown', requires_reconciliation: true })]);
  // One-off connector send (external MCP origin) through the actual SQL path.
  async function externalSend() {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session',$2,false)", [USER, SESSION]);
    await x.heartbeat();
    const binding = { ...x.binding, requestId: SEND };
    const directory = await x.f.rpc('public.hermes_external_group_directory_v1', binding, 'authenticated');
    const ack = await x.f.rpc('public.hermes_external_group_send_v1', { ...binding, roomIds: [x.ROOM], conversationIds: [x.GROUP],
      expectedContextVersion: directory.authority.contextVersion, intentDigest: 'c'.repeat(64), roomReadDigest: 'd'.repeat(64) }, 'authenticated');
    return ack.dispatch.recipients[0].jobId;
  }
  const resolve = (targetId, decision, requestId = NEXT, kind = 'queue_job', note = 'Đã kiểm trực tiếp trong nhóm Zalo') =>
    x.ui('resolve', { organizationId: ORG, requestId, kind, targetId, decision, note });

  await x.each('denied run is durable, the owner is told once, repeats aggregate, recovery closes and tells once', async () => {
    await create();
    await db.exec('UPDATE public.fixture_authority SET manage_schedule=false');
    assert.deepEqual(await x.run(), { status: 'blocked', reason: 'user_permission_revoked', closedRecipients: 0 });
    await x.run();
    let rows = await x.incidents();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].kind, rows[0].reason, rows[0].occurrences], ['authority', 'user_permission_revoked', 2]);
    assert.deepEqual(rows[0].detail, { permission: 'chat_zalo.manage_automation' });
    assert.equal(await x.count('public.zalo_send_queue'), 0);
    assert.equal((await x.sweep()).notified, 1);
    assert.equal((await x.sweep()).notified, 0);
    const notes = await x.notifications();
    assert.equal(notes.length, 1);
    assert.deepEqual([notes[0].user_id, notes[0].organization_id, notes[0].type, notes[0].channel], [USER, ORG, 'CUSTOM', 'IN_APP']);
    assert.match(notes[0].content, /không còn quyền CRM/);
    assert.doesNotMatch(notes[0].content, /đã gửi/);
    assert.deepEqual([notes[0].metadata.reason, notes[0].metadata.phase, notes[0].metadata.url], ['user_permission_revoked', 'opened', '/settings/hermes']);
    // Marked TEST: the reminder JWT slot refuses; bell only, refusal recorded.
    assert.equal(await x.count('net.fixture_requests'), 0);
    assert.match((await db.query('SELECT notify_result FROM app_private.hermes_schedule_incidents')).rows[0].notify_result.pushError, /^55000/);
    await db.exec('UPDATE public.fixture_authority SET manage_schedule=true');
    assert.equal((await x.run()).status, 'queued');
    rows = await x.incidents();
    assert.deepEqual([rows[0].closed, rows[0].close_reason], [true, 'recovered']);
    await x.sweep(); await x.sweep();
    const after = await x.notifications();
    assert.equal(after.length, 2);
    assert.match(after[1].subject, /chạy lại/);
    assert.equal(after[1].metadata.phase, 'recovered');
    assert.doesNotMatch(after[1].content, /đã gửi/);
  });

  for (const [name, change, reason, detail] of [
    ['CRM send permission', 'UPDATE public.fixture_authority SET send_zalo=false', 'user_permission_revoked', { permission: 'chat_zalo.send' }],
    ['CRM chat view permission', 'UPDATE public.fixture_authority SET view_zalo=false', 'user_permission_revoked', { permission: 'chat_zalo.view' }],
    ['Hermes overlay action', "UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['chat_zalo.send']", 'hermes_overlay_revoked', { capability: 'chat_zalo.manage_automation' }],
    ['company ceiling', "UPDATE app_private.hermes_org_policies SET action_capabilities=ARRAY['chat_zalo.send']", 'company_policy_revoked', { capability: 'chat_zalo.manage_automation' }],
    ['company switch', 'UPDATE app_private.hermes_org_policies SET enabled=false', 'company_policy_disabled', {}],
    ['capability registry', "UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='chat_zalo.manage_automation'", 'capability_disabled', { capability: 'chat_zalo.manage_automation' }],
    ['connection revoke', "UPDATE app_private.hermes_connections SET state='REVOKED',revoked_at=clock_timestamp()", 'connection_revoked', {}],
    ['connection token revoke', 'UPDATE app_private.hermes_connection_tokens SET revoked_at=clock_timestamp()', 'connection_token_expired', {}],
    ['membership revoke', "UPDATE public.organization_memberships SET status='REVOKED'", 'membership_inactive', {}],
    ['building rooms.view scope', 'UPDATE public.fixture_authority SET rooms=false', 'scope_narrowed', 'building'],
    ['connection scope', "UPDATE app_private.hermes_connections SET scope_ids='{}'", 'scope_narrowed', 'building'],
    ['template switch', "UPDATE app_private.hermes_schedule_templates SET enabled=false WHERE template='rooms_public_text_v1'", 'template_disabled', { template: 'rooms_public_text_v1' }],
    ['sender account', "UPDATE public.zalo_accounts SET status='disconnected'", 'zalo_sender_unavailable', { sqlstate: '42501' }],
    ['company timezone', "CREATE OR REPLACE FUNCTION app_private.org_timezone_v1(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'UTC'::text$$", 'timezone_changed', {}],
  ]) await x.each(`blocked reason is machine-readable: ${name}`, async () => {
    await create();
    await db.exec(change);
    assert.deepEqual(await x.run(), { status: 'blocked', reason, closedRecipients: 0 });
    const [incident] = await x.incidents();
    assert.deepEqual([incident.kind, incident.reason], ['authority', reason]);
    assert.deepEqual(incident.detail, detail === 'building' ? { buildingIds: [x.BUILDING] } : detail);
    assert.equal(await x.count('public.zalo_send_queue'), 0);
  });

  await x.each('a legacy owner enabled outside the gate is reported, not silently raced', async () => {
    await create();
    await x.ageRow("INSERT INTO public.zalo_automations(organization_id,kind,enabled,config) VALUES($1,'broadcast_vacant',true,$2::jsonb)", [ORG, JSON.stringify({ recipients: [x.GROUP] })]);
    assert.deepEqual(await x.run(), { status: 'blocked', reason: 'legacy_owner_active', closedRecipients: 0 });
  });

  await x.each('one denied recipient stops only itself; its queued sibling still passes the provider gate', async () => {
    await db.query(`INSERT INTO public.zalo_conversations(id,account_id,organization_id,thread_type,thread_id,peer_name,user_id)
      VALUES($1,$2,$3,'group','988','Second synthetic group',$4)`, [NEXT, ACCOUNT, ORG, FOREIGN]);
    await create(x.settings('rooms_public_text_v1', { conversationIds: [x.GROUP, NEXT] }));
    await x.ageRow("UPDATE public.zalo_conversations SET thread_type='user' WHERE id=$1", [NEXT]);
    const first = await x.run();
    assert.deepEqual([first.status, first.conversationId], ['queued', x.GROUP]);
    assert.deepEqual(await x.run(), { status: 'skipped', reason: 'target_denied', conversationIds: [NEXT] });
    const [incident] = await x.incidents();
    assert.deepEqual([incident.kind, incident.reason, incident.detail], ['authority', 'target_denied', { conversationIds: [NEXT], partial: true }]);
    const [job] = await x.jobs();
    await processing(job.id);
    assert.equal(await x.provider(job.id, { body: job.payload.body, ownUid: uid40 }), true);
    assert.deepEqual(await x.probe(), { status: 'blocked', reason: 'target_denied' });
    assert.equal((await x.incidents()).filter(row => !row.closed).length, 1);
  });

  await x.each('a run error is classified itself, not masked by a separate recipient denial', async () => {
    await db.query(`INSERT INTO public.zalo_conversations(id,account_id,organization_id,thread_type,thread_id,peer_name,user_id)
      VALUES($1,$2,$3,'group','988','Second synthetic group',$4)`, [NEXT, ACCOUNT, ORG, FOREIGN]);
    await create(x.settings('rooms_public_text_v1', { conversationIds: [x.GROUP, NEXT] }));
    await x.ageRow("UPDATE public.zalo_conversations SET thread_type='user' WHERE id=$1", [NEXT]);
    await db.exec("UPDATE public.buildings SET name=''");
    assert.deepEqual(await x.run(), { status: 'blocked', reason: 'room_data_changed', closedRecipients: 0 });
    assert.deepEqual((await x.incidents()).map(row => [row.kind, row.reason]).sort(), [['authority', 'target_denied'], ['run', 'room_data_changed']]);
    assert.equal((await x.incidents()).find(row => row.reason === 'room_data_changed').detail.code, 'hermes_group_rooms_changed');
  });

  await x.each('a queued job whose own recipient is denied later never reaches the provider', async () => {
    await create();
    assert.equal((await x.run()).status, 'queued');
    const [job] = await x.jobs();
    await x.ageRow("UPDATE public.zalo_conversations SET thread_type='user' WHERE id=$1", [x.GROUP]);
    await processing(job.id);
    await assert.rejects(x.provider(job.id, { body: job.payload.body, ownUid: uid40 }), code('42501'));
    assert.equal((await db.query('SELECT provider_started_at FROM public.zalo_send_queue WHERE id=$1', [job.id])).rows[0].provider_started_at, null);
  });

  await x.each('grant-wide revocation blocks a queued job before provider I/O; the failure is reported once', async () => {
    await create();
    assert.equal((await x.run()).status, 'queued');
    const [job] = await x.jobs();
    await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['chat_zalo.send']");
    await processing(job.id);
    await assert.rejects(x.provider(job.id, { body: job.payload.body, ownUid: uid40 }), code('42501'));
    assert.equal((await db.query('SELECT provider_started_at FROM public.zalo_send_queue WHERE id=$1', [job.id])).rows[0].provider_started_at, null);
    // Worker jobFail path for a non-admitted provider call: definite failure.
    await db.query(`UPDATE public.zalo_send_queue SET status='failed',processed_at=clock_timestamp(),
      last_error='PROVIDER_NOT_ADMITTED: hermes_schedule_denied' WHERE id=$1`, [job.id]);
    assert.equal((await x.sweep()).observed, 1);
    assert.equal((await x.sweep()).observed, 0);
    const delivery = (await x.incidents()).find(row => row.kind === 'delivery');
    assert.deepEqual([delivery.reason, delivery.detail.errorCode, delivery.occurrences, delivery.notified], ['delivery_failed', 'PROVIDER_NOT_ADMITTED', 1, true]);
    assert.match((await x.notifications()).at(-1).content, /chưa gửi được \(PROVIDER_NOT_ADMITTED\)/);
  });

  await x.each('a block past the catch-up window closes the day with its reason and stops re-attempts', async () => {
    const zone = ['UTC', 'Etc/GMT+12'].find(timeZone => Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date())) >= 4);
    await db.exec(`CREATE OR REPLACE FUNCTION app_private.org_timezone_v1(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT '${zone}'::text$$`);
    const day = (await db.query('SELECT extract(isodow FROM clock_timestamp() AT TIME ZONE $1)::integer AS weekday', [zone])).rows[0].weekday;
    await create(x.settings('rooms_public_text_v1', { timeZone: zone, weekdays: [day], time: '00:00' }));
    await db.exec('UPDATE public.fixture_authority SET send_zalo=false');
    assert.deepEqual(await x.run(), { status: 'blocked', reason: 'user_permission_revoked', closedRecipients: 1 });
    assert.deepEqual((await db.query('SELECT outcome,reason FROM app_private.hermes_schedule_runs')).rows, [{ outcome: 'missed', reason: 'user_permission_revoked' }]);
    assert.deepEqual(await x.worker('hermes_room_schedule_due_v1', [INSTANCE, [ORG]]), []);
    await db.exec('UPDATE public.fixture_authority SET send_zalo=true');
    assert.deepEqual(await x.run(), { status: 'already_run' });
    assert.equal(await x.count('public.zalo_send_queue'), 0);
  });

  await x.each('an unknown legacy delivery blocks with its job id until a manager reconciles it; nothing is resent', async () => {
    await create();
    await insertLegacyUnknown();
    assert.deepEqual(await x.run(), { status: 'blocked', reason: 'blocked_by_unknown_delivery', closedRecipients: 0 });
    assert.deepEqual((await x.incidents())[0].detail, { jobIds: [LEGACY] });
    const listed = await x.ui('list', ORG);
    assert.deepEqual(listed.items.map(item => [item.kind, item.id, item.origin, item.preview]), [['queue_job', LEGACY, 'automation', 'Bản tin phòng cũ']]);
    assert.equal(listed.canManage, true);
    const resolved = await resolve(LEGACY, 'not_sent');
    assert.deepEqual([resolved.reconciliation.decision, resolved.reconciliation.via, resolved.reconciliation.targetId], ['not_sent', 'crm_ui', LEGACY]);
    const [row] = (await db.query('SELECT status,result FROM public.zalo_send_queue WHERE id=$1', [LEGACY])).rows;
    assert.deepEqual([row.status, row.result.outcome, row.result.requires_reconciliation, row.result.previous_outcome],
      ['failed', 'reconciled_not_sent', false, 'unknown']);
    assert.equal(await x.count('public.zalo_send_queue'), 1);
    assert.equal((await x.run()).status, 'queued');
    assert.equal((await x.incidents())[0].close_reason, 'recovered');
    assert.deepEqual((await x.ui('list', ORG)).items, []);
    assert.equal((await x.ui('list', ORG)).recent[0].mine, true);
  });

  await x.each('scheduled unknown delivery becomes one incident; human confirmation closes it without a recovery claim', async () => {
    await create(); await x.run();
    const [job] = await x.jobs();
    await x.markUnknown(job.id);
    assert.equal((await x.sweep()).observed, 1);
    assert.equal((await x.sweep()).observed, 0);
    for (const statement of ["UPDATE app_private.hermes_schedule_delivery_observations SET outcome='failed'", 'DELETE FROM app_private.hermes_schedule_delivery_observations',
      "UPDATE app_private.hermes_schedule_incidents SET reason='edited'", 'DELETE FROM app_private.hermes_schedule_incidents']) {
      await db.exec('SAVEPOINT immutable'); await assert.rejects(db.query(statement), code('42501'));
      await db.exec('ROLLBACK TO SAVEPOINT immutable; RELEASE SAVEPOINT immutable');
    }
    let rows = await x.incidents();
    assert.deepEqual(rows.map(row => [row.kind, row.reason, row.occurrences, row.notified]), [['delivery', 'delivery_unknown', 1, true]]);
    assert.match((await x.notifications())[0].content, /chưa rõ đã tới nhóm/);
    let summary = (await x.manage('list', {}, { version: 2 })).schedules[0];
    assert.equal(summary.lastRuns[0].deliveryStatus, 'unknown');
    assert.deepEqual(summary.openIssues.map(issue => issue.reason), ['delivery_unknown']);
    await resolve(job.id, 'sent');
    await x.sweep();
    rows = await x.incidents();
    assert.deepEqual([rows[0].closed, rows[0].close_reason, rows[0].closed_notified], [true, 'recovered', false]);
    assert.equal((await x.notifications()).length, 1);
    summary = (await x.manage('list', {}, { version: 2 })).schedules[0];
    assert.equal(summary.lastRuns[0].deliveryStatus, 'confirmed_sent');
    assert.deepEqual(summary.openIssues, []);
  });

  await x.each('expiring standing grant warns once, renewal closes it silently, expiry is reported once', async () => {
    await create(x.settings('rooms_public_text_v1', { expiresAt: new Date(Date.now() + 2 * 3600000).toISOString() }));
    await x.sweep(); await x.sweep();
    let rows = await x.incidents();
    assert.deepEqual(rows.map(row => [row.kind, row.reason, row.notified]), [['expiry', 'grant_expiring', true]]);
    assert.match((await x.notifications())[0].subject, /sắp hết hạn/);
    await x.manage('update', { requestId: NEXT, scheduleId: SCHEDULE, expectedRevision: 1,
      settings: x.settings('rooms_public_text_v1', { expiresAt: new Date(Date.now() + 5 * 86400000).toISOString() }) });
    await x.sweep();
    rows = await x.incidents();
    assert.deepEqual([rows[0].closed, rows[0].close_reason], [true, 'grant_replaced']);
    // Grants are insert-only evidence: model an already expired grant.
    await db.query(`WITH g AS (INSERT INTO app_private.hermes_schedule_grants(schedule_id,revision,user_id,organization_id,connection_id,binding_id,
        binding_epoch,account_id,settings,request_id,request_digest,created_at,expires_at)
      SELECT schedule_id,3,user_id,organization_id,connection_id,binding_id,binding_epoch,account_id,settings,request_id,request_digest,
        clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 minute' FROM app_private.hermes_schedule_grants
      WHERE schedule_id=$1 ORDER BY revision DESC LIMIT 1 RETURNING id)
      UPDATE app_private.hermes_room_schedules SET grant_id=(SELECT id FROM g),revision=3 WHERE id=$1`, [SCHEDULE]);
    await x.sweep(); await x.sweep();
    rows = (await x.incidents()).filter(row => row.reason === 'grant_expired');
    assert.deepEqual(rows.map(row => [row.kind, row.notified, row.closed]), [['expiry', true, false]]);
    assert.match((await x.notifications()).at(-1).content, /đã hết hạn nên lịch đã dừng/);
    assert.deepEqual(await x.run(SCHEDULE, 3), { status: 'skipped', reason: 'inactive_or_changed' });
  });

  await x.each('policy mode is off by default; when on, room and policy owners coexist and a second policy owner conflicts', async () => {
    await assert.rejects(create(x.settings('sale_policy_public_text_v1')), code('42501'));
    await db.exec("UPDATE app_private.hermes_schedule_templates SET enabled=true WHERE template='sale_policy_public_text_v1'");
    await create(x.settings('sale_policy_public_text_v1'));
    await create(x.settings(), NEXT);
    await assert.rejects(create(x.settings('sale_policy_public_text_v1'), OTHER), code('PT409'));
    await assert.rejects(create(x.settings(), OTHER), code('PT409'));
  });

  await x.each('policy notice: silent baseline, change queued once with public text, fenced at provider, unknown blocks, not-sent sends a new dispatch', async () => {
    await db.exec("UPDATE app_private.hermes_schedule_templates SET enabled=true WHERE template='sale_policy_public_text_v1'");
    // Clock port for the local day of run_v1 only (calendar progression).
    const definition = candidate('hermes_schedule_health_v1').match(/CREATE OR REPLACE FUNCTION public\.hermes_room_schedule_run_v1[\s\S]*?\$fn\$;/)[0];
    const anchor = "local_now:=clock_timestamp() AT TIME ZONE (g.settings->>'timeZone')";
    assert.ok(definition.includes(anchor), 'actual run_v1 local clock');
    await db.exec(`CREATE FUNCTION app_private.fixture_day_clock() RETURNS timestamptz LANGUAGE sql AS $$
      SELECT clock_timestamp()+make_interval(days=>current_setting('hermes_fixture.day_offset')::integer)$$;
      SELECT set_config('hermes_fixture.day_offset','0',true);`);
    await db.exec(definition.replace(anchor, "local_now:=app_private.fixture_day_clock() AT TIME ZONE (g.settings->>'timeZone')"));
    const day = offset => db.query("SELECT set_config('hermes_fixture.day_offset',$1,true)", [String(offset)]);
    await db.query("INSERT INTO public.public_room_settings(owner_id,organization_id,soon_days,sale_policy) VALUES($1,$2,30,' Giảm 500k tháng đầu ')", [USER, ORG]);
    await db.query("UPDATE public.rooms SET sale_note='Tặng 1 tháng gửi xe'");
    await create(x.settings('sale_policy_public_text_v1', { weekdays: [1, 2, 3, 4, 5, 6, 7] }));
    assert.deepEqual(await x.run(), { status: 'skipped', reason: 'baseline', conversationId: x.GROUP });
    await day(1);
    assert.deepEqual(await x.run(), { status: 'skipped', reason: 'unchanged', conversationId: x.GROUP });
    assert.equal(await x.count('public.zalo_send_queue'), 0);
    await db.query("UPDATE public.rooms SET sale_note='Tặng 2 tháng gửi xe'");
    await day(2);
    const queued = await x.run();
    assert.equal(queued.status, 'queued');
    let [job] = await x.jobs();
    assert.equal(job.payload.body, 'CẬP NHẬT CHÍNH SÁCH SALE\nGiảm 500k tháng đầu\nChính sách riêng từng phòng:\n1. Synthetic building · 101: Tặng 2 tháng gửi xe');
    assert.doesNotMatch(job.payload.body, /PRIVATE|5\.000\.000|not-to-cross/);
    await processing(job.id);
    assert.equal(await x.provider(job.id, { body: job.payload.body, ownUid: uid40 }), true);
    await x.markUnknown(job.id);
    await day(3);
    assert.deepEqual(await x.run(), { status: 'skipped', reason: 'delivery_unknown', dispatchId: queued.dispatchId });
    assert.equal((await x.incidents()).find(row => row.kind === 'delivery').reason, 'delivery_unknown');
    await resolve(job.id, 'not_sent');
    const again = await x.run();
    assert.equal(again.status, 'queued');
    assert.notEqual(again.dispatchId, queued.dispatchId);
    assert.equal(await x.count('public.zalo_send_queue'), 2);
    job = (await x.jobs()).find(row => row.hermes_group_dispatch_id === again.dispatchId);
    // A public policy edit between enqueue and provider I/O is a fence, not a send.
    await db.query("UPDATE public.public_room_settings SET sale_policy='Giảm 700k tháng đầu'");
    await processing(job.id);
    await assert.rejects(x.provider(job.id, { body: job.payload.body, ownUid: uid40 }), code('PT409'));
    assert.equal((await db.query('SELECT provider_started_at FROM public.zalo_send_queue WHERE id=$1', [job.id])).rows[0].provider_started_at, null);
  });

  await x.each('push uses the reminder JWT slot once per incident phase; an inactive owner gets no bell or push', async () => {
    await db.exec('UPDATE public.fixture_push SET enabled=true');
    await create();
    await db.exec('UPDATE public.fixture_authority SET manage_schedule=false');
    await x.run(); await x.sweep(); await x.sweep();
    const requests = (await db.query('SELECT url,body,headers FROM net.fixture_requests')).rows;
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/functions\/v1\/send-push$/);
    assert.equal(requests[0].body.userId, USER);
    assert.match(requests[0].body.idempotencyKey, /^hermes-schedule:[0-9a-f-]{36}:opened$/);
    assert.equal(requests[0].headers.Authorization, 'Bearer fixture.service.jwt');
    await db.exec("UPDATE public.organization_memberships SET status='REVOKED'");
    assert.equal((await x.run()).reason, 'membership_inactive');
    await x.sweep();
    const rows = await x.incidents();
    assert.deepEqual(rows.map(row => [row.reason, row.closed, row.close_reason]), [['user_permission_revoked', true, 'superseded'], ['membership_inactive', false, null]]);
    assert.deepEqual((await db.query("SELECT notify_result FROM app_private.hermes_schedule_incidents WHERE reason='membership_inactive'")).rows[0].notify_result, { skipped: 'owner_inactive' });
    assert.equal((await x.notifications()).length, 1);
    assert.equal(await x.count('net.fixture_requests'), 1);
  });

  await x.each('probe reports a change before the next due time and closes on restore; probes rotate', async () => {
    await create();
    assert.deepEqual((await x.sweep()).probes, [SCHEDULE]);
    assert.deepEqual(await x.probe(), { status: 'healthy' });
    assert.deepEqual((await x.sweep()).probes, []);
    await db.exec('UPDATE app_private.hermes_org_policies SET enabled=false');
    assert.deepEqual(await x.probe(), { status: 'blocked', reason: 'company_policy_disabled' });
    await x.sweep();
    assert.match((await x.notifications())[0].content, /công ty đang tắt Hermes/);
    await db.exec('UPDATE app_private.hermes_org_policies SET enabled=true');
    assert.deepEqual(await x.probe(), { status: 'healthy' });
    await x.sweep();
    assert.equal((await x.notifications()).length, 2);
    assert.equal(await x.count('public.zalo_send_queue'), 0);
  });

  await x.each('maintenance expires stale private commands and queued Hermes jobs as never sent; private reply attestation only', async () => {
    await x.ageRow("UPDATE app_private.hermes_zalo_private_commands SET accepted_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '50 minutes'");
    await create(); await x.run();
    const [job] = await x.jobs();
    await x.ageRow("UPDATE app_private.hermes_group_dispatches SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [job.hermes_group_dispatch_id]);
    const swept = await x.sweep();
    assert.deepEqual([swept.prunedCommands, swept.expiredJobs, swept.observed], [1, 1, 1]);
    const [expired] = await x.jobs();
    assert.deepEqual([expired.status, expired.result.outcome], ['failed', 'expired']);
    assert.match(expired.last_error, /^EXPIRED_HERMES_DISPATCH/);
    assert.equal((await db.query("SELECT status FROM public.zalo_messages WHERE body LIKE 'BẢN TIN%'")).rows[0].status, 'failed');
    assert.equal((await x.incidents()).find(row => row.kind === 'delivery').detail.errorCode, 'EXPIRED_HERMES_DISPATCH');
    const [command] = (await db.query('SELECT id,state,failure_code FROM app_private.hermes_zalo_private_commands')).rows;
    assert.deepEqual([command.state, command.failure_code], ['UNKNOWN_EFFECT', 'expired']);
    const listed = await x.ui('list', ORG);
    assert.deepEqual(listed.items.map(item => [item.kind, item.id, item.origin, item.preview]), [['private_command', command.id, 'private_reply', null]]);
    const first = await resolve(command.id, 'not_sent', NEXT, 'private_command', 'Không nhận được trả lời riêng');
    assert.deepEqual(await resolve(command.id, 'not_sent', NEXT, 'private_command', 'Không nhận được trả lời riêng'), first);
    await assert.rejects(resolve(command.id, 'sent', NEXT, 'private_command', 'Không nhận được trả lời riêng'), code('PT409'));
    await assert.rejects(resolve(command.id, 'sent', OTHER, 'private_command'), code('PT409'));
    assert.equal((await db.query('SELECT state FROM app_private.hermes_zalo_private_commands')).rows[0].state, 'UNKNOWN_EFFECT');
    assert.deepEqual((await x.ui('list', ORG)).items, []);
  });

  await x.each('UI scope: own Hermes sends need chat view, org automation needs manage; outsiders and settled jobs are refused', async () => {
    const own = await externalSend();
    // Only a failed UNKNOWN_EFFECT row can be attested; a queued/settled one cannot.
    await assert.rejects(resolve(own, 'sent', LEGACY), code('PT409'));
    await x.markUnknown(own);
    await insertLegacyUnknown();
    let listed = await x.ui('list', ORG);
    assert.deepEqual(listed.items.map(item => [item.id, item.origin]).sort(), [[LEGACY, 'automation'], [own, 'hermes_connector']].sort());
    assert.match(listed.items.find(item => item.id === own).conversationName, /Synthetic group/);
    await db.exec('UPDATE public.fixture_authority SET view_zalo=false');
    listed = await x.ui('list', ORG);
    assert.deepEqual(listed.items.map(item => [item.id, item.preview, item.conversationName]), [[LEGACY, null, null]]);
    await assert.rejects(resolve(own, 'sent'), code('42501'));
    await db.exec('UPDATE public.fixture_authority SET view_zalo=true,manage_schedule=false');
    listed = await x.ui('list', ORG);
    assert.deepEqual([listed.canManage, listed.items.map(item => item.id)], [false, [own]]);
    await assert.rejects(resolve(LEGACY, 'sent'), code('42501'));
    await assert.rejects(x.ui('list', ORG, FOREIGN), code('42501'));
    await resolve(own, 'sent');
    await assert.rejects(resolve(own, 'not_sent', OTHER), code('PT409'));
    await assert.rejects(resolve(own, 'sent', NEXT, 'queue_job', 'Ghi chú khác'), code('PT409'));
    await assert.rejects(resolve(own, 'sent', OTHER, 'queue_job', '   '), code('22023'));
    const [row] = (await db.query('SELECT status,result FROM public.zalo_send_queue WHERE id=$1', [own])).rows;
    assert.deepEqual([row.status, row.result.outcome, row.result.reconciliation.decision], ['sent', 'reconciled_sent', 'sent']);
    for (const statement of ["UPDATE app_private.hermes_delivery_reconciliations SET note='edited'", 'DELETE FROM app_private.hermes_delivery_reconciliations']) {
      await db.exec('SAVEPOINT immutable'); await assert.rejects(db.query(statement), code('42501'));
      await db.exec('ROLLBACK TO SAVEPOINT immutable; RELEASE SAVEPOINT immutable');
    }
  });

  await x.each('connector issues/reconcile are bound to this connection and to current Action rights', async () => {
    const created = await x.manage('create', { requestId: SCHEDULE, settings: x.settings() }, { version: 2 });
    assert.deepEqual([created.schedule.openIssues, created.schedule.lastRuns], [[], []]);
    await x.run();
    const [job] = await x.jobs();
    await x.markUnknown(job.id);
    await x.sweep();
    const issues = await x.manage('issues', {}, { version: 2 });
    assert.deepEqual(issues.unknownDeliveries.map(item => [item.jobId, item.origin, item.scheduleId]), [[job.id, 'standing_grant', SCHEDULE]]);
    assert.deepEqual(issues.issues.map(item => [item.kind, item.reason]), [['delivery', 'delivery_unknown']]);
    const input = { requestId: NEXT, jobId: job.id, decision: 'sent', note: 'User xác nhận qua Hermes: đã thấy tin trong nhóm' };
    await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['chat_zalo.send']");
    await assert.rejects(x.manage('reconcile', input, { version: 2 }), code('42501'));
    await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['chat_zalo.send','chat_zalo.manage_automation']");
    await db.exec('UPDATE public.fixture_authority SET manage_schedule=false');
    await assert.rejects(x.manage('reconcile', input, { version: 2 }), code('42501'));
    await db.exec('UPDATE public.fixture_authority SET manage_schedule=true');
    const done = await x.manage('reconcile', input, { version: 2 });
    assert.deepEqual([done.reconciliation.via, done.reconciliation.decision, done.reconciliation.targetId], ['hermes_connector', 'sent', job.id]);
    assert.deepEqual(await x.manage('reconcile', input, { version: 2 }), done);
    assert.deepEqual((await x.manage('issues', {}, { version: 2 })).unknownDeliveries, []);
    assert.equal((await db.query('SELECT connection_id FROM app_private.hermes_delivery_reconciliations')).rows[0].connection_id, x.binding.connectionId);
    // A one-off send of this connection needs chat_zalo.send, not schedule rights.
    const external = await externalSend();
    await x.markUnknown(external);
    assert.deepEqual((await x.manage('issues', {}, { version: 2 })).unknownDeliveries.map(item => [item.jobId, item.origin, item.scheduleId]), [[external, 'external_mcp', null]]);
    await db.exec('UPDATE public.fixture_authority SET send_zalo=false');
    await assert.rejects(x.manage('reconcile', { ...input, requestId: OTHER, jobId: external }, { version: 2 }), code('42501'));
    await db.exec('UPDATE public.fixture_authority SET send_zalo=true');
    assert.equal((await x.manage('reconcile', { ...input, requestId: OTHER, jobId: external, decision: 'not_sent' }, { version: 2 })).reconciliation.decision, 'not_sent');
    // A legacy automation job has no Hermes origin: never attestable by a connection.
    await insertLegacyUnknown();
    await assert.rejects(x.manage('reconcile', { ...input, requestId: LEGACY, jobId: LEGACY }, { version: 2 }), code('42501'));
  });

  await x.each('manage_v2 keyset pages validate with the broker contract past one page', async () => {
    for (let index = 0; index < 22; index++) {
      const scheduleId = '10000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
      await x.manage('create', { requestId: scheduleId, settings: x.settings() }, { version: 2 });
      await x.manage('revoke', { requestId: '20000000-0000-4000-8000-' + index.toString(16).padStart(12, '0'), scheduleId, expectedRevision: 1 }, { version: 2 });
    }
    const seen = new Set(); let cursor = null, pages = 0;
    do {
      const input = scheduleInput('list', { limit: 20, cursor }), page = scheduleResult('list', await x.manage('list', input, { version: 2 }), null, input);
      for (const row of page.schedules) { assert.equal(seen.has(row.scheduleId), false); seen.add(row.scheduleId); assert.equal(row.state, 'REVOKED'); }
      cursor = page.nextCursor; pages++;
    } while (cursor);
    assert.deepEqual([seen.size, pages], [22, 2]);
  });

  await x.each('real session-bound mount: v2 receipts, policy template, issues and reconcile through the broker contract', async () => {
    await db.exec("UPDATE app_private.hermes_schedule_templates SET enabled=true WHERE template='sale_policy_public_text_v1'");
    const auth = { verifySession: value => x.auth.verifySession(value), async readAuthorization(value) {
      const base = await x.auth.readAuthorization(value);
      return { ...base, permissions: { ...base.permissions, read: [...base.permissions.read, 'chat_zalo.view'], action: [...base.permissions.action, 'chat_zalo.send', 'chat_zalo.manage_automation'] },
        companyCeilings: { ...base.companyCeilings, read: [...base.companyCeilings.read, 'chat_zalo.view'], action: [...base.companyCeilings.action, 'chat_zalo.send', 'chat_zalo.manage_automation'] },
        scopesByPermission: { ...base.scopesByPermission, 'chat_zalo.view': { buildingIds: [], cashbookIds: [] }, 'chat_zalo.send': { buildingIds: [], cashbookIds: [] },
          'chat_zalo.manage_automation': { buildingIds: [], cashbookIds: [] } } };
    } };
    const authority = createDurableAuthority({ auth, connectionStore: x.connectionStore, crypto: x.crypto });
    let writes = 0;
    hooks.beforeFetch = async (url, options) => {
      if (new URL(url).pathname !== '/rest/v1/rpc/hermes_room_schedule_manage_v2') return;
      assert.equal(new URL(url).origin, 'https://example.invalid'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
      await auth.verifySession({ accessToken: options.headers.authorization.slice(7) });
      const { p } = JSON.parse(options.body); assert.deepEqual(Object.keys(p).sort(), ['binding', 'input', 'operation']);
      assert(!Object.hasOwn(p.input, 'userId')); assert(!Object.hasOwn(p.input, 'organizationId'));
      await x.heartbeat();
      try {
        const result = await x.f.rpc('public.hermes_room_schedule_manage_v2', p, 'authenticated');
        if (!['list', 'issues'].includes(p.operation)) writes++;
        return Response.json(result);
      } catch (error) {
        return Response.json({ code: error.code, message: error.message, details: null, hint: null },
          { status: error.code === '42501' ? 403 : error.code === 'PT409' ? 409 : 400 });
      }
    };
    try {
      const mount = createScheduleMount({ authority, auth, connectionStore: x.connectionStore, crypto: x.crypto,
        supabase: x.config, dependencyScope: x.scope, fetch: x.config.fetch });
      const service = mount.createService(), signal = new AbortController().signal;
      const call = async (operation, input, events = {}) => service.finalizeSchedule(token, await service.prepareSchedule(token, operation, input, { signal }), { signal,
        onDispatch() { events.dispatched = (events.dispatched ?? 0) + 1; }, onRejected() { events.rejected = (events.rejected ?? 0) + 1; } });
      const events = {};
      const created = await call('create', { requestId: SCHEDULE, settings: x.settings('sale_policy_public_text_v1') }, events);
      assert.deepEqual([created.schedule.scheduleId, created.schedule.settings.template, created.schedule.openIssues, events.dispatched, writes],
        [SCHEDULE, 'sale_policy_public_text_v1', [], 1, 1]);
      assert(!JSON.stringify(created).includes('SYNTHETIC_PRIVATE_REFRESH')); assert(!JSON.stringify(created).includes(token));
      await db.query("UPDATE public.rooms SET sale_note='Tặng 1 tháng gửi xe'");
      assert.equal((await x.run()).reason, 'baseline');
      assert.deepEqual((await call('list', {})).schedules[0].lastRuns.map(run => [run.outcome, run.reason, run.deliveryStatus]), [['baseline', null, null]]);
      // A room bulletin by the same connection: deliver, lose the ACK, read and settle it.
      await call('create', { requestId: NEXT, settings: x.settings() });
      assert.equal((await x.run(NEXT)).status, 'queued');
      const [job] = await x.jobs();
      await x.markUnknown(job.id);
      await x.sweep();
      const issues = await call('issues', { scheduleId: NEXT });
      assert.deepEqual(issues.unknownDeliveries.map(item => item.jobId), [job.id]);
      assert.deepEqual(issues.issues.map(item => [item.kind, item.reason, item.closedAt]), [['delivery', 'delivery_unknown', null]]);
      const input = { requestId: OTHER, jobId: job.id, decision: 'not_sent', note: 'Người dùng kiểm nhóm: tin chưa tới' };
      const settled = await call('reconcile', input);
      assert.deepEqual([settled.reconciliation.targetId, settled.reconciliation.decision, settled.reconciliation.via], [job.id, 'not_sent', 'hermes_connector']);
      // A different attestation under the same request ID is a conflict, not a second write.
      const conflict = {};
      await assert.rejects(call('reconcile', { ...input, decision: 'sent' }, conflict), error => error.code === 'context_changed');
      assert.deepEqual([conflict.dispatched, conflict.rejected], [1, 1]);
      assert.deepEqual((await call('issues', {})).unknownDeliveries, []);
      assert.equal(await x.count('public.zalo_send_queue'), 1);
      // 16/10 21:27Z production: a zoned expiresAt without ".000" through the mount
      // reaches SQL canonical, and the strict SQL echo check still matches.
      const minute = Math.floor((Date.now() + 86400000) / 60000) * 60000, canonical = new Date(minute).toISOString();
      const zoned = new Date(minute + 7 * 3600000).toISOString().slice(0, 16) + '+07:00';
      // (update of the existing bulletin: a second ACTIVE one on the same group would be an owner conflict.)
      const renew = expiresAt => call('update', { requestId: ZONED, scheduleId: NEXT, expectedRevision: 1, settings: x.settings('rooms_public_text_v1', { expiresAt }) });
      const before = writes, renewed = await renew(zoned);
      assert.deepEqual([renewed.schedule.scheduleId, renewed.schedule.revision, renewed.schedule.settings.expiresAt, writes - before], [NEXT, 2, canonical, 1]);
      assert.deepEqual((await renew(canonical.replace('.000Z', 'Z'))).schedule, renewed.schedule, 'equivalent form replays the same request');
      await assert.rejects(renew(zoned.slice(0, 16)), error => error.code === 'invalid_request', 'zone-less expiry never reaches SQL');
      assert.equal(writes - before, 2);
    } finally { hooks.beforeFetch = undefined; }
  });

  await t.test('ACL: worker gets run_v2/probe/sweep, users get list/resolve/manage_v2; helpers and ledgers are private', async () => {
    for (const [name, allowed] of [['public.hermes_room_schedule_run_v2(uuid,bigint,uuid)', 'service_role'], ['public.hermes_room_schedule_probe_v1(uuid,uuid)', 'service_role'],
      ['public.hermes_room_schedule_sweep_v1(uuid,uuid[])', 'service_role'], ['public.hermes_room_schedule_run_v1(uuid,bigint,uuid)', 'service_role'],
      ['public.hermes_delivery_reconcile_list_v1(uuid)', 'authenticated'], ['public.hermes_delivery_reconcile_resolve_v1(jsonb)', 'authenticated'],
      ['public.hermes_room_schedule_manage_v2(jsonb)', 'authenticated']]) {
      for (const role of ['anon', 'authenticated', 'service_role', 'hermes_store_executor']) {
        assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, name])).rows[0].ok, role === allowed, `${role} ${name}`);
      }
      assert.equal((await db.query('SELECT provolatile FROM pg_proc WHERE oid=$1::regprocedure', [name])).rows[0].provolatile, 'v');
    }
    const helpers = (await db.query(`SELECT p.oid::regprocedure::text name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='app_private' AND (p.proname LIKE 'hermes_schedule_%' OR p.proname LIKE 'hermes_delivery_%')`)).rows.map(row => row.name);
    assert.ok(helpers.length >= 20);
    for (const name of helpers) for (const role of ['anon', 'authenticated', 'service_role', 'hermes_store_executor']) {
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, name])).rows[0].ok, false, `${role} ${name}`);
    }
    for (const table of ['hermes_schedule_incidents', 'hermes_schedule_delivery_observations', 'hermes_schedule_templates', 'hermes_delivery_reconciliations']) {
      for (const role of ['anon', 'authenticated', 'service_role', 'hermes_store_executor']) {
        assert.equal((await db.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') ok", [role, `app_private.${table}`])).rows[0].ok, false);
      }
    }
    assert.deepEqual((await db.query("SELECT conname FROM pg_constraint WHERE conrelid='app_private.hermes_schedule_runs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%outcome%' ORDER BY 1")).rows.map(row => row.conname),
      ['hermes_schedule_runs_check', 'hermes_schedule_runs_outcome_check', 'hermes_schedule_runs_policy_check', 'hermes_schedule_runs_reason_check']);
  });
});
