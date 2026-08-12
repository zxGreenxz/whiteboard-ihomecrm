#!/usr/bin/env node
// Gate: quyền gác ROUTE phải khớp `capability.permission` trong registry.
//
// VÌ SAO CẦN
//   Registry khai mỗi capability có một quyền: `{ module, action }`. Bốn nơi đọc
//   quyền đó — route guard, sidebar, launcher, permission picker — và ba nơi sau
//   đã được sinh/kiểm từ registry. Route guard thì KHÔNG: nó khai tay trong JSX.
//
//   Lệch ở đây là loại lệch tệ nhất trong bốn nơi. Sidebar lệch thì người dùng
//   thấy một mục không bấm được — phiền, nhìn ra ngay. Route guard lệch thì trang
//   MỞ ĐƯỢC bằng cách gõ thẳng URL dù registry nói cần quyền khác, và không có
//   triệu chứng nào cho tới khi ai đó thử.
//
// HAI KIỂU GUARD, VÀ KHÔNG ĐƯỢC GIẢ VỜ CHÚNG GIỐNG NHAU
//   `<RequirePermission module="…" action="…">`  — đọc thẳng được
//   `<OpenClawRouteGuard>`                        — guard riêng, quyền nằm bên trong
//   Kiểu thứ hai phải truy vào file của guard. Nếu không truy được thì exit 3:
//   "không đọc được quyền của guard" KHÁC "quyền khớp".
//
//   node scripts/check-route-permission-drift.mjs
//
// Không cần credential. Thoát 0 · 1 khi lệch · 3 khi KHÔNG ĐỌC ĐƯỢC.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boChuThichJs, boChuThichJsx } from './lib/bo-chu-thich.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `{ id, primaryRoute, module, action }` cho mỗi capability trong registry. */
export function docRegistry(nguon) {
  const code = boChuThichJs(nguon);
  const ra = [];
  for (const khoi of code.split(/\n\s*\{\s*\n/).slice(1)) {
    const id = /id:\s*"([^"]+)"/.exec(khoi)?.[1];
    const route = /primaryRoute:\s*"([^"]+)"/.exec(khoi)?.[1];
    const p = /permission:\s*\{\s*module:\s*"([^"]+)",\s*action:\s*"([^"]+)"/.exec(khoi);
    // Miễn trừ guard phải nằm TRONG khối `permission` của chính capability đó.
    // Bóc trên cả khối sẽ nhận nhầm một `mienTruVi` của `e2e` hay `docs` — ba
    // trường miễn trừ khác nhau, và lẫn chúng thì một lý do viết cho E2E sẽ âm
    // thầm mở khoá phép kiểm quyền.
    const khoiQuyen = /permission:\s*\{[\s\S]*?\n\s{4}\}/.exec(khoi)?.[0] ?? '';
    const mienTru = /guardMienTruVi:\s*\n?\s*"([^"]+)"/.exec(khoiQuyen)?.[1] ?? null;
    if (id && route && p) {
      ra.push({ id, primaryRoute: route, module: p[1], action: p[2], guardMienTruVi: mienTru });
    }
  }
  return ra;
}

/**
 * Quyền mà JSX của một route khai.
 *
 * Trả `{ loai: 'truc-tiep' | 'guard-rieng' | 'khong-thay', ... }` — ba trạng thái
 * tách bạch, vì "không thấy guard nào" và "guard riêng chưa truy được" dẫn tới hai
 * kết luận khác nhau.
 */
