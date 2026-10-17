import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGroupRoomPreview, createGroupRoomPreviewService } from './group-room-preview.mjs';
import { projectAvailableRooms } from './room-read-projection.mjs';
import { BrokerError } from './broker.mjs';
import { createRoomReadService } from './room-read-service.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createHash, randomBytes } from 'node:crypto';

const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.parse('2026-10-13T10:00:00.000Z');
export function fixture() {
  const result = projectAvailableRooms({ pages: 1,
    buildings: [{ id: uuid(10), name: 'Tòa mẫu', code: 'M' }],
    rooms: [11, 12].map(n => ({ id: uuid(n), building_id: uuid(10), code: `P${n}`, name: `Phòng ${n}`,
      floor: 1, area: 25, rent_price: 4_500_000, deposit_amount: 9_000_000, status_public: 'free',
      sale_state: 'READY', sale_today: '2026-10-13', avail_date: null, expected_ready_on: null,
      internal_note: 'SECRET_NOTE', tenant_phone: 'PRIVATE_PHONE', images: ['https://private.invalid'], sale_bonus_note: 'SECRET_BONUS' })),
  }, { allowedBuildingIds: [uuid(10)], readAt: now - 1000 });
  return {
    intent: { roomIds: [uuid(11), uuid(12)], conversationIds: [uuid(20), uuid(21)] }, now,
    authority: {
      owner: { userId: uuid(1), organizationId: uuid(2), assistantId: uuid(3), connectionId: uuid(4) },
      binding: { epoch: 3, policyVersion: 4, membershipId: uuid(5), authorizationVersion: 8, sessionRevision: 2 },
      contextVersion: 'a'.repeat(64), expiresAt: now + 600_000,
      effective: { read: ['assistant.context.read', 'rooms.view', 'chat_zalo.view'], action: ['chat_zalo.send'] },
      scopeIds: [uuid(6)], allowedBuildingIds: [uuid(10)],
    },
    roomRead: { organizationId: uuid(2), contextVersion: 'a'.repeat(64), result },
    recipientRead: {
      organizationId: uuid(2), contextVersion: 'a'.repeat(64), readAt: new Date(now - 2000).toISOString(),
      sender: { accountId: uuid(30), name: 'Nick bot mẫu', ownUid: '10001', loginRequestedAt: '2026-10-13T09:00:00.000Z', botVersion: 3, ingressGeneration: uuid(31) },
      allowedConversationIds: [uuid(20), uuid(21)],
      conversations: [20, 21].map(n => ({ conversationId: uuid(n), organizationId: uuid(2), accountId: uuid(30), threadId: String(n), threadType: 'group', name: `Nhóm mẫu ${n}` })),
    },
  };
}
function rejects(change, code) {
  const input = fixture(); change(input);
  assert.throws(() => buildGroupRoomPreview(input), error => error.code === code);
}
test('current ingress accepts forty digit UIDs and nullable login snapshots', () => {
  const input = fixture();
  input.recipientRead.sender.ownUid = '1'.repeat(40);
  input.recipientRead.sender.loginRequestedAt = null;
  input.recipientRead.conversations[0].threadId = '2'.repeat(40);
  const output = buildGroupRoomPreview(input);
  assert.equal(output.canonical.sender.ownUid, '1'.repeat(40));
  assert.equal(output.canonical.sender.loginRequestedAt, null);
  assert.equal(output.canonical.recipients[0].threadId, '2'.repeat(40));
  input.recipientRead.sender.loginRequestedAt = '2026-10-13T09:00:00.000Z';
  assert.notEqual(buildGroupRoomPreview(input).digest, output.digest);
});
test('current ingress still rejects oversized UIDs and missing login snapshots', () => {
  rejects(x => { x.recipientRead.sender.ownUid = '1'.repeat(41); }, 'draft_input_invalid');
  rejects(x => { x.recipientRead.conversations[0].threadId = '2'.repeat(41); }, 'draft_input_invalid');
  rejects(x => { delete x.recipientRead.sender.loginRequestedAt; }, 'draft_input_invalid');
});
test('reuses actual finalized room projection and builds visible exact body/sender/recipients, no effect or consent', () => {
  const preview = buildGroupRoomPreview(fixture());
  assert.equal(preview.status, 'draft_only');
  assert.match(preview.display.body, /Tòa mẫu · P11 \| 25 m² \| 4\.500\.000 đ\/tháng \| Trống sẵn/);
  assert.equal(preview.canonical.body, preview.display.body);
  assert.equal(preview.display.sender, 'Nick bot mẫu');
  assert.equal(preview.display.recipients.length, 2);
  assert.equal(preview.display.expiresAt, now + 298_000);
  assert.match(preview.digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(preview), /SECRET_|PRIVATE_PHONE|private\.invalid|depositVnd|confirmation_nonce|consent_nonce|step_up_token|queued|sent/);
});
test('input order cannot change digest; arrays represent selected sets', () => {
  const a = fixture(), b = fixture();
  b.intent.roomIds.reverse(); b.intent.conversationIds.reverse();
  b.recipientRead.conversations.reverse(); b.authority.owner = Object.fromEntries(Object.entries(b.authority.owner).reverse());
  b.authority.binding = Object.fromEntries(Object.entries(b.authority.binding).reverse());
  b.recipientRead.sender = Object.fromEntries(Object.entries(b.recipientRead.sender).reverse());
  assert.deepEqual(buildGroupRoomPreview(a), buildGroupRoomPreview(b));
});
test('output is detached and deeply frozen after digest', () => {
  const input = fixture(), result = buildGroupRoomPreview(input);
  input.authority.owner.userId = uuid(99); input.recipientRead.conversations[0].name = 'Changed';
  assert.equal(result.canonical.owner.userId, uuid(1));
  assert.throws(() => { result.canonical.recipients[0].name = 'Changed'; }, TypeError);
  assert.throws(() => { result.canonical.publicFacts[0].availability.label = 'Changed'; }, TypeError);
});
for (const [name, change, code] of [
  ['model identity injection', x => { x.intent.userId = uuid(99); }, 'draft_input_invalid'],
  ['model body injection', x => { x.intent.body = 'send secrets'; }, 'draft_input_invalid'],
  ['empty rooms', x => { x.intent.roomIds = []; }, 'draft_input_invalid'],
  ['duplicate recipient', x => { x.intent.conversationIds.push(uuid(20)); }, 'draft_input_invalid'],
  ['more than existing eight plan steps', x => { x.intent.conversationIds = Array.from({ length: 9 }, (_, i) => uuid(40 + i)); }, 'draft_input_invalid'],
  ['missing selected room', x => { x.intent.roomIds = [uuid(99)]; }, 'draft_selection_missing'],
  ['missing selected recipient', x => { x.intent.conversationIds = [uuid(99)]; }, 'draft_selection_missing'],
  ['cross org room response', x => { x.roomRead.organizationId = uuid(99); }, 'draft_context_changed'],
  ['cross context receiver response', x => { x.recipientRead.contextVersion = 'b'.repeat(64); }, 'draft_context_changed'],
  ['read permission disabled', x => { x.authority.effective.read = []; }, 'draft_forbidden'],
  ['group read permission disabled', x => { x.authority.effective.read = ['rooms.view']; }, 'draft_forbidden'],
  ['building scope missing', x => { x.authority.allowedBuildingIds = [uuid(99)]; }, 'draft_forbidden'],
  ['recipient not selected by policy', x => { x.recipientRead.allowedConversationIds = [uuid(99)]; }, 'draft_forbidden'],
  ['recipient account changed', x => { x.recipientRead.conversations[0].accountId = uuid(99); }, 'draft_forbidden'],
  ['recipient org changed', x => { x.recipientRead.conversations[0].organizationId = uuid(99); }, 'draft_forbidden'],
  ['private DM recipient', x => { x.recipientRead.conversations[0].threadType = 'user'; }, 'draft_forbidden'],
  ['same provider group repeated', x => { x.recipientRead.conversations[0].threadId = '21'; }, 'draft_input_invalid'],
  ['capped source', x => { x.roomRead.result.completeness = 'source_capped'; }, 'draft_source_incomplete'],
  ['stale room response', x => { x.roomRead.result.readAt = new Date(now - 300_000).toISOString(); }, 'draft_expired'],
  ['future receiver response beyond the DB clock skew', x => { x.recipientRead.readAt = new Date(now + 6_000).toISOString(); }, 'draft_expired'],
  ['future room read stamped by this host', x => { x.roomRead.result.readAt = new Date(now + 1).toISOString(); }, 'draft_expired'],
  ['expired connection', x => { x.authority.expiresAt = now; }, 'draft_expired'],
  ['room field newline injection', x => { x.roomRead.result.rooms[0].code = 'P11\nInjected'; }, 'draft_input_invalid'],
  ['group bidi control', x => { x.recipientRead.conversations[0].name = 'abc\u202e'; }, 'draft_input_invalid'],
  ['invalid date', x => { x.roomRead.result.rooms[0].availability.availableOn = '2026-02-30'; }, 'draft_input_invalid'],
  ['negative listed price', x => { x.roomRead.result.rooms[0].priceVnd = -1; }, 'draft_input_invalid'],
  ['pass status with a non-pass fact', x => { x.roomRead.result.rooms[0].status = 'pass'; }, 'draft_input_invalid'],
  ['pass fact on a vacant room', x => { x.roomRead.result.rooms[0].availability.kind = 'pass'; }, 'draft_input_invalid'],
]) test(`rejects ${name}`, () => rejects(change, code));
// Supabase's clock may run ahead of (or behind) the connector host; DB-issued
// instants get the shared 5 s allowance on upper bounds and on the decision
// ordering lower bound. Expiry and staleness stay strict.
const SKEW_CASES = [[50, true], [4_000, true], [6_000, false]];
test('receiver read stamped by a DB clock 50 ms or 4 s ahead is current; 6 s ahead is rejected', () => {
  for (const [ahead, accepted] of SKEW_CASES) {
    const input = fixture(); input.recipientRead.readAt = new Date(now + ahead).toISOString();
    if (accepted) assert.equal(buildGroupRoomPreview(input).display.expiresAt, now + 299_000);
    else assert.throws(() => buildGroupRoomPreview(input), error => error.code === 'draft_expired');
  }
});
test('customer-pass rooms listed on the sale page are selectable with listed price and the page contact text', () => {
  const input = fixture();
  input.roomRead.result = projectAvailableRooms({ pages: 1, buildings: [{ id: uuid(10), name: 'Tòa mẫu', code: 'M' }],
    rooms: [11, 12].map(n => ({ id: uuid(n), building_id: uuid(10), code: `P${n}`, name: `Phòng ${n}`, floor: 1, area: 25,
      rent_price: 4_500_000, deposit_amount: 9_000_000, status_public: 'pass', sale_state: 'PASS', sale_today: '2026-10-13',
      avail_date: null, expected_ready_on: null, pass_price: n === 11 ? 3_900_000 : null, pass_contact_manager: n === 11,
      pass_contact_phone: n === 11 ? null : '0900000002', pass_contact_name: n === 11 ? null : 'Khách Thử' })),
  }, { allowedBuildingIds: [uuid(10)], readAt: now - 1000 });
  const { body } = buildGroupRoomPreview(input).display;
  assert.match(body, /Tòa mẫu · P11 \| 25 m² \| 3\.900\.000 đ\/tháng \| Khách pass phòng · Liên hệ admin iHome mở cửa/);
  assert.match(body, /Tòa mẫu · P12 \| 25 m² \| 4\.500\.000 đ\/tháng \| Khách pass phòng: 0900000002 \(Khách Thử\)/);
});
test('does not execute model accessors or array accessors', () => {
  let calls = 0;
  const x = fixture(); Object.defineProperty(x.intent, 'roomIds', { get() { calls++; return [uuid(11)]; }, enumerable: true });
  assert.throws(() => buildGroupRoomPreview(x), { code: 'draft_input_invalid' });
  const y = fixture(); Object.defineProperty(y.intent.roomIds, '0', { get() { calls++; return uuid(11); }, enumerable: true });
  assert.throws(() => buildGroupRoomPreview(y), { code: 'draft_input_invalid' });
  assert.equal(calls, 0);
});
for (const [name, change] of [
  ['exact body facts', x => { x.roomRead.result.rooms[0].priceVnd += 1; }],
  ['recipient', x => { x.intent.conversationIds = [uuid(21)]; }],
  ['provider thread', x => { x.recipientRead.conversations[0].threadId = '99999'; }],
  ['sender login', x => { x.recipientRead.sender.loginRequestedAt = '2026-10-13T09:01:00.000Z'; }],
  ['sender UID', x => { x.recipientRead.sender.ownUid = '99999'; }],
  ['bot revision', x => { x.recipientRead.sender.botVersion++; }],
  ['ingress generation', x => { x.recipientRead.sender.ingressGeneration = uuid(99); }],
  ['user', x => { x.authority.owner.userId = uuid(99); }],
  ['connection', x => { x.authority.owner.connectionId = uuid(99); }],
  ['policy revision', x => { x.authority.binding.policyVersion++; }],
  ['CRM authorization revision', x => { x.authority.binding.authorizationVersion++; }],
  ['session revision', x => { x.authority.binding.sessionRevision++; }],
  ['expiry', x => { x.authority.expiresAt = now + 10_000; }],
]) test(`digest binds ${name}`, () => {
  const a = fixture(), b = fixture(); change(b);
  assert.notEqual(buildGroupRoomPreview(a).digest, buildGroupRoomPreview(b).digest);
});
test('private or future room fields cannot flow to output or change selected public payload', () => {
  const a = fixture(), b = fixture();
  b.roomRead.result.rooms[0].internal_note = 'SECRET_NEW'; b.roomRead.result.rooms[0].depositVnd = 100_000_000; b.roomRead.result.rooms[0].rentVnd = 1;
  assert.deepEqual(buildGroupRoomPreview(a), buildGroupRoomPreview(b));
});

