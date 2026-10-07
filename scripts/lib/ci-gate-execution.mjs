import { spawnSync } from 'node:child_process';
import { canReuseGateReceipt, createGateReceipt, STATIC_EVIDENCE_MAX_AGE_MS } from './gate-evidence.mjs';

const usableSha = (sha) => typeof sha === 'string' && sha.length > 0 && !/^0+$/.test(sha);

/**
 * A push to main plans from the production tip, so one aggregate covers every
 * commit promotion would ship — not only this push. A red or cancelled earlier
 * push can no longer drop out of release evidence. Fallback: event.before, then full.
 */
export function selectEventSnapshot({ eventName, event = {}, checkoutSha, ref, productionTip = null, productionIsAncestor = false }) {
  let fallback = null;
  if (eventName === 'push' && ref === 'refs/heads/main') {
    if (usableSha(productionTip) && productionTip !== checkoutSha && productionIsAncestor) {
      return { base: productionTip, head: checkoutSha, full: false, reason: 'origin/production là tổ tiên của HEAD: plan phủ cả dải production..HEAD' };
    }
    fallback = !usableSha(productionTip) ? 'checkout không có origin/production'
      : productionTip === checkoutSha ? 'origin/production đã ở đúng HEAD' : 'origin/production không phải tổ tiên của HEAD';
  }
  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha : eventName === 'push' ? event.before : null;
  const usable = usableSha(base);
  const source = eventName === 'pull_request' ? 'base của pull request' : 'event.before';
  const reason = usable ? (fallback ? `${fallback}; dùng ${source}` : `Dùng ${source}`)
    : `${fallback ? `${fallback}; ` : ''}không có base kiểm được: chạy full`;
  return { base: usable ? base : null, head: checkoutSha, full: !usable, reason };
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
