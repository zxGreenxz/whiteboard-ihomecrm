#!/usr/bin/env node
// Vitest cho test LIÊN QUAN tới file đã stage (theo đồ thị import của Vitest), chỉ
// trong bộ app-unit của test-matrix: test node:test, Playwright và DEFERRED không lọt.
//
// VÌ SAO CẦN: plan full (đổi tooling dùng chung) giao cả bộ Vitest cho CI, còn plan
// hẹp chỉ chạy test được map tay. Nhiều lần main đỏ vì Vitest mà máy không kiểm.
//
//   node scripts/run-related-vitest.mjs --plan .cache/gate-receipts/plan.json
//
// Bỏ các test bộ app-unit hẹp đã chạy trong cùng lượt gate. Thoát theo Vitest.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { khopGlob } from './check-risk-classifier.mjs';
import { isDeferredTest } from './lib/deferred-modules.mjs';

const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
// Đổi các file này làm Vitest chạy lại TOÀN BỘ (forceRerunTriggers) — việc của CI.
const KICH_HOAT_TOAN_BO = /(?:^|\/)(?:package\.json|vite\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s)$/;

export function nguonLienQuan(paths, coTrongIndex = () => true) {
  return (paths ?? []).filter((p) => /\.[cm]?[jt]sx?$/.test(p) && !KICH_HOAT_TOAN_BO.test(p) && coTrongIndex(p));
}

export function testThuocAppUnit(files, matrix) {
  const suite = matrix.suites.find((s) => s.id === 'app-unit');
  if (!suite) throw new Error('test-matrix thiếu suite app-unit');
  return files.filter((f) => TEST.test(f) && !isDeferredTest(f) &&
    suite.includes.some((g) => khopGlob(f, g)) && !(suite.excludes ?? []).some((g) => khopGlob(f, g)));
}

/** Tập test Vitest được phép xét và tập file nguồn để dò liên quan. */
export function chonRelated(plan, { tracked, matrix }) {
  const narrow = plan.suiteSelections?.find((s) => s.id === 'app-unit' && s.mode === 'targeted');
  const daChay = new Set(narrow?.files ?? []);
  const indexed = new Set(tracked);
  return {
    related: nguonLienQuan(plan.changedPaths, (p) => indexed.has(p)),
    include: testThuocAppUnit(tracked, matrix).filter((f) => !daChay.has(f)),
  };
}

async function main(argv) {
  const planPath = argv.includes('--plan') ? argv[argv.indexOf('--plan') + 1] : null;
  if (!planPath) throw new Error('Cần --plan <json>');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const matrix = JSON.parse(readFileSync('tooling/test-matrix.json', 'utf8'));
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const { related, include } = chonRelated(plan, { tracked, matrix });
  if (!related.length || !include.length) { console.log('Vitest liên quan: không có file nguồn JS/TS cần dò'); return; }
  console.log(`Vitest liên quan: dò ${related.length} file nguồn trong ${include.length} test app-unit`);
  const { startVitest } = await import('vitest/node');
  let context;
  try {
    // Nửa số luồng: test DOM hết giờ 5 s khi máy đầy tải (đỏ giả, chạy riêng xanh).
    const maxWorkers = Math.max(1, Math.floor(availableParallelism() / 2));
    context = await startVitest('test', [], { include, related: related.map((p) => resolve(p)), run: true, watch: false, passWithNoTests: true, maxWorkers });
    if (!context) throw new Error('Vitest không trả về context');
  } finally { await context?.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = process.exitCode || 1; }
}
