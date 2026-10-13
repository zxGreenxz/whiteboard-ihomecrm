import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createConnectionHandoff, createHandoffCipher } from './connection-handoff.mjs';

const linux = process.platform === 'linux';
const IDS = ['connectionId', 'assistantId', 'userId', 'organizationId', 'operationId'];
const key = Buffer.alloc(32, 39), keys = new Map([['one', key]]);
const make = () => Object.fromEntries([...IDS.map(name => [name, randomUUID()]), ['token', `hc_${randomBytes(32).toString('base64url')}`]]);
const options = (directory, extra = {}) => ({ directory, activeKeyVersion: 'one', keys, ...extra });
const cipher = extra => createHandoffCipher({ activeKeyVersion: 'one', keys, ...extra });
const checkError = (code, forbidden = []) => error => {
  assert.equal(error.name, 'ConnectionHandoffError'); assert.equal(error.code, code); assert.equal(error.message, code);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  for (const text of forbidden) assert.equal(JSON.stringify(error).includes(text), false);
  return true;
};
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-handoff-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}
function store(t, root, extra) { const result = createConnectionHandoff(options(root, extra)); t.after(() => result.close()); return result; }
function encoded(value) { return JSON.stringify(value) + '\n'; }

test('dedicated handoff cipher encrypts only token and authenticates all five canonical identities', () => {
  const crypto = cipher(), data = make();
  try {
    const first = crypto.seal(data), second = crypto.seal(data);
    assert.deepEqual(crypto.open(first), data); assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.binding)); assert.ok(Object.isFrozen(crypto.open(first)));
    assert.notEqual(first.nonce, second.nonce); assert.notEqual(first.ciphertext, second.ciphertext);
    assert.equal(JSON.stringify(first).includes(data.token), false); assert.equal(Buffer.from(first.ciphertext, 'base64url').length, 46);
    for (const id of IDS) assert.throws(() => crypto.open({ ...first, binding: { ...first.binding, [id]: randomUUID() } }), checkError('handoff_ciphertext_invalid', [data.token]));
  } finally { crypto.destroy(); }
});

test('handoff rejects raw/session-domain AES material even with the same supplied key', () => {
  const crypto = cipher(), data = make(), nonce = randomBytes(12), current = crypto.seal(data);
  try {
    for (const domain of ['ihomecrm/hermes/user-session:v1', 'ihomecrm/hermes/host-connection-handoff:v1']) {
      const wrong = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      wrong.setAAD(Buffer.from(JSON.stringify([domain, 1, 'A256GCM', 'one', ...IDS.map(id => data[id])])));
      const ciphertext = Buffer.concat([wrong.update(data.token), wrong.final()]);
      assert.throws(() => crypto.open({ ...current, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: wrong.getAuthTag().toString('base64url') }), checkError('handoff_ciphertext_invalid'));
    }
  } finally { crypto.destroy(); }
});

test('bounded rotation preserves old immutable envelopes and rejects missing or renamed versions', () => {
  const old = cipher(), data = make(), sealed = old.seal(data), nextKey = Buffer.alloc(32, 42);
  const next = cipher({ activeKeyVersion: 'two', keys: new Map([['one', key], ['two', nextKey]]) });
  const retired = cipher({ activeKeyVersion: 'two', keys: new Map([['two', nextKey]]) });
  const renamed = cipher({ activeKeyVersion: 'two', keys: new Map([['two', key]]) });
  try {
    assert.deepEqual(next.open(sealed), data); assert.equal(next.seal(data).keyVersion, 'two');
    assert.throws(() => retired.open(sealed), checkError('handoff_key_unavailable'));
    assert.throws(() => renamed.open({ ...sealed, keyVersion: 'two' }), checkError('handoff_ciphertext_invalid'));
    assert.throws(() => cipher({ keys: new Map(Array.from({ length: 17 }, (_, i) => [String(i), key])), activeKeyVersion: '0' }), checkError('handoff_config_invalid'));
  } finally { old.destroy(); next.destroy(); retired.destroy(); renamed.destroy(); }
});

