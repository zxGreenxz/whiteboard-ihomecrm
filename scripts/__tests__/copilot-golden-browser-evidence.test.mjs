import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as evidence from '../copilot-golden-browser-evidence.mjs';

const golden = JSON.parse(readFileSync(new URL('../../tooling/copilot-golden-eval.json', import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL('../../tooling/copilot-golden-scenarios.json', import.meta.url)));
const sha = 'a'.repeat(40), digest = 'b'.repeat(64);
const attestation = {
  buildSha: sha, edgeSourceDigest: digest, deployedEdgeSourceDigest: digest,
  providerModel: '9router:cx/gpt-5.6-luna(max)', organizationId: evidence.DEMO_ORG,
  corpusDigest: evidence.digest(golden), manifestDigest: evidence.digest(manifest),
  fixtureDigest: digest, policyDigest: digest, actorDigest: digest,
  observedAt: '2026-09-06T10:00:00.000Z', contextId: 'isolated-browser-1',
};

test('manifest accounts for every original case and distinguishes unfinished domain oracles', () => {
  assert.deepEqual(evidence.validateManifest(golden, manifest), []);
  assert.equal(manifest.cases.length, 75);
  assert.ok(manifest.cases.every(c => c.oracle && c.fixture && c.acceptance.length));
  assert.ok(manifest.cases.find(c => c.id === 'C64').conversationGroup === 'memory-lifecycle');
  assert.ok(manifest.cases.find(c => c.id === 'C73').fixture.includes('expense'));
  assert.ok(evidence.validateManifest(golden, { ...manifest, cases: manifest.cases.slice(1) }).length);
});

test('legacy inferred arrays are rejected even when all 75 statuses say pass', () => {
  assert.ok(evidence.validateBrowserRun(golden, manifest, golden.cases.map(c => ({ ...c, status: 'pass' }))).length);
});

test('a fresh run explicitly records all cases as pending and cannot pass', () => {
  const run = evidence.createRun(golden, manifest, attestation);
  assert.equal(run.cases.length, 75);
  assert.equal(run.cases.filter(c => c.status === 'pending').length, 75);
  assert.equal(evidence.summarizeRun(run).verdict, 'blocked');
  assert.equal(evidence.summarizeRun(run).latencyMs.p50, null);
  assert.deepEqual(evidence.validateBrowserRun(golden, manifest, run), []);
});

test('blocked result has no fabricated actual observations and cannot transition directly to pass', () => {
  const run = evidence.createRun(golden, manifest, attestation);
  evidence.transitionCase(run, 'C01', { status: 'blocked', reason: 'quota_exhausted' });
  assert.equal(run.cases[0].observed, undefined);
  assert.throws(() => evidence.transitionCase(run, 'C01', { status: 'pass' }), /transition/);
});

test('completed assistant text alone cannot pass a case without concrete oracle evidence', () => {
  const run = evidence.createRun(golden, manifest, attestation);
  evidence.transitionCase(run, 'C01', { status: 'running' });
  assert.throws(() => evidence.transitionCase(run, 'C01', {
    status: 'pass', observed: { answerDigest: digest, modelRounds: 1 },
  }), /evidence/);
});

test('complete allowlisted observations are accepted structurally, while fixture drift and unimplemented cases are rejected', () => {
  const run = evidence.createRun(golden, manifest, attestation);
  const scenario = manifest.cases[0];
  evidence.transitionCase(run, 'C01', { status: 'running' });
  evidence.transitionCase(run, 'C01', { status: 'pass', timing: {
    startedAt: '2026-09-06T10:00:00.000Z', completedAt: '2026-09-06T10:00:01.000Z', totalMs: 1000, humanWaitMs: 0, processingMs: 1000,
  }, observed: { answerDigest: digest, promptDigest: evidence.digest(scenario.prompt), promptTemplateDigest: evidence.digest(scenario.prompt),
    bindingDigest: digest, rpcDigest: digest, modelRounds: 2, toolResultLinked: true, finalAnswerMounted: true,
    readRpc: 'copilot_available_rooms_v1', businessWrites: 0, networkErrors: 0, oracleVersion: scenario.oracle } });
  assert.deepEqual(evidence.validateBrowserRun(golden, manifest, run), []);
  assert.throws(() => evidence.resumeRun(run, attestation), /cannot be reused/);
  const drift = structuredClone(run); drift.cases[0].observed.rpcDigest = 'c'.repeat(64);
  assert.ok(evidence.validateBrowserRun(golden, manifest, drift).some(e => /fixture/.test(e)));
  const unsupported = structuredClone(run); unsupported.cases[1] = { ...unsupported.cases[0], id: 'C02', oracle: manifest.cases[1].oracle };
  assert.ok(evidence.validateBrowserRun(golden, manifest, unsupported).some(e => /evidence/.test(e)));
});

test('provider failure latencies are excluded from successful quantiles and pending SLA stays pending', () => {
  const summary = evidence.summarizeRun({ cases: [
    { status: 'pass', timing: { totalMs: 1000, humanWaitMs: 200, processingMs: 800 } },
    { status: 'blocked', timing: { totalMs: 1, humanWaitMs: 0, processingMs: 1 } },
    { status: 'fail', timing: { totalMs: 10, humanWaitMs: 0, processingMs: 10 } },
  ] });
  assert.equal(summary.latencyMs.p50, 1000);
  assert.equal(summary.unsuccessfulLatencyMs.p50, 1);
  assert.equal(summary.sla.status, 'pending-owner-approval');
});

test('attestation drift, duplicate IDs, unknown fields and interrupted cleanup fail closed', () => {
  const run = evidence.createRun(golden, manifest, attestation);
  assert.throws(() => evidence.resumeRun(run, { ...attestation, providerModel: 'other:model' }), /attestation/);
  const duplicate = structuredClone(run); duplicate.cases[1].id = 'C01';
  assert.ok(evidence.validateBrowserRun(golden, manifest, duplicate).length);
  const privatePayload = structuredClone(run); privatePayload.raw = 'do not retain';
  assert.ok(evidence.validateBrowserRun(golden, manifest, privatePayload).length);
  run.cleanup.push({ caseId: 'C64', fixtureKey: 'memory-fixture', state: 'pending', cleanup: 'canonical-memory-delete' });
  assert.throws(() => evidence.resumeRun(run, attestation), /cleanup/);
});

test('checkpoint survives a roundtrip and resume never reuses previous pass or replays interrupted writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-evidence-'));
  try {
    const run = evidence.createRun(golden, manifest, attestation);
    evidence.transitionCase(run, 'C01', { status: 'running' });
    evidence.writeCheckpoint(join(dir, 'run.json'), run, golden, manifest);
    const restored = JSON.parse(readFileSync(join(dir, 'run.json')));
    assert.throws(() => evidence.resumeRun(restored, attestation), /interrupted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('building room scenario binds exactly one visible DEMO building and retains all room facts for exclusion checks', () => {
  const scenario = manifest.cases.find(c => c.id === 'C13');
  const payload = { buildings: [{ id: 'a', name: 'DEMO Toà A' }, { id: 'b', name: 'Other' }], rooms: [{ building_id: 'a', code: 'A101' }, { building_id: 'b', code: 'B101' }] };
  const bound = evidence.bindRoomScenario(scenario, payload);
  assert.ok(bound.prompt.includes('DEMO Toà A'));
  assert.ok(!bound.prompt.includes('{{'));
  assert.deepEqual(bound.payload.buildings.map(b => b.id), ['a']);
  assert.deepEqual(bound.buildingScope, { id: 'a', name: 'DEMO Toà A' });
  assert.equal(bound.payload.rooms.length, 2);
  assert.throws(() => evidence.bindRoomScenario(scenario, { ...payload, buildings: [] }), /fixture_unbound/);
  assert.throws(() => evidence.bindRoomScenario(scenario, { ...payload, buildings: [payload.buildings[0], payload.buildings[0]] }), /fixture_unbound/);
});

test('structured quota and rate errors classify without retaining raw provider text', () => {
  for (const code of ['quota_exhausted','insufficient_quota','daily_quota','daily_token_quota']) {
    assert.equal(evidence.providerFailureReason({ code, message: 'private upstream payload' }), 'quota_exhausted');
  }
  for (const code of ['rate_limited','rate_limit_exceeded','rate_limit_error']) {
    assert.equal(evidence.providerFailureReason({ code }), 'rate_exhausted');
  }
  assert.equal(evidence.providerFailureReason({ type: 'rate_limit_error' }), 'rate_exhausted');
  assert.equal(evidence.providerFailureReason({ code: 429 }), 'rate_exhausted');
  assert.equal(evidence.providerFailureReason({ code: 'unknown', message: 'quota_exhausted in prose is not a structured code' }), 'provider_failed');
});

test('model identity is explicit and shared with the fleet, not a duplicated cx-only allowlist', () => {
  for (const providerModel of ['9router:ag/gemini-3.6-flash-high(high)', '9router:ag/gemini-3.7-flash-high(high)', '9router:ag/gemini-3.8-flash(high)']) {
    const run = evidence.createRun(golden, manifest, { ...attestation, providerModel });
    assert.equal(run.attestation.providerModel, providerModel);
  }
  for (const providerModel of ['', '9router:raw private payload', 'other:ag/model']) {
    assert.throws(() => evidence.createRun(golden, manifest, { ...attestation, providerModel }), /attestation/);
  }
});

test('building scope rejects missing, non-string and empty IDs from unknown RPC payloads', () => {
  const scenario = manifest.cases.find(c => c.id === 'C13');
  for (const id of [undefined, null, 0, 123, {}, ['a'], '', ' ']) {
    assert.throws(() => evidence.bindRoomScenario(scenario, {
      buildings: [{ id, name: 'DEMO Toà A' }], rooms: [],
    }), /fixture_unbound/, `building ID ${JSON.stringify(id)} must not become a typed scope`);
  }
  assert.throws(() => evidence.bindRoomScenario(scenario, { buildings: [null], rooms: [] }), /fixture_unbound/);
});

test('attestation rejects coercible non-string fields before returning a typed run', () => {
  for (const [field, value] of Object.entries(attestation)) {
    for (const malformed of [undefined, null, 0, 123, [value], new String(value)]) {
      assert.throws(() => evidence.createRun(golden, manifest, { ...attestation, [field]: malformed }),
        /attestation/, `${field} must be a primitive string`);
    }
  }
});

test('unknown manifest inputs cannot create cases with unvalidated scenario fields', () => {
  for (const field of ['id', 'fixture', 'oracle', 'kind', 'prompt']) {
    for (const malformed of [undefined, null, 123, [manifest.cases[0][field]], '']) {
      const changed = structuredClone(manifest), corpus = structuredClone(golden);
      changed.cases[0][field] = malformed;
      if (field === 'id') corpus.cases[0].id = malformed;
      assert.ok(evidence.validateManifest(corpus, changed).length, `${field} must be a nonempty string`);
      assert.throws(() => evidence.createRun(corpus, changed, {
        ...attestation, corpusDigest: evidence.digest(corpus), manifestDigest: evidence.digest(changed),
      }), /manifest/);
    }
  }
  for (const acceptance of [undefined, null, 'claim', [], [123], [null], ['']]) {
    const changed = structuredClone(manifest); changed.cases[0].acceptance = acceptance;
    assert.ok(evidence.validateManifest(golden, changed).length, 'acceptance must contain nonempty strings');
  }
  for (const malformed of [null, {}, { cases: null }, { cases: [null] }]) {
    assert.ok(evidence.validateManifest(malformed, manifest).length);
    assert.ok(evidence.validateBrowserRun(malformed, manifest, {}).length);
  }
  const changed = structuredClone(manifest); changed.cases[0] = null;
  assert.ok(evidence.validateManifest(golden, changed).length);
  assert.ok(evidence.validateBrowserRun(golden, changed, {}).length);
});

function passedRoomRun() {
  const run = evidence.createRun(golden, manifest, attestation);
  evidence.transitionCase(run, 'C01', { status: 'running' });
  evidence.transitionCase(run, 'C01', { status: 'pass', timing: {
    startedAt: '2026-09-06T10:00:00.000Z', completedAt: '2026-09-06T10:00:01.000Z',
    totalMs: 1000, humanWaitMs: 0, processingMs: 1000,
  }, observed: {
    answerDigest: digest, promptDigest: digest, promptTemplateDigest: evidence.digest(manifest.cases[0].prompt),
    bindingDigest: digest, rpcDigest: digest, modelRounds: 2, toolResultLinked: true, finalAnswerMounted: true,
    readRpc: 'copilot_available_rooms_v1', businessWrites: 0, networkErrors: 0, oracleVersion: 'available-rooms-v1',
  } });
  run.cleanup.push({ caseId: 'C64', fixtureKey: 'memory-fixture', state: 'done', cleanup: 'canonical-memory-delete' });
  return run;
}

test('checkpoint validation rejects coercible identity, timing, observation and cleanup fields', () => {
  const run = passedRoomRun();
  assert.deepEqual(evidence.validateBrowserRun(golden, manifest, run), []);
  for (const fields of [
    ['runId', 'createdAt', 'updatedAt'], ['startedAt', 'completedAt'],
    ['answerDigest', 'promptDigest', 'promptTemplateDigest', 'bindingDigest', 'rpcDigest'],
    ['caseId', 'fixtureKey', 'state', 'cleanup'],
  ]) {
    for (const field of fields) {
      const changed = structuredClone(run);
      const target = fields[0] === 'runId' ? changed : fields[0] === 'startedAt' ? changed.cases[0].timing
        : fields[0] === 'answerDigest' ? changed.cases[0].observed : changed.cleanup[0];
      target[field] = [target[field]];
      assert.ok(evidence.validateBrowserRun(golden, manifest, changed).length, `${field} must reject array coercion`);
    }
  }
  const numeric = structuredClone(run);
  numeric.cases[0].timing = { startedAt: 0, completedAt: 0, totalMs: 0, humanWaitMs: 0, processingMs: 0 };
  assert.ok(evidence.validateBrowserRun(golden, manifest, numeric).length, 'numeric timestamps must be rejected');
  for (const field of ['fixtureKey', 'cleanup']) {
    const changed = structuredClone(run); changed.cleanup[0][field] = 123;
    assert.ok(evidence.validateBrowserRun(golden, manifest, changed).length, `${field} must reject numeric IDs`);
  }
});

test('checkpoint validation rejects malformed optional fields even on unfinished cases', () => {
  const run = evidence.createRun(golden, manifest, attestation);
  for (const [field, malformed] of [['reason', 123], ['reason', null], ['timing', null], ['timing', 0], ['timing', false], ['timing', '']]) {
    const changed = structuredClone(run); changed.cases[0][field] = malformed;
    assert.ok(evidence.validateBrowserRun(golden, manifest, changed).length, `${field} must be validated when present`);
  }
  const changed = structuredClone(run); changed.cases[0] = null;
  assert.ok(evidence.validateBrowserRun(golden, manifest, changed).length);
});

test('valid string boundaries preserve C01, C13 and checkpoint roundtrips', () => {
  const payload = { buildings: [{ id: 'building-a', name: 'DEMO Toà A' }], rooms: [] };
  for (const id of ['C01', 'C13']) {
    const bound = evidence.bindRoomScenario(manifest.cases.find(c => c.id === id), payload);
    assert.equal(typeof bound.prompt, 'string');
    assert.match(bound.bindingDigest, /^[a-f0-9]{64}$/);
    if (id === 'C13') assert.equal(bound.buildingScope.id.toUpperCase(), 'BUILDING-A');
  }
  const run = passedRoomRun();
  assert.ok(Object.values(run.attestation).every(value => typeof value === 'string'));
  assert.equal(run.attestation.contextId.toUpperCase(), 'ISOLATED-BROWSER-1');
  const dir = mkdtempSync(join(tmpdir(), 'copilot-typed-evidence-'));
  try {
    const path = join(dir, 'run.json');
    evidence.writeCheckpoint(path, run, golden, manifest);
    const restored = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(evidence.validateBrowserRun(golden, manifest, restored), []);
    assert.equal(restored.cases[0].timing.startedAt.slice(0, 10), '2026-09-06');
    assert.equal(evidence.summarizeRun(restored).verdict, 'blocked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
