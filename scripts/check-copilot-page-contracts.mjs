#!/usr/bin/env node
import { writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectAllRoutes } from './check-route-guards.mjs';

export function normalizeRoute(value) {
  const route = String(value ?? '').split(/[?#]/, 1)[0];
  return route.replace(/\/+$/, '') || '/';
}

export function routeMatches(pattern, pathname) {
  const p = normalizeRoute(pattern);
  const actual = normalizeRoute(pathname);
  if (p === '*') return actual === '*';
  const patternParts = p.split('/').filter(Boolean);
  const actualParts = actual.split('/').filter(Boolean);
  const splat = patternParts.at(-1) === '*';
  const fixedLength = splat ? patternParts.length - 1 : patternParts.length;
  if ((!splat && patternParts.length !== actualParts.length) || actualParts.length < fixedLength) return false;
  return patternParts.slice(0, fixedLength).every((part, index) => part.startsWith(':') || part === actualParts[index]);
}

function loadContracts(repoRoot) {
  // Worktree node_modules is commonly a junction to another checkout. Keep the
  // generated importer in this repo so relative resolution cannot cross trees.
  const tmp = join(repoRoot, '.tmp-copilot-loaders', '__copilot_page_contracts.mts');
  const source = [
    "import { COPILOT_PAGE_CONTRACTS } from '../src/app/capabilities/registry';",
    'console.log(JSON.stringify(COPILOT_PAGE_CONTRACTS));',
  ].join('\n');
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, source, 'utf8');
  try {
    const result = spawnSync('npx', ['vite-node', '.tmp-copilot-loaders/__copilot_page_contracts.mts'], {
      cwd: repoRoot, encoding: 'utf8', shell: true, timeout: 120_000,
    });
    const line = String(result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
    return line ? JSON.parse(line) : null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Đường dẫn tương đối tới mirror TS của sổ đăng ký hành động. */
export const FILE_ACTION_CATALOG = join('src', 'copilot', 'plan', 'actionCatalog.ts');

/**
 * Bóc tập `action_id` từ `ACTION_CATALOG` bằng REGEX, không import.
 *
 * VÌ SAO REGEX chứ không `vite-node` như hai bộ nạp bên trên: file đó kéo theo
 * `zod` và `@/lib/permissions`, và bộ nạp của gate này chạy trong worktree có
 * `node_modules` là junction sang checkout khác. Regex đọc đúng thứ cần — TÊN
 * hành động — và không phụ thuộc vào việc dựng được cả cây import.
 *
 * Chỉ đọc trong khối `export const ACTION_CATALOG = { … } as const`: `actionId`
 * còn xuất hiện trong `interface ActionCatalogEntry` và trong chú thích, và một
 * bộ đọc quét cả file sẽ nhặt cả những chỗ đó.
 *
 * Trả `null` khi không bóc được gì. Người gọi phải coi `null` là "không biết"
 * và giữ nguyên luật nghiêm — chứ không phải "không có hành động nào".
 */
export function docActionCatalogIds(source) {
  const text = String(source ?? '');
  const start = text.indexOf('export const ACTION_CATALOG');
  if (start < 0) return null;
  const end = text.indexOf('} as const satisfies', start);
  if (end < 0) return null;
  const khoi = text.slice(start, end);
  const ids = [...khoi.matchAll(/\bactionId\s*:\s*['"]([a-z_]+\.[a-z_]+)['"]/g)].map((m) => m[1]);
  return ids.length ? new Set(ids) : null;
}

function loadActionCatalogIds(repoRoot) {
  try {
    return docActionCatalogIds(readFileSync(join(repoRoot, FILE_ACTION_CATALOG), 'utf8'));
  } catch {
    return null;
  }
}

function loadPermissionKeys(repoRoot) {
  const tmp = join(repoRoot, '.tmp-copilot-loaders', '__copilot_permission_keys.mts');
  const source = [
    "import { ALL_PAGE_FEATURES } from '../src/lib/permissionPages';",
    'console.log(JSON.stringify([...new Set(ALL_PAGE_FEATURES.map((f) => `${f.module}.${f.action}`))]));',
  ].join('\n');
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, source, 'utf8');
  try {
    const result = spawnSync('npx', ['vite-node', '.tmp-copilot-loaders/__copilot_permission_keys.mts'], {
      cwd: repoRoot, encoding: 'utf8', shell: true, timeout: 120_000,
    });
    const line = String(result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
    return line ? new Set(JSON.parse(line)) : null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function validateContracts(
  contracts,
  routes = [],
  exemptions = [],
  permissionKeys = null,
  expectedRouteCount = null,
  actionIds = null,
) {
  const problems = [];
  const keys = new Set();
  const routeSet = new Set();
  for (const page of contracts ?? []) {
    if (!page?.key || keys.has(page.key)) problems.push(`duplicate or missing key: ${page?.key ?? '<empty>'}`);
    keys.add(page?.key);
    const route = normalizeRoute(page?.route);
    if (!route || routeSet.has(route)) problems.push(`duplicate or missing route: ${page?.route ?? '<empty>'}`);
    routeSet.add(route);
    if (!['none', 'read', 'navigate', 'filter', 'draft'].includes(page?.mode)) problems.push(`${page.key}: invalid mode`);
    if (!['property', 'crm', 'billing', 'reports', 'communications', 'workforce'].includes(page?.batch)) {
      problems.push(`${page.key}: invalid or missing batch`);
    }
    if (typeof page?.rolloutKey !== 'string' || !page.rolloutKey.trim()) {
      problems.push(`${page.key}: rolloutKey is required`);
    }
    if (page?.canonicalRoute !== undefined && (!String(page.canonicalRoute).startsWith('/') || /:\w+|\*$/.test(page.canonicalRoute))) {
      problems.push(`${page.key}: canonicalRoute must be a concrete path`);
    }
    if (!page?.permission?.module || !page?.permission?.action) problems.push(`${page.key}: missing permission`);
    if (permissionKeys && !permissionKeys.has(`${page.permission.module}.${page.permission.action}`)) {
      problems.push(`${page.key}: permission ${page.permission.module}.${page.permission.action} is not registered`);
    }
    if (!Array.isArray(page?.safeControlIds)) problems.push(`${page.key}: safeControlIds must be an array`);
    if (page?.mode === 'draft' && !page?.e2eSpec) problems.push(`${page.key}: draft requires e2eSpec`);

    // Một trang khai `actionIds` là một trang nói "Copilot ghi được ở đây, và
    // đây là những hành động nó được cầm". Mọi id phải có trong sổ hành động —
    // một id không có trong sổ nghĩa là trang quảng cáo một cửa mà server không
    // biết, và `copilot_action_gate_v1` sẽ từ chối nó với `copilot_action_disabled`.
    const khaiActionIds = Array.isArray(page?.actionIds) ? page.actionIds : null;
    if (khaiActionIds) {
      if (khaiActionIds.length === 0) problems.push(`${page.key}: actionIds must not be empty`);
      for (const id of khaiActionIds) {
        if (actionIds && !actionIds.has(id)) {
          problems.push(`${page.key}: action ${id} is not in ACTION_CATALOG`);
        }
      }
    }

    // NỚI CÓ ĐIỀU KIỆN cho `financial` + `draft`, và chỉ cho nó.
    //
    // Luật cũ cấm mọi mode ghi trên trang `financial`/`security`. Nó đúng khi
    // chưa có cơ chế nào chứng minh một đường ghi đã được rào — nhưng từ G2-A
    // thì có: mỗi hành động là một hàng trong `copilot_action_registry` với cờ
    // kill switch riêng, và `ACTION_CATALOG` là bản sao client của sổ đó. Nên
    // cửa mở ĐÚNG BA điều kiện cùng lúc, và cả ba đều kiểm được ở build time:
    //   1. mode là `draft` (không phải `filter`/`none` nào khác),
    //   2. trang khai `actionIds` và MỌI id đều có trong sổ hành động,
    //   3. trang có `e2eSpec` — có một đường khói đi qua nó bằng trình duyệt.
    //
    // `security` KHÔNG được nới: quyền và bí mật không có "bản nháp".
    //
    // Fail-closed khi không đọc được sổ (`actionIds === null`): không biết thì
    // giữ nguyên luật nghiêm, chứ không phải cho qua.
    const draftDuocPhep =
      page?.mode === 'draft' &&
      page?.dataClass === 'financial' &&
      Boolean(page?.e2eSpec) &&
      Boolean(actionIds) &&
      Array.isArray(khaiActionIds) &&
      khaiActionIds.length > 0 &&
      khaiActionIds.every((id) => actionIds.has(id));

    if (
      ['financial', 'security'].includes(page?.dataClass) &&
      !['read', 'navigate'].includes(page?.mode) &&
      !draftDuocPhep
    ) {
      problems.push(`${page.key}: high-risk page must be read or navigate`);
    }
  }

  if (routes.length) {
    if (expectedRouteCount !== null && routes.length < 100) problems.push(`route inventory too small: ${routes.length}`);
    const accounted = [];
    for (const route of routes) {
      const path = typeof route === 'string' ? route : route?.path;
      if (!path || route?.redirect || path === '(index)') continue;
      const contracted = (contracts ?? []).some((page) => routeMatches(page.route, path));
      const exemption = (exemptions ?? []).find((entry) => routeMatches(entry.route, path));
      if (!contracted && !exemption) {
        problems.push(`${path}: route is neither contracted nor exempted`);
      } else if (exemption && !exemption.reason?.trim()) {
        problems.push(`${exemption.route}: exemption requires a reason`);
      }
      accounted.push(path);
    }
    if (expectedRouteCount !== null && accounted.length !== expectedRouteCount) {
      problems.push(`expected ${expectedRouteCount} non-redirect routes, found ${accounted.length}`);
    }
  }
  return problems;
}

function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const contracts = loadContracts(repoRoot);
  if (!contracts) {
    console.error('Unable to load Copilot page contracts');
    process.exitCode = 3;
    return;
  }
  let routes;
  try {
    routes = collectAllRoutes();
  } catch (error) {
    console.error(`Unable to load application routes: ${error.message}`);
    process.exitCode = 3;
    return;
  }
  const permissionKeys = loadPermissionKeys(repoRoot);
  if (!permissionKeys) {
    console.error('Unable to load permission catalog');
    process.exitCode = 3;
    return;
  }
  const exemptionsSource = [
    "import { COPILOT_PAGE_EXEMPTIONS } from '../src/app/capabilities/registry';",
    'console.log(JSON.stringify(COPILOT_PAGE_EXEMPTIONS));',
  ].join('\n');
  const exemptionTmp = join(repoRoot, '.tmp-copilot-loaders', '__copilot_page_exemptions.mts');
  mkdirSync(dirname(exemptionTmp), { recursive: true });
  writeFileSync(exemptionTmp, exemptionsSource, 'utf8');
  let exemptions = null;
  try {
    const result = spawnSync('npx', ['vite-node', '.tmp-copilot-loaders/__copilot_page_exemptions.mts'], {
      cwd: repoRoot, encoding: 'utf8', shell: true, timeout: 120_000,
    });
    const line = String(result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
    exemptions = line ? JSON.parse(line) : null;
  } finally {
    rmSync(exemptionTmp, { force: true });
  }
  if (!Array.isArray(exemptions)) {
    console.error('Unable to load Copilot page exemptions');
    process.exitCode = 3;
    return;
  }
  // OpenClaw removal reduced the current inventory from the historical 113 to
  // 112 non-redirect routes. Keep this baseline explicit so an accidental route
  // loss cannot silently make the accounting gate weaker.
  // Sổ hành động: nguồn duy nhất cho phép một trang `financial` mang mode
  // `draft`. Không đọc được là hỏng gate, không phải "không có action nào" —
  // im lặng trả tập rỗng sẽ biến luật "chỉ hành động có trong sổ" thành luật
  // "không hành động nào", tức là gate vẫn xanh trong khi nó đã mù.
  const actionIds = loadActionCatalogIds(repoRoot);
  if (!actionIds) {
    console.error(`Unable to load Copilot action catalog (${FILE_ACTION_CATALOG})`);
    process.exitCode = 3;
    return;
  }
  const problems = validateContracts(contracts, routes, exemptions, permissionKeys, 112, actionIds);
  if (problems.length) {
    console.error(`Copilot page contracts: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  const renderableRoutes = routes.filter((route) => !route?.redirect && route?.path !== '(index)');
  const contractedRoutes = renderableRoutes.filter((route) =>
    (contracts ?? []).some((entry) => routeMatches(entry.route, route.path)),
  );
  const exemptedRoutes = renderableRoutes.filter((route) =>
    !(contracts ?? []).some((entry) => routeMatches(entry.route, route.path)) &&
    (exemptions ?? []).some((entry) => routeMatches(entry.route, route.path)),
  );
  const canonicalPages = new Set(
    (contracts ?? []).map((entry) => normalizeRoute(entry.canonicalRoute ?? entry.route)),
  );
  console.log(
    `Copilot page contracts: ${contracts.length} explicit page(s), ${canonicalPages.size} canonical page(s), ` +
      `${renderableRoutes.length} non-redirect route(s) accounted ` +
      `(${contractedRoutes.length} contracted, ${exemptedRoutes.length} exempted).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
