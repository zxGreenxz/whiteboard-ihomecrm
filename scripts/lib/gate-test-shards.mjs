// Small selections stay on one runner. Split broad suites where a second
// runner's checkout and npm install are short compared with test execution.
export const MIN_FILES_TO_SHARD = Object.freeze({ 'node-native': 64, 'app-unit': 256 });

export function filesForTestShard(selection, shard = 1) {
  const count = selection.shards ?? 1;
  if (![1, 2].includes(count) || !Number.isInteger(shard) || shard < 1 || shard > count) {
    throw new Error(`Invalid test shard ${shard} of ${count}`);
  }
  if (selection.files.length < count) throw new Error('Each test shard needs at least one file');
  // The planner sorts paths. Alternating distributes neighbouring SQL/DOM
  // suites without depending on timing data from a previous run.
  return count === 1 ? selection.files : selection.files.filter((_, i) => i % count === shard - 1);
}