test('cipher copies injected keys, validates them with native Map methods and zeroes only owned keys', () => {
  const supplied = Buffer.alloc(32, 8), ring = new Map([['one', supplied]]);
  Object.defineProperty(ring, 'size', { get() { throw new Error('not read'); } });
  const crypto = cipher({ keys: ring }), data = make(), sealed = crypto.seal(data);
  supplied.fill(9); ring.clear(); assert.deepEqual(crypto.open(sealed), data);
  crypto.destroy(); crypto.destroy(); assert.ok(supplied.every(byte => byte === 9));
  assert.throws(() => crypto.open(sealed), checkError('handoff_key_unavailable'));
  assert.throws(() => crypto.seal(data), checkError('handoff_key_unavailable'));
  for (const bad of [new Map(), new Map([['one', Buffer.alloc(31)]]), { one: key }]) assert.throws(() => cipher({ keys: bad }), checkError('handoff_config_invalid'));
});

test('cipher snapshots exact own data and refuses getters, symbols, prototypes and noncanonical IDs', () => {
  const crypto = cipher(), data = make(); let reads = 0;
  try {
    const getter = { ...data }; Object.defineProperty(getter, 'token', { get() { reads++; return data.token; } });
    for (const bad of [getter, { ...data, extra: 1 }, { ...data, [Symbol('x')]: 1 }, Object.assign(Object.create(data), data),
      { ...data, connectionId: data.connectionId.toUpperCase() }, { ...data, token: 'hc_short' }]) assert.throws(() => crypto.seal(bad), checkError('handoff_record_invalid'));
    const sealed = crypto.seal(data), envelopeGetter = { ...sealed }; Object.defineProperty(envelopeGetter, 'tag', { get() { reads++; return sealed.tag; } });
    assert.throws(() => crypto.open(envelopeGetter), checkError('handoff_ciphertext_invalid')); assert.equal(reads, 0);
    data.token = `hc_${'A'.repeat(43)}`; assert.notEqual(crypto.open(sealed).token, data.token);
  } finally { crypto.destroy(); }
});

test('cipher fails closed for tamper, foreign fields, truncated/noncanonical bytes and oversized input', () => {
  const crypto = cipher(), sealed = crypto.seal(make());
  try {
    for (const field of ['nonce', 'tag', 'ciphertext']) {
      const changed = sealed[field][0] === 'A' ? 'B' : 'A';
      for (const bad of [sealed[field] + '=', sealed[field].slice(1), changed + sealed[field].slice(1), 'x'.repeat(10_000)]) {
        assert.throws(() => crypto.open({ ...sealed, [field]: bad }), checkError('handoff_ciphertext_invalid'));
      }
    }
    for (const bad of [{ ...sealed, v: 2 }, { ...sealed, algorithm: 'none' }, { ...sealed, plaintext: 'secret' }, { ...sealed, binding: { ...sealed.binding, token: 'secret' } }]) assert.throws(() => crypto.open(bad), checkError('handoff_ciphertext_invalid'));
  } finally { crypto.destroy(); }
});

test('factory is inert; validation and pre-abort leave a missing directory untouched', async t => {
  const parent = await directory(t), missing = path.join(parent, 'missing'), wal = store(t, missing), controller = new AbortController();
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
  controller.abort(); await assert.rejects(wal.stage(make(), { signal: controller.signal }), checkError('handoff_cancelled'));
  await assert.rejects(wal.list({ signal: controller.signal }), checkError('handoff_cancelled'));
  await assert.rejects(wal.stage({ ...make(), forgedUser: randomUUID() }), checkError('handoff_record_invalid'));
  await assert.rejects(wal.list({ signal: {} }), checkError('handoff_options_invalid'));
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
  assert.throws(() => createConnectionHandoff(options('relative')), checkError('handoff_config_invalid'));
  assert.throws(() => createConnectionHandoff(options(missing, { maxRecords: 257 })), checkError('handoff_config_invalid'));
});

