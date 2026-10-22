import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runDisposableLocalClusterMatrix } from './network-center-disposable-db.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const migrationPath = 'supabase/migrations/20261022145352_network_center_camera_monitoring_v1.sql';

export async function runCameraProof({ repoRoot = root, environment = process.env, mutation } = {}) {
  const source = await readFile(resolve(repoRoot, migrationPath), 'utf8');
  const migration = mutation ? mutation(source) : source;
  if (mutation && source === migration) throw new Error('Camera proof mutation did not change its input');
  const proof = await readFile(new URL('./__tests__/network-center-camera-runtime.sql', import.meta.url), 'utf8');
  return runDisposableLocalClusterMatrix({ repoRoot, environment,
    buildSql: ({ localProof }) => `
DO $bind$ BEGIN IF NOT EXISTS(SELECT FROM app_private.network_center_disposable_proof WHERE proof_nonce='${localProof.proofNonce}') THEN RAISE EXCEPTION 'Wrong disposable target'; END IF; END $bind$;
-- This harness models network RBAC; can_access_building is supplied as the
-- same scoped predicate, not claimed as full production/PostgREST evidence.
CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog AS 'SELECT public.can_do_on_building(''network_center'',''view'',$1)';
${migration}
${migration}
${proof}`,
    parseVerdict: (output) => {
      if (!output.includes('CAMERA_PROOF_OK')) throw new Error('Camera proof did not finish');
      return { passed: true, migrationAppliedTwice: true, productionPostgrestVerified: false };
    },
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCameraProof().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
