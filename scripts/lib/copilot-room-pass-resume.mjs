import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DEMO, UUID, digest, requireThat } from './copilot-room-pass-live.mjs';

export const REQUIRED_CASES = Object.freeze(['fresh_consent_toggles', 'nonce_replay', 'stale_second_nonce', 'aba',
  'conflict_atomicity', 'disallowed_role_preview', 'scope_revoked', 'other_building_scope', 'flag_revoked',
  'global_emergency', 'scoped_emergency', 'future_emergency', 'expired_emergency', 'unrelated_permission_emergency',
  'plan_execute', 'plan_repreview', 'plan_cancel', 'browser_consent',
  'same_nonce_sessions', 'parent_relationship_race', 'listing_revision_race', 'nonce_expiry_wait', 'flag_expiry_wait',
  'global_emergency_wait', 'scoped_emergency_wait']);
const hash = raw => createHash('sha256').update(raw).digest('hex');
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keysOnly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));

export function acceptedCasePrefix(results) {
  requireThat(Array.isArray(results) && results.length <= REQUIRED_CASES.length
    && results.every((result, index) => result?.status === 'pass' && result.name === REQUIRED_CASES[index])
    && ![1, 2, 7].includes(results.length), 'resume_cases_invalid');
  return results.map(result => result.name);
}

function validateJournal(j, admission, runId) {
  requireThat(j?.schemaVersion === 1 && UUID.test(j.runId) && j.runId !== runId
    && j.organizationId === DEMO && j.actorId === admission.actorId
    && ['accepted', 'acceptance_failed', 'recovered', 'incomplete'].includes(j.status), 'resume_journal_invalid');
  requireThat(['sourceSha', 'buildSha', 'organizationId', 'actorId'].every(key => j.admission?.[key] === admission[key])
    && j.admission.reviewed === true && j.admission.administrativeFixtureReviewed === true, 'resume_admission_mismatch');
  requireThat(j.fixtureCleanup?.status === 'done' && j.controls?.restored === true && !j.controls.pending
    && j.controls.current?.state === 'disabled' && j.controls.current.canary_org === null
    && j.controls.current.expires_at === null, 'resume_cleanup_unproven');
  requireThat(Array.isArray(j.operations) && j.operations.every(op => ['acknowledged', 'rejected'].includes(op.state)
    || (['reconciled_terminal', 'reconciled_absent', 'reconciled_committed'].includes(op.state) && isDigest(op.terminalEvidenceDigest)))
    && Array.isArray(j.scenarios) && j.scenarios.every(s => s.state === 'settled'
      || (s.state === 'reconciled_terminal' && isDigest(s.terminalEvidenceDigest)))
    && (!j.browser || j.browser.state === 'settled'), 'resume_terminal_unproven');
  acceptedCasePrefix(j.results);
  requireThat((!j.scopeRevocation || j.scopeRevocation.state === 'restored')
    && (!j.emergencies || (Array.isArray(j.emergencies) && j.emergencies.every(e => e.state === 'removed')))
    && Array.isArray(j.fixtures?.plans) && j.fixtures.plans.every(plan => ['terminal', 'absent'].includes(plan.status)
      || j.results.some(r => r.name.startsWith('plan_') && r.status === 'pass' && r.planId === plan.id)), 'resume_auxiliary_cleanup_unproven');
}

