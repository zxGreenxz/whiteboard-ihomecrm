import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createDurableInboundListener,
  installInboundBridgeCommitter,
} from "../../openclaw-zalo-cell/vendor/zalouser-bridge/src/bridge/inbound-listener.js";
import {
  businessFramesFromPayload,
  hashCanonicalSendPayload,
  providerSinkFromPayload,
  type CanonicalSendPayloadV1,
} from "../../openclaw-zalo-cell/vendor/zalouser-bridge/src/bridge/canonical-send.js";
import { createPrivateOutboundRpc } from "../../openclaw-zalo-cell/vendor/zalouser-bridge/src/bridge/outbound-rpc.js";
import { createPreparedOutboundBatch } from "../../openclaw-zalo-cell/vendor/zalouser-bridge/src/bridge/send-context.js";

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
    "canonical-send.ts",
    "control-traffic.ts",
    "inbound-listener.ts",
    "outbound-rpc.ts",
    "protocol.ts",
    "runtime-bootstrap.ts",
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
      source("src/zalo-js.ts").includes("pending = params.onMessage(normalized)") &&
      source("src/zalo-js.ts").includes("void Promise.resolve(pending).catch") &&
      source("src/monitor.ts").includes("await ensureInboundBridgeReady") &&
      source("src/monitor.ts").includes("await commitAndDispatchInbound") &&
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
        "pending = params.onMessage(normalized)",
      );
      expect(readText(resolve(preparedRoot, "src/monitor.ts"))).toContain(
        "await commitAndDispatchInbound",
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

  it("keeps all eight bridge overlay modules present and independently addressable", () => {
    const expected = [
      ["authorize-client.ts", "createAuthorizeClient"],
      ["canonical-send.ts", "snapshotZaloUserBridgeSendParams"],
      ["control-traffic.ts", "classifyControlTraffic"],
      ["inbound-listener.ts", "installInboundBridgeCommitter"],
      ["outbound-rpc.ts", "registerPrivateOutboundRpc"],
      ["protocol.ts", "createSignedBridgeRequest"],
      ["runtime-bootstrap.ts", "installProductionBridgeRuntimeFromEnvironment"],
      ["send-context.ts", "createSendContext"],
    ] as const;

    for (const [file, symbol] of expected) {
      const source = readText(resolve(vendorRoot, "src/bridge", file));
      expect(source).toMatch(new RegExp(`export (?:async )?function ${symbol}\\b`));
    }
  });

  it("proves the fork seams fail closed before dispatch or provider I/O", async () => {
    const events: string[] = [];
    const uninstall = installInboundBridgeCommitter({
      binding: {
        cellId: "cell-a",
        organizationId: "organization-a",
        sessionGeneration: 1,
      },
      committer: async () => {
        events.push("commit");
        throw new Error("WAL unavailable");
      },
      ready: async () => undefined,
      commitTimeoutMs: 6_000,
      readinessTimeoutMs: 2_000,
    });
    const inbound = createDurableInboundListener({
      accountId: "account-a",
      dispatch: async () => {
        events.push("dispatch");
      },
    });

    try {
      await expect(inbound({
        callbackReceivedAt: "2026-07-27T00:00:01.000Z",
        eventKind: "MESSAGE",
        normalized: {
          media: [],
          replyToProviderMessageId: null,
          text: "contract fixture",
        },
        providerConversationId: "thread-a",
        providerEventId: "event-a",
        providerEventType: "webchat",
        providerMessageId: "message-a",
        providerSenderId: "sender-a",
        providerTarget: { kind: "PEER", providerId: "sender-a" },
        rawEnvelope: { content: "contract fixture" },
        sourceTimestamp: "2026-07-27T00:00:00.000Z",
      })).rejects.toThrow("WAL unavailable");
    } finally {
      uninstall();
    }
    expect(events).toEqual(["commit"]);

    let providerFrames = 0;
    const payload: CanonicalSendPayloadV1 = Object.freeze({
      version: 1,
      organizationId: "organization-a",
      accountId: "account-a",
      target: Object.freeze({ kind: "PEER", providerId: "thread-a" }),
      channel: "zalouser",
      accountProfile: "profile-a",
      idempotencyKey: "contract-outbox:1",
      parts: Object.freeze([Object.freeze({
        version: 1,
        partIndex: 0,
        kind: "TEXT",
        text: "contract fixture",
      })]),
      replyToProviderMessageId: null,
      policyVersionId: "policy-v1",
      automationVersionId: null,
      templateVersionId: null,
      frozenInputs: Object.freeze({
        campaignVersionId: null,
        scheduleVersion: null,
        subscriptionVersion: null,
        subscriptionId: null,
        occurrenceId: null,
        sourceTable: null,
        sourceId: null,
        sourceVersion: null,
        knowledgeVersionIds: Object.freeze([]),
        sourceSnapshotHash: null,
        targetVersion: 1,
        targetDirectoryRefreshedAt: "2026-07-29T10:00:00.000Z",
        fieldMappingHash: null,
      }),
    });
    const request = Object.freeze({
      version: 1 as const,
      payload,
      authorization: Object.freeze({
        version: 1 as const,
        claimToken: "contract-claim",
        authorizationMarker: Object.freeze({
          version: 1 as const,
          outboxId: "contract-outbox",
          claimGeneration: 1,
          payloadHash: hashCanonicalSendPayload(payload),
          fencingToken: 1,
          sessionGeneration: 1,
          controlVersion: 1,
          takeoverVersion: 1,
          markerNonce: "contract-marker",
          expiresAt: "2026-07-29T10:00:15.000Z",
        }),
      }),
    });
    const outbound = createPrivateOutboundRpc({
      prepare: async (candidate) => Object.freeze({
        batch: createPreparedOutboundBatch(
          providerSinkFromPayload(candidate.payload),
          businessFramesFromPayload(candidate.payload),
        ),
        sendPrepared: async () => {
          providerFrames += 1;
          return {};
        },
      }),
      authorize: async () => {
        throw Object.assign(new Error("denied"), { code: "AUTHORIZATION_DENIED" });
      },
    });
    await expect(outbound.invoke("zalouser.bridge.send", request))
      .rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(providerFrames).toBe(0);
  });
});
