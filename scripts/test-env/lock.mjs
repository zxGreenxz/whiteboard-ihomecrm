import { batBuocDichTest, PhienPsql } from './lib.mjs';

// In-process capability: env flags and serialized objects cannot bypass the lock.
const leases = new WeakMap();
export async function assertTestLease(lease, test) {
  const entry = lease && leases.get(lease);
  if (!entry || entry.test !== test || entry.lost) throw new Error('Không còn giữ khoá TEST cho database này.');
  await entry.session.chay('SELECT 1;');
}

export async function withTestLock({ cred, test }, work) {
  await batBuocDichTest(cred, test);
  const session = new PhienPsql(test);
  const lease = Object.freeze({});
  const entry = { test, session, lost: false };
  const lost = () => { entry.lost = true; };
  session.p.once('exit', lost);
  try {
    const acquired = (await session.chay("SELECT pg_try_advisory_lock(hashtext('test-env-sync'));")).trim();
    if (acquired !== 't') throw new Error('TEST đang được đồng bộ/kiểm thử bởi lượt khác; dừng trước khi ghi.');
    leases.set(lease, entry);
    const result = await work(lease);
    await assertTestLease(lease, test);
    return result;
  } finally {
    leases.delete(lease);
    session.p.off('exit', lost);
    // Closing this dedicated session releases its session-level advisory lock.
    await session.dong();
  }
}
