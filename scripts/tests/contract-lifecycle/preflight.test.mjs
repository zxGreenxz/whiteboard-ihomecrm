import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  validateTestTarget,
  withVerifiedTestTarget,
  captureNamedCatalog,
  compareNamedCatalog,
  catalogHash,
  assertRequiredFixtures,
} from '../../contract-lifecycle/preflight.mjs';

const ref = 'abcdefghijklmnopqrst';
const target = { expectedRef: ref, url: `https://${ref}.supabase.co` };

test('target validation rejects absent, production, unknown and inconsistent destinations', () => {
  for (const config of [
    {},
    { ...target, expectedRef: 'tryymsxyyckgbrmmvozx' },
    { ...target, url: 'https://example.com' },
    { ...target, url: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co' },
    { ...target, url: `http://${ref}.supabase.co` },
    { ...target, url: `https://${ref}.supabase.co/rest/v1` },
  ]) assert.throws(() => validateTestTarget(config));
  assert.deepEqual(validateTestTarget(target), target);
});

test('mutation runs only after exact server marker is verified', async () => {
  let writes = 0;
  const mutate = async () => ++writes;
  await assert.rejects(withVerifiedTestTarget(target, { readMarker: async () => null, mutate }));
  await assert.rejects(withVerifiedTestTarget(target, { readMarker: async () => ({ ref: 'wrong' }), mutate }));
  assert.equal(writes, 0);
  assert.equal(await withVerifiedTestTarget(target, { readMarker: async () => ({ ref }), mutate }), 1);
});

test('catalog capture fetches past 1000 rows and compares exact named requirements', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({ id: String(i).padStart(4, '0'), value: i }));
  const fetchPage = async (_name, offset, limit) => ({ rows: rows.slice(offset, offset + limit), totalCount: rows.length });
  const actual = await captureNamedCatalog({ requirements: [{ name: 'writers', minRows: 1001 }], fetchPage, pageSize: 1000 });
  assert.equal(actual.writers.rowCount, 1001);
  assert.equal(actual.writers.rows[1000].id, '1000');
  assert.deepEqual(compareNamedCatalog(actual, { writers: { minRows: 1001, sha256: catalogHash(rows) } }), { ready: true, errors: [] });
  assert.equal(compareNamedCatalog(actual, { writers: { minRows: 1001, sha256: '0'.repeat(64) } }).ready, false);
  assert.equal(compareNamedCatalog(actual, { missing: { minRows: 1, sha256: '0'.repeat(64) } }).ready, false);
});

test('catalog capture rejects empty, duplicate, unsorted and incomplete pages', async () => {
  const req = [{ name: 'writers', minRows: 1 }];
  await assert.rejects(captureNamedCatalog({ requirements: req, fetchPage: async () => ({ rows: [], totalCount: 0 }) }));
  await assert.rejects(captureNamedCatalog({ requirements: req, fetchPage: async () => ({ rows: [{ id: 'a' }, { id: 'a' }], totalCount: 2 }) }));
  await assert.rejects(captureNamedCatalog({ requirements: req, fetchPage: async () => ({ rows: [{ id: 'b' }, { id: 'a' }], totalCount: 2 }) }));
  await assert.rejects(captureNamedCatalog({ requirements: req, fetchPage: async () => ({ rows: [{ id: 'a' }], totalCount: 2 }), pageSize: 1 }));
  await assert.rejects(captureNamedCatalog({ requirements: req, fetchPage: async () => ({ rows: [{ id: 'a' }], totalCount: 200000 }), maxRows: 1000 }));
});

test('catalog comparison rejects missing and tampered capture fields', () => {
  const rows = [{ id: 'a' }];
  const sha256 = catalogHash(rows);
  const expected = { writers: { minRows: 1, sha256 } };
  for (const captured of [
    { rowCount: 1, sha256, rows: [] },
    { sha256, rows },
    { rowCount: 1, sha256 },
    { rowCount: 1.5, sha256, rows },
    { rowCount: 1, sha256: 'invalid', rows },
    { rowCount: 1, sha256, rows: [{ id: 'b' }] },
  ]) {
    const comparison = compareNamedCatalog({ writers: captured }, expected);
    assert.equal(comparison.ready, false, JSON.stringify(captured));
    assert.ok(comparison.errors.length > 0);
  }
});

test('fixture admission rejects missing role, JWT and unstable IDs', () => {
  const fixture = {
    fixtureIds: { lease: '11111111-1111-4111-8111-111111111111' },
    jwtByRole: { manager: 'jwt1', accountant: 'jwt2', sale: 'jwt3', crossOrg: 'jwt4', revoked: 'jwt5' },
  };
  assert.deepEqual(assertRequiredFixtures(fixture), fixture);
  assert.throws(() => assertRequiredFixtures({ ...fixture, fixtureIds: {} }));
  assert.throws(() => assertRequiredFixtures({ ...fixture, fixtureIds: { lease: 'random' } }));
  assert.throws(() => assertRequiredFixtures({ ...fixture, jwtByRole: { manager: 'jwt1' } }));
});
