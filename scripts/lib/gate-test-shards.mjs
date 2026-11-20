// Minimum selected files to justify each level of runner parallelism.
export const SHARD_THRESHOLDS = Object.freeze({
  'node-native': { 2: 64 },
  'app-unit': { 2: 256, 4: 1024 },
});

export function shardCountForSuite(suiteId, fileCount) {
  let count = 1;
  for (const [shards, minimum] of Object.entries(SHARD_THRESHOLDS[suiteId] ?? {})) {
    if (fileCount >= minimum) count = Number(shards);
  }
  return count;
}

export function filesForTestShard(selection, shard = 1) {
  const count = selection.shards ?? 1;
  const supported = count === 1 || Object.hasOwn(SHARD_THRESHOLDS[selection.id] ?? {}, count);
  if (!Number.isInteger(count) || !supported || !Number.isInteger(shard) || shard < 1 || shard > count) {
    throw new Error(`Invalid test shard ${shard} of ${count}`);
  }
  if (selection.files.length < count) throw new Error('Each test shard needs at least one file');
  if (count === 1) return selection.files;
  // Preserve the two-shard layout. With four runners, reverse every other
  // group so each runner gets both early and late paths in neighbouring groups.
  return selection.files.filter((_, index) => {
    const offset = index % count;
    const reverse = count === 4 && Math.floor(index / count) % 2 === 1;
    return (reverse ? count - offset : offset + 1) === shard;
  });
}
