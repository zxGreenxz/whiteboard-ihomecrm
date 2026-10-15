import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as original from '../../worker/lib/hermes-native-bridge.js';
import { readNativeConfig } from '../../worker/lib/hermes-native-config.js';
import { nativeDigest } from '../../worker/lib/hermes-native-journal.js';
import { NATIVE_RECONCILIATION_MAX_BYTES, nativeReconciliationFile } from '../../worker/lib/hermes-native-reconciliation.js';
import { planNativeGrant, applyNativeGrant, inspectNativeDelivery, reconcileNativeDelivery } from './operator.mjs';

// Every unknown send here is produced by the real bridge and every decision is
// recorded by the real operator reconcile command; only negative cases forge
// or damage the ledger bytes the operator wrote.
const accountId = '11111111-1111-4111-8111-111111111111';
const receipt = () => ({ message: { msgId: 987654 }, attachment: [] });
const lost = () => ({ ackLost: true });
// The simulated lost ACK is an unrecognized receipt: the bridge reports only
// its redacted shape. Every other fault below is a reconciliation fault.
const LOST_FAULT = 'native_receipt_unrecognized {ackLost:boolean}';
const ledgerFaults = faults => { assert.ok(faults.includes(LOST_FAULT)); return faults.filter(code => code !== LOST_FAULT); };
const tick = () => new Promise(resolve => setImmediate(resolve));
const OLD = 'Nội dung cũ chưa rõ đã tới chưa', NEW = 'Nội dung mới sau đối soát';

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
function grant(t, { profiles = [['alpha', '200']], listenPort = 8991 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-release-')));
  const stateRoot = path.join(root, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 });
  const configFile = path.join(root, 'config.json'), cleanup = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step();
    fs.rmSync(root, { recursive: true, force: true });
  });
  profiles.forEach(([profile, pairedUid], index) => {
    const options = { action: 'create', configFile, profile, accountId, ownUid: '100', pairedUid,
      tokenFile: path.join(root, `${profile}.token`), ...(index ? {} : { stateRoot, listenPort }) };
    applyNativeGrant({ ...options, expect: planNativeGrant(options).expectedRevision });
  });
  return { root, stateRoot, configFile, ledgerFile: `${configFile}.reconciliations.json`, cleanup };
}
/** viaEnv drives the production entry (startNativeBridge + env). Otherwise
 * ledger:false models a bridge built without the ledger path (legacy). */
async function harness(f, { impl = original, viaEnv = false, ledger = true } = {}) {
  const config = readNativeConfig(f.configFile), calls = [], faults = [];
  let reply = lost, bridge, url;
  const onFault = code => faults.push(code);
  if (viaEnv) {
    const previous = process.env.HERMES_ZALO_NATIVE_CONFIG;
    process.env.HERMES_ZALO_NATIVE_CONFIG = f.configFile;
    try { bridge = await impl.startNativeBridge({ onFault }); }
    finally { if (previous === undefined) delete process.env.HERMES_ZALO_NATIVE_CONFIG; else process.env.HERMES_ZALO_NATIVE_CONFIG = previous; }
    f.cleanup.push(() => bridge.close());
    url = `http://127.0.0.1:${config.listenPort}`;
  } else {
    bridge = impl.createNativeBridge({ config, providerTimeoutMs: 50, onFault,
      ...(ledger ? { reconciliationFile: nativeReconciliationFile(f.configFile) } : {}) });
    f.cleanup.push(() => bridge.close());
    url = await bridge.listen(0);
  }
  bridge.attach({ accountId, ownUid: '100', isActive: () => true,
    api: { sendMessage: async (...args) => { calls.push(args); return reply(...args); } } });
  async function send(profile, requestId, text = `Tin ${requestId}`) {
    const channel = config.channels.find(c => c.profile === profile);
    const response = await fetch(`${url}/v1/send`, { method: 'POST', headers: { Authorization: `Bearer ${channel.token}`,
      'Content-Type': 'application/json' }, body: JSON.stringify({ generation: channel.generation, requestId, text }) });
    assert.equal(response.status, 200);
    return (await response.json()).status;
  }
  return { config, bridge, calls, faults, send, setReply: next => { reply = next; } };
}
function reconcile(f, profile, requestId, decision = 'not_sent') {
  const options = { action: 'reconcile', configFile: f.configFile, profile, requestId, decision,
    note: 'Đã mở DM trên Zalo và đối chiếu thủ công' };
  return reconcileNativeDelivery({ ...options, expect: reconcileNativeDelivery(options).expectedRevision }, { apply: true });
}
const inspect = (f, profile = 'alpha') => inspectNativeDelivery({ configFile: f.configFile, profile }).channels[0];
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
async function blocked(h, label) {
  const calls = h.calls.length;
  assert.equal(await h.send('alpha', `blocked-${label}`, NEW), 'outcome_unknown', label);
  assert.equal(h.calls.length, calls, `${label}: provider must not be called`);
}

