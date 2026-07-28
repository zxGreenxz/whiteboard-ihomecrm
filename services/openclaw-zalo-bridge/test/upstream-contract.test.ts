import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDurableInboundListener } from "../../openclaw-zalo-cell/vendor/zalouser-bridge/src/bridge/inbound-listener.js";
import { createPrivateOutboundRpc } from "../../openclaw-zalo-cell/vendor/zalouser-bridge/src/bridge/outbound-rpc.js";

const bridgeTestRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(bridgeTestRoot, "../../..");
const vendorRoot = resolve(repoRoot, "services/openclaw-zalo-cell/vendor/zalouser-bridge");
const upstreamRoot = resolve(vendorRoot, "upstream/package");

const REQUIRED_PUBLIC_ENTRYPOINTS = [
  "index.ts",
  "api.ts",
  "runtime-api.ts",
  "channel-plugin-api.ts",
  "contract-api.ts",
  "doctor-contract-api.ts",
  "secret-contract-api.ts",
  "setup-entry.ts",
  "setup-plugin-api.ts",
];

const PATCH_SERIES = [
  "0001-durable-inbound-bridge-listener.patch",
  "0002-private-bridge-send-rpc.patch",
  "0003-close-bypasses-and-classify-control.patch",
];

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function applyReviewedFork(root: string): void {
  for (const patch of PATCH_SERIES) {
    execFileSync(
      "git",
      ["apply", "--whitespace=nowarn", resolve(vendorRoot, "patches", patch)],
      { cwd: root, stdio: "pipe" },
    );
  }
  const bridgeRoot = resolve(root, "src/bridge");
  mkdirSync(bridgeRoot, { recursive: true });
  for (const file of [
    "authorize-client.ts",
    "control-traffic.ts",
    "inbound-listener.ts",
    "outbound-rpc.ts",
    "send-context.ts",
  ]) {
    cpSync(resolve(vendorRoot, "src/bridge", file), resolve(bridgeRoot, file));
  }
}

function inspectPrivateSecuritySeams(root: string) {
  const source = (path: string) => {
    const absolute = resolve(root, path);
    return existsSync(absolute) ? readText(absolute) : "";
  };
  return {
    publicEntrypoints: REQUIRED_PUBLIC_ENTRYPOINTS.every((path) => existsSync(resolve(root, path))),
    privateInbound:
      source("src/zalo-js.ts").includes("Promise.resolve(params.onMessage(normalized))") &&
      source("src/monitor.ts").includes("await commitInboundThroughBridge") &&
      source("src/bridge/inbound-listener.ts").includes("createDurableInboundListener"),
    privateOutbound:
      source("index.ts").includes('registerPrivateOutboundRpc(api, "zalouser.bridge.send")') &&
      ["src/send.ts", "src/channel.adapters.ts", "src/tool.ts"].every((path) =>
        source(path).includes("PRIVATE_RPC_REQUIRED"),
      ) &&
      source("src/bridge/outbound-rpc.ts").includes("createPrivateOutboundRpc"),
  };
}

