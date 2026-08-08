import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const vendorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) rmSync(root, { force: true, recursive: true });
  }
});

function preparePatchedSource(): string {
  const root = mkdtempSync(resolve(tmpdir(), "ihome-egress-patched-source-"));
  temporaryRoots.push(root);
  cpSync(resolve(vendorRoot, "upstream/package"), root, { recursive: true });
  // The whole series, in order: the egress patch is written against the tree the
  // earlier patches leave behind, exactly as prepare.mjs applies them.
  for (const patch of readFileSync(resolve(vendorRoot, "patches/series"), "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)) {
    execFileSync("git", ["apply", "--whitespace=nowarn", resolve(vendorRoot, "patches", patch)], {
      cwd: root,
      stdio: "pipe",
    });
  }
  return root;
}

describe("patched egress routing", () => {
  it("hands an egress agent to zca-js everywhere a Zalo client is built", () => {
    const root = preparePatchedSource();
    const zaloJs = readFileSync(resolve(root, "src/zalo-js.ts"), "utf8");

    // Both clients matter: the QR login opens the first socket, and the stored
    // session client owns the realtime listener that carries every message.
    const constructions = zaloJs.match(/createZalo\(\{/gu) ?? [];
    const agentPasses = zaloJs.match(/agent: resolveZaloEgressAgent\(\)/gu) ?? [];
    expect(constructions.length).toBeGreaterThanOrEqual(2);
    expect(agentPasses.length).toBe(constructions.length);
    expect(zaloJs).toContain('import { resolveZaloEgressAgent } from "./bridge/egress-agent.js";');
  });

  it("keeps the agent in the constructor contract so the option cannot be dropped silently", () => {
    const root = preparePatchedSource();
    const zcaClient = readFileSync(resolve(root, "src/zca-client.ts"), "utf8");

    expect(zcaClient).toContain("agent?: unknown;");
    expect(zcaClient).not.toContain(
      "type ZaloCtor = new (options?: { logging?: boolean; selfListen?: boolean }) => {",
    );
  });

  it("leaves no Zalo client built without an agent", () => {
    const root = preparePatchedSource();
    const zaloJs = readFileSync(resolve(root, "src/zalo-js.ts"), "utf8");

    // The single-line form is how the QR path shipped upstream; if it comes back
    // the listener silently returns to dialling Zalo without the broker.
    expect(zaloJs).not.toMatch(/createZalo\(\{ logging: false, selfListen: false \}\)/u);
  });
});
