#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateGolden(golden) {
  const problems = [];
  if (golden?.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (!golden?.provenance?.buildShaRequired || !golden?.provenance?.providerModelRequired) {
    problems.push('build SHA and provider/model provenance must be required');
  }
  if (!Array.isArray(golden?.provenance?.lane) || !golden.provenance.lane.includes('mock') || !golden.provenance.lane.includes('real-model')) {
    problems.push('provenance lane must include mock and real-model');
  }
  const cases = Array.isArray(golden?.cases) ? golden.cases : [];
  const expectedIds = Array.from({ length: 30 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`);
  const actualIds = cases.map((item) => item?.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) problems.push('cases must be exactly C01-C30 in order');
  for (const item of cases) {
    if (!item?.input || !item?.expectedOutcome) problems.push(`${item?.id ?? '<unknown>'}: missing input/outcome`);
    if (!Array.isArray(item?.toolPath)) problems.push(`${item?.id ?? '<unknown>'}: toolPath must be an array`);
    if (typeof item?.forbidden !== 'boolean') problems.push(`${item?.id ?? '<unknown>'}: forbidden must be boolean`);
    if (item?.forbidden && item?.expectedOutcome !== 'forbidden') problems.push(`${item?.id ?? '<unknown>'}: forbidden case must expect forbidden outcome`);
    if (item?.emptyState !== 'explicit') problems.push(`${item?.id ?? '<unknown>'}: emptyState must be explicit`);
  }
  const sla = golden?.latencySlaMs;
  if (sla?.status !== 'pending-owner-approval') {
    for (const field of ['p50', 'p95', 'max']) {
      if (!Number.isFinite(sla?.[field]) || sla[field] <= 0) problems.push(`latency ${field} must be a positive number`);
    }
  }
  return problems;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const golden = JSON.parse(readFileSync(join(root, 'tooling', 'copilot-golden-eval.json'), 'utf8'));
  const problems = validateGolden(golden);
  if (problems.length) {
    console.error(`Copilot golden eval: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Copilot golden eval: ${golden.cases.length} cases validated; latency SLA ${golden.latencySlaMs.status}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
