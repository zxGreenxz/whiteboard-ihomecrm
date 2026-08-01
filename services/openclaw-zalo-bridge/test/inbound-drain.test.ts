import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInboundController } from "../src/bridge/inbound-controller.js";
import { createSpoolDrainWorker } from "../src/spool/drain-worker.js";
import { payloadChecksum } from "../src/spool/checksum.js";
import { SqliteSpool } from "../src/spool/sqlite-spool.js";
import type { CellWorkloadBinding } from "../src/runtime-api/workload-auth.js";

const binding: CellWorkloadBinding = {
  organizationId: "dddd0000-0000-4000-8000-000000000001",
  accountId: "dddd1000-0000-4000-8000-000000000001",
  cellId: "dddd2000-0000-4000-8000-000000000001",
  sessionGeneration: 5,
  fencingToken: 7,
};

function inboundEnvelope(overrides: Record<string, unknown> = {}) {
  const rawEnvelope = { content: "hello" };
  const normalized = {
    text: "hello",
    replyToProviderMessageId: null,
    mediaManifest: [],
  };
  return {
    version: 1,
    organizationId: binding.organizationId,
    accountId: binding.accountId,
    cellId: binding.cellId,
    sessionGeneration: binding.sessionGeneration,
    providerEventId: "provider-event-1",
    providerMessageId: "provider-message-1",
    eventKind: "MESSAGE",
    providerConversationId: "conversation-1",
    providerSenderId: "sender-1",
    providerTarget: { kind: "PEER", providerId: "sender-1" },
    providerEventType: "webchat",
    sourceTimestamp: "2026-08-01T00:00:00.000Z",
    callbackReceivedAt: "2026-08-01T00:00:01.000Z",
    rawEnvelope,
    rawEnvelopeSha256: payloadChecksum(rawEnvelope),
    normalized,
    normalizedSha256: payloadChecksum(normalized),
    ...overrides,
  };
}

let directory: string;
let spool: SqliteSpool;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openclaw-inbound-drain-"));
  spool = new SqliteSpool(join(directory, "spool.db"));
  createInboundController({ spool, binding }).commit(inboundEnvelope(), binding);
});

afterEach(() => {
  spool.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("durable inbound spool drain", () => {
  it("posts the complete canonical envelope and deletes only after atomic acceptance", async () => {
    const runtime = {
      post: vi.fn(async () => ({
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
          decisionKind: "WORK_ELIGIBLE",
          noSendReason: null,
          workItemId: "dddd9000-0000-4000-8000-000000000004",
          media: [],
        }],
      })),
    };
    const worker = createSpoolDrainWorker({ spool, runtime });

    await expect(worker.drainOnce()).resolves.toEqual({
      attempted: 1,
      acknowledged: 1,
      quarantined: 0,
    });
    expect(runtime.post).toHaveBeenCalledTimes(1);
    const [path, batch] = runtime.post.mock.calls[0]!;
    expect(path).toBe("/v1/inbound/batch");
    expect(batch).toMatchObject({
      version: 1,
      organizationId: binding.organizationId,
      accountId: binding.accountId,
      cellId: binding.cellId,
      sessionGeneration: binding.sessionGeneration,
      events: [{
        version: 1,
        providerConversationId: "conversation-1",
        providerSenderId: "sender-1",
        providerTarget: { kind: "PEER", providerId: "sender-1" },
        rawEnvelope: { content: "hello" },
        normalized: { text: "hello", mediaManifest: [] },
      }],
    });
    expect(batch).not.toHaveProperty("fencingToken");
    expect(spool.countByState("SPOOLED")).toBe(0);
  });

  it("keeps a row retryable after runtime outage", async () => {
    const worker = createSpoolDrainWorker({
      spool,
      runtime: { post: vi.fn(async () => { throw new Error("runtime unavailable"); }) },
    });

    await expect(worker.drainOnce()).rejects.toThrow(/drain/i);
    expect(spool.countByState("SPOOLED")).toBe(1);
    expect(spool.pending()[0]?.retryCount).toBe(1);
  });

  it("retries media processing through a canonical DUPLICATE before deleting local state", async () => {
    let attempt = 0;
    const runtime = {
      post: vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? {
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
                noSendReason: "POLICY_NO_SEND",
                workItemId: null,
                media: [{ manifestIndex: 0, mediaId: "dddd9000-0000-4000-8000-000000000005" }],
              }],
            }
          : {
              version: 1,
              requestId: "dddd7000-0000-4000-8000-000000000002",
              accepted: 0,
              deduplicated: 1,
              quarantined: 0,
              results: [{
                index: 0,
                status: "DUPLICATE",
                inboundEventId: "dddd9000-0000-4000-8000-000000000001",
                media: [{ manifestIndex: 0, mediaId: "dddd9000-0000-4000-8000-000000000005" }],
              }],
            };
      }),
    };
    const processMedia = vi.fn(async (_event, media) => {
      expect(media).toEqual([{ manifestIndex: 0, mediaId: "dddd9000-0000-4000-8000-000000000005" }]);
      if (processMedia.mock.calls.length === 1) throw new Error("gateway unavailable");
    });
    const worker = createSpoolDrainWorker({ spool, runtime, processMedia });

    await expect(worker.drainOnce()).rejects.toThrow(/media/i);
    expect(spool.countByState("SPOOLED")).toBe(1);
    await expect(worker.drainOnce()).resolves.toMatchObject({ acknowledged: 1 });
    expect(processMedia).toHaveBeenCalledTimes(2);
    expect(spool.countByState("SPOOLED")).toBe(0);
  });

  it("re-spools an exact replay after a quarantined drain without unlocking conflicting bytes", async () => {
    const quarantiningRuntime = {
      post: vi.fn(async () => ({
        version: 1,
        requestId: "dddd7000-0000-4000-8000-000000000001",
        accepted: 0,
        deduplicated: 0,
        quarantined: 1,
        results: [{ index: 0, status: "QUARANTINED", collisionKind: "PAYLOAD_MISMATCH" }],
      })),
    };
    const firstWorker = createSpoolDrainWorker({ spool, runtime: quarantiningRuntime });

    await expect(firstWorker.drainOnce()).resolves.toEqual({
      attempted: 1,
      acknowledged: 0,
      quarantined: 1,
    });
    expect(spool.countByState("QUARANTINED")).toBe(1);

    spool.close();
    spool = new SqliteSpool(join(directory, "spool.db"));
    const controller = createInboundController({ spool, binding });
    expect(controller.commit(inboundEnvelope(), binding)).toMatchObject({ status: "committed" });

    const conflictingNormalized = {
      text: "different bytes",
      replyToProviderMessageId: null,
      mediaManifest: [],
    };
    expect(controller.commit(inboundEnvelope({
      normalized: conflictingNormalized,
      normalizedSha256: payloadChecksum(conflictingNormalized),
    }), binding)).toMatchObject({ status: "collision" });

    const acceptingRuntime = {
      post: vi.fn(async () => ({
        version: 1,
        requestId: "dddd7000-0000-4000-8000-000000000002",
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
          noSendReason: "POLICY_NO_SEND",
          workItemId: null,
          media: [],
        }],
      })),
    };
    const secondWorker = createSpoolDrainWorker({ spool, runtime: acceptingRuntime });
    await expect(secondWorker.drainOnce()).resolves.toMatchObject({ acknowledged: 1 });
    expect(spool.countByState("SPOOLED")).toBe(0);
  });
});