// Probes shared by the behavior tests and the mutation tests. Each reports
// whether the guard held, so a mutant must flip it.
async function unreconciledProbe(t, impl) {
  const f = grant(t), h = await harness(f, { impl });
  assert.equal(await h.send('alpha', 'unknown-1', OLD), 'outcome_unknown');
  h.setReply(receipt);
  const status = await h.send('alpha', 'fresh-1', NEW);
  return { f, h, held: status === 'outcome_unknown' && h.calls.length === 1 };
}
async function releaseProbe(t, impl) {
  const f = grant(t, { listenPort: await freePort() }), h = await harness(f, { impl, viaEnv: true });
  assert.equal(await h.send('alpha', 'unknown-1', OLD), 'outcome_unknown');
  assert.equal(await h.send('alpha', 'blocked-1'), 'outcome_unknown');
  const journalFile = inspect(f).journalFile;
  const before = { journal: fs.readFileSync(journalFile), config: fs.readFileSync(f.configFile),
    record: readJson(journalFile).outbound['unknown-1'], generation: h.config.channels[0].generation };
  reconcile(f, 'alpha', 'unknown-1');
  const journalAfterReconcile = fs.readFileSync(journalFile);
  h.setReply(receipt);
  const status = await h.send('alpha', 'fresh-1', NEW);
  return { f, h, before, journalFile, journalAfterReconcile, released: status === 'sent' && h.calls.length === 2 };
}
// null: the probe derives a value differing by one from the genuine entry.
const FORGED = { recordDigest: { recordDigest: nativeDigest('một nội dung khác') }, startedAt: null,
  generation: { generation: '33333333-3333-4333-8333-333333333333' }, profile: { profile: 'beta' },
  accountId: { accountId: '44444444-4444-4444-8444-444444444444' }, requestId: { requestId: 'unknown-2' } };
async function forgedProbe(t, impl, names = Object.keys(FORGED)) {
  const f = grant(t), h = await harness(f, { impl });
  assert.equal(await h.send('alpha', 'unknown-1', OLD), 'outcome_unknown');
  reconcile(f, 'alpha', 'unknown-1');
  const genuine = readJson(f.ledgerFile), entry = genuine.entries[0], held = {};
  // A variant that wrongly passes gets a receipt, so it cannot add a second
  // unknown that would mask the remaining variants.
  h.setReply(receipt);
  for (const name of names) {
    const change = FORGED[name] ?? { [name]: entry[name] + 1 };
    fs.writeFileSync(f.ledgerFile, JSON.stringify({ ...genuine, entries: [{ ...entry, ...change }] }));
    const calls = h.calls.length;
    held[name] = await h.send('alpha', `forged-${name}`) === 'outcome_unknown' && h.calls.length === calls;
  }
  return { f, h, genuine, held };
}
async function inFlightProbe(t, impl) {
  const f = grant(t), h = await harness(f, { impl }), pending = Promise.withResolvers();
  h.setReply(() => pending.promise);
  let held;
  try {
    assert.equal(await h.send('alpha', 'unknown-1', OLD), 'outcome_unknown'); // observation timeout only
    assert.equal(inspect(f).outbound.counts.outcome_unknown, 1);
    reconcile(f, 'alpha', 'unknown-1');
    h.setReply(receipt);
    held = await h.send('alpha', 'fresh-1', NEW) === 'outcome_unknown' && h.calls.length === 1;
  } finally { pending.resolve(lost()); }
  return { f, h, held };
}
async function unreadableProbe(t, impl) {
  const f = grant(t), h = await harness(f, { impl });
  assert.equal(await h.send('alpha', 'unknown-1', OLD), 'outcome_unknown');
  reconcile(f, 'alpha', 'unknown-1');
  const genuine = fs.readFileSync(f.ledgerFile, 'utf8');
  fs.writeFileSync(f.ledgerFile, '{');
  h.setReply(receipt);
  const held = await h.send('alpha', 'fresh-1', NEW) === 'outcome_unknown' && h.calls.length === 1;
  return { f, h, genuine, held };
}

