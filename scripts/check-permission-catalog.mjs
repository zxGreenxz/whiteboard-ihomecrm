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
// Dump CẢ HAI bề mặt: catalog thô (ALL) và catalog SAU bộ lọc hiển thị
// (VISIBLE_PAGE_GROUPS — thứ PermissionPicker thật sự render), cộng danh sách
// trang được KHAI là chưa ship.
//
// Vì sao cần: gate chỉ so DB với catalog THÔ, nên mọi cách giấu quyền ở tầng
// hiển thị đều đi qua mà nó không thấy gì. Đo 07/08/2026: ALL=231, VISIBLE=223
// — 8 khoá openclaw_zalo.* đang is_active trong permission_definitions và ALLOW
// trên vai trò "Chủ sở hữu tổ chức" của cả 3 org (gồm org thật), nhưng người
// quản trị KHÔNG nhìn thấy để xem hay thu hồi. Ở đây việc giấu là CÓ CHỦ ĐÍCH
// và có khai (UNSHIPPED_PAGE_KEYS gác theo cờ runtime) — nên gate không nên đỏ,
// mà phải BẮT PHẢI KHAI: giấu có khai thì đọc được và cãi được, giấu không khai
// thì không.
writeFileSync(tmp, [
  "import { ALL_PAGE_FEATURES, VISIBLE_PAGE_GROUPS, UNSHIPPED_PAGE_KEYS, featureKey } from '../../src/lib/permissionPages';",
  'const all = [...new Set(ALL_PAGE_FEATURES.map(featureKey))];',
  'const visible = [...new Set(VISIBLE_PAGE_GROUPS.flatMap((g) => g.pages.flatMap((p) => p.features.map(featureKey))))];',
  'console.log(JSON.stringify({ all, visible, unshipped: [...UNSHIPPED_PAGE_KEYS] }));',
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
const found = dump.stdout?.match(/\{"all":.*\}/);
if (dump.status !== 0 || !found) {
  console.error(
    'Không đọc được catalog FE:',
    dump.error?.message ?? `exit ${dump.status}`,
    '\n',
    (dump.stderr || dump.stdout || '').slice(0, 800),
  );
  process.exit(1);
}
const bocRa = JSON.parse(found[0]);
const feKeys = new Set(bocRa.all);
const visibleKeys = new Set(bocRa.visible);
const unshipped = new Set(bocRa.unshipped);

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
// Chiều thứ BA: khoá có nhãn nhưng bị GIẤU khỏi bảng phân quyền.
//
// Hai phép so trên đối chiếu DB với catalog THÔ, nên chúng mù hoàn toàn với
// tầng hiển thị: một khoá vẫn "có nhãn" mà người quản trị không bao giờ thấy
// để cấp hay thu hồi. Hậu quả giống hệt trường hợp thiếu nhãn — quyền TỒN TẠI
// NHƯNG VÔ HÌNH — chỉ khác đường đi.
//
// Giấu KHÔNG phải lúc nào cũng sai: một trang chưa ship thì hiện ra chỉ gây rối.
// Nên luật ở đây là PHẢI KHAI, không phải CẤM — cùng nguyên tắc với PUBLIC_ROUTES
// và ROUTE_LONG_DA_KHAI. Khai rồi thì đọc được, cãi được, và tự hết hiệu lực khi
// cờ runtime bật.
const biGiau = [...dbKeys].filter((k) => feKeys.has(k) && !visibleKeys.has(k)).sort();
const giauKhongKhai = biGiau.filter((k) => !unshipped.has(k.split('.')[0])).sort();

if (biGiau.length) {
  console.log(
    `   ${biGiau.length} khoá có nhãn nhưng ẨN khỏi bảng phân quyền ` +
    `(trang chưa ship đã khai: ${[...unshipped].join(', ') || '(không)'})`,
  );
}
if (giauKhongKhai.length) {
  console.error(`\n❌ ${giauKhongKhai.length} khoá bị ẩn khỏi bảng phân quyền mà KHÔNG khai là chưa ship:`);
  giauKhongKhai.forEach((k) => console.error('   ', k));
  console.error('   Chúng đang is_active trong DB và có thể đang ALLOW trên vai trò nào đó,');
  console.error('   nhưng người quản trị không thấy để xem hay thu hồi.');
  console.error('   Xử: hiện chúng trong picker, HOẶC khai trang vào UNSHIPPED_PAGE_KEYS kèm lý do.');
}

if (thieuNhan.length || nhanMoCoi.length || giauKhongKhai.length) {
  console.error('\nSửa src/lib/permissionPages.ts (nhãn) hoặc permission_definitions (khoá) cho khớp.');
  process.exit(1);
}
console.log('✅ Catalog nhãn FE khớp đúng tập khoá quyền của DB.');
