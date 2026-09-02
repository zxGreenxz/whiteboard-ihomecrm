#!/usr/bin/env node
// Gate: phạm vi trang của Copilot phải SINH TỪ page contract, và mỗi đích điều
// hướng phải trỏ tới route CÓ THẬT với cặp quyền CÓ THẬT.
//
// VÌ SAO ĐÂY LÀ BIÊN NGUY HIỂM
//   `ROUTE_DIEU_HUONG` là thứ duy nhất quyết định Copilot đưa người dùng đi đâu.
//   Cả `route` lẫn `module` đều là CHUỖI, và cả hai hỏng theo kiểu khó truy:
//
//     - `route` sai ⇒ `navigate()` đưa tới một đường dẫn không tồn tại. Router
//       trả trang trắng hoặc màn 404, còn Copilot vẫn báo "✅ Đã mở trang …".
//       Người dùng nhìn thấy lời khẳng định thành công đè lên một màn hình rỗng.
//
//     - `module`/`action` sai ⇒ `canUse(perms, module, action)` không tìm thấy
//       feature nào nên trả false, và tool ném "Không có quyền xem trang X". Đó
//       là câu báo lỗi SAI SỰ THẬT: người dùng có quyền, chỉ là tên gõ nhầm. Họ
//       sẽ đi xin cấp quyền cho một thứ họ đã có.
//
//   Không trình biên dịch nào bắt được hai ca này: cả hai đều là chuỗi hợp lệ.
//
// BA BẢN CHÉP ĐÃ BỎ HẲN (02/09/2026) — GATE ĐỔI CÂU HỎI
//   Trước lát G1-A, gate này đối chiếu `MO_TRANG_ROUTES` với
//   `PILOT_ROUTE_ALLOWLIST`: hai danh sách viết tay, và gate chỉ nói được
//   "chúng đang lệch". Nay cả hai (cùng chỉ dẫn theo trang) đều sinh từ
//   `COPILOT_PAGE_CONTRACTS` qua `src/copilot/pageScope.ts`, nên phép so cũ trở
//   thành so một thứ với chính nó — xanh vĩnh viễn, kể cả khi cả hai cùng sai.
//
//   Câu hỏi CÒN lệch được, và là câu gate này hỏi:
//     (1) có route điều hướng nào KHÔNG thuộc contract không (ai đó thêm tay);
//     (2) allowlist UI-control có KHỚP ĐÚNG tập contract khai `safeControlIds`
//         không — nới bằng tay là mở phạm vi thao tác ở nơi chưa duyệt control nào;
//     (3) route có thật trong router không, cặp `module.action` có thật không.
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
const FILE_CREATE_AGENT = join(repoRoot, 'src', 'copilot', 'createAgent.ts');

/** Dưới ngần này route bóc được thì bộ đọc hỏng, không phải app hết route. */
export const SAN_ROUTE = 100;
/**
 * Dưới ngần này đích điều hướng thì bộ nạp hỏng, không phải phạm vi teo lại.
 *
 * Đo 02/09/2026: 19 route sinh từ 47 contract. Sàn phải NẰM TRÊN con số 3 của
 * ba danh sách tay cũ — một lần rơi về pilot cũ trông y hệt "phạm vi sạch".
 */
export const SAN_DIEU_HUONG = 15;
/** Dưới ngần này contract thì `COPILOT_PAGE_CONTRACTS` không nạp được. */
export const SAN_HOP_DONG = 15;
/** Dưới ngần này route UI-control thì bộ nạp hỏng, không phải pilot bị tắt. */
export const SAN_PILOT = 3;

/**
 * TÊN DUY NHẤT được phép làm allowlist mặc định của page-agent.
 *
 * VÌ SAO GATE PHẢI ĐO ĐÚNG CHỖ RUNTIME ĐỌC
 *   Gate nạp giá trị của `PILOT_UI_CONTROL_ROUTES` — BÊN SẢN XUẤT. Nếu ai đó đặt
 *   một bí danh ở giữa (`const X = [...PILOT_UI_CONTROL_ROUTES, '/contracts']`) rồi
 *   cho `createAgent` dùng X, thì mọi con số gate đo được vẫn đúng trong khi phạm
 *   vi ĐỨNG của page-agent đã rộng ra. Đo giá trị bên sản xuất là đo một thứ
 *   không ai dùng.
 *
 *   Nên gate kiểm thêm một điều không suy ra được từ giá trị: chỗ gọi trong
 *   `createAgent.ts` phải trỏ ĐÚNG CÁI TÊN này, không phải một biến khác và
 *   không phải một mảng viết tại chỗ.
 */
