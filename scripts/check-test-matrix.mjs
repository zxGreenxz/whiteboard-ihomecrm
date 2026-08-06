#!/usr/bin/env node
// Gate: không file test nào được MỒ CÔI.
//
// Một file test không nằm trong lệnh nào sẽ im lặng không bao giờ chạy. Nhìn vào
// repo thì thấy "đã có test", nhìn vào CI thì thấy xanh, mà thực tế không ai
// kiểm gì — tệ hơn không viết test, vì nó tạo ra cảm giác đã được che.
//
// Repo đã có verify-network-center-test-completeness.mjs cho một lý do cùng họ:
// test bị SKIP cũng báo pass. Script này mở rộng ý đó ra toàn repo ở mức "file
// có thuộc suite nào không".
//
//   node scripts/check-test-matrix.mjs
//   node scripts/check-test-matrix.mjs --list   # in bảng phân bổ theo suite
//
// Không cần credential, không đọc database.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX_PATH = join(repoRoot, 'tooling', 'test-matrix.json');

const TEST_FILE = /\.(test|spec)\.(ts|tsx|mjs|js|cjs)$/;

/**
 * Chuyển glob sang RegExp. Chỉ hỗ trợ `**` và `*` — đủ cho các pattern trong
 * matrix, và cố ý KHÔNG kéo thêm dependency vào một gate phải chạy được ở mọi
 * runner.
 *
 * Thứ tự thay thế quan trọng: xử lý `**` trước `*`, nếu không `**` sẽ bị luật
 * của `*` (không vượt dấu /) ăn mất và mọi pattern đệ quy đều hỏng.
 */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` khớp cả zero thư mục, nên `a/**/b.ts` khớp luôn `a/b.ts`.
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    out += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${out}$`);
}

export function trackedTestFiles(ignorePatterns) {
  const ignores = ignorePatterns.map(globToRegExp);
  // `--others --exclude-standard`: file test MỚI chưa `git add` vẫn phải bị soi.
  // Thiếu hai cờ này, một file test mới tạo là mồ côi mà gate vẫn xanh — lỗi đã
  // đo được 07/08/2026 ở cả ba gate dùng `git ls-files` trong repo.
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => TEST_FILE.test(p))
    .filter((p) => !ignores.some((re) => re.test(p)));
}

export function assignSuites(files, suites) {
  const matchers = suites.map((s) => ({
    id: s.id,
    runner: s.runner,
    res: (s.includes ?? []).map(globToRegExp),
    // `excludes` phản chiếu các cờ --exclude thật trong CI. Không có trường này
    // thì matrix buộc phải nói dối về suite nào chạy file nào — đúng chỗ đã sai:
    // ci-gates loại các file network-center khỏi bước Vitest, nhưng matrix vẫn
    // khai app-unit ôm chúng.
    exRes: (s.excludes ?? []).map(globToRegExp),
  }));
  const bySuite = new Map(suites.map((s) => [s.id, []]));
  const orphans = [];

  for (const file of files) {
    const owners = matchers
      .filter((m) => m.res.some((re) => re.test(file)) && !m.exRes.some((re) => re.test(file)))
      .map((m) => m.id);
    if (owners.length === 0) orphans.push(file);
    for (const id of owners) bySuite.get(id).push(file);
  }
  return { bySuite, orphans };
}

/**
 * Tìm các file bị HAI RUNNER KHÁC NHAU cùng nhận.
 *
 * Đây mới là loại trùng nguy hiểm, và trước đây gate gộp chung nó vào một dòng
 * ⚠ "chạy trùng thì tốn thời gian chứ không mất an toàn". Câu đó chỉ đúng khi
 * hai suite dùng cùng runner. Khác runner thì ít nhất một bên KHÔNG chạy nổi
 * file đó: 22 file `node:test` từng bị bước Vitest quét phải và fail hàng loạt
 * với "No test suite found", trong khi matrix vẫn khai chúng thuộc app-unit.
 * Vì vậy trường hợp này phải ĐỎ, không phải cảnh báo.
 */
export function crossRunnerConflicts(files, suites, bySuite) {
  const runnerOf = new Map(suites.map((s) => [s.id, s.runner]));
  const conflicts = [];
  for (const file of files) {
    const owners = [...bySuite].filter(([, list]) => list.includes(file)).map(([id]) => id);
    const runners = [...new Set(owners.map((id) => runnerOf.get(id)))];
    if (runners.length > 1) conflicts.push({ file, owners, runners });
  }
  return conflicts;
}

function main(argv) {
  const matrix = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
  const files = trackedTestFiles(matrix.ignore ?? []);
  const { bySuite, orphans } = assignSuites(files, matrix.suites);

  if (argv.includes('--list')) {
    for (const [id, list] of bySuite) {
      const suite = matrix.suites.find((s) => s.id === id);
      console.log(`${String(list.length).padStart(4)}  ${id}  [${suite.runner}]`);
    }
  }

  const empty = [...bySuite].filter(([, list]) => list.length === 0).map(([id]) => id);
  const conflicts = crossRunnerConflicts(files, matrix.suites, bySuite);

  if (conflicts.length > 0) {
    console.error(`❌ ${conflicts.length} file bị HAI RUNNER khác nhau cùng nhận:\n`);
    for (const c of conflicts.slice(0, 10)) {
      console.error(`  - ${c.file}\n      ${c.owners.join(' + ')} → runner ${c.runners.join(' vs ')}`);
    }
    if (conflicts.length > 10) console.error(`  … và ${conflicts.length - 10} file nữa`);
    console.error('\n  Khác runner thì ít nhất một bên KHÔNG chạy nổi file đó (vd Vitest gặp');
    console.error('  file `node:test` sẽ fail "No test suite found"). Sửa bằng `excludes`');
    console.error('  ở suite không thực sự chạy nó, khớp đúng cờ --exclude trong CI.');
    process.exitCode = 1;
    return;
  }

  if (orphans.length > 0 || empty.length > 0) {
    if (orphans.length > 0) {
      console.error(`❌ ${orphans.length} file test MỒ CÔI — không suite nào chạy chúng:\n`);
      for (const f of orphans.slice(0, 20)) console.error(`  - ${f}`);
      if (orphans.length > 20) console.error(`  … và ${orphans.length - 20} file nữa`);
      console.error('\n  → thêm vào `includes` của suite phù hợp trong tooling/test-matrix.json,');
      console.error('    hoặc vào `ignore` nếu cố ý không chạy (kèm lý do trong $comment).');
    }
    if (empty.length > 0) {
      console.error(`\n❌ ${empty.length} suite khai trong matrix nhưng không khớp file nào: ${empty.join(', ')}`);
      console.error('  → suite chết: hoặc pattern sai, hoặc test đã bị xoá mà matrix chưa cập nhật.');
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `✅ ${files.length} file test, ${matrix.suites.length} suite, không file nào mồ côi.`,
  );
  const multi = files.filter((f) => [...bySuite].filter(([, l]) => l.includes(f)).length > 1);
  if (multi.length > 0) {
    // Tới đây thì mọi trùng lặp đều CÙNG runner (khác runner đã bị chặn đỏ ở
    // trên). Cùng runner chạy hai lần thì tốn thời gian chứ không mất an toàn.
    console.warn(`⚠ ${multi.length} file thuộc nhiều suite cùng runner (chạy trùng, vô hại): ${multi.slice(0, 3).join(', ')}${multi.length > 3 ? ' …' : ''}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
