// Child process for pg-pool-drain.test.mjs: tears a real disposable cluster down while pool clients are connected.
// A process-level uncaughtException is the failure being guarded, so it must run outside the node:test process.
import pg from 'pg';
import { localCluster } from './crm-shared-read-sql-fixture.mjs';

const mode = process.argv[2];
const SCENARIOS = ['drained', 'undrained'];
if (!SCENARIOS.includes(mode)) throw new Error(`mode must be one of ${SCENARIOS.join(', ')}`);

// The backend has not consumed Terminate yet when pg_ctl stop signals it: model the lost race by writing
// Terminate only after a delay, which pg_ctl stop (synchronous, event loop blocked) always outlasts.
const originalEnd = pg.Client.prototype.end;
pg.Client.prototype.end = function delayedEnd(callback) { setTimeout(() => originalEnd.call(this, callback), 50); };

const { pool, cleanup } = await localCluster({ diagnostic() {} });
const clients = await Promise.all([1, 2, 3, 4].map(() => pool.connect()));
await Promise.all(clients.map(client => client.query('SELECT 1')));
clients.forEach(client => client.release());

if (mode === 'undrained') {
  await pg.Pool.prototype.end.call(pool); // what pool.end() was before drainOnEnd: resolves with sockets still open
  cleanup();
} else {
  await pool.end();
  cleanup();
}
// Let any late socket event surface before the process decides its exit code.
await new Promise(resolve => setTimeout(resolve, 600));
console.log(`scenario ${mode}: no uncaught exception`);
