import { randomUUID } from 'node:crypto';
import { batBuocDichTest, lit, PhienPsql, testEnvSignal } from './lib.mjs';

// The advisory session may die while an independent HTTP write is still running.
// Keep an owner token in TEST's durable schema until work and cleanup have settled.
// A leftover token is NEVER expired or deleted by another run.
const leases = new WeakMap();
const recovery = 'Giữ test_env.active_run; phải kiểm tra tiến trình/lệnh ghi đã dừng và dọn fixture thủ công trước khi xoá đúng token. Không tự khôi phục theo tuổi marker.';

function entryFor(lease, test, { allowAbort = false } = {}) {
  const capability = lease && leases.get(lease);
  if (!capability || capability.entry.test !== test) throw new Error('Không còn giữ khoá TEST cho database này.');
  if (!allowAbort) lease.signal.throwIfAborted();
  return capability.entry;
}

function attachSession(entry) {
  const session = new PhienPsql(entry.test);
  const lost = () => {
    entry.lost = true;
    entry.controller.abort(new Error('Mất phiên giữ khoá TEST; dừng công việc mới.'));
    entry.cleanupController?.abort(new Error('Mất phiên giữ khoá trong khi dọn TEST.'));
  };
  session.p.once('exit', lost);
  session.p.once('error', lost);
  entry.session = session;
  entry.detach = () => { session.p.off('exit', lost); session.p.off('error', lost); };
  return session;
}

async function query(entry, sql) {
  try { return await entry.session.chay(sql); }
  catch (error) {
    entry.lost = true;
    entry.controller.abort(error);
    entry.cleanupController?.abort(error);
    throw error;
  }
}

export async function assertTestLease(lease, test) {
  const entry = entryFor(lease, test);
  if (entry.lost) throw new Error('Không còn giữ khoá TEST cho database này.');
  await query(entry, 'SELECT 1;');
  lease.signal.throwIfAborted();
}

/** Call before the first fixture write, including an HTTP request with uncertain outcome. */
export function markTestCleanupRequired(lease, test) {
  const entry = entryFor(lease, test);
  if (entry.lost) throw new Error('Không còn giữ khoá TEST cho database này.');
  entry.pendingCleanup = true;
}

/** Work must await in-flight writes before entering cleanup; never retry those writes here. */
export async function withTestCleanup(lease, test, cleanup) {
  const entry = entryFor(lease, test, { allowAbort: true });
  if (entry.cleanupController) throw new Error('Một lượt dọn TEST khác đang chạy.');
  entry.pendingCleanup = true;
  entry.cleanupController = new AbortController();
  const cleanupLease = Object.freeze({ signal: entry.cleanupController.signal });
  leases.set(cleanupLease, { entry });
  try {
    if (entry.lost) {
      entry.detach();
      await entry.session.dong();
      attachSession(entry);
      if ((await query(entry, "SELECT pg_try_advisory_lock(hashtext('test-env-sync'));")).trim() !== 't') {
        throw new Error(`Không lấy lại được khoá TEST để dọn. ${recovery}`);
      }
      entry.lost = false;
    }
    const token = (await query(entry, 'SELECT token::text FROM test_env.active_run WHERE singleton;')).trim();
    if (token !== entry.token) throw new Error(`Token TEST không còn thuộc lượt này; từ chối dọn. ${recovery}`);
    await assertTestLease(cleanupLease, test);
    const result = await cleanup(cleanupLease);
    await assertTestLease(cleanupLease, test);
    entry.pendingCleanup = false;
    return result;
  } finally {
    leases.delete(cleanupLease);
    entry.cleanupController = null;
  }
}

export async function withTestLock({ cred, test }, work) {
  const shutdown = testEnvSignal();
  shutdown.throwIfAborted();
  await batBuocDichTest(cred, test);
  shutdown.throwIfAborted();
  const entry = { test, token: randomUUID(), controller: new AbortController(), lost: false, pendingCleanup: false };
  const interrupted = () => entry.controller.abort(shutdown.reason);
  shutdown.addEventListener('abort', interrupted, { once: true });
  const lease = Object.freeze({ signal: entry.controller.signal });
  attachSession(entry);
  let claimed = false, result, failure;
  try {
    const acquired = (await query(entry, "SELECT pg_try_advisory_lock(hashtext('test-env-sync'));")).trim();
    if (acquired !== 't') throw new Error('TEST đang được đồng bộ/kiểm thử bởi lượt khác; dừng trước khi ghi.');
    await query(entry, `CREATE TABLE IF NOT EXISTS test_env.active_run (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      token uuid NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), process_id integer NOT NULL
    );`);
    await query(entry, 'REVOKE ALL ON test_env.active_run FROM PUBLIC, anon, authenticated;');
    const prior = (await query(entry, 'SELECT token::text FROM test_env.active_run WHERE singleton;')).trim();
    if (prior) throw new Error(`TEST còn lượt chưa dọn (active_run token ${prior}). ${recovery}`);
    entry.controller.signal.throwIfAborted();
    const inserted = (await query(entry, `INSERT INTO test_env.active_run(singleton, token, process_id)
      VALUES (true, ${lit(entry.token)}, ${process.pid}) RETURNING token::text;`)).trim();
    if (inserted !== entry.token) throw new Error(`Không xác minh được token TEST vừa tạo. ${recovery}`);
    claimed = true;
    leases.set(lease, { entry });
    await assertTestLease(lease, test);
    result = await work(lease);
    await assertTestLease(lease, test);
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (claimed) {
        if (entry.lost || entry.pendingCleanup) {
          const message = `${failure ? `${failure.message} ` : ''}Chưa xác minh dọn TEST. ${recovery}`;
          failure = new Error(message, { cause: failure });
        } else {
          // A rejected read/assertion is safe to retry after completed cleanup.
          // Delete only our exact token while the advisory lock is still held.
          const deleted = (await query(entry, `DELETE FROM test_env.active_run WHERE singleton AND token=${lit(entry.token)} RETURNING token::text;`)).trim();
          if (deleted !== entry.token) throw new Error(`Token TEST đổi trước khi mở khoá. ${recovery}`);
        }
      }
    } catch (error) {
      failure = new Error(`${failure ? `${failure.message} ` : ''}${error.message}`, { cause: failure ?? error });
    } finally {
      leases.delete(lease);
      shutdown.removeEventListener('abort', interrupted);
      entry.detach();
      await entry.session.dong();
    }
  }
  if (failure) throw failure;
  shutdown.throwIfAborted();
  lease.signal.throwIfAborted();
  return result;
}