export function quyenCuaRoute(nguonRoute, duongRoute) {
  // Khớp route theo path, chấp nhận cả dạng `/x` và `/x/*`.
  const esc = duongRoute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`path=\\s*["']${esc}(?:/\\*)?["']([\\s\\S]{0,600})`, 'm');
  const m = re.exec(boChuThichJsx(nguonRoute));
  if (!m) return { loai: 'khong-thay-route' };

  // CẮT Ở ROUTE KẾ TIẾP, không đọc trọn 600 ký tự.
  //
  // Bản đầu lấy nguyên cửa sổ 600 ký tự sau `path="…"`, mà 600 ký tự thừa sức
  // tràn qua hai ba <Route> nữa. Cộng với lỗi thứ hai ngay dưới, nó sinh ra báo
  // động giả kiểu tệ nhất: gate nói `/invoices` gác bằng `invoices.print` trong
  // khi route đó gác bằng `invoices` — con số nó đọc là của route KHÁC.
  const doan = m[1].split(/path=\s*["']/)[0];

  // `action` là TUỲ CHỌN. `RequirePermission` khai `action = "view"` làm mặc định
  // (xem src/components/auth/RequirePermission.tsx), và phần lớn route trong repo
  // dựa vào mặc định đó. Regex cũ ĐÒI có `action=`, nên với route không khai nó
  // không khớp — rồi quét tiếp và vớ phải `action` của route sau.
  const truc = /<RequirePermission\s+module=["']([^"']+)["']((?:\s+\w+=["'][^"']*["'])*)/.exec(doan);
  if (truc) {
    const action = /\baction=["']([^"']+)["']/.exec(truc[2] ?? '')?.[1] ?? 'view';
    return { loai: 'truc-tiep', module: truc[1], action };
  }

  const guard = /<([A-Z][A-Za-z0-9]*(?:RouteGuard|Guard))\b/.exec(doan);
  if (guard) return { loai: 'guard-rieng', ten: guard[1] };

  return { loai: 'khong-thay-guard' };
}

/** Quyền `module.action` mà một guard riêng dùng, đọc từ file của nó. */
export function quyenCuaGuard(nguonGuard) {
  const code = boChuThichJs(nguonGuard);
  const m = /["']([a-z0-9_]+)\.([a-z0-9_]+)["']/.exec(code.match(/VIEW_PERMISSION\s*=\s*["'][^"']+["']/)?.[0] ?? '');
  return m ? { module: m[1], action: m[2] } : null;
}

function main() {
  let files;
  try {
    files = execFileSync('git', ['ls-files', 'src'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter((p) => /\.tsx?$/.test(p));
  } catch (error) {
    console.error(`❌ KHÔNG ĐỌC ĐƯỢC danh sách file: ${error.message}`);
    process.exit(3);
  }

  const doc = (p) => readFileSync(join(repoRoot, p), 'utf8');
  const caps = docRegistry(doc('src/app/capabilities/registry.ts'));
  if (caps.length === 0) {
    console.error('❌ KHÔNG ĐỌC ĐƯỢC capability nào từ registry — bộ bóc hỏng, không phải "registry rỗng".');
    process.exit(3);
  }

  const routeFiles = files.filter((p) => p.startsWith('src/app/routes/') && p.endsWith('.tsx'));
  if (routeFiles.length < 5) {
    console.error(`❌ KHÔNG ĐỌC ĐƯỢC file route (thấy ${routeFiles.length}, đo 11/08/2026: 11).`);
    process.exit(3);
  }
  const nguonRoute = routeFiles.map(doc).join('\n');

  const lech = [];
  const khongDoc = [];
  /** Route cố ý không gác, kèm lý do — in ra để nó không lặng lẽ tích lại. */
  const mienTruGuard = [];

  for (const c of caps) {
    const q = quyenCuaRoute(nguonRoute, c.primaryRoute);

    if (q.loai === 'khong-thay-route') {
      khongDoc.push(`${c.id}: không tìm thấy route \`${c.primaryRoute}\` trong src/app/routes/.`);
      continue;
    }
    if (q.loai === 'khong-thay-guard') {
      // Miễn trừ TƯỜNG MINH: route cố ý không gác vì trang tự rẽ theo quyền bên
      // trong. Chỉ chấp nhận khi có LÝ DO viết ra — không có lý do thì đây vẫn là
      // "quên gác", và đó là điều gate này sinh ra để bắt.
      if (c.guardMienTruVi) {
        mienTruGuard.push(`${c.id}: route \`${c.primaryRoute}\` cố ý không gác — ${c.guardMienTruVi}`);
        continue;
      }
      lech.push(`${c.id}: route \`${c.primaryRoute}\` KHÔNG có guard quyền nào — registry nói cần ${c.module}.${c.action}.`);
      continue;
    }

    // Có guard THẬT mà vẫn khai miễn trừ ⇒ lý do đã lạc hậu. Để nguyên thì lần
    // sau ai đó gỡ guard đi sẽ không ai báo, vì miễn trừ vẫn còn đó.
    if (c.guardMienTruVi) {
      lech.push(
        `${c.id}: khai \`guardMienTruVi\` nhưng route \`${c.primaryRoute}\` CÓ guard thật — gỡ miễn trừ đi, nếu không nó sẽ che lần gỡ guard sau.`,
      );
      continue;
    }

    if (q.loai === 'guard-rieng') {
      const f = files.find((p) => p.endsWith(`/${q.ten}.tsx`));
      if (!f) {
        khongDoc.push(`${c.id}: guard \`${q.ten}\` không tìm thấy file — không đọc được quyền của nó.`);
        continue;
      }
      const qg = quyenCuaGuard(doc(f));
      if (!qg) {
        khongDoc.push(`${c.id}: đọc được ${f} nhưng không rút ra quyền — bộ bóc chưa hiểu cách guard này khai.`);
        continue;
      }
      if (qg.module !== c.module || qg.action !== c.action) {
        lech.push(`${c.id}: guard \`${q.ten}\` dùng ${qg.module}.${qg.action}, registry khai ${c.module}.${c.action}.`);
      }
      continue;
    }

    if (q.module !== c.module || q.action !== c.action) {
      lech.push(`${c.id}: route guard dùng ${q.module}.${q.action}, registry khai ${c.module}.${c.action}.`);
    }
  }

  if (khongDoc.length > 0) {
    console.error(`❌ KHÔNG KIỂM ĐƯỢC ${khongDoc.length} capability:\n`);
    for (const k of khongDoc) console.error(`  - ${k}`);
    console.error('\n  "Không đọc được quyền của guard" KHÁC "quyền khớp". Sửa bộ bóc hoặc route.');
    process.exit(3);
  }

  if (lech.length > 0) {
    console.error(`❌ ${lech.length} route gác bằng quyền KHÁC registry:\n`);
    for (const l of lech) console.error(`  - ${l}`);
    console.error('\n  Route guard lệch là loại tệ nhất trong bốn nơi đọc quyền: trang MỞ ĐƯỢC bằng cách');
    console.error('  gõ thẳng URL, và không có triệu chứng nào cho tới khi ai đó thử.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `✅ ${caps.length} capability: quyền gác route khớp registry` +
      (mienTruGuard.length > 0 ? ` (${mienTruGuard.length} miễn trừ tường minh).` : "."),
  );
  // In ra thay vì im lặng: miễn trừ mà không ai nhìn thấy thì tích lại thành một
  // danh sách route không gác, và không có lúc nào để ai đó hỏi "cái này còn đúng
  // không". Đây là dòng thông tin, không phải cảnh báo — nó không đổi mã thoát.
  for (const m of mienTruGuard) console.log(`   ℹ ${m}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
