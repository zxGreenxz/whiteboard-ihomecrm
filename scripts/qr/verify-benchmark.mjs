// Explicit browser smoke; intentionally outside the portable CI Vitest suite.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile), root = process.cwd();
const script = path.join(root, 'scripts/qr/benchmark.mjs');
const moduleUrl = pathToFileURL(script).href;
async function run(args) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-benchmark-smoke-'));
  try {
    let result;
    try { result = { ...(await exec(process.execPath, args, { cwd: root, timeout: 120000, env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch } })), code: 0 }; }
    catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    assert.deepEqual(await fs.readdir(scratch), [], 'benchmark must clean owned scratch');
    return { ...result, rows: result.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)) };
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

for (const args of [['--fixed'], ['--baseline-ref', '1d6523fb']]) {
  const result = await run([script, ...args]);
  assert.equal(result.code, 0, result.stderr);
  const engines = args.includes('--fixed') ? ['fixed'] : ['baseline', 'fixed'];
  assert.deepEqual([...new Set(result.rows.map((row) => row.engine))], engines);
  assert.equal(result.rows.length, engines.length * 6);
  for (const row of result.rows) {
    assert.ok(Number.isFinite(row.elapsedMs));
    assert.equal(row.wrongPayload, false);
    assert.ok(['decoded', 'not-found'].includes(row.terminationReason));
    if (row.engine === 'fixed') assert.equal(row.success, true, row.caseId);
  }
  console.log(JSON.stringify({ probe: args.join(' '), rows: result.rows.length, fixedSuccess: result.rows.filter((row) => row.engine === 'fixed' && row.success).length, cleanup: true }));
}

// Build failure, browser launch failure after server listen, and a failing close
// all exit naturally with no server/browser or scratch left behind.
for (const [stage, dependency] of [
  ['build', 'buildCurrent: async () => { throw new Error("synthetic build failure"); }'],
  ['browser', 'launchBrowser: async () => { throw new Error("synthetic browser failure"); }'],
  ['cleanup', 'launchBrowser: async () => ({ newPage: async () => { throw new Error("synthetic page failure"); }, close: async () => { throw new Error("synthetic close failure"); } })'],
]) {
  const result = await run(['--input-type=module', '-e', `import { runBenchmark } from ${JSON.stringify(moduleUrl)}; try { await runBenchmark(['--fixed'], { ${dependency} }); } catch (error) { console.error(JSON.stringify({stage:error.stage})); process.exitCode=1; }`]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(`"stage":"${stage}"`), result.stderr);
  console.log(JSON.stringify({ probe: `${stage}-failure`, cleanup: true }));
}

const failure = await run(['--input-type=module', '-e', `
  import { runBenchmark } from ${JSON.stringify(moduleUrl)};
  import { chromium } from 'playwright';
  const result = await runBenchmark(['--fixed'], { launchBrowser: async () => {
    const browser = await chromium.launch({headless:true});
    return { close: () => browser.close(), newPage: async (options) => {
      const page = await browser.newPage(options);
      await page.route('**/assets/qr.worker-*.js', route => route.abort());
      return page;
    }};
  }});
  if(result.failed) process.exitCode=1;
`]);
assert.equal(failure.code, 1, failure.stderr);
assert.equal(failure.rows.length, 6);
for (const row of failure.rows) {
  assert.equal(row.terminationReason, 'engine-unavailable');
  assert.equal(row.success, false);
  assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs < 20000);
}
console.log(JSON.stringify({ probe: 'worker-load-failure', rows: failure.rows.length, structuredFailure: true, cleanup: true }));
