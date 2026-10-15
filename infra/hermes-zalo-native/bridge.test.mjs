import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createNativeBridge, nativeTextReceipt } from '../../worker/lib/hermes-native-bridge.js';
import { readNativeConfig } from '../../worker/lib/hermes-native-config.js';

const channel = { accountId: '11111111-1111-4111-8111-111111111111', ownUid: '100', pairedUid: '200', mainUid: '200',
  profile: 'personal-fixture', generation: '22222222-2222-4222-8222-222222222222', token: 'hzn_' + 'a'.repeat(64) };
const event = (id = 'm1') => ({ type: 0, isSelf: false, threadId: '200', data: {
  uidFrom: '200', idTo: '100', msgType: 'webchat', msgId: id, content: 'Native personal request', ts: Date.now() } });
async function fixture(t, { config: supplied, provider, timeout, maxProviderPending, onFault = () => {} } = {}) {
  const root = supplied?.stateRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-'));
  const config = supplied || { stateRoot: root, channels: [channel] };
  const sent = [];
  let active = true;
  const bridge = createNativeBridge({ config, providerTimeoutMs: timeout || 100, maxProviderPending, onFault });
  const api = { sendMessage: async (...args) => {
    sent.push(args); return provider ? provider(...args) : { message: { msgId: 987654 }, attachment: [] };
  } };
  const session = bridge.attach({ accountId: channel.accountId, ownUid: '100', api, isActive: () => active });
  const url = await bridge.listen(0);
  t.after(async () => { await bridge.close(); if (!supplied) fs.rmSync(root, { recursive: true, force: true }); });
  async function request(route, body = {}, token = channel.token) {
    const response = await fetch(url + route, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  const receive = () => request('/v1/receive', { generation: channel.generation });
  const send = (requestId = 'reply-1', text = 'Native response') => request('/v1/send', { generation: channel.generation, requestId, text });
  return { bridge, config, session, api, sent, url, request, receive, send, deactivate: () => { active = false; } };
}

test('native private DM and fixed paired reply work without CRM clients or a model wrapper', async t => {
  const f = await fixture(t);
  assert.equal(await f.session.capture(event()), true);
  const inbound = await f.receive();
  assert.equal(inbound.data.status, 'message');
  assert.equal(inbound.data.profile, channel.profile);
  assert.equal(inbound.data.event.senderUid, '200');
  assert.equal(inbound.data.event.text, 'Native personal request');
  assert.equal((await f.request('/v1/ack', { generation: channel.generation, eventId: inbound.data.event.id, status: 'accepted' })).data.status, 'accepted');
  assert.equal((await f.send()).data.status, 'sent');
  assert.deepEqual(f.sent, [[{ msg: 'Native response' }, '200', 0]]);
  assert.equal((await f.receive()).data.status, 'empty');
});

test('raw groups, history-shaped input, foreign sender, forwarded text and echoes never become instructions', async t => {
  const f = await fixture(t);
  for (const alter of [m => { m.type = 1; }, m => { m.isSelf = true; },
    m => { m.data.uidFrom = '300'; }, m => { m.data.idTo = '999'; },
    m => { m.data.ts = Date.now() - 400000; }, m => { m.data.forward = true; },
    m => { m.data.content = '/hermes-link hz_' + 'b'.repeat(64); },
    m => { Object.defineProperty(m.data, 'content', { get() { throw new Error('must not execute'); } }); },
    m => { m.threadId = '300'; }]) {
    const message = event(); alter(message); await f.session.capture(message);
    assert.equal((await f.receive()).data.status, 'empty');
  }
  assert.equal(f.bridge.isPrivateThread(channel.accountId, '200'), true);
  assert.equal(f.bridge.isPrivateThread(channel.accountId, '300'), false);
});

test('channel capability, generation, verified own UID and current session are mandatory', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/channel', {}, 'hc_crm_token')).status, 401);
  assert.equal((await f.request('/v1/send', { generation: 'stale', requestId: 'a', text: 'no' })).status, 400);
  assert.equal((await f.request('/v1/send', { generation: channel.generation, requestId: 'a', text: 'no', recipientUid: '300' })).status, 400);
  assert.throws(() => f.bridge.attach({ accountId: channel.accountId, ownUid: '999', api: f.api, isActive: () => true }), /identity_mismatch/);
  f.deactivate(); await f.session.capture(event());
  assert.equal((await f.receive()).data.status, 'unavailable');
  assert.equal((await f.send()).data.status, 'unavailable');
  assert.equal(f.sent.length, 0);
});

test('durable inbound dedup and outbound receipt survive a bridge restart without replay', async t => {
  const f = await fixture(t);
  const message = event(); await f.session.capture(message); await f.session.capture(message);
  assert.equal((await f.receive()).data.status, 'message');
  assert.equal((await f.receive()).data.status, 'empty');
  assert.equal((await f.send()).data.status, 'sent');
  await f.bridge.close();
  const g = await fixture(t, { config: f.config });
  await g.session.capture(message);
  assert.equal((await g.receive()).data.status, 'empty');
  assert.equal((await g.send()).data.status, 'sent');
  assert.equal(g.sent.length, 0);
  assert.equal((await g.send('reply-1', 'altered payload')).status, 400);
});

test('runtime receipt shapes: numeric-string msgId and extra keys are sent; invalid msgId stays unknown with a redacted fault', async t => {
  assert.equal(nativeTextReceipt({ message: { msgId: 987654 }, attachment: [] }), '987654');
  assert.equal(nativeTextReceipt({ message: { msgId: '7312345678901', cliMsgId: '1' }, attachment: [], extra: { a: 1 } }), '7312345678901');
  assert.equal(nativeTextReceipt({ message: { msgId: '7312345678901' } }), '7312345678901', 'attachment may be absent');
  for (const bad of [undefined, null, {}, { message: {} }, { message: { msgId: 0 }, attachment: [] }, { message: { msgId: -5 }, attachment: [] },
    { message: { msgId: 2 ** 53 }, attachment: [] }, { message: { msgId: '0' }, attachment: [] }, { message: { msgId: '-5' }, attachment: [] },
    { message: { msgId: 'abc' }, attachment: [] }, { message: { msgId: '12 3' }, attachment: [] }, { message: { msgId: '1'.repeat(26) }, attachment: [] },
    { message: { msgId: 1 }, attachment: [{ msgId: 2 }] }, { message: { msgId: 1 }, attachment: 'x' }, { msgId: 1, attachment: [] }]) {
    assert.equal(nativeTextReceipt(bad), null, JSON.stringify(bad));
  }
  const getter = { message: {}, attachment: [] }; let read = false;
  Object.defineProperty(getter.message, 'msgId', { enumerable: true, get() { read = true; return 1; } });
  assert.equal(nativeTextReceipt(getter), null); assert.equal(read, false, 'provider getters never run');

  const live = await fixture(t, { provider: () => ({ message: { msgId: '7312345678901', cliMsgId: '55' }, attachment: [], ts: 1 }) });
  assert.deepEqual((await live.send('string-id')).data, { status: 'sent', messageId: '7312345678901' });
  assert.equal((await live.send('next', 'Second response')).data.status, 'sent', 'a recognized receipt never quarantines the channel');
  const faults = [];
  const bad = await fixture(t, { provider: () => ({ message: { msgId: 'PRIVATE 0912345678', note: 'PRIVATE TEXT' }, attachment: [] }),
    onFault: code => faults.push(code) });
  assert.equal((await bad.send('bad-id')).data.status, 'outcome_unknown');
  assert.deepEqual(faults, ['native_receipt_unrecognized {message:{msgId:string,note:string},attachment:array(0)}']);
  assert.doesNotMatch(faults.join(), /PRIVATE|0912/);
  // A map keyed by IDs must not leak those IDs through key names.
  const idKeyed = await fixture(t, { provider: () => ({ message: { 7312345678901: { ok: true } }, attachment: [] }),
    onFault: code => faults.push(code) });
  assert.equal((await idKeyed.send('id-keyed')).data.status, 'outcome_unknown');
  assert.equal(faults.at(-1), 'native_receipt_unrecognized {message:{#:object},attachment:array(0)}');
  assert.doesNotMatch(faults.join(), /7312345678901/);
  // A receipt the unchanged journal format cannot record stays unknown, never "sent".
  const wide = await fixture(t, { provider: () => ({ message: { msgId: '9'.repeat(20) }, attachment: [] }), onFault: code => faults.push(code) });
  assert.equal((await wide.send('wide-id')).data.status, 'outcome_unknown');
  assert.equal(faults.at(-1), 'native_receipt_unrecordable');
});

test('lost provider outcome is quarantined durably and concurrent retry cannot send twice', async t => {
  const pending = Promise.withResolvers();
  const f = await fixture(t, { provider: () => pending.promise, timeout: 15 });
  const [a, b] = await Promise.all([f.send(), f.send()]);
  assert.equal(a.data.status, 'outcome_unknown'); assert.equal(b.data.status, 'outcome_unknown');
  assert.equal(f.sent.length, 1);
  let closed = false;
  const closing = f.bridge.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  const closedBeforeProvider = closed;
  pending.resolve({ ackLost: true });
  await closing;
  assert.equal(closedBeforeProvider, false, 'shutdown must retain worker ownership until actual provider settlement');
  const g = await fixture(t, { config: f.config });
  assert.equal((await g.send()).data.status, 'outcome_unknown'); assert.equal(g.sent.length, 0);
});

test('link handshake including quoted and malformed markers goes only to the redacted CRM linking path', async t => {
  const f = await fixture(t);
  for (const data of [
    { content: '/hermes-link hz_' + 'b'.repeat(64) },
    { content: '/hermes-link malformed' },
    { quote: { content: 'hz_' + 'b'.repeat(64) } },
  ]) {
    const message = event(); Object.assign(message.data, data);
    assert.equal(await f.session.capture(message), false);
    assert.equal((await f.receive()).data.status, 'empty');
  }
});

test('ambiguous channel blocks fresh request IDs and changed content concurrently and after restart', async t => {
  const pending = Promise.withResolvers();
  const f = await fixture(t, { provider: () => pending.promise, timeout: 15 });
  try {
    const [a, b] = await Promise.all([f.send('cron-live'), f.send('cron-standalone', 'Changed fallback payload')]);
    assert.equal(a.data.status, 'outcome_unknown'); assert.equal(b.data.status, 'outcome_unknown');
    assert.equal(f.sent.length, 1, 'new request ID or changed payload must not bypass an unknown outcome');
  } finally { pending.resolve({ ackLost: true }); }
  await f.bridge.close();
  const g = await fixture(t, { config: f.config });
  assert.equal((await g.send('after-restart')).data.status, 'outcome_unknown');
  assert.equal((await g.send('different', 'Fresh proactive text')).data.status, 'outcome_unknown');
  assert.equal(g.sent.length, 0, 'ambiguous channel quarantine must survive worker restart');
});

test('known provider success releases channel quarantine and permits genuinely fresh repeated text', async t => {
  const pending = Promise.withResolvers(), entered = Promise.withResolvers();
  const f = await fixture(t, { provider: () => { entered.resolve(); return pending.promise; }, timeout: 10000 });
  const first = f.send('first');
  try {
    await entered.promise;
    assert.equal((await f.send('during-send', 'Different payload during send')).data.status, 'outcome_unknown');
    assert.equal(f.sent.length, 1);
  } finally { pending.resolve({ message: { msgId: 987654 }, attachment: [] }); }
  assert.equal((await first).data.status, 'sent');
  assert.equal((await f.send('fresh', 'Native response')).data.status, 'sent');
  assert.equal((await f.send('fresh', 'Native response')).data.status, 'sent');
  assert.equal((await f.send('different', 'Fresh proactive text')).data.status, 'sent');
  assert.equal(f.sent.length, 3, 'success permits new obligations while same-ID receipt dedup remains');
});

test('late known provider receipt clears quarantine only after it is durably recorded', async t => {
  const pending = Promise.withResolvers();
  const f = await fixture(t, { provider: () => pending.promise, timeout: 15 });
  try {
    assert.equal((await f.send('late-ack')).data.status, 'outcome_unknown');
    assert.equal((await f.send('before-ack', 'Fresh text')).data.status, 'outcome_unknown');
    assert.equal(f.sent.length, 1);
  } finally { pending.resolve({ message: { msgId: 987654 }, attachment: [] }); }
  // Reading the original ID only returns success once its terminal journal write
  // has completed. A duplicate effect must not be used to manufacture that proof.
  assert.equal((await f.send('late-ack')).data.status, 'sent');
  assert.equal((await f.send('after-ack', 'Fresh text')).data.status, 'sent');
  assert.equal(f.sent.length, 2);
  await f.bridge.close();
  const g = await fixture(t, { config: f.config });
  assert.equal((await g.send('late-ack')).data.status, 'sent');
  assert.equal(g.sent.length, 0);
  assert.equal((await g.send('fresh-after-restart')).data.status, 'sent');
  assert.equal(g.sent.length, 1);
});

test('ambiguous channel quarantine belongs only to its own journal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-digest-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const second = { ...channel, profile: 'second-fixture', pairedUid: '300', mainUid: '300', token: 'hzn_' + 'b'.repeat(64) };
  const f = await fixture(t, { config: { stateRoot: root, channels: [channel, second] }, provider: () => ({ ackLost: true }) });
  assert.equal((await f.send('first-channel')).data.status, 'outcome_unknown');
  const other = await f.request('/v1/send', { generation: second.generation, requestId: 'second-channel', text: 'Native response' }, second.token);
  assert.equal(other.data.status, 'outcome_unknown');
  assert.deepEqual(f.sent.map(([, uid]) => uid), ['200', '300']);
});

