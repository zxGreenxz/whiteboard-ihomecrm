import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
export const IMPLEMENTED_ORACLES = new Set(['available-rooms-v1', 'available-rooms-building-v1']);
const HASH = /^[0-9a-f]{64}$/;
const STATES = ['pending', 'running', 'pass', 'fail', 'blocked'];
const REASONS = new Set(['oracle_not_implemented', 'fixture_unbound', 'preflight_missing', 'attestation_failed',
  'quota_exhausted', 'rate_exhausted', 'provider_failed', 'browser_failed', 'oracle_failed', 'cleanup_required']);
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function bindRoomScenario(scenario, payload) {
  if (!Array.isArray(payload?.buildings) || !Array.isArray(payload?.rooms)) throw new Error('fixture_unbound');
  if (scenario.id === 'C01') return { prompt: scenario.prompt, payload, bindingDigest: digest(payload.buildings) };
  if (scenario.id !== 'C13') throw new Error('oracle_not_implemented');
  const buildings = payload.buildings.filter(b => b.name === 'DEMO Toà A');
  if (buildings.length !== 1) throw new Error('fixture_unbound');
  return { prompt: scenario.prompt.replace('{{building.name}}', buildings[0].name), payload: { ...payload, buildings }, bindingDigest: digest(buildings) };
}
function keysOnly(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)); }
function exactIds(a, b) { return JSON.stringify(a?.map(c => c?.id)) === JSON.stringify(b?.map(c => c?.id)); }

export function validateManifest(golden, manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== 1 || manifest?.scope !== 'full-corpus' || !Array.isArray(manifest?.cases)) return ['invalid manifest'];
  if (!exactIds(golden.cases, manifest.cases) || new Set(manifest.cases.map(c => c.id)).size !== manifest.cases.length) errors.push('manifest must cover every corpus ID exactly once in order');
  for (const c of manifest.cases) {
    if (!c.fixture || !c.oracle || !c.kind || !Array.isArray(c.acceptance) || !c.acceptance.length) errors.push(`${c.id}: fixture and oracle acceptance required`);
  }
  return errors;
}

function validAttestation(a) {
  if (!keysOnly(a, ['buildSha','edgeSourceDigest','deployedEdgeSourceDigest','providerModel','organizationId','corpusDigest','manifestDigest','fixtureDigest','policyDigest','actorDigest','observedAt','contextId'])) return false;
  return /^[0-9a-f]{40}$/.test(a.buildSha) && a.organizationId === DEMO_ORG
    && /^9router:cx\/gpt-5\.(?:6-(?:luna|terra)(?:-review)?\(max\)|5(?:-review)?)$/.test(a.providerModel)
    && ['edgeSourceDigest','deployedEdgeSourceDigest','corpusDigest','manifestDigest','fixtureDigest','policyDigest','actorDigest'].every(k => HASH.test(a[k]))
    && a.edgeSourceDigest === a.deployedEdgeSourceDigest && Number.isFinite(Date.parse(a.observedAt))
    && /^[a-zA-Z0-9-]{1,100}$/.test(a.contextId);
}

export function createRun(golden, manifest, attestation) {
  if (validateManifest(golden, manifest).length || !validAttestation(attestation)
    || attestation.corpusDigest !== digest(golden) || attestation.manifestDigest !== digest(manifest)) throw new Error('invalid attestation or manifest');
  return { schemaVersion: 2, lane: 'real-model', executor: 'attested-chat-panel-v1', attestation,
    runId: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    cases: manifest.cases.map(c => ({ id: c.id, oracle: c.oracle, status: 'pending' })), cleanup: [] };
}

function validTiming(t) {
  return keysOnly(t, ['startedAt','completedAt','totalMs','humanWaitMs','processingMs'])
    && ['totalMs','humanWaitMs','processingMs'].every(k => Number.isFinite(t[k]) && t[k] >= 0)
    && Number.isFinite(Date.parse(t.startedAt)) && Number.isFinite(Date.parse(t.completedAt))
    && Date.parse(t.completedAt) >= Date.parse(t.startedAt)
    && Math.abs(Date.parse(t.completedAt) - Date.parse(t.startedAt) - t.totalMs) <= 2
    && Math.abs(t.totalMs - t.humanWaitMs - t.processingMs) <= 2;
}

function validPass(c) {
  const o = c.observed;
  return ['C01','C13'].includes(c.id) && IMPLEMENTED_ORACLES.has(c.oracle) && validTiming(c.timing)
    && keysOnly(o, ['answerDigest','promptDigest','promptTemplateDigest','bindingDigest','rpcDigest','modelRounds','toolResultLinked','finalAnswerMounted','readRpc','businessWrites','networkErrors','oracleVersion'])
    && ['answerDigest','promptDigest','promptTemplateDigest','bindingDigest','rpcDigest'].every(k => HASH.test(o[k]))
    && Number.isInteger(o.modelRounds) && o.modelRounds >= 2 && o.toolResultLinked === true && o.finalAnswerMounted === true
    && o.readRpc === 'copilot_available_rooms_v1' && o.oracleVersion === c.oracle
    && o.businessWrites === 0 && o.networkErrors === 0;
}

