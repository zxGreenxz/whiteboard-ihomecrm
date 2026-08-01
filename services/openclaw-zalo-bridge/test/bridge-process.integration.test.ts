import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBridgeRuntime, startBridgeProcess } from "../src/bin/bridge.js";
import { SqliteSpool } from "../src/spool/sqlite-spool.js";

const cleanup: string[] = [];
const spools: SqliteSpool[] = [];

function emptyHeartbeat() {
  return {
    version: 1,
    organizationId: "dddd0000-0000-4000-8000-000000000001",
    accountId: "dddd1000-0000-4000-8000-000000000001",
    cellId: "dddd2000-0000-4000-8000-000000000001",
    observedAt: "2026-08-01T00:00:00.000Z",
    accepted: true,
    authMode: "NORMAL",
    currentSessionGeneration: 5,
    currentConnectionGeneration: 3,
    commandResultAcks: [],
    commands: [],
  };
}

afterEach(() => {
  for (const spool of spools.splice(0)) {
    try { spool.close(); } catch { /* runtime may already own and close it */ }
  }
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("executable bridge runtime composition", () => {
  it("starts real workers/readiness and shuts every resource down idempotently", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openclaw-runtime-"));
    cleanup.push(directory);
    const spool = new SqliteSpool(join(directory, "spool.db"));
    spools.push(spool);
    const paths: string[] = [];
    const workClaimBodies: unknown[] = [];
    const createOutboxBodies: unknown[] = [];
    const schedulePayload = {
      kind: "SCHEDULE_OCCURRENCE" as const,
      scheduleId: "dddd4400-0000-4000-8000-000000000001",
      scheduleVersion: 4,
      occurrenceId: "dddd4500-0000-4000-8000-000000000001",
      campaignVersionId: "dddd4200-0000-4000-8000-000000000001",
      targetId: "dddd9400-0000-4000-8000-000000000001",
      targetVersion: 3,
      targetDirectoryRefreshedAt: "2026-08-01T00:00:00.000Z",
      automationVersionId: "dddd4000-0000-4000-8000-000000000001",
      templateVersionId: "dddd4100-0000-4000-8000-000000000001",
      knowledgeVersionIds: [],
      eligibilityDecisionHash: "b".repeat(64),
    };
    const scheduleClaim = {
      version: 1 as const,
      workItemId: "dddd9000-0000-4000-8000-000000000001",
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      accountId: "dddd1000-0000-4000-8000-000000000001",
      cellId: "dddd2000-0000-4000-8000-000000000001",
      credentialGeneration: 4,
      leaseGeneration: 3,
      sourceKey: "schedule:1",
      claimToken: "work-claim-token-1",
      claimGeneration: 2,
      fencingToken: 7,
      leaseExpiresAt: "2026-08-01T00:00:30.000Z",
      payload: schedulePayload,
    };
    let workClaimed = false;
    const runtime = {
      post: vi.fn(async (path: string, body: unknown) => {
        paths.push(path);
        if (path === "/v1/heartbeat") return emptyHeartbeat();
        if (path === "/v1/outbox/claim") return { version: 1, items: [] };
        if (path === "/v1/work/claim") {
          workClaimBodies.push(body);
          if (workClaimed) return { version: 1, items: [] };
          workClaimed = true;
          return { version: 1, items: [scheduleClaim] };
        }
        if (path === "/v1/work/context") {
          return {
            version: 1,
            workItemId: scheduleClaim.workItemId,
            claimGeneration: scheduleClaim.claimGeneration,
            kind: "SCHEDULE_OCCURRENCE",
            currentState: { allowed: true },
            frozenContext: {
              frozenIdentity: schedulePayload,
              template: "Chào {{customerName}}, phòng {{roomCode}}.",
              values: { customerName: "An", roomCode: "P101" },
              requiredFields: ["customerName"],
              canonicalPayload: {
                version: 1,
                organizationId: scheduleClaim.organizationId,
                accountId: scheduleClaim.accountId,
                target: { kind: "PEER", providerId: "peer-1" },
                channel: "zalouser",
                accountProfile: "primary",
                idempotencyKey: "schedule:1",
                parts: [{ version: 1, partIndex: 0, kind: "TEXT", text: "placeholder" }],
                replyToProviderMessageId: null,
                policyVersionId: "dddd3000-0000-4000-8000-000000000001",
                automationVersionId: schedulePayload.automationVersionId,
                templateVersionId: schedulePayload.templateVersionId,
                frozenInputs: {
                  campaignVersionId: schedulePayload.campaignVersionId,
                  scheduleVersion: schedulePayload.scheduleVersion,
                  subscriptionVersion: null,
                  subscriptionId: null,
                  occurrenceId: schedulePayload.occurrenceId,
                  sourceTable: "openclaw_schedule_snapshots",
                  sourceId: schedulePayload.scheduleId,
                  sourceVersion: String(schedulePayload.scheduleVersion),
                  knowledgeVersionIds: [],
                  sourceSnapshotHash: "c".repeat(64),
                  targetVersion: schedulePayload.targetVersion,
                  targetDirectoryRefreshedAt: schedulePayload.targetDirectoryRefreshedAt,
                  fieldMappingHash: null,
                },
              },
              sourceSnapshotHash: "c".repeat(64),
            },
          };
        }
        if (path === "/v1/work/create-outbox") {
          createOutboxBodies.push(body);
          return {
            version: 1,
            workItemId: scheduleClaim.workItemId,
            claimGeneration: scheduleClaim.claimGeneration,
            outcome: "COMPLETED",
            canonicalEvidenceHash: "d".repeat(64),
            completedAt: "2026-08-01T00:00:02.000Z",
            retryNotBefore: null,
          };
        }
        throw new Error(`unexpected runtime path ${path}`);
      }),
    };
    const close = vi.fn(async () => undefined);
    const cellRpc = {
      invoke: vi.fn(async (method: string) => {
        if (method === "channels.status") return {
          channelAccounts: {
            zalouser: [{
              accountId: "default",
              running: true,
              connected: true,
            }],
          },
        };
        throw new Error(`unexpected cell method ${method}`);
      }),
      close,
    };
    const timers = new Map<object, () => void>();
    const started = await startBridgeProcess({
      env: { OPENCLAW_BRIDGE_HOST: "127.0.0.1", OPENCLAW_BRIDGE_PORT: "18991" },
      runtimeOptions: {
      binding: {
        organizationId: "dddd0000-0000-4000-8000-000000000001",
        accountId: "dddd1000-0000-4000-8000-000000000001",
        cellId: "dddd2000-0000-4000-8000-000000000001",
        sessionGeneration: 5,
        fencingToken: 7,
      },
      workloadSecret: Buffer.from("cell-local-workload-secret-32-bytes-minimum"),
      spool,
      runtime,
      cellRpc,
      now: () => 1_785_062_400_000,
      claimToken: () => "dddd7000-0000-4000-8000-000000000001",
      modelProviderHealthy: () => true,
      setInterval: (callback) => {
        const handle = {};
        timers.set(handle, callback);
        return handle;
      },
      clearInterval: (handle) => timers.delete(handle as object),
      },
    });
    const bridge = started.runtime!;

    const address = await bridge.start();
    expect(paths).toEqual(expect.arrayContaining([
      "/v1/heartbeat",
      "/v1/outbox/claim",
      "/v1/work/claim",
      "/v1/work/context",
      "/v1/work/create-outbox",
    ]));
    expect(workClaimBodies).toEqual([expect.objectContaining({
      limit: 2,
      requestedKinds: ["INBOUND_AUTOMATION", "SCHEDULE_OCCURRENCE", "CRM_EVENT"],
    })]);
    expect(paths.filter((path) => path === "/v1/work/context")).toHaveLength(1);
    expect(runtime.post).toHaveBeenCalledWith("/v1/work/context", {
      version: 1,
      claim: scheduleClaim,
    });
    expect(createOutboxBodies).toEqual([expect.objectContaining({
      claim: scheduleClaim,
      canonicalPayload: expect.objectContaining({
        parts: [{ version: 1, partIndex: 0, kind: "TEXT", text: "Chào An, phòng P101." }],
      }),
      sourceSnapshotHash: "c".repeat(64),
    })]);
    expect(bridge.readiness()).toEqual({
      inboundReady: true,
      outboundReady: true,
      aiReady: true,
      heartbeatStale: false,
    });
    const response = await fetch(`http://${address.host}:${address.port}/readyz`);
    expect(response.status).toBe(200);
    expect(timers.size).toBeGreaterThanOrEqual(4);

    await bridge.stop();
    await bridge.stop();
    expect(timers.size).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(fetch(`http://${address.host}:${address.port}/livez`)).rejects.toThrow();
  });

  it("keeps inbound ready but does not claim outbound work at eighty-percent spool pressure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openclaw-runtime-pressure-"));
    cleanup.push(directory);
    const spool = new SqliteSpool(join(directory, "spool.db"), {
      maxBytes: 100,
      measureUsedBytes: () => 85,
    });
    spools.push(spool);
    const paths: string[] = [];
    const bridge = createBridgeRuntime({
      address: { host: "127.0.0.1", port: 0 },
      binding: {
        organizationId: "dddd0000-0000-4000-8000-000000000001",
        accountId: "dddd1000-0000-4000-8000-000000000001",
        cellId: "dddd2000-0000-4000-8000-000000000001",
        sessionGeneration: 5,
        fencingToken: 7,
      },
      workloadSecret: Buffer.from("cell-local-workload-secret-32-bytes-minimum"),
      spool,
      runtime: {
        post: vi.fn(async (path: string) => {
          paths.push(path);
          if (path === "/v1/heartbeat") return emptyHeartbeat();
          throw new Error(`outbound route must remain paused: ${path}`);
        }),
      },
      cellRpc: {
        invoke: vi.fn(async (method: string) => {
          if (method === "channels.status") {
            return {
              channelAccounts: {
                zalouser: [{
                  accountId: "default",
                  running: true,
                  connected: true,
                }],
              },
            };
          }
          throw new Error(`unexpected cell method ${method}`);
        }),
      },
      now: () => 1_785_062_400_000,
      claimToken: () => "dddd7000-0000-4000-8000-000000000001",
      workHandlers: {
        runInbound: vi.fn(),
        runSchedule: vi.fn(),
        runCrm: vi.fn(),
      },
      setInterval: () => ({}),
      clearInterval: () => undefined,
    });

    await bridge.start();
    expect(bridge.readiness()).toEqual({
      inboundReady: true,
      outboundReady: false,
      aiReady: false,
      heartbeatStale: false,
    });
    expect(paths).toEqual(["/v1/heartbeat"]);
    await bridge.stop();
  });

  it("fails readiness, stops the provider channel, and emits a critical heartbeat when intake is stopped", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openclaw-runtime-intake-stopped-"));
    cleanup.push(directory);
    const spool = new SqliteSpool(join(directory, "spool.db"), {
      maxBytes: 100,
      measureUsedBytes: () => 100,
    });
    spools.push(spool);
    const heartbeatBodies: unknown[] = [];
    const cellRpc = {
      invoke: vi.fn(async (method: string) => {
        if (method === "channels.status") return {
          channelAccounts: {
            zalouser: [{ accountId: "primary", running: true, connected: true }],
          },
        };
        if (method === "channels.stop") return { stopped: true };
        throw new Error(`unexpected cell method ${method}`);
      }),
    };
    const bridge = createBridgeRuntime({
      address: { host: "127.0.0.1", port: 0 },
      binding: {
        organizationId: "dddd0000-0000-4000-8000-000000000001",
        accountId: "dddd1000-0000-4000-8000-000000000001",
        cellId: "dddd2000-0000-4000-8000-000000000001",
        sessionGeneration: 5,
        fencingToken: 7,
      },
      channelAccountId: "primary",
      spool,
      runtime: {
        post: vi.fn(async (path: string, body: unknown) => {
          if (path === "/v1/heartbeat") {
            heartbeatBodies.push(body);
            return emptyHeartbeat();
          }
          throw new Error(`unexpected runtime path ${path}`);
        }),
      },
      cellRpc,
      now: () => 1_785_062_400_000,
      claimToken: () => "dddd7000-0000-4000-8000-000000000001",
      workHandlers: { runInbound: vi.fn(), runSchedule: vi.fn(), runCrm: vi.fn() },
      setInterval: () => ({}),
      clearInterval: () => undefined,
    });

    await bridge.start();
    expect(bridge.readiness()).toMatchObject({ inboundReady: false, outboundReady: false });
    expect(cellRpc.invoke).toHaveBeenCalledWith("channels.stop", {
      channel: "zalouser",
      accountId: "primary",
    });
    expect(heartbeatBodies).toContainEqual(expect.objectContaining({
      severity: "CRITICAL",
      healthKind: "INBOUND_INTAKE_STOPPED",
      status: "OPEN",
      fingerprint: "inbound-intake-stopped",
      contentFreeMetrics: { gapActive: false, pressureLevel: "STOP_INTAKE" },
    }));
    await bridge.stop();
  });

  it("aborts active inbound media before closing its dependencies", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openclaw-runtime-shutdown-"));
    cleanup.push(directory);
    const spool = new SqliteSpool(join(directory, "spool.db"));
    spools.push(spool);
    const events: string[] = [];
    let releaseMedia: (() => void) | undefined;
    const timers: Array<{ callback: () => void; milliseconds: number }> = [];
    const runtime = {
      post: vi.fn(async (path: string) => {
        if (path === "/v1/heartbeat") return emptyHeartbeat();
        if (path === "/v1/outbox/claim" || path === "/v1/work/claim") {
          return { version: 1, items: [] };
        }
        if (path === "/v1/inbound/batch") return {
          version: 1,
          requestId: "dddd7000-0000-4000-8000-000000000001",
          accepted: 1,
          deduplicated: 0,
          quarantined: 0,
          results: [{
            index: 0,
            status: "ACCEPTED",
            inboundEventId: "dddd9000-0000-4000-8000-000000000001",
            messageId: "dddd9000-0000-4000-8000-000000000002",
            decisionId: "dddd9000-0000-4000-8000-000000000003",
            decisionKind: "NO_SEND",
            noSendReason: "TEST",
            workItemId: null,
            media: [{
              manifestIndex: 0,
              mediaId: "dddd9000-0000-4000-8000-000000000020",
            }],
          }],
        };
        throw new Error(`unexpected runtime path ${path}`);
      }),
      close: vi.fn(async () => { events.push("runtime-close"); }),
    };
    const cellRpc = {
      invoke: vi.fn(async (method: string) => {
        if (method === "channels.status") return {
          channelAccounts: {
            zalouser: [{ accountId: "default", running: true, connected: true }],
          },
        };
        throw new Error(`unexpected cell method ${method}`);
      }),
      close: vi.fn(async () => { events.push("cell-close"); }),
    };
    const processInboundMedia = vi.fn(async (
      _event: unknown,
      _media: unknown,
      signal?: AbortSignal,
    ) => {
      if (signal === undefined) {
        events.push("missing-signal");
        return;
      }
      await new Promise<void>((resolve) => {
        releaseMedia = resolve;
        signal.addEventListener("abort", () => {
          events.push("media-aborted");
        }, { once: true });
      });
      try {
        spool.pressure();
        events.push("media-finished");
      } catch {
        events.push("post-close-write");
      }
      throw signal.reason;
    });
    const bridge = createBridgeRuntime({
      address: { host: "127.0.0.1", port: 0 },
      binding: {
        organizationId: "dddd0000-0000-4000-8000-000000000001",
        accountId: "dddd1000-0000-4000-8000-000000000001",
        cellId: "dddd2000-0000-4000-8000-000000000001",
        sessionGeneration: 5,
        fencingToken: 7,
      },
      spool,
      runtime,
      cellRpc,
      processInboundMedia,
      workHandlers: {
        runInbound: vi.fn(),
        runSchedule: vi.fn(),
        runCrm: vi.fn(),
      },
      workerDrainTimeoutMs: 100,
      inboundDrainIntervalMs: 1_234,
      setInterval: (callback, milliseconds) => {
        const timer = { callback, milliseconds };
        timers.push(timer);
        return timer;
      },
      clearInterval: () => undefined,
    });

    await bridge.start();
    spool.append({
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      accountId: "dddd1000-0000-4000-8000-000000000001",
      cellId: "dddd2000-0000-4000-8000-000000000001",
      sessionGeneration: 5,
      eventKind: "MESSAGE",
      providerEventId: "provider-event-shutdown",
      providerMessageId: "provider-message-shutdown",
      providerConversationId: "conversation-shutdown",
      providerSenderId: "sender-shutdown",
      providerTarget: { kind: "PEER", providerId: "sender-shutdown" },
      providerEventType: "MESSAGE",
      sourceTimestamp: "2026-08-01T00:00:00.000Z",
      callbackReceivedAt: "2026-08-01T00:00:01.000Z",
      providerTimestamp: 1_785_062_400_000,
      rawPayload: { content: "image" },
      normalizedPayload: { text: "", mediaManifest: [{ version: 1, index: 0 }] },
      mediaManifest: [{ version: 1, index: 0 }],
    });
    timers.find((timer) => timer.milliseconds === 1_234)?.callback();
    await vi.waitFor(() => expect(processInboundMedia).toHaveBeenCalledOnce());

    const stopPromise = bridge.stop();
    const stopOutcome = await Promise.race([
      stopPromise.then(() => "stopped" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 300)),
    ]);
    if (stopOutcome === "timed-out") {
      releaseMedia?.();
      await stopPromise;
      expect(stopOutcome).toBe("stopped");
      return;
    }

    expect(events).toEqual(["media-aborted"]);
    expect(runtime.close).not.toHaveBeenCalled();
    expect(cellRpc.close).not.toHaveBeenCalled();
    expect(() => spool.pressure()).not.toThrow();
    releaseMedia?.();
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    expect(events).toEqual([
      "media-aborted",
      "media-finished",
      "runtime-close",
      "cell-close",
    ]);
  });

  it("keeps non-AI work available while excluding inbound AI claims when the cell circuit is open", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openclaw-runtime-ai-open-"));
    cleanup.push(directory);
    const spool = new SqliteSpool(join(directory, "spool.db"));
    spools.push(spool);
    const workClaimBodies: unknown[] = [];
    const bridge = createBridgeRuntime({
      address: { host: "127.0.0.1", port: 0 },
      binding: {
        organizationId: "dddd0000-0000-4000-8000-000000000001",
        accountId: "dddd1000-0000-4000-8000-000000000001",
        cellId: "dddd2000-0000-4000-8000-000000000001",
        sessionGeneration: 5,
        fencingToken: 7,
      },
      channelAccountId: "primary",
      workloadSecret: Buffer.from("cell-local-workload-secret-32-bytes-minimum"),
      spool,
      runtime: {
        post: vi.fn(async (path: string, body: unknown) => {
          if (path === "/v1/heartbeat") return emptyHeartbeat();
          if (path === "/v1/outbox/claim") return { version: 1, items: [] };
          if (path === "/v1/work/claim") {
            workClaimBodies.push(body);
            return { version: 1, items: [] };
          }
          throw new Error(`unexpected runtime path ${path}`);
        }),
      },
      cellRpc: {
        invoke: vi.fn(async (method: string) => {
          if (method === "channels.status") {
            return {
              channelAccounts: {
                zalouser: [{
                  accountId: "primary",
                  running: true,
                  connected: true,
                }],
              },
            };
          }
          throw new Error(`unexpected cell method ${method}`);
        }),
      },
      now: () => 1_785_062_400_000,
      claimToken: () => "dddd7000-0000-4000-8000-000000000001",
      workHandlers: {
        runInbound: vi.fn(),
        runSchedule: vi.fn(),
        runCrm: vi.fn(),
        aiAutomaticSendAllowed: () => false,
      },
      setInterval: () => ({}),
      clearInterval: () => undefined,
    });

    await bridge.start();
    expect(bridge.readiness()).toMatchObject({ outboundReady: true, aiReady: false });
    expect(workClaimBodies).toEqual([expect.objectContaining({
      requestedKinds: ["SCHEDULE_OCCURRENCE", "CRM_EVENT"],
    })]);
    await bridge.stop();
  });
});
