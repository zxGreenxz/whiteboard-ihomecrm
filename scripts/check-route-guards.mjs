#!/usr/bin/env node
// Gate: mọi <Route> trong App.tsx phải nằm dưới một guard đã biết, hoặc được
// khai TƯỜNG MINH là công khai.
//
// VÌ SAO CẦN
//   App.tsx có ~150 route và 169 chỗ dùng RequirePermission. Thêm một route mới
//   mà quên bọc guard là một dòng JSX trông y hệt các dòng bên cạnh — không có
//   gì đỏ, không có gì cảnh báo, và trang đó lộ cho bất kỳ ai đăng nhập. Đây là
//   loại lỗi mà code review dễ bỏ qua nhất vì nó là sự VẮNG MẶT, không phải sự
//   hiện diện.
//
// VÌ SAO DÙNG AST, KHÔNG DÙNG REGEX
//   Ba test hiện có (openclawNavigation, businessPerformanceNavigation) khẳng
//   định bằng regex trên VĂN BẢN NGUỒN của App.tsx. Chúng vỡ ngay khi ai đó
//   xuống dòng khác đi, và chúng chặn việc tách App.tsx — thứ chính plan đang
//   muốn làm.
//   Tôi đã thử bản quét ký tự trước khi viết cái này: nó đếm `/>` của JSX lồng
//   bên trong (ví dụ `element={<Page />}`) là đóng thẻ Route, nên gộp nesting
//   sai và báo 63 route "không guard" trong đó phần lớn là báo động giả. JSX
//   không parse được bằng cách đếm ký tự — phải dùng parser thật.
//
//   node scripts/check-route-guards.mjs
//   node scripts/check-route-guards.mjs --list   # in bảng route → guard
//
// Không cần credential, không đọc database.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(repoRoot, "src", "App.tsx");

// Component được coi là cổng chặn. Thêm guard mới thì thêm vào đây — cố ý bắt
// phải khai, để một "guard" tự chế không vô tình được tính là đã bảo vệ.
export const GUARDS = new Set([
  "ProtectedRoute", // cổng ĐĂNG NHẬP — bọc ngoài cùng ở hầu hết route
  "RequirePermission", // cổng QUYỀN theo module/action
  "RequireAuth",
  "OpenClawRouteGuard",
  "ProfitDistributionRouteGuard",
]);

// Route CÔNG KHAI có chủ đích — không cần đăng nhập. Mỗi mục phải có lý do, vì
// danh sách này chính là bề mặt tấn công của ứng dụng.
export const PUBLIC_ROUTES = new Map([
  ["/login", "màn đăng nhập"],
  ["/register", "đăng ký tài khoản"],
  ["/forgot-password", "quên mật khẩu"],
  ["/reset-password", "đặt lại mật khẩu qua link email"],
  ["/auth/callback", "OAuth callback"],
  ["/c/:code", "link hoá đơn hợp đồng công khai gửi khách"],
  ["/r/:token", "trang Phòng trống công khai (token)"],
  ["/phongtrong", "alias thương hiệu của /r/:token"],
  ["/quayso", "sự kiện quay số cho sale, không đăng nhập"],
  ["/quayso/:slug", "sự kiện quay số theo slug"],
  ["/quayso/:slug/quay", "màn quay của sự kiện"],
  ["*", "trang 404"],
]);

function jsxName(node) {
  const tag = ts.isJsxElement(node)
    ? node.openingElement.tagName
    : ts.isJsxSelfClosingElement(node)
      ? node.tagName
      : null;
  return tag ? tag.getText() : null;
}

function attrValue(node, name) {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  for (const a of opening.attributes.properties) {
    if (!ts.isJsxAttribute(a) || a.name.getText() !== name) continue;
    const init = a.initializer;
    if (init && ts.isStringLiteral(init)) return init.text;
    return null;
  }
  return undefined;
}

/** true khi element của route CHỈ là <Navigate …/> — tức route chuyển hướng. */
function chiLaNavigate(node, tenRedirect = new Set()) {
  const tags = [];
  const walk = (n) => {
    const name = jsxName(n);
    if (name) tags.push(name);
    n.forEachChild(walk);
  };
  walk(node);
  return tags.length > 0 && tags.every((t) => t === "Navigate" || tenRedirect.has(t));
}

/**
 * Tên các component KHAI TRONG CHÍNH FILE NÀY mà thân hàm chỉ render <Navigate>.
 *
 * Ví dụ có thật: `TenantToCustomerRedirect` đọc `useParams()` rồi trả
 * `<Navigate to={'/customers/' + id} />`. Nó là redirect, nhưng vì được bọc
 * trong một component có tên nên kiểm tra "element chỉ là <Navigate>" không thấy
 * — và nó trở thành route DUY NHẤT bị báo thiếu guard. Tự nhận diện từ AST tốt
 * hơn bắt khai tay: khai tay thì danh sách sẽ lỗi thời, còn đây thì không.
 */
function componentChiRedirect(sf) {
  const ten = new Set();
  const check = (name, body) => {
    if (!body) return;
    const tags = [];
    const walk = (n) => {
      const t = jsxName(n);
      if (t) tags.push(t);
      n.forEachChild(walk);
    };
    walk(body);
    if (tags.length > 0 && tags.every((t) => t === "Navigate")) ten.add(name);
  };
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name) check(n.name.getText(), n.body);
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          check(d.name.getText(), d.initializer.body);
        }
      }
    }
  });
  return ten;
}

