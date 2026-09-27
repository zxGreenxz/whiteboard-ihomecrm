import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { validateReconcileScope, compareV1, compareV2, readSqlPages, runV1, v1Sql } from '../../contract-lifecycle/reconcile.mjs';

const scope = { expectedRef: 'abcdefghijklmnopqrst', url: 'https://abcdefghijklmnopqrst.supabase.co', organizationId: 'aaaa0000-0000-4000-8000-000000000001' };

test('scope rejects missing target, mismatched credential and subset fields before I/O', () => {
  assert.throws(() => validateReconcileScope({ organizationId: scope.organizationId }, scope.expectedRef));
  assert.throws(() => validateReconcileScope({ ...scope, voucherIds: [] }, scope.expectedRef));
  assert.throws(() => validateReconcileScope(scope, 'bbbbbbbbbbbbbbbbbbbb'));
  assert.deepEqual(validateReconcileScope(scope, scope.expectedRef), scope);
});

test('V1 equal sums cannot hide a different source set or an empty RPC', () => {
  const a = [{ id: 'a', total_amount: '10' }, { id: 'b', total_amount: '20' }];
  const c = [{ id: 'a', total_amount: '10' }, { id: 'c', total_amount: '20' }];
  const truth = { count: 2, sum: '30' };
  assert.equal(compareV1({ before: a, after: a, rest: c, rpc: [{ cash_income: 30, internal_income: 0, pending_income: 0 }], pages: 2, truth }).status, 1);
  assert.equal(compareV1({ before: a, after: a, rest: a, rpc: [], pages: 2, truth }).status, 3);
  assert.equal(compareV1({ before: a, after: a, rest: a, rpc: [{ cash_income: 30, internal_income: 0, pending_income: 0 }], pages: 2, truth }).status, 3);
});

test('V1 known REST loss wins over missing cap evidence', () => {
  const before = [{ id: 'a', total_amount: '10' }];
  assert.equal(compareV1({ before, after: before, rest: [], rpc: [{ cash_income: '0', internal_income: '0', pending_income: '0' }], truth: { count: 1, sum: '10' }, pages: 0 }).status, 1);
});

test('V1 rejects an already rounded unsafe JSON number', () => {
  const before = [{ id: 'a', total_amount: 9007199254740992 }];
  assert.equal(compareV1({ before, after: before, rest: before, rpc: [{ cash_income: '9007199254740992', internal_income: '0', pending_income: '0' }], truth: { count: 1, sum: '9007199254740992' }, pages: 1 }).status, 2);
});

test('V1 detects source drift even when sum stays equal', () => {
  const before = [{ id: 'a', total_amount: '10', approval_status: 'APPROVED' }];
  const after = [{ id: 'a', total_amount: '10', approval_status: 'PENDING' }];
  assert.equal(compareV1({ before, after, rest: before, rpc: [{ cash_income: 10, internal_income: 0, pending_income: 0 }], pages: 1, truth: { count: 1, sum: '10' } }).status, 1);
});

test('V2 requires both view counterparts and checks posting IDs with equal sums', () => {
  const accounts = [{ id: 'a' }];
  const legacy = [{ id: 'a', current_amount: '10' }];
  const v2 = [{ id: 'a', current_amount: '10' }];
  assert.equal(compareV2({ accounts, legacy, v2: [], truth: { count: 1001, sum: '0' }, postings: [] }).status, 3);
  const postings = Array.from({ length: 1001 }, (_, i) => ({ id: String(i).padStart(4, '0'), signed_amount: '0' }));
  const idDigest = createHash('md5').update(postings.map(r => r.id).join(',')).digest('hex');
  const swapped = postings.map((r, i) => i === 1 ? { ...r, id: '0001a' } : r);
  assert.equal(compareV2({ accounts, legacy, v2, truth: { count: 1001, sum: '0', idDigest }, postings: swapped }).status, 1);
});

