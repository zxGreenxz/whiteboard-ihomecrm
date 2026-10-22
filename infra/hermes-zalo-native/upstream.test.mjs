import { createNativeBridge } from '../../worker/lib/hermes-native-bridge.js';
import { stripImageMetadata } from '../../worker/lib/hermes-native-media.js';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HERMES_COMMIT } from '../hermes-runtime/runtime-contract.mjs';

test('real upstream plugin and BasePlatformAdapter compose with the worker bridge', {
  skip: !process.env.HERMES_TEST_UPSTREAM || !process.env.HERMES_TEST_PYTHON
    ? 'Requires explicit upstream checkout and isolated Python environment; not live model/Zalo proof' : false,
}, async () => {
const upstream = path.resolve(process.env.HERMES_TEST_UPSTREAM);
assert.equal(execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), HERMES_COMMIT);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-upstream-')));
const profile = path.join(root, 'profiles/native-fixture'); fs.mkdirSync(profile, { recursive: true });
const channel = { accountId: '11111111-1111-4111-8111-111111111111', ownUid: '100', pairedUid: '200', mainUid: '200',
  profile: 'native-fixture', generation: '22222222-2222-4222-8222-222222222222', token: 'hzn_' + 'a'.repeat(64) };
const bridge = createNativeBridge({ config: { stateRoot: path.join(root, 'journal'), channels: [channel] } });
const sent = [];
const session = bridge.attach({ accountId: channel.accountId, ownUid: '100', isActive: () => true,
  api: { async sendMessage(...args) { sent.push(args); return { message: { msgId: 987654 }, attachment: [] }; } } });
try {
  const url = await bridge.listen(0);
  await session.capture({ type: 0, isSelf: false, threadId: '200', data: { uidFrom: '200', idTo: '100',
    msgType: 'webchat', msgId: 'm1', content: 'personal native fixture', ts: Date.now() } });
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, TEMP: root, TMP: root,
    PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', HERMES_HOME: profile, PROBE_UPSTREAM: upstream,
    PROBE_PLUGIN: path.resolve('infra/hermes-zalo-native'),
    HERMES_ZALO_BRIDGE_URL: url, HERMES_ZALO_BRIDGE_TOKEN: channel.token, HERMES_ZALO_PROFILE: channel.profile,
    HERMES_ZALO_PAIRED_UID: channel.pairedUid, HERMES_ZALO_GENERATION: channel.generation };
  const child = spawn(process.env.HERMES_TEST_PYTHON, ['infra/hermes-zalo-native/upstream-probe.py'], { env, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, `Upstream probe failed: ${stderr}`);
  const result = JSON.parse(stdout.trim());
  assert.deepEqual(result, { registration: true, upstreamBaseAdmission: true, receive: true, send: true, dedup: true, foreignDenied: true });
  assert.deepEqual(sent, [[{ msg: 'Phòng trống – native reply' }, '200', 0], [{ msg: 'Fresh proactive reply' }, '200', 0]]);
} finally { await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

const upstreamRequired = {
  skip: !process.env.HERMES_TEST_UPSTREAM || !process.env.HERMES_TEST_PYTHON
    ? 'Requires explicit upstream checkout and isolated Python environment; not live model/Zalo proof' : false,
};

async function withDeliveryFixture(run, { confirmed = false, providerDelayMs = 0, providerTimeoutMs = 60000 } = {}) {
  const upstream = path.resolve(process.env.HERMES_TEST_UPSTREAM);
  assert.equal(execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), HERMES_COMMIT);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-recovery-')));
  const profile = path.join(root, 'profiles/native-fixture'); fs.mkdirSync(profile, { recursive: true });
  const channel = { accountId: '11111111-1111-4111-8111-111111111111', ownUid: '100', pairedUid: '200', mainUid: '200',
    profile: 'native-fixture', generation: '22222222-2222-4222-8222-222222222222', token: 'hzn_' + 'a'.repeat(64) };
  const journalRoot = path.join(root, 'journal');
  const bridge = createNativeBridge({ config: { stateRoot: journalRoot, channels: [channel] }, providerTimeoutMs });
  const sent = [];
  bridge.attach({ accountId: channel.accountId, ownUid: '100', isActive: () => true,
    api: { async sendMessage(message, ...destination) {
      sent.push([message, ...destination]);
      if (providerDelayMs) await new Promise(resolve => setTimeout(resolve, providerDelayMs));
      // The provider effect occurred but its ACK cannot prove success. A mutated
      // fallback/recovery payload would become a new provider effect in this fixture.
      return !confirmed && message.msg.startsWith('ambiguous ')
        ? { ackLost: true } : { message: { msgId: 987654 }, attachment: [] };
    } } });
  try {
    const url = await bridge.listen(0);
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, TEMP: root, TMP: root,
      PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', HERMES_HOME: profile, PROBE_UPSTREAM: upstream,
      PROBE_PLUGIN: path.resolve('infra/hermes-zalo-native'),
      HERMES_ZALO_BRIDGE_URL: url, HERMES_ZALO_BRIDGE_TOKEN: channel.token, HERMES_ZALO_PROFILE: channel.profile,
      HERMES_ZALO_PAIRED_UID: channel.pairedUid, HERMES_ZALO_GENERATION: channel.generation };
    async function probe(mode) {
      const child = spawn(process.env.HERMES_TEST_PYTHON, ['infra/hermes-zalo-native/upstream-probe.py'], {
        env: { ...env, PROBE_MODE: mode }, windowsHide: true,
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      const timer = setTimeout(() => child.kill(), 30000);
      let code;
      try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
      finally { clearTimeout(timer); }
      assert.equal(code, 0, `Upstream ${mode} probe failed (provider effects: ${sent.length}): ${stderr}`);
      return JSON.parse(stdout.trim());
    }
    const journalStatuses = () => Object.values(JSON.parse(fs.readFileSync(
      path.join(journalRoot, fs.readdirSync(journalRoot)[0]), 'utf8')).outbound).map(record => record.status);
    await run({ probe, sent, journalStatuses });
  } finally { await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test('real upstream retry and plain-text fallback never resend ambiguous native delivery', upstreamRequired, async () => {
  await withDeliveryFixture(async ({ probe, sent }) => {
    assert.deepEqual(await probe('retry'), { retryAndFallbackSuppressed: true, responseLossTerminal: true });
    assert.equal(sent.length, 1); // The first ambiguous effect also quarantines the subsequent proactive attempt.
    assert.ok(sent.every(([message]) => message.msg.startsWith('ambiguous retry ')));
  });
});

test('real upstream runtime ledger recovery quarantines an ambiguous native delivery', upstreamRequired, async () => {
  await withDeliveryFixture(async ({ probe, sent }) => {
    assert.deepEqual(await probe('runtime'), { runtimeRecoveryQuarantined: true });
    assert.deepEqual(sent, [[{ msg: 'ambiguous runtime' }, '200', 0]]);
  });
});

test('real upstream cron live-to-standalone fallback cannot duplicate short or transformed long output', upstreamRequired, async t => {
  for (const mode of ['cron', 'cron-long']) await t.test(mode, async () => {
    await withDeliveryFixture(async ({ probe, sent }) => {
      assert.deepEqual(await probe(mode), { liveAttemptOnly: true, standaloneRejected: true, ambiguousFailure: true });
      assert.equal(sent.length, 1, 'Cron fallback changed request ID/text but must not create a second provider effect');
      assert.ok(sent[0][0].msg.startsWith('ambiguous native cron result'));
    });
  });
});

test('real upstream cron fallback stays rejected after known SENT when HTTP response or late ACK was lost', upstreamRequired, async t => {
  for (const mode of ['cron-http-loss', 'cron-late-ack']) await t.test(mode, async () => {
    await withDeliveryFixture(async ({ probe, sent, journalStatuses }) => {
      assert.deepEqual(await probe(mode), { liveAttemptOnly: true, standaloneRejected: true, ambiguousFailure: true });
      assert.equal(sent.length, 1, 'An unknown caller outcome must not become a second effect after a known provider ACK');
      assert.deepEqual(journalStatuses(), ['sent'], 'Test the race after the bridge latch has cleared');
    }, { confirmed: true, ...(mode === 'cron-late-ack' ? { providerDelayMs: 50, providerTimeoutMs: 5 } : {}) });
  });
});

test('real upstream generic Zalo route fails explicitly while live cron permits fresh repeated deliveries', upstreamRequired, async () => {
  await withDeliveryFixture(async ({ probe, sent }) => {
    assert.deepEqual(await probe('generic'), { genericRouteRejected: true, adapterNotCalled: true });
    assert.equal(sent.length, 0);
    assert.deepEqual(await probe('cron-success'), { liveCronDelivered: true, freshRepeatDelivered: true });
    assert.deepEqual(sent, Array.from({ length: 2 }, () => [{ msg: 'successful native cron result' }, '200', 0]));
  });
});

test('real upstream restart and crash-left recovery preserve channel quarantine for all new sends', upstreamRequired, async () => {
  await withDeliveryFixture(async ({ probe, sent }) => {
    assert.deepEqual(await probe('seed-restart'), { durableSeed: true, attempts: 4 });
    assert.equal(sent.length, 1);
    assert.deepEqual(await probe('recover-restart'), { restartRecoveryQuarantined: true, crashLeftQuarantined: true,
      pendingHeldByChannelQuarantine: true, freshHeldByChannelQuarantine: true });
    assert.deepEqual(sent, [[{ msg: 'ambiguous failed' }, '200', 0]]);
  });
});

// Synthetic JPEG (no real photo): EXIF with a marker the worker must strip.
const u16 = n => Buffer.from([n >> 8, n & 255]);
const segment = (marker, body) => Buffer.concat([Buffer.from([0xff, marker]), u16(body.length + 2), body]);
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from('JFIF\0\x01\x02\0\0\x01\0\x01\0\0', 'latin1')),
  segment(0xe1, Buffer.from('Exif\0\0MM\0*\0\0\0\x08\0\0GPS_SECRET', 'latin1')), segment(0xdb, Buffer.alloc(65, 1)),
  segment(0xc0, Buffer.from([8, 1, 224, 2, 128, 1, 1, 0x11, 0])), segment(0xc4, Buffer.alloc(20, 2)),
  segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0x34]), Buffer.from([0xff, 0xd9])]);

