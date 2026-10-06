import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { indexInputConflicts } from '../lib/local-gate-snapshot.mjs';
const dirs = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gate-index-')); dirs.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init'); git('config', 'core.autocrlf', 'false');
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n'); git('add', 'a.ts');
  return { root, git };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('local index input identity', () => {
  it('rejects unstaged executable input and untracked input, preserves index', () => {
    const { root, git } = fixture();
    writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(root, 'new.ts'), 'export const b = 3;\n');
    expect(indexInputConflicts(root, ['**/*.ts'])).toEqual(['a.ts', 'new.ts']);
    expect(git('show', ':a.ts').toString()).toContain('a = 1');
  });
  it('ignores WIP outside selected inputs but detects deletion', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'notes.md'), 'my WIP');
    expect(indexInputConflicts(root, ['**/*.ts'])).toEqual([]);
    rmSync(join(root, 'a.ts'));
    expect(indexInputConflicts(root, ['**/*.ts'])).toEqual(['a.ts']);
  });
  it('allows checkout CRLF only, not other whitespace/content changes', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\r\n');
    expect(indexInputConflicts(root, ['**/*.ts'])).toEqual([]);
    writeFileSync(join(root, 'a.ts'), 'export const a = 1; \r\n');
    expect(indexInputConflicts(root, ['**/*.ts'])).toEqual(['a.ts']);
  });
});
