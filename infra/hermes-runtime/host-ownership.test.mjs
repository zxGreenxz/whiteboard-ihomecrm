import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireHostOwnership, createHostAudit, readBootIdentity } from './host-ownership.mjs';

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
        return { stat: options => fs.lstat(name, options), sync: async () => {}, close: async () => {} };
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
// Boot identities are injected (trusted ports), so Windows and Linux run the same recovery branch without real procfs.
const BOOT = '5f0c3a1e-8b2d-4c6e-9a7f-1b3d5e7f9a0c', OLD_BOOT = '0d2e4f6a-1b3c-4d5e-8f7a-9b0c1d2e3f4a', NEXT_BOOT = '7a9b1c3d-5e7f-4a1b-8c3d-5e7f9a1b3c5d';
const OLD_LOCK = '30000000-0000-4000-8000-000000000003', HOUR = 3_600_000_000_000n, RECOVERED = { event: 'host_stale_lock_recovered', basis: 'boot_id' };
const lockText = (lockId, bootId) => JSON.stringify(bootId ? { version: 2, lockId, bootId } : { version: 1, lockId }) + '\n';
const claimName = (lockId = OLD_LOCK, bootId = BOOT) => `.hermes-host.lock.reclaim-${lockId}-${bootId}`;
// Seams below spot the claim by prefix, so a mutant claim name fails the test instead of leaving a gate shut.
const isClaim = (root, name) => typeof name === 'string' && name.startsWith(path.join(root, '.hermes-host.lock.reclaim-'));
const tomorrow = () => BigInt(Date.now() + 86_400_000) * 1_000_000n;
function bootPorts(bootId = BOOT, bootTime = null) {
  const events = [];
  return { events, ports: { readBoot: async () => ({ bootId, bootTime }), log: record => { events.push(record); } } };
}
async function staleRoot(t, text = lockText(OLD_LOCK, OLD_BOOT)) {
  const root = await fixture(t), filename = path.join(root, '.hermes-host.lock');
  await fs.writeFile(filename, text, { mode: 0o600 }); return { root, filename, text };
}

test('ownership is exclusive, records its boot, keeps a crash marker, and releases only its held lock', async t => {
  const root = await fixture(t), { events, ports } = bootPorts(), lock = await acquireHostOwnership({ stateRoot: root }, ports);
  assert.deepEqual(Object.keys(lock), ['release']); assert.ok(Object.isFrozen(lock));
  const filename = path.join(root, '.hermes-host.lock'), value = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.deepEqual(Object.keys(value), ['version', 'lockId', 'bootId']); assert.equal(value.version, 2); assert.equal(value.bootId, BOOT);
  await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), /host_already_owned/);
  const release = lock.release(); assert.equal(lock.release(), release); await release;
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
  const next = await acquireHostOwnership({ stateRoot: root }, ports); await next.release();
  await fs.writeFile(filename, JSON.stringify({ pid: 0, expiresAt: 1 }) + '\n', { mode: 0o600 });
  await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), /host_already_owned/);
  assert.match(await fs.readFile(filename, 'utf8'), /"pid":0/); assert.deepEqual(events, []);
});

