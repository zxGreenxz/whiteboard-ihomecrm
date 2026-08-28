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
import yaml from 'js-yaml';

import { laCI, lietKeUntracked, phanCap } from './lib/git-scope.mjs';

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
  // (Mồ côi trên file untracked nay chỉ CẢNH BÁO ở local — xem phanLoaiMoCoi —
  // nhưng vẫn phải quét thấy để cảnh báo được và để CỨNG trên CI.)
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => TEST_FILE.test(p))
    .filter((p) => !ignores.some((re) => re.test(p)));
}

/**
 * Tách mồ côi thành {cung, mem} theo luật phiên-song-song (28/08/2026): file
 * test untracked thường là WIP của PHIÊN KHÁC trên working tree chung, đỏ cứng
 * vì nó là đỏ oan. Untracked ⇒ mềm ở local; đã stage/tracked hoặc chạy trên CI
 * ⇒ cứng như cũ. Lưới không thủng: Contract §3 bắt stage trước commit, và ngay
 * lúc stage thì file rời nhóm untracked.
 */
export function phanLoaiMoCoi(orphans, tapUntracked, ci) {
  const { cung, mem } = phanCap(orphans, tapUntracked, ci, (f) => f);
  return { cung, mem };
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

/**
 * Rút đúng tập cờ `--exclude` của MỘT bước trong workflow.
 *
 * Đọc YAML thay vì regex trên văn bản thô: bước này là chuỗi gấp (`run: >`), nên
 * xuống dòng đã bị YAML nối lại thành một dòng — regex trên file thô sẽ phải tự
 * đoán chỗ nối và đoán sai lúc ai đó đổi kiểu gấp.
 *
 * Trả `null` khi KHÔNG TÌM THẤY bước — khác hẳn "bước có nhưng không exclude gì",
 * và người gọi phải phân biệt hai thứ đó (exit 3 chứ không phải so tập rỗng).
 */
export function coExcludeCuaBuoc(doc, tenBuoc) {
  for (const job of Object.values(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (step?.name !== tenBuoc) continue;
      const lenh = String(step.run ?? '');
      return [...lenh.matchAll(/--exclude\s+'([^']+)'|--exclude\s+"([^"]+)"|--exclude\s+(\S+)/g)]
        .map((m) => m[1] ?? m[2] ?? m[3]);
    }
  }
  return null;
}

/** Tên job có thật trong một workflow. Trả `null` nếu không đọc/parse được file. */
export function jobCuaWorkflow(duong) {
  try {
    const doc = yaml.load(readFileSync(join(repoRoot, duong), 'utf8'));
    return new Set(Object.keys(doc?.jobs ?? {}));
  } catch {
    return null;
  }
}

function main(argv) {
  const matrix = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
  const files = trackedTestFiles(matrix.ignore ?? []);
  const homNay = new Date().toISOString().slice(0, 10);
  // File test untracked = WIP (thường của phiên khác trên working tree chung).
  // Mọi vi phạm chỉ dính file untracked đều hạ xuống ⚠ ở local — xem phanLoaiMoCoi.
  const tapUntracked = new Set(lietKeUntracked().filter((p) => TEST_FILE.test(p)));

  // ── Chống-xanh-rỗng: đo hỏng phải kêu là đo hỏng, không được đọc thành "sạch" ──
  const chan = [];
  if ((matrix.suites?.length ?? 0) < 9) {
    chan.push(`Matrix chỉ còn ${matrix.suites?.length ?? 0} suite (từng có 9). Mỗi suite mất đi là một vùng test không ai khai chạy ở đâu.`);
  }
  if (files.length < 200) {
    chan.push(`Chỉ tìm được ${files.length} file test — repo có hơn 400. Phép quét hỏng, đừng đọc kết quả bên dưới.`);
  }
  if (chan.length > 0) {
    console.error('❌ KHÔNG KIỂM ĐƯỢC (không phải "đã kiểm và sạch"):\n');
    for (const c of chan) console.error(`  - ${c}`);
    process.exit(3);
  }

  // ── Phép kiểm 3: ciJobs phải trỏ tới job CÓ THẬT ──
  //
  // `ciJob` cũ là văn xuôi ("network-center-validation / validate", "(local — …)")
  // nên không ai đối chiếu được, và nó đã nói dối thật: suite openclaw-sql ghi
  // "không chạy trên ci-gates" trong khi job openclaw-sql-gates chạy đúng lệnh đó.
  const loiCiJob = [];
  const cacheJob = new Map();
  for (const s of matrix.suites) {
    if (!Array.isArray(s.ciJobs)) {
      loiCiJob.push(`${s.id}: thiếu trường \`ciJobs\` (mảng {workflow, job}; để [] nếu chỉ chạy local).`);
      continue;
    }
    for (const { workflow, job } of s.ciJobs) {
      if (!cacheJob.has(workflow)) cacheJob.set(workflow, jobCuaWorkflow(workflow));
      const jobs = cacheJob.get(workflow);
      if (jobs === null) {
        loiCiJob.push(`${s.id}: không đọc/parse được ${workflow}.`);
      } else if (!jobs.has(job)) {
        loiCiJob.push(`${s.id}: khai job \`${job}\` trong ${workflow} nhưng workflow đó không có job tên vậy (có: ${[...jobs].join(', ')}).`);
      }
    }
  }

  // ── Phép kiểm 4: suite không chạy CI phải có LÝ DO và HẠN ──
  //
  // "Chạy local thôi" không hạn là cách một suite bảo mật rời khỏi CI vĩnh viễn
  // mà không ai phải quyết định gì.
  const loiBlocked = [];
  for (const s of matrix.suites) {
    const chayCi = Array.isArray(s.ciJobs) && s.ciJobs.length > 0;
    if (chayCi) {
      if (s.blockedFromCi) loiBlocked.push(`${s.id}: vừa khai ciJobs vừa khai blockedFromCi — mâu thuẫn, chọn một.`);
      continue;
    }
    const b = s.blockedFromCi;
    if (!b) {
      loiBlocked.push(`${s.id}: không chạy trên CI mà không khai \`blockedFromCi\` {reason, expiry, exitCondition}.`);
      continue;
    }
    if (!b.reason || String(b.reason).length < 30) loiBlocked.push(`${s.id}: \`blockedFromCi.reason\` quá ngắn để là lý do thật.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.expiry ?? ''))) loiBlocked.push(`${s.id}: \`blockedFromCi.expiry\` phải là ngày YYYY-MM-DD.`);
    else if (b.expiry < homNay) loiBlocked.push(`${s.id}: miễn trừ CI HẾT HẠN ${b.expiry} (hôm nay ${homNay}) — đưa lên CI hoặc gia hạn có chủ đích.`);
    if (!b.exitCondition) loiBlocked.push(`${s.id}: thiếu \`exitCondition\` — không có điều kiện thoát thì miễn trừ là vĩnh viễn.`);
  }

  // ── Phép kiểm 5: `excludes` của app-unit phải KHỚP TỪNG CỜ --exclude thật ──
  //
  // Trước đây đây chỉ là một câu hứa trong chú thích của matrix. Đo 11/08/2026:
  // matrix khai 8 cờ, CI có 12 — bốn cờ services/infra/.tmp-openclaw-host/.e2e-fleet
  // không có trong matrix, tức matrix mô tả sai phạm vi của suite lớn nhất repo.
  const loiExclude = [];
  const appUnit = matrix.suites.find((s) => s.id === 'app-unit');
  if (!appUnit?.ciVitestStep) {
    loiExclude.push('app-unit thiếu `ciVitestStep` — không biết đối chiếu với bước nào trong CI.');
  } else {
    const wf = appUnit.ciJobs?.[0]?.workflow;
    let doc = null;
    try {
      doc = yaml.load(readFileSync(join(repoRoot, wf), 'utf8'));
    } catch {
      /* doc null → xử ở dưới */
    }
    const thuc = doc ? coExcludeCuaBuoc(doc, appUnit.ciVitestStep) : null;
    if (thuc === null) {
      console.error(`❌ KHÔNG KIỂM ĐƯỢC: không tìm thấy bước "${appUnit.ciVitestStep}" trong ${wf}.`);
      console.error('   Bước bị đổi tên thì phép đối chiếu --exclude im lặng biến mất — đó là mất kiểm soát, không phải pass.');
      process.exit(3);
    }
    const khai = new Set(appUnit.excludes ?? []);
    const that = new Set(thuc);
    const thieu = [...that].filter((x) => !khai.has(x));
    const thua = [...khai].filter((x) => !that.has(x));
    for (const x of thieu) loiExclude.push(`CI loại '${x}' nhưng matrix không khai — matrix nói suite này chạy file mà thật ra nó bỏ qua.`);
    for (const x of thua) loiExclude.push(`matrix khai loại '${x}' nhưng CI không có cờ đó — file đó VẪN chạy trên CI.`);
  }

  const loiKhai = [...loiCiJob, ...loiBlocked, ...loiExclude];
  if (loiKhai.length > 0) {
    console.error(`❌ ${loiKhai.length} lỗi khai báo trong tooling/test-matrix.json:\n`);
    for (const l of loiKhai) console.error(`  - ${l}`);
    console.error('\nMột manifest không ai đối chiếu sẽ lệch trong im lặng rồi thành nguồn sai.');
    process.exitCode = 1;
    return;
  }

  const { bySuite, orphans } = assignSuites(files, matrix.suites);

  // ── Runner khai phải CHẠY NỔI file đó ─────────────────────────────────────
  //
  // Matrix khai "file này do suite X chạy". Cho tới 11/08/2026 không gì kiểm rằng
  // runner của X đọc nổi file — và tám file `scripts/__tests__/*.test.mjs` dùng
  // API `node:test` bị xếp vào suite VITEST. Hậu quả kép:
  //   - bước Vitest của quality-gates ĐỎ ("No test suite found" / SyntaxError)
  //   - và KHÔNG lệnh nào chạy chúng: 106 assertion tồn tại mà chưa từng thi hành
  // Tệ hơn không có test, vì nhìn vào thư mục thì thấy "đã có test".
  //
  // Phép kiểm rẻ và dứt khoát: file import `node:test` thì suite nhận nó không
  // được là vitest, và ngược lại.
  const loiRunner = [];
  for (const [id, list] of bySuite) {
    const suite = matrix.suites.find((s) => s.id === id);
    const laVitest = String(suite.runner).startsWith('vitest');
    const laNode = suite.runner === 'node --test';
    if (!laVitest && !laNode) continue;
    for (const f of list) {
      let src = '';
      try {
        src = readFileSync(join(repoRoot, f), 'utf8');
      } catch {
        continue;
      }
      const dungNodeTest = /from\s+['"]node:test['"]/.test(src);
      const dungVitest = /from\s+['"]vitest['"]/.test(src);
      if (laVitest && dungNodeTest && !dungVitest) {
        loiRunner.push({ file: f, msg: `${f}: dùng \`node:test\` nhưng suite \`${id}\` chạy bằng Vitest — Vitest không đọc nổi nó.` });
      }
      if (laNode && dungVitest) {
        loiRunner.push({ file: f, msg: `${f}: dùng \`vitest\` nhưng suite \`${id}\` chạy bằng \`node --test\`.` });
      }
    }
  }

  const runnerCap = phanCap(loiRunner, tapUntracked, laCI());
  if (runnerCap.mem.length > 0) {
    console.warn(`⚠ ${runnerCap.mem.length} file CHƯA ADD giao nhầm runner (WIP — có thể của phiên khác):`);
    for (const l of runnerCap.mem) console.warn(`  - ${l.msg}`);
    console.warn('  Nếu là của bạn: sẽ CHẶN CỨNG ngay khi `git add` — sửa matrix trước khi stage.');
  }
  if (runnerCap.cung.length > 0) {
    console.error(`❌ ${runnerCap.cung.length} file được giao cho runner KHÔNG chạy nổi nó:\n`);
    for (const l of runnerCap.cung) console.error(`  - ${l.msg}`);
    console.error('\n  Matrix khai một đằng, runner đọc một nẻo: bước CI đỏ vì lý do không');
    console.error('  liên quan tới chất lượng code, VÀ file test đó không được ai chạy.');
    process.exitCode = 1;
    return;
  }

  if (argv.includes('--list')) {
    for (const [id, list] of bySuite) {
      const suite = matrix.suites.find((s) => s.id === id);
      console.log(`${String(list.length).padStart(4)}  ${id}  [${suite.runner}]`);
    }
  }

  const empty = [...bySuite].filter(([, list]) => list.length === 0).map(([id]) => id);
  const conflicts = crossRunnerConflicts(files, matrix.suites, bySuite);

  const conflictCap = phanCap(conflicts, tapUntracked, laCI());
  if (conflictCap.mem.length > 0) {
    console.warn(`⚠ ${conflictCap.mem.length} file CHƯA ADD bị hai runner cùng nhận (WIP — có thể của phiên khác):`);
    for (const c of conflictCap.mem.slice(0, 5)) console.warn(`  - ${c.file} (${c.runners.join(' vs ')})`);
  }
  if (conflictCap.cung.length > 0) {
    console.error(`❌ ${conflictCap.cung.length} file bị HAI RUNNER khác nhau cùng nhận:\n`);
    for (const c of conflictCap.cung.slice(0, 10)) {
      console.error(`  - ${c.file}\n      ${c.owners.join(' + ')} → runner ${c.runners.join(' vs ')}`);
    }
    if (conflictCap.cung.length > 10) console.error(`  … và ${conflictCap.cung.length - 10} file nữa`);
    console.error('\n  Khác runner thì ít nhất một bên KHÔNG chạy nổi file đó (vd Vitest gặp');
    console.error('  file `node:test` sẽ fail "No test suite found"). Sửa bằng `excludes`');
    console.error('  ở suite không thực sự chạy nó, khớp đúng cờ --exclude trong CI.');
    process.exitCode = 1;
    return;
  }

  // Mồ côi trên file UNTRACKED chỉ mềm ở local: đỏ cứng vì WIP phiên khác là
  // đỏ oan (đo 28/08/2026: 3 spec copilot dở làm gate của mọi phiên đỏ).
  const { cung: moCoiCung, mem: moCoiMem } = phanLoaiMoCoi(orphans, tapUntracked, laCI());

  if (moCoiMem.length > 0) {
    console.warn(`⚠ ${moCoiMem.length} file test mồ côi nhưng CHƯA ADD (WIP — có thể của phiên khác):`);
    for (const f of moCoiMem.slice(0, 10)) console.warn(`  - ${f}`);
    if (moCoiMem.length > 10) console.warn(`  … và ${moCoiMem.length - 10} file nữa`);
    console.warn('  Nếu là của bạn: sẽ CHẶN CỨNG ngay khi `git add` — khai suite trước khi stage.');
  }

  if (moCoiCung.length > 0 || empty.length > 0) {
    if (moCoiCung.length > 0) {
      console.error(`❌ ${moCoiCung.length} file test MỒ CÔI — không suite nào chạy chúng:\n`);
      for (const f of moCoiCung.slice(0, 20)) console.error(`  - ${f}`);
      if (moCoiCung.length > 20) console.error(`  … và ${moCoiCung.length - 20} file nữa`);
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
    `✅ ${files.length} file test, ${matrix.suites.length} suite, không file nào mồ côi${
      moCoiMem.length > 0 ? ` (trừ ${moCoiMem.length} file chưa add — xem ⚠ trên)` : ''
    }.`,
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
