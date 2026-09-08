import { join } from 'node:path';
import { expect, it } from 'vitest';

import { permissionLoaderPath } from '../lib/permission-catalog-loader.mjs';

it('keeps the permission catalog loader in the current worktree', () => {
  const repoRoot = 'C:\\worktrees\\copilot-golden-integrated';
  expect(
    permissionLoaderPath(repoRoot),
  ).toBe(join(repoRoot, '.tmp-permission-catalog', '__perm-keys.mts'));
});
