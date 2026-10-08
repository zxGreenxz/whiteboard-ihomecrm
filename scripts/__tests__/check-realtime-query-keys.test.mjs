import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { main, SAN_SO_KEY } from '../check-realtime-query-keys.mjs';
import { docKeyTuHub, keyTuKetQuaNap, queryRootNames } from '../check-realtime-key-ownership.mjs';

const roots = Array.from({ length: 20 }, (_, i) => `used-${i}`);
const files = ['finance', 'contracts', 'operations'].map((name) => `src/hooks/realtime/${name}.ts`);
const dump = (values = roots) => ({ status: 0, signal: null, stdout: JSON.stringify(values) });
function check(options = {}) {
  const messages = [];
  const status = main({
    listTracked: () => [...files, 'src/hooks/useQueries.ts', 'src/hooks/__tests__/queries.test.ts'].join('\n'),
    readSource: (path) => path === 'src/hooks/useQueries.ts' ? JSON.stringify(roots) : '"orphan-generated"',
    loadDescriptors: () => dump(),
    logger: { log: (message) => messages.push(message), error: (message) => messages.push(message) },
    ...options,
  });
  return { status, messages: messages.join('\n') };
}

test('giữ sàn20 và kiểm root sinh từ helper/spread, gồm orphan chỉ có ở descriptor/test', () => {
  assert.equal(SAN_SO_KEY, 20);
  const prefixes = (names) => names.map((name) => [name]);
  const entries = [{ keys: [...prefixes(roots), ...prefixes(['orphan-generated'])] }];
  const result = check({ loadDescriptors: () => dump(queryRootNames(entries)) });
  assert.equal(result.status, 1);
  assert.match(result.messages, /orphan-generated/);
  assert.equal(check().status, 0);
});

test('loader thất bại trả3 kể cả stdout chứa JSON đầy đủ', () => {
  for (const outcome of [
    { ...dump(), status: 1 },
    { ...dump(), status: null, signal: 'SIGTERM' },
    { ...dump(), error: new Error('spawn failed') },
  ]) assert.equal(check({ loadDescriptors: () => outcome }).status, 3);
  assert.equal(check({ loadDescriptors: () => { throw new Error('cannot write loader'); } }).status, 3);
});

test('JSON/root sai hình dạng và số root duy nhất dưới sàn đều trả3', () => {
  for (const outcome of [
    { ...dump(), stdout: 'not JSON' },
    dump({ roots }), dump([]), dump([...roots, null]), dump([...roots, '   ']),
    dump(roots.slice(0, 19)), dump(Array(20).fill('same-root')),
  ]) assert.equal(check({ loadDescriptors: () => outcome }).status, 3);
});

test('không bỏ qua entry/key sai trong descriptor runtime', () => {
  for (const entries of [null, {}, [null], [{}], [{ keys: {} }], [{ keys: [[]] }], [{ keys: [[3]] }], [{ keys: [['']] }]]) {
    assert.throws(() => queryRootNames(entries));
  }
});

test('không đủ3 file descriptor hoặc không đọc được Git/source trả3', () => {
  assert.equal(check({ listTracked: () => files.slice(0, 2).join('\n') }).status, 3);
  assert.equal(check({ listTracked: () => { throw new Error('git failed'); } }).status, 3);
  assert.equal(check({ readSource: () => { throw new Error('source read failed'); } }).status, 3);
});

test('nạp module thật nhận cả key finance qua helper và key được ghép ở index', () => {
  const actual = keyTuKetQuaNap(docKeyTuHub(), SAN_SO_KEY);
  assert.ok(actual.includes('company-wallets'));
  assert.ok(actual.includes('reservation-settlement-by-voucher'));
  assert.ok(actual.includes('contract-settlement'));
});

test('hai checker chạy song song không giẫm loader và dọn file riêng sau khi chạy', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const temp = new URL('../../.tmp-vite-loaders/', import.meta.url);
  const run = (script) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: root, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output, pid: child.pid }));
  });
  const results = await Promise.all([
    run('scripts/check-realtime-query-keys.mjs'),
    run('scripts/check-realtime-key-ownership.mjs'),
  ]);
  for (const result of results) assert.equal(result.status, 0, result.output);
  const remaining = readdirSync(temp).filter((name) => results.some(({ pid }) => name.startsWith(`__realtime-keys-${pid}-`)));
  assert.deepEqual(remaining, []);
});
