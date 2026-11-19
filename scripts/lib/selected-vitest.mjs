import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { filesForTestShard } from './gate-test-shards.mjs';

export function selectionDigest(files) {
  return createHash('sha256').update(JSON.stringify([...files].sort())).digest('hex');
}

export function selectedVitestFiles(plan, expectedDigest, shard = 1) {
  const selections = plan?.suiteSelections?.filter((selection) => selection.id === 'app-unit');
  if (selections?.length !== 1 || !Array.isArray(selections[0].files) || selections[0].files.length === 0) throw new Error('Missing or empty app-unit selection');
  validateExactVitestFiles(selections[0].files);
  const files = filesForTestShard(selections[0], shard);
  if (selectionDigest(files) !== expectedDigest) throw new Error('Selected Vitest file digest differs from the gate command');
  return [...files].sort();
}

export function validateExactVitestFiles(files) {
  if (!files.length) throw new Error('Empty Vitest file selection');
  if (new Set(files).size !== files.length) throw new Error('Duplicate file in Vitest selection');
  for (const file of files) {
    if (typeof file !== 'string' || /[\\:*?{}[\]!]/.test(file) || file.startsWith('/') ||
      file.split('/').some((part) => !part || part === '.' || part === '..') || !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) {
      throw new Error(`Selection requires an exact repository-relative test path: ${file}`);
    }
  }
}

export function assertCollectedSelection(selected, collected, root) {
  const actual = collected.map((file) => relative(root, file.filepath).replaceAll('\\', '/')).sort();
  const missing = selected.filter((file) => !actual.includes(file));
  const unexpected = actual.filter((file) => !selected.includes(file));
  if (missing.length) throw new Error(`Selected Vitest files not collected: ${missing.join(', ')}`);
  if (unexpected.length || actual.length !== selected.length) throw new Error(`Unexpected Vitest collection: ${unexpected.join(', ')}`);
}
