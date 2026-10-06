import { createHash } from 'node:crypto';
import { relative } from 'node:path';

export function selectionDigest(files) {
  return createHash('sha256').update(JSON.stringify([...files].sort())).digest('hex');
}

export function selectedVitestFiles(plan, expectedDigest) {
  const selections = plan?.suiteSelections?.filter((selection) => selection.id === 'app-unit');
  if (selections?.length !== 1 || !Array.isArray(selections[0].files) || selections[0].files.length === 0) throw new Error('Missing or empty app-unit selection');
  const files = selections[0].files;
  if (new Set(files).size !== files.length) throw new Error('Duplicate file in app-unit selection');
  for (const file of files) {
    if (typeof file !== 'string' || /[\\:*?{}[\]!]/.test(file) || file.startsWith('/') ||
      file.split('/').some((part) => !part || part === '.' || part === '..') || !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) {
      throw new Error(`Selection requires an exact repository-relative test path: ${file}`);
    }
  }
  if (selectionDigest(files) !== expectedDigest) throw new Error('Selected Vitest file digest differs from the gate command');
  return [...files].sort();
}

export function assertCollectedSelection(selected, collected, root) {
  const actual = collected.map((file) => relative(root, file.filepath).replaceAll('\\', '/')).sort();
  const missing = selected.filter((file) => !actual.includes(file));
  const unexpected = actual.filter((file) => !selected.includes(file));
  if (missing.length) throw new Error(`Selected Vitest files not collected: ${missing.join(', ')}`);
  if (unexpected.length || actual.length !== selected.length) throw new Error(`Unexpected Vitest collection: ${unexpected.join(', ')}`);
}