test('default ports read the real procfs boot identity on Linux and keep the version 1 lock elsewhere', async t => {
  const root = await fixture(t), lock = await acquireHostOwnership({ stateRoot: root });
  const value = JSON.parse(await fs.readFile(path.join(root, '.hermes-host.lock'), 'utf8'));
  if (process.platform === 'linux') {
    const { bootId, bootTime } = await readBootIdentity();
    assert.match(bootId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(bootTime > 0n && bootTime <= BigInt(Date.now()) * 1_000_000n);
    assert.deepEqual(Object.keys(value), ['version', 'lockId', 'bootId']); assert.equal(value.version, 2); assert.equal(value.bootId, bootId);
  } else assert.deepEqual(Object.keys(value), ['version', 'lockId']);
  await lock.release();
});

test('readBootIdentity reads boot_id and btime, and a missing or malformed source is absent', async t => {
  const proc = await fixture(t), random = path.join(proc, 'sys', 'kernel', 'random'), absent = { bootId: null, bootTime: null };
  const identity = async () => ({ ...await readBootIdentity({ procRoot: proc }) });
  const write = async (id, stat) => { await fs.writeFile(path.join(random, 'boot_id'), id); await fs.writeFile(path.join(proc, 'stat'), stat); };
  assert.deepEqual(await identity(), absent); await fs.mkdir(random, { recursive: true });
  await write(`${BOOT}\n`, 'cpu  1 2 3 4\nintr 7 0 1\nctxt 9\nbtime 1762393260\nprocesses 5\n');
  assert.deepEqual(await identity(), { bootId: BOOT, bootTime: 1762393260n * 1_000_000_000n });
  for (const [id, stat] of [[BOOT.toUpperCase(), 'btime 0\n'], [`${BOOT}\n\n`, 'btime -1\n'], [` ${BOOT}`, 'btime 17623932600000000\n'],
    ['not-a-boot-id\n', 'btime 1e9\nbtime\n'], ['', 'nobtime 1\n']]) {
    await write(id, stat); assert.deepEqual(await identity(), absent);
  }
});

test('a lock written in another boot is replaced atomically and reported without private data', async t => {
  const { root, filename } = await staleRoot(t), { events, ports } = bootPorts();
  const lock = await acquireHostOwnership({ stateRoot: root }, ports), value = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.deepEqual(Object.keys(value), ['version', 'lockId', 'bootId']); assert.equal(value.bootId, BOOT); assert.notEqual(value.lockId, OLD_LOCK);
  // Exactly the fixed record: no path, lock ID, boot ID or error text reaches the journal.
  assert.deepEqual(events, [RECOVERED]); assert.deepEqual(await fs.readdir(root), ['.hermes-host.lock']);
  await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), /host_already_owned/);
  await lock.release(); assert.deepEqual(await fs.readdir(root), []); assert.deepEqual(events, [RECOVERED]);
});

test('a version 1 lock is stale only when both its mtime and ctime precede the boot by more than one hour', async t => {
  const { root, filename, text } = await staleRoot(t, lockText(OLD_LOCK));
  const days = new Date(Date.now() - 3 * 86_400_000); await fs.utimes(filename, days, days);
  const info = await fs.stat(filename, { bigint: true }); assert.ok(info.mtimeNs + 24n * HOUR < info.ctimeNs);
  // mtime alone lies days before that boot, but the inode changed since (utimes moves ctime): no proof; nor is the margin edge.
  for (const bootTime of [info.mtimeNs + 2n * HOUR, info.ctimeNs + HOUR, null]) {
    const { events, ports } = bootPorts(BOOT, bootTime);
    await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), /host_already_owned/); assert.deepEqual(events, []);
  }
  assert.equal(await fs.readFile(filename, 'utf8'), text); assert.deepEqual(await fs.readdir(root), ['.hermes-host.lock']);
  const { events, ports } = bootPorts(BOOT, info.ctimeNs + HOUR + 1n), lock = await acquireHostOwnership({ stateRoot: root }, ports);
  assert.deepEqual(events, [{ event: 'host_stale_lock_recovered', basis: 'boot_time' }]);
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).bootId, BOOT); await lock.release();
});

test('a lock of the current boot is never taken over, however old it looks', async t => {
  const { root, filename, text } = await staleRoot(t, lockText(OLD_LOCK, BOOT)), { events, ports } = bootPorts(BOOT, tomorrow());
  const month = new Date(Date.now() - 30 * 86_400_000); await fs.utimes(filename, month, month);
  await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), /host_already_owned/);
  assert.equal(await fs.readFile(filename, 'utf8'), text); assert.deepEqual(await fs.readdir(root), ['.hermes-host.lock']); assert.deepEqual(events, []);
});

test('without a boot identity every existing lock keeps the previous refusal and a new lock keeps version 1', async t => {
  const root = await fixture(t), filename = path.join(root, '.hermes-host.lock'), future = tomorrow();
  for (const readBoot of [async () => ({ bootId: null, bootTime: future }), async () => { throw Error('PRIVATE_PROC_DETAIL'); },
    () => ({ bootId: BOOT.toUpperCase(), bootTime: future }), async () => ({ bootId: `${BOOT}\n`, bootTime: future }), async () => null]) {
    const events = [], ports = { readBoot, log: record => { events.push(record); } };
    for (const text of [lockText(OLD_LOCK, OLD_BOOT), lockText(OLD_LOCK)]) {
      await fs.writeFile(filename, text, { mode: 0o600 });
      await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), error => error.code === 'host_already_owned' && !error.message.includes('PRIVATE'));
      assert.equal(await fs.readFile(filename, 'utf8'), text);
    }
    await fs.rm(filename); const lock = await acquireHostOwnership({ stateRoot: root }, ports);
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(filename, 'utf8'))), ['version', 'lockId']); await lock.release();
    assert.deepEqual(events, []); assert.deepEqual(await fs.readdir(root), []);
  }
});

