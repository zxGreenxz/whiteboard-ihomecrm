import { join } from 'node:path';

/** Resolving a junctioned node_modules must never move the importer to another checkout. */
export function worktreeViteLoaderPath(repoRoot, filename) {
  return join(repoRoot, '.tmp-vite-loaders', filename);
}
