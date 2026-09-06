#!/usr/bin/env node
// Real evidence is produced only by the attested headless ChatPanel fleet spec.
// The former direct one-round provider/routing script is intentionally removed.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const allowed = new Set(['--results-out', '--attestation']);
if (args.some((arg, index) => index % 2 === 0 && !allowed.has(arg))) {
  console.error('Real golden lane is full-corpus: only --results-out and --attestation are accepted. Credentials use fleet environment variables.');
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
    const result = spawnSync(process.execPath, [cli, 'test', '--config', 'golden.config.ts'], {
      cwd: resolve(root, '.e2e-fleet'), stdio: 'inherit',
      env: { ...process.env, COPILOT_GOLDEN_RESULTS: resolve(option('--results-out')), COPILOT_GOLDEN_ATTESTATION: resolve(option('--attestation')), FLEET_WORKERS: '1' },
    });
    process.exitCode = result.status ?? 2;
  }
}