test('(a) an unreconciled unknown blocks every new request ID; a bridge without the ledger path keeps legacy quarantine', async t => {
  const { f, h, held } = await unreconciledProbe(t);
  assert.equal(held, true);
  assert.equal(fs.existsSync(f.ledgerFile), false);
  assert.deepEqual([inspect(f).quarantine, inspect(f).reconciliation.unreconciled], ['outcome_unknown', 1]);
  reconcile(f, 'alpha', 'unknown-1');
  await h.bridge.close();
  const legacy = await harness(f, { ledger: false });
  legacy.setReply(receipt);
  assert.equal(await legacy.send('alpha', 'fresh-2', NEW), 'outcome_unknown');
  assert.equal(legacy.calls.length, 0, 'a bridge built without the ledger path never releases');
  await legacy.bridge.close();
  const restarted = await harness(f);
  restarted.setReply(receipt);
  assert.equal(await restarted.send('alpha', 'unknown-1', OLD), 'outcome_unknown');
  assert.equal(await restarted.send('alpha', 'fresh-2', NEW), 'sent');
  assert.deepEqual(restarted.calls.map(([body, uid]) => [body.msg, uid]), [[NEW, '200']]);
});

test('(b) operator reconcile reopens the channel for a new ID through the production entry, without resend, journal edit or generation change', async t => {
  const r = await releaseProbe(t);
  assert.equal(r.released, true);
  const { f, h } = r;
  assert.deepEqual(h.calls.map(([body, uid]) => [body.msg, uid]), [[OLD, '200'], [NEW, '200']]);
  assert.ok(r.before.journal.equals(r.journalAfterReconcile), 'reconcile itself never writes the journal');
  assert.equal(await h.send('alpha', 'fresh-1', NEW), 'sent');
  assert.equal(await h.send('alpha', 'unknown-1', OLD), 'outcome_unknown');
  assert.equal(h.calls.length, 2, 'neither the reconciled unknown nor a repeated new ID is sent again');
  const journal = readJson(r.journalFile);
  assert.deepEqual(journal.outbound['unknown-1'], r.before.record);
  assert.deepEqual([journal.outbound['unknown-1'].status, journal.outbound['unknown-1'].digest], ['outcome_unknown', nativeDigest(OLD)]);
  assert.equal(journal.outbound['fresh-1'].status, 'sent');
  assert.equal(Object.hasOwn(journal.outbound, 'blocked-1'), false, 'a quarantined request is never admitted');
  assert.ok(fs.readFileSync(f.configFile).equals(r.before.config));
  assert.equal(readNativeConfig(f.configFile).channels[0].generation, r.before.generation);
  const inspected = inspect(f);
  assert.equal(inspected.quarantine, 'released_by_reconciliation');
  assert.deepEqual(inspected.reconciliation, { recorded: 1, unreconciled: 0, quarantineRelease: 'worker_reads_ledger_before_each_new_send' });
  assert.deepEqual(ledgerFaults(h.faults), []);
});

test('(c) an entry differing in digest, start time, generation, profile, account or request ID never releases', async t => {
  const { f, h, genuine, held } = await forgedProbe(t);
  assert.deepEqual(held, Object.fromEntries(Object.keys(FORGED).map(name => [name, true])));
  assert.equal(h.calls.length, 1);
  fs.writeFileSync(f.ledgerFile, JSON.stringify(genuine));
  assert.equal(await h.send('alpha', 'after-genuine', NEW), 'sent', 'the genuine entry releases (fixture is not vacuous)');
  assert.deepEqual(ledgerFaults(h.faults), []);
});

