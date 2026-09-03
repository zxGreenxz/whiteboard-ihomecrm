#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Biến thể MOBILE của một trang là một file riêng (`*Mobile*.tsx`), nạp lười
 * theo viewport ≤767px. Trang desktop và trang mobile KHÔNG bao giờ mount cùng
 * lúc — `RoomsPage`/`InvoicesPage`/`CustomersPage` chọn đúng một nhánh — nên
 * cùng một marker nằm ở cả hai file là hợp lệ, và bộ giải DOM vẫn chỉ thấy một
 * phần tử. Hai marker trong CÙNG một lớp (cùng desktop, hoặc cùng mobile) thì
 * vẫn là đánh dấu sai: lúc đó `giaiSafeControl` ném `nhieu_hon_mot` và control
 * chết hẳn.
 */
export function laFileMobile(file) {
  const ten = String(file).split(/[\\/]/u).pop() ?? '';
  return /Mobile/u.test(ten);
}

export function validateSafeControlMarkers(contracts, sourceByFile) {
  // marker -> khoá trang, để quy marker về trang mà KHÔNG đoán bằng tiền tố
  // (`reports.finance` là tiền tố của `reports.finance.deposits`).
  const expected = new Map();
  const trangCoControl = [];
  for (const page of contracts ?? []) {
    for (const controlId of page.safeControlIds ?? []) expected.set(`${page.key}.${controlId}`, page.key);
    if ((page.safeControlIds ?? []).length > 0) trangCoControl.push(page.key);
  }

  // Hai bảng tách theo lớp biến thể: một marker được phép xuất hiện tối đa MỘT
  // lần ở mỗi lớp (desktop / mobile), không phải một lần trên toàn repo.
  const seen = { desktop: new Map(), mobile: new Map() };
  const problems = [];
  for (const [file, source] of sourceByFile) {
    const lop = laFileMobile(file) ? 'mobile' : 'desktop';
    const re = /data-ai-safe\s*=\s*["']([^"']+)["']/g;
    for (const match of source.matchAll(re)) {
      const marker = match[1];
      if (!expected.has(marker)) problems.push(`${file}: unknown marker ${marker}`);
      const previous = seen[lop].get(marker);
      if (previous) problems.push(`duplicate marker ${marker}: ${previous} and ${file}`);
      seen[lop].set(marker, file);
    }
  }
  for (const marker of expected.keys()) {
    if (!seen.desktop.has(marker) && !seen.mobile.has(marker)) problems.push(`missing marker ${marker}`);
  }

  // Trên điện thoại, trang desktop KHÔNG mount. Một trang có control an toàn mà
  // không có marker nào trong biến thể mobile nghĩa là page-agent mù hẳn ở đó
  // (`giaiSafeControl` ném `khong_thay`) — đúng lỗi mà task G1-E vá. Gate theo
  // TRANG chứ không theo từng control: có control desktop không có bản mobile
  // tương đương (bộ lọc tháng của hoá đơn), ép một-một sẽ buộc phải bịa control.
  const coMarkerMobile = new Set();
  for (const marker of seen.mobile.keys()) {
    const key = expected.get(marker);
    if (key) coMarkerMobile.add(key);
  }
  for (const key of trangCoControl) {
    if (!coMarkerMobile.has(key)) problems.push(`missing mobile marker for page ${key}`);
  }
  return problems;
}

function loadContracts(repoRoot) {
  const source = [
    "import { COPILOT_PAGE_CONTRACTS } from '../src/app/capabilities/registry';",
    'console.log(JSON.stringify(COPILOT_PAGE_CONTRACTS));',
  ].join('\n');
  // Keep the importer in this checkout; node_modules may be junctioned to a
  // different worktree and would otherwise resolve the wrong registry.
  const tmp = join(repoRoot, '.tmp-copilot-loaders', '__copilot_safe_contracts.mts');
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, source, 'utf8');
  try {
    const result = spawnSync('npx', ['vite-node', '.tmp-copilot-loaders/__copilot_safe_contracts.mts'], {
      cwd: repoRoot, encoding: 'utf8', shell: true, timeout: 120_000,
    });
    const line = String(result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
    return line ? JSON.parse(line) : null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const contracts = loadContracts(repoRoot);
  if (!contracts) {
    console.error('Unable to load Copilot page contracts');
    process.exitCode = 3;
    return;
  }
  const files = [];
  const visit = (relativeDir) => {
    const absoluteDir = join(repoRoot, relativeDir);
    for (const entry of readdirSync(absoluteDir)) {
      const relative = join(relativeDir, entry);
      const absolute = join(repoRoot, relative);
      if (statSync(absolute).isDirectory()) visit(relative);
      else if (/\.(?:tsx?|jsx?)$/u.test(entry)) files.push(relative);
    }
  };
  visit('src/pages');
  visit('src/components');
  const sourceByFile = new Map(files.map((file) => [file, readFileSync(join(repoRoot, file), 'utf8')]));
  const problems = validateSafeControlMarkers(contracts, sourceByFile);
  if (problems.length) {
    console.error(`Copilot safe-control markers: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Copilot safe-control markers: ${[...sourceByFile.values()].join('').match(/data-ai-safe\s*=/g)?.length ?? 0} marker(s) valid.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
