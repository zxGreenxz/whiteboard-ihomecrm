#!/usr/bin/env node
// Gate: logic ngày tháng không được đổi kết quả theo múi giờ của máy chạy.
//
// Vì sao cần, cụ thể cho repo này:
//   CI chạy UTC (không workflow nào set TZ), người dùng và dữ liệu ở UTC+7. Đây là
//   CRM tiền thuê nhà — hoá đơn, lương, chốt lãi đều gắn với THÁNG. Lệch một ngày ở
//   ranh giới tháng là lệch hẳn kỳ, và loại lỗi đó không làm gì đỏ lên: nó chỉ sai
//   trong khoảng 00:00–07:00 giờ VN, tức là lúc không ai ngồi xem.
//   Đã có án lệ: màn lương từng mặc định về KỲ TRƯỚC trong vài giờ đầu ngày 1
//   (audit 2026-07-20) — vì thế mới có `vnYmOf()` dùng Intl với Asia/Ho_Chi_Minh
//   thay cho giờ máy.
//
// Cách kiểm: chạy cùng một tập test dưới nhiều múi giờ CÁCH XA NHAU và đòi kết quả
// GIỐNG HỆT. Hai đầu mút UTC+14 và UTC-11 cách nhau 25 giờ, nên mọi thời điểm trong
// ngày đều rơi vào "ngày khác nhau" ở hai đầu — nếu có chỗ nào đọc giờ máy để suy ra
// ngày thì nó sẽ lộ ra ở đây.
//
// CI đưa vào đúng các file ngày/tháng do planner chọn. Chạy độc lập thì lấy
// toàn bộ bộ test múi giờ đang hoạt động, gồm cả file mới theo quy ước tên.
//   npm run gate:timezone
//   npm run gate:timezone -- --quick   # UTC và giờ Việt Nam

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMEZONE_TEST_FILES, isTimezoneTest } from './lib/timezone-suite.mjs';
import { isDeferredTest } from './lib/deferred-modules.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// UTC = môi trường CI. Asia/Ho_Chi_Minh = môi trường thật của dữ liệu.
// Hai đầu mút là để bắt lỗi mà hai cái trên bỏ lọt: chênh nhau 25 giờ.
const ZONES = ['UTC', 'Asia/Ho_Chi_Minh', 'Pacific/Kiritimati', 'Pacific/Midway'];

/**
 * Tên test/file ĐỎ và dòng lỗi đầu tiên của chúng, lấy từ output vitest (đã bỏ màu).
 * Gate trước đây chỉ in "2 ĐỎ" nên CI đỏ ba lần liên tiếp (20/10/2026) mà không ai
 * biết test nào; log CI không giữ output vitest. Giữ tối đa `limit` dòng để log
 * không phình. Chỉ đọc, không đổi cách chạy vitest.
 */
export function extractVitestFailures(output, limit = 40) {
  // Vitest vẫn tô màu khi không có TTY: thiếu \u001b thì ESC còn sót, dòng FAIL không khớp `^\s*`.
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  const failed = [];
  const details = [];
  for (const raw of plain.split(/\r?\n/)) {
    const line = raw.trimEnd();
    // jsdom in dòng này ở stderr cho mọi test đi qua window.scrollTo; không phải lỗi test.
    if (/Not implemented:/.test(line)) continue;
    // Tên test đỏ đứng trước: console.error của các test xanh cũng bắt đầu bằng "Error" và in sớm hơn.
    if (/^\s*(FAIL|×|✗)\s/.test(line)) failed.push(line.trim());
    else if (/^\s*(Error|AssertionError|TypeError|RangeError)\b/.test(line) ||
        /timed out in \d+ms/.test(line) || /^\s*❯\s+\S+\.test\.[cm]?[jt]sx?:\d+/.test(line)) {
      details.push(line.trim());
    }
  }
  return [...failed, ...details].slice(0, limit);
}

