// TEST only; run migration + permission comparison in one rolled-back transaction.
import { readFileSync } from 'node:fs';
import { credential, ketNoi, batBuocDichTest, psql } from './test-env/lib.mjs';
import { withTestLock } from './test-env/lock.mjs';

const cred = credential();
const { test } = await ketNoi(cred);
await batBuocDichTest(cred, test);
await withTestLock({ cred, test }, async () => {
  let migration = readFileSync(new URL('../supabase/migrations/20261112093443_manager_collaboration_scopes_v1.sql', import.meta.url), 'utf8');
  const mutation = process.argv.includes('--mutation');
  if (mutation) migration = migration.replace(
    "('voucher.view', 'company', 'income_expenses.print'),",
    "('voucher.view', 'company', 'income_expenses.print'), ('bad', 'company', 'thu_tien.collect'),",
  );
  const decisions = JSON.parse(readFileSync(new URL('../config/manager-collaboration-v1.json', import.meta.url), 'utf8'));
  const expected = decisions.decided.flatMap((d) => d.keys.map((key) => ({ decision_id: d.id, scope_kind: d.scope, permission_key: key })));
  const trustedCatalog = `CREATE TEMP TABLE mc_expected AS SELECT * FROM jsonb_to_recordset('${JSON.stringify(expected).replaceAll("'", "''")}'::jsonb) AS x(decision_id text,scope_kind text,permission_key text);`;
  const assertions = readFileSync(new URL('../supabase/tests/manager_collaboration_v1.sql', import.meta.url), 'utf8');
  let result;
  try {
    result = psql(test, `BEGIN; SET LOCAL client_min_messages=warning;\n${migration}\n${trustedCatalog}\n${assertions}\nROLLBACK;`);
  } catch (error) {
    if (!mutation || !error.message.includes('Catalog differs from approved decisions')) throw error;
    console.log('PASS: unauthorized ThuTien expansion detected; transaction rolled back.');
    return;
  }
  if (mutation) throw new Error('Mutation was not rejected by the decision assertions');
  console.log(result.stdout.trim());
  console.log('PASS: manager collaboration transaction rolled back; production untouched.');
});
