import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globSangRegex } from '../check-risk-classifier.mjs';

/** The commands read disk. Only claim index evidence when selected disk inputs match it. */
export function indexInputConflicts(root, inputs) {
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  const matchers = inputs.map(globSangRegex);
  const paths = new Set([
    ...git(['diff', '--name-only', '-z']).toString().split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0'),
  ].filter(Boolean));
  return [...paths].filter((path) => {
    if (!matchers.some((re) => re.test(path))) return false;
    if (!existsSync(join(root, path))) return true;
    let index;
    try { index = git(['show', `:${path}`]); } catch { return true; }
    const disk = readFileSync(join(root, path));
    if (disk.equals(index)) return false;
    // Git checkouts may normalize text EOL; never ignore other whitespace or bytes.
    if (!disk.includes(0) && !index.includes(0)) return disk.toString('utf8').replace(/\r\n/g, '\n') !== index.toString('utf8').replace(/\r\n/g, '\n');
    return true;
  }).sort();
}
