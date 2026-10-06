import { spawnSync } from 'node:child_process';
import { canReuseGateReceipt, createGateReceipt, STATIC_EVIDENCE_MAX_AGE_MS } from './gate-evidence.mjs';

export function selectEventSnapshot({ eventName, event = {}, checkoutSha }) {
  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha : eventName === 'push' ? event.before : null;
  const usable = typeof base === 'string' && base.length > 0 && !/^0+$/.test(base);
  return { base: usable ? base : null, head: checkoutSha, full: !usable };
}

export function trustedReuseRun(run, { repository, sha, now = Date.now() }) {
  const age = now - Date.parse(run.created_at);
  return run.path === '.github/workflows/ci-gates.yml' && run.event === 'pull_request' &&
    run.status === 'completed' && run.conclusion === 'success' && run.head_sha === sha &&
    run.head_repository?.full_name === repository && Number.isInteger(run.id) && Number.isInteger(run.run_attempt) &&
    Number.isFinite(age) && age >= 0 && age <= STATIC_EVIDENCE_MAX_AGE_MS &&
    run.pull_requests?.some((pr) => pr.base?.ref === 'main' && pr.base?.repo?.full_name === repository) === true;
}

export function executeGateJob({ plan, jobId, getGate, runId, env = process.env, root = process.cwd(),
  reusableReceipts = [], trustedRunIds = [], now = Date.now, runtime = { node: process.version },
  execute = (gate) => spawnSync(gate.command, gate.args, { cwd: root, env, stdio: 'inherit', timeout: 25 * 60 * 1000 }),
}) {
  const selected = plan.gateIds.map((id) => {
    const gate = getGate(id, plan);
    if (!gate) throw new Error(`Unknown gate ${id}`);
    return gate;
  }).filter((gate) => gate.job === jobId);
  if (!selected.length) throw new Error(`No selected gates for ${jobId}`);
  const receipts = [];
  for (const gate of selected) {
    const context = { gate, plan, runId, now: now(), runtime, trustedRunIds };
    const reuse = reusableReceipts.find((receipt) => canReuseGateReceipt(receipt, context));
    if (reuse) { console.log(`${gate.id}: reuse verified static receipt from ${reuse.runId}`); receipts.push(reuse); continue; }
    const startedAt = new Date(now()).toISOString();
    const missing = (gate.requires ?? []).filter((name) => !env[name]);
    let status = 'blocked';
    let exitCode = 3;
    if (!missing.length) {
      console.log(`${gate.id}: execute selected gate`);
      const result = execute(gate);
      exitCode = Number.isInteger(result.status) ? result.status : 3;
      status = exitCode === 0 ? 'passed' : result.signal ? 'cancelled' : exitCode === 3 ? 'blocked' : 'failed';
    } else console.error(`${gate.id}: missing required environment names: ${missing.join(', ')}`);
    receipts.push(createGateReceipt({ gate, plan, runId, status, exitCode, startedAt, completedAt: new Date(now()).toISOString(), runtime }));
  }
  return { receipts, exitCode: receipts.every((receipt) => receipt.status === 'passed') ? 0 : 1 };
}
