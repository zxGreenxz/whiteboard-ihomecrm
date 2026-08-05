// Contract test cho bề mặt sản phẩm ở mức trang.
//
// Thay cách kiểm cũ: các test điều hướng hiện có đọc MÃ NGUỒN App.tsx /
// Sidebar.tsx / launcherTiles.ts rồi regex tìm chuỗi. Cách đó vừa vỡ khi ai đó
// đổi format, vừa có thể tự khớp vào chính comment nói về route — nó kiểm "chuỗi
// này có xuất hiện không", chứ không kiểm "cấu hình có nhất quán không".
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
