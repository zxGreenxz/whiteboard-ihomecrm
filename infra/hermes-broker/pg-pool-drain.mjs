// Teardown of a disposable PostgreSQL cluster used by the SQL fixtures.
//
// pg-pool resolves end() once its clients are removed from its own list, which is BEFORE their sockets close:
// each client only writes Terminate and half-closes. The fixtures then stop the cluster synchronously
// (pg_ctl stop blocks the event loop), so a backend can still be live when SIGTERM reaches it. It answers the
// client with FATAL 57P01 "terminating connection due to administrator command"; that message is read after
// the test body ended, pg-pool's idle listener re-emits it as pool 'error', nobody listens, and Node reports an
// uncaughtException against a file whose tests all passed (CI main, run 41293228823 and 73cefc967, 01/11/2026).
//
// The fix is ordering: end() of a drained pool resolves only after every physical client emitted 'end', so
// the cluster is stopped when nothing is connected. Only the server's own shutdown notice (57P01) is tolerated
// while that happens; any other pool error still throws, and no listener exists outside the drain window.
export const SERVER_SHUTDOWN_SQLSTATE = '57P01';

export function drainOnEnd(pool) {
  const physical = [];
  pool.on('connect', client => { physical.push(new Promise(resolve => client.once('end', resolve))); });
  const end = pool.end.bind(pool);
  pool.end = async () => {
    const tolerateShutdownNotice = error => { if (error?.code !== SERVER_SHUTDOWN_SQLSTATE) throw error; };
    pool.on('error', tolerateShutdownNotice);
    try {
      await end();
      await Promise.all(physical);
    } finally { pool.off('error', tolerateShutdownNotice); }
  };
  return pool;
}
