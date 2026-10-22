// Local-only mutations are applied to SQL strings inside a disposable PGlite.
// Never edits source SQL and never opens a network/database connection.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const target='supabase/migrations/20261020183008_sale_reservation_deadline_received_scope_v1.sql';
const sha=()=>createHash('sha256').update(readFileSync(target)).digest('hex');
const before=sha();
const variants=['pass_source','deadline_auth','terms_sync','received_truth','parent_rls','bypass_owner'];
const results=[];
for(const variant of variants){
  const report=`docs/plans/sale-phong-actions-20261021/deposit-lock-mutation-${variant}.json`;
  const run=spawnSync(process.execPath,[
    'node_modules/vitest/vitest.mjs','run','src/lib/__tests__/saleReservationIntegrityMigration.test.ts',
    '--reporter=json',`--outputFile=${report}`,
  ],{env:{...process.env,SALE_RESERVATION_MUTATION:variant},encoding:'utf8',windowsHide:true});
  const data=JSON.parse(readFileSync(report,'utf8'));
  const failures=data.testResults.flatMap(file=>file.assertionResults.filter(t=>t.status==='failed').map(t=>t.fullName));
  const result={variant,exitCode:run.status,killed:run.status===1 && failures.length>0,failedTests:failures};
  results.push(result);console.log(JSON.stringify(result));
}
const summary={source:target,sha256Before:before,sha256After:sha(),sourceUnchanged:before===sha(),results};
writeFileSync('docs/plans/sale-phong-actions-20261021/deposit-lock-mutations-summary.json',JSON.stringify(summary,null,2)+'\n');
if(!summary.sourceUnchanged||results.some(r=>!r.killed))process.exitCode=1;
