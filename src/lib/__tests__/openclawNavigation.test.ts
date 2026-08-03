import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CRLF-normalised: see openclawInboxMigration.test.ts. A checkout with CRLF makes
// any assertion spanning a line boundary fail on Windows for identical source.
const readSource = (relativePath: string) =>
  readFileSync(relativePath, "utf8").replace(/\r\n/gu, "\n");

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

  it("publishes a mobile launcher tile gated on the same module and action", async () => {
    // Asserted against the EXPORTED data, not source text. A grep for
    // "href: '/openclaw-zalo'" still passes when the entry is commented out, moved
    // into dead code, or gated on the wrong module.
    const { LAUNCHER_SECTIONS } = await import("@/pages/home/launcherTiles");
    const tiles = LAUNCHER_SECTIONS.flatMap((section) => section.items);
    const matching = tiles.filter((entry) => entry.href === "/openclaw-zalo");
    expect(matching, "no launcher tile targets /openclaw-zalo").toHaveLength(1);
    expect(matching[0]!.module).toBe("openclaw_zalo");
    // The tile must demand exactly what the route guard demands, otherwise the user
    // is shown an entry that bounces them straight back home.
    expect(matching[0]!.action).toBe("view");
  });

  it("publishes exactly one desktop sidebar entry for the route", () => {
    // Sidebar builds its list inline, so this stays a source assertion - but it pins
    // the ENTRY as a whole instead of two substrings that could come from different
    // lines and still look like a match.
    const sidebar = readSource("src/components/layout/Sidebar.tsx");
    const entries = sidebar.match(/\{[^{}]*href: '\/openclaw-zalo'[^{}]*\}/gu) ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("module: 'openclaw_zalo'");
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