describe("reviewed OpenClaw ZaloUser upstream contract", () => {
  it("pins the expected package, plugin, and complete public source snapshot", () => {
    const upstream = JSON.parse(readText(resolve(vendorRoot, "UPSTREAM.json"))) as {
      package?: string;
      version?: string;
      sourceManifest?: Array<{ outputPath?: string; sha256?: string; size?: number }>;
    };
    const plugin = JSON.parse(readText(resolve(upstreamRoot, "openclaw.plugin.json"))) as {
      id?: string;
      channels?: string[];
    };

    expect(upstream.package).toBe("@openclaw/zalouser");
    expect(upstream.version).toBe("2026.7.1");
    expect(plugin.id).toBe("zalouser");
    expect(plugin.channels).toEqual(["zalouser"]);
    expect(upstream.sourceManifest).toHaveLength(75);

    const paths = new Set(upstream.sourceManifest?.map((entry) => entry.outputPath));
    for (const entrypoint of REQUIRED_PUBLIC_ENTRYPOINTS) {
      expect(paths).toContain(`upstream/package/${entrypoint}`);
    }
    expect(upstream.sourceManifest?.every((entry) =>
      typeof entry.outputPath === "string" &&
      /^upstream\/package(?:\/|$)/.test(entry.outputPath) &&
      Number.isInteger(entry.size) &&
      typeof entry.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(entry.sha256),
    )).toBe(true);
  });

  it("applies the exact reviewed patches before the bridge overlay is used", () => {
    const preparedRoot = mkdtempSync(resolve(tmpdir(), "ihome-openclaw-upstream-contract-"));
    try {
      cpSync(upstreamRoot, preparedRoot, { recursive: true });
      const series = readText(resolve(vendorRoot, "patches/series"))
        .split(/\r?\n/)
        .filter(Boolean);
      expect(series).toEqual(PATCH_SERIES);

      applyReviewedFork(preparedRoot);

      expect(readText(resolve(preparedRoot, "src/zalo-js.ts"))).toContain(
        "Promise.resolve(params.onMessage(normalized))",
      );
      expect(readText(resolve(preparedRoot, "src/monitor.ts"))).toContain(
        "await commitInboundThroughBridge",
      );
      expect(readText(resolve(preparedRoot, "index.ts"))).toContain(
        'registerPrivateOutboundRpc(api, "zalouser.bridge.send")',
      );
      for (const path of ["src/send.ts", "src/channel.adapters.ts", "src/tool.ts"]) {
        expect(readText(resolve(preparedRoot, path))).toContain("PRIVATE_RPC_REQUIRED");
      }
      expect(inspectPrivateSecuritySeams(upstreamRoot)).toEqual({
        publicEntrypoints: true,
        privateInbound: false,
        privateOutbound: false,
      });
      expect(inspectPrivateSecuritySeams(preparedRoot)).toEqual({
        publicEntrypoints: true,
        privateInbound: true,
        privateOutbound: true,
      });
    } finally {
      rmSync(preparedRoot, { recursive: true, force: true });
    }
  });

  it("keeps the five bridge overlay modules present and independently addressable", () => {
    const expected = [
      ["authorize-client.ts", "createAuthorizeClient"],
      ["control-traffic.ts", "classifyControlTraffic"],
      ["inbound-listener.ts", "installInboundBridgeCommitter"],
      ["outbound-rpc.ts", "registerPrivateOutboundRpc"],
      ["send-context.ts", "createSendContext"],
    ] as const;

    for (const [file, symbol] of expected) {
      const source = readText(resolve(vendorRoot, "src/bridge", file));
      expect(source).toMatch(new RegExp(`export (?:async )?function ${symbol}\\b`));
    }
  });

  it("proves the fork seams fail closed before dispatch or provider I/O", async () => {
    const events: string[] = [];
    const inbound = createDurableInboundListener({
      accountId: "account-a",
      commit: async () => {
        events.push("commit");
        throw new Error("WAL unavailable");
      },
      dispatch: async () => {
        events.push("dispatch");
      },
    });

    await expect(inbound({
      content: { text: "contract fixture" },
      occurredAt: "2026-07-27T00:00:00.000Z",
      providerMessageId: "message-a",
      senderId: "sender-a",
      threadId: "thread-a",
    })).rejects.toThrow("WAL unavailable");
    expect(events).toEqual(["commit"]);

    let providerFrames = 0;
    const outbound = createPrivateOutboundRpc({
      authorize: async () => {
        throw Object.assign(new Error("denied"), { code: "AUTHORIZATION_DENIED" });
      },
      sendFrame: async () => {
        providerFrames += 1;
        return {};
      },
    });
    await expect(outbound.invoke("zalouser.bridge.send", {
      context: {} as never,
      frames: [{ kind: "text", text: "contract fixture" }],
    })).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(providerFrames).toBe(0);
  });
});
