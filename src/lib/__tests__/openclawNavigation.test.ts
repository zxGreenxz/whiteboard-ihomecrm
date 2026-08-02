import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) => readFileSync(relativePath, "utf8");

describe("OpenClaw Zalo navigation contract", () => {
  it("lazy-loads an exact, independently guarded route", () => {
    const app = readSource("src/App.tsx");

    expect(app).toContain(
      'const OpenClawZaloPage = lazy(() => import("./pages/openclaw-zalo/OpenClawZaloPage"));',
    );
    expect(app).toContain(
      'const OpenClawRouteGuard = lazy(() => import("./components/openclaw-zalo/OpenClawRouteGuard"));',
    );
    expect(app).toMatch(/<Route\s+path="\/openclaw-zalo"[\s\S]*?<OpenClawRouteGuard>[\s\S]*?<OpenClawZaloPage\s*\/>[\s\S]*?<\/OpenClawRouteGuard>/);
    expect(app).not.toMatch(/path="\/openclaw-zalo"[\s\S]{0,240}RequirePermission/);
  });

  it("publishes distinct desktop and mobile navigation entries", () => {
    const sidebar = readSource("src/components/layout/Sidebar.tsx");
    const breadcrumbs = readSource("src/components/layout/Breadcrumbs.tsx");
    const launcher = readSource("src/pages/home/launcherTiles.ts");

    expect(sidebar).toContain("href: '/openclaw-zalo'");
    expect(sidebar).toContain("module: 'openclaw_zalo'");
    expect(launcher).toContain("href: '/openclaw-zalo'");
    expect(launcher).toContain("module: 'openclaw_zalo'");
    expect(breadcrumbs).toContain("'/openclaw-zalo': 'OpenClaw Zalo'");
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
