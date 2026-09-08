import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
export const IMPLEMENTED_ORACLES = new Set(['customer-nguyen-an-v1', 'absent-synthetic-phone-v1', 'available-rooms-v1', 'available-rooms-building-v1', 'contract-code-v1', 'absent-customer-contract-v1', 'contract-code-detail-v1', 'vouchers-2026-07-v1', 'empty-expenses-2099-01-v1', 'pending-approval-inbox-v1']);
const HASH = /^[0-9a-f]{64}$/;
const STATES = ['pending', 'running', 'pass', 'fail', 'blocked', 'not_selected'];
const REASONS = new Set(['oracle_not_implemented', 'fixture_unbound', 'preflight_missing', 'attestation_failed',
  'quota_exhausted', 'rate_exhausted', 'provider_failed', 'browser_failed', 'oracle_failed', 'cleanup_required']);
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Only structured provider codes, never prose or a retained upstream payload. */
export function providerFailureReason(error) {
  const code = String(error?.code ?? error?.type ?? '').toLowerCase();
  if (['quota_exhausted','quota_exceeded','insufficient_quota','daily_quota','daily_token_quota'].includes(code)) return 'quota_exhausted';
  if (['429','rate_limited','rate_limit_exceeded','rate_limit_error','too_many_requests','busy'].includes(code)) return 'rate_exhausted';
  return 'provider_failed';
}
export function bindRoomScenario(scenario, payload) {
  if (!Array.isArray(payload?.buildings) || !Array.isArray(payload?.rooms)) throw new Error('fixture_unbound');
  if (scenario.id === 'C01') return { prompt: scenario.prompt, payload, bindingDigest: digest(payload.buildings) };
  if (scenario.id !== 'C13') throw new Error('oracle_not_implemented');
  const buildings = payload.buildings.filter(b => b?.name === 'DEMO Toà A');
  if (buildings.length !== 1 || !nonemptyString(buildings[0].id)) throw new Error('fixture_unbound');
  return { prompt: scenario.prompt.replace('{{building.name}}', buildings[0].name), payload: { ...payload, buildings },
    buildingScope: { id: buildings[0].id, name: buildings[0].name }, bindingDigest: digest(buildings) };
}
function keysOnly(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)); }
function nonemptyString(value) { return typeof value === 'string' && value.trim().length > 0; }
function exactIds(a, b) { return JSON.stringify(a?.map(c => c?.id)) === JSON.stringify(b?.map(c => c?.id)); }

export function validateManifest(golden, manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== 1 || manifest?.scope !== 'full-corpus' || !Array.isArray(manifest?.cases)) return ['invalid manifest'];
  if (!Array.isArray(golden?.cases) || !golden.cases.every(c => nonemptyString(c?.id))) return ['invalid corpus IDs'];
  for (const c of manifest.cases) {
    if (!['id','fixture','oracle','kind','prompt'].every(k => nonemptyString(c?.[k]))
      || !Array.isArray(c.acceptance) || !c.acceptance.length || !c.acceptance.every(nonemptyString)) errors.push('invalid scenario fields: fixture and oracle acceptance required');
  }
  if (errors.length) return errors;
  if (!exactIds(golden.cases, manifest.cases) || new Set(manifest.cases.map(c => c.id)).size !== manifest.cases.length) errors.push('manifest must cover every corpus ID exactly once in order');
  return errors;
}

