import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionActionAuthAdapter, createGroupPreviewAuthAdapter, createSupabaseGroupPreviewReads } from './group-preview-adapter.mjs';
import { groupDirectoryResponse, groupPreviewResponse, groupSendResponse, GROUP_DIRECTORY_TOOL, GROUP_PREVIEW_TOOL } from './group-preview-mount.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.now(), signal = new AbortController().signal;
const request = { accessToken: 'a.' + Buffer.from(JSON.stringify({ role: 'authenticated', sub: id(1), session_id: id(2) })).toString('base64url') + '.b', organizationId: id(3), userId: id(1), signal };
const current = () => ({ epoch: 'base', permissions: { read: ['rooms.view'], action: [] }, companyCeilings: { read: ['rooms.view'], action: [] },
  membership: { membershipId: id(4), authorizationVersion: 1 }, scopesByPermission: { 'rooms.view': { buildingIds: [id(5)], cashbookIds: [] } } });
const action = () => ({ organizationId: id(3), userId: id(1), membershipId: id(4), authorizationVersion: 1, policyVersion: 1, allowed: true, companyEnabled: true,
  readAllowed: true, readCompanyEnabled: true });
const directory = () => ({ authority: { owner: { userId: id(1), organizationId: id(3), assistantId: id(6), connectionId: id(7) }, contextVersion: 'a'.repeat(64), expiresAt: now + 30000 },
  recipientRead: { organizationId: id(3), contextVersion: 'a'.repeat(64), readAt: new Date(now).toISOString(),
    sender: { accountId: id(8), name: 'Bot', ownUid: '10001', loginRequestedAt: null, botVersion: 1, ingressGeneration: id(9) },
    allowedConversationIds: [id(10)], conversations: [{ conversationId: id(10), organizationId: id(3), accountId: id(8), threadId: '20002', threadType: 'group', name: 'Group' }] } });

test('directory output exposes only CRM selection IDs and display labels with strict account/group boundaries', () => {
  const raw = directory(), result = groupDirectoryResponse(raw, now);
  assert.deepEqual(result, { sender: 'Bot', conversations: [{ conversationId: id(10), name: 'Group' }], expiresAt: now + 30000 });
  assert(Object.isFrozen(result.conversations[0]));
  for (const mutate of [x => x.recipientRead.conversations[0].accountId = id(90), x => x.recipientRead.conversations[0].threadType = 'user',
    x => x.recipientRead.allowedConversationIds = [], x => x.recipientRead.conversations[0].name = 'bad\nname',
    x => x.recipientRead.contextVersion = 'b'.repeat(64), x => x.authority.expiresAt = now]) {
    const changed = directory(); mutate(changed); assert.throws(() => groupDirectoryResponse(changed, now), e => e.code === 'backend_unavailable');
  }
  raw.recipientRead.conversations[0].name = 'changed'; assert.equal(result.conversations[0].name, 'Group');
  const empty = directory(); empty.recipientRead.allowedConversationIds = []; empty.recipientRead.conversations = [];
  assert.deepEqual(groupDirectoryResponse(empty, now).conversations, []);
  assert.equal(GROUP_DIRECTORY_TOOL.inputSchema.additionalProperties, false);
  assert.deepEqual(GROUP_PREVIEW_TOOL.inputSchema.required, ['roomIds', 'conversationIds']);
});

