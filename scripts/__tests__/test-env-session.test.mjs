import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal(),
  spawn: () => {
    const p = new EventEmitter();
    p.exitCode = null;
    p.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    p.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    p.stdin = { write() {}, end() {} };
    return p;
  },
}));
import { PhienPsql } from '../test-env/lib.mjs';

it('a dead lock session rejects later SQL and close never hangs', async () => {
  const session = new PhienPsql('test');
  session.p.exitCode = 1; session.p.emit('exit', 1); session.p.emit('close', 1);
  await expect(session.chay('SELECT 1;')).rejects.toThrow(/psql/);
  await session.dong();
}, 300);