export function parseVitestSummary(output) {
  // Vitest in màu ANSI; bỏ trước khi khớp, nếu không regex trượt hết.
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  const tests = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/.exec(plain);
  const files = /Test Files\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/.exec(plain);
  if (!tests || !files) return null;
  return {
    testsFailed: Number(tests[1] ?? 0),
    testsPassed: Number(tests[2]),
    filesFailed: Number(files[1] ?? 0),
    filesPassed: Number(files[2]),
  };
}

function standaloneFiles() {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
    '*.timezone.test.ts', '*.timezone.test.tsx'], { cwd: repoRoot, encoding: 'utf8' });
  return [...new Set([...TIMEZONE_TEST_FILES, ...paths.split('\0').filter(Boolean)])].filter((file) => !isDeferredTest(file)).sort();
}

function runUnder(tz, files) {
  const r = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts/run-selected-vitest.mjs'), '--files', ...files],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, TZ: tz } },
  );
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { tz, code: r.status, summary: parseVitestSummary(output), failures: extractVitestFailures(output) };
}

function main(argv) {
  const zones = argv.includes('--quick') ? ZONES.slice(0, 2) : ZONES;
  const fileFlag = argv.indexOf('--files');
  const files = fileFlag === -1 ? standaloneFiles() : argv.slice(fileFlag + 1);
  if (!files.length || files.some((file) => !isTimezoneTest(file) || isDeferredTest(file))) {
    throw new Error('Cần chọn ít nhất một file test múi giờ đang hoạt động.');
  }
  const results = [];

  for (const tz of zones) {
    process.stdout.write(`  chạy dưới TZ=${tz} … `);
    const r = runUnder(tz, files);
    if (!r.summary) {
      console.log('KHÔNG ĐỌC ĐƯỢC KẾT QUẢ');
      console.error(`\n❌ Không parse được output vitest dưới TZ=${tz}. Gate này vô nghĩa nếu không đọc được kết quả, nên coi là đỏ.`);
      for (const line of r.failures) console.error(`    ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${r.summary.testsPassed} xanh${r.summary.testsFailed ? `, ${r.summary.testsFailed} ĐỎ` : ''}`);
    results.push(r);
  }

  const failing = results.filter((r) => r.code !== 0 || r.summary.testsFailed > 0 || r.summary.filesPassed !== files.length || r.summary.testsPassed === 0);
  if (failing.length > 0) {
    console.error(`\n❌ Test ĐỎ dưới ${failing.length}/${results.length} múi giờ: ${failing.map((r) => r.tz).join(', ')}`);
    for (const r of failing) {
      console.error(`  TZ=${r.tz} (exit ${r.code}):`);
      if (r.failures.length === 0) console.error('     (vitest không in dòng FAIL nào — xem exit code)');
      for (const line of r.failures) console.error(`     ${line}`);
    }
    console.error('  → chạy lại tay để xem chi tiết:');
    console.error(`     TZ=${failing[0].tz} node scripts/run-selected-vitest.mjs --files ${files.join(' ')}`);
    process.exitCode = 1;
    return;
  }

  // Đây mới là phần chính: không chỉ "đều xanh" mà phải xanh Y HỆT NHAU.
  const counts = new Set(results.map((r) => `${r.summary.testsPassed}/${r.summary.filesPassed}`));
  if (counts.size > 1) {
    console.error('\n❌ Số test chạy KHÁC NHAU giữa các múi giờ:');
    for (const r of results) console.error(`     ${r.tz.padEnd(22)} ${r.summary.testsPassed} test / ${r.summary.filesPassed} file`);
    console.error('  Nghĩa là có test bị bỏ qua hoặc sinh thêm tuỳ múi giờ — kết quả xanh ở CI');
    console.error('  không còn nói lên điều gì về máy người dùng.');
    process.exitCode = 1;
    return;
  }

  const [{ summary }] = results;
  console.log(
    `\n✅ ${summary.testsPassed} test (${summary.filesPassed} file) cho kết quả GIỐNG HỆT dưới ${results.length} múi giờ: ${zones.join(', ')}.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
