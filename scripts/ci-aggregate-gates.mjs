#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGate } from './lib/gate-registry.mjs';
import { aggregateGateEvidence } from './lib/gate-evidence.mjs';

let plan;
let receipts = [];
const extraFailures = [];
try { plan = JSON.parse(readFileSync('.gate-evidence/plan.json', 'utf8')); } catch { extraFailures.push('Preflight plan artifact unavailable'); }
try {
  const visit = (dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? visit(join(dir, entry.name)) : entry.name === 'receipts.json' ? JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) : []) : [];
  receipts = visit('.gate-receipts');
} catch { extraFailures.push('Invalid receipt artifact'); }
const runId = `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`;
const jobs = JSON.parse(process.env.CI_JOB_RESULTS || '{}');
if (jobs.preflight?.result !== 'success') extraFailures.push('Preflight did not succeed');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (plan?.snapshot.head !== head || plan?.runId !== runId) extraFailures.push('Plan checkout/run mismatch');
const registry = {};
for (const id of plan?.gateIds ?? []) {
  try { registry[id] = getGate(id, plan); } catch { extraFailures.push(`Cannot resolve ${id}`); }
}
const aggregate = aggregateGateEvidence({ plan, receipts, jobs, registry, runId, trustedRunIds: plan?.trustedRunIds, runtime: { node: process.version } });
aggregate.failures.push(...extraFailures);
aggregate.status = aggregate.failures.length ? 'failed' : 'passed';
aggregate.releaseReady = aggregate.status === 'passed' && aggregate.requiredExternalWorkflows.length === 0;
mkdirSync('.gate-evidence', { recursive: true });
writeFileSync('.gate-evidence/aggregate.json', JSON.stringify(aggregate, null, 2) + '\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Gate aggregate: **${aggregate.status}**\n\nTested SHA: \`${head}\`\n\n${aggregate.failures.map((failure) => `- ${failure}`).join('\n')}\n\nExternal workflow evidence still required at promotion: ${JSON.stringify(aggregate.requiredExternalWorkflows)}\n`);
console.log(JSON.stringify(aggregate, null, 2));
if (process.env.GITHUB_STEP_SUMMARY && aggregate.browserRequirements.length) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nCI xác nhận kiểm kỹ thuật. Kiểm UI/viewport/console ở local cần bằng chứng riêng:\n\n${aggregate.browserRequirements.map((item) => `- ${item.reason}; viewport: ${item.viewports.join(', ')}`).join('\n')}\n`);
process.exitCode = aggregate.status === 'passed' ? 0 : 1;