export function validateBrowserRun(golden, manifest, run) {
  const errors = validateManifest(golden, manifest);
  if (!keysOnly(run, ['schemaVersion','lane','executor','attestation','runId','createdAt','updatedAt','cases','cleanup'])
    || run.schemaVersion !== 2 || run.lane !== 'real-model' || run.executor !== 'attested-chat-panel-v1') return [...errors, 'actual browser evidence schema v2 required; legacy inferred artifacts are invalid'];
  if (!validAttestation(run.attestation) || run.attestation.corpusDigest !== digest(golden) || run.attestation.manifestDigest !== digest(manifest)) errors.push('attestation mismatch');
  if (!/^[0-9a-f-]{36}$/.test(run.runId) || ![run.createdAt,run.updatedAt].every(t => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t))) errors.push('invalid run identity/timestamps');
  if (!Array.isArray(run.cases) || !exactIds(golden.cases, run.cases)) return [...errors, 'case IDs missing, duplicated or out of order'];
  for (const [i,c] of run.cases.entries()) {
    if (!keysOnly(c, ['id','oracle','status','reason','timing','observed']) || !STATES.includes(c.status) || c.oracle !== manifest.cases[i].oracle) errors.push(`${c.id}: malformed case`);
    if (['blocked','fail'].includes(c.status) && !REASONS.has(c.reason)) errors.push(`${c.id}: reason required`);
    if (c.status === 'pass' && !validPass(c)) errors.push(`${c.id}: completed browser/oracle evidence required`);
    if (c.status === 'pass' && (c.observed?.promptTemplateDigest !== digest(manifest.cases[i].prompt) || c.observed?.rpcDigest !== run.attestation.fixtureDigest)) errors.push(`${c.id}: observed prompt/fixture differs from attestation`);
    if (c.status !== 'pass' && c.observed !== undefined) errors.push(`${c.id}: unsuccessful case cannot claim actual observations`);
    if (c.timing && !validTiming(c.timing)) errors.push(`${c.id}: invalid timing`);
  }
  if (!Array.isArray(run.cleanup) || run.cleanup.some(c => !keysOnly(c, ['caseId','fixtureKey','state','cleanup'])
    || !golden.cases.some(g => g.id === c.caseId) || !['pending','done'].includes(c.state)
    || !/^[a-z0-9-]{1,100}$/.test(c.fixtureKey) || !/^[a-z0-9-]{1,100}$/.test(c.cleanup))) errors.push('invalid cleanup journal');
  return errors;
}

export function transitionCase(run, id, update) {
  const c = run.cases.find(c => c.id === id);
  const transitions = { pending: ['running','blocked'], running: ['pass','fail','blocked'], blocked: [], pass: [], fail: [] };
  if (!c || !transitions[c.status]?.includes(update.status)) throw new Error('invalid case transition');
  const next = { ...c, ...update };
  if (next.status === 'pass' && !validPass(next)) throw new Error('completed browser/oracle evidence required');
  if (['blocked','fail'].includes(next.status) && !REASONS.has(next.reason)) throw new Error('invalid reason');
  Object.assign(c, update); run.updatedAt = new Date().toISOString();
}

/** Checkpoints preserve progress for review, but cannot silently reuse live passes
 * after a browser restart: auth, memory and DB context are not reproducible. */
export function resumeRun(run, attestation) {
  if (digest(run.attestation) !== digest(attestation)) throw new Error('attestation changed; start a new run');
  if (run.cleanup.some(c => c.state !== 'done')) throw new Error('cleanup pending; reconcile the durable journal first');
  if (run.cases.some(c => c.status === 'running')) throw new Error('interrupted case; reconcile before a new run');
  if (run.cases.some(c => c.status === 'pass')) throw new Error('previous live passes cannot be reused across browser contexts');
  return run;
}

export function writeCheckpoint(path, run, golden, manifest) {
  const errors = validateBrowserRun(golden, manifest, run);
  if (errors.length) throw new Error(`invalid checkpoint: ${errors.join('; ')}`);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(run, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
}

function quantiles(values) {
  values.sort((a,b) => a-b);
  const at = p => values.length ? values[Math.max(0, Math.ceil(values.length * p)-1)] : null;
  return { min: values[0] ?? null, p50: at(.5), p95: at(.95), max: values.at(-1) ?? null };
}
export function summarizeRun(run) {
  const counts = Object.fromEntries(STATES.map(s => [s, run.cases.filter(c => c.status === s).length]));
  const times = predicate => run.cases.filter(c => predicate(c) && Number.isFinite(c.timing?.totalMs)).map(c => c.timing.totalMs);
  return { total: run.cases.length, counts, latencyMs: quantiles(times(c => c.status === 'pass')),
    unsuccessfulLatencyMs: quantiles(times(c => c.status !== 'pass')),
    sla: { status: 'pending-owner-approval', p50: null, p95: null, max: null },
    verdict: 'blocked' }; // Owner SLA approval is still absent, even if every oracle passes.
}
