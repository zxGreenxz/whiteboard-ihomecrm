#!/usr/bin/env node
// Gate: whitelist điều hướng của Copilot phải trỏ tới route CÓ THẬT và module
// quyền CÓ THẬT.
//
// VÌ SAO ĐÂY LÀ BIÊN NGUY HIỂM
//   `MO_TRANG_ROUTES` là thứ duy nhất quyết định Copilot đưa người dùng đi đâu.
//   Cả `route` lẫn `module` đều là CHUỖI, và cả hai hỏng theo kiểu khó truy:
//
//     - `route` sai ⇒ `navigate()` đưa tới một đường dẫn không tồn tại. Router
//       trả trang trắng hoặc màn 404, còn Copilot vẫn báo "✅ Đã mở trang …".
//       Người dùng nhìn thấy lời khẳng định thành công đè lên một màn hình rỗng.
//
//     - `module` sai ⇒ `canUse(perms, module, 'view')` không tìm thấy feature nào
//       nên trả false, và tool ném "Không có quyền xem trang X". Đó là câu báo
//       lỗi SAI SỰ THẬT: người dùng có quyền, chỉ là tên module gõ nhầm. Họ sẽ đi
//       xin cấp quyền cho một thứ họ đã có.
//
//   Không trình biên dịch nào bắt được hai ca này: cả hai đều là chuỗi hợp lệ.
//
// BA BẢN CHÉP ĐÃ ĐƯỢC BỎ, KHÔNG PHẢI ĐƯỢC GATE
//   Danh sách trang từng viết bốn lần (khoá map · `z.enum` · `description` gửi
//   cho mô hình · luật lúc chạy). Ba cái sau nay SINH TỪ map, nên gate này không
//   cần canh chúng — bỏ được một bản chép luôn tốt hơn dựng gate canh bản chép.
//
//   node scripts/check-copilot-routes.mjs
//
// Dùng lại `collectAllRoutes()` của check-route-guards để không chép tay danh
// sách route. Thoát 0 · 1 vi phạm · 3 KHÔNG ĐO ĐƯỢC.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectAllRoutes } from './check-route-guards.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE_REGISTRY = join(repoRoot, 'src', 'copilot', 'tools', 'registry.ts');
const FILE_GUARD = join(repoRoot, 'src', 'copilot', 'safetyGuard.ts');

/** Dưới ngần này route bóc được thì bộ đọc hỏng, không phải app hết route. */
export const SAN_ROUTE = 100;
/** Dưới ngần này mục whitelist thì bộ đọc hỏng, không phải whitelist rỗng. */
export const SAN_WHITELIST = 3;