function originalProof(result, j) {
  const index = REQUIRED_CASES.indexOf(result.name);
  const fields = index < 3 ? ['count'] : result.name.startsWith('plan_') ? ['planId']
    : result.name === 'browser_consent' ? ['buildSha'] : index >= 18 ? ['barrier'] : [];
  requireThat(keysOnly(result, ['name', 'status', ...fields]), 'resume_proof_invalid');
  if (index < 3) requireThat(result.count === 4, 'resume_toggle_proof_invalid');
  if (fields.includes('planId')) requireThat(UUID.test(result.planId)
    && j.fixtures?.plans?.some(plan => plan.id === result.planId), 'resume_plan_proof_invalid');
  if (result.name === 'browser_consent') requireThat(result.buildSha === j.admission.buildSha
    && j.browser?.state === 'settled', 'resume_browser_proof_invalid');
  if (index >= 18) {
    const b = result.barrier, expectedCount = result.name === 'same_nonce_sessions' ? 2 : 1;
    const participants = [b?.holder, ...(Array.isArray(b?.executors) ? b.executors : [])];
    requireThat(b?.executors?.length === expectedCount
      && participants.every(p => Number.isInteger(p?.pid) && p.pid > 0 && /^\d+$/.test(p.xid)
        && Number.isFinite(Date.parse(p.transactionStarted)))
      && new Set(participants.map(p => p.pid)).size === participants.length
      && new Set(participants.map(p => p.xid)).size === participants.length
      && b.executors.every((p, i) => Array.isArray(p.blockers) && p.blockers.includes(i === 0 ? b.holder.pid : b.executors[0].pid))
      && j.scenarios.some(s => s.name === result.name && s.state === 'settled' && digest(s.barrier) === digest(b)), 'resume_barrier_unproven');
  }
  return structuredClone(result);
}

/** Local journal files are operator evidence, not a substitute for live proof.
 * Verify the complete lineage before any transport call or lease acquisition.
 * Persist content digests so later continuations reject altered ancestors. */
export async function loadAcceptedHistory({ resume, admission, runId }) {
  if (resume === undefined) return null;
  requireThat(keysOnly(resume, ['journalPaths']) && Array.isArray(resume.journalPaths)
    && resume.journalPaths.length > 0 && resume.journalPaths.length <= 100
    && resume.journalPaths.every(p => typeof p === 'string' && p.length > 0), 'resume_paths_required');
  const entries = new Map(), ordered = [];
  for (const input of resume.journalPaths) {
    let raw, j;
    try { raw = await readFile(input, 'utf8'); j = JSON.parse(raw); }
    catch { requireThat(false, 'resume_journal_unreadable'); }
    validateJournal(j, admission, runId);
    requireThat(!entries.has(j.runId), 'resume_duplicate_run');
    const entry = { j, ref: { runId: j.runId, path: resolve(input), digest: hash(raw) } };
    entries.set(j.runId, entry); ordered.push(entry);
  }
  const resolved = new Map(), visiting = new Set();
  function visit(id) {
    requireThat(!visiting.has(id) && entries.has(id), 'resume_lineage_invalid');
    if (resolved.has(id)) return resolved.get(id);
    visiting.add(id);
    const { j, ref } = entries.get(id), prior = j.priorAcceptance;
    let inherited = [];
    if (prior) {
      requireThat(UUID.test(prior.runId) && Array.isArray(prior.cases), 'resume_lineage_invalid');
      inherited = visit(prior.runId);
      requireThat(digest(prior.cases) === digest(inherited.map(r => r.name)), 'resume_lineage_invalid');
      if (prior.journals) for (const recorded of prior.journals) {
        requireThat(isDigest(recorded.digest) && entries.get(recorded.runId)?.ref.digest === recorded.digest, 'resume_digest_mismatch');
      }
    }
    requireThat(inherited.length <= j.results.length, 'resume_lineage_invalid');
    const results = j.results.map((result, i) => {
      if (i < inherited.length) {
        const ancestor = inherited[i];
        requireThat(result.name === ancestor.name && result.source === 'prior_terminal_journal', 'resume_lineage_invalid');
        if (result.origin) requireThat(digest(result) === digest(ancestor), 'resume_origin_mismatch');
        else requireThat(keysOnly(result, ['name', 'status', 'source']), 'resume_proof_invalid');
        return structuredClone(ancestor);
      }
      return { ...originalProof(result, j), source: 'prior_terminal_journal', origin: { runId: id, journalDigest: ref.digest } };
    });
    visiting.delete(id); resolved.set(id, results); return results;
  }
  const results = visit(ordered[0].j.runId);
  requireThat(resolved.size === entries.size, 'resume_unrelated_journal');
  return { runId: ordered[0].j.runId, cases: results.map(r => r.name), results, journals: ordered.map(e => e.ref) };
}