function validAttestation(a) {
  const fields = ['buildSha','edgeSourceDigest','deployedEdgeSourceDigest','providerModel','organizationId','corpusDigest','manifestDigest','fixtureDigest','policyDigest','actorDigest','observedAt','contextId'];
  if (!keysOnly(a, [...fields, 'contractFixtures', 'incomeApprovalFixtures', 'customerFixtures']) || !fields.every(k => typeof a[k] === 'string')) return false;
  return /^[0-9a-f]{40}$/.test(a.buildSha) && a.organizationId === DEMO_ORG
    // Candidate policy lives in copilotTestModel.ts. This evidence layer only
    // checks safe identity syntax; browser/CLI require the exact selected model.
    && typeof a.providerModel === 'string' && a.providerModel.length <= 160
    && /^9router:[a-z0-9][a-z0-9._/-]*(?:\([a-z0-9_-]+\))?$/.test(a.providerModel)
    && ['edgeSourceDigest','deployedEdgeSourceDigest','corpusDigest','manifestDigest','fixtureDigest','policyDigest','actorDigest'].every(k => HASH.test(a[k]))
    && a.edgeSourceDigest === a.deployedEdgeSourceDigest && Number.isFinite(Date.parse(a.observedAt))
    && /^[a-zA-Z0-9-]{1,100}$/.test(a.contextId)
    && (a.customerFixtures === undefined || validCustomerFixtures(a.customerFixtures,a.actorDigest,a.contextId))
    && (a.contractFixtures === undefined || validContractFixtures(a.contractFixtures))
    && (a.incomeApprovalFixtures === undefined || validIncomeApprovalFixtures(a.incomeApprovalFixtures,a.actorDigest));
}

const CUSTOMER_MAPPING = { C02:['customer-nguyen-an-v1','customer-search','copilot_customer_search_v1'], C14:['absent-synthetic-phone-v1','customer-absent','copilot_customer_search_v1'] };
/** Structural binding only: the trusted operator issues this after fresh owned-row reads. */
export function validC02Ownership(o,{actorDigest,contextDigest,responseDigest}) {
  const ids=['customerId','associationId','hostId','roomId','buildingId'];
  const hashes=['actorDigest','contextDigest','phoneDigest','markerDigest','hostDigest','associationsDigest','customerDigest','associationDigest','responseDigest','reviewDigest'];
  const fields=['kind','state','organizationId','implementationSha',...ids,...hashes];
  return keysOnly(o,fields)&&fields.every(k=>typeof o[k]==='string')
    && o.kind==='owned-c02-v1'&&o.state==='ready'&&o.organizationId===DEMO_ORG
    && o.hostId==='10b1a785-6344-4598-812c-6dc6e98837ed'
    && ids.every(k=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(o[k]))
    && new Set(ids.map(k=>o[k])).size===ids.length
    && hashes.every(k=>HASH.test(o[k]))&&/^[a-f0-9]{40}$/.test(o.implementationSha)
    && o.actorDigest===actorDigest&&o.contextDigest===contextDigest&&o.responseDigest===responseDigest;
}
function validCustomerFixtures(fixtures,actorDigest,contextId) {
  const hashes=['actorDigest','contextDigest','queryDigest','identityDigest','responseDigest'];
  return keysOnly(fixtures,Object.keys(CUSTOMER_MAPPING)) && Object.entries(fixtures).every(([id,f])=>
    keysOnly(f,['kind','organizationId',...hashes,...(id==='C02'?['ownership']:[])]) && f.kind===CUSTOMER_MAPPING[id][1] && f.organizationId===DEMO_ORG
    && f.actorDigest===actorDigest && f.contextDigest===digest(contextId) && hashes.every(k=>typeof f[k]==='string' && HASH.test(f[k]))
    // Independently reconstruct the only allowed queries and known absent
    // payload; matching arbitrary digest strings cannot establish absence.
    && f.queryDigest===digest({p_organization_id:DEMO_ORG,p_search:id==='C02'?'Nguyễn An':`000${String(parseInt(digest(contextId).slice(0,12),16)%10000000).padStart(7,'0')}`})
    && (id==='C02'?validC02Ownership(f.ownership,f):f.responseDigest===digest([]) && f.identityDigest===digest({organizationId:DEMO_ORG,actorDigest,rows:[]})));
}
const CONTRACT_MAPPING = {
  C31: ['contract-code-v1', 'contract-search', 'copilot_contract_search_v1'],
  C32: ['absent-customer-contract-v1', 'contract-absent', 'copilot_contract_search_v1'],
  C33: ['contract-code-detail-v1', 'contract-detail', 'copilot_contract_detail_v1'],
};
const INCOME_APPROVAL_MAPPING = {
  C34:['vouchers-2026-07-v1','voucher-search','copilot_income_expense_search_v1'],
  C35:['empty-expenses-2099-01-v1','voucher-empty','copilot_income_expense_search_v1'],
  C36:['pending-approval-inbox-v1','pending-inbox','copilot_pending_requests_v1'],
};
function validIncomeApprovalFixtures(fixtures, actorDigest) {
  return keysOnly(fixtures,Object.keys(INCOME_APPROVAL_MAPPING)) && Object.entries(fixtures).every(([id,f]) =>
    keysOnly(f,['kind','organizationId','actorDigest','queryDigest','identityDigest','responseDigest',...(id==='C34'?['dailyCashbookQueryDigest','dailyCashbookResponseDigest']:[])])
    && (f.dailyCashbookQueryDigest===undefined && f.dailyCashbookResponseDigest===undefined || id==='C34' && ['dailyCashbookQueryDigest','dailyCashbookResponseDigest'].every(k=>typeof f[k]==='string' && HASH.test(f[k])))
    && f.kind === INCOME_APPROVAL_MAPPING[id][1] && f.organizationId === DEMO_ORG && f.actorDigest === actorDigest
    && ['actorDigest','queryDigest','identityDigest','responseDigest'].every(k=>typeof f[k] === 'string' && HASH.test(f[k])));
}
function validContractFixtures(fixtures) {
  return keysOnly(fixtures, Object.keys(CONTRACT_MAPPING)) && Object.entries(fixtures).every(([id,f]) => {
    const hashes = ['queryDigest','identityDigest','searchDigest', ...(id === 'C33' ? ['detailDigest'] : id === 'C32' ? ['customerDigest'] : [])];
    return keysOnly(f, ['kind','organizationId', ...hashes]) && f.kind === CONTRACT_MAPPING[id][1]
      && f.organizationId === DEMO_ORG && hashes.every(k => typeof f[k] === 'string' && HASH.test(f[k]));
  });
}
export function selectCaseIds(manifest, ids) {
  if (ids === undefined) return manifest.cases.map(c => c.id);
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !manifest.cases.some(c => c.id === id))) throw new Error('invalid case selection');
  return manifest.cases.filter(c => ids.includes(c.id)).map(c => c.id);
}

