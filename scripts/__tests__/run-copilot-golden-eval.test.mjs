import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateGoldenResults, validateRunProvenance } from '../run-copilot-golden-eval.mjs';

test('aggregates case results with latency percentiles and explicit counts', () => {
  const summary = aggregateGoldenResults([
    { id: 'C01', status: 'pass', latencyMs: 10 },
    { id: 'C02', status: 'partial', latencyMs: 20 },
    { id: 'C03', status: 'fail', latencyMs: 30 },
  ]);
  assert.equal(summary.counts.pass, 1);
  assert.equal(summary.counts.partial, 1);
  assert.equal(summary.counts.fail, 1);
  assert.equal(summary.latencyMs.min, 10);
  assert.equal(summary.latencyMs.p50, 20);
  assert.equal(summary.latencyMs.p95, 30);
  assert.equal(summary.latencyMs.max, 30);
});

test('rejects missing provenance instead of reporting a release verdict', () => {
  assert.deepEqual(validateRunProvenance({ lane: 'mock', buildSha: '', providerModel: '' }), [
    'buildSha is required',
    'providerModel is required',
  ]);
  assert.deepEqual(validateRunProvenance({ lane: 'unknown', buildSha: 'a'.repeat(40), providerModel: 'mock:test' }), [
    'lane must be mock or real-model',
  ]);
});