// Optional proxy in front of the bridge: an older worker that rejects `accept`,
// or a transport that corrupts photo bytes while keeping the announced headers.
function bridgeProxy(target, { rejectAccept = false, tamperMedia = false } = {}) {
  const seen = { accept: 0, plain: 0 };
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts);
    if (req.url === '/v1/receive') seen[JSON.parse(body).accept ? 'accept' : 'plain']++;
    if (rejectAccept && req.url === '/v1/receive' && JSON.parse(body).accept) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"native_request_rejected"}'); return;
    }
    const upstream = await fetch(target + req.url, { method: 'POST', headers: { Authorization: req.headers.authorization }, body });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (tamperMedia && req.url === '/v1/media' && upstream.ok) bytes[bytes.length - 3] ^= 0xff;
    res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([key]) =>
      ['content-type', 'content-length', 'x-media-sha256', 'x-media-type'].includes(key))));
    res.end(bytes);
  });
  return { seen, server, listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve(`http://127.0.0.1:${server.address().port}`))) };
}

async function withMediaFixture(run, proxyOptions) {
  const upstream = path.resolve(process.env.HERMES_TEST_UPSTREAM);
  assert.equal(execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), HERMES_COMMIT);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-native-media-')));
  const profile = path.join(root, 'profiles/native-fixture'); fs.mkdirSync(profile, { recursive: true });
  const channel = { accountId: '11111111-1111-4111-8111-111111111111', ownUid: '100', pairedUid: '200', mainUid: '200',
    profile: 'native-fixture', generation: '22222222-2222-4222-8222-222222222222', token: 'hzn_' + 'a'.repeat(64) };
  const journalRoot = path.join(root, 'journal');
  const bridge = createNativeBridge({ config: { stateRoot: journalRoot, channels: [channel] }, media: { settleMs: 20, waitMs: 150 },
    fetchMedia: async url => url.includes('gone') ? new Response(null, { status: 404 })
      : new Response(PHOTO, { headers: { 'content-type': 'image/jpeg' } }) });
  const sent = [];
  const session = bridge.attach({ accountId: channel.accountId, ownUid: '100', isActive: () => true,
    api: { async sendMessage(...args) { sent.push(args); return { message: { msgId: 987654 }, attachment: [] }; } } });
  let proxy = null;
  try {
    let url = await bridge.listen(0);
    if (proxyOptions) { proxy = bridgeProxy(url, proxyOptions); url = await proxy.listen(); }
    const message = (msgId, msgType, content, extra = {}) => ({ type: 0, isSelf: false, threadId: '200', data: {
      uidFrom: '200', idTo: '100', msgType, msgId, ts: String(Date.now()), content, ...extra } });
    const photo = (msgId, file, title = '', layout) => message(msgId, 'chat.photo',
      { title, href: `https://photo-stal.zdn.vn/${file}.jpg`, params: '{}' },
      layout ? { extraData: JSON.stringify({ groupMediaMsg: { groupLayoutId: layout } }) } : {});
    async function probe(mode, onLine) {
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, TEMP: root, TMP: root,
        PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', HERMES_HOME: profile, PROBE_UPSTREAM: upstream,
        PROBE_PLUGIN: path.resolve('infra/hermes-zalo-native'), PROBE_MODE: mode,
        HERMES_ZALO_BRIDGE_URL: url, HERMES_ZALO_BRIDGE_TOKEN: channel.token, HERMES_ZALO_PROFILE: channel.profile,
        HERMES_ZALO_PAIRED_UID: channel.pairedUid, HERMES_ZALO_GENERATION: channel.generation };
      const child = spawn(process.env.HERMES_TEST_PYTHON, ['infra/hermes-zalo-native/upstream-probe.py'], { env, windowsHide: true });
      let stdout = '', stderr = '', pending = '', chain = Promise.resolve();
      child.stdout.on('data', bytes => {
        stdout += bytes; pending += bytes;
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) chain = chain.then(() => onLine?.(line.trim()));
      });
      child.stderr.on('data', bytes => { stderr += bytes; });
      const timer = setTimeout(() => child.kill(), 40000);
      let code;
      try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
      finally { clearTimeout(timer); }
      await chain;
      assert.equal(code, 0, `Upstream ${mode} probe failed: ${stderr}`);
      return JSON.parse(stdout.trim().split('\n').at(-1));
    }
    const journal = () => Object.values(JSON.parse(fs.readFileSync(
      path.join(journalRoot, fs.readdirSync(journalRoot)[0]), 'utf8')).inbound).map(record => [record.messageId, record.status]);
    await run({ probe, session, photo, message, journal, proxy, sent });
  } finally {
    await bridge.close(); proxy?.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('real upstream adapter declares photos and turns them into PHOTO events with cached, stripped bytes', upstreamRequired, async () => {
  await withMediaFixture(async ({ probe, session, photo, message, journal }) => {
    const result = await probe('media', async line => {
      if (line === 'READY') await session.capture(photo('p1', 'bill', 'chi 350k sửa vòi'));
      if (line === 'GOT 1') {
        await session.capture(photo('a1', 'album-1', '', 'L1'));
        await session.capture(photo('a2', 'gone', '', 'L1'));
      }
      if (line === 'GOT 2') {
        for (const id of ['f1', 'f2']) await session.capture(message(id, 'share.file', { title: 'private.pdf', href: 'https://f.zdn.vn/x' }));
      }
    });
    const stripped = createHash('sha256').update(stripImageMetadata(PHOTO)).digest('hex');
    assert.deepEqual(result, { photo: true, albumWithError: true, notice: true, zimgLine: true, cached: [stripped, stripped] });
    assert.deepEqual(journal(), [['p1', 'accepted'], ['a1', 'accepted'], ['a2', 'accepted'], ['f1', 'accepted'], ['f2', 'accepted']]);
  });
});

test('real upstream adapter keeps text working against an older worker that rejects the photo handshake', upstreamRequired, async () => {
  await withMediaFixture(async ({ probe, session, message, proxy, sent }) => {
    await session.capture(message('m1', 'webchat', 'personal native fixture'));
    assert.deepEqual(await probe('composition'), { registration: true, upstreamBaseAdmission: true, receive: true,
      send: true, dedup: true, foreignDenied: true });
    assert.equal(proxy.seen.accept, 1, 'one handshake attempt, then text-only until the retry interval');
    assert.ok(proxy.seen.plain >= 1);
    assert.equal(sent.length, 2);
  }, { rejectAccept: true });
});

test('real upstream adapter treats only the request-rejected 400 as an older worker', upstreamRequired, async () => {
  await withMediaFixture(async ({ probe }) => {
    assert.deepEqual(await probe('receive-errors'), { internalFaultKeepsPhotos: true, olderWorkerFallsBack: true });
  });
});

test('real upstream adapter refuses photo bytes that do not match the announced digest', upstreamRequired, async () => {
  await withMediaFixture(async ({ probe, session, photo, journal }) => {
    assert.deepEqual(await probe('media-tamper', async line => {
      if (line === 'READY') await session.capture(photo('t1', 'bill', 'bill'));
    }), { tamperedBytesRejected: true });
    assert.deepEqual(journal(), [['t1', 'accepted']]);
  }, { tamperMedia: true });
});
