import { createHash } from 'node:crypto';

export const STATIC_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function evidenceDigest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function commandDigest(gate) {
  return evidenceDigest({ command: gate.command, args: gate.args ?? [], cwd: gate.cwd ?? '.' });
}

export function createGateReceipt({ gate, plan, runId, status, startedAt, completedAt, exitCode, runtime = { node: process.version } }) {
  return {
    schemaVersion: 1, gateId: gate.id, jobId: gate.job, evidenceClass: gate.evidenceClass,
    status, exitCode, snapshot: { ...plan.snapshot }, policyDigest: plan.policyDigest,
    runtimeDigest: plan.runtimeDigest, inputDigest: plan.inputDigest,
    commandDigest: commandDigest(gate), runtime, runId: String(runId), startedAt, completedAt,
  };
}

/** Trust is supplied by the caller's verified artifact provenance, never by a field in the receipt. */
export function validateGateReceipt(receipt, { gate, plan, runId, now = Date.now(), trustedRunIds = [], allowReuse = false, runtime } = {}) {
  const problems = [];
  if (!receipt || !gate || !plan) return { valid: false, problems: ['Missing receipt, gate or plan'] };
  if (receipt.schemaVersion !== 1) problems.push('Unsupported receipt schema');
  if (receipt.gateId !== gate.id || receipt.jobId !== gate.job) problems.push('Gate/job identity mismatch');
  if (receipt.status !== 'passed' || receipt.exitCode !== 0) problems.push(`Gate did not pass (${receipt.status})`);
  for (const field of ['head', 'tree', 'source']) {
    if (!plan.snapshot?.[field] || receipt.snapshot?.[field] !== plan.snapshot[field]) problems.push(`Snapshot ${field} mismatch`);
  }
  if ((receipt.snapshot?.base ?? null) !== (plan.snapshot?.base ?? null)) problems.push('Snapshot base mismatch');
  for (const field of ['policyDigest', 'runtimeDigest', 'inputDigest']) {
    if (!plan[field] || receipt[field] !== plan[field]) problems.push(`${field} mismatch`);
  }
  if (receipt.commandDigest !== commandDigest(gate)) problems.push('Executed command mismatch');
  if (receipt.evidenceClass !== gate.evidenceClass) problems.push('Evidence class mismatch');
  if (runtime && evidenceDigest(receipt.runtime) !== evidenceDigest(runtime)) problems.push('Actual runtime mismatch');
  const started = Date.parse(receipt.startedAt);
  const completed = Date.parse(receipt.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started || completed > now) problems.push('Invalid receipt timestamps');
  const sameRun = typeof receipt.runId === 'string' && receipt.runId.length > 0 && receipt.runId === String(runId);
  if (!sameRun) {
    if (!allowReuse || gate.evidenceClass !== 'static') problems.push('Cross-run reuse is only allowed for static evidence');
    if (!trustedRunIds.map(String).includes(receipt.runId)) problems.push('Untrusted source run');
    if (now - completed > STATIC_EVIDENCE_MAX_AGE_MS) problems.push('Static receipt expired');
  }
  return { valid: problems.length === 0, problems };
}

export function canReuseGateReceipt(receipt, context) {
  const age = (context?.now ?? Date.now()) - Date.parse(receipt?.completedAt);
  return context?.gate?.evidenceClass === 'static' && age >= 0 && age <= STATIC_EVIDENCE_MAX_AGE_MS &&
    validateGateReceipt(receipt, { ...context, allowReuse: true }).valid;
}

/** Missing/conditional/cancelled jobs and zero receipts cannot produce a successful aggregate. */
export function aggregateGateEvidence({ plan, receipts = [], jobs = {}, registry = {}, runId, now = Date.now(), trustedRunIds = [], runtime } = {}) {
  const failures = [];
  if (!plan || !Array.isArray(plan.gateIds) || plan.gateIds.length === 0 || !Array.isArray(plan.requiredJobs) || plan.requiredJobs.length === 0) {
    failures.push('Missing or empty gate plan');
  } else {
    for (const obligation of plan.unavailable ?? []) failures.push(`Unverifiable required obligation: ${typeof obligation === 'string' ? obligation : JSON.stringify(obligation)}`);
    for (const path of plan.executionMismatches ?? []) failures.push(`Execution input differs from planned snapshot: ${path}`);
    if (new Set(plan.gateIds).size !== plan.gateIds.length) failures.push('Duplicate gate IDs in plan');
    for (const jobId of plan.requiredJobs) {
      const result = typeof jobs[jobId] === 'string' ? jobs[jobId] : jobs[jobId]?.result;
      if (result !== 'success') failures.push(`Required job ${jobId}: ${result ?? 'missing'}`);
    }
    for (const gateId of plan.gateIds) {
      const gate = registry[gateId];
      if (!gate) { failures.push(`Unknown required gate ${gateId}`); continue; }
      if (!plan.requiredJobs.includes(gate.job)) failures.push(`Missing required job declaration for ${gateId}`);
      const found = receipts.filter((receipt) => receipt?.gateId === gateId);
      if (found.length !== 1) { failures.push(`${gateId}: expected one receipt, got ${found.length}`); continue; }
      const checked = validateGateReceipt(found[0], { gate, plan, runId, now, trustedRunIds, allowReuse: true, runtime });
      failures.push(...checked.problems.map((problem) => `${gateId}: ${problem}`));
    }
  }
  return {
    schemaVersion: 1, status: failures.length ? 'failed' : 'passed', failures,
    evidenceScope: 'ci-technical', browserRequirements: plan?.browserRequirements ?? [],
    manualUiValidation: 'not-attested-by-ci',
    requiredExternalWorkflows: plan?.requiredExternalWorkflows ?? [],
    releaseReady: failures.length === 0 && !(plan?.requiredExternalWorkflows?.length),
    gateIds: plan?.gateIds ?? [], snapshot: plan?.snapshot ?? null,
    policyDigest: plan?.policyDigest ?? null, runtimeDigest: plan?.runtimeDigest ?? null,
    inputDigest: plan?.inputDigest ?? null, runId: String(runId), completedAt: new Date(now).toISOString(),
  };
}
