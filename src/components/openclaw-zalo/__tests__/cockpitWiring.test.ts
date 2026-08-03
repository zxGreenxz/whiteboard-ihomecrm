import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The cockpit must actually RENDER what Task 23 built.
 *
 * Task 22 shipped `Breadcrumbs.tsx` that nothing rendered, and the review only
 * caught it by reading the tree by hand. A component with passing unit tests that
 * no screen mounts is still dead code, and its tests prove nothing about the
 * product. These assertions are on the wiring, which is the part unit tests of the
 * presentational components cannot see.
 */
const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/gu, "\n");

const cockpit = source("src/components/openclaw-zalo/OpenClawCockpit.tsx");

describe("cockpit wiring", () => {
  it("mounts the inbox for the inbox section", () => {
    expect(cockpit).toContain('from "./inbox/OpenClawInboxSection"');
    expect(cockpit).toMatch(/activeSection === "inbox"[\s\S]{0,80}<OpenClawInboxSection/u);
  });

  it("mounts the connection dialog and can open it", () => {
    expect(cockpit).toContain('from "./dialogs/OpenClawConnectionSection"');
    expect(cockpit).toContain("<OpenClawConnectionSection");
    // An open state that nothing can set is the same dead end as an unmounted
    // component, so the trigger is pinned too.
    expect(cockpit).toContain("setConnectionOpen(true)");
  });

  it("offers the reconnect trigger only to a member who may manage connections", () => {
    expect(cockpit).toMatch(
      /can\("manage_connections"\)\s*\?\s*\(\)\s*=>\s*setConnectionOpen\(true\)/u,
    );
  });

  it("reaches every component Task 23 added from a screen the router renders", () => {
    // Walks the import graph from the page down, rather than trusting each file to
    // be reachable because it exists.
    // The guard wraps the route in App.tsx, and the page picks a viewport variant;
    // both variants must reach the same cockpit or a component is invisible to half
    // the users.
    const app = source("src/App.tsx");
    expect(app).toMatch(/<OpenClawRouteGuard>[\s\S]{0,200}<\/OpenClawRouteGuard>/u);
    const page = source("src/pages/openclaw-zalo/OpenClawZaloPage.tsx");
    expect(page).toContain("OpenClawZaloDesktopPage");
    expect(page).toContain("OpenClawZaloMobilePage");
    for (const variant of ["OpenClawZaloDesktopPage", "OpenClawZaloMobilePage"]) {
      expect(source(`src/pages/openclaw-zalo/${variant}.tsx`), variant)
        .toContain("OpenClawCockpit");
    }
    const inboxSection = source("src/components/openclaw-zalo/inbox/OpenClawInboxSection.tsx");
    expect(inboxSection).toContain('from "./OpenClawInbox"');
    const inbox = source("src/components/openclaw-zalo/inbox/OpenClawInbox.tsx");
    for (const child of ["./AiDraftPanel", "./ConversationList", "./ConversationThread"]) {
      expect(inbox, child).toContain(`from "${child}"`);
    }
    const connectionSection = source(
      "src/components/openclaw-zalo/dialogs/OpenClawConnectionSection.tsx",
    );
    expect(connectionSection).toContain('from "./OpenClawConnectionDialog"');
  });
});
