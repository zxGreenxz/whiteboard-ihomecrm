import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanOpenClawFiles } from "../../../scripts/check-openclaw-isolation.mjs";

const fixtureRoots: string[] = [];

function makeFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-isolation-"));
  fixtureRoots.push(root);

  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(root, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, source, "utf8");
  }

  return root;
}

afterEach(() => {
  while (fixtureRoots.length > 0) {
    rmSync(fixtureRoots.pop()!, { recursive: true, force: true });
  }
});

describe("OpenClaw Zalo isolation guardrail", () => {
  it("finds no forbidden references in the repository OpenClaw scopes", () => {
    expect(scanOpenClawFiles()).toEqual([]);
  });

  it("scans every isolated scope while allowing the canonical channel and approved fork seams", () => {
    const root = makeFixture({
      "src/lib/openclaw-zalo/types.ts": `export const channel = "zalouser";`,
      "services/openclaw-egress-broker/src/index.ts": `export const channel = "zalouser";`,
      "services/openclaw-zalo-cell/vendor/zalouser-bridge/src/send.ts": [
        `import "@openclaw/zalouser";`,
        `export const delivery = adapter.send(payload);`,
        `export const rpc = tool.execute("send", payload);`,
      ].join("\n"),
      "services/openclaw-zalo-cell/vendor/@openclaw/zalouser/index.js": `export const installed = true;`,
      "services/openclaw-zalo-cell/package.json": `{"dependencies":{"@openclaw/zalouser":"file:vendor/zalouser.tgz"}}`,
      "services/openclaw-zalo-bridge/src/adapters/zalouser-bridge-rpc-adapter.ts": [
        `import "@openclaw/zalouser";`,
        `export const delivery = adapter.send(payload);`,
        `export const rpc = tool.execute("send", payload);`,
      ].join("\n"),
      "services/openclaw-zalo-bridge/test/upstream-contract.test.ts": [
        `import "@openclaw/zalouser";`,
        `expect(adapter.send(payload)).toBeDefined();`,
      ].join("\n"),
      "services/openclaw-zalo-bridge/test/zalouser-bridge-rpc-adapter.test.ts": [
        `import "@openclaw/zalouser";`,
        `expect(tool.execute("send", payload)).toBeDefined();`,
      ].join("\n"),
      "infra/openclaw-zalo/config/runtime.env.example": `OPENCLAW_CHANNEL=zalouser`,
      "contracts/openclaw-zalo/runtime.schema.json": `{"channel":"zalouser"}`,
      "supabase/migrations/20260727010000_openclaw_catalog_foundation.sql": `create table openclaw_zalo_accounts;`,
      "supabase/functions/_shared/openclaw/constants.ts": `export const CHANNEL = "zalouser";`,
      "supabase/functions/openclaw-control/index.ts": `export const channel = "zalouser";`,
      "services/openclaw-zalo-bridge/src/classification.ts": `classificationTool.execute(payload);`,
      "infra/openclaw-zalo/secrets/runtime.env": `LEGACY_TABLE=zalo_ignored_secret`,
      "src/lib/legacy.ts": `const old = "zalo_legacy";`,
    });

    expect(scanOpenClawFiles(root)).toEqual([]);
  });

  it("reports legacy coupling, package bypasses, generic sends, direct delivery, and worker paths", () => {
    const root = makeFixture({
      "src/lib/openclaw-zalo/bad.ts": [
        `import "@openclaw/zalouser";`,
        `import "../chat-zalo/legacy";`,
        `const hook = "src/hooks/useZaloChat.ts";`,
      ].join("\n"),
      "services/openclaw-zalo-bridge/src/not-approved.ts": [
        `import "@openclaw/zalouser";`,
        `client.call("send", payload);`,
        `adapter.sendText(payload);`,
      ].join("\n"),
      "services/openclaw-zalo-bridge/package.json": `{"dependencies":{"@openclaw/zalouser":"2026.7.1"}}`,
      "services/openclaw-zalo-bridge/vendor/@openclaw/zalouser/index.js": `export const installed = true;`,
      "services/openclaw-zalo-bridge/src/quoted-rpc.ts": `const request = {"method":"send"};`,
      "services/openclaw-zalo-bridge/src/optional-adapter.ts": `adapter?.send(payload);`,
      "services/openclaw-zalo-bridge/src/bracket-tool.ts": `tool["execute"]("send", payload);`,
      "services/openclaw-zalo-bridge/src/secrets/not-generated.ts": `const table = "zalo_must_fail";`,
      "services/openclaw-zalo-bridge/test/not-a-contract.test.ts": `import "@openclaw/zalouser";`,
      "services/openclaw-zalo-bridge/worker/queue.ts": `export const queue = true;`,
      "services/openclaw-egress-broker/src/legacy.sql": `select zalo_legacy from old_table;`,
      "infra/openclaw-zalo/config/chat.ts": `const route = "/chat-zalo";`,
      "contracts/openclaw-zalo/bad.schema.json": `{"hook":"useZaloChat"}`,
      "supabase/migrations/20260727010000_openclaw_catalog_foundation.sql": `create table zalo_legacy;`,
      "supabase/functions/openclaw-control/index.ts": `const path = "worker/queue";`,
    });

    const findings = scanOpenClawFiles(root);

    const expectFinding = (file: string, rule: string) => {
      expect(findings).toContainEqual(expect.objectContaining({ file, rule }));
    };

    expectFinding("src/lib/openclaw-zalo/bad.ts", "direct-zalouser-package");
    expectFinding("src/lib/openclaw-zalo/bad.ts", "legacy-chat-zalo-path");
    expectFinding("src/lib/openclaw-zalo/bad.ts", "legacy-use-zalo-chat");
    expectFinding("services/openclaw-zalo-bridge/src/not-approved.ts", "stock-generic-send");
    expectFinding(
      "services/openclaw-zalo-bridge/src/not-approved.ts",
      "direct-adapter-tool-delivery",
    );
    expectFinding("services/openclaw-zalo-bridge/package.json", "direct-zalouser-package");
    expectFinding(
      "services/openclaw-zalo-bridge/vendor/@openclaw/zalouser/index.js",
      "direct-zalouser-package",
    );
    expectFinding("services/openclaw-zalo-bridge/src/quoted-rpc.ts", "stock-generic-send");
    expectFinding(
      "services/openclaw-zalo-bridge/src/optional-adapter.ts",
      "direct-adapter-tool-delivery",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/src/bracket-tool.ts",
      "direct-adapter-tool-delivery",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/src/secrets/not-generated.ts",
      "legacy-zalo-identifier",
    );
    expectFinding("services/openclaw-zalo-bridge/worker/queue.ts", "legacy-worker-path");
    expectFinding("services/openclaw-egress-broker/src/legacy.sql", "legacy-zalo-identifier");
    expectFinding("infra/openclaw-zalo/config/chat.ts", "legacy-chat-zalo-path");
    expectFinding("contracts/openclaw-zalo/bad.schema.json", "legacy-use-zalo-chat");
    expectFinding(
      "supabase/migrations/20260727010000_openclaw_catalog_foundation.sql",
      "legacy-zalo-identifier",
    );
    expectFinding("supabase/functions/openclaw-control/index.ts", "legacy-worker-path");
  });
});
