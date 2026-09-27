import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const spawnSync = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
vi.mock('node:child_process', () => ({ spawnSync }));

const target = 'postgresql://postgres:local-password@127.0.0.1:58840/postgres';
const cleanEnv = { PATH: 'C:/safe-bin', SystemRoot: 'C:/Windows' };
const initialDocker = process.env.PSQL_DOCKER;
afterEach(() => {
  if (initialDocker === undefined) delete process.env.PSQL_DOCKER;
  else process.env.PSQL_DOCKER = initialDocker;
});
const load = async docker => {
  if (docker) process.env.PSQL_DOCKER = docker;
  else delete process.env.PSQL_DOCKER;
  vi.resetModules();
  return import('../lib/goi-psql-dich.mjs');
};

test('local restore target accepts clean loopback and rejects libpq URI routing overrides', async () => {
  const { admitLocalPsqlTarget } = await load('');
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.doesNotThrow(() => admitLocalPsqlTarget(target.replace('127.0.0.1', host), cleanEnv));
  }
  for (const unsafe of [
    target + '?host=remote.example',
    target + '?hostaddr=203.0.113.7',
    target + '?%68ostaddr=203.0.113.7',
    target + '?host=127.0.0.1&host=remote.example',
    target + '?service=route',
    target.replace('127.0.0.1', '127.0.0.1,remote.example'),
    target.replace('127.0.0.1', 'remote.example'),
  ]) assert.throws(() => admitLocalPsqlTarget(unsafe, cleanEnv), /local restore target/);
});

test('routing environment is refused before any native psql write', async () => {
  const { goiPsql } = await load('');
  for (const key of ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGSERVICE', 'PGSERVICEFILE', 'PGSYSCONFDIR']) {
    spawnSync.mockClear();
    assert.throws(() => goiPsql(['-d', target, '-c', 'select 1'], { localOnly: true, env: { ...cleanEnv, [key]: 'unsafe' } }), /local restore target/);
    assert.equal(spawnSync.mock.calls.length, 0, key);
  }
});

test('URI routing overrides are refused before the process receives SQL', async () => {
  const { goiPsql } = await load('');
  for (const unsafe of [target + '?host=remote.example', target + '?hostaddr=203.0.113.7', target + '?%68ost=remote.example', target.replace('127.0.0.1', '127.0.0.1,remote.example')]) {
    spawnSync.mockClear();
    assert.throws(() => goiPsql(['-d', unsafe, '-f', '-'], { localOnly: true, env: cleanEnv, input: 'select 1;' }), /local restore target/);
    assert.equal(spawnSync.mock.calls.length, 0, unsafe);
  }
});

test('process inherited routing defaults are refused when caller supplies no env', async () => {
  const { goiPsql } = await load('');
  const prior = process.env.PGHOSTADDR;
  try {
    process.env.PGHOSTADDR = '203.0.113.7';
    spawnSync.mockClear();
    assert.throws(() => goiPsql(['-d', target, '-f', '-'], { localOnly: true, input: 'select 1;' }), /local restore target/);
    assert.equal(spawnSync.mock.calls.length, 0);
  } finally {
    if (prior === undefined) delete process.env.PGHOSTADDR;
    else process.env.PGHOSTADDR = prior;
  }
});

test('native invocation uses admitted URI, no psqlrc and no inherited PG defaults', async () => {
  const { goiPsql } = await load('');
  spawnSync.mockClear();
  goiPsql(['-d', target, '-f', '-'], { localOnly: true, env: { ...cleanEnv, PGPASSWORD: 'ignored' }, input: 'select 1;' });
  const [command, args, opts] = spawnSync.mock.calls[0];
  assert.match(command, /psql(?:\.exe)?$/);
  assert.deepEqual(args, ['-X', '-d', target, '-f', '-']);
  assert.equal(opts.input, 'select 1;');
  assert.equal(opts.localOnly, undefined);
  assert.equal(Object.keys(opts.env).some(key => /^PG/i.test(key)), false);
});

test('Docker invocation erases container defaults and passes the same admitted URI', async () => {
  const { goiPsql } = await load('ci01-disposable');
  spawnSync.mockClear();
  goiPsql(['-d', target, '-f', '-'], { localOnly: true, env: cleanEnv, input: 'select 1;' });
  const [command, args, opts] = spawnSync.mock.calls[0];
  assert.equal(command, 'docker');
  assert.deepEqual(args.slice(0, 5), ['exec', '-i', 'ci01-disposable', 'env', '-i']);
  assert.match(args[5], /^PATH=\/usr\/lib\/postgresql\/17\/bin:/);
  assert.deepEqual(args.slice(6), ['psql', '-X', '-d', target, '-f', '-']);
  assert.equal(opts.input, 'select 1;');
  assert.equal(Object.keys(opts.env).some(key => /^PG/i.test(key)), false);
});
