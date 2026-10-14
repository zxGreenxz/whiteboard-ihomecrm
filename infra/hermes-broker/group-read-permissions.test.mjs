import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMount, token } from './group-preview-fixture.mjs';
import { createGroupPreviewMount } from './group-preview-mount.mjs';
import { setupGroupSendSql } from '../hermes-zalo-router/group-send-sql-fixture.mjs';
import { createBroker } from './broker.mjs';
import { createRoomReadService, createSupabaseRoomReads } from './room-read-service.mjs';
import { FOREIGN } from '../hermes-zalo-router/private-command-fixture.mjs';

test('group directory needs current chat read only; preview needs room read; action stays independent', { timeout: 60000 }, async t => {
  const f = await setupMount(t);
  const mount = createGroupPreviewMount({ auth: f.auth, authority: f.authority, connectionStore: f.connectionStore, crypto: f.crypto,
    supabase: { url: f.config.url, publishableKey: f.config.publishableKey }, dependencyScope: f.scope, fetch: f.config.fetch });
  assert.equal(mount.authority, f.authority);
  const service = mount.createService({ commandId: f.baseline.commandId, claimId: f.CLAIM });
  const context = { commandId: f.baseline.commandId, claimId: f.CLAIM };
  const broker = createBroker({ authority: mount.authority, groupPreviews: mount, dependencyScope: f.scope, audit: async () => {},
    roomReads: createRoomReadService({ authority: mount.authority, connectionStore: f.connectionStore, crypto: f.crypto, auth: f.auth,
      reads: createSupabaseRoomReads(f.config) }) });
  const options = { signal: new AbortController().signal };
  await f.f.rollbackCase(async () => {
  await f.f.db.exec(`UPDATE public.fixture_authority SET rooms=false,send_zalo=false;
    INSERT INTO app_private.hermes_capabilities VALUES('chat_zalo.view','read',true) ON CONFLICT(capability) DO UPDATE SET enabled=true;
    UPDATE app_private.hermes_org_policies SET read_capabilities=ARRAY['chat_zalo.view'],action_capabilities='{}',scope_ids='{}';
    UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['chat_zalo.view'],action_capabilities='{}',scope_ids='{}';`);
  await f.reset();
  const receipt = await service.prepareGroupDirectory(token, options);
  assert.deepEqual((await service.finalizeGroupDirectory(token, receipt, options)).conversations,
    [{ conversationId: f.GROUP, name: 'Synthetic group' }]);
  assert.deepEqual((await broker.groupDirectory(token, context, options)).conversations,
    [{ conversationId: f.GROUP, name: 'Synthetic group' }]);
  assert.deepEqual((await broker.listGroupTools(token, context, options)).tools.map(tool => tool.name),
    ['crm_group_directory', 'crm_group_send_status']);
  await assert.rejects(broker.previewGroupRooms(token, context, f.selection, options), error => error.code === 'tool_not_available');
  await assert.rejects(broker.sendGroupRooms(token, context, f.selection, options), error => error.code === 'tool_not_available');
  await assert.rejects(service.prepareGroupRoomPreview(token, f.selection, options), error => error.code === 'forbidden');
  const live = await mount.authority.resolve(token, options);
  assert.deepEqual(live.effective, { read: ['chat_zalo.view'], action: [] });
  await f.f.db.exec(`UPDATE public.fixture_authority SET rooms=true;
    UPDATE app_private.hermes_org_policies SET read_capabilities=ARRAY['chat_zalo.view','rooms.view'],scope_ids=ARRAY['${f.SCOPE}'::uuid];
    UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['chat_zalo.view','rooms.view'],scope_ids=ARRAY['${f.SCOPE}'::uuid];`);
  const preview = await service.prepareGroupRoomPreview(token, f.selection, options);
  assert.equal((await service.finalizeGroupRoomPreview(token, preview, options)).status, 'preview_only');
  assert.equal((await broker.previewGroupRooms(token, context, f.selection, options)).status, 'preview_only');
  assert.deepEqual((await broker.listGroupTools(token, context, options)).tools.map(tool => tool.name),
    ['crm_group_directory', 'crm_group_room_preview', 'crm_group_send_status']);
  await assert.rejects(broker.sendGroupRooms(token, context, f.selection, options), error => error.code === 'tool_not_available');
  const send = await service.prepareGroupRoomPreview(token, f.selection, options);
  await assert.rejects(service.finalizeGroupRoomSend(token, send, { ...options, onDispatch() {}, onRejected() {} }), error => error.code === 'forbidden');
  const pending = await service.prepareGroupDirectory(token, options);
  await f.f.db.exec('UPDATE public.fixture_authority SET view_zalo=false');
  await assert.rejects(service.finalizeGroupDirectory(token, pending, options));
  });
});

test('dispatch status keeps current group-read authority after room/send removal, with no new queue write', { timeout: 60000 }, async t => {
  const x = await setupGroupSendSql(t);
  await x.f.rollbackCase(async () => {
    const ack = await x.send(await x.request());
    await x.f.db.exec(`UPDATE public.fixture_authority SET rooms=false,send_zalo=false;
      UPDATE app_private.hermes_org_policies SET read_capabilities=ARRAY['chat_zalo.view'],action_capabilities='{}',scope_ids='{}';
      UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['chat_zalo.view'],action_capabilities='{}',scope_ids='{}';`);
    const status = await x.status(ack.dispatch.id);
    assert.equal(status.recipients[0].status, 'queued');
    assert.equal((await x.f.db.query('SELECT count(*)::int n FROM public.zalo_send_queue')).rows[0].n, 1);
    await x.f.db.exec('SAVEPOINT other_actor');
    await x.f.db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [FOREIGN]);
    await assert.rejects(x.status(ack.dispatch.id), error => error.code === 'P0002');
    await x.f.db.exec('ROLLBACK TO SAVEPOINT other_actor; RELEASE SAVEPOINT other_actor');
    await assert.rejects(x.send(await x.request()));
    await x.f.db.exec('UPDATE public.fixture_authority SET view_zalo=false');
    await assert.rejects(x.status(ack.dispatch.id), error => error.code === '42501');
  });
});
