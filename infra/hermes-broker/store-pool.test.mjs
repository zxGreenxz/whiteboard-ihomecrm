import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { createStorePool } from './store-pool.mjs';

const projectRef = 'abcdefghijklmnopqrst';
const input = () => ({ projectRef, host: 'aws-1-ap-southeast-1.pooler.supabase.com',
  role: 'hermes_store_fixture', password: 'synthetic-password-32-bytes-fixture' });
class FakePool extends EventEmitter { constructor(config) { super(); this.config = config; } }
const create = values => createStorePool(values, { Pool: FakePool });

test('TLS, role-bound session pooler and execution limits cannot be overridden by PG options', () => {
  const pool = create({ ...input(), ssl: false, port: 6543, user: 'postgres', connectionString: 'postgres://root@other' });
  assert.equal(pool.config.port, 5432);
  assert.equal(pool.config.user, `hermes_store_fixture.${projectRef}`);
  assert.deepEqual(pool.config.ssl, { rejectUnauthorized: true });
  assert.equal(pool.config.max, 4);
  assert.ok(pool.config.statement_timeout < pool.config.query_timeout);
  assert.ok(pool.config.lock_timeout < pool.config.statement_timeout);
  assert.equal(pool.config.connectionTimeoutMillis, 5000);
  assert.equal(pool.config.connectionString, undefined);
});

test('one connection stays warm between Hermes turns but every client has a bounded lifetime', () => {
  const pool = create(input());
  assert.equal(pool.config.min, 1);
  assert.ok(pool.config.min < pool.config.max);
  assert.ok(pool.config.idleTimeoutMillis >= 60_000);
  assert.ok(pool.config.maxLifetimeSeconds > 0 && pool.config.maxLifetimeSeconds <= 900);
  assert.equal(pool.config.keepAlive, true);
  assert.ok(pool.config.keepAliveInitialDelayMillis > 0 && pool.config.keepAliveInitialDelayMillis <= 60_000);
});

test('direct hostname must match the project and uses only the dedicated role', () => {
  const pool = create({ ...input(), host: `db.${projectRef}.supabase.co` });
  assert.equal(pool.config.user, 'hermes_store_fixture');
  assert.equal(pool.config.database, 'postgres');
  assert.throws(() => create({ ...input(), host: 'db.zzzzzzzzzzzzzzzzzzzz.supabase.co' }));
});

test('privileged, malformed or external configuration is rejected before pool creation', () => {
  for (const change of [{ role: 'postgres' }, { role: 'service_role' }, { role: 'hermes_store_executor' },
    { role: 'hermes_store_x;SQL' }, { projectRef: '../ref' }, { host: 'attacker.invalid' },
    { host: 'localhost' }, { host: 'pooler.supabase.com.attacker.invalid' },
    { password: '' }, { password: 'secret\nwith-newline-xxxxxxxx' }, { ca: 'not-a-certificate' }, { onIdleFailure: null }]) {
    assert.throws(() => create({ ...input(), ...change }), { message: 'invalid_store_pool_config' });
  }
});

test('additional CA never disables peer verification; idle errors expose only a fixed code', async () => {
  const events = [];
  const ca = '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----';
  const pool = create({ ...input(), ca, onIdleFailure: value => events.push(value) });
  assert.deepEqual(pool.config.ssl, { rejectUnauthorized: true, ca });
  assert.doesNotThrow(() => pool.emit('error', new Error('private connection password')));
  assert.deepEqual(events, [{ code: 'store_idle_connection_failed' }]);
  const badObserver = create({ ...input(), onIdleFailure: () => { throw new Error('private'); } });
  assert.doesNotThrow(() => badObserver.emit('error', new Error('private database error')));
  const asyncObserver = create({ ...input(), onIdleFailure: async () => { throw new Error('private async failure'); } });
  asyncObserver.emit('error', new Error('private database error'));
  await new Promise(resolve => setImmediate(resolve));
});

test('actual pg startup cannot inherit ambient PGOPTIONS that disable query limits', t => {
  const previous = process.env.PGOPTIONS;
  t.after(() => { if (previous === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = previous; });
  process.env.PGOPTIONS = '-c statement_timeout=0 -c lock_timeout=0';
  const pool = create(input());
  const startup = new pg.Client(pool.config).getStartupConf();
  assert.equal(startup.options, '-c statement_timeout=8000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000');
  assert.equal(startup.statement_timeout, '8000');
  assert.equal(startup.lock_timeout, '3000');
});
