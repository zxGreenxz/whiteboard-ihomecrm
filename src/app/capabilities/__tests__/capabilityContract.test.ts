// Contract test cho bề mặt sản phẩm ở mức trang.
//
// Thay cách kiểm cũ: các test điều hướng hiện có đọc MÃ NGUỒN App.tsx /
// Sidebar.tsx / launcherTiles.ts rồi regex tìm chuỗi. Cách đó vừa vỡ khi ai đó
// đổi format, vừa có thể tự khớp vào chính comment nói về route — nó kiểm "chuỗi
// này có xuất hiện không", chứ không kiểm "cấu hình có nhất quán không".
//
// ĐỌC KỸ TRƯỚC KHI TIN FILE NÀY — thay đổi từ Đợt 4 lát 3
//   Sidebar và launcher nay SINH nav/tile từ registry (navFieldsFor /
//   launcherFieldsFor). Nghĩa là các phép so title/href/module/action ở dưới đã
//   trở thành TỰ QUY CHIẾU: chúng so registry với thứ vừa được sinh ra từ chính
//   registry, nên xanh vĩnh viễn kể cả khi cả hai cùng sai. Giữ lại vì chúng vẫn
//   chốt hình dạng dữ liệu và vẫn bắt được lỗi ở tầng adapter (ví dụ quên map
//   `action`, hoặc trả tile khi cờ tắt).
//
//   Phép kiểm THẬT của lát 3 nằm ở scripts/check-capability-surfaces.mjs: nó đọc
//   MÃ NGUỒN và bắt (a) ai đó khai tay lại một capability route, (b) route JSX
//   viết tay lệch với registry, (c) trang permission picker biến mất. Ba thứ đó
//   vẫn lệch được; những gì ở dưới thì không.
//
//   Các phép so với ALL_PAGES (permission picker) BÊN DƯỚI thì KHÔNG tự quy
//   chiếu — permissionPages.ts vẫn khai tay hoàn toàn.
//
// QUAN TRỌNG: hai cờ runtime mặc định TẮT, nên nếu chỉ chạy ở trạng thái mặc
// định thì mọi phép so nav/tile sẽ không có gì để so và test xanh trong khi
// không kiểm gì — đúng lớp lỗi "suite chạy 0 test vẫn báo pass". Vì vậy file
// này ép cờ BẬT rồi mới nạp module, và có một test riêng cho trạng thái TẮT.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/network-center/runtime", () => ({
  NETWORK_CENTER_RUNTIME_ENABLED: true,
  NETWORK_CENTER_RUNTIME_MODE: "production",
}));
vi.mock("@/lib/openclaw-zalo/runtime", () => ({
  OPENCLAW_RUNTIME_ENABLED: true,
  OPENCLAW_RUNTIME_MODE: "production",
}));

const { CAPABILITIES } = await import("../registry");
const { navigationGroups } = await import("@/components/layout/Sidebar");
const { LAUNCHER_SECTIONS } = await import("@/pages/home/launcherTiles");
const { ALL_PAGES } = await import("@/lib/permissionPages");

type FlatNavItem = { title: string; href?: string; module?: string; action?: string };

function flattenNav(): FlatNavItem[] {
  const out: FlatNavItem[] = [];
  for (const group of navigationGroups) {
    for (const item of group.items) {
      if ("items" in item && Array.isArray(item.items)) {
        out.push(...(item.items as FlatNavItem[]));
      } else {
        out.push(item as FlatNavItem);
      }
    }
  }
  return out;
}

const navItems = flattenNav();
const tiles = LAUNCHER_SECTIONS.flatMap((s) => s.items);
const cases = CAPABILITIES.map((c) => [c.id, c] as const);

describe("capability registry ↔ bề mặt thật (cờ BẬT)", () => {
  it("có capability để kiểm và cờ thật sự đang bật", () => {
    // Chốt chặn cho chính file này: nếu mock hỏng, mọi test dưới sẽ không có gì
    // để so và vẫn xanh. Test này làm điều đó thành lỗi nhìn thấy được.
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    expect(CAPABILITIES.every((c) => c.release.enabled)).toBe(true);
  });

  it.each(cases)("%s: xuất hiện ở sidebar và launcher khi cờ bật", (_id, capability) => {
    const nav = navItems.find((i) => i.href === capability.primaryRoute);
    const tile = tiles.find((t) => t.href === capability.primaryRoute);

    expect(Boolean(nav), "mục sidebar").toBe(capability.surfaces.desktopNav);
    expect(Boolean(tile), "tile launcher").toBe(capability.surfaces.mobileLauncher);
  });

  it.each(cases)("%s: nav và launcher gác đúng CÙNG (module, action) như registry", (_id, capability) => {
    const nav = navItems.find((i) => i.href === capability.primaryRoute);
    const tile = tiles.find((t) => t.href === capability.primaryRoute);

    expect(nav, "không tìm thấy mục sidebar để so quyền").toBeDefined();
    expect(tile, "không tìm thấy tile để so quyền").toBeDefined();

    expect(nav?.module).toBe(capability.permission.module);
    expect(tile?.module).toBe(capability.permission.module);
    // Route dùng action 'view'; nav/tile để trống nghĩa là mặc định 'view'.
    expect(nav?.action ?? "view").toBe(capability.permission.action);
    expect(tile?.action ?? "view").toBe(capability.permission.action);
  });

  it.each(cases)("%s: id tile khớp id capability", (_id, capability) => {
    const tile = tiles.find((t) => t.href === capability.primaryRoute);
    expect(tile?.id).toBe(capability.id);
  });

  it.each(cases)("%s: có trang trong permission picker, và action gác route tồn tại ở đó", (_id, capability) => {
    const page = ALL_PAGES.find((p) => p.route === capability.surfaces.permissionPage);
    expect(page, `thiếu trang quyền cho ${capability.primaryRoute}`).toBeDefined();
    expect(page?.key).toBe(capability.permission.module);

    const actions = page?.features.map((f) => f.action) ?? [];
    expect(actions).toContain(capability.permission.action);
  });

  it.each(cases)("%s: trang quyền của capability xuất hiện ĐÚNG MỘT LẦN trong picker", (_id, capability) => {
    // Ánh xạ nhiều-nhiều trong permissionPages là HỢP LỆ và không bị cấm ở đây:
    // đo 11/08/2026 thấy route `/` phục vụ hai module (core + ai-copilot), và key
    // `customers` phục vụ cả /leads lẫn /customers. Đó là thiết kế, không phải lỗi.
    //
    // Nhưng với trang quyền mà một CAPABILITY trỏ tới thì hai entry là mơ hồ: giao
    // diện phân quyền hiện hai dòng cho cùng một bề mặt, và không ai biết cấp dòng
    // nào thì mở được trang. Đây cũng chính là cái bẫy §7 mô tả cho alias.
    const trung = ALL_PAGES.filter((p) => p.route === capability.surfaces.permissionPage);
    expect(trung.length, `${capability.surfaces.permissionPage} có ${trung.length} entry`).toBe(1);
  });

  it("không capability nào trùng route hoặc trùng id", () => {
    const routes = CAPABILITIES.map((c) => c.primaryRoute);
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(routes).size).toBe(routes.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("mỗi capability trỏ tới một trang tài liệu hệ thống", () => {
    for (const capability of CAPABILITIES) {
      expect(capability.docs.systemDoc).toMatch(/^docs\/he-thong\/\d+-[a-z0-9-]+\.md$/);
    }
  });
});
