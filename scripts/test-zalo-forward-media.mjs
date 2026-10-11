// Real PostgreSQL proofs on the marked TEST project; one ROLLBACK transaction.
// No provider calls, production writes, or credentials read by this runner.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = readFileSync(join(root, 'supabase/migrations/20261011052259_zalo_rpc_only_scope_va_atomic_queue.sql'), 'utf8');
let migration = readFileSync(join(root, 'supabase/migrations/20261011073522_zalo_chuyen_tiep_media_theo_tin_nguon.sql'), 'utf8');
const harness = readFileSync(join(root, 'scripts/tests/zalo-forward-media.sql'), 'utf8');
const mutation = process.argv.find(arg => arg.startsWith('--mutation-'));
const mutations = {
  '--mutation-fingerprint': ['IF v_existing_fingerprint IS DISTINCT FROM v_fingerprint THEN', 'IF false THEN', 'FORWARD_ASSERT: changed target set does not append new jobs'],
  '--mutation-source-org': ['(p_org IS NOT NULL AND m.organization_id IS DISTINCT FROM p_org)', 'false', 'FORWARD_EXPECTED_DENIAL: service queue rejects foreign source'],
  '--mutation-first-caption': ["v_caption:=NULLIF(array_to_string(v_image_captions,E'\\n'),'');", 'v_caption:=v_image_captions[1];', 'FORWARD_ASSERT: all distinct image captions survive in source order'],
};
if (mutation) {
  const point = mutations[mutation];
  if (!point || !migration.includes(point[0])) throw new Error('Unknown/moved mutation point; never silently skip a proof.');
  migration = migration.replace(point[0], point[1]);
}
const folder = mkdtempSync(join(tmpdir(), 'ihome-zalo-forward-'));
try {
  const path = join(folder, 'proof.sql');
  // TEST may lag production. Overlay only the exact two Zalo prerequisites in
  // this transaction; unrelated NULL fixtures and schema are left untouched.
  writeFileSync(path, "SET LOCAL client_min_messages='warning';\n" + base + '\n' + migration + "\nSET LOCAL client_min_messages='notice';\n" + harness);
  const result = spawnSync(process.execPath, [join(root, 'scripts/test-env/thu-sql.mjs'), path], { cwd: root, encoding: 'utf8', timeout: 120000 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (mutation) {
    if (result.status === 0 || !output.includes(mutations[mutation][2])) { console.error(output); throw new Error('Mutation did not die at its intended behavioral assertion.'); }
    console.log(`FORWARD_MUTATION_PASS: ${mutation}; intended behavioral assertion caught it; rolled back.`);
  } else {
    console.log(output.trim());
    if (result.status !== 0 || !output.includes('FORWARD_SQL_PASS:')) process.exitCode = 1;
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
