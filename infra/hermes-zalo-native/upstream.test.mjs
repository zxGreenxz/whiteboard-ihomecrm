import { createNativeBridge } from '../../worker/lib/hermes-native-bridge.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