/** Mọi guard xuất hiện ở BẤT KỲ đâu trong cây con của node. */
function guardsInSubtree(node) {
  const out = [];
  const walk = (n) => {
    const name = jsxName(n);
    if (name && GUARDS.has(name)) out.push(name);
    n.forEachChild(walk);
  };
  walk(node);
  return out;
}

/**
 * Duyệt cây JSX và ghi lại guard của từng <Route>.
 *
 * Guard có thể ở HAI vị trí và phải tính CẢ HAI:
 *   1. Trong `element={…}` của chính route đó — đây là dạng phổ biến nhất ở repo
 *      này: `<Route path="/x" element={<ProtectedRoute><RequirePermission …>…}/>`.
 *      Tức guard là CON của Route, không phải tổ tiên.
 *   2. Ở TỔ TIÊN, khi một layout route bọc cả nhóm con.
 *
 * Bản đầu tôi chỉ xét tổ tiên và báo 135/150 route "không guard" — báo động giả
 * gần như toàn bộ, vì repo dùng dạng (1). Một gate an ninh báo sai kiểu đó sẽ bị
 * tắt đi trong vòng một ngày, nên nó nguy hiểm hơn là không có gate.
 */
export function collectRoutes(sourceText) {
  const sf = ts.createSourceFile("App.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const tenRedirect = componentChiRedirect(sf);
  const found = [];

  const walk = (node, ancestorGuards) => {
    let nextGuards = ancestorGuards;
    const name = jsxName(node);
    if (name) {
      if (GUARDS.has(name)) nextGuards = [...ancestorGuards, name];
      if (name === "Route") {
        const path = attrValue(node, "path");
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const elementAttr = opening.attributes.properties.find(
          (a) => ts.isJsxAttribute(a) && a.name.getText() === "element",
        );
        const own = elementAttr ? guardsInSubtree(elementAttr) : [];
        // Route CHUYỂN HƯỚNG: element chỉ là <Navigate to="…" />. Không cần guard
        // vì nó không render gì — quyền được kiểm ở route ĐÍCH. Bắt nó phải có
        // guard sẽ tạo ra 33 báo động giả và dạy người ta bọc guard thừa.
        const laRedirect = elementAttr ? chiLaNavigate(elementAttr, tenRedirect) : false;
        found.push({
          path: path === undefined ? "(index)" : (path ?? "(dynamic)"),
          guards: [...ancestorGuards, ...own],
          redirect: laRedirect,
        });
        // Guard trong `element` của một LAYOUT route bảo vệ cả các route con lồng
        // bên trong nó, nên phải truyền xuống. Không truyền thì route con của một
        // layout đã có guard sẽ bị báo hở — báo động giả, và người ta sẽ bọc thêm
        // guard thừa cho yên gate.
        nextGuards = [...nextGuards, ...own];
      }
    }
    node.forEachChild((c) => walk(c, nextGuards));
  };
  walk(sf, []);
  return found;
}

function main(argv) {
  const routes = collectRoutes(readFileSync(APP, "utf8"));

  if (argv.includes("--list")) {
    for (const r of routes) {
      console.log(`${(r.guards[r.guards.length - 1] ?? "—").padEnd(28)} ${r.path}`);
    }
  }

  const hoTrong = routes.filter(
    (r) => r.guards.length === 0 && !r.redirect && !PUBLIC_ROUTES.has(r.path) && r.path !== "(index)",
  );

  if (hoTrong.length > 0) {
    console.error(`❌ ${hoTrong.length} route KHÔNG có guard và cũng không khai là công khai:\n`);
    for (const r of hoTrong) console.error(`  - ${r.path}`);
    console.error("\n  Mỗi route ở đây hoặc phải bọc trong một guard (RequirePermission…),");
    console.error("  hoặc phải thêm vào PUBLIC_ROUTES trong scripts/check-route-guards.mjs KÈM LÝ DO.");
    console.error("  Danh sách công khai chính là bề mặt tấn công — bắt khai để nó luôn đọc được.");
    process.exitCode = 1;
    return;
  }

  // Chiều ngược lại: route khai công khai nhưng thực ra đã có guard ⇒ danh sách
  // lỗi thời, và một danh sách bề-mặt-tấn-công lỗi thời thì tệ hơn không có.
  const thuaTrongDanhSach = routes.filter((r) => PUBLIC_ROUTES.has(r.path) && r.guards.length > 0);
  if (thuaTrongDanhSach.length > 0) {
    console.error(`❌ ${thuaTrongDanhSach.length} route khai là CÔNG KHAI nhưng thực tế đã có guard:\n`);
    for (const r of thuaTrongDanhSach) console.error(`  - ${r.path}  (guard: ${r.guards.join(" > ")})`);
    console.error("\n  → gỡ khỏi PUBLIC_ROUTES. Để lại thì danh sách bề mặt tấn công nói sai sự thật.");
    process.exitCode = 1;
    return;
  }

  const coGuard = routes.filter((r) => r.guards.length > 0).length;
  const congKhai = routes.filter((r) => r.guards.length === 0 && PUBLIC_ROUTES.has(r.path)).length;
  const redirect = routes.filter((r) => r.guards.length === 0 && r.redirect).length;
  console.log(
    `✅ ${routes.length} route: ${coGuard} có guard · ${congKhai} khai công khai có lý do · ` +
      `${redirect} redirect · ${routes.length - coGuard - congKhai - redirect} route index.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
