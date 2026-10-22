import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireHostOwnership, createHostAudit } from './host-ownership.mjs';

const EVENT = { requestId: '10000000-0000-4000-8000-000000000001', operation: 'tools/call',
  connectionId: '20000000-0000-4000-8000-000000000002', outcome: 'prepared' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const pause = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, { native = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-host-')));
  await fs.chmod(root, 0o700);
  t.after(async () => { t.mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); });
  // Windows cannot open/fsync a directory. This shim lets logical queue/tamper
  // cases exercise real files locally; native directory durability is Linux-only.
  if (!native && process.platform === 'win32') {
    const open = fs.open.bind(fs);
    t.mock.method(fs, 'open', async (name, flags, mode) => {
      const info = await fs.lstat(name).catch(() => null);
      if (info?.isDirectory() && flags === (constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))) {
        return { stat: () => fs.lstat(name), sync: async () => {}, close: async () => {} };
      }
      return open(name, flags, mode);
    });
  }
  return root;
}
function wrapOpen(t, wrap) {
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args) => wrap(await open(...args), args));
}

test('ownership is exclusive, keeps a crash marker, and releases only its held lock', async t => {
  const root = await fixture(t), lock = await acquireHostOwnership({ stateRoot: root });
  assert.deepEqual(Object.keys(lock), ['release']); assert.ok(Object.isFrozen(lock));
  const filename = path.join(root, '.hermes-host.lock'), value = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.deepEqual(Object.keys(value), ['version', 'lockId']); assert.equal(value.version, 1);
  await assert.rejects(acquireHostOwnership({ stateRoot: root }), /host_already_owned/);
  const release = lock.release(); assert.equal(lock.release(), release); await release;
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
  const next = await acquireHostOwnership({ stateRoot: root }); await next.release();
  await fs.writeFile(filename, JSON.stringify({ pid: 0, expiresAt: 1 }) + '\n', { mode: 0o600 });
  await assert.rejects(acquireHostOwnership({ stateRoot: root }), /host_already_owned/);
  assert.match(await fs.readFile(filename, 'utf8'), /"pid":0/);
});

test('racing acquisitions admit one writer and never replace the winner', async t => {
  const root = await fixture(t), attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireHostOwnership({ stateRoot: root })));
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(x => x.status === 'rejected' && x.reason.code === 'host_already_owned').length, 7);
  await attempts.find(x => x.status === 'fulfilled').value.release();
});

test('changed lock content or inode is retained and release is never retried', async t => {
  for (const replace of [false, true]) {
    const root = await fixture(t), lock = await acquireHostOwnership({ stateRoot: root }), filename = path.join(root, '.hermes-host.lock');
    const old = await fs.readFile(filename);
    if (replace) { await fs.rename(filename, filename + '.old'); await fs.writeFile(filename, old, { mode: 0o600 }); }
    else await fs.writeFile(filename, 'changed-owner\n');
    const result = lock.release(); await assert.rejects(result, /host_lock_retained/); assert.equal(lock.release(), result);
    assert.ok(await fs.stat(filename)); await assert.rejects(acquireHostOwnership({ stateRoot: root }), /host_already_owned/);
  }
});

test('unknown acquire sync failure leaves a crash lock rather than undoing possibly durable ownership', async t => {
  const root = await fixture(t); let calls = 0;
  wrapOpen(t, (handle, [name]) => {
    if (name.endsWith('.hermes-host.lock')) { handle.datasync = async () => { calls++; throw Error('PRIVATE_BACKEND_DETAIL'); }; }
    return handle;
  });
  await assert.rejects(acquireHostOwnership({ stateRoot: root }), error => error.code === 'host_ownership_unknown' && !error.message.includes('PRIVATE'));
  assert.equal(calls, 1); assert.ok(await fs.stat(path.join(root, '.hermes-host.lock')));
  await assert.rejects(acquireHostOwnership({ stateRoot: root }), /host_already_owned/);
});

