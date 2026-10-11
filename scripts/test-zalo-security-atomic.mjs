// Runs behavior proofs only on the independently marked TEST project, always in
// ROLLBACK. Never creates a production connection or reads credentials itself.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migration = readFileSync(join(root, 'supabase/migrations/20261011052259_zalo_rpc_only_scope_va_atomic_queue.sql'), 'utf8');
const harness = readFileSync(join(root, 'scripts/tests/zalo-security-atomic.sql'), 'utf8');
const mutate = process.argv.includes('--mutation-crm-org');
const mutateEcho = process.argv.includes('--mutation-echo-delete');
const needle = 'IF NEW.customer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customers x WHERE x.id=NEW.customer_id AND x.organization_id=v_org) THEN';
if (mutate && !migration.includes(needle)) throw new Error('Mutation point moved; update the proof rather than silently skipping it.');
const echoNeedle = 'DELETE FROM public.zalo_messages WHERE id=e.id;';
if (mutateEcho && !migration.includes(echoNeedle)) throw new Error('Echo mutation point moved; update the proof rather than silently skipping it.');
if (mutate && mutateEcho) throw new Error('Run one mutation at a time.');
const altered = mutate ? migration.replace(needle, 'IF false AND NOT EXISTS(SELECT 1 FROM public.customers x WHERE x.id=NEW.customer_id AND x.organization_id=v_org) THEN')
  : mutateEcho ? migration.replace(echoNeedle, 'DELETE FROM public.zalo_messages WHERE id=m.id;') : migration;
// Reapplying an already installed TEST migration emits many expected notices;
// keep the helper's bounded error output available for the behavioral assertion.
const sql = "SET LOCAL client_min_messages='warning';\n" + altered + "\nSET LOCAL client_min_messages='notice';\n" + harness;
const folder = mkdtempSync(join(tmpdir(), 'ihome-zalo-sql-'));
try {
  const file = join(folder, 'proof.sql');
  writeFileSync(file, sql, 'utf8');
  const result = spawnSync(process.execPath, [join(root, 'scripts/test-env/thu-sql.mjs'), file], { cwd: root, encoding: 'utf8', timeout: 120000 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (mutate || mutateEcho) {
    const assertion = mutate ? 'ZALO_TEST_EXPECTED_DENIAL: service writes still reject CRM cross-org' : 'ZALO_TEST_ASSERT: canonical id/key/media and seen metadata survive echo';
    if (result.status === 0 || !output.includes(assertion)) {
      console.error(output); throw new Error('Mutation did not die at its intended behavioral assertion.');
    }
    console.log(`ZALO_MUTATION_PASS: ${mutate ? 'removing CRM org guard' : 'deleting canonical pending row on echo'} was caught by the behavior test; transaction rolled back.`);
  } else {
    console.log(output.trim());
    if (result.status !== 0 || !output.includes('ZALO_SQL_PASS:')) process.exitCode = 1;
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
