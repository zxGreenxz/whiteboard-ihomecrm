import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// PostgreSQL is the external boundary. This double preserves session-level
// advisory ownership separately from the durable row, including abrupt loss.
const db = vi.hoisted(() => ({ sessions: [], owner: null, marker: null, signal: null, events: [] }));
vi.mock('../test-env/lib.mjs', async importOriginal => ({
  ...await importOriginal(),
  batBuocDichTest: async () => {},
  testEnvSignal: () => db.signal.signal,
  PhienPsql: class {
    constructor() { this.p = new EventEmitter(); this.closed = false; db.sessions.push(this); }
    async chay(sql) {
      if (this.closed) throw new Error('session closed');
      if (sql.includes('pg_try_advisory_lock')) {
        if (db.owner && db.owner !== this) return 'f';
        db.owner = this; db.events.push('lock'); return 't';
      }
      if (/CREATE TABLE|REVOKE/.test(sql)) return '';
      if (/SELECT token::text/.test(sql)) return db.marker ?? '';
      if (/INSERT INTO test_env.active_run/.test(sql)) {
        if (db.owner !== this || db.marker) throw new Error('duplicate or unlocked marker');
        db.marker = sql.match(/'([a-f0-9-]{36})'/)[1]; db.events.push('mark'); db.afterMark?.(); return db.marker;
      }
      if (/DELETE FROM test_env.active_run/.test(sql)) {
        if (db.owner !== this) throw new Error('unlocked delete');
        if (!sql.includes(db.marker)) return '';
        const old = db.marker; db.marker = null; db.events.push('clear'); db.afterClear?.(); return old;
      }
      if (sql === 'SELECT 1;') return '1';
      throw new Error(`Unexpected SQL: ${sql}`);
    }
    lose() { this.closed = true; if (db.owner === this) db.owner = null; this.p.emit('exit', 1); }
    async dong() { if (db.owner === this) db.owner = null; this.closed = true; db.events.push('unlock'); }
  },
}));
import { assertTestLease, markTestCleanupRequired, withTestCleanup, withTestLock } from '../test-env/lock.mjs';

const context = { cred: {}, test: 'guarded-test-db' };
beforeEach(() => Object.assign(db, { sessions: [], owner: null, marker: null, signal: new AbortController(), events: [], afterMark: null, afterClear: null }));

describe('TEST durable run ownership', () => {
  it('cannot enter work if interrupted while persisting the token', async () => {
    db.afterMark = () => db.signal.abort(new Error('SIGINT at claim'));
    let entered = false;
    await expect(withTestLock(context, async () => { entered = true; })).rejects.toThrow('SIGINT at claim');
    expect(entered).toBe(false); expect(db.marker).toBeNull();
  });

  it('cannot certify success if interrupted while releasing its token', async () => {
    db.afterClear = () => db.signal.abort(new Error('SIGINT at release'));
    await expect(withTestLock(context, async () => 'PASS')).rejects.toThrow('SIGINT at release');
    expect(db.marker).toBeNull();
  });

  it('busy advisory lock prevents entry and closes the rejected connection', async () => {
    db.owner = {};
    let entered = false;
    await expect(withTestLock(context, async () => { entered = true; })).rejects.toThrow(/TEST/);
    expect(entered).toBe(false); expect(db.sessions[0].closed).toBe(true); expect(db.marker).toBeNull();
  });

  it('rejects forged, released and wrong-database capabilities', async () => {
    await expect(assertTestLease({}, context.test)).rejects.toThrow();
    let held;
    await withTestLock(context, async lease => {
      held = lease; await assertTestLease(lease, context.test);
      await expect(assertTestLease(lease, 'wrong-db')).rejects.toThrow();
    });
    await expect(assertTestLease(held, context.test)).rejects.toThrow();
  });

  it('blocks a second runner after advisory session loss while an old write is outstanding', async () => {
    let wrote = false;
    await expect(withTestLock(context, async lease => {
      markTestCleanupRequired(lease, context.test);
      db.sessions[0].lose();
      expect(lease.signal.aborted).toBe(true);
      await expect(assertTestLease(lease, context.test)).rejects.toThrow();
      await expect(withTestLock(context, async () => { wrote = true; })).rejects.toThrow(/active_run|chưa dọn/i);
      expect(wrote).toBe(false);
      // The old HTTP operation may finish here. Its durable marker must remain.
      db.events.push('write-settled');
    })).rejects.toThrow('Mất phiên giữ khoá TEST');
    expect(db.marker).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('reacquires only its token and completes cleanup before deleting marker and unlocking', async () => {
    await expect(withTestLock(context, async lease => {
      markTestCleanupRequired(lease, context.test);
      db.sessions[0].lose();
      await withTestCleanup(lease, context.test, async cleanupLease => {
        expect(cleanupLease.signal.aborted).toBe(false);
        await assertTestLease(cleanupLease, context.test);
        expect(db.owner).not.toBeNull(); expect(db.marker).not.toBeNull();
        await Promise.resolve(); db.events.push('cleanup');
      });
    })).rejects.toThrow('Mất phiên giữ khoá TEST');
    expect(db.marker).toBeNull();
    expect(db.events.slice(-3)).toEqual(['cleanup', 'clear', 'unlock']);
    await withTestLock(context, async () => {});
  });

  it('retains a failed cleanup marker even when the caller catches its error', async () => {
    await expect(withTestLock(context, async lease => {
      markTestCleanupRequired(lease, context.test);
      try { await withTestCleanup(lease, context.test, async () => { throw new Error('cleanup failed'); }); }
      catch { /* reporter collects the failure */ }
    })).rejects.toThrow(/cleanup|dọn/i);
    expect(db.marker).not.toBeNull();
    let entered = false;
    await expect(withTestLock(context, async () => { entered = true; })).rejects.toThrow();
    expect(entered).toBe(false);
  });

  it('never cleans or deletes another owner token after session loss', async () => {
    let cleaned = false;
    await expect(withTestLock(context, async lease => {
      markTestCleanupRequired(lease, context.test); db.sessions[0].lose();
      db.marker = '00000000-0000-4000-8000-000000000099';
      await withTestCleanup(lease, context.test, async () => { cleaned = true; });
    })).rejects.toThrow(/token/i);
    expect(cleaned).toBe(false); expect(db.marker).toBe('00000000-0000-4000-8000-000000000099');
  });

  it('aborts future work on SIGINT but permits asynchronous cleanup under the held lock', async () => {
    await expect(withTestLock(context, async lease => {
      markTestCleanupRequired(lease, context.test);
      db.signal.abort(new Error('SIGINT'));
      await expect(assertTestLease(lease, context.test)).rejects.toThrow('SIGINT');
      await withTestCleanup(lease, context.test, async cleanupLease => {
        await assertTestLease(cleanupLease, context.test);
        await Promise.resolve(); db.events.push('cleanup');
      });
    })).rejects.toThrow('SIGINT');
    expect(db.marker).toBeNull(); expect(db.events.slice(-3)).toEqual(['cleanup', 'clear', 'unlock']);
  });

  it('validation failure before fixture writes releases marker without manual recovery', async () => {
    await expect(withTestLock(context, async () => { throw new Error('snapshot stale'); })).rejects.toThrow('snapshot stale');
    expect(db.marker).toBeNull();
    await withTestLock(context, async () => {});
  });
});