test('transport preserves Vietnamese UTF-8 split between network chunks and bounded JSON escapes', async t => {
  const f = await fixture(t);
  const text = 'Phòng trống', payload = Buffer.from(JSON.stringify({ generation: channel.generation, requestId: 'unicode', text }));
  const split = payload.indexOf(Buffer.from('ò')) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = http.request(f.url + '/v1/send', { method: 'POST', headers: { Authorization: `Bearer ${channel.token}` } }, res => {
      let raw = ''; res.on('data', part => { raw += part; }); res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject); req.write(payload.subarray(0, split)); setImmediate(() => req.end(payload.subarray(split)));
  });
  assert.equal(result.status, 'sent');
  assert.equal(f.sent[0][0].msg, text);
  const escaped = 'x' + '\u0001'.repeat(10000);
  assert.equal((await f.send('escaped', escaped)).data.status, 'sent');
  assert.equal(f.sent[1][0].msg, escaped);
});

test('unsettled provider work keeps the admission slot after timeout and across a session replacement', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-provider-slot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const second = { ...channel, profile: 'second-fixture', pairedUid: '300', mainUid: '300', token: 'hzn_' + 'b'.repeat(64) };
  const pending = Promise.withResolvers();
  const f = await fixture(t, { config: { stateRoot: root, channels: [channel, second] },
    provider: () => pending.promise, timeout: 15, maxProviderPending: 1 });
  try {
    assert.equal((await f.send()).data.status, 'outcome_unknown');
    f.session.close();
    f.bridge.attach({ accountId: channel.accountId, ownUid: '100', api: f.api, isActive: () => true });
    // A different channel is outside quarantine, so this specifically proves
    // that timeout/reconnect did not release the shared provider admission slot.
    const other = await f.request('/v1/send', { generation: second.generation, requestId: 'other-channel', text: 'Different pending work' }, second.token);
    assert.equal(other.data.status, 'busy');
    assert.equal(f.sent.length, 1);
  } finally { pending.resolve({ message: { msgId: 987654 }, attachment: [] }); }
});