test('lock replacement during its durability await cannot acknowledge host ownership', async t => {
  const root = await fixture(t), entered = deferred(), blocker = deferred();
  wrapOpen(t, (handle, [name]) => {
    if (name.endsWith('.hermes-host.lock')) { const sync = handle.datasync.bind(handle); handle.datasync = async () => { entered.resolve(); await blocker.promise; await sync(); }; }
    return handle;
  });
  const acquiring = acquireHostOwnership({ stateRoot: root }); await entered.promise;
  const filename = path.join(root, '.hermes-host.lock'), content = await fs.readFile(filename);
  await fs.rename(filename, filename + '.old'); await fs.writeFile(filename, content, { mode: 0o600 }); blocker.resolve();
  const [result] = await Promise.allSettled([acquiring]);
  if (result.status === 'fulfilled') await result.value.release().catch(() => {});
  assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'host_ownership_unknown');
  assert.deepEqual(await fs.readFile(filename), content);
});

test('root and lock symlinks are refused without mutating their targets', async t => {
  const root = await fixture(t), target = path.join(root, 'target'); await fs.mkdir(target, { mode: 0o700 });
  const redirect = path.join(root, 'redirect'); await fs.symlink(target, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(acquireHostOwnership({ stateRoot: redirect }), /host_path_refused/);
  assert.deepEqual(await fs.readdir(target), []);
  if (process.platform !== 'win32') {
    await fs.writeFile(path.join(root, 'foreign'), 'foreign', { mode: 0o600 });
    await fs.symlink(path.join(root, 'foreign'), path.join(root, '.hermes-host.lock'));
    await assert.rejects(acquireHostOwnership({ stateRoot: root }), /host_already_owned/);
    assert.equal(await fs.readFile(path.join(root, 'foreign'), 'utf8'), 'foreign');
  }
});

test('strict config and event snapshots never evaluate getters or persist extra data', async t => {
  const root = await fixture(t); let getters = 0;
  const config = {}; Object.defineProperty(config, 'stateRoot', { get() { getters++; return root; } });
  await assert.rejects(acquireHostOwnership(config), /host_invalid_data/);
  assert.throws(() => createHostAudit({ directory: root, secret: 'PRIVATE_TOKEN' }), /host_invalid_data/);
  const sink = createHostAudit({ directory: root }); assert.deepEqual(await fs.readdir(root), []);
  const getter = { ...EVENT }; Object.defineProperty(getter, 'operation', { get() { getters++; return 'tools/call'; } });
  for (const value of [getter, { ...EVENT, text: 'PRIVATE_MESSAGE' }, { ...EVENT, token: 'PRIVATE_TOKEN' },
    { ...EVENT, operation: 'model/complete' }, { ...EVENT, requestId: 'hc_' + 'x'.repeat(43) },
    { ...EVENT, outcome: 'prepared', code: 'timeout' }, { ...EVENT, connectionId: null },
    { ...EVENT, outcome: 'timeout', code: 'forbidden' }, { ...EVENT, outcome: 'denied', code: 'timeout' },
    { ...EVENT, outcome: 'denied', code: 'PRIVATE_PROVIDER_ERROR' }, { ...EVENT, [Symbol('extra')]: true }]) {
    await assert.rejects(sink.write(value), /host_audit_invalid/);
  }
  assert.equal(getters, 0); assert.deepEqual(await fs.readdir(root), []); await sink.close();
});

test('audit writes only the real broker protocol, snapshots callers and remains append-only on reopen', async t => {
  const root = await fixture(t), sink = createHostAudit({ directory: root });
  const mutable = { ...EVENT }, first = sink.write(mutable); mutable.requestId = 'PRIVATE_TOKEN'; await first;
  const denied = { ...EVENT, operation: 'authenticate', connectionId: null, outcome: 'denied', code: 'unauthorized' };
  const timeout = { ...EVENT, operation: 'tools/list', outcome: 'timeout', code: 'timeout' };
  // Rào chữ công khai: token xác nhận bị từ chối vẫn được ghi sổ với đúng mã (không thành backend_unavailable).
  const confirmation = { ...EVENT, outcome: 'denied', code: 'confirmation_invalid' };
  // Báo cáo vượt trần trang (PT413) giữ đúng mã để mô hình thu hẹp bộ lọc.
  const tooLarge = { ...EVENT, outcome: 'denied', code: 'result_too_large' };
  // Tên toà/phòng không giải được (B5d) giữ đúng mã để mô hình hỏi lại — không thành backend_unavailable.
  const unresolved = { ...EVENT, outcome: 'denied', code: 'read_name_unresolved' };
  await Promise.all([sink.write(denied), sink.write(timeout), sink.write(confirmation), sink.write(tooLarge), sink.write(unresolved)]); await sink.close();
  const filename = path.join(root, 'broker-audit.jsonl');
  const rows = (await fs.readFile(filename, 'utf8')).trim().split('\n').map(JSON.parse); assert.deepEqual(rows, [EVENT, denied, timeout, confirmation, tooLarge, unresolved]);
  const again = createHostAudit({ directory: root }); await again.write(EVENT); await again.close();
  assert.equal((await fs.readFile(filename, 'utf8')).trim().split('\n').length, 7);
});

test('group directory and preview audit operations retain the exact private host protocol', async t => {
  const root = await fixture(t), sink = createHostAudit({ directory: root });
  const events = ['private/group-directory', 'private/group-room-preview', 'private/group-room-send', 'private/group-send-status'].map(operation => ({ ...EVENT, operation }));
  events.push({ ...EVENT, operation: 'private/group-room-send', outcome: 'denied', code: 'send_outcome_unknown' });
  for (const code of ['group_recipient_limit', 'group_room_limit']) events.push({ ...EVENT, operation: 'private/group-room-send', outcome: 'denied', code });
  for (const event of events) await sink.write(event);
  for (const extra of ['claimId', 'token', 'body', 'sender', 'conversations'])
    await assert.rejects(sink.write({ ...events[0], [extra]: 'PRIVATE' }), /host_audit_invalid/);
  await assert.rejects(sink.write({ ...EVENT, operation: 'private/group-send' }), /host_audit_invalid/);
  await sink.close();
  const raw = await fs.readFile(path.join(root, 'broker-audit.jsonl'), 'utf8');
  assert.deepEqual(raw.trim().split('\n').map(JSON.parse), events); assert(!raw.includes('PRIVATE'));
});

test('pending fdatasync retains write and close, bounds queue at32, and rejects new writes immediately on close', async t => {
  const root = await fixture(t), blocker = deferred(), entered = deferred(); let syncs = 0, closes = 0;
  wrapOpen(t, (handle, [name]) => {
    if (name.endsWith('broker-audit.jsonl')) {
      const sync = handle.datasync.bind(handle), close = handle.close.bind(handle);
      handle.datasync = async () => { syncs++; if (syncs === 2) { entered.resolve(); await blocker.promise; } await sync(); };
      handle.close = async () => { closes++; await close(); };
    }
    return handle;
  });
  const sink = createHostAudit({ directory: root }); let finished = false;
  const first = sink.write(EVENT).then(() => { finished = true; }); await entered.promise;
  const queued = Array.from({ length: 31 }, () => sink.write(EVENT));
  let overflow = 'pending';
  const extra = sink.write(EVENT).then(() => { overflow = 'fulfilled'; }, error => { overflow = error.code; });
  await pause();
  if (overflow !== 'host_audit_busy') {
    blocker.resolve(); await Promise.allSettled([first, ...queued, extra]); await sink.close().catch(() => {});
    assert.equal(overflow, 'host_audit_busy');
  }
  let closed = false; const ending = sink.close().then(() => { closed = true; }); await pause();
  assert.equal(finished, false); assert.equal(closed, false); assert.equal(closes, 0);
  await assert.rejects(sink.write(EVENT), /host_audit_closed/);
  blocker.resolve(); await Promise.all([first, ...queued, ending]); assert.equal(closes, 1);
  assert.equal((await fs.readFile(path.join(root, 'broker-audit.jsonl'), 'utf8')).trim().split('\n').length, 32);
});

test('failed append synchronization is unknown, latches future writes and makes close fail without replay', async t => {
  const root = await fixture(t); let syncs = 0;
  wrapOpen(t, (handle, [name]) => {
    if (name.endsWith('broker-audit.jsonl')) {
      const sync = handle.datasync.bind(handle);
      handle.datasync = async () => { syncs++; if (syncs === 2) throw Error('PRIVATE_DB_DETAIL'); await sync(); };
    }
    return handle;
  });
  const sink = createHostAudit({ directory: root });
  await assert.rejects(sink.write(EVENT), /host_audit_unknown/); await assert.rejects(sink.write(EVENT), /host_audit_unknown/);
  const close = sink.close(); assert.equal(sink.close(), close); await assert.rejects(close, /host_audit_unknown/);
  assert.equal(syncs, 2); assert.equal((await fs.readFile(path.join(root, 'broker-audit.jsonl'), 'utf8')).trim().split('\n').length, 1);
});

test('audit replacement during fdatasync cannot acknowledge an unreachable appended receipt', async t => {
  const root = await fixture(t), entered = deferred(), blocker = deferred(); let calls = 0;
  wrapOpen(t, (handle, [name]) => {
    if (name.endsWith('broker-audit.jsonl')) { const sync = handle.datasync.bind(handle); handle.datasync = async () => { if (++calls === 2) { entered.resolve(); await blocker.promise; } await sync(); }; }
    return handle;
  });
  const sink = createHostAudit({ directory: root }), writing = sink.write(EVENT); await entered.promise;
  const filename = path.join(root, 'broker-audit.jsonl'); await fs.rename(filename, filename + '.old'); await fs.writeFile(filename, 'foreign\n', { mode: 0o600 }); blocker.resolve();
  await assert.rejects(writing, /host_audit_unknown/); await assert.rejects(sink.close(), /host_audit_unknown/);
  assert.equal(await fs.readFile(filename, 'utf8'), 'foreign\n');
});

test('audit rejects incomplete tails, oversized logs, and replacement while preserving the existing bytes', async t => {
  for (const scenario of ['tail', 'oversized', 'replace']) {
    const root = await fixture(t), filename = path.join(root, 'broker-audit.jsonl');
    if (scenario === 'tail') await fs.writeFile(filename, 'partial', { mode: 0o600 });
    if (scenario === 'oversized') { await fs.writeFile(filename, '', { mode: 0o600 }); await fs.truncate(filename, 16 * 1024 * 1024 + 1); }
    const sink = createHostAudit({ directory: root });
    if (scenario === 'replace') { await sink.write(EVENT); await fs.rename(filename, filename + '.old'); await fs.writeFile(filename, 'foreign\n', { mode: 0o600 }); }
    const before = await fs.readFile(filename);
    await assert.rejects(sink.write(EVENT), /host_audit_(incomplete|capacity|changed)/); await assert.rejects(sink.close());
    assert.deepEqual(await fs.readFile(filename), before);
  }
});

test('audit refuses a second process-local writer without disturbing the first sink', async t => {
  const root = await fixture(t), first = createHostAudit({ directory: root }), second = createHostAudit({ directory: root });
  await first.write(EVENT); await assert.rejects(second.write(EVENT), /host_audit_in_use/); await assert.rejects(second.close(), /host_audit_in_use/);
  await first.write(EVENT); await first.close();
  const third = createHostAudit({ directory: root }); await third.write(EVENT); await third.close();
});

test('native Linux ownership and audit require private modes and reject hardlinks', { skip: process.platform !== 'linux' }, async t => {
  const root = await fixture(t, { native: true }); await fs.chmod(root, 0o755);
  await assert.rejects(acquireHostOwnership({ stateRoot: root }), /host_path_refused/); await fs.chmod(root, 0o700);
  const lock = await acquireHostOwnership({ stateRoot: root }); assert.equal((await fs.stat(path.join(root, '.hermes-host.lock'))).mode & 0o777, 0o600); await lock.release();
  const sink = createHostAudit({ directory: root }); await sink.write(EVENT); await sink.close();
  const filename = path.join(root, 'broker-audit.jsonl'); assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  await fs.link(filename, path.join(root, 'linked')); const next = createHostAudit({ directory: root });
  await assert.rejects(next.write(EVENT), /host_path_refused/); await assert.rejects(next.close());
});

test('native Linux lock excludes another process and survives that process exiting', { skip: process.platform !== 'linux' }, async t => {
  const root = await fixture(t, { native: true });
  const moduleUrl = new URL('./host-ownership.mjs', import.meta.url).href;
  const source = `import { acquireHostOwnership } from ${JSON.stringify(moduleUrl)}; await acquireHostOwnership({stateRoot:process.argv[1]});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise(resolve => child.once('close', resolve)); assert.equal(code, 0, stderr);
  await assert.rejects(acquireHostOwnership({ stateRoot: root }), /host_already_owned/);
});
