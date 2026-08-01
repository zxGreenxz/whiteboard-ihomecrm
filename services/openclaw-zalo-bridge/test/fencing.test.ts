import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createInboundController } from "../src/bridge/inbound-controller.js";
import { closeBridgeServer, createBridgeServer, listenBridgeServer } from "../src/bridge/server.js";
import { payloadChecksum } from "../src/spool/checksum.js";
import { SqliteSpool } from "../src/spool/sqlite-spool.js";
import {
  createSignedBridgeRequest,
  verifySignedBridgeResponse,
} from "../../openclaw-zalo-cell/vendor/zalouser-bridge/src/bridge/protocol.js";
import type { CellWorkloadBinding } from "../src/runtime-api/workload-auth.js";

const secret = Buffer.from("cell-local-workload-secret-32-bytes-minimum", "utf8");
const binding: CellWorkloadBinding = {
  organizationId: "dddd0000-0000-4000-8000-000000000001",
  accountId: "dddd1000-0000-4000-8000-000000000001",
  cellId: "dddd2000-0000-4000-8000-000000000001",
  sessionGeneration: 5,
  fencingToken: 7,
};
const localBinding = { ...binding, controlVersion: 2, takeoverVersion: 1 };
const NOW = 1_785_062_400_000;
const open: Array<{ server: Server; spool: SqliteSpool; directory: string }> = [];

function envelope() {
  const rawEnvelope = { content: "hello" };
  const normalized = { text: "hello", replyToProviderMessageId: null, mediaManifest: [] };
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
  };
}

afterEach(async () => {
  for (const item of open.splice(0)) {
    await closeBridgeServer(item.server);
    item.spool.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

describe("cell fencing at the inbound HTTP boundary", () => {
  it("rejects query-bearing aliases instead of authenticating them as the canonical route", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openclaw-fencing-"));
    const spool = new SqliteSpool(join(directory, "spool.db"));
    const controller = createInboundController({ spool, binding });
    const server = createBridgeServer({
      readiness: () => ({ inboundReady: true, outboundReady: true, aiReady: true, heartbeatStale: false }),
      localCell: {
        secret,
        binding: localBinding,
        inbound: controller,
        authorizeSend: async () => undefined,
        now: () => NOW,
      },
    });
    open.push({ server, spool, directory });
    const address = await listenBridgeServer(server, { host: "127.0.0.1", port: 0 });
    const request = createSignedBridgeRequest({
      operation: "inbound.commit",
      binding: localBinding,
      body: envelope(),
      secret,
      now: NOW,
      nonce: "dddd7000-0000-4000-8000-000000000099",
      ttlMs: 2_000,
    });

    const response = await fetch(
      `http://${address.host}:${address.port}/v1/zalouser/inbound/commit?forwarded-route=/v1/zalouser/inbound/commit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );

    expect(response.status).toBe(404);
    expect(spool.countByState("SPOOLED")).toBe(0);
  });

  it("rejects a stale fence before accepting the same nonce from the current cell", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openclaw-fencing-"));
    const spool = new SqliteSpool(join(directory, "spool.db"));
    const controller = createInboundController({ spool, binding });
    const server = createBridgeServer({
      readiness: () => ({ inboundReady: true, outboundReady: true, aiReady: true, heartbeatStale: false }),
      localCell: {
        secret,
        binding: localBinding,
        inbound: controller,
        authorizeSend: async () => undefined,
        now: () => NOW,
      },
    });
    open.push({ server, spool, directory });
    const address = await listenBridgeServer(server, { host: "127.0.0.1", port: 0 });
    const url = `http://${address.host}:${address.port}/v1/zalouser/inbound/commit`;
    const nonce = "dddd7000-0000-4000-8000-000000000001";
    const signed = (requestBinding: typeof localBinding) => createSignedBridgeRequest({
      operation: "inbound.commit",
      binding: requestBinding,
      body: envelope(),
      secret,
      now: NOW,
      nonce,
      ttlMs: 2_000,
    });

    const stale = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed({ ...localBinding, fencingToken: 6 })),
    });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: "UNAUTHORIZED" });
    expect(spool.countByState("SPOOLED")).toBe(0);

    const accepted = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed(localBinding)),
    });
    expect(accepted.status).toBe(200);
    expect(verifySignedBridgeResponse(await accepted.json(), {
      operation: "inbound.commit",
      requestNonce: nonce,
      binding: localBinding,
      secret,
      now: NOW,
    })).toMatchObject({ status: "committed" });
    expect(spool.countByState("SPOOLED")).toBe(1);
  });
});
