// Acceptance §7: nav item và launcher tile KHÔNG thể trỏ route không tồn tại.
//
// VÌ SAO ĐÁNG CÓ TEST RIÊNG
//   Một `href` gãy không làm hỏng build, không làm đỏ typecheck, và không ai thấy
//   cho tới khi người dùng bấm vào rồi nhận trang trắng. Route và nav được khai ở
//   hai chỗ khác nhau (`src/app/routes/*` và `Sidebar.tsx` / `launcherTiles.ts`),
//   nên xoá hoặc đổi tên một route là việc hoàn toàn im lặng đối với nav.
//
// VÌ SAO DÙNG collectAllRoutes() CHỨ KHÔNG ĐỌC src/App.tsx
//   Chính hàm đó đã ghi lý do: test đọc App.tsx sẽ đỏ mỗi lần tách một nhóm route
//   sang file mới dù hành vi không đổi — đã xảy ra thật khi tách financeReportRoutes.
//   Dùng collectAllRoutes thì test bám theo ROUTE, không bám theo FILE. Nó cũng là
//   đúng nguồn mà `gate:route-guards` dùng, nên hai phép kiểm không thể lệch nhau.
import { describe, expect, it } from "vitest";

import { collectAllRoutes } from "../../../../scripts/check-route-guards.mjs";
import { navigationGroups } from "../../../components/layout/Sidebar";
import { LAUNCHER_SECTIONS } from "../../../pages/home/launcherTiles";

/**
 * Sàn chống-xanh-rỗng.
 *
 * Nếu ai đó đổi hình dạng `navigationGroups` hoặc `LAUNCHER_SECTIONS` (đổi tên
 * trường `href`, gói thêm một lớp), vòng lặp dưới sẽ gom được 0 href và mọi
 * `expect` bên trong không chạy lần nào — test XANH mà chẳng kiểm gì. Hai sàn này
 * biến trường hợp đó thành đỏ.
 */
const TOI_THIEU_NAV = 20;
const TOI_THIEU_LAUNCHER = 20;

/**
 * Sidebar khai nav HAI TẦNG: item lá có `href`, item cha có `items` và KHÔNG có
 * href. Bản đầu của hàm này chỉ lấy tầng đầu và gom được 6/24 href — sàn
 * TOI_THIEU_NAV bên dưới bắt được, nếu không thì test đã "xanh" trong khi bỏ qua
 * 3/4 số mục. Đây đúng hình dạng điểm mù hay gặp nhất: bộ lọc chỉ phủ MỘT biến thể.
 */
function hrefsCuaNav(): string[] {
  const ra: string[] = [];
  const di = (ds: Array<{ href?: string; items?: Array<{ href?: string }> }>) => {
    for (const i of ds) {
      if (i.href) ra.push(i.href);
      if (Array.isArray(i.items)) di(i.items);
    }
  };
  di(navigationGroups.flatMap((g) => g.items) as never);
  return ra;
}

function hrefsCuaLauncher(): string[] {
  return LAUNCHER_SECTIONS.flatMap((s) => s.items.map((i) => i.href)).filter(Boolean);
}

/**
 * Một href khớp một route khi trùng khít, hoặc khi route có tham số/splat mà href
 * lấp được. Nav thường trỏ đường tĩnh, nhưng luật phải đúng cả khi ai đó thêm một
 * mục trỏ vào route có param.
 */
export function laBatTat(p: string): boolean {
  return p === "*" || p === "/*";
}