test('unrecognised, partial, oversized or extended lock content is never stale', async t => {
  const stale = lockText(OLD_LOCK, OLD_BOOT), { root, filename } = await staleRoot(t, ''), { events, ports } = bootPorts(BOOT, tomorrow());
  const json = value => JSON.stringify(value) + '\n';
  for (const text of ['', '\0'.repeat(64), stale.slice(0, -1), stale.slice(0, 30), stale.replace('{', '{ '), stale + ' '.repeat(600),
    stale.replace(OLD_BOOT, OLD_BOOT.toUpperCase()), json({ version: 2, lockId: OLD_LOCK, bootId: OLD_BOOT, pid: 1 }),
    json({ lockId: OLD_LOCK, version: 2, bootId: OLD_BOOT }), json({ version: 1, lockId: OLD_LOCK, bootId: OLD_BOOT }),
    json({ version: 3, lockId: OLD_LOCK, bootId: OLD_BOOT }), json({ version: 2, lockId: 'PRIVATE_TOKEN', bootId: OLD_BOOT }), json({ version: 2, bootId: OLD_BOOT })]) {
    await fs.writeFile(filename, text, { mode: 0o600 });
    await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), error => error.code === 'host_already_owned' && !error.message.includes('PRIVATE'));
    assert.equal(await fs.readFile(filename, 'utf8'), text); assert.deepEqual(await fs.readdir(root), ['.hermes-host.lock']);
  }
  assert.deepEqual(events, []);
});

test('a stale-looking lock behind a hard link, symlink, other owner or open mode is refused unchanged', async t => {
  const { root, filename, text } = await staleRoot(t), { events, ports } = bootPorts(), other = path.join(root, 'other-name');
  await fs.link(filename, other);
  await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), /host_already_owned/); await fs.rm(other);
  if (process.platform !== 'win32') {
    await fs.rename(filename, other); await fs.symlink(other, filename);
    await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), /host_already_owned/);
    assert.ok((await fs.lstat(filename)).isSymbolicLink()); assert.equal(await fs.readFile(other, 'utf8'), text);
    await fs.rm(filename); await fs.rename(other, filename); await fs.chmod(filename, 0o640);
    await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), /host_already_owned/); await fs.chmod(filename, 0o600);
    const lstat = fs.lstat.bind(fs), foreign = t.mock.method(fs, 'lstat', async (name, options) => {
      const info = await lstat(name, options); if (name === filename) info.uid += options?.bigint ? 1n : 1; return info;
    });
    await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), /host_already_owned/); foreign.mock.restore();
  }
  assert.equal(await fs.readFile(filename, 'utf8'), text); assert.deepEqual(await fs.readdir(root), ['.hermes-host.lock']); assert.deepEqual(events, []);
  // Control: the same lock without the defect is recovered, so each refusal above came from its own check.
  const lock = await acquireHostOwnership({ stateRoot: root }, ports); assert.deepEqual(events, [RECOVERED]); await lock.release();
});

test('concurrent recoveries of one stale lock admit exactly one writer and leave no claim behind', async t => {
  const { root, filename } = await staleRoot(t), { events, ports } = bootPorts();
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireHostOwnership({ stateRoot: root }, ports)));
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(x => x.status === 'rejected' && x.reason.code === 'host_already_owned').length, 7);
  assert.deepEqual(await fs.readdir(root), ['.hermes-host.lock']); assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).bootId, BOOT);
  assert.deepEqual(events, [RECOVERED]); await attempts.find(x => x.status === 'fulfilled').value.release();
});

test('a start that saw the stale lock before another start recovered it cannot replace the recovered lock', { timeout: 30_000 }, async t => {
  const { root, filename } = await staleRoot(t), entered = deferred(), gate = deferred();
  const open = fs.open.bind(fs); let delayed = false;
  t.mock.method(fs, 'open', async (name, ...rest) => {
    if (isClaim(root, name) && !delayed) { delayed = true; entered.resolve(); await gate.promise; }
    return open(name, ...rest);
  });
  const late = bootPorts(), early = bootPorts(), waiting = acquireHostOwnership({ stateRoot: root }, late.ports); await entered.promise;
  const winner = await acquireHostOwnership({ stateRoot: root }, early.ports), recovered = await fs.readFile(filename);
  // The late start now wins the freed claim name, but the lock it inspected is gone: it must refuse, not overwrite.
  gate.resolve(); await assert.rejects(waiting, /host_already_owned/);
  assert.deepEqual(await fs.readFile(filename), recovered); assert.deepEqual(await fs.readdir(root), ['.hermes-host.lock']);
  assert.deepEqual([late.events, early.events], [[], [RECOVERED]]); await winner.release();
});

