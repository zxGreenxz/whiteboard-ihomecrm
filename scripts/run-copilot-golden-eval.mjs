#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LANES = new Set(['mock', 'real-model']);

export function validateRunProvenance(provenance) {
  const problems = [];
  if (!LANES.has(provenance?.lane)) problems.push('lane must be mock or real-model');
  if (!/^[0-9a-f]{40}$/i.test(String(provenance?.buildSha ?? ''))) problems.push('buildSha is required');
  if (!String(provenance?.providerModel ?? '').trim()) problems.push('providerModel is required');
  return problems;
}

function percentile(values, p) {
  if (!values.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * values.length));
  return values[Math.min(rank, values.length) - 1];
}

export function aggregateGoldenResults(results) {
  const counts = { pass: 0, partial: 0, fail: 0, blocked: 0 };
  const latencies = [];
  for (const result of results ?? []) {
    if (Object.hasOwn(counts, result?.status)) counts[result.status] += 1;
    else counts.blocked += 1;
    if (Number.isFinite(result?.latencyMs) && result.latencyMs >= 0) latencies.push(Number(result.latencyMs));
  }
  latencies.sort((a, b) => a - b);
  return {
    total: (results ?? []).length,
    counts,
    latencyMs: {
      min: latencies.length ? latencies[0] : null,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length ? latencies[latencies.length - 1] : null,
    },
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    out[key] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return out;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const golden = JSON.parse(readFileSync(join(root, 'tooling', 'copilot-golden-eval.json'), 'utf8'));
  const args = parseArgs(process.argv);
  const provenance = {
    lane: args.lane || process.env.COPILOT_GOLDEN_LANE,
    buildSha: args['build-sha'] || process.env.EXPECTED_SOURCE_SHA || process.env.VITE_BUILD_SHA,
    providerModel: args['provider-model'] || process.env.COPILOT_PROVIDER_MODEL,
  };
  const provenanceProblems = validateRunProvenance(provenance);
  if (provenanceProblems.length) {
    console.error(`Copilot golden eval blocked: ${provenanceProblems.join('; ')}`);
    process.exitCode = 2;
    return;
  }
  if (!args.results) {
    console.error('Copilot golden eval blocked: --results <json> is required; no live model is invoked implicitly.');
    process.exitCode = 2;
    return;
  }
  const cases = JSON.parse(readFileSync(String(args.results), 'utf8'));
  if (!Array.isArray(cases)) {
    console.error('Copilot golden eval blocked: results JSON must be an array.');
    process.exitCode = 2;
    return;
  }
  const expectedIds = golden.cases.map((item) => item.id);
  if (JSON.stringify(cases.map((item) => item?.id)) !== JSON.stringify(expectedIds)) {
    console.error('Copilot golden eval blocked: results must contain exactly C01-C30 in order.');
    process.exitCode = 2;
    return;
  }
  const aggregate = aggregateGoldenResults(cases);
  const slaReady = golden.latencySlaMs?.status !== 'pending-owner-approval';
  const verdict = !slaReady || aggregate.counts.fail > 0 || aggregate.counts.partial > 0 || aggregate.counts.blocked > 0
    ? 'blocked'
    : 'pass';
  const report = { schemaVersion: 1, provenance, aggregate, cases, verdict };
  if (args.out) writeFileSync(String(args.out), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
  if (verdict !== 'pass') process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