test('requests/options reject accessors before any await and never expose token or path in errors', async t => {
  const root = await directory(t), wal = store(t, path.join(root, 'missing')), data = make(); let calls = 0;
  const opts = {}; Object.defineProperty(opts, 'signal', { get() { calls++; throw new Error(data.token); } });
  await assert.rejects(wal.stage(data, opts), checkError('handoff_options_invalid', [data.token, root]));
  const malicious = { ...data }; Object.defineProperty(malicious, 'token', { get() { calls++; throw new Error(data.token); } });
  await assert.rejects(wal.stage(malicious), checkError('handoff_record_invalid', [data.token, root]));
  await assert.rejects(wal.stage(data), checkError('handoff_unavailable', [data.token, root])); assert.equal(calls, 0);
});

test('queue has a finite cap and close waits all accepted operations, rejects future work, stays idempotent', async t => {
  const root = await directory(t), wal = store(t, path.join(root, 'missing'));
  const work = Array.from({ length: 16 }, () => wal.list());
  const settled = Promise.allSettled(work); await assert.rejects(wal.list(), checkError('handoff_busy'));
  const close = wal.close(); assert.equal(wal.close(), close);
  await assert.rejects(wal.list(), checkError('handoff_closed')); await assert.rejects(wal.stage(make()), checkError('handoff_closed'));
  await close; assert.ok((await settled).every(item => item.status === 'rejected' && item.reason.code === 'handoff_unavailable'));
});

test('Windows refuses unsupported native directory durability without a stored acknowledgement', { skip: process.platform !== 'win32' }, async t => {
  const root = await directory(t), wal = store(t, root), data = make();
  await assert.rejects(wal.stage(data), checkError('handoff_unavailable', [root, data.token]));
  assert.deepEqual(await readdir(root), []);
});