export function createRun(golden, manifest, attestation, caseIds) {
  if (validateManifest(golden, manifest).length || !validAttestation(attestation)
    || attestation.corpusDigest !== digest(golden) || attestation.manifestDigest !== digest(manifest)) throw new Error('invalid attestation or manifest');
  const selected = selectCaseIds(manifest, caseIds);
  return { ...(caseIds === undefined ? {} : { selection: { mode: 'selected', caseIds: selected } }), schemaVersion: 2, lane: 'real-model', executor: 'attested-chat-panel-v1', attestation,
    runId: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    cases: manifest.cases.map(c => ({ id: c.id, oracle: c.oracle, status: selected.includes(c.id) ? 'pending' : 'not_selected' })), cleanup: [] };
}

function validTiming(t) {
  return keysOnly(t, ['startedAt','completedAt','totalMs','humanWaitMs','processingMs'])
    && ['totalMs','humanWaitMs','processingMs'].every(k => Number.isFinite(t[k]) && t[k] >= 0)
    && ['startedAt','completedAt'].every(k => typeof t[k] === 'string' && Number.isFinite(Date.parse(t[k])))
    && Date.parse(t.completedAt) >= Date.parse(t.startedAt)
    && Math.abs(Date.parse(t.completedAt) - Date.parse(t.startedAt) - t.totalMs) <= 2
    && Math.abs(t.totalMs - t.humanWaitMs - t.processingMs) <= 2;
}

