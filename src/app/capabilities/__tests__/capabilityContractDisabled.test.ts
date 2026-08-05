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
vi.mock("@/lib/openclaw-zalo/runtime", () => ({
  OPENCLAW_RUNTIME_ENABLED: false,
  OPENCLAW_RUNTIME_MODE: "off",
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

describe("capability registry ↔ bề mặt thật (cờ TẮT)", () => {
  it("mock có hiệu lực — mọi capability đều đang tắt", () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    expect(CAPABILITIES.every((c) => !c.release.enabled)).toBe(true);
  });

  it.each(CAPABILITIES.map((c) => [c.id, c.primaryRoute] as const))(
    "%s: KHÔNG còn mục sidebar nào trỏ tới %s",
    (_id, route) => {
      expect(navItems.some((i) => i.href === route)).toBe(false);
    },
  );

  it.each(CAPABILITIES.map((c) => [c.id, c.primaryRoute] as const))(
    "%s: KHÔNG còn tile launcher nào trỏ tới %s",
    (_id, route) => {
      expect(tiles.some((t) => t.href === route)).toBe(false);
    },
  );
});