export const TEN_ALLOWLIST = 'PILOT_UI_CONTROL_ROUTES';

/**
 * Route đã chuẩn hoá về dạng so sánh được: bỏ dấu `/` cuối.
 */
export function chuanHoa(p) {
  return String(p).replace(/\/+$/, '') || '/';
}

/**
 * Đích điều hướng KHÔNG có contract nào chống lưng.
 *
 * So khớp TUYỆT ĐỐI, không phải tiền tố: điều hướng trỏ tới một route cụ thể,
 * và nới thành tiền tố sẽ cho `/finance/salary` (miễn trừ) lọt qua chỉ vì có
 * contract `/finance/cashbooks`.
 */
export function routesNgoaiHopDong(dieuHuong, routeHopDong) {
  const co = new Set(routeHopDong.map(chuanHoa));
  return dieuHuong
    .map((m) => (typeof m === 'string' ? m : m.route))
    .map(chuanHoa)
    .filter((r) => !co.has(r));
}

/**
 * Lệch giữa allowlist UI-control và tập contract khai `safeControlIds`.
 *
 * Trả HAI CHIỀU. Chỉ kiểm một chiều thì nửa còn lại im lặng: xoá
 * `safeControlIds` của một trang mà quên rút allowlist vẫn xanh (page-agent
 * đứng ở trang không còn control nào được duyệt), còn nới allowlist bằng tay
 * cũng vẫn xanh (mở phạm vi thao tác ngoài contract).
 */
export function lechUiControl(pilot, routeCoControl) {
  const dsPilot = new Set(pilot.map(chuanHoa));
  const dsControl = new Set(routeCoControl.map(chuanHoa));
  return {
    thieu: [...dsControl].filter((r) => !dsPilot.has(r)),
    thua: [...dsPilot].filter((r) => !dsControl.has(r)),
  };
}

/**
 * Tên biểu thức làm allowlist mặc định trong `createAgent.ts`.
 *
 * Trả `null` khi không tìm thấy câu `params.allowlist ?? X` — gọi là KHÔNG ĐO
 * ĐƯỢC, không phải "không vi phạm". Trả chuỗi rỗng khi vế phải không phải một
 * định danh trần (ví dụ một mảng viết tại chỗ) — đó là vi phạm.
 */
export function docTenAllowlist(nguon) {
  const m = String(nguon).match(/params\.allowlist\s*\?\?\s*([^;]+);/);
  if (!m) return null;
  const ve = m[1].trim();
  return /^[A-Za-z_$][\w$]*$/.test(ve) ? ve : '';
}

/**
 * Nạp phạm vi THẬT bằng vite-node, không đọc bằng regex.
 *
 * Vì sao không regex: cả ba danh sách nay là kết quả của một phép suy diễn
 * (`COPILOT_PAGE_CONTRACTS` → gộp theo canonical route → bỏ route động). Regex
 * đọc được literal, không đọc được phép suy diễn — và một bộ đọc regex hỏng trả
 * rỗng, mà rỗng trông y hệt "phạm vi sạch". Đo 11/08/2026 đã dính đúng lỗi đó
 * với `permissionPages.ts` (bản regex đầu tiên đọc ra ĐÚNG 0 module).
 *
 * Nạp một lượt cả feature quyền để chỉ trả giá khởi động vite-node một lần.
 */
