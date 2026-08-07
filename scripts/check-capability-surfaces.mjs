#!/usr/bin/env node
// Gate: bề mặt sản phẩm (sidebar · launcher · route · trang quyền) phải SINH TỪ
// capability registry, không được khai lại bằng tay.
//
// VÌ SAO GATE NÀY RA ĐỜI CÙNG LÚC VỚI ĐỢT 4 LÁT 3
//   Lát 3 đổi consumer từ "khai tay rồi để contract test đối chiếu" sang "sinh
//   từ registry". Việc đó bịt một lỗ nhưng MỞ một lỗ khác, và lỗ mới nguy hiểm
//   hơn vì nó vô hình: contract test cũ so registry với sidebar/launcher, mà nay
//   sidebar/launcher SINH RA từ registry — nên phép so trở thành so registry với
//   chính nó. Nó sẽ xanh vĩnh viễn kể cả khi cả hai cùng sai.
//
//   Đây đúng là mẫu lỗi đã lặp lại nhiều lần trong repo này: "test kiểm bản chép
//   thay vì kiểm code thật". Lần này bản chép chính là bản gốc.
//
//   Nên phép kiểm phải chuyển sang thứ CÒN có thể lệch:
//     (1) không ai khai tay lại một capability route ở sidebar/launcher —
//         registry mất quyền sở hữu ngay khi có bản khai thứ hai;
//     (2) route trong App.tsx / src/app/routes/ vẫn là JSX viết tay (registry cố
//         ý không chứa component — plan §7), nên nó VẪN lệch được với registry;
//     (3) trang trong permission picker vẫn khai tay;
//     (4) trang tài liệu hệ thống mà registry trỏ tới phải tồn tại thật.
//
//   node scripts/check-capability-surfaces.mjs
//
// Không cần credential, không đọc database. Thoát 0 đạt · 1 vi phạm · 3 không kiểm được.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = (p) => readFileSync(join(repoRoot, p), "utf8");

/**
 * Sàn chống rỗng-vô-nghĩa. Nếu bộ đọc registry hỏng thì danh sách capability
 * thành rỗng, mọi vòng lặp chạy 0 lần, và gate in dấu tick trên hư không.
 */
const TOI_THIEU_CAPABILITY = 2;

/** File được phép NHẮC route capability dưới dạng chuỗi (nguồn hoặc test). */
const DUOC_NHAC = [
  "src/app/capabilities/registry.ts",
  "src/app/capabilities/surfaceAdapters.ts",
];

/**
 * Đọc registry bằng cách bóc literal, KHÔNG import module.
 *
 * registry.ts import runtime module đọc import.meta.env — Node trần không có
 * import.meta.env nên import thẳng sẽ nổ. Bóc literal đủ cho việc gate cần: id,
 * route, nhãn, quyền, trang quyền, trang tài liệu.
 */
export function bocRegistry(nguon) {
  const ra = [];
  const khoi = nguon.split(/\n\s*\{\s*\n/).slice(1);
  for (const k of khoi) {
    const id = k.match(/id:\s*"([^"]+)"/)?.[1];
    const route = k.match(/primaryRoute:\s*"([^"]+)"/)?.[1];
    if (!id || !route) continue;
    ra.push({
      id,
      route,
      label: k.match(/label:\s*"([^"]+)"/)?.[1] ?? null,
      module: k.match(/module:\s*"([^"]+)"/)?.[1] ?? null,
      action: k.match(/action:\s*"([^"]+)"/)?.[1] ?? null,
      permissionPage: k.match(/permissionPage:\s*"([^"]+)"/)?.[1] ?? null,
      systemDoc: k.match(/systemDoc:\s*"([^"]+)"/)?.[1] ?? null,
    });
  }
  return ra;
}

/** Route capability xuất hiện dưới dạng chuỗi trong file consumer ⇒ khai tay. */
export function timKhaiTay(nguon, route) {
  // Bỏ comment trước khi tìm: một comment giải thích "route /openclaw-zalo bị
  // gác sau cờ" KHÔNG phải bản khai thứ hai. Cùng lớp lỗi với gate từng tự khớp
  // vào chính câu nói thứ đó bị cấm (đã xảy ra 3 lần trong repo này).
  const sach = nguon.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  return new RegExp(`["'\`]${route.replace(/\//g, "\\/")}["'\`]`).test(sach);
}

