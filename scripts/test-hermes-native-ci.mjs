#!/usr/bin/env node
// CI runs the existing behavior tests in the pinned, offline Linux image.
// A skipped or empty file is not evidence for its native/upstream contract.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

assert.equal(process.platform, 'linux', 'Native CI requires Linux ownership and durability checks');
assert.ok(process.getuid() > 0 && process.getgid() > 0, 'Native CI requires a non-root principal');
for (const key of ['HERMES_TEST_UPSTREAM', 'HERMES_TEST_PYTHON']) {
  assert.ok(process.env[key] && path.isAbsolute(process.env[key]), `${key} must explicitly select the pinned runtime`);
}
process.umask(0o077);

for (const file of [
  'worker/deploy/native-deployment.test.mjs',
  ...['bridge.test.mjs', 'bridge-media.test.mjs', 'journal.test.mjs', 'operator.test.mjs', 'operator-reconcile.test.mjs',
    'quarantine-release.test.mjs', 'upstream.test.mjs']
    .map(name => `infra/hermes-zalo-native/${name}`),
]) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=120000',
    file], { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${file} did not complete successfully`);
  assert.match(result.stdout, /^# tests [1-9]\d*$/m, `${file} ran no tests`);
  // Node counts an empty file as one passing subtest named after that file.
  assert.match(result.stdout, /^# Subtest: (?!.*\.test\.mjs$).+/m, `${file} registered no behavior tests`);
  for (const kind of ['fail', 'cancelled', 'skipped', 'todo']) {
    assert.match(result.stdout, new RegExp(`^# ${kind} 0$`, 'm'), `${file} has ${kind} or no complete summary`);
  }
}