function validPass(c, attestation) {
  const o = c.observed;
  const mapping = CONTRACT_MAPPING[c.id] ?? INCOME_APPROVAL_MAPPING[c.id] ?? CUSTOMER_MAPPING[c.id];
  const contract = Boolean(CONTRACT_MAPPING[c.id]), financial = Boolean(INCOME_APPROVAL_MAPPING[c.id]), customer = Boolean(CUSTOMER_MAPPING[c.id]);
  const fixture = customer ? attestation?.customerFixtures?.[c.id] : contract ? attestation?.contractFixtures?.[c.id] : attestation?.incomeApprovalFixtures?.[c.id];
  const correctMapping = mapping ? c.oracle === mapping[0] : c.oracle === ({ C01: 'available-rooms-v1', C13: 'available-rooms-building-v1' })[c.id];
  return correctMapping && validTiming(c.timing)
    && keysOnly(o, ['answerDigest','promptDigest','promptTemplateDigest','bindingDigest','rpcDigest','modelRounds','toolResultLinked','finalAnswerMounted','readRpc','businessWrites','networkErrors','oracleVersion', ...(customer ? ['fixtureDigest','queryDigest','identityDigest','responseDigest','contextDigest'] : contract ? ['fixtureDigest','queryDigest','identityDigest','searchDigest','detailDigest', ...(c.id === 'C32' ? ['customerDigest','contractCalls','customerCalls'] : [])] : financial ? ['fixtureDigest','queryDigest','identityDigest','responseDigest',...(c.id==='C34'?['dailyCashbookCalls','dailyCashbookDigest']:[])] : [])])
    && ['answerDigest','promptDigest','promptTemplateDigest','bindingDigest','rpcDigest'].every(k => typeof o[k] === 'string' && HASH.test(o[k]))
    && Number.isInteger(o.modelRounds) && o.modelRounds >= 2 && o.toolResultLinked === true && o.finalAnswerMounted === true
    && o.readRpc === (mapping ? mapping[2] : 'copilot_available_rooms_v1') && o.oracleVersion === c.oracle
    && (!contract || (fixture && validContractFixtures({ [c.id]: fixture })
      && o.fixtureDigest === digest(fixture) && o.bindingDigest === digest(fixture)
      && ['queryDigest','identityDigest','searchDigest'].every(k => o[k] === fixture[k])
      && (c.id === 'C33' ? o.detailDigest === fixture.detailDigest && o.modelRounds >= 3 : o.detailDigest === undefined)
      && (c.id !== 'C32' || (Number.isInteger(o.contractCalls) && o.contractCalls >= 1 && Number.isInteger(o.customerCalls) && o.customerCalls >= 0 && o.contractCalls + o.customerCalls <= 10 && (o.customerCalls > 0 ? o.customerDigest === fixture.customerDigest : o.customerDigest === undefined)))
      && o.rpcDigest === (fixture.detailDigest ?? fixture.searchDigest)))
    && (!financial || (fixture && validIncomeApprovalFixtures({[c.id]:fixture},attestation.actorDigest)
      && o.fixtureDigest === digest(fixture) && o.bindingDigest === digest(fixture)
      && ['queryDigest','identityDigest','responseDigest'].every(k=>o[k] === fixture[k]) && o.rpcDigest === fixture.responseDigest
      && (c.id!=='C34' || (o.dailyCashbookCalls===undefined && fixture.dailyCashbookResponseDigest===undefined && o.dailyCashbookDigest===undefined
        || o.dailyCashbookCalls===0 && o.dailyCashbookDigest===undefined
        || o.dailyCashbookCalls===1 && typeof fixture.dailyCashbookResponseDigest==='string' && o.dailyCashbookDigest===fixture.dailyCashbookResponseDigest))))
    && (!customer || (fixture && validCustomerFixtures({[c.id]:fixture},attestation.actorDigest,attestation.contextId)
      && o.modelRounds===2 && o.fixtureDigest===digest(fixture) && o.bindingDigest===digest(fixture)
      && ['queryDigest','identityDigest','responseDigest','contextDigest'].every(k=>o[k]===fixture[k]) && o.rpcDigest===fixture.responseDigest))
    && o.businessWrites === 0 && o.networkErrors === 0;
}

