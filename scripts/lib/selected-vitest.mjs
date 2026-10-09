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

/**
 * Part `index` of `count` over the sorted selection. Round-robin keeps the parts the
 * same size and spreads slow directories; each file lands in exactly one part.
 */
export function shardSelection(files, shard) {
  if (shard === null || shard === undefined) return files;
  const match = /^(\d+)\/(\d+)$/.exec(String(shard));
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || count < 2 || index < 1 || index > count) throw new Error(`Invalid --shard ${shard}; expected <index>/<count>`);
  const part = [...files].sort().filter((_, position) => position % count === index - 1);
  if (!part.length) throw new Error(`Shard ${shard} has no files; the plan must not split a selection this small`);
  return part;
}

export function assertCollectedSelection(selected, collected, root) {
  const actual = collected.map((file) => relative(root, file.filepath).replaceAll('\\', '/')).sort();
  const missing = selected.filter((file) => !actual.includes(file));
  const unexpected = actual.filter((file) => !selected.includes(file));
  if (missing.length) throw new Error(`Selected Vitest files not collected: ${missing.join(', ')}`);
  if (unexpected.length || actual.length !== selected.length) throw new Error(`Unexpected Vitest collection: ${unexpected.join(', ')}`);
}
