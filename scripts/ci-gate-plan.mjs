#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planFromGit } from './lib/gate-plan.mjs';
import { GATE_REGISTRY } from './lib/gate-registry.mjs';
import { selectEventSnapshot, trustedReuseRun } from './lib/ci-gate-execution.mjs';

const root = process.cwd();
const output = '.gate-evidence';
mkdirSync(output, { recursive: true });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) throw new Error('Checkout SHA differs from workflow SHA');
const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
// fetch-depth: 0 checks out every branch, so origin/production is local here.
let productionTip = null;
let productionIsAncestor = false;
if (process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/main') {
  try { productionTip = execFileSync('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/production^{commit}'], { cwd: root, encoding: 'utf8' }).trim(); } catch { productionTip = null; }
  if (productionTip) productionIsAncestor = spawnSync('git', ['merge-base', '--is-ancestor', productionTip, head], { cwd: root }).status === 0;
}
const selection = selectEventSnapshot({ eventName: process.env.GITHUB_EVENT_NAME, event, checkoutSha: head, ref: process.env.GITHUB_REF, productionTip, productionIsAncestor });
const plan = await planFromGit({ root, mode: 'commit', base: selection.base, head: selection.head, full: selection.full, environment: 'ci' });
plan.snapshot.baseReason = selection.reason;
plan.runId = `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`;
plan.trustedRunIds = [];
plan.reusableReceipts = [];

// Failure to obtain verified previous receipts only makes this run do more work.
if (process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/main' && process.env.GITHUB_RUN_ATTEMPT === '1' && process.env.GH_TOKEN) {
  try {
    const repository = process.env.GITHUB_REPOSITORY;
    const response = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/actions/workflows/ci-gates.yml/runs?event=pull_request&status=success&head_sha=${head}&per_page=20`], { encoding: 'utf8', timeout: 30_000 }));
    const run = response.workflow_runs?.find((candidate) => trustedReuseRun(candidate, { repository, sha: head }));
    if (run) {
      const folder = join(output, 'reuse');
      execFileSync('gh', ['run', 'download', String(run.id), '--repo', repository, '--pattern', `gate-receipts-*-attempt-${run.run_attempt}`, '--dir', folder], { timeout: 30_000, stdio: 'pipe' });
      const visit = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? visit(join(dir, entry.name)) : entry.name === 'receipts.json' ? JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) : []);
      plan.reusableReceipts = visit(folder);
      plan.trustedRunIds = [`${run.id}:${run.run_attempt}`];
    }
  } catch { console.log('No verified reusable receipts; selected gates will run.'); }
}
writeFileSync(join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `required_jobs=${JSON.stringify(plan.requiredJobs)}\nneeds_demo_browser=${plan.gateIds.includes('suite:e2e-personal-finance-demo')}\nneeds_docs_build=${plan.gateIds.includes('docs-build')}\nneeds_deno=${plan.gateIds.some((id) => GATE_REGISTRY[id]?.command === 'deno')}\n`);
}
console.log(JSON.stringify({ snapshot: plan.snapshot, profiles: plan.profiles, reasons: plan.reasons, gateIds: plan.gateIds, requiredJobs: plan.requiredJobs, fullFallback: plan.fullFallback, deferred: plan.deferred }, null, 2));