test('a lock replaced or rewritten after inspection is never overwritten and the unpublished claim is withdrawn', async t => {
  for (const change of ['inode', 'content']) {
    const { root, filename, text } = await staleRoot(t), { events, ports } = bootPorts();
    const replacement = change === 'inode' ? text : lockText('40000000-0000-4000-8000-000000000004', OLD_BOOT);
    wrapOpen(t, async (handle, [name]) => {
      if (isClaim(root, name)) { if (change === 'inode') await fs.rename(filename, filename + '.old'); await fs.writeFile(filename, replacement, { mode: 0o600 }); }
      return handle;
    });
    await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), /host_already_owned/);
    assert.equal(await fs.readFile(filename, 'utf8'), replacement); assert.deepEqual(events, []);
    assert.deepEqual((await fs.readdir(root)).sort(), change === 'inode' ? ['.hermes-host.lock', '.hermes-host.lock.old'] : ['.hermes-host.lock']);
  }
});

test('a failed claim write is withdrawn without touching the stale lock, and the next start recovers it', async t => {
  const { root, filename, text } = await staleRoot(t), { events, ports } = bootPorts(); let syncs = 0;
  wrapOpen(t, (handle, [name]) => {
    if (isClaim(root, name)) { const sync = handle.datasync.bind(handle); handle.datasync = async () => { if (++syncs === 1) throw Error('PRIVATE_DISK_DETAIL'); await sync(); }; }
    return handle;
  });
  await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), error => error.code === 'host_ownership_unavailable' && !error.message.includes('PRIVATE'));
  assert.equal(await fs.readFile(filename, 'utf8'), text); assert.deepEqual(await fs.readdir(root), ['.hermes-host.lock']); assert.deepEqual(events, []);
  const lock = await acquireHostOwnership({ stateRoot: root }, ports); assert.equal(syncs, 2); assert.deepEqual(events, [RECOVERED]); await lock.release();
});

test('a recovery interrupted in this boot keeps refusing, and the next boot recovers past its inert claim', async t => {
  const { root, filename, text } = await staleRoot(t), now = bootPorts(BOOT), next = bootPorts(NEXT_BOOT); let cut = false;
  // The claim's first stat fails before the attempt knows its own inode: like a crash, that claim stays behind.
  wrapOpen(t, (handle, [name]) => {
    if (isClaim(root, name) && !cut) { cut = true; handle.stat = async () => { throw Error('PRIVATE_CUT_DETAIL'); }; }
    return handle;
  });
  await assert.rejects(acquireHostOwnership({ stateRoot: root }, now.ports), error => error.code === 'host_ownership_unavailable' && !error.message.includes('PRIVATE'));
  const [leftover, ...others] = (await fs.readdir(root)).filter(name => name !== '.hermes-host.lock');
  assert.equal(leftover, claimName()); assert.deepEqual(others, []);
  await assert.rejects(acquireHostOwnership({ stateRoot: root }, now.ports), /host_already_owned/);
  assert.equal(await fs.readFile(filename, 'utf8'), text);
  const lock = await acquireHostOwnership({ stateRoot: root }, next.ports);
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).bootId, NEXT_BOOT); assert.deepEqual((await fs.readdir(root)).sort(), ['.hermes-host.lock', leftover]);
  assert.deepEqual([now.events, next.events], [[], [RECOVERED]]); await lock.release();
});

test('an ambiguous claim publication is unknown, never withdrawn, and the same boot then refuses', async t => {
  const { root, filename } = await staleRoot(t), { events, ports } = bootPorts(), rename = fs.rename.bind(fs); let failed = false;
  t.mock.method(fs, 'rename', async (from, to) => { await rename(from, to); if (!failed) { failed = true; throw Error('PRIVATE_RENAME_DETAIL'); } });
  await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), error => error.code === 'host_ownership_unknown' && !error.message.includes('PRIVATE'));
  const value = JSON.parse(await fs.readFile(filename, 'utf8')); assert.equal(value.bootId, BOOT); assert.deepEqual(await fs.readdir(root), ['.hermes-host.lock']);
  await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), /host_already_owned/);
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), value); assert.deepEqual(events, []);
});

