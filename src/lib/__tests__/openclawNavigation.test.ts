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

  // VIẾT LẠI Ở ĐỢT 4 LÁT 3.
  //
  // Hai test dưới đây trước kia bắt cụm `{ … href: '/openclaw-zalo' … }` trong
  // VĂN BẢN NGUỒN của launcherTiles.ts và Sidebar.tsx, rồi đòi nó nằm gần chuỗi
  // OPENCLAW_RUNTIME_ENABLED. Từ lát 3, cả tile lẫn mục sidebar SINH TỪ capability
  // registry, nên cụm đó không còn tồn tại — hai test vỡ vì khẳng định một HÌNH
  // DẠNG đã biến mất, không phải vì một tính chất bị mất.
  //
  // Tính chất cần giữ vẫn nguyên: "cả ba bề mặt — route, tile, sidebar — phải đòi
  // đúng cùng một quyền và cùng bật/tắt". Nay nó được bảo đảm bằng CẤU TRÚC (một
  // nguồn khai duy nhất) thay vì bằng phép so. Nên chỗ còn lệch được đã dời đi,
  // và test phải dời theo:
  //   - registry có đòi ĐÚNG quyền mà OpenClawRouteGuard thật sự kiểm không —
  //     guard là mã viết tay, registry là dữ liệu, hai bên vẫn trôi khỏi nhau được;
  //   - có ai khai TAY lại route ở consumer không — bản khai thứ hai làm registry
  //     mất quyền sở hữu mà không gì đỏ.

  it("registry đòi đúng quyền mà OpenClawRouteGuard thật sự kiểm", async () => {
    const guard = readSource("src/components/openclaw-zalo/OpenClawRouteGuard.tsx");
    const registry = readSource("src/app/capabilities/registry.ts");
    const khoi = registry.split('id: "openclaw-zalo"')[1] ?? "";

    const module = khoi.match(/module:\s*"([^"]+)"/)?.[1];
    const action = khoi.match(/action:\s*"([^"]+)"/)?.[1];
    expect(module, "registry phải khai module cho openclaw-zalo").toBeDefined();

    // Guard kiểm chuỗi quyền dạng "<module>.<action>". Nếu ai đổi một bên, hai
    // bên lệch và người dùng thấy lối vào rồi bị đá về trang chủ.
    expect(guard).toContain(`"${module}.${action}"`);
  });

  it("không nơi nào khai TAY lại route capability — bề mặt phải sinh từ registry", async () => {
    const { timKhaiTay } = await import("../../../scripts/check-capability-surfaces.mjs");
    for (const f of ["src/pages/home/launcherTiles.ts", "src/components/layout/Sidebar.tsx"]) {
      expect(timKhaiTay(readSource(f), "/openclaw-zalo"), `${f} còn khai tay`).toBe(false);
    }
  });

  it("cờ TẮT thì adapter không sinh mục nào cho cả sidebar lẫn launcher", async () => {
    // Cờ mặc định TẮT (đã chốt ở test trên). Đây là trạng thái bản production
    // đang ship, nên nó là trạng thái đáng kiểm nhất: một mục sống lâu hơn route
    // của nó chính là mục người dùng bấm vào rồi rơi ra 404.
    const { navFieldsFor, launcherFieldsFor } = await import("@/app/capabilities/surfaceAdapters");
    expect(navFieldsFor("openclaw-zalo")).toHaveLength(0);
    expect(launcherFieldsFor("openclaw-zalo")).toHaveLength(0);
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