test('(d) corrupt, schema-invalid, oversized or hardlinked ledgers fail closed with a redacted fault', async t => {
  const { f, h, genuine, held } = await unreadableProbe(t);
  assert.equal(held, true);
  const value = JSON.parse(genuine);
  for (const [label, bytes] of [
    ['extra-key', JSON.stringify({ ...value, entries: [{ ...value.entries[0], resend: true }] })],
    ['duplicate', JSON.stringify({ ...value, entries: [value.entries[0], value.entries[0]] })],
    ['wrong-version', JSON.stringify({ ...value, version: 2 })],
    ['oversized', genuine + ' '.repeat(NATIVE_RECONCILIATION_MAX_BYTES)],
  ]) { fs.writeFileSync(f.ledgerFile, bytes); await blocked(h, label); }
  fs.writeFileSync(f.ledgerFile, genuine);
  const hardlink = path.join(f.root, 'ledger-hardlink.json');
  fs.linkSync(f.ledgerFile, hardlink);
  await blocked(h, 'hardlink');
  fs.unlinkSync(hardlink);
  assert.equal(ledgerFaults(h.faults).length, 6);
  assert.ok(ledgerFaults(h.faults).every(code => code === 'native_reconciliation_unreadable'));
  assert.equal(await h.send('alpha', 'after-repair', NEW), 'sent');
  assert.equal(inspect(f).quarantine, 'released_by_reconciliation');
});

test('(d) Linux: unsafe ledger mode, config directory mode or a symlinked ledger fail closed',
  { skip: process.platform === 'win32' && 'Windows does not attest Linux owner/mode/symlink guards' }, async t => {
    const f = grant(t), h = await harness(f);
    assert.equal(await h.send('alpha', 'unknown-1', OLD), 'outcome_unknown');
    reconcile(f, 'alpha', 'unknown-1');
    h.setReply(receipt);
    fs.chmodSync(f.ledgerFile, 0o640); await blocked(h, 'ledger-mode'); fs.chmodSync(f.ledgerFile, 0o600);
    fs.chmodSync(f.root, 0o750); await blocked(h, 'directory-mode'); fs.chmodSync(f.root, 0o700);
    const target = path.join(f.root, 'ledger-target.json');
    fs.renameSync(f.ledgerFile, target); fs.symlinkSync(target, f.ledgerFile);
    await blocked(h, 'symlink');
    fs.unlinkSync(f.ledgerFile); fs.renameSync(target, f.ledgerFile);
    assert.deepEqual(ledgerFaults(h.faults), Array(3).fill('native_reconciliation_unreadable'));
    assert.equal(await h.send('alpha', 'after-repair', NEW), 'sent');
  });

test('(e) two unknowns with only one reconciled stay quarantined until both have decisions', async t => {
  const f = grant(t), h = await harness(f);
  assert.equal(await h.send('alpha', 'unknown-1', OLD), 'outcome_unknown');
  reconcile(f, 'alpha', 'unknown-1');
  assert.equal(await h.send('alpha', 'unknown-2', 'Tin thứ hai cũng mất xác nhận'), 'outcome_unknown');
  assert.equal(h.calls.length, 2, 'the first decision admitted unknown-2 exactly once');
  h.setReply(receipt);
  await blocked(h, 'one-of-two');
  const half = inspect(f);
  assert.deepEqual([half.quarantine, half.reconciliation.recorded, half.reconciliation.unreconciled], ['outcome_unknown', 1, 1]);
  reconcile(f, 'alpha', 'unknown-2', 'sent');
  assert.equal(await h.send('alpha', 'fresh-3', NEW), 'sent');
  assert.equal(h.calls.length, 3);
  assert.deepEqual([inspect(f).quarantine, inspect(f).reconciliation.recorded], ['released_by_reconciliation', 2]);
});

test('(f) a decision recorded for another profile never opens this channel, even for the same request ID and text', async t => {
  const f = grant(t, { profiles: [['alpha', '200'], ['beta', '300']] }), h = await harness(f);
  assert.equal(await h.send('alpha', 'unknown-1', OLD), 'outcome_unknown');
  assert.equal(await h.send('beta', 'unknown-1', OLD), 'outcome_unknown');
  reconcile(f, 'beta', 'unknown-1');
  h.setReply(receipt);
  assert.equal(await h.send('alpha', 'fresh-1', NEW), 'outcome_unknown');
  assert.equal(await h.send('beta', 'fresh-1', NEW), 'sent');
  assert.deepEqual(h.calls.map(([, uid]) => uid), ['200', '300', '300']);
  assert.deepEqual([inspect(f, 'alpha').quarantine, inspect(f, 'beta').quarantine], ['outcome_unknown', 'released_by_reconciliation']);
});

