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
// KHÔNG chạy cả `src`: phần component không có logic ngày, thêm vào chỉ tốn thời gian.
// Dùng GLOB thư mục chứ không phải danh sách file, để test viết sau tự động được phủ —
// một danh sách cứng sẽ lỗi thời im lặng và gate thành trang trí.
//
//   node scripts/check-timezone-stability.mjs
//   node scripts/check-timezone-stability.mjs --quick   # chỉ UTC vs Asia/Ho_Chi_Minh
//
// Không cần credential, không đọc database.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// `src/copilot` vào danh sách từ 14/08/2026: Copilot chuẩn hoá kỳ tương đối
// ("tháng này"/"tháng trước") bằng mã trong `temporalContext.ts`, tức nó có
// logic ngày tháng thật và thừa hưởng nguyên lớp lỗi mà gate này canh — mô hình
// hỏi "doanh thu tháng trước" lúc 1h sáng mùng 1 giờ VN mà máy chạy UTC sẽ ra
// lệch hẳn một kỳ. Chú thích cũ "phần component không có logic ngày" vẫn đúng
// cho phần còn lại của `src`, nhưng không còn đúng với thư mục này.
const TARGETS = ['src/lib', 'src/hooks', 'src/copilot'];

// UTC = môi trường CI. Asia/Ho_Chi_Minh = môi trường thật của dữ liệu.
// Hai đầu mút là để bắt lỗi mà hai cái trên bỏ lọt: chênh nhau 25 giờ.
const ZONES = ['UTC', 'Asia/Ho_Chi_Minh', 'Pacific/Kiritimati', 'Pacific/Midway'];

export function parseVitestSummary(output) {
  // Vitest in màu ANSI; bỏ trước khi khớp, nếu không regex trượt hết.
  const plain = output.replace(/\[[0-9;]*m/g, '');
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

function runUnder(tz) {
  // Gọi thẳng entry JS của vitest bằng process.execPath, KHÔNG qua npx: Node trên
  // Windows từ chối spawn file .cmd khi shell:false (EINVAL, bản vá bảo mật), còn bật
  // shell:true thì đường dẫn có dấu cách lại thành nguồn lỗi mới. Cách này không
  // đụng shell nên chạy giống nhau ở mọi nền tảng.
  const r = spawnSync(
    process.execPath,
    [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", ...TARGETS],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, TZ: tz } },
  );
  return { tz, code: r.status, summary: parseVitestSummary(`${r.stdout ?? ''}${r.stderr ?? ''}`) };
}

function main(argv) {
  const zones = argv.includes('--quick') ? ZONES.slice(0, 2) : ZONES;
  const results = [];

  for (const tz of zones) {
    process.stdout.write(`  chạy dưới TZ=${tz} … `);
    const r = runUnder(tz);
    if (!r.summary) {
      console.log('KHÔNG ĐỌC ĐƯỢC KẾT QUẢ');
      console.error(`\n❌ Không parse được output vitest dưới TZ=${tz}. Gate này vô nghĩa nếu không đọc được kết quả, nên coi là đỏ.`);
      process.exitCode = 1;
      return;
    }
    console.log(`${r.summary.testsPassed} xanh${r.summary.testsFailed ? `, ${r.summary.testsFailed} ĐỎ` : ''}`);
    results.push(r);
  }

  const failing = results.filter((r) => r.code !== 0 || r.summary.testsFailed > 0);
  if (failing.length > 0) {
    console.error(`\n❌ Test ĐỎ dưới ${failing.length}/${results.length} múi giờ: ${failing.map((r) => r.tz).join(', ')}`);
    console.error('  → chạy lại tay để xem chi tiết:');
    console.error(`     TZ=${failing[0].tz} npx vitest run ${TARGETS.join(' ')}`);
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
  console.log('   Khoảng cách UTC+14 ↔ UTC-11 là 25 giờ, nên mọi thời điểm trong ngày đều đã được thử ở hai "ngày" khác nhau.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
