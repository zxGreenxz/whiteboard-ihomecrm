import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FILE_ACTION_CATALOG,
  docActionCatalogIds,
  normalizeRoute,
  routeMatches,
  validateContracts,
} from '../check-copilot-page-contracts.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

// ── Nới có điều kiện cho `financial` + `draft` (G2-E) ────────────────────────
//
// Luật cũ: mọi trang `financial`/`security` phải `read`/`navigate`. Nó chặn cả
// những đường ghi ĐÃ có hàng rào thật (nonce + cú bấm người + kill switch trong
// `copilot_action_registry`), nên nó bị nới — nhưng chỉ khi ba điều kiện cùng
// đúng. Các bài dưới đây tắt TỪNG điều kiện một và đòi gate đỏ trở lại: một
// điều kiện không tự đóng cửa được khi thiếu nó thì nó không phải điều kiện.

const SO_HANH_DONG = new Set(['income_expense.create_draft', 'meter_reading.create']);

function trangDraft(patch = {}) {
  return {
    key: 'income-expenses.draft',
    route: '/income-expense',
    mode: 'draft',
    permission: { module: 'income_expenses', action: 'create' },
    dataClass: 'financial',
    batch: 'billing',
    rolloutKey: 'income-expenses.draft',
    safeControlIds: [],
    actionIds: ['income_expense.create_draft'],
    e2eSpec: '.e2e-fleet/specs/copilot-draft.spec.ts',
    ...patch,
  };
}

function loi(page, actionIds = SO_HANH_DONG) {
  return validateContracts([page], [], [], null, null, actionIds).join('\n');
}

test('financial + draft ĐƯỢC PHÉP khi có e2eSpec và mọi action nằm trong sổ', () => {
  assert.equal(loi(trangDraft()), '');
});

test('thiếu e2eSpec ⇒ đỏ CẢ HAI luật: draft đòi spec, và cửa financial đóng lại', () => {
  const ra = loi(trangDraft({ e2eSpec: undefined }));
  assert.match(ra, /draft requires e2eSpec/);
  assert.match(ra, /high-risk page must be read or navigate/);
});

test('không khai actionIds ⇒ cửa financial vẫn đóng', () => {
  assert.match(loi(trangDraft({ actionIds: undefined })), /high-risk page must be read or navigate/);
});

test('actionIds rỗng ⇒ đỏ, không phải "không có gì để kiểm"', () => {
  const ra = loi(trangDraft({ actionIds: [] }));
  assert.match(ra, /actionIds must not be empty/);
  assert.match(ra, /high-risk page must be read or navigate/);
});

test('action không có trong sổ ⇒ đỏ, và cửa financial đóng lại', () => {
  const ra = loi(trangDraft({ actionIds: ['income_expense.create_draft', 'khong.co_that'] }));
  assert.match(ra, /action khong\.co_that is not in ACTION_CATALOG/);
  assert.match(ra, /high-risk page must be read or navigate/);
});

test('KHÔNG đọc được sổ hành động ⇒ fail-closed, cửa vẫn đóng', () => {
  assert.match(loi(trangDraft(), null), /high-risk page must be read or navigate/);
});

test('security KHÔNG bao giờ được nới, dù khai đủ mọi thứ', () => {
  const ra = loi(trangDraft({ key: 'settings.roles', route: '/settings/roles', dataClass: 'security' }));
  assert.match(ra, /high-risk page must be read or navigate/);
});

test('mode ghi khác `draft` trên trang financial vẫn bị cấm', () => {
  assert.match(loi(trangDraft({ mode: 'filter' })), /high-risk page must be read or navigate/);
});

test('trang không phải high-risk khai action lạ vẫn đỏ ở luật actionIds', () => {
  const ra = loi(trangDraft({ key: 'rooms.list', route: '/apartments', dataClass: 'internal', mode: 'read', actionIds: ['khong.co_that'] }));
  assert.match(ra, /action khong\.co_that is not in ACTION_CATALOG/);
  assert.doesNotMatch(ra, /high-risk page/);
});

test('bộ đọc sổ hành động bóc được id thật từ actionCatalog.ts', () => {
  const ids = docActionCatalogIds(readFileSync(join(repoRoot, FILE_ACTION_CATALOG), 'utf8'));
  assert.ok(ids instanceof Set, 'phải bóc được một Set id');
  for (const id of ['income_expense.create_draft', 'meter_reading.create', 'reservation_deposit.create']) {
    assert.ok(ids.has(id), `sổ thiếu ${id}`);
  }
  // Không nhặt nhầm chữ `actionId` trong `interface ActionCatalogEntry` hay
  // trong chú thích: mọi id phải có dạng `<module>.<hanh_dong>` và có thật.
  for (const id of ids) assert.match(id, /^[a-z_]+\.[a-z_]+$/);
});

test('bộ đọc trả null khi không thấy khối ACTION_CATALOG — người gọi phải fail-closed', () => {
  assert.equal(docActionCatalogIds('export const KHAC = {} as const satisfies X;'), null);
  assert.equal(docActionCatalogIds(''), null);
});
