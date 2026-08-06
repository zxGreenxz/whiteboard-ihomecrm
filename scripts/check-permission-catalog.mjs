// Cổng CI: catalog nhãn tiếng Việt ở FE phải phủ ĐÚNG tập khoá quyền của DB.
//
// VÌ SAO CẦN
//   Khoá có trong permission_definitions mà FE không có nhãn => nó không xuất
//   hiện trên bảng phân quyền, nên KHÔNG AI cấp hay thu hồi được — quyền tồn
//   tại nhưng vô hình. Ngày 26/07 đã đo: DB 219 khoá, FE 208, thiếu đúng 11
//   (approvals.emergency_override, cashbooks.manage_custody/post,
//   income_expenses.reverse/self_approve_within_limit, notifications.create/edit,
//   sale_phong.edit, settings.create/delete, shareholder_profit.pay_manager).
//
//   Chiều ngược lại cũng hỏng: nhãn FE trỏ tới khoá DB không có => tick vào thì
//   RPC ghi từ chối với "Quyền ... không tồn tại", người dùng không hiểu vì sao.
//
// Dùng: node scripts/check-permission-catalog.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);

let pat = process.env.SUPABASE_PAT;
if (!pat) {
  try {
    pat = readFileSync(new URL('CLAUDE.local.md', root), 'utf8').match(/sbp_[a-f0-9]+/)?.[0];
  } catch { /* không có file cục bộ — CI truyền qua env */ }
}
if (!pat) {
  console.error('=== ⚠ KHÔNG KIỂM ĐƯỢC — KHÔNG PHẢI PASS ===');
  console.error('  Thiếu SUPABASE_PAT (env) hoặc CLAUDE.local.md.');
  console.error('');
  console.error('  Trước đây chỗ này thoát 0, tức "bỏ qua" và "đã kiểm, khớp" cho ra CÙNG một mã');
  console.error('  thoát — người chạy tay không có cách nào phân biệt. Gate này canh việc khoá');
  console.error('  quyền trong DB đều có nhãn ở FE; khoá thiếu nhãn là quyền TỒN TẠI NHƯNG VÔ HÌNH,');
  console.error('  không ai cấp hay thu hồi được. Một chữ PASS sai ở đây là im lặng bỏ mặc điều đó.');
  console.error('');
  console.error('  Thoát 3 = chưa đủ điều kiện chạy (khác 1 = LỆCH thật).');
  console.error('  CI không bị ảnh hưởng: job security-gates chỉ chạy khi preflight thấy has_pat.');
  process.exit(3);
}

const ref = readFileSync(new URL('supabase/config.toml', root), 'utf8')
  .match(/project_id\s*=\s*"([^"]+)"/)[1];

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: `select key from public.permission_definitions
             where permission_domain = 'TENANT' and is_active order by key`,
  }),
});
if (!res.ok) {
  console.error('Không gọi được Management API:', res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}
const dbKeys = new Set((await res.json()).map((r) => r.key));

// Đọc catalog FE qua vite-node để không phải tự parse TypeScript. vite-node
// không nhận cờ -e nên phải qua file tạm; đặt trong node_modules/.cache để
// alias và tsconfig của dự án vẫn áp dụng (ngoài cây dự án thì import hỏng).
const tmp = fileURLToPath(new URL('node_modules/.cache/__perm-keys.ts', root));
mkdirSync(dirname(tmp), { recursive: true });
writeFileSync(tmp, [
  "import { ALL_PAGE_FEATURES, featureKey } from '../../src/lib/permissionPages';",
  'console.log(JSON.stringify([...new Set(ALL_PAGE_FEATURES.map(featureKey))]));',
].join('\n'), 'utf8');

let dump;
try {
  // Truyền đường dẫn TƯƠNG ĐỐI, không phải `tmp` tuyệt đối. Với `shell: true`,
  // Node KHÔNG quote đối số mà nối tất cả thành một chuỗi lệnh, nên một đường dẫn
  // tuyệt đối chứa dấu cách bị shell cắt làm đôi: trên máy dev thật
  // ("C:\Users\Nguyen Tam\…") gate này chết với `Cannot find module '/@fs/C:/Users/Nguyen'`.
  // CI Linux có đường dẫn không dấu cách nên không bao giờ lộ.
  // `cwd` đã trỏ đúng gốc repo, và đường dẫn tương đối thì không có dấu cách.
  // (Không bỏ được `shell: true`: `npx` trên Windows là `npx.cmd`, mà Node từ chối
  // spawn file .cmd khi shell:false — EINVAL, bản vá bảo mật.)
  dump = spawnSync('npx', ['vite-node', 'node_modules/.cache/__perm-keys.ts'], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
    shell: true,
  });
} finally {
  rmSync(tmp, { force: true });
}
const found = dump.stdout?.match(/\[".*"\]/);
if (dump.status !== 0 || !found) {
  console.error(
    'Không đọc được catalog FE:',
    dump.error?.message ?? `exit ${dump.status}`,
    '\n',
    (dump.stderr || dump.stdout || '').slice(0, 800),
  );
  process.exit(1);
}
const feKeys = new Set(JSON.parse(found[0]));

const thieuNhan = [...dbKeys].filter((k) => !feKeys.has(k)).sort();
const nhanMoCoi = [...feKeys].filter((k) => !dbKeys.has(k)).sort();

console.log(`DB: ${dbKeys.size} khoá · FE: ${feKeys.size} nhãn`);
if (thieuNhan.length) {
  console.error(`\n❌ ${thieuNhan.length} khoá DB KHÔNG có nhãn FE (vô hình trên bảng phân quyền):`);
  thieuNhan.forEach((k) => console.error('   ', k));
}
if (nhanMoCoi.length) {
  console.error(`\n❌ ${nhanMoCoi.length} nhãn FE trỏ tới khoá DB không có (tick vào sẽ bị RPC từ chối):`);
  nhanMoCoi.forEach((k) => console.error('   ', k));
}
if (thieuNhan.length || nhanMoCoi.length) {
  console.error('\nSửa src/lib/permissionPages.ts (nhãn) hoặc permission_definitions (khoá) cho khớp.');
  process.exit(1);
}
console.log('✅ Catalog nhãn FE khớp đúng tập khoá quyền của DB.');
