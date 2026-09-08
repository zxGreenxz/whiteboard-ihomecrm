#!/usr/bin/env node
// Real evidence is produced only by the attested headless ChatPanel fleet spec.
// The former direct one-round provider/routing script is intentionally removed.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
import { selectCaseIds } from './copilot-golden-browser-evidence.mjs';
function verifiedHarnessSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const sha = result.stdout.trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Cannot attest harness checkout HEAD');
  if (process.env.COPILOT_HARNESS_SHA && process.env.COPILOT_HARNESS_SHA !== sha) throw new Error('Declared harness SHA differs from checkout HEAD');
  return sha;
}
const args = process.argv.slice(2);
let selected;
try {
  if (args.includes('--case-ids')) selected = selectCaseIds(JSON.parse(readFileSync(resolve(root, 'tooling/copilot-golden-scenarios.json'), 'utf8')), args[args.indexOf('--case-ids') + 1]?.split(','));
} catch { console.error('Invalid --case-ids selection; no browser/model call was made.'); process.exit(2); }
const option = name => args[args.indexOf(name) + 1];
const allowed = new Set(['--results-out', '--attestation', '--case-ids']);
if (args.length % 2 || new Set(args.filter((_,i) => i % 2 === 0)).size !== args.length / 2 || args.some((arg, index) => index % 2 === 0 && !allowed.has(arg))) {
  console.error('Real golden lane is full-corpus: only --results-out, --attestation and explicit --case-ids are accepted (default full-corpus). Credentials use fleet environment variables.');
  process.exitCode = 2;
} else if (!args.includes('--results-out') || !args.includes('--attestation') || !existsSync(option('--attestation'))) {
  console.error('Missing --results-out or --attestation; no browser/model call was made.');
  process.exitCode = 2;
} else {
  if (existsSync(option('--results-out'))) {
    console.error('Existing checkpoint retained. Cross-browser resume cannot reuse observations; use a new results path after reconciling cleanup.');
    process.exit(2);
  }
  const cli = resolve(root, 'node_modules/@playwright/test/cli.js');
  if (!existsSync(cli)) { console.error('Install isolated workspace dependencies first.'); process.exitCode = 2; }
  else {
    let harnessSha;
    try { harnessSha = verifiedHarnessSha(); } catch (error) { console.error(error instanceof Error ? error.message : 'Cannot attest harness checkout HEAD'); process.exit(2); }
    const result = spawnSync(process.execPath, [cli, 'test', '--config', 'golden.config.ts'], {
      cwd: resolve(root, '.e2e-fleet'), stdio: 'inherit',
      env: { ...process.env, COPILOT_HARNESS_SHA: harnessSha, COPILOT_GOLDEN_CASE_IDS: selected?.join(',') ?? '', COPILOT_GOLDEN_RESULTS: resolve(option('--results-out')), COPILOT_GOLDEN_ATTESTATION: resolve(option('--attestation')), FLEET_WORKERS: '1' },
    });
    process.exitCode = result.status ?? 2;
  }
}