/** `phong: { route: '/apartments', module: 'rooms', label: '…' }` → bản ghi. */
export function docWhitelist(vanBan) {
  const dau = vanBan.indexOf('export const MO_TRANG_ROUTES');
  if (dau < 0) return [];
  const than = vanBan.slice(dau, vanBan.indexOf('\n};', dau));
  const ra = [];
  for (const m of than.matchAll(
    /(\w+):\s*\{\s*route:\s*'([^']+)'\s*,\s*module:\s*'([^']+)'/g,
  )) {
    ra.push({ khoa: m[1], route: m[2], module: m[3] });
  }
  return ra;
}

/**
 * Tập `module.action` CÓ THẬT, nạp từ chính `permissionPages.ts` qua vite-node.
 *
 * Không đọc bằng regex: module ở file đó được truyền qua tham số hàm
 * (`crud("rooms", …)`, `ft(module, action, …)`) chứ không viết thành literal
 * `module: 'rooms'`. Bản regex đầu tiên đọc ra ĐÚNG 0 module và gate thoát 3 —
 * may là nhờ sàn chống-xanh-rỗng, nếu không nó đã "xanh" trên một tập rỗng.
 */
export function docFeatureQuyen() {
  // Worktree node_modules may be a junction to another checkout. Keep the
  // generated importer under repoRoot so vite-node resolves this tree's source.
  const tmp = join(repoRoot, '.tmp-copilot-loaders', '__perm-features.ts');
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(
    tmp,
    [
      'import { ALL_PAGE_FEATURES } from "../src/lib/permissionPages";',
      'console.log(JSON.stringify([...new Set(ALL_PAGE_FEATURES.map((f) => `${f.module}.${f.action}`))]));',
    ].join('\n'),
    'utf8',
  );
  try {
    // Đường dẫn TƯƠNG ĐỐI + shell:true — cùng bẫy npx.cmd/dấu cách đã ghi ở
    // check-realtime-descriptors.
    const r = spawnSync('npx', ['vite-node', '.tmp-copilot-loaders/__perm-features.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
      timeout: 10 * 60 * 1000,
    });
    const dong = String(r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
    return new Set(JSON.parse(dong));
  } catch {
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Route trong app, đã chuẩn hoá về dạng so sánh được: bỏ tham số động và dấu `/`
 * cuối. `/invoices/:id` và `/invoices` là hai route khác nhau với router, nhưng
 * whitelist chỉ trỏ tới trang danh sách nên so ở mức đường dẫn tĩnh là đủ.
 */
export function chuanHoa(p) {
  return String(p).replace(/\/+$/, '') || '/';
}

/** `PILOT_ROUTE_ALLOWLIST = ['/a', '/b']` → `['/a', '/b']`. */
export function docAllowlist(vanBan) {
  return [...String(vanBan).matchAll(/PILOT_ROUTE_ALLOWLIST\s*=\s*\[([^\]]*)\]/g)].flatMap((m) =>
    [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]),
  );
}

/**
 * Route mà `mo_trang` quảng cáo NHƯNG route guard sẽ chặn.
 *
 * Vì sao hai danh sách này phải trùng khớp, không chỉ là chuyện gọn gàng:
 * `mo_trang` gọi `navigate()` sang trang đích, rồi ngay bước kế tiếp
 * `makeRouteGuard` đọc `window.location.pathname` và NÉM LỖI nếu đường dẫn nằm
 * ngoài allowlist. Tức là tool tự đưa agent vào chỗ mà chốt chặn của chính nó
 * cấm đứng — agent điều hướng thành công rồi chết ngay sau đó, và người dùng
 * thấy "✅ Đã mở trang X" đi kèm một task đứt gánh.
 *
 * Đo 13/08/2026: whitelist 5 trang, allowlist 3 → `/contracts` và `/buildings`
 * rơi đúng vào cái bẫy này.
 *
 * So khớp theo cùng luật với guard lúc chạy: khớp tuyệt đối hoặc là tiền tố
 * thư mục (`/x` phủ `/x/123`), KHÔNG phải tiền tố chuỗi (`/x` không phủ `/xyz`).
 */
export function routesNgoaiAllowlist(whitelist, allowlist) {
  const ds = allowlist.map(chuanHoa);
  return whitelist
    .map((m) => (typeof m === 'string' ? m : m.route))
    .map(chuanHoa)
    .filter((r) => !ds.some((a) => r === a || r.startsWith(a + '/')));
}

function main() {
  const wl = docWhitelist(readFileSync(FILE_REGISTRY, 'utf8'));
  if (wl.length < SAN_WHITELIST) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ đọc được ${wl.length} mục whitelist (sàn ${SAN_WHITELIST}).`);
    console.error('   Hình dạng MO_TRANG_ROUTES đã đổi — đừng đọc thành "whitelist sạch".');
    process.exit(3);
  }

  let routes;
  try {
    routes = collectAllRoutes();
  } catch (e) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: không bóc được route — ${e.message}`);
    process.exit(3);
  }
  if (routes.length < SAN_ROUTE) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ bóc được ${routes.length} route (sàn ${SAN_ROUTE}).`);
    process.exit(3);
  }
  const coRoute = new Set(routes.map((r) => chuanHoa(typeof r === 'string' ? r : r.path)));

  const features = docFeatureQuyen();
  if (!features || features.size < 20) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ nạp được ${features ? features.size : 0} feature quyền (sàn 20).`);
    console.error('   vite-node lỗi hoặc permissionPages đổi hình dạng — đừng đọc thành "module đều hợp lệ".');
    process.exit(3);
  }

  const van = [];
  for (const m of wl) {
    if (!coRoute.has(chuanHoa(m.route))) {
      van.push(
        `${m.khoa}: route "${m.route}" KHÔNG tồn tại. Copilot sẽ báo "✅ Đã mở trang" ` +
        'rồi đưa người dùng tới màn trắng.',
      );
    }
    // Tool gọi `canUse(perms, module, 'view')`, nên phải có ĐÚNG cặp `<module>.view`.
    // Chỉ kiểm "module có tồn tại" là chưa đủ: một module chỉ khai `manage` mà
    // không khai `view` sẽ trượt y hệt, và triệu chứng giống hệt.
    if (!features.has(`${m.module}.view`)) {
      van.push(
        `${m.khoa}: không có feature quyền "${m.module}.view". canUse() trả false nên tool ` +
        'báo "Không có quyền xem trang" — câu đó SAI SỰ THẬT và đẩy người dùng đi xin quyền họ đã có.',
      );
    }
  }

  // Whitelist điều hướng phải là TẬP CON của phạm vi route guard cho phép đứng.
  const allowlist = docAllowlist(readFileSync(FILE_GUARD, 'utf8'));
  if (allowlist.length === 0) {
    console.error('❌ KHÔNG ĐO ĐƯỢC: không đọc được PILOT_ROUTE_ALLOWLIST trong safetyGuard.ts.');
    console.error('   Bộ đọc hỏng hoặc danh sách đã đổi hình dạng — đừng đọc thành "không lệch".');
    process.exit(3);
  }
  for (const r of routesNgoaiAllowlist(wl, allowlist)) {
    van.push(
      `route "${r}" được mo_trang quảng cáo nhưng NẰM NGOÀI PILOT_ROUTE_ALLOWLIST. ` +
        'Agent điều hướng tới nơi mà route guard cấm đứng: tool báo "✅ Đã mở trang" ' +
        'rồi bước kế tiếp ném lỗi và task đứt gánh.',
    );
  }

  console.log(
    `Whitelist Copilot: ${wl.length} trang · allowlist guard ${allowlist.length} route · ` +
      `đối chiếu ${coRoute.size} route và ${features.size} feature quyền.`,
  );

  if (van.length > 0) {
    console.error(`\n❌ ${van.length} vấn đề:\n`);
    for (const v of van) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }

  console.log('✅ Mọi trang trong whitelist đều có route thật và module quyền thật.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
