import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProfileHomes } from './profile-homes.mjs';
import { ProfileLeaseStore } from './profile-lease.mjs';

const A = { assistantId: '30000000-0000-4000-8000-000000000001', userId: '10000000-0000-4000-8000-000000000001', organizationId: '20000000-0000-4000-8000-000000000001' };
const B = { assistantId: '30000000-0000-4000-8000-000000000002', userId: '10000000-0000-4000-8000-000000000002', organizationId: A.organizationId };
const options = () => ({ signal: new AbortController().signal });
async function fixture(t) {
  const raw = await mkdtemp(path.join(os.tmpdir(), 'hermes-homes-')), root = await realpath(raw);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, homes: createProfileHomes({ homeRoot: root }) };
}

test('factory is inert; homes are canonical direct siblings and marker is outside each home', async t => {
  const { root, homes } = await fixture(t); assert.deepEqual(await readdir(root), []);
  const [a, b] = await Promise.all([homes.ensure(A, options()), homes.ensure(B, options())]);
  assert.notEqual(a, b); assert.equal(path.dirname(a), root); assert.equal(path.dirname(b), root);
  assert.equal(await realpath(a), a); assert.deepEqual(await readdir(a), []);
  const marker = JSON.parse(await readFile(path.join(root, '.profile-home-owners', A.assistantId + '.json'), 'utf8'));
  assert.deepEqual(marker, { version: 1, ...A, home: a });
  assert.equal(await homes.ensure(A, options()), a);
  const leases = new ProfileLeaseStore({ homeRoot: root, directory: path.join(root, 'supervisor') });
  const lease = await leases.acquire({ ...A, home: a });
  await assert.rejects(leases.acquire({ ...A, home: a }), /profile_in_use/);
  await homes.ensure(A, options());
  await assert.rejects(leases.acquire({ ...A, home: a }), /profile_in_use/, 'ensure must not remove a crash/execution lock');
  await lease.release();
});

test('owner is snapshotted, concurrent same owner converges, and reassignment is rejected', async t => {
  const { homes } = await fixture(t), mutable = { ...A };
  const first = homes.ensure(mutable, options()); mutable.userId = B.userId;
  const [a, again] = await Promise.all([first, homes.ensure(A, options())]); assert.equal(a, again);
  for (const owner of [{ ...A, userId: B.userId }, { ...A, organizationId: '20000000-0000-4000-8000-000000000003' }]) {
    await assert.rejects(homes.ensure(owner, options()), /profile_owner_mismatch/);
  }
});

test('existing unmarked home or symlink cannot be adopted; old data remains untouched', async t => {
  const { root, homes } = await fixture(t), home = path.join(root, `assistant-${A.assistantId}`);
  await mkdir(home); await writeFile(path.join(home, 'existing.txt'), 'old private data');
  await assert.rejects(homes.ensure(A, options()), /profile_home_unowned/);
  assert.equal(await readFile(path.join(home, 'existing.txt'), 'utf8'), 'old private data');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'hermes-foreign-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, `assistant-${B.assistantId}`), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(homes.ensure(B, options()), /profile_home_unowned/);
  assert.deepEqual(await readdir(outside), []);
});

test('redirected root and malformed marker are refused', async t => {
  const { root, homes } = await fixture(t), home = await homes.ensure(A, options());
  const marker = path.join(root, '.profile-home-owners', A.assistantId + '.json');
  await writeFile(marker, '{"version":1,"foreign":true}');
  await assert.rejects(homes.ensure(A, options()), /profile_owner_mismatch/);
  const rootLink = path.join(root, 'redirected'); await symlink(root, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createProfileHomes({ homeRoot: rootLink }).ensure(B, options()), /profile_path_refused/);
  assert.deepEqual(await readdir(home), []);
});

test('metadata and already owned home symlink replacement never redirects ensure into another directory', async t => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'hermes-foreign-')); t.after(() => rm(outside, { recursive: true, force: true }));
  const first = await fixture(t), home = await first.homes.ensure(A, options());
  await rmdir(home);
  await symlink(outside, home, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(first.homes.ensure(A, options()), /profile_path_refused/);
  const second = await fixture(t);
  await symlink(outside, path.join(second.root, '.profile-home-owners'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(second.homes.ensure(A, options()), /profile_path_refused/);
  assert.deepEqual(await readdir(outside), []);
});

test('exact data-only identity and cancellation reject before filesystem work', async t => {
  const { root, homes } = await fixture(t); let reads = 0;
  const getter = { ...A }; Object.defineProperty(getter, 'userId', { get() { reads++; return A.userId; } });
  for (const input of [getter, { ...A, home: '/foreign' }, Object.assign(Object.create({}), A), { ...A, assistantId: '../escape' }]) {
    await assert.rejects(homes.ensure(input, options()));
  }
  assert.equal(reads, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(homes.ensure(A, { signal: controller.signal }), /profile_cancelled/);
  assert.deepEqual(await readdir(root), []);
});

test('native Linux requires private host ownership/modes and creates 0700 directories/0600 marker', { skip: process.platform !== 'linux' }, async t => {
  const { root, homes } = await fixture(t), home = await homes.ensure(A, options());
  for (const directory of [root, home, path.join(root, '.profile-home-owners')]) assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(root, '.profile-home-owners', A.assistantId + '.json'))).mode & 0o777, 0o600);
  await chmod(root, 0o755); await assert.rejects(homes.ensure(B, options()), /profile_path_refused/);
});
