import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRoute, routeMatches, validateContracts } from '../check-copilot-page-contracts.mjs';

test('normalizes trailing slash and matches wildcard route segments only', () => {
  assert.equal(normalizeRoute('/apartments/'), '/apartments');
  assert.equal(routeMatches('/apartments/*', '/apartments/123'), true);
  assert.equal(routeMatches('/apartments/*', '/apartments'), true);
  assert.equal(routeMatches('/apartments/*', '/apartments-extra'), false);
});

test('unknown route does not become covered by a prefix typo', () => {
  assert.equal(routeMatches('/reports/*', '/reportsx'), false);
});

test('requires every non-redirect route to be contracted or explicitly exempted', () => {
  const routes = [
    { path: '/apartments', redirect: false },
    { path: '/apartments/:id', redirect: false },
    { path: '/legacy', redirect: false },
    { path: '/old', redirect: true },
  ];
  const contracts = [{
    key: 'rooms.list',
    route: '/apartments',
    mode: 'filter',
    permission: { module: 'rooms', action: 'view' },
    dataClass: 'internal',
    batch: 'property',
    rolloutKey: 'rooms.list',
    safeControlIds: [],
  }];
  assert.deepEqual(
    validateContracts(contracts, routes, [{ route: '/apartments/*', reason: 'detail is read-only' }, { route: '/legacy', reason: 'legacy surface' }]),
    [],
  );
  assert.match(
    validateContracts(contracts, [{ path: '/unaccounted', redirect: false }], []).join('\n'),
    /unaccounted.*neither contracted nor exempted/,
  );
});
