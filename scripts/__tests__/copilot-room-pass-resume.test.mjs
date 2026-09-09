import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEMO, prepareRoomPassRun } from '../lib/copilot-room-pass-live.mjs';
import { runRoomPassAcceptance, REQUIRED_CASES } from '../copilot-room-pass-live-acceptance.mjs';
const resumeApi = await import('../lib/copilot-room-pass-resume.mjs').catch(() => ({}));
const ACTOR = '11111111-1111-4111-8111-111111111111';
const admission = { organizationId: DEMO, actorId: ACTOR, sourceSha: 'a'.repeat(40), buildSha: 'a'.repeat(40), reviewed: true, administrativeFixtureReviewed: true };
const basicProof = name => ({ name, status: 'pass', ...(REQUIRED_CASES.indexOf(name) < 3 ? { count: 4 } : {}) });
function journal(count = 6) {
  return { schemaVersion: 1, runId: randomUUID(), actorId: ACTOR, organizationId: DEMO, admission,
    status: 'acceptance_failed', fixtureCleanup: { status: 'done' },
    controls: { restored: true, current: { state: 'disabled', canary_org: null, expires_at: null } },
    operations: [], scenarios: [], fixtures: { plans: [] }, results: REQUIRED_CASES.slice(0, count).map(basicProof) };
}
async function withJournals(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'room-pass-resume-'));
  const save = async (j, name = j.runId) => { const path = join(dir, `${name}.json`); await writeFile(path, JSON.stringify(j)); return path; };
  const load = paths => resumeApi.loadAcceptedHistory({ resume: { journalPaths: paths }, admission, runId: ACTOR });
  try { await fn({ dir, save, load }); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('resume reads original durable proofs through a completed continuation lineage', async () => withJournals(async ({ save, load }) => {
  const original = journal(), parent = journal(8);
  parent.priorAcceptance = { runId: original.runId, cases: REQUIRED_CASES.slice(0, 6) };
  parent.results.splice(0, 6, ...original.results.map(({ name }) => ({ name, status: 'pass', source: 'prior_terminal_journal' })));
  const paths = [await save(parent), await save(original)];
  const history = await load(paths);
  assert.equal(history.results.length, 8);
  assert.equal(history.results[0].count, 4);
  assert.equal(history.results[0].origin.runId, original.runId);
  assert.match(history.results[0].origin.journalDigest, /^[a-f0-9]{64}$/);
  assert.equal(history.journals.length, 2);
  assert.equal(history.results[7].origin.runId, parent.runId);
  const child = journal(8);
  child.results = history.results;
  child.priorAcceptance = { runId: parent.runId, cases: REQUIRED_CASES.slice(0, 8), journals: history.journals };
  const childPath = await save(child);
  assert.equal((await load([childPath, ...paths])).results[0].count, 4);
  original.note = 'changed after proof was carried'; await save(original);
  await assert.rejects(load([childPath, ...paths]), /resume_/);
}));

test('resume rejects supplied labels without journal files', async () => {
  await assert.rejects(resumeApi.loadAcceptedHistory({ resume: { runId: randomUUID(), results: REQUIRED_CASES.map(basicProof) }, admission, runId: ACTOR }), /resume_/);
});

test('all case boundaries reject interrupted groups before new work starts', () => {
  for (let count = 0; count <= REQUIRED_CASES.length; count++) {
    const results = REQUIRED_CASES.slice(0, count).map(basicProof);
    if ([1, 2, 7].includes(count)) assert.throws(() => resumeApi.acceptedCasePrefix(results), /resume_/);
    else assert.equal(resumeApi.acceptedCasePrefix(results).length, count);
  }
  assert.throws(() => resumeApi.acceptedCasePrefix([basicProof(REQUIRED_CASES[0]), basicProof(REQUIRED_CASES[3])]), /resume_/);
});

test('terminal labels cannot hide unfinished cleanup, changed identity, or unknown effects', async () => withJournals(async ({ save, load }) => {
  const invalid = [
    j => { j.fixtureCleanup.status = 'pending'; }, j => { j.controls.current.state = 'shadow'; },
    j => { j.controls.pending = {}; }, j => { j.browser = { state: 'intent' }; },
    j => { j.operations = [{ state: 'unknown' }]; }, j => { j.scenarios = [{ state: 'intent' }]; },
    j => { j.operations = [{ state: 'reconciled_terminal' }]; },
    j => { j.status = 'accepting'; }, j => { j.organizationId = ACTOR; }, j => { j.actorId = randomUUID(); },
    j => { j.admission = { ...admission, buildSha: 'b'.repeat(40) }; },
    j => { j.admission = { ...admission, reviewed: false }; }, j => { delete j.results[0].count; },
    j => { j.results[0].source = 'prior_terminal_journal'; },
    j => { j.fixtures.plans.push({ id: randomUUID(), status: 'created' }); },
    j => { j.scopeRevocation = { state: 'active' }; },
    j => { j.emergencies = [{ state: 'active' }]; },
  ];
  for (const corrupt of invalid) {
    const j = journal(); corrupt(j); const path = await save(j);
    await assert.rejects(load([path]), /resume_/);
  }
}));

test('resume rejects missing ancestors, cycles and duplicated run IDs', async () => withJournals(async ({ save, load }) => {
  const a = journal(), b = journal();
  a.priorAcceptance = { runId: b.runId, cases: a.results.map(r => r.name) };
  a.results = a.results.map(({ name }) => ({ name, status: 'pass', source: 'prior_terminal_journal' }));
  const ap = await save(a), bp = await save(b);
  await assert.rejects(load([ap]), /resume_/);
  b.priorAcceptance = { runId: a.runId, cases: a.results.map(r => r.name) }; b.results = a.results; await save(b);
  await assert.rejects(load([ap, bp]), /resume_/);
  const duplicate = await save(a, 'duplicate');
  await assert.rejects(load([ap, duplicate, bp]), /resume_/);
}));

test('browser, plan and lock-wait passes require their original specific evidence', async () => withJournals(async ({ save, load }) => {
  for (const count of [15, 18, 19]) {
    const j = journal(count);
    for (const result of j.results.filter(r => r.name.startsWith('plan_'))) {
      result.planId = randomUUID(); j.fixtures.plans.push({ id: result.planId });
    }
    if (count >= 18) { j.results[17].buildSha = admission.buildSha; j.browser = { state: 'settled' }; }
    const target = j.results.at(-1);
    if (count === 15) delete target.planId;
    if (count === 18) target.buildSha = 'b'.repeat(40);
    if (count === 19) target.barrier = { holder: { pid: 1 }, executors: [] };
    await assert.rejects(load([await save(j)]), /resume_/);
  }
}));

test('invalid history leaves no lease and performs no transport requests', async () => withJournals(async ({ dir }) => {
  const journalPath = join(dir, 'new.json');
  const run = await prepareRoomPassRun({ organizationId: DEMO, actorId: ACTOR, journalPath });
  const tripwire = new Proxy({}, { get() { throw new Error('transport touched before validation'); } });
  await assert.rejects(runRoomPassAcceptance({ run, journalPath, admission, transport: tripwire,
    disallowedTransport: tripwire, browser: async () => {}, resume: { results: [] } }), /resume_/);
  await assert.rejects(access(`${journalPath}.lock`), /ENOENT/);
}));
