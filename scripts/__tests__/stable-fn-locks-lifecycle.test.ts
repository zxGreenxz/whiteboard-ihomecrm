import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Exercise the real CLI without credentials/network. A queued cleanup must run
// even when the catalog gate fails; abrupt exit can crash Windows fetch handles.
describe('stable function gate process lifecycle', () => {
  it.each([
    { status: 200, body: '[]', code: 0, message: 'OK —' },
    { status: 200, body: JSON.stringify([{ fn_name: 'bad_reader', volatility: 'STABLE', lock_from: 'writer' }]), code: 1, message: 'bad_reader' },
    { status: 503, body: 'catalog unavailable', code: 1, message: 'FAILED 503' },
  ])('drains cleanup with HTTP $status and exit $code', ({ status, body, code, message }) => {
    const gate = pathToFileURL(path.resolve('scripts/check-stable-fn-locks.mjs')).href;
    const script = `
      process.env.SUPABASE_PAT = 'synthetic-offline-token';
      globalThis.fetch = async () => {
        setTimeout(() => console.log('CLEANUP_DRAINED'), 20);
        return new Response(${JSON.stringify(body)}, { status: ${status} });
      };
      await import(${JSON.stringify(gate)});
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 10000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(code);
    expect(result.stdout + result.stderr).toContain(message);
    expect(result.stdout).toContain('CLEANUP_DRAINED');
  });
});