/**
 * Có <Route> phục vụ route này không.
 *
 * Chấp nhận CẢ dạng splat `path="/network-center/*"` — react-router khớp nó với
 * chính `/network-center` lẫn mọi đường con, nên đòi đúng chuỗi khít là báo động
 * giả. Bản đầu của gate này đòi khít và đã kêu nhầm ngay lần chạy thứ nhất; đúng
 * mẫu "bộ lọc chỉ phủ MỘT biến thể" đã lặp lại nhiều lần trong repo.
 */
export function coRoute(nguon, route) {
  const r = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`path=["']${r}(/\\*)?["']`).test(nguon);
}

/** Mọi file .tsx khai route, để tìm <Route path="..."> của capability. */
function nguonRoute() {
  const ra = [{ p: "src/App.tsx", s: doc("src/App.tsx") }];
  const thuMuc = join(repoRoot, "src", "app", "routes");
  if (existsSync(thuMuc)) {
    for (const f of readdirSync(thuMuc)) {
      if (f.endsWith(".tsx")) ra.push({ p: `src/app/routes/${f}`, s: doc(`src/app/routes/${f}`) });
    }
  }
  return ra;
}

function main() {
  let caps;
  try {
    caps = bocRegistry(doc("src/app/capabilities/registry.ts"));
  } catch (e) {
    console.error(`❌ Không đọc được registry: ${e.message}`);
    process.exit(3);
  }
  if (caps.length < TOI_THIEU_CAPABILITY) {
    console.error(`❌ Chỉ bóc được ${caps.length} capability (sàn ${TOI_THIEU_CAPABILITY}) — bộ đọc hỏng.`);
    console.error(`   "0 vi phạm" trên 0 capability là câu đúng mà vô nghĩa.`);
    process.exit(3);
  }

  const viPham = [];

  // (1) Không được khai tay lại ở consumer.
  const consumer = ["src/components/layout/Sidebar.tsx", "src/pages/home/launcherTiles.ts"];
  for (const f of consumer) {
    if (DUOC_NHAC.includes(f)) continue;
    const s = doc(f);
    for (const c of caps) {
      if (timKhaiTay(s, c.route)) {
        viPham.push(
          `${f}: còn khai TAY route "${c.route}". Bề mặt này phải sinh từ registry ` +
            `(navFieldsFor / launcherFieldsFor) — bản khai thứ hai làm registry mất quyền sở hữu.`,
        );
      }
    }
  }

  // (2) Route JSX vẫn viết tay ⇒ vẫn lệch được với registry. Phải tồn tại.
  const nguon = nguonRoute();
  for (const c of caps) {
    const co = nguon.some((n) => coRoute(n.s, c.route));
    if (!co) {
      viPham.push(
        `Không tìm thấy <Route path="${c.route}"> ở App.tsx hay src/app/routes/. ` +
          `Registry khai capability này nhưng không có route nào phục vụ nó ⇒ nav/tile dẫn tới 404.`,
      );
    }
  }

  // (3) Trang trong permission picker vẫn khai tay.
  const pp = doc("src/lib/permissionPages.ts");
  for (const c of caps) {
    if (!c.permissionPage) continue;
    if (!new RegExp(`["']${c.permissionPage.replace(/\//g, "\\/")}["']`).test(pp)) {
      viPham.push(
        `permissionPages.ts thiếu trang "${c.permissionPage}" của capability ${c.id} ⇒ ` +
          `không ai cấp/thu được quyền cho trang này qua giao diện phân quyền.`,
      );
    }
  }

  // (4) Trang tài liệu hệ thống phải tồn tại thật.
  for (const c of caps) {
    if (c.systemDoc && !existsSync(join(repoRoot, c.systemDoc))) {
      viPham.push(`Capability ${c.id} trỏ tới tài liệu không tồn tại: ${c.systemDoc}`);
    }
  }

  console.log(`Capability: ${caps.length} · consumer kiểm ${consumer.length} · nguồn route ${nguon.length}`);

  if (viPham.length > 0) {
    console.error(`\n❌ ${viPham.length} vi phạm:`);
    for (const v of viPham) console.error(`   - ${v}`);
    process.exit(1);
  }
  console.log(`✅ ${caps.length} capability: bề mặt sinh từ registry, route/trang quyền/tài liệu đều có mặt.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
