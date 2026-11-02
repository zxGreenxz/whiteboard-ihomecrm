import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { drainOnEnd } from './pg-pool-drain.mjs';

const shutdownNotice = () => Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fakePool() {
  const pool = new EventEmitter(), sequence = [];
  pool.end = async () => { sequence.push('pool ended'); };
  return { pool: drainOnEnd(pool), sequence };
}

test('end() resolves only after every physical client closed its socket', async () => {
  const { pool, sequence } = fakePool();
  const first = new EventEmitter(), second = new EventEmitter();
  pool.emit('connect', first); pool.emit('connect', second);
  const ended = pool.end().then(() => sequence.push('cluster may stop'));
  await tick();
  assert.deepEqual(sequence, ['pool ended'], 'pg-pool itself already resolved, the sockets are still open');
  first.emit('end'); await tick();
  assert.deepEqual(sequence, ['pool ended'], 'one live client is enough to keep waiting');
  second.emit('end'); await ended;
  assert.deepEqual(sequence, ['pool ended', 'cluster may stop']);
});

test('only the server shutdown notice is tolerated, and only while the pool is being drained', async () => {
  const { pool } = fakePool();
  assert.equal(pool.listenerCount('error'), 0);
  assert.throws(() => pool.emit('error', shutdownNotice()), /terminating connection/, 'a 57P01 during the test still fails it');
  const client = new EventEmitter();
  pool.emit('connect', client);
  const ending = pool.end();
  assert.doesNotThrow(() => pool.emit('error', shutdownNotice()), '57P01 while draining is the cluster stopping');
  for (const code of ['08006', 'ECONNRESET', '57014', undefined]) {
    assert.throws(() => pool.emit('error', Object.assign(new Error(`other ${code}`), { code })), /other/, `${code} must stay red while draining`);
  }
  client.emit('end'); await ending;
  assert.equal(pool.listenerCount('error'), 0, 'no listener survives the drain window');
  assert.throws(() => pool.emit('error', shutdownNotice()), /terminating connection/);
  assert.throws(() => pool.emit('error', new Error('later')), /later/);
});

test('a failing end() still removes the drain listener and surfaces the failure', async () => {
  const pool = new EventEmitter();
  pool.end = async () => { throw new Error('Called end on pool more than once'); };
  drainOnEnd(pool);
  await assert.rejects(pool.end(), /more than once/);
  assert.equal(pool.listenerCount('error'), 0);
});

const scenario = fileURLToPath(new URL('./pg-pool-drain-scenario.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const SCENARIO_DEADLINE_MS = 150000; // below the test timeout, so a hung child is killed and cannot hold its pipes open
function runScenario(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scenario, mode], { cwd: repoRoot, windowsHide: true });
    let stdout = '', stderr = '';
    const deadline = setTimeout(() => { stderr += `
scenario ${mode} killed after ${SCENARIO_DEADLINE_MS} ms`; child.kill(); }, SCENARIO_DEADLINE_MS);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', status => { clearTimeout(deadline); resolve({ status, stdout, stderr }); });
  });
}

// The 57P01 tolerance is covered by the fake-pool test above: against a real cluster a delivered
// shutdown notice races with ECONNRESET (which must stay red), so it cannot be asserted deterministically.
test('real cluster: stopping PostgreSQL after pool.end() leaves no uncaughtException', { timeout: 180000 }, async () => {
  const [drained, undrained] = await Promise.all(['drained', 'undrained'].map(runScenario));
  // Control: without the drain the same teardown does crash the process with a late connection error, so the green run is not vacuous.
  assert.notEqual(undrained.status, 0, `undrained control must fail:
${undrained.stdout}${undrained.stderr}`);
  assert.match(undrained.stderr, /57P01|terminating connection|ECONNRESET|Connection terminated/);
  assert.equal(drained.status, 0, `${drained.stdout}${drained.stderr}`);
  assert.match(drained.stdout, /scenario drained: no uncaught exception/);
});