export function napPhamViTrang() {
  // Worktree node_modules may be a junction to another checkout. Keep the
  // generated importer under repoRoot so vite-node resolves this tree's source.
  const tmp = join(repoRoot, '.tmp-copilot-loaders', '__copilot-page-scope.ts');
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(
    tmp,
    [
      'import { ROUTE_DIEU_HUONG, PILOT_UI_CONTROL_ROUTES } from "../src/copilot/pageScope";',
      'import { COPILOT_PAGE_CONTRACTS } from "../src/app/capabilities/registry";',
      'import { ALL_PAGE_FEATURES } from "../src/lib/permissionPages";',
      'const canon = (p: { route: string; canonicalRoute?: string }) => p.canonicalRoute ?? p.route;',
      'console.log(JSON.stringify({',
      '  dieuHuong: ROUTE_DIEU_HUONG.map((m) => ({ key: m.key, route: m.route, module: m.module, action: m.action, label: m.label })),',
      '  pilot: [...PILOT_UI_CONTROL_ROUTES],',
      '  hopDongRoute: COPILOT_PAGE_CONTRACTS.map(canon),',
      '  hopDongCoControl: COPILOT_PAGE_CONTRACTS.filter((p) => p.safeControlIds.length > 0).map(canon),',
      '  features: [...new Set(ALL_PAGE_FEATURES.map((f) => `${f.module}.${f.action}`))],',
      '}));',
    ].join('\n'),
    'utf8',
  );
  try {
    // Đường dẫn TƯƠNG ĐỐI + shell:true — cùng bẫy npx.cmd/dấu cách đã ghi ở
    // check-realtime-descriptors.
    const r = spawnSync('npx', ['vite-node', '.tmp-copilot-loaders/__copilot-page-scope.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
      timeout: 10 * 60 * 1000,
    });
    const dong = String(r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
    return JSON.parse(dong);
  } catch {
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

function main() {
  const pv = napPhamViTrang();
  if (!pv) {
    console.error('❌ KHÔNG ĐO ĐƯỢC: vite-node không nạp được src/copilot/pageScope.ts.');
    console.error('   Đừng đọc thành "phạm vi sạch" — không có số nào được đo cả.');
    process.exit(3);
  }
  if (!Array.isArray(pv.dieuHuong) || pv.dieuHuong.length < SAN_DIEU_HUONG) {
    console.error(
      `❌ KHÔNG ĐO ĐƯỢC: chỉ nạp được ${pv.dieuHuong?.length ?? 0} đích điều hướng (sàn ${SAN_DIEU_HUONG}).`,
    );
    console.error('   Hình dạng ROUTE_DIEU_HUONG đã đổi, hoặc phạm vi vừa teo về pilot cũ.');
    process.exit(3);
  }
  if (!Array.isArray(pv.hopDongRoute) || pv.hopDongRoute.length < SAN_HOP_DONG) {
    console.error(
      `❌ KHÔNG ĐO ĐƯỢC: chỉ nạp được ${pv.hopDongRoute?.length ?? 0} page contract (sàn ${SAN_HOP_DONG}).`,
    );
    process.exit(3);
  }
  if (!Array.isArray(pv.pilot) || pv.pilot.length < SAN_PILOT) {
    console.error(
      `❌ KHÔNG ĐO ĐƯỢC: chỉ nạp được ${pv.pilot?.length ?? 0} route UI-control (sàn ${SAN_PILOT}).`,
    );
    console.error('   Bộ nạp hỏng hoặc contract mất `safeControlIds` — đừng đọc thành "allowlist sạch".');
    process.exit(3);
  }
  const features = new Set(pv.features ?? []);
  if (features.size < 20) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ nạp được ${features.size} feature quyền (sàn 20).`);
    console.error('   permissionPages đổi hình dạng — đừng đọc thành "module đều hợp lệ".');
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

  const van = [];
  for (const m of pv.dieuHuong) {
    if (!coRoute.has(chuanHoa(m.route))) {
      van.push(
        `${m.key}: route "${m.route}" KHÔNG tồn tại. Copilot sẽ báo "✅ Đã mở trang" ` +
          'rồi đưa người dùng tới màn trắng.',
      );
    }
    if (m.route.includes(':')) {
      van.push(
        `${m.key}: route "${m.route}" còn tham số động. mo_trang không biết điền id nào ` +
          'nên sẽ điều hướng tới đường dẫn nguyên văn và ra màn 404.',
      );
    }
    // Tool gọi `canUse(perms, module, action)` theo ĐÚNG contract, nên phải có
    // đúng cặp đó. Chỉ kiểm "module có tồn tại" là chưa đủ: một module chỉ khai
    // `manage` mà không khai action cần dùng sẽ trượt y hệt, triệu chứng giống hệt.
    if (!features.has(`${m.module}.${m.action}`)) {
      van.push(
        `${m.key}: không có feature quyền "${m.module}.${m.action}". canUse() trả false nên ` +
          'tool báo "Không có quyền xem trang" — câu đó SAI SỰ THẬT và đẩy người dùng đi xin ' +
          'quyền họ đã có.',
      );
    }
  }

  for (const r of routesNgoaiHopDong(pv.dieuHuong, pv.hopDongRoute)) {
    van.push(
      `route "${r}" nằm trong phạm vi điều hướng nhưng KHÔNG có page contract nào. ` +
        'Một bề mặt Copilot không có contract là bề mặt không ai duyệt: không dataClass, ' +
        'không mode, không rollout key. Khai ở src/app/capabilities/registry.ts.',
    );
  }

  // Chỗ RUNTIME ĐỌC: `createAgent` phải lấy allowlist từ ĐÚNG một cái tên.
  const tenAllowlist = docTenAllowlist(readFileSync(FILE_CREATE_AGENT, 'utf8'));
  if (tenAllowlist === null) {
    console.error('❌ KHÔNG ĐO ĐƯỢC: không thấy `params.allowlist ?? …` trong createAgent.ts.');
    console.error('   Chỗ page-agent lấy phạm vi đứng đã đổi hình dạng — đừng đọc thành "không lệch".');
    process.exit(3);
  }
  if (tenAllowlist !== TEN_ALLOWLIST) {
    van.push(
      `createAgent.ts lấy allowlist mặc định từ "${tenAllowlist || '<biểu thức tại chỗ>'}" chứ không phải ` +
        `${TEN_ALLOWLIST}. Gate đo giá trị bên sản xuất, nên một bí danh ở giữa sẽ nới phạm vi ` +
        'ĐỨNG của page-agent mà mọi con số vẫn xanh.',
    );
  }

  // Trang pilot phải ĐẾN ĐƯỢC: control đã duyệt mà không có đích điều hướng thì
  // luật fail-closed theo VISIBLE_PAGE_GROUPS vừa nuốt mất một trang pilot.
  const dsDieuHuong = new Set(pv.dieuHuong.map((m) => chuanHoa(m.route)));
  for (const r of (pv.pilot ?? []).map(chuanHoa)) {
    if (!dsDieuHuong.has(r)) {
      van.push(
        `route UI-control "${r}" KHÔNG nằm trong phạm vi điều hướng. Thường là do trang ` +
          'rớt khỏi VISIBLE_PAGE_GROUPS (chưa ship) — page-agent đứng ở một trang mà ' +
          'chính Copilot không thừa nhận là điểm đến.',
      );
    }
  }

  const lech = lechUiControl(pv.pilot ?? [], pv.hopDongCoControl ?? []);
  for (const r of lech.thua) {
    van.push(
      `route "${r}" nằm trong allowlist UI-control nhưng contract của nó KHÔNG khai ` +
        '`safeControlIds`. Page-agent được đứng và thao tác ở một trang chưa duyệt control nào.',
    );
  }
  for (const r of lech.thieu) {
    van.push(
      `route "${r}" có contract khai \`safeControlIds\` nhưng KHÔNG nằm trong allowlist ` +
        'UI-control. Control đã duyệt mà agent không tới đứng được — phạm vi teo trong im lặng.',
    );
  }

  console.log(
    `Phạm vi Copilot: ${pv.dieuHuong.length} đích điều hướng · ${pv.pilot.length} route UI-control · ` +
      `sinh từ ${pv.hopDongRoute.length} page contract · đối chiếu ${coRoute.size} route và ` +
      `${features.size} feature quyền.`,
  );

  if (van.length > 0) {
    console.error(`\n❌ ${van.length} vấn đề:\n`);
    for (const v of van) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }

  console.log('✅ Mọi đích điều hướng đều sinh từ contract, có route thật và cặp quyền thật.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