test('ownership ports are strict functions checked before any filesystem or procfs work', async t => {
  const root = await fixture(t); let reads = 0;
  const readBoot = async () => { reads++; return { bootId: BOOT, bootTime: null }; }, getter = {};
  Object.defineProperty(getter, 'readBoot', { enumerable: true, get() { reads++; return readBoot; } });
  for (const [ports, code] of [[{ readBoot: BOOT }, 'host_invalid_config'], [{ log: 'stdout' }, 'host_invalid_config'], [{ readBoot: undefined }, 'host_invalid_config'],
    [{ readBoot, token: 'PRIVATE_TOKEN' }, 'host_invalid_data'], [getter, 'host_invalid_data'], [null, 'host_invalid_data'], [Object.create({ readBoot }), 'host_invalid_data']]) {
    await assert.rejects(acquireHostOwnership({ stateRoot: root }, ports), error => error.code === code && !error.message.includes('PRIVATE'));
  }
  assert.equal(reads, 0); assert.deepEqual(await fs.readdir(root), []);
});

test('a throwing or rejecting event sink never changes the recovered ownership', async t => {
  const unhandled = [], listener = reason => { unhandled.push(reason); };
  process.on('unhandledRejection', listener); t.after(() => { process.off('unhandledRejection', listener); });
  for (const log of [() => { throw Error('PRIVATE_STDOUT'); }, async () => { throw Error('PRIVATE_STDOUT'); }]) {
    const { root, filename } = await staleRoot(t), lock = await acquireHostOwnership({ stateRoot: root }, { readBoot: async () => ({ bootId: BOOT, bootTime: null }), log });
    assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).bootId, BOOT); await lock.release();
  }
  await pause(); assert.deepEqual(unhandled, []);
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

for (const kind of ['lock', 'audit']) test(`${kind} rejects distinct file IDs that round to the same Number`, async t => {
  const root = await fixture(t), filename = path.join(root, kind === 'lock' ? '.hermes-host.lock' : 'broker-audit.jsonl');
  const firstId = 2n ** 53n, replacementId = firstId + 1n;
  assert.equal(Number(firstId), Number(replacementId));
  let replaced = false;
  const identity = (info, options, replacement) => {
    info.ino = options?.bigint ? (replacement ? replacementId : firstId) : Number(replacement ? replacementId : firstId);
    return info;
  };
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', async (name, options) => {
    const info = await lstat(name, options);
    return name === filename ? identity(info, options, replaced) : info;
  });
  wrapOpen(t, (handle, [name]) => {
    if (name === filename) {
      const stat = handle.stat.bind(handle), replacement = replaced;
      handle.stat = async options => identity(await stat(options), options, replacement);
    }
    return handle;
  });
  const owner = kind === 'lock' ? await acquireHostOwnership({ stateRoot: root }) : createHostAudit({ directory: root });
  if (kind === 'audit') await owner.write(EVENT);
  const before = await fs.readFile(filename);
  await fs.rename(filename, filename + '.old');
  await fs.writeFile(filename, before, { mode: 0o600 });
  replaced = true;
  if (kind === 'lock') await assert.rejects(owner.release(), /host_lock_retained/);
  else {
    await assert.rejects(owner.write(EVENT), /host_audit_changed/);
    await assert.rejects(owner.close(), /host_audit_changed/);
  }
  assert.deepEqual(await fs.readFile(filename), before);
  assert.deepEqual(await fs.readFile(filename + '.old'), before);
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

test('native Linux lock excludes another process, survives its exit in this boot and is recovered after a reboot', { skip: process.platform !== 'linux' }, async t => {
  const root = await fixture(t, { native: true }), filename = path.join(root, '.hermes-host.lock');
  const moduleUrl = new URL('./host-ownership.mjs', import.meta.url).href;
  const source = `import { acquireHostOwnership } from ${JSON.stringify(moduleUrl)}; await acquireHostOwnership({stateRoot:process.argv[1]});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise(resolve => child.once('close', resolve)); assert.equal(code, 0, stderr);
  // Real procfs on both sides: the dead child's lock carries this boot's ID, so it is still refused.
  const events = [], log = record => { events.push(record); };
  await assert.rejects(acquireHostOwnership({ stateRoot: root }, { log }), /host_already_owned/);
  const crashed = JSON.parse(await fs.readFile(filename, 'utf8')); assert.equal(crashed.bootId, (await readBootIdentity()).bootId);
  // The same private file as the next boot would read it: only the kernel boot ID differs.
  await fs.writeFile(filename, lockText(crashed.lockId, OLD_BOOT));
  const lock = await acquireHostOwnership({ stateRoot: root }, { log }); assert.deepEqual(events, [RECOVERED]);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600); assert.deepEqual(await fs.readdir(root), ['.hermes-host.lock']); await lock.release();
});
