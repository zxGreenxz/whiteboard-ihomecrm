import { join } from 'node:path';

/** Keep the Vite importer in the current worktree, never inside node_modules. */
export function permissionLoaderPath(repoRoot) {
  return join(repoRoot, '.tmp-permission-catalog', '__perm-keys.mts');
}
