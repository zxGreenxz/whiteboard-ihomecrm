import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const root = process.cwd();
const script = path.join(root, 'scripts/qr/benchmark.mjs');

async function invoke(args, extraEnv = {}) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-benchmark-test-'));
  try {
    let outcome;
    try { outcome = { ...(await exec(process.execPath, [script, ...args], { cwd: root, timeout: 120000, env: { ...process.env, TMP: scratch, TEMP: scratch, TMPDIR: scratch, ...extraEnv } })), code: 0 }; }
    catch (error) { outcome = { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
    const leftovers = await fs.readdir(scratch);
    return { ...outcome, leftovers, rows: (outcome.stdout ?? '').split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)) };
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

describe('synthetic benchmark CLI', () => {
  it.each([[], ['--baseline-ref'], ['--baseline-ref', 'no-such-qr-baseline'], ['--fixed', '--unknown']])('rejects invalid input before fixture/browser allocation: %j', async (...args) => {
    // An absent browser makes accidental fixture generation observable.
    const result = await invoke(args, { PLAYWRIGHT_BROWSERS_PATH: path.join(root, '.missing-qr-browser') });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"stage":"arguments"');
    expect(result.leftovers).toEqual([]);
  }, 15000);

  it('cleans owned scratch when fixture browser setup fails', async () => {
    const result = await invoke(['--fixed'], { PLAYWRIGHT_BROWSERS_PATH: path.join(root, '.missing-qr-browser') });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"stage":"fixtures"');
    expect(result.leftovers).toEqual([]);
  }, 15000);

});
