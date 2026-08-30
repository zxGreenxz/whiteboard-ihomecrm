// Nửa còn lại của contract: khi cờ TẮT, capability phải biến mất khỏi MỌI bề mặt.
//
// Tách file riêng vì cờ được đọc lúc module nạp, nên hai trạng thái không cùng
// tồn tại trong một module graph.
//
// Đây là hướng drift đã xảy ra thật: route bị gác sau cờ, nhưng tile ở launcher
// và mục ở sidebar vẫn còn. Người dùng có quyền nên vẫn thấy lối vào, bấm vào
// thì rơi ra 404 — lỗi chỉ lộ ra với đúng những người có quyền cao nhất.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/network-center/runtime", () => ({
  NETWORK_CENTER_RUNTIME_ENABLED: false,
  NETWORK_CENTER_RUNTIME_MODE: "off",
}));

const { CAPABILITIES } = await import("../registry");
const { navigationGroups } = await import("@/components/layout/Sidebar");
const { LAUNCHER_SECTIONS } = await import("@/pages/home/launcherTiles");

type FlatNavItem = { href?: string };

const navItems: FlatNavItem[] = navigationGroups.flatMap((group) =>
  group.items.flatMap((item) =>
    "items" in item && Array.isArray(item.items) ? (item.items as FlatNavItem[]) : [item as FlatNavItem],
  ),
);
const tiles = LAUNCHER_SECTIONS.flatMap((s) => s.items);

/**
 * HAI LOẠI CAPABILITY, và bản đầu của file này chỉ biết một loại.
 *
 * Lúc viết, cả hai capability trong registry đều nằm sau một cờ runtime, nên
 * "tắt cờ ⇒ mọi capability biến mất" là câu đúng. Từ 12/08/2026 registry có thêm
 * bề mặt LUÔN BẬT (`runtimeModule: null`) — hoá đơn, thu chi, sổ quỹ, bảng lương.
 * Chúng không có cờ nào để tắt, nên đòi chúng biến mất là đòi sai.
 *
 * Vì vậy tách hai tập và kiểm HAI CHIỀU. Chỉ thu hẹp về tập có cờ thì test sẽ im
 * lặng bỏ qua nhóm luôn-bật; chiều thứ hai giữ nhóm đó vẫn được canh — nếu ai đó
 * lỡ tay gỡ chúng khỏi sidebar/launcher, ca dưới sẽ đỏ.
 */
const coCo = CAPABILITIES.filter((c) => c.release.runtimeModule !== null);
const luonBat = CAPABILITIES.filter((c) => c.release.runtimeModule === null);

describe("capability registry ↔ bề mặt thật (cờ TẮT)", () => {
  it("chống-xanh-rỗng: registry có CẢ HAI loại để phép kiểm dưới đây có nghĩa", () => {
    // Không còn capability nào có cờ ⇒ toàn bộ nhóm ca đầu chạy 0 lần và file này
    // thành trang trí. Không còn capability luôn-bật ⇒ nhóm ca sau cũng vậy.
    expect(coCo.length).toBeGreaterThanOrEqual(1);
    expect(luonBat.length).toBeGreaterThanOrEqual(1);
  });

  it("mock có hiệu lực — mọi capability CÓ CỜ đều đang tắt", () => {
    expect(coCo.every((c) => !c.release.enabled)).toBe(true);
  });

  it("capability LUÔN BẬT không bị mock làm tắt lây", () => {
    // Nếu ca này đỏ thì `truong()` trong surfaceAdapters đang lọc nhầm, và các ca
    // "vẫn còn mục" bên dưới sẽ xanh vì lý do sai.
    expect(luonBat.every((c) => c.release.enabled)).toBe(true);
  });

  it.each(coCo.map((c) => [c.id, c.primaryRoute] as const))(
    "%s (có cờ): KHÔNG còn mục sidebar nào trỏ tới %s",
    (_id, route) => {
      expect(navItems.some((i) => i.href === route)).toBe(false);
    },
  );

  it.each(coCo.map((c) => [c.id, c.primaryRoute] as const))(
    "%s (có cờ): KHÔNG còn tile launcher nào trỏ tới %s",
    (_id, route) => {
      expect(tiles.some((t) => t.href === route)).toBe(false);
    },
  );

  // Chỉ đòi bề mặt nào capability KHAI là có. Bản đầu của hai ca này đòi cả nav
  // lẫn tile cho mọi capability luôn-bật — đúng lúc viết (cả bốn đều có đủ hai),
  // sai ngay khi có bề mặt chỉ nằm ở sidebar.
  it.each(luonBat.filter((c) => c.surfaces.desktopNav).map((c) => [c.id, c.primaryRoute] as const))(
    "%s (luôn bật): VẪN còn mục sidebar trỏ tới %s",
    (_id, route) => {
      expect(navItems.some((i) => i.href === route)).toBe(true);
    },
  );

  it.each(luonBat.filter((c) => c.surfaces.mobileLauncher).map((c) => [c.id, c.primaryRoute] as const))(
    "%s (luôn bật): VẪN còn tile launcher trỏ tới %s",
    (_id, route) => {
      expect(tiles.some((t) => t.href === route)).toBe(true);
    },
  );
});