test('token routes each profile to its own configured sender and journal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-multi-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const second = { ...channel, profile: 'second-fixture', pairedUid: '300', mainUid: '300', token: 'hzn_' + 'b'.repeat(64) };
  const f = await fixture(t, { config: { stateRoot: root, channels: [channel, second] } });
  await f.session.capture(event());
  assert.equal((await f.request('/v1/receive', { generation: channel.generation }, second.token)).data.status, 'empty');
  assert.equal((await f.receive()).data.status, 'message');
  await f.request('/v1/send', { generation: second.generation, requestId: 'other-profile', text: 'private second' }, second.token);
  assert.equal(f.sent[0][1], '300');
});

test('native config rejects cross-profile token reuse and requires the paired user as main controller', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, 'token'); fs.writeFileSync(tokenFile, channel.token, { mode: 0o600 });
  const file = path.join(root, 'config.json');
  const grant = { ...channel, tokenFile }; delete grant.token;
  const config = { version: 1, stateRoot: root, listenPort: 8991, channels: [grant] };
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 }); assert.equal(readNativeConfig(file).channels[0].profile, channel.profile);
  config.channels.push({ ...grant, profile: 'second-fixture', pairedUid: '300', mainUid: '300' });
  fs.writeFileSync(file, JSON.stringify(config)); assert.throws(() => readNativeConfig(file), /token/);
  config.channels = [{ ...grant, mainUid: '300' }];
  fs.writeFileSync(file, JSON.stringify(config)); assert.throws(() => readNativeConfig(file), /channel/);
});
