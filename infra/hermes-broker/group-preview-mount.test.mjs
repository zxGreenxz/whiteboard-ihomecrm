import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionActionAuthAdapter, createGroupPreviewAuthAdapter, createSupabaseGroupPreviewReads } from './group-preview-adapter.mjs';
import { groupDirectoryResponse, GROUP_DIRECTORY_TOOL, GROUP_PREVIEW_TOOL } from './group-preview-mount.mjs';
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
