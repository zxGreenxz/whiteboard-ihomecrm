import { join } from 'node:path';
import { expect, it } from 'vitest';

import { worktreeViteLoaderPath } from '../lib/worktree-vite-loader.mjs';

it('places temporary Vite loaders inside the active worktree', () => {
  const repoRoot = 'C:\\worktrees\\copilot-golden-integrated';
  expect(worktreeViteLoaderPath(repoRoot, '__rt-surface.mts')).toBe(
    join(repoRoot, '.tmp-vite-loaders', '__rt-surface.mts'),
  );
});
