#!/usr/bin/env node
// Gate: tooling/runtime-matrix.json phải khớp thực tế, theo CẢ HAI chiều.
//
// Vì sao cần: repo có sáu ràng buộc Node khác nhau trên tám manifest, và root
// `engines: ">=20"` không phải sàn thật của mọi thứ — script test:openclaw:services
// tự chặn nếu không phải Node 24.15+. Agent đọc root rồi chọn Node 20 sẽ thấy
// test OpenClaw fail vì lý do chẳng liên quan gì tới code đang sửa.
//
// Một bảng tra chỉ có ích khi nó ĐÚNG. Nếu chỉ có file JSON mà không ai kiểm,
// nó sẽ lệch trong im lặng và trở thành nguồn sai còn nguy hiểm hơn không có gì
// — y hệt số "371 migration" từng nằm trong ba tài liệu suốt nhiều tuần.
//
//   node scripts/check-runtime-matrix.mjs
//
// Không cần credential, không đọc database.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX_PATH = join(repoRoot, 'tooling', 'runtime-matrix.json');

// Vendored upstream và build output không phải bề mặt runtime của repo này.
const IGNORED = [
  /node_modules/,
  /session-crypto[\\/]dist[\\/]/,
  /zalouser-bridge[\\/]upstream[\\/]/,
];

export function trackedPackageJsons() {
  const out = execFileSync('git', ['ls-files', '*package.json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out
    .trim()
    .split('\n')
    .filter((p) => p && !IGNORED.some((re) => re.test(p)));
}

export function readEngines(relPath) {
  try {
    const j = JSON.parse(readFileSync(join(repoRoot, relPath), 'utf8'));
    return j.engines?.node ?? null;
  } catch {
    return undefined; // không đọc được — khác với "không khai"
  }
}

export function readWorkflowRuntimes(relPath) {
  const doc = yaml.load(readFileSync(join(repoRoot, relPath), 'utf8'));
  const node = new Set();
  const deno = new Set();
  for (const job of Object.values(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      const uses = String(step?.uses ?? '');
      if (uses.includes('setup-node') && step?.with?.['node-version'] !== undefined) {
        node.add(String(step.with['node-version']));
      }
      if (uses.includes('setup-deno') && step?.with?.['deno-version'] !== undefined) {
        deno.add(String(step.with['deno-version']));
      }
    }
  }
  return { node: [...node], deno: [...deno] };
}

function main() {
  const matrix = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
  const problems = [];

  // ── Chiều 1: mọi package.json trên đĩa phải có mặt trong matrix ──
  const declared = new Map(matrix.packages.map((p) => [p.path.replace(/\\/g, '/'), p]));
  const onDisk = trackedPackageJsons().map((p) => p.replace(/\\/g, '/'));

  for (const path of onDisk) {
    if (!declared.has(path)) {
      problems.push(
        `${path} chưa có trong runtime-matrix.\n` +
        '      → thêm entry (node: "..." hoặc null nếu cố ý không khai).',
      );
    }
  }

  // ── Chiều 2: mọi entry trong matrix phải khớp engines thật ──
  for (const [path, entry] of declared) {
    if (!onDisk.includes(path)) {
      problems.push(`${path} có trong matrix nhưng không tồn tại (hoặc không được git track).`);
      continue;
    }
    const actual = readEngines(path);
    if (actual === undefined) {
      problems.push(`${path} không đọc/parse được.`);
      continue;
    }
    if ((actual ?? null) !== (entry.node ?? null)) {
      problems.push(
        `${path}: matrix ghi ${JSON.stringify(entry.node)} nhưng engines thật là ${JSON.stringify(actual)}.`,
      );
    }
  }

  // ── Chiều 3: workflow ──
  for (const wf of matrix.workflows) {
    let actual;
    try {
      actual = readWorkflowRuntimes(wf.path);
    } catch (error) {
      problems.push(`${wf.path}: không parse được (${error.message}).`);
      continue;
    }
    const expectNode = wf.node === null ? [] : [wf.node];
    const expectDeno = wf.deno === null ? [] : [wf.deno];

    if (JSON.stringify(actual.node.sort()) !== JSON.stringify(expectNode.sort())) {
      problems.push(
        `${wf.path}: matrix ghi node ${JSON.stringify(expectNode)} nhưng workflow dùng ${JSON.stringify(actual.node)}.`,
      );
    }
    if (JSON.stringify(actual.deno.sort()) !== JSON.stringify(expectDeno.sort())) {
      problems.push(
        `${wf.path}: matrix ghi deno ${JSON.stringify(expectDeno)} nhưng workflow dùng ${JSON.stringify(actual.deno)}.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error('❌ runtime-matrix lệch thực tế:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nMatrix sai còn nguy hiểm hơn không có matrix — sửa một trong hai phía cho khớp.');
    process.exitCode = 1;
    return;
  }

  const unpinned = matrix.packages.filter((p) => p.node === null);
  console.log(
    `✅ runtime-matrix khớp thực tế: ${matrix.packages.length} package, ${matrix.workflows.length} workflow.`,
  );
  if (unpinned.length > 0) {
    // Cảnh báo, không fail: đây là nợ đã được ghi nhận có chủ đích, chưa phải lỗi.
    console.warn(`⚠ ${unpinned.length} package chưa khai engines: ${unpinned.map((p) => p.path).join(', ')}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