// Supabase's clock runs ahead of the connector host. DB-issued instants get the
// shared 5 s allowance on their upper bound only: 50 ms and 4 s ahead pass, 6 s fails.
const AHEAD = [[50, true], [4000, true], [6000, false]];
const accepts = (accepted, run, code) => accepted ? assert.doesNotThrow(run) : assert.throws(run, e => e.code === code);
test('directory read stamped by a DB clock ahead of this host passes within the shared skew (production 17/10 regression)', () => {
  // Captured on the VPS: DB readAt 06:54:20.808Z while Date.now() was 06:54:20.799Z.
  const at = Date.parse('2026-10-17T06:54:20.799Z'), captured = directory();
  captured.authority.expiresAt = at + 30000; captured.recipientRead.readAt = '2026-10-17T06:54:20.808Z';
  assert.deepEqual(groupDirectoryResponse(captured, at).conversations, [{ conversationId: id(10), name: 'Group' }]);
  for (const [ahead, accepted] of AHEAD) {
    const read = directory(); read.recipientRead.readAt = new Date(now + ahead).toISOString();
    accepts(accepted, () => assert.equal(groupDirectoryResponse(read, now).sender, 'Bot'), 'backend_unavailable');
    const authority = directory(); authority.authority.expiresAt = now + 300000 + ahead;
    accepts(accepted, () => assert.equal(groupDirectoryResponse(authority, now).expiresAt, now + 300000), 'backend_unavailable');
  }
  // Staleness and expiry are not loosened.
  const stale = directory(); stale.recipientRead.readAt = new Date(now - 300000).toISOString();
  assert.throws(() => groupDirectoryResponse(stale, now), e => e.code === 'backend_unavailable');
  const expired = directory(); expired.authority.expiresAt = now;
  assert.throws(() => groupDirectoryResponse(expired, now), e => e.code === 'backend_unavailable');
});
test('preview and send responses bound DB-issued expiries with the shared skew, never accept expired ones', () => {
  const intent = { roomIds: [id(12)], conversationIds: [id(10)] };
  const preview = expiresAt => ({ status: 'preview_only', fieldSet: 'selected-room-sale-text-v1', digest: 'c'.repeat(64),
    display: { body: 'PHÒNG ĐÃ CHỌN', sender: 'Bot', recipients: [{ conversationId: id(10), name: 'Group' }], expiresAt } });
  const send = expiresAt => ({ status: 'queued', dispatchId: id(11), expiresAt: new Date(expiresAt).toISOString(),
    recipients: [{ conversationId: id(10), name: 'Group', status: 'queued' }] });
  for (const [ahead, accepted] of AHEAD) {
    accepts(accepted, () => assert.equal(groupPreviewResponse(preview(now + 300000 + ahead), intent, now).status, 'preview_only'), 'backend_unavailable');
    accepts(accepted, () => assert.equal(groupSendResponse(send(now + 300000 + ahead), now).status, 'queued'), 'send_outcome_unknown');
  }
  assert.throws(() => groupPreviewResponse(preview(now), intent, now), e => e.code === 'backend_unavailable');
  assert.throws(() => groupSendResponse(send(now), now), e => e.code === 'send_outcome_unknown');
});

test('management action extension falls back only for known missing rollout and never gives that fallback action authority', async t => {
  const scope = createDependencyScope(); t.after(() => scope.close()); let response;
  const reads = createSupabaseGroupPreviewReads({ url: 'https://project.example', publishableKey: 'sb_publishable_fixture', dependencyScope: scope,
    fetch: async () => response() });
  const baseAuth = { verifySession: async () => ({}), readAuthorization: async () => current() };
  const management = createConnectionActionAuthAdapter({ baseAuth, reads }), strict = createGroupPreviewAuthAdapter({ baseAuth, reads });
  for (const value of [() => Response.json({ code: 'PGRST202', message: 'Synthetic RPC absent', details: null, hint: null }, { status: 404 }),
    () => Response.json({ code: '42501', message: 'hermes_group_policy_absent', details: null, hint: null }, { status: 403 })]) {
    response = value; assert.deepEqual(await management.readAuthorization(request), current());
    await assert.rejects(strict.readAuthorization(request));
  }
  for (const value of [() => Response.json({ code: 'PGRST202' }, { status: 404 }), () => Response.json({ code: 'PGRST202' }, { status: 500 }),
    () => Response.json({ code: '42501', message: 'hermes_group_denied' }, { status: 403 }),
    () => Response.json({ ...action(), membershipId: id(99) }), () => Response.json({ ...action(), allowed: 'true' }),
    () => Response.json({ ...action(), allowed: true, companyEnabled: false })]) {
    response = value; await assert.rejects(management.readAuthorization(request));
  }
  response = () => Response.json(action());
  const enabled = await management.readAuthorization(request); assert.deepEqual(enabled.permissions.action, ['chat_zalo.send']);
  assert.deepEqual(enabled.permissions.read, ['rooms.view', 'chat_zalo.view']);
  response = () => Response.json({ ...action(), allowed: false });
  const revoked = await management.readAuthorization(request); assert.deepEqual(revoked.permissions.action, []); assert.notEqual(enabled.epoch, revoked.epoch);
  assert.deepEqual(revoked.permissions.read, ['rooms.view', 'chat_zalo.view']);
  response = () => Response.json({ ...action(), allowed: false, companyEnabled: false });
  assert.deepEqual((await management.readAuthorization(request)).companyCeilings.action, []);
});
