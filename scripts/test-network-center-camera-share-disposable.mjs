import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runDisposableLocalClusterMatrix } from './network-center-disposable-db.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cameraPath = 'supabase/migrations/20261022145352_network_center_camera_monitoring_v1.sql';
const sharePath = 'supabase/migrations/20261110070438_network_center_camera_share_v1.sql';

/** Applies the camera-share migration twice on a disposable cluster, then runs the role-switching proof. */
export async function runCameraShareProof({ repoRoot = root, environment = process.env, mutation } = {}) {
  const camera = await readFile(resolve(repoRoot, cameraPath), 'utf8');
  const source = await readFile(resolve(repoRoot, sharePath), 'utf8');
  const migration = mutation ? mutation(source) : source;
  if (mutation && source === migration) throw new Error('Camera share proof mutation did not change its input');
  const proof = await readFile(new URL('./__tests__/network-center-camera-share-runtime.sql', import.meta.url), 'utf8');
  return runDisposableLocalClusterMatrix({ repoRoot, environment,
    buildSql: ({ localProof }) => `
DO $bind$ BEGIN IF NOT EXISTS(SELECT FROM app_private.network_center_disposable_proof WHERE proof_nonce='${localProof.proofNonce}') THEN RAISE EXCEPTION 'Wrong disposable target'; END IF; END $bind$;
-- Harness RBAC is the scoped predicate of the Network Center proofs; this is not
-- claimed as production/PostgREST evidence.
${camera}
${migration}
${migration}
${proof}`,
    parseVerdict: (output) => {
      if (!output.includes('CAMERA_SHARE_PROOF_OK')) throw new Error('Camera share proof did not finish');
      return { passed: true, migrationAppliedTwice: true, productionPostgrestVerified: false };
    },
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCameraShareProof().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
