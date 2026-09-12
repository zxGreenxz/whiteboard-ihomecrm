// Compile the forward migration and execute DEMO integration in one rollback.
// Uses existing flags, real actor authorization and fixture-only possession.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadSupabaseAdminConfig, stripMigrationTransactionControl } from './apply-accounting-rollout.mjs';
import { runQuery, fixtureInvoiceSql, actAsFixtureActorSql } from './lib/v5-collection-harness.mjs';

const path='supabase/migrations/20260912065909_invoice_adjustment_atomic_revisions.sql';
const source=readFileSync(path,'utf8');
const body=stripMigrationTransactionControl(source,path);
const conflictPath='supabase/migrations/20260912091403_invoice_domain_conflicts_http409.sql';
const conflictSource=readFileSync(conflictPath,'utf8');
const conflictBody=stripMigrationTransactionControl(conflictSource,conflictPath);
const probe=readFileSync('docs/audits/2026-09-12-invoice-adjustment-repair.probe.sql','utf8');
if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(body)) throw new Error('Embedded migration controls transactions');
const config=loadSupabaseAdminConfig({readFile:(p,e)=>readFileSync(
  String(p).includes('CLAUDE.local.md') && process.env.IHOMECRM_SECRET_FILE ? process.env.IHOMECRM_SECRET_FILE : p,e)});
const sql=`BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s';
${body}
${process.argv.includes('--repeat-migration')?body:''}
${conflictBody}
${process.argv.includes('--repeat-migration')?conflictBody:''}
${fixtureInvoiceSql({marker:'[E2E-V5-HARNESS:adjustment-repair]',billingMonth:'2093-10',rent:100000,deposit:20000})}
INSERT INTO public.cashbook_possession_bindings(organization_id,cashbook_id,membership_id,possession_kind,valid_from,reason)
SELECT m.organization_id,current_setting('v5h.account_tm')::uuid,m.id,'KNOWER',now()-interval '1 minute','rollback-only adjustment fixture'
FROM public.organization_memberships m WHERE m.organization_id='dddd0000-0000-4000-8000-000000000001'
 AND m.user_id=current_setting('v5h.actor')::uuid AND m.status='ACTIVE'
 AND NOT app_private.ie_has_cashbook_possession_v1(m.organization_id,current_setting('v5h.account_tm')::uuid,m.id);
${actAsFixtureActorSql()}
${probe}
RESET ROLE; SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
${fixtureInvoiceSql({marker:'[E2E-V5-HARNESS:adjustment-legacy-residual]',billingMonth:'2093-11',rent:100000,deposit:0})}
INSERT INTO public.cashbook_possession_bindings(organization_id,cashbook_id,membership_id,possession_kind,valid_from,reason)
SELECT m.organization_id,current_setting('v5h.account_tm')::uuid,m.id,'KNOWER',now()-interval '1 minute','rollback-only residual fixture'
FROM public.organization_memberships m WHERE m.organization_id='dddd0000-0000-4000-8000-000000000001'
 AND m.user_id=current_setting('v5h.actor')::uuid AND m.status='ACTIVE'
 AND NOT app_private.ie_has_cashbook_possession_v1(m.organization_id,current_setting('v5h.account_tm')::uuid,m.id);
${actAsFixtureActorSql()}
${readFileSync('docs/audits/2026-09-12-invoice-adjustment-legacy-residual.probe.sql','utf8')}
RESET ROLE; SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'PASS: v2 revisions, V5 collection/reversal, component pins, historical money, review, stale/replay, malformed inputs and scope; rollback' AS result;
ROLLBACK;`;
const rows=await runQuery(sql,config);
if (!rows.some(row=>String(row.result).startsWith('PASS:'))) throw new Error('Missing success sentinel');
console.log(rows.filter(row=>row.result));
console.log(`migration sha256=${createHash('sha256').update(source).digest('hex')}; applications=${process.argv.includes('--repeat-migration')?2:1}`);
console.log(`conflict migration sha256=${createHash('sha256').update(conflictSource).digest('hex')}; applications=${process.argv.includes('--repeat-migration')?2:1}`);