function khopRoute(href: string, duongRoute: string[]): boolean {
  if (duongRoute.includes(href)) return true;
  // LOẠI route bắt-tất TRẦN (`*` — trang 404) khỏi phép so khớp.
  //
  // Bản đầu của hàm này không loại, nên `*` biến thành regex `^.*$` và KHỚP MỌI
  // href — test xanh với cả một href bịa ra. Đột biến bắt được: đổi
  // `/building-map` thành `/route-khong-he-ton-tai` mà suite vẫn xanh, và
  // scripts/dot-bien.mjs gọi thẳng tên nó là "GATE MÙ".
  //
  // Đây chính là điều một route 404 làm trong React Router: nó nhận MỌI đường
  // chưa khai. Nếu tính nó là "route tồn tại" thì câu hỏi "href này có route
  // không" luôn có câu trả lời "có", và phép kiểm mất sạch ý nghĩa.
  //
  // `/network-center/*` thì KHÔNG loại: splat có tiền tố thật, và một href
  // `/network-center/devices` khớp nó là khớp đúng.
  return duongRoute.filter((p) => !laBatTat(p)).some((p) => {
    if (!p.includes(":") && !p.includes("*")) return false;
    const re = new RegExp(
      "^" +
        p
          .split("/")
          .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg === "*" ? ".*" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
          .join("/") +
        "$",
    );
    return re.test(href);
  });
}

describe("nav và launcher không trỏ route không tồn tại", () => {
  const routes = collectAllRoutes() as Array<{ path: string }>;
  const duongRoute = routes.map((r) => r.path);

  it("collectAllRoutes trả về đủ route — nếu không thì mọi phép so dưới là vô nghĩa", () => {
    // gate:route-guards đặt sàn 100; giữ cùng bậc để hai bên không lệch.
    expect(duongRoute.length).toBeGreaterThanOrEqual(100);
  });

  it("bóc được đủ href từ navigationGroups", () => {
    expect(hrefsCuaNav().length).toBeGreaterThanOrEqual(TOI_THIEU_NAV);
  });

  it("bóc được đủ href từ LAUNCHER_SECTIONS", () => {
    expect(hrefsCuaLauncher().length).toBeGreaterThanOrEqual(TOI_THIEU_LAUNCHER);
  });

  it("MỌI href trong sidebar đều có route thật", () => {
    const gay = hrefsCuaNav().filter((h) => !khopRoute(h, duongRoute));
    expect(gay, `href trong Sidebar.tsx không có route: ${gay.join(", ")}`).toEqual([]);
  });

  it("MỌI href trong launcher đều có route thật", () => {
    const gay = hrefsCuaLauncher().filter((h) => !khopRoute(h, duongRoute));
    expect(gay, `href trong launcherTiles.ts không có route: ${gay.join(", ")}`).toEqual([]);
  });
});

describe("khopRoute — luật so khớp", () => {
  it("trùng khít thì khớp", () => {
    expect(khopRoute("/my-day", ["/my-day"])).toBe(true);
  });

  it("không có trong danh sách thì KHÔNG khớp", () => {
    expect(khopRoute("/khong-ton-tai", ["/my-day", "/dashboard"])).toBe(false);
  });

  it("route có param lấp được thì khớp", () => {
    expect(khopRoute("/contracts/abc123", ["/contracts/:id"])).toBe(true);
  });

  it("param KHÔNG nuốt dấu gạch chéo — /a/b/c không khớp /a/:id", () => {
    expect(khopRoute("/a/b/c", ["/a/:id"])).toBe(false);
  });

  it("splat khớp phần đuôi", () => {
    expect(khopRoute("/reports/finance/analysis", ["/reports/*"])).toBe(true);
  });
});

describe("route bắt-tất không được tính là 'route tồn tại'", () => {
  it("`*` bị loại — nếu không thì mọi href đều khớp và phép kiểm vô nghĩa", () => {
    expect(laBatTat("*")).toBe(true);
    expect(laBatTat("/*")).toBe(true);
  });

  it("splat CÓ tiền tố thật thì KHÔNG bị loại", () => {
    expect(laBatTat("/network-center/*")).toBe(false);
  });

  it("href bịa KHÔNG khớp dù danh sách có route bắt-tất", () => {
    expect(khopRoute("/duong-bia-ra", ["*", "/my-day"])).toBe(false);
  });

  it("nhưng vẫn khớp splat có tiền tố", () => {
    expect(khopRoute("/network-center/devices", ["*", "/network-center/*"])).toBe(true);
  });
});
