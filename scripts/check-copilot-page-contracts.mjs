#!/usr/bin/env node
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
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
  if (p.endsWith('/*')) {
    const base = p.slice(0, -2) || '/';
    return actual === base || actual.startsWith(`${base}/`);
  }
  return p === actual;
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

export function validateContracts(contracts, routes = [], exemptions = [], permissionKeys = null, expectedRouteCount = null) {
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
    if (!page?.permission?.module || !page?.permission?.action) problems.push(`${page.key}: missing permission`);
    if (permissionKeys && !permissionKeys.has(`${page.permission.module}.${page.permission.action}`)) {
      problems.push(`${page.key}: permission ${page.permission.module}.${page.permission.action} is not registered`);
    }
    if (!Array.isArray(page?.safeControlIds)) problems.push(`${page.key}: safeControlIds must be an array`);
    if (page?.mode === 'draft' && !page?.e2eSpec) problems.push(`${page.key}: draft requires e2eSpec`);
    if (['financial', 'security'].includes(page?.dataClass) && !['read', 'navigate'].includes(page?.mode)) {
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
  const problems = validateContracts(contracts, routes, exemptions, permissionKeys, 112);
  if (problems.length) {
    console.error(`Copilot page contracts: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  const nonRedirectCount = routes.filter((route) => !route?.redirect && route?.path !== '(index)').length;
  console.log(`Copilot page contracts: ${contracts.length} explicit page(s), ${nonRedirectCount} non-redirect route(s) accounted.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
