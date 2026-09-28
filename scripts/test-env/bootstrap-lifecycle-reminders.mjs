#!/usr/bin/env node
// Explicit TEST-only post-sync bootstrap. No production cron or salary/E6 job.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const PROD_REF = 'tryymsxyyckgbrmmvozx';
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
function validateTestServiceJwt(testRef, serviceJwt) {
  if (!/^[a-z0-9]{20}$/.test(testRef) || testRef === PROD_REF) throw new Error('Ref must be TEST, never production');
  let claims;
  try { claims = JSON.parse(Buffer.from(serviceJwt.split('.')[1], 'base64url').toString('utf8')); } catch { throw new Error('TEST service JWT required'); }
  if (claims.role !== 'service_role' || claims.ref !== testRef) throw new Error('Service JWT must belong to this TEST project');
}
export function buildLifecycleEdgeSecrets(testRef, serviceJwt) {
  validateTestServiceJwt(testRef, serviceJwt);
  return [{name:'LIFECYCLE_REMINDERS_SERVICE_JWT',value:serviceJwt}];
}
export function buildLifecycleCronSql(testRef, serviceJwt) {
  validateTestServiceJwt(testRef, serviceJwt);
  return `BEGIN;
DO $guard$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM test_env.danh_dau WHERE ref=${literal(testRef)}) THEN RAISE EXCEPTION 'TEST database marker mismatch'; END IF;
  IF to_regprocedure('public.lifecycle_reminder_sweep_v1(uuid)') IS NULL THEN RAISE EXCEPTION 'Apply reviewed lifecycle migration first'; END IF;
END $guard$;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
DO $secret$ DECLARE existing uuid; BEGIN
  SELECT id INTO existing FROM vault.secrets WHERE name='test_lifecycle_service_jwt';
  IF existing IS NULL THEN PERFORM vault.create_secret(${literal(serviceJwt)},'test_lifecycle_service_jwt');
  ELSE PERFORM vault.update_secret(existing,${literal(serviceJwt)},'test_lifecycle_service_jwt'); END IF;
END $secret$;
CREATE TABLE IF NOT EXISTS test_env.lifecycle_reminder_dispatches(request_id bigint PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON test_env.lifecycle_reminder_dispatches FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION test_env.dispatch_lifecycle_reminders_v1()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,test_env AS $dispatch$
DECLARE token text; request_id bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM test_env.danh_dau WHERE ref=${literal(testRef)}) THEN RAISE EXCEPTION 'TEST database marker mismatch'; END IF;
  SELECT decrypted_secret INTO token FROM vault.decrypted_secrets WHERE name='test_lifecycle_service_jwt';
  IF token IS NULL THEN RAISE EXCEPTION 'TEST lifecycle service credential missing'; END IF;
  SELECT net.http_post(url:=${literal(`https://${testRef}.supabase.co/functions/v1/lifecycle-reminders`)},
    headers:=jsonb_build_object('Authorization','Bearer '||token,'Content-Type','application/json'),body:='{}'::jsonb,timeout_milliseconds:=120000) INTO request_id;
  INSERT INTO test_env.lifecycle_reminder_dispatches VALUES(request_id,clock_timestamp());
  RETURN request_id;
END $dispatch$;
REVOKE ALL ON FUNCTION test_env.dispatch_lifecycle_reminders_v1() FROM PUBLIC,anon,authenticated,service_role;
DO $schedule$ DECLARE job bigint; BEGIN
  FOR job IN SELECT jobid FROM cron.job WHERE jobname='test-lifecycle-reminders-15m' LOOP PERFORM cron.unschedule(job); END LOOP;
  PERFORM cron.schedule('test-lifecycle-reminders-15m','*/15 * * * *','SELECT test_env.dispatch_lifecycle_reminders_v1()');
END $schedule$;
COMMIT;`;
}

async function main() {
  if (!process.argv.includes('--apply')) throw new Error('Bootstrap requires --apply; use only after reviewed TEST migration install');
  const { readFileSync } = await import('node:fs');
  const { credential, ketNoi, batBuocDichTest, mgmt, psql, repoRoot } = await import('./lib.mjs');
  const cred = credential();
  if (!cred.testPat) throw new Error('TEST management PAT required');
  const { test } = await ketNoi(cred);
  await batBuocDichTest(cred, test);
  const secrets = await mgmt(cred.testPat, 'GET', `/v1/projects/${cred.testRef}/secrets`);
  if (secrets.some(secret => /^VAPID_/.test(secret.name))) throw new Error('TEST cannot have VAPID push credentials');
  const keys = await mgmt(cred.testPat,'GET',`/v1/projects/${cred.testRef}/api-keys?reveal=true`);
  const serviceJwt = keys.find(key=>key.name==='service_role')?.api_key;
  const edgeSecrets = buildLifecycleEdgeSecrets(cred.testRef,serviceJwt);
  const sql = buildLifecycleCronSql(cred.testRef,serviceJwt);
  // Keep Edge's exact authorization credential identical to the TEST Vault token.
  // Never echo a Management error body which could contain that credential.
  try { await mgmt(cred.testPat,'POST',`/v1/projects/${cred.testRef}/secrets`,edgeSecrets); }
  catch { throw new Error('TEST lifecycle dedicated Edge credential configuration failed'); }
  // Deploy the additive function without requiring a production counterpart.
  const form = new FormData();
  form.append('metadata', JSON.stringify({name:'lifecycle-reminders',entrypoint_path:'index.ts',verify_jwt:true}));
  for (const file of ['index.ts','runner.ts']) {
    form.append('file', new Blob([readFileSync(resolve(repoRoot,'supabase/functions/lifecycle-reminders',file))]),file);
  }
  const response = await fetch(`https://api.supabase.com/v1/projects/${cred.testRef}/functions/deploy?slug=lifecycle-reminders`, {
    method:'POST',headers:{Authorization:`Bearer ${cred.testPat}`},body:form,
  });
  if (!response.ok) throw new Error(`TEST edge deploy failed: HTTP ${response.status}`);
  const deployed = await response.json();
  if (deployed.verify_jwt !== true) throw new Error('Lifecycle edge must verify JWT');
  // Do not echo SQL or nested psql failure: either could contain the vault input.
  try { psql(test,sql); } catch { throw new Error('TEST lifecycle cron bootstrap failed; inspect DB diagnostics without printing credentials'); }
  console.log('TEST lifecycle edge deployed with verify_jwt=true; 15-minute cron installed; no VAPID.');
}
if (process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  main().catch(error=>{ console.error(error.message); process.exitCode=1; });
}
