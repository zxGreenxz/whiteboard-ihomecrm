#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGate } from './lib/gate-registry.mjs';
import { executeGateJob } from './lib/ci-gate-execution.mjs';
import { indexInputConflicts } from './lib/local-gate-snapshot.mjs';

const jobId = process.argv[process.argv.indexOf('--job') + 1];
if (!process.argv.includes('--job') || !/^[a-z0-9-]+$/.test(jobId)) throw new Error('Required --job <job-id>');
const plan = JSON.parse(readFileSync('.gate-evidence/plan.json', 'utf8'));
if (plan.executionMismatches?.length) throw new Error('Plan contains execution input mismatches');
const root = process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== plan.snapshot.head || git('rev-parse', 'HEAD^{tree}') !== plan.snapshot.tree) throw new Error('Checkout differs from planned tested SHA/tree');
const assertSnapshot = () => {
  if (git('write-tree') !== plan.snapshot.tree) throw new Error('CI index differs from planned tree');
  const changed = indexInputConflicts(root, [...plan.inputPatterns, ...plan.inputPaths]);
  if (changed.length) throw new Error('CI disk inputs differ from planned index: ' + changed.join(', '));
};
assertSnapshot();
const runtimePolicy = JSON.parse(readFileSync('tooling/runtime-matrix.json', 'utf8')).workflows.find((row) => row.path === '.github/workflows/ci-gates.yml');
if (process.version !== `v${runtimePolicy.node}`) throw new Error(`Wrong Node runtime: ${process.version}`);
if (plan.gateIds.some((id) => { const gate = getGate(id, plan); return gate.job === jobId && gate.command === 'deno'; })) {
  const deno = execFileSync('deno', ['--version'], { encoding: 'utf8' }).split('\n')[0].split(' ')[1];
  if (deno !== runtimePolicy.deno) throw new Error(`Wrong Deno runtime: ${deno}`);
}
const runId = `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`;
if (plan.runId !== runId) throw new Error('Plan belongs to a different workflow run/attempt');
const result = executeGateJob({ plan, jobId, getGate, runId, root, reusableReceipts: plan.reusableReceipts, trustedRunIds: plan.trustedRunIds });
const directory = join('.gate-evidence', jobId);
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'receipts.json'), JSON.stringify(result.receipts, null, 2) + '\n');
assertSnapshot();
process.exitCode = result.exitCode;