const opaque = 'hc_' + 'A'.repeat(43);
const tokenHash = createHash('sha256').update(opaque).digest('hex');
const objectHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const code = expected => error => error instanceof BrokerError && error.code === expected && error.message === expected && !error.cause;
const tick = () => new Promise(resolve => setImmediate(resolve));
function serviceFixture() {
  const input = fixture(), events = [], controller = new AbortController();
  let time = now, observedIntent;
  const decisionReceipt = Object.freeze({}), roomReceipt = Object.freeze({});
  const roomReads = {
    async prepareAvailableRooms(token, filters, { signal }) {
      events.push('room.prepare'); assert.equal(token, opaque); assert.deepEqual(filters, { offset: 0, limit: 100 });
      assert(signal instanceof AbortSignal); return roomReceipt;
    },
    async finalizeAvailableRooms(token, receipt) {
      events.push('room.finalize'); assert.equal(token, opaque); assert.equal(receipt, roomReceipt);
      return input.roomRead.result; // Built by the real tracked projection in fixture().
    },
  };
  const decisions = {
    async prepare(token, intent, { signal }) {
      events.push('decision.prepare'); assert.equal(token, opaque); assert(signal instanceof AbortSignal);
      observedIntent = intent; return decisionReceipt;
    },
    async finalize(token, receipt, binding, { signal }) {
      events.push('decision.finalize'); assert.equal(token, opaque); assert.equal(receipt, decisionReceipt);
      assert(signal instanceof AbortSignal); assert.deepEqual(Object.keys(binding).sort(), ['intentDigest', 'roomReadAt', 'roomReadDigest']);
      assert.equal(binding.intentDigest, objectHash(observedIntent));
      assert.equal(binding.roomReadDigest, objectHash(input.roomRead.result));
      assert.equal(binding.roomReadAt, input.roomRead.result.readAt);
      return { decision: { kind: 'hermes.group-room-preview.v1', outcome: 'allow', decisionId: uuid(90),
        tokenDigest: tokenHash, intentDigest: binding.intentDigest, roomReadDigest: binding.roomReadDigest,
        contextVersion: input.authority.contextVersion,
        checkedAt: time, expiresAt: time + 60_000 }, authority: input.authority, recipientRead: input.recipientRead };
    },
  };
  const create = extra => createGroupRoomPreviewService({ roomReads, decisions, clock: () => time, ...extra });
  return { input, events, controller, roomReads, decisions, create, options: { signal: controller.signal },
    time(value) { time = value; }, observedIntent: () => observedIntent };
}
async function run(f) {
  const service = f.create(), receipt = await service.prepareGroupRoomPreview(opaque, f.input.intent, f.options);
  f.events.push('audit'); return service.finalizeGroupRoomPreview(opaque, receipt, f.options);
}
test('service requires a trusted backend and room service; no default or caller verified flag', () => {
  for (const args of [{}, { decisions: {} }, { verified: true }]) assert.throws(() => createGroupRoomPreviewService(args), /group_preview_backend_required/);
  const f = serviceFixture();
  assert.deepEqual(Object.keys(f.create()), ['prepareGroupRoomPreview', 'finalizeGroupRoomPreview']);
});
test('prepare has no data; final decision follows caller audit and real projection before release', async () => {
  const f = serviceFixture(), service = f.create();
  const receipt = await service.prepareGroupRoomPreview(opaque, f.input.intent, f.options);
  assert.deepEqual(receipt, {}); assert(Object.isFrozen(receipt));
  f.events.push('audit');
  const out = await service.finalizeGroupRoomPreview(opaque, receipt, f.options);
  assert.deepEqual(f.events, ['decision.prepare', 'room.prepare', 'audit', 'room.finalize', 'decision.finalize']);
  assert.equal(out.status, 'preview_only'); assert.equal(out.display.expiresAt, now + 60_000);
  assert.equal(out.display.body, buildGroupRoomPreview(f.input).display.body);
  assert.deepEqual(Object.keys(out), ['status', 'fieldSet', 'digest', 'display']);
  assert.doesNotMatch(JSON.stringify(out), /userId|organizationId|assistantId|connectionId|ownUid|threadId|accountId|contextVersion|tokenDigest|canonical|SECRET|PRIVATE/);
  assert(Object.isFrozen(out.display.recipients));
  await assert.rejects(service.finalizeGroupRoomPreview(opaque, receipt, f.options), code('context_changed'));
});
for (const key of ['userId', 'organizationId', 'assistantId', 'connectionId', 'accountId', 'body', 'verified', 'authority', 'allowedBuildingIds']) {
  test(`service rejects model ${key} before backend or room IO`, async () => {
    const f = serviceFixture(); f.input.intent[key] = 'injected';
    await assert.rejects(f.create().prepareGroupRoomPreview(opaque, f.input.intent, f.options), code('invalid_request'));
    assert.deepEqual(f.events, []);
  });
}
test('service rejects missing/forged/foreign instance receipts and wrong token consumes real receipt', async () => {
  const f = serviceFixture(), service = f.create(), other = f.create();
  const receipt = await service.prepareGroupRoomPreview(opaque, f.input.intent, f.options);
  await assert.rejects(service.finalizeGroupRoomPreview(opaque, {}, f.options), code('context_changed'));
  await assert.rejects(other.finalizeGroupRoomPreview(opaque, receipt, f.options), code('context_changed'));
  await assert.rejects(service.finalizeGroupRoomPreview('hc_' + 'B'.repeat(43), receipt, f.options), code('context_changed'));
  await assert.rejects(service.finalizeGroupRoomPreview(opaque, receipt, f.options), code('context_changed'));
  assert.equal(f.events.includes('room.finalize'), false);
});
test('intent is copied/frozen; post-prepare mutation cannot retarget rooms or groups', async () => {
  const f = serviceFixture(), service = f.create();
  const receipt = await service.prepareGroupRoomPreview(opaque, f.input.intent, f.options);
  f.input.intent.roomIds = [uuid(99)]; f.input.intent.conversationIds = [uuid(99)];
  assert(Object.isFrozen(f.observedIntent().roomIds));
  const out = await service.finalizeGroupRoomPreview(opaque, receipt, f.options);
  assert.equal(out.display.recipients.length, 2); assert.match(out.display.body, /P11/);
});
test('malformed token and missing signal are rejected with no backend IO', async () => {
  const f = serviceFixture(), service = f.create();
  await assert.rejects(service.prepareGroupRoomPreview('jwt', f.input.intent, f.options), code('unauthorized'));
  await assert.rejects(service.prepareGroupRoomPreview(opaque, f.input.intent), code('invalid_request'));
  assert.deepEqual(f.events, []);
});
test('action denial is preserved before room reads and unexpected errors do not leak text', async () => {
  const f = serviceFixture(); f.decisions.prepare = async () => { throw new BrokerError('forbidden'); };
  await assert.rejects(run(f), code('forbidden')); assert.deepEqual(f.events, []);
  f.decisions.prepare = async () => { throw new Error('PRIVATE_BACKEND_DETAILS'); };
  await assert.rejects(run(f), code('backend_unavailable')); assert.deepEqual(f.events, []);
});
for (const [name, modify, expected = 'context_changed'] of [
  ['missing decision', x => { delete x.decision; }, 'backend_unavailable'],
  ['verified flag alone', x => { x.decision = { verified: true }; }, 'backend_unavailable'],
  ['negative backend decision', x => { x.decision.outcome = 'deny'; }, 'forbidden'],
  ['wrong decision kind', x => { x.decision.kind = 'rooms.read'; }, 'backend_unavailable'],
  ['wrong token', x => { x.decision.tokenDigest = 'b'.repeat(64); }],
  ['wrong intent', x => { x.decision.intentDigest = 'b'.repeat(64); }],
  ['wrong room content', x => { x.decision.roomReadDigest = 'b'.repeat(64); }],
  ['changed authority context', x => { x.authority = { ...x.authority, contextVersion: 'b'.repeat(64) }; }],
  ['old decision beyond the DB clock skew', x => { x.decision.checkedAt = now - 6_000; }],
  ['future decision beyond the DB clock skew', x => { x.decision.checkedAt = now + 6_000; }],
  ['expired decision', x => { x.decision.expiresAt = now; }],
  ['too-long decision', x => { x.decision.expiresAt = now + 300_001; }],
]) test(`service rejects ${name} and does not retry`, async () => {
  const f = serviceFixture(), original = f.decisions.finalize;
  f.decisions.finalize = async (...args) => { const result = await original(...args); modify(result); return result; };
  await assert.rejects(run(f), code(expected)); assert.equal(f.events.filter(v => v === 'decision.finalize').length, 1);
});
test('service accepts a final decision checked by a DB clock 50 ms or 4 s ahead; 6 s ahead is a conflict', async () => {
  for (const [ahead, accepted] of SKEW_CASES) {
    const f = serviceFixture(), original = f.decisions.finalize;
    f.decisions.finalize = async (...args) => { const result = await original(...args); result.decision.checkedAt = now + ahead; return result; };
    if (accepted) assert.equal((await run(f)).display.expiresAt, now + 60_000);
    else await assert.rejects(run(f), code('context_changed'));
  }
});
test('service accepts a final decision checked by a DB clock 50 ms or 4 s behind prepare start; 6 s behind is a conflict', async () => {
  // startedAt is this host's clock at prepare (= now); the DB clock may lag it.
  for (const [behind, accepted] of SKEW_CASES) {
    const f = serviceFixture(), original = f.decisions.finalize;
    f.decisions.finalize = async (...args) => { const result = await original(...args); result.decision.checkedAt = now - behind; return result; };
    if (accepted) assert.equal((await run(f)).display.expiresAt, now + 60_000);
    else await assert.rejects(run(f), code('context_changed'));
  }
});
test('send accepts a queue expiry issued by a DB clock 50 ms or 4 s ahead; 6 s ahead stays an unknown outcome', async () => {
  for (const [ahead, accepted] of SKEW_CASES) {
    const f = serviceFixture(), expiresAt = new Date(now + 300_000 + ahead).toISOString();
    f.decisions.dispatch = async (token, receipt, binding, { signal, onDispatch }) => {
      onDispatch(uuid(95)); const final = await f.decisions.finalize(token, receipt, binding, { signal });
      return { ...final, dispatch: { id: uuid(95), expiresAt,
        recipients: [uuid(20), uuid(21)].map((conversationId, n) => ({ conversationId, jobId: uuid(96 + n), status: 'queued' })) } };
    };
    const service = f.create(), receipt = await service.prepareGroupRoomPreview(opaque, f.input.intent, f.options);
    const sent = service.finalizeGroupRoomSend(opaque, receipt, { ...f.options, onDispatch() {}, onRejected() {} });
    if (accepted) assert.deepEqual(await sent, { status: 'queued', dispatchId: uuid(95), expiresAt,
      recipients: [20, 21].map(n => ({ conversationId: uuid(n), name: `Nhóm mẫu ${n}`, status: 'queued' })) });
    else await assert.rejects(sent, code('send_outcome_unknown'));
  }
});
test('source result cannot change during final await after its digest was bound', async () => {
  const f = serviceFixture(), original = f.decisions.finalize;
  f.decisions.finalize = async (...args) => {
    const result = await original(...args); f.input.roomRead.result.rooms[0].priceVnd = 1;
    return result;
  };
  const out = await run(f); assert.match(out.display.body, /4\.500\.000/); assert.doesNotMatch(out.display.body, /\| 1 đ/);
});
test('expired prepared receipt is consumed without final room or decision calls', async () => {
  const f = serviceFixture(), service = f.create();
  const receipt = await service.prepareGroupRoomPreview(opaque, f.input.intent, f.options);
  f.time(now + 30_000);
  await assert.rejects(service.finalizeGroupRoomPreview(opaque, receipt, f.options), code('timeout'));
  assert.deepEqual(f.events, ['decision.prepare', 'room.prepare']);
  f.time(now); await assert.rejects(service.finalizeGroupRoomPreview(opaque, receipt, f.options), code('context_changed'));
});
test('abort while final decision hangs returns no preview and no automatic retry', async () => {
  const f = serviceFixture(); let release;
  f.decisions.finalize = async () => { f.events.push('decision.hangs'); await new Promise(resolve => { release = resolve; }); };
  const promise = run(f); await tick(); f.controller.abort();
  await assert.rejects(promise, code('timeout')); release(); await tick();
  assert.equal(f.events.filter(v => v === 'decision.hangs').length, 1);
});
for (const [name, mutate] of [
  ['final group read', x => { x.authority.effective.read = ['rooms.view']; }],
  ['final group org', x => { x.recipientRead.conversations[0].organizationId = uuid(99); }],
  ['final sending account', x => { x.recipientRead.sender.accountId = uuid(99); }],
]) test(`service still validates ${name} despite an allowed acknowledgement`, async () => {
  const f = serviceFixture(), original = f.decisions.finalize;
  f.decisions.finalize = async (...args) => { const result = await original(...args); mutate(result); return result; };
  await assert.rejects(run(f), code('forbidden'));
});
test('final decision identity and lifetime participate in external digest', async () => {
  const a = serviceFixture(), b = serviceFixture(), original = b.decisions.finalize;
  b.decisions.finalize = async (...args) => { const result = await original(...args); result.decision.decisionId = uuid(91); return result; };
  assert.notEqual((await run(a)).digest, (await run(b)).digest);
});
test('selection outside this one room page is rejected, never silently omitted or merged', async () => {
  const f = serviceFixture(); f.input.intent.roomIds = [uuid(99)];
  await assert.rejects(run(f), code('invalid_request'));
  assert.equal(f.events.filter(event => event === 'room.prepare').length, 1);
});
test('recipient context change remains a conflict after final allowed decision', async () => {
  const f = serviceFixture(); f.input.recipientRead.contextVersion = 'b'.repeat(64);
  await assert.rejects(run(f), code('context_changed'));
});