test('V2 known account balance mismatch wins over empty monthly postings', () => {
  const accounts = [{ id: 'a' }];
  const legacy = [{ id: 'a', current_amount: '10' }];
  const v2 = [{ id: 'a', current_amount: '11' }];
  assert.equal(compareV2({ accounts, legacy, v2, truth: { count: 0, sum: '0' }, postings: [] }).status, 1);
  assert.equal(compareV2({ accounts, legacy, v2: [{ id: 'a', current_amount: 'garbage' }], truth: { count: 0, sum: '0' }, postings: [] }).status, 2);
});

test('SQL paging rejects truncated pages and changed counts', async () => {
  await assert.rejects(readSqlPages(async (offset) => offset === 0 ? { rows: [{ id: 'a' }], totalCount: 2 } : { rows: [], totalCount: 2 }, { pageSize: 1 }));
  await assert.rejects(readSqlPages(async (offset) => offset === 0 ? { rows: [{ id: 'a' }], totalCount: 2 } : { rows: [{ id: 'b' }], totalCount: 3 }, { pageSize: 1 }));
});

test('V1 after snapshot opens a distinct read-only transaction and catches changed eligible row', async () => {
  const before = [{ id: 'a', total_amount: '10', approval_status: 'APPROVED' }];
  const after = [{ id: 'a', total_amount: '11', approval_status: 'APPROVED' }];
  const admissions = [];
  const transaction = async (_config, { readOnly, run }) => {
    admissions.push(readOnly);
    return run({ query: async () => ({ rows: [{ id: scope.organizationId }] }) });
  };
  const sqlReader = async () => ({ before: admissions.length === 1 ? before : after, truth: { count: 1, sum: admissions.length === 1 ? '10' : '11' } });
  const createHttp = () => ({ signIn: async () => 'jwt', rpc: async () => [{ cash_income: '10', internal_income: '0', pending_income: '0' }] });
  const selectRows = async () => before;
  const result = await runV1({}, scope, { email: 'actor@test', password: 'secret' }, 'key', { transaction, sqlReader, createHttp, selectRows });
  assert.deepEqual(admissions, [true, true]);
  assert.equal(result.status, 1);
});

test('V1 real REST paginator classifies exact empty as mismatch while malformed range remains an error', async () => {
  const before = [{ id: 'a', total_amount: '10' }];
  const transaction = async (_config, { run }) => run({ query: async () => ({ rows: [{ id: scope.organizationId }] }) });
  const sqlReader = async () => ({ before, truth: { count: 1, sum: '10' } });
  const invoke = async (range, rows) => runV1({}, scope, { email: 'actor@test', password: 'secret' }, 'key', {
    transaction, sqlReader,
    createHttp: () => ({
      signIn: async () => 'jwt',
      rpc: async () => [{ cash_income: '10', internal_income: '0', pending_income: '0' }],
      selectPage: async () => ({ headers: new Headers({ 'content-range': range }), rows }),
    }),
  });
  const empty = await invoke('*/0', []);
  assert.equal(empty.status, 1);
  assert.equal(empty.reason, 'source_mismatch');
  assert.equal((await invoke('bad-range', [])).status, 2);
  assert.equal((await invoke('0-0/1', before)).status, 3);
});

test('V1 SQL source excludes a different organization before deriving RPC IDs', async () => {
  const query = async (sql, values) => {
    const scoped = sql.includes('organization_id = $1') && values[0] === scope.organizationId;
    if (sql.includes('count(*)::int AS c FROM')) return { rows: [{ c: scoped ? 1 : 2 }] };
    if (sql.includes('count(*)')) return { rows: [{ count: scoped ? 1 : 2, sum: scoped ? '10' : '20' }] };
    return { rows: scoped ? [{ id: 'a', total_amount: '10' }] : [{ id: 'a', total_amount: '10' }, { id: 'b', total_amount: '10' }] };
  };
  const result = await v1Sql({ query }, scope, { start: '1900-01-01', end: '9999-12-31' });
  assert.deepEqual(result.before.map(r => r.id), ['a']);
  assert.equal(result.truth.count, 1);
});
