import { describe, expect, it } from "vitest";
import {
  createSignedBridgeResponse,
  verifySignedBridgeResponse,
  type BridgeRuntimeBindingV1,
} from "../src/bridge/protocol.js";

const binding: BridgeRuntimeBindingV1 = Object.freeze({
  organizationId: "organization-a",
  accountId: "account-a",
  cellId: "cell-a",
  sessionGeneration: 7,
  fencingToken: 9,
  controlVersion: 3,
  takeoverVersion: 2,
});
const secret = Buffer.alloc(32, 0x5a);
const now = Date.parse("2026-07-30T10:00:00.000Z");

function response() {
  return createSignedBridgeResponse({
    operation: "outbox.authorize-send",
    requestNonce: "request-nonce-a",
    binding,
    body: Object.freeze({ version: 1, status: "AUTHORIZED" }),
    secret,
    now,
    ttlMs: 1_000,
  });
}

function verify(value: unknown, overrides: Partial<Parameters<typeof verifySignedBridgeResponse>[1]> = {}) {
  return verifySignedBridgeResponse(value, {
    operation: "outbox.authorize-send",
    requestNonce: "request-nonce-a",
    binding,
    secret,
    now: now + 1,
    ...overrides,
  });
}

describe("signed bridge response protocol", () => {
  it("authenticates the exact response body and request context", () => {
    expect(verify(response())).toEqual({ version: 1, status: "AUTHORIZED" });
  });

  it.each([
    ["body", (candidate: Record<string, unknown>) => {
      candidate.body = { version: 1, status: "AUTHORIZED", forged: true };
    }],
    ["request nonce", (candidate: Record<string, unknown>) => {
      candidate.requestNonce = "other-nonce";
    }],
    ["operation", (candidate: Record<string, unknown>) => {
      candidate.operation = "inbound.commit";
    }],
    ["binding", (candidate: Record<string, unknown>) => {
      candidate.binding = { ...binding, accountId: "account-b" };
    }],
    ["signature", (candidate: Record<string, unknown>) => {
      candidate.signature = "0".repeat(64);
    }],
  ])("rejects a changed %s", (_label, mutate) => {
    const candidate = structuredClone(response()) as unknown as Record<string, unknown>;
    mutate(candidate);
    expect(() => verify(candidate)).toThrowError(expect.objectContaining({
      code: "BRIDGE_RESPONSE_AUTHENTICATION_FAILED",
    }));
  });

  it("rejects an expired response and a response outside the five-second lifetime", () => {
    expect(() => verify(response(), { now: now + 1_001 })).toThrowError(
      expect.objectContaining({ code: "BRIDGE_RESPONSE_AUTHENTICATION_FAILED" }),
    );
    expect(() => createSignedBridgeResponse({
      operation: "outbox.authorize-send",
      requestNonce: "request-nonce-a",
      binding,
      body: { version: 1, status: "AUTHORIZED" },
      secret,
      now,
      ttlMs: 5_001,
    })).toThrowError();
  });
});