export function validateBrowserRun(golden, manifest, run) {
  const errors = validateManifest(golden, manifest);
  if (errors.length) return errors;
  if (!keysOnly(run, ['schemaVersion','lane','executor','attestation','runId','createdAt','updatedAt','cases','cleanup','selection'])
    || run.schemaVersion !== 2 || run.lane !== 'real-model' || run.executor !== 'attested-chat-panel-v1') return [...errors, 'actual browser evidence schema v2 required; legacy inferred artifacts are invalid'];
  if (!validAttestation(run.attestation) || run.attestation.corpusDigest !== digest(golden) || run.attestation.manifestDigest !== digest(manifest)) errors.push('attestation mismatch');
  if (typeof run.runId !== 'string' || !/^[0-9a-f-]{36}$/.test(run.runId)
    || ![run.createdAt,run.updatedAt].every(t => typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t))) errors.push('invalid run identity/timestamps');
  if (!Array.isArray(run.cases) || !exactIds(golden.cases, run.cases)) return [...errors, 'case IDs missing, duplicated or out of order'];
  let selected = manifest.cases.map(c => c.id);
  if (run.selection !== undefined) {
    try {
      if (!keysOnly(run.selection, ['mode','caseIds']) || run.selection.mode !== 'selected') throw new Error();
      selected = selectCaseIds(manifest, run.selection.caseIds);
      if (JSON.stringify(selected) !== JSON.stringify(run.selection.caseIds)) throw new Error();
    } catch { errors.push('invalid case selection'); }
  }
  for (const [i,c] of run.cases.entries()) {
    if ((c.status === 'not_selected') === selected.includes(c.id)) errors.push(`${c.id}: selection/status mismatch`);
    if (!keysOnly(c, ['id','oracle','status','reason','timing','observed']) || !STATES.includes(c.status) || c.oracle !== manifest.cases[i].oracle) errors.push(`${c.id}: malformed case`);
    if (c.reason !== undefined && !REASONS.has(c.reason)) errors.push(`${c.id}: invalid reason`);
    if (['blocked','fail'].includes(c.status) && !REASONS.has(c.reason)) errors.push(`${c.id}: reason required`);
    if (c.status === 'pass' && !validPass(c, run.attestation)) errors.push(`${c.id}: completed browser/oracle evidence required`);
    if (c.status === 'pass' && (c.observed?.promptTemplateDigest !== digest(manifest.cases[i].prompt) || (!CONTRACT_MAPPING[c.id] && !INCOME_APPROVAL_MAPPING[c.id] && !CUSTOMER_MAPPING[c.id] && c.observed?.rpcDigest !== run.attestation.fixtureDigest))) errors.push(`${c.id}: observed prompt/fixture differs from attestation`);
    if (c.status !== 'pass' && c.observed !== undefined) errors.push(`${c.id}: unsuccessful case cannot claim actual observations`);
    if (c.timing !== undefined && !validTiming(c.timing)) errors.push(`${c.id}: invalid timing`);
  }
  if (!Array.isArray(run.cleanup) || run.cleanup.some(c => !keysOnly(c, ['caseId','fixtureKey','state','cleanup'])
    || !golden.cases.some(g => g.id === c.caseId) || !['pending','done'].includes(c.state)
    || !['fixtureKey','cleanup'].every(k => typeof c[k] === 'string' && /^[a-z0-9-]{1,100}$/.test(c[k])))) errors.push('invalid cleanup journal');
  return errors;
}

export function transitionCase(run, id, update) {
  const c = run.cases.find(c => c.id === id);
  const transitions = { pending: ['running','blocked'], running: ['pass','fail','blocked'], blocked: [], pass: [], fail: [], not_selected: [] };
  if (!c || !transitions[c.status]?.includes(update.status)) throw new Error('invalid case transition');
  const next = { ...c, ...update };
  if (next.status === 'pass' && !validPass(next, run.attestation)) throw new Error('completed browser/oracle evidence required');
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
  const selectedCases = run.cases.filter(c => c.status !== 'not_selected');
  return { fullPlanAccepted: false, selectedScope: run.selection ?? { mode: 'full-corpus', caseIds: run.cases.map(c => c.id) },
    selectedCounts: Object.fromEntries(STATES.filter(s => s !== 'not_selected').map(s => [s, selectedCases.filter(c => c.status === s).length])),
    selectedVerdict: selectedCases.length > 0 && selectedCases.every(c => c.status === 'pass') ? 'pass' : 'blocked',
    total: run.cases.length, counts, latencyMs: quantiles(times(c => c.status === 'pass')),
    unsuccessfulLatencyMs: quantiles(times(c => c.status !== 'pass')),
    sla: { status: 'pending-owner-approval', p50: null, p95: null, max: null },
    verdict: 'blocked' }; // Owner SLA approval is still absent, even if every oracle passes.
}
