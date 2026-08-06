import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CRLF-normalised: see openclawInboxMigration.test.ts. A checkout with CRLF makes
// any assertion spanning a line boundary fail on Windows for identical source.
const readSource = (relativePath: string) =>
  readFileSync(relativePath, "utf8").replace(/\r\n/gu, "\n");

describe("OpenClaw Zalo navigation contract", () => {
  // Khẳng định về GUARD nay đọc CẤU TRÚC (AST) chứ không so regex trên văn bản
  // nguồn. Bản cũ dùng `toMatch(/<Route\s+path="\/openclaw-zalo"[\s\S]*?…/)` —
  // nó vỡ ngay khi ai đó xuống dòng khác đi, và nó là một trong ba test đang
  // chặn việc tách App.tsx. Cùng một điều được kiểm, nhưng nay kiểm đúng thứ
  // mình quan tâm: route này được bọc bởi guard nào.
  it("route /openclaw-zalo dùng guard RIÊNG, không dùng RequirePermission", async () => {
    const { collectAllRoutes } = await import("../../../scripts/check-route-guards.mjs");
    const routes = collectAllRoutes();
    const route = routes.find((r: { path: string }) => r.path === "/openclaw-zalo");

    expect(route, "route /openclaw-zalo phải tồn tại").toBeDefined();
    expect(route!.guards).toContain("OpenClawRouteGuard");
    // Điểm cốt lõi: OpenClaw tự quyết quyền theo runtime flag + trạng thái kết
    // nối, nên KHÔNG được đi qua RequirePermission — nếu không, người có quyền
    // module sẽ vào được cả khi runtime tắt.
    expect(route!.guards).not.toContain("RequirePermission");
  });

  it("nạp lazy để không kéo OpenClaw vào bundle chính", () => {
    // Khai báo lazy đã tách khỏi App.tsx sang src/app/lazyPages.ts (Đợt 4).
    // Chỉ kiểm phần KHÔNG phụ thuộc định dạng: định danh được gán bằng lazy(...)
    // trỏ đúng module. Không khoá dấu cách hay xuống dòng.
    const lazyPages = readSource("src/app/lazyPages.ts");
    expect(lazyPages).toMatch(/OpenClawZaloPage\s*=\s*lazy\(/);
    expect(lazyPages).toMatch(/pages\/openclaw-zalo\/OpenClawZaloPage/);
    expect(lazyPages).toMatch(/OpenClawRouteGuard\s*=\s*lazy\(/);
    expect(lazyPages).toMatch(/components\/openclaw-zalo\/OpenClawRouteGuard/);
  });

  it("publishes no launcher tile while the runtime flag is off", async () => {
    // The flag defaults off, which is the state a production build ships in until
    // the rollout gates pass. A tile that outlived its route would render for every
    // owner - they hold the permission - and land them on the 404 page.
    const { LAUNCHER_SECTIONS } = await import("@/pages/home/launcherTiles");
    const { OPENCLAW_RUNTIME_ENABLED } = await import("@/lib/openclaw-zalo/runtime");
    expect(OPENCLAW_RUNTIME_ENABLED, "the flag must default off").toBe(false);
    const tiles = LAUNCHER_SECTIONS.flatMap((section) => section.items);
    expect(tiles.filter((entry) => entry.href === "/openclaw-zalo")).toHaveLength(0);
  });

  it("gates the launcher tile on the same module and action as the route", () => {
    // Source-asserted because the exported data cannot carry the tile while the flag
    // is off. It still pins the ENTRY as a whole rather than two substrings that
    // could come from different lines: the tile must demand exactly what the route
    // guard demands, or a user is shown an entry that bounces them home.
    const tiles = readSource("src/pages/home/launcherTiles.ts");
    const entries = tiles.match(/\{[^{}]*href: '\/openclaw-zalo'[^{}]*\}/gu) ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("module: 'openclaw_zalo'");
    expect(entries[0]).toContain("action: 'view'");
    // And it must sit inside the flag, not beside it.
    expect(tiles).toMatch(/OPENCLAW_RUNTIME_ENABLED[\s\S]{0,200}href: '\/openclaw-zalo'/u);
  });

  it("publishes exactly one desktop sidebar entry, and gates it on the flag", () => {
    // Sidebar builds its list inline, so this stays a source assertion - but it pins
    // the ENTRY as a whole instead of two substrings that could come from different
    // lines and still look like a match.
    const sidebar = readSource("src/components/layout/Sidebar.tsx");
    const entries = sidebar.match(/\{[^{}]*href: '\/openclaw-zalo'[^{}]*\}/gu) ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("module: 'openclaw_zalo'");
    // All three surfaces - route, launcher tile, sidebar - move together. A sidebar
    // entry that outlives the route is the one an owner actually clicks, because
    // they hold the permission and the desktop nav is always on screen.
    expect(sidebar).toMatch(/OPENCLAW_RUNTIME_ENABLED[\s\S]{0,300}href: '\/openclaw-zalo'/u);
  });

  it("records the breadcrumb label, and states plainly that nothing renders it yet", () => {
    const breadcrumbs = readSource("src/components/layout/Breadcrumbs.tsx");
    expect(breadcrumbs).toContain("'/openclaw-zalo': 'OpenClaw Zalo'");
    // KNOWN GAP, app-wide and pre-existing: Breadcrumbs is imported by no component
    // (MainLayout dropped its breadcrumb slot), so this label cannot render for ANY
    // feature, not only OpenClaw. Asserting that keeps the gap visible instead of
    // letting the label above read as a satisfied requirement. Delete this assertion
    // the day something mounts Breadcrumbs again.
    const mounted = ["src/components/layout/MainLayout.tsx", "src/App.tsx"]
      .map(readSource)
      .join("\n");
    expect(mounted).not.toContain("Breadcrumbs");
  });

  it("keeps the new product isolated from the legacy chat route", () => {
    const files = [
      "src/pages/openclaw-zalo/OpenClawZaloPage.tsx",
      "src/pages/openclaw-zalo/OpenClawZaloDesktopPage.tsx",
      "src/pages/openclaw-zalo/OpenClawZaloMobilePage.tsx",
      "src/components/openclaw-zalo/OpenClawCockpit.tsx",
      "src/components/openclaw-zalo/OpenClawRouteGuard.tsx",
    ];

    for (const file of files) {
      const source = readSource(file);
      expect(source).not.toContain("/chat-zalo");
      expect(source).not.toContain("ChatZaloPage");
      expect(source).not.toContain("useZaloChat");
    }
  });

  it("uses organization-aware authorization before rendering the page", () => {
    const guard = readSource("src/components/openclaw-zalo/OpenClawRouteGuard.tsx");

    expect(guard).toContain("useOpenClawOrganization");
    expect(guard).toContain("useOpenClawBootstrap");
    expect(guard).toContain('get_authorization_context_v1');
    expect(guard).toContain('"openclaw_zalo.view"');
    expect(guard).toContain('<Navigate to="/" replace />');
    expect(guard).not.toContain("RequirePermission");
  });

  it("uses full-bleed desktop and a standalone phone shell", () => {
    const page = readSource("src/pages/openclaw-zalo/OpenClawZaloPage.tsx");
    const desktop = readSource("src/pages/openclaw-zalo/OpenClawZaloDesktopPage.tsx");
    const mobile = readSource("src/pages/openclaw-zalo/OpenClawZaloMobilePage.tsx");

    expect(page).toContain("usePhoneViewport()");
    expect(desktop).toContain("<MainLayout fullBleed>");
    expect(mobile).not.toContain("MainLayout");
    expect(mobile).toContain("overflow-x-hidden");
  });
});
