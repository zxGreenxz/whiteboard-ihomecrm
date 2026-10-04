#!/usr/bin/env node
// Run the existing gate SQL against guarded TEST, not the production ref hardcoded in those CLIs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { credential, ketNoi, batBuocDichTest, psql, psqlJson } from './test-env/lib.mjs';
const cred = credential(), { test } = await ketNoi(cred);
await batBuocDichTest(cred, test);
function gateSql(path) {
 const text = readFileSync(path, 'utf8');
 const literal = text.match(/const sql = (`[\s\S]*?`);/);
 assert(literal, `gate SQL not found: ${path}`);
 return runInNewContext(literal[1], Object.freeze({}), { timeout: 1000 });
}
assert.deepEqual(psqlJson(test, gateSql('scripts/check-stable-fn-locks.mjs').trim().replace(/;$/, '')), []);
console.log('PASS existing stable-function gate SQL on TEST');
const views = psqlJson(test, gateSql('scripts/check-view-invoker.mjs').trim().replace(/;$/, ''));
assert(views.length > 0); assert(views.every(v => v.relkind === 'v' && v.security_invoker === 'true'));
console.log(`PASS existing view-invoker gate SQL on TEST (${views.length} views)`);
const functions = psqlJson(test, `select proname,provolatile,prosecdef,proconfig,
 has_function_privilege('anon',oid,'execute') anon,
 has_function_privilege('authenticated',oid,'execute') authenticated
 from pg_proc where pronamespace='public'::regnamespace and proname like 'personal_finance_%'`);
assert.equal(functions.length, 4);
for (const f of functions) {
 assert.equal(f.anon, false); assert.equal(f.authenticated, f.proname !== 'personal_finance_apply');
 assert.equal(f.provolatile, f.proname === 'personal_finance_snapshot' ? 's' : 'v');
 assert.equal(f.prosecdef, f.proname !== 'personal_finance_snapshot');
 assert(f.proconfig.includes('search_path=pg_catalog, public'));
}
console.log('PASS function ACL, search_path, volatility and invoker/definer boundaries');
const tables = psqlJson(test, `select c.relname,c.relrowsecurity,
 has_table_privilege('anon',c.oid,'select,insert,update,delete') anon,
 has_table_privilege('authenticated',c.oid,'insert,update,delete,truncate') direct_write,
 has_table_privilege('authenticated',c.oid,'select') own_read
 from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'
 and c.relname in ('personal_transactions','personal_wallets','personal_categories','personal_legacy_category_map','personal_goals','personal_budget_limits','personal_wallet_transfers','personal_finance_requests')`);
assert.equal(tables.length, 8); for (const t of tables) { assert(t.relrowsecurity); assert(!t.anon); assert(!t.direct_write); assert(t.own_read); }
const columnGrants = psqlJson(test, `select table_name,column_name,privilege_type from information_schema.column_privileges where table_schema='public' and table_name like 'personal_%' and grantee in ('anon','authenticated','PUBLIC') and privilege_type in ('INSERT','UPDATE','REFERENCES')`);
assert.deepEqual(columnGrants, []);
const policies = psqlJson(test, "select policyname from pg_policies where schemaname='public' and tablename='personal_transactions'").map(r => r.policyname);
assert(policies.includes('personal_txn_own')); assert(policies.some(p => p.includes('hide_sandbox'))); assert(!policies.includes('personal_transactions_org_boundary'));
console.log('PASS table/column ACL, owner RLS, retained hide_sandbox and removed org_boundary');
const exemptions = psqlJson(test, "select expires_at,replacement_policy from app_private.org_boundary_exemptions where table_name='personal_transactions'");
assert.equal(exemptions.length,1); assert(exemptions[0].replacement_policy.includes('personal_txn_own'));
psql(test, `BEGIN;
 ALTER TABLE public.personal_transactions ENABLE ROW LEVEL SECURITY;
 DO $verify$ BEGIN
  IF app_private.ensure_org_boundary_v1('personal_transactions') OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='personal_transactions' AND policyname='personal_transactions_org_boundary') THEN
   RAISE EXCEPTION 'actor-owned exemption did not survive DDL';
  END IF;
 END $verify$;
 ROLLBACK;`);
console.log(`PASS actor ownership survives future DDL/event trigger; exemption review ${exemptions[0].expires_at}`);
