// Explicit TEST-only, rollback-only observation of the current financial policy.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTestCredentials, loadTestCredentialsFromVault, withTestTransaction } from './transport.mjs';
import { runFinancialScenario, verifyFixtureAbsence } from '../tests/contract-lifecycle/financial-fixture.mjs';

export const SCENARIOS = Object.freeze(['FORFEIT', 'REFUND', 'DEBT', 'PAID']);
export function assertScenarioSet(results) {
  assert.deepEqual(results.map(r => r.name).sort(), [...SCENARIOS].sort(), 'Required scenario set missing/duplicated');
  assert(results.every(r => r.status === 'PASS'), 'Required scenario failed');
  assert(results.every(r => r.rollbackAbsent === true && r.before?.contracts?.length === 1 &&
    r.after?.contracts?.length === 1 && r.before.invoices?.length > 0 && r.before.postings?.length > 0 &&
    r.retry === 'SAME_RESPONSE_ZERO_EFFECT' && r.payloadConflict === '23505'), 'Nonempty live scenario evidence required');
}
export function assertForfeitInvoices(before, after) {
  assert(before.length >= 3 && before.every(r => Number(r.total_amount) > 0), 'nonzero source invoices required');
  assert(before.some(r => Number(r.paid_amount) === 0) && before.some(r => r.status === 'PARTIAL_PAID') && before.some(r => r.status === 'PAID'), 'nonzero unpaid/partial/paid sources required');
  for (const row of before) {
    assert(['APPROVED', 'OVERDUE', 'PARTIAL_PAID', 'PAID'].includes(row.status), 'Unknown source status');
    const next = after.find(r => r.id === row.id);
    assert(next, 'missing source invoice after settlement');
    assert.equal(next.status, row.status === 'PAID' ? 'PAID' : 'CANCELLED', 'cancellation status');
    assert.equal(Number(next.total_amount), Number(row.status === 'PAID' ? row.total_amount : row.paid_amount), 'kept invoice total');
    assert.equal(Number(next.paid_amount), Number(row.paid_amount), 'kept paid amount');
  }
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function runBaseline(config) {
  const report = {
    runId: `p0c-${randomUUID()}`, gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding:'utf8' }).trim(),
    testRef: config.expectedRef, at: new Date().toISOString(), runtime:process.version,
    harnessSha256: digest(['./baseline.mjs','../tests/contract-lifecycle/financial-fixture.mjs'].map(file=>readFileSync(new URL(file,import.meta.url),'utf8'))),
    kind:'CURRENT_FINANCIAL_POLICY_SQL_ROLLBACK', scenarios:[], status:'FAIL',
    limits:['SQL request claims are not real JWT authorization proof.', 'Post-commit approval, concurrency and real JWT mutations remain pending.', 'Flags are observed, never changed; no production writes.'],
  };
  for (const name of SCENARIOS) {
    const roots = [];
    const result = { name, status:'FAIL', stage:'admission', roots };
    try {
      await withTestTransaction(config, { run: async context => {
        try {
          await runFinancialScenario(context, { name, runId:report.runId, roots, evidence:result, assertForfeitInvoices, digest, stage:value => { result.stage=value; } });
        } catch(e) {
          result.errorCode=/^[A-Z0-9_]{2,24}$/.test(e.code ?? '') ? e.code : 'BASELINE_ASSERTION';
          throw e;
        }
      }});
      result.stage='rollback-verification';
      result.rollbackAbsent = await withTestTransaction(config, { readOnly:true, run: ctx => verifyFixtureAbsence(ctx, roots) });
      assert(result.rollbackAbsent, 'Fixture roots survived rollback');
      result.status='PASS'; result.stage='complete';
    } catch {
      // Transport deliberately suppresses arbitrary SQL text. Fixture records only SQLSTATE/stage.
      try { result.rollbackAbsent=await withTestTransaction(config, {readOnly:true,run:ctx=>verifyFixtureAbsence(ctx, roots)}); } catch { result.rollbackAbsent=false; }
    }
    result.sha256=digest(result);
    report.scenarios.push(result);
  }
  report.pass=report.scenarios.filter(r=>r.status==='PASS').length;
  report.fail=report.scenarios.length-report.pass;
  try { assertScenarioSet(report.scenarios); report.status='PASS'; } catch { /* fail closed */ }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args=process.argv.slice(2);
    assert(args.includes('--test'), 'Explicit --test required');
    const ca=args[args.indexOf('--ca-file')+1];
    assert(args.includes('--ca-file') && ca && !ca.startsWith('--'), 'Explicit --ca-file required');
    const config=await (args.includes('--vault') ? loadTestCredentialsFromVault() : loadTestCredentials());
    config.db.ca=readFileSync(ca,'utf8');
    const report=await runBaseline(config);
    const output=resolve('docs/generated/contract-lifecycle', `${report.at.replaceAll(':','-')}-financial-baseline.json`);
    mkdirSync(dirname(output),{recursive:true}); writeFileSync(output,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({status:report.status,pass:report.pass,fail:report.fail,output}));
    if(report.status!=='PASS') process.exitCode=1;
  } catch { console.error('NOT_READY: explicit TEST credentials, target, CA and admission required.'); process.exitCode=1; }
}
