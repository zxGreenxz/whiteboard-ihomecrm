import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProfileLeaseStore } from './profile-lease.mjs';
import { assertInside } from './runtime-contract.mjs';

const ids = {
  assistantId: '30000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000001',
  organizationId: '20000000-0000-4000-8000-000000000001',
};
async function setup(t) {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'hermes-profile-'));
  t.after(() => rm(assertInside(os.tmpdir(), rawRoot), { recursive: true }));
  const root = await realpath(rawRoot);
  const home = path.join(root, 'home'); await mkdir(home);
  const config = { homeRoot: root, directory: path.join(root, 'supervisor') };
  return { root, rawRoot, home, config, store: new ProfileLeaseStore(config), binding: { ...ids, home } };
}

test('canonicalizes the root and home together, including Windows TEMP 8.3 aliases', async (t) => {
  const { rawRoot, home } = await setup(t);
  const store = new ProfileLeaseStore({ homeRoot: rawRoot, directory: path.join(rawRoot, 'supervisor') });
  const lease = await store.acquire({ ...ids, home: path.join(rawRoot, 'home') });
  assert.equal(lease.binding.home, home);
  await lease.release();
});

test('atomic lease rejects simultaneous holders, including a second supervisor instance', async (t) => {
  const { store, config, binding } = await setup(t);
  const results = await Promise.allSettled([store.acquire(binding), new ProfileLeaseStore(config).acquire(binding)]);
  assert.equal(results.filter((v) => v.status === 'fulfilled').length, 1);
  assert.equal(results.find((v) => v.status === 'rejected').reason.message, 'profile_in_use');
  const lease = results.find((v) => v.status === 'fulfilled').value;
  await lease.release();
  const restarted = await new ProfileLeaseStore(config).acquire(binding);
  assert.deepEqual(restarted.binding, binding);
  assert.equal(await lease.release(), false, 'old holder must not release the new lock');
  await assert.rejects(store.acquire(binding), /profile_in_use/);
  await restarted.release();
});

test('an existing profile/home cannot be reassigned to another user, organization, assistant or home', async (t) => {
  const { store, binding, root } = await setup(t);
  await (await store.acquire(binding)).release();
  const otherHome = path.join(root, 'other-home'); await mkdir(otherHome);
  for (const next of [{ ...binding, userId: '10000000-0000-4000-8000-000000000002' },
    { ...binding, organizationId: '20000000-0000-4000-8000-000000000002' },
    { ...binding, assistantId: '30000000-0000-4000-8000-000000000002' },
    { ...binding, home: otherHome }]) {
    await assert.rejects(store.acquire(next), /profile_owner_mismatch/);
  }
  await (await store.acquire(binding)).release();
});

test('revoked profile cannot restart and a crashed lease is never silently stolen', async (t) => {
  const { store, config, binding } = await setup(t);
  const lease = await store.acquire(binding);
  await assert.rejects(new ProfileLeaseStore(config).acquire(binding), /profile_in_use/);
  await store.revoke(binding.assistantId);
  await lease.release();
  await assert.rejects(new ProfileLeaseStore(config).acquire(binding), /profile_revoked/);
});

test('rejects path escape, symlink escape and metadata mounted inside a runtime home', async (t) => {
  const { store, binding, root } = await setup(t);
  await assert.rejects(store.acquire({ ...binding, home: os.tmpdir() }), /strictly inside/);
  const link = path.join(root, 'redirected-home');
  await symlink(os.tmpdir(), link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.acquire({ ...binding, home: link }), /strictly inside/);
  const nested = path.join(binding.home, 'nested'); await mkdir(nested);
  await assert.rejects(store.acquire({ ...binding, home: nested }), /profile_home_not_direct_child/);
  const unsafe = new ProfileLeaseStore({ homeRoot: root, directory: path.join(binding.home, 'supervisor') });
  await assert.rejects(unsafe.acquire(binding), /profile_metadata_inside_home/);
  await assert.rejects(store.acquire({ ...binding, assistantId: '../foreign' }), /profile_invalid_binding/);
});