test('Linux native stage is durable-before-ack, encrypted, private, immutable and exact-idempotent', { skip: !linux }, async t => {
  const root = await directory(t), wal = store(t, root), data = make(), filename = path.join(root, `${data.connectionId}.handoff.json`);
  const response = await wal.stage(data); assert.deepEqual(response, { status: 'stored', connectionId: data.connectionId, operationId: data.operationId }); assert.ok(Object.isFrozen(response));
  const bytes = await readFile(filename, 'utf8'); assert.equal(bytes.includes(data.token), false); assert.equal((await lstat(filename)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(root), [`${data.connectionId}.handoff.json`]);
  assert.deepEqual(await wal.stage(data), response); assert.equal(await readFile(filename, 'utf8'), bytes);
  const found = await wal.list(); assert.deepEqual(found, [data]); assert.ok(Object.isFrozen(found)); assert.ok(Object.isFrozen(found[0]));
  await wal.close(); const restarted = store(t, root); assert.deepEqual(await restarted.list(), [data]);
});

test('Linux conflicting connection, owner, token or operation cannot replace an immutable record', { skip: !linux }, async t => {
  const root = await directory(t), wal = store(t, root), data = make(); await wal.stage(data);
  const filename = path.join(root, `${data.connectionId}.handoff.json`), original = await readFile(filename, 'utf8');
  for (const id of [...IDS, 'token']) {
    const altered = { ...data, [id]: id === 'token' ? make().token : randomUUID() };
    await assert.rejects(wal.stage(altered), checkError('handoff_conflict', [root, data.token]));
  }
  assert.equal(await readFile(filename, 'utf8'), original); assert.deepEqual(await wal.list(), [data]);
});

test('Linux source snapshot precedes queue awaits and a directory has only one owner per process', { skip: !linux }, async t => {
  const root = await directory(t), wal = store(t, root), another = store(t, root), data = make(), expected = { ...data };
  const staged = wal.stage(data); data.token = make().token; data.userId = randomUUID(); await staged;
  assert.deepEqual(await wal.list(), [expected]); await assert.rejects(another.list(), checkError('handoff_directory_in_use'));
  await wal.close(); assert.deepEqual(await another.list(), [expected]);
});

test('Linux retained partial pending files stay private, unreturned and count against capacity', { skip: !linux }, async t => {
  const root = await directory(t), pending = `.handoff-${randomUUID()}.pending`, wal = store(t, root, { maxRecords: 1 });
  await writeFile(path.join(root, pending), '{partial encrypted', { mode: 0o600 });
  assert.deepEqual(await wal.list(), []); await assert.rejects(wal.stage(make()), checkError('handoff_capacity'));
  assert.equal(await readFile(path.join(root, pending), 'utf8'), '{partial encrypted');
});

test('Linux maxRecords bounds stage and list without evicting or deleting old connections', { skip: !linux }, async t => {
  const root = await directory(t), wal = store(t, root, { maxRecords: 1 }), first = make();
  await wal.stage(first); await assert.rejects(wal.stage(make()), checkError('handoff_capacity')); await wal.stage(first);
  assert.deepEqual(await wal.list(), [first]); assert.equal((await readdir(root)).length, 1);
});

test('Linux list rejects any corrupt, duplicated-key, foreign, oversized or wrong-key committed file as a whole', { skip: !linux }, async t => {
  const root = await directory(t), wal = store(t, root), one = make(), two = make(); await wal.stage(one); await wal.stage(two);
  const filename = path.join(root, `${two.connectionId}.handoff.json`), original = await readFile(filename, 'utf8'), parsed = JSON.parse(original);
  for (const bytes of [original.slice(0, -8), original.replace('"v":1', '"v":1,"v":1'), 'x'.repeat(2049),
    encoded({ ...parsed, binding: { ...parsed.binding, connectionId: one.connectionId } }), encoded({ ...parsed, keyVersion: 'absent' })]) {
    await writeFile(filename, bytes); await assert.rejects(wal.list(), error => ['handoff_ciphertext_invalid', 'handoff_path_refused', 'handoff_key_unavailable'].includes(error.code));
  }
  await writeFile(filename, original); assert.equal((await wal.list()).length, 2);
  const third = make(), crypto = cipher(); await writeFile(path.join(root, `${third.connectionId}.handoff.json`), encoded(crypto.seal({ ...third, operationId: one.operationId })), { mode: 0o600 }); crypto.destroy();
  await assert.rejects(wal.list(), checkError('handoff_conflict'));
});

test('Linux key rotation reads immutable old files; retirement fails without a plaintext fallback', { skip: !linux }, async t => {
  const root = await directory(t), first = store(t, root), data = make(); await first.stage(data); await first.close();
  const filename = path.join(root, `${data.connectionId}.handoff.json`), original = await readFile(filename, 'utf8');
  const rotated = store(t, root, { activeKeyVersion: 'two', keys: new Map([['one', key], ['two', Buffer.alloc(32, 2)]]) });
  assert.deepEqual(await rotated.list(), [data]); await rotated.stage(data); assert.equal(await readFile(filename, 'utf8'), original); await rotated.close();
  const retired = store(t, root, { activeKeyVersion: 'two', keys: new Map([['two', Buffer.alloc(32, 2)]]) });
  await assert.rejects(retired.list(), checkError('handoff_key_unavailable'));
});

test('Linux permissions, symlinks, noncanonical directory and unexpected files fail closed', { skip: !linux }, async t => {
  const root = await directory(t), wal = store(t, root), data = make();
  await chmod(root, 0o750); await assert.rejects(wal.stage(data), checkError('handoff_path_refused')); await chmod(root, 0o700);
  const foreign = path.join(root, 'foreign'); await writeFile(foreign, 'anything', { mode: 0o600 }); await assert.rejects(wal.list(), checkError('handoff_path_refused')); await rm(foreign);
  await wal.stage(data); const filename = path.join(root, `${data.connectionId}.handoff.json`); await chmod(filename, 0o640); await assert.rejects(wal.list(), checkError('handoff_path_refused')); await chmod(filename, 0o600);
  const sibling = await directory(t), alias = path.join(sibling, 'alias'); await symlink(root, alias, 'dir'); const linked = store(t, alias); await assert.rejects(linked.list(), checkError('handoff_path_refused'));
  const renamed = path.join(sibling, 'held'); await writeFile(renamed, await readFile(filename), { mode: 0o600 }); await rm(filename); await symlink(renamed, filename);
  await assert.rejects(wal.list(), checkError('handoff_path_refused'));
});

// Fault tests use Node's test-only module seam in a separate child. Files and
// hard-link publication are native. Windows directory handles alone are fake;
// this tests protocol/lifetime, NOT Linux fsync durability or permissions.
test('publication fault seam retains encrypted WAL and close waits actual file IO (synthetic directory sync on Windows)', async t => {
  const root = await directory(t), moduleUrl = pathToFileURL(path.resolve('infra/hermes-broker/connection-handoff.mjs')).href;
  const source = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import * as fs from 'node:fs/promises';
    const native = {...fs}, root = ${JSON.stringify(root)};
    let resolveHeld, release, waiting = new Promise(r => resolveHeld = r), hold = new Promise(r => release = r);
    let mode = 'hold', directorySyncs = 0; const events=[];
    mock.module('node:fs/promises', { exports: {...native, open: async (...args) => {
      const fakeDirectory=process.platform==='win32' && args[0]===root;
      const file = fakeDirectory ? {stat:()=>native.stat(root),sync:async()=>{},close:async()=>{}} : await native.open(...args);
      const sync = file.sync.bind(file);
      file.sync = async () => {
        if (args[0] === root) { events.push('directory-sync'); directorySyncs++; if (mode === 'fail-directory' && directorySyncs === 2) throw new Error('private OS detail'); }
        await sync();
        if(String(args[0]).endsWith('.pending'))events.push('file-sync');
        if (String(args[0]).endsWith('.pending') && mode === 'hold') { resolveHeld(); await hold; }
      }; return file;
    },link:async(...args)=>{events.push('publish');return native.link(...args)},unlink:async(...args)=>{events.push('unlink');return native.unlink(...args)}}});
    const {createConnectionHandoff} = await import(${JSON.stringify(moduleUrl)});
    const opts = {directory:root, activeKeyVersion:'one', keys:new Map([['one',Buffer.alloc(32,39)]])};
    const first = createConnectionHandoff(opts), controller = new AbortController(), record = ${JSON.stringify(make())};
    let stageSettled = false, closeSettled = false;
    const staged = first.stage(record,{signal:controller.signal}); staged.then(()=>stageSettled=true,()=>stageSettled=true);
    await waiting; controller.abort(); const closed = first.close(); closed.then(()=>closeSettled=true);
    await new Promise(r=>setImmediate(r)); assert.equal(stageSettled,false); assert.equal(closeSettled,false);
    release(); await assert.rejects(staged,{code:'handoff_outcome_unknown'}); await closed;
    const retained = await native.readdir(root); assert.equal(retained.length,1); assert.ok(retained[0].endsWith('.pending'));
    const bytes = await native.readFile(root+'/'+retained[0],'utf8'); assert.equal(bytes.includes(record.token),false);
    mode='fail-directory'; directorySyncs=0; const second=createConnectionHandoff(opts), next=${JSON.stringify(make())};
    await assert.rejects(second.stage(next),{code:'handoff_outcome_unknown'});
    const final=root+'/'+next.connectionId+'.handoff.json'; assert.ok((await native.stat(final)).isFile());
    assert.deepEqual(await second.list(),[next]); await second.close();
    mode='normal'; directorySyncs=0; events.length=0; const third=createConnectionHandoff(opts), valid=${JSON.stringify(make())};
    const snapshot={...valid}, write=third.stage(valid); valid.token=${JSON.stringify(make().token)}; await write;
    assert.deepEqual(events,['directory-sync','file-sync','publish','directory-sync','unlink','directory-sync']);
    assert.equal((await third.list()).find(r=>r.connectionId===snapshot.connectionId).token,snapshot.token);
    const finalBytes=await native.readFile(root+'/'+snapshot.connectionId+'.handoff.json','utf8');
    await third.stage(snapshot); assert.equal(await native.readFile(root+'/'+snapshot.connectionId+'.handoff.json','utf8'),finalBytes);
    await assert.rejects(third.stage({...snapshot,token:valid.token}),{code:'handoff_conflict'});
    await assert.rejects(third.stage({...snapshot,connectionId:${JSON.stringify(randomUUID())}}),{code:'handoff_conflict'});
    const unknown=(await native.readdir(root)).find(name=>name.endsWith('.pending')); assert.ok(unknown);
    await native.writeFile(root+'/'+snapshot.connectionId+'.handoff.json',finalBytes.replace('"v":1','"v":1,"v":1'));
    await assert.rejects(third.list(),{code:'handoff_ciphertext_invalid'}); await third.close();
  `;
  const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.error, undefined);
});