test('(g) a decision recorded while this worker still awaits that provider call holds until the call settles', async t => {
  const { h, held } = await inFlightProbe(t);
  assert.equal(held, true);
  await tick(); await tick();
  assert.equal(await h.send('alpha', 'fresh-1', NEW), 'sent');
  assert.deepEqual(h.calls.map(([body]) => body.msg), [OLD, NEW]);
});

// Mutation evidence: each mutant removes one guard from a copy of the shipped
// modules; the same probe the original passes must then fail.
const libDir = fileURLToPath(new URL('../../worker/lib/', import.meta.url));
const COPIED = ['hermes-native-bridge.js', 'hermes-native-reconciliation.js'];
async function loadMutant(t, patches) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mutant-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  for (const name of COPIED) {
    let source = fs.readFileSync(path.join(libDir, name), 'utf8');
    for (const [, from, to] of patches.filter(([file]) => file === name)) {
      assert.equal(source.split(from).length, 2, `mutation anchor must occur exactly once: ${from}`);
      source = source.replace(from, () => to);
    }
    source = source.replace(/from '\.\/([\w.-]+\.js)'/g, (match, dep) =>
      COPIED.includes(dep) ? match : `from '${pathToFileURL(path.join(libDir, dep)).href}'`);
    fs.writeFileSync(path.join(dir, name), source);
  }
  return import(pathToFileURL(path.join(dir, 'hermes-native-bridge.js')).href);
}
const BRIDGE = 'hermes-native-bridge.js', MATCHER = 'hermes-native-reconciliation.js';
const MUTATIONS = [
  { name: 'bridge ignores ledger contents (absent or any readable ledger releases)',
    patches: [[BRIDGE, 'return unknown.every(record => nativeReconciliationFor(entries, channel, record) !== null);', 'return true;']],
    probe: async (t, impl) => (await unreconciledProbe(t, impl)).held },
  { name: 'bridge never consults the ledger (legacy permanent quarantine)',
    patches: [[BRIDGE, 'if (unknown.length && !reconciled(entry, unknown))', 'if (unknown.length)']],
    probe: async (t, impl) => (await releaseProbe(t, impl)).released },
  { name: 'production entry omits the ledger path',
    patches: [[BRIDGE, 'createNativeBridge({ config, onFault, reconciliationFile: nativeReconciliationFile(configFile) })', 'createNativeBridge({ config, onFault })']],
    probe: async (t, impl) => (await releaseProbe(t, impl)).released },
  { name: 'unreadable ledger treated as released',
    patches: [[BRIDGE, "catch { onFault('native_reconciliation_unreadable'); return false; }", "catch { onFault('native_reconciliation_unreadable'); return true; }"]],
    probe: async (t, impl) => (await unreadableProbe(t, impl)).held },
  { name: 'no in-process hold while the provider call is pending',
    patches: [[BRIDGE, 'unknown.some(record => pending.has(record.id))', 'false']],
    probe: async (t, impl) => (await inFlightProbe(t, impl)).held },
  ...['recordDigest', 'startedAt', 'generation', 'profile'].map(field => ({
    name: `matcher drops ${field}`,
    patches: [[MATCHER, { recordDigest: 'entry.recordDigest === record.digest && ', startedAt: ' && entry.startedAt === record.startedAt',
      generation: 'entry.generation === channel.generation && ', profile: 'entry.profile === channel.profile && ' }[field], '']],
    probe: async (t, impl) => (await forgedProbe(t, impl, [field])).held[field] })),
];
for (const mutation of MUTATIONS) {
  test(`mutation: ${mutation.name}`, async t => {
    await t.test('original code holds the guard', async t => { assert.equal(await mutation.probe(t, original), true); });
    await t.test('mutant breaks the same probe (test is not vacuous)', async t => {
      assert.equal(await mutation.probe(t, await loadMutant(t, mutation.patches)), false);
    });
  });
}