test('composes real room service, durable authority, crypto and projection with explicit fake backend IO', async t => {
  const input = fixture(), events = [], controller = new AbortController();
  const keys = createSessionCrypto({ activeKeyVersion: 'test', keys: new Map([['test', randomBytes(32)]]) });
  t.after(() => keys.destroy());
  const owner = input.authority.owner, b = input.authority.binding, limits = input.authority.effective;
  const sessionBinding = { assistantId: owner.assistantId, userId: owner.userId,
    organizationId: owner.organizationId, sessionId: uuid(41) };
  const accessToken = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role: 'authenticated',
    sub: owner.userId, session_id: sessionBinding.sessionId, exp: now / 1000 + 600 })).toString('base64url'), 'test-signature'].join('.');
  const material = { accessToken, refreshToken: 'PRIVATE_REFRESH', expiresAt: now + 600_000 };
  const joined = { status: 'active', connection: { id: owner.connectionId, assistantId: owner.assistantId,
    userId: owner.userId, organizationId: owner.organizationId, state: 'active', epoch: b.epoch,
    restrictions: limits, scopeIds: input.authority.scopeIds, tokenDigest: tokenHash, credentialRef: uuid(42),
    expiresAt: input.authority.expiresAt },
  session: { credentialRef: uuid(42), revision: b.sessionRevision, envelope: keys.seal(material, sessionBinding),
    expiresAt: material.expiresAt, binding: sessionBinding },
  membership: { membershipId: b.membershipId, authorizationVersion: b.authorizationVersion, isSuperadmin: false },
  policy: { version: b.policyVersion, ...limits, scopeIds: input.authority.scopeIds } };
  const connectionStore = { async readConnection(request) {
    assert.deepEqual(request, { tokenDigest: tokenHash }); return structuredClone(joined);
  } };
  const auth = {
    async verifySession({ accessToken: supplied }) { assert.equal(supplied, accessToken);
      return { userId: owner.userId, sessionId: sessionBinding.sessionId, expiresAt: material.expiresAt }; },
    async readAuthorization({ accessToken: supplied }) { assert.equal(supplied, accessToken); return {
      userId: owner.userId, isSuperadmin: false, activeOrganizationIds: [owner.organizationId], epoch: 'crm-1',
      membership: { organizationId: owner.organizationId, status: 'ACTIVE', revokedAt: null, validFrom: null,
        validTo: null, membershipId: b.membershipId, authorizationVersion: b.authorizationVersion },
      permissions: limits, companyCeilings: limits, scopesByPermission: {
        'assistant.context.read': { buildingIds: [], cashbookIds: [] },
        'rooms.view': { buildingIds: [uuid(10)], cashbookIds: [] },
        'chat_zalo.send': { buildingIds: [], cashbookIds: [] },
        'chat_zalo.view': { buildingIds: [], cashbookIds: [] },
      },
    }; },
  };
  const authority = createDurableAuthority({ connectionStore, crypto: keys, auth, clock: () => now });
  const reads = {
    async scopeMap(request) {
      events.push('room.bound-map'); assert.equal(request.accessToken, accessToken);
      assert.equal(request.organizationId, owner.organizationId); assert.equal(request.connectionId, owner.connectionId);
      assert.deepEqual(request.scopeIds, input.authority.scopeIds);
      return { organizationId: owner.organizationId, complete: true,
        scopes: [{ id: uuid(6), scopeType: 'BUILDING', buildingId: uuid(10), areaId: null, cashbookId: null }],
        areaBuildings: [], permissionBuildingIds: [uuid(10)], binding: { connectionId: owner.connectionId, ...b } };
    },
    async availableRooms(request) {
      events.push('room.raw-read'); assert.equal(request.accessToken, accessToken);
      return { pages: 1, buildings: [{ id: uuid(10), name: 'Tòa mẫu', code: 'M' }],
        rooms: [11, 12].map(n => ({ id: uuid(n), building_id: uuid(10), code: `P${n}`, name: `Phòng ${n}`,
          floor: 1, area: 25, rent_price: 4_500_000, deposit_amount: 9_000_000, status_public: 'free',
          sale_state: 'READY', sale_today: '2026-10-13', avail_date: null, expected_ready_on: null,
          internal_note: 'SECRET_NOTE', tenant_phone: 'PRIVATE_PHONE' })) };
    },
  };
  const roomReads = createRoomReadService({ authority, connectionStore, crypto: keys, auth, reads, clock: () => now });
  let admitted, intent;
  const receipt = Object.freeze({});
  const decisions = {
    async prepare(token, selection, options) {
      admitted = await authority.resolve(token, options); intent = selection;
      return receipt;
    },
    async finalize(token, issued, binding, options) {
      assert.equal(issued, receipt); await authority.checkUnchanged(token, admitted, options);
      events.push('fake-group-decision');
      // This fixture deliberately supplies group authority; it is NOT live SQL/JWT proof.
      return { decision: { kind: 'hermes.group-room-preview.v1', outcome: 'allow', decisionId: uuid(90),
        tokenDigest: tokenHash, intentDigest: objectHash(intent), roomReadDigest: binding.roomReadDigest,
        contextVersion: admitted.contextVersion, checkedAt: now, expiresAt: now + 60_000 },
      authority: { ...input.authority, effective: admitted.effective, contextVersion: admitted.contextVersion },
      recipientRead: { ...input.recipientRead, contextVersion: admitted.contextVersion } };
    },
  };
  const service = createGroupRoomPreviewService({ roomReads, decisions, clock: () => now });
  const prepared = await service.prepareGroupRoomPreview(opaque, input.intent, { signal: controller.signal });
  events.push('audit');
  const out = await service.finalizeGroupRoomPreview(opaque, prepared, { signal: controller.signal });
  assert.deepEqual(events, ['room.bound-map', 'room.raw-read', 'audit', 'room.bound-map', 'fake-group-decision']);
  assert.match(out.display.body, /Trống sẵn/); assert.doesNotMatch(JSON.stringify(out), /SECRET|PRIVATE|9\.000\.000|deposit/);
});
