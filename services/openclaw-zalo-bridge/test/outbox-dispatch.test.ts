import { describe, expect, it } from "vitest";

import {
  evaluateMarker,
  isTerminal,
  MARKER_MAX_TTL_MS,
  mayRetryAutomatically,
  nextState,
  type MarkerFields,
} from "../src/outbox/state-machine.js";

const NOW = 1_785_062_400_000;

const marker: MarkerFields = {
  version: 1,
  outboxId: "dddd8000-0000-4000-8000-000000000001",
  claimGeneration: 3,
  payloadHash: "a".repeat(64),
  fencingToken: 7,
  sessionGeneration: 5,
  controlVersion: 2,
  takeoverVersion: 1,
  markerNonce: "dddd7000-0000-4000-8000-000000000001",
  expiresAt: new Date(NOW + 10_000).toISOString(),
};

function check(overrides: Record<string, unknown> = {}) {
  return evaluateMarker({
    marker,
    nowEpochMs: NOW,
    leaseExpiresAtEpochMs: NOW + 30_000,
    expectedPayloadSha256: marker.payloadHash,
    currentFencingToken: marker.fencingToken,
    currentSessionGeneration: marker.sessionGeneration,
    currentControlVersion: marker.controlVersion,
    currentTakeoverVersion: marker.takeoverVersion,
    nonceAlreadyConsumed: false,
    ...overrides,
  } as Parameters<typeof evaluateMarker>[0]);
}

describe("Outbox state machine", () => {
  it("claims queued work into a lease", () => {
    expect(nextState("QUEUED", "CLAIM")).toBe("LEASED");
  });

  it("reclaims an expired lease back to the queue", () => {
    expect(nextState("LEASED", "LEASE_EXPIRED")).toBe("QUEUED");
  });

  it("enters DISPATCHING only through a won authorization", () => {
    expect(nextState("LEASED", "AUTHORIZED")).toBe("DISPATCHING");
    expect(nextState("QUEUED", "AUTHORIZED")).toBeNull();
  });

  it("never returns DISPATCHING to QUEUED", () => {
    for (const reason of [
      "CLAIM",
      "LEASE_EXPIRED",
      "PRE_HANDOFF_FAILURE",
      "AUTHORIZED",
      "CANCELLED",
    ] as const) {
      expect(nextState("DISPATCHING", reason), reason).not.toBe("QUEUED");
    }
  });

  it("requeues only a proven pre-handoff failure", () => {
    expect(nextState("LEASED", "PRE_HANDOFF_FAILURE")).toBe("QUEUED");
    expect(nextState("DISPATCHING", "PRE_HANDOFF_FAILURE")).toBeNull();
  });

  it("turns every unresolved dispatch into UNKNOWN", () => {
    expect(nextState("DISPATCHING", "POST_HANDOFF_TIMEOUT")).toBe("UNKNOWN");
    expect(nextState("DISPATCHING", "CRASH_IN_DISPATCHING")).toBe("UNKNOWN");
    expect(nextState("DISPATCHING", "SWEEPER_UNRESOLVED")).toBe("UNKNOWN");
  });

  it("records provider success and rejection distinctly", () => {
    expect(nextState("DISPATCHING", "PROVIDER_SUCCESS")).toBe("SENT");
    expect(nextState("DISPATCHING", "PROVIDER_REJECT")).toBe("FAILED");
  });

  it("treats UNKNOWN as terminal and never auto-retryable", () => {
    expect(isTerminal("UNKNOWN")).toBe(true);
    expect(mayRetryAutomatically("UNKNOWN")).toBe(false);
    for (const reason of ["CLAIM", "AUTHORIZED", "PROVIDER_SUCCESS"] as const) {
      expect(nextState("UNKNOWN", reason), reason).toBeNull();
    }
  });

  it("never leaves a terminal state", () => {
    for (const state of ["SENT", "FAILED", "CANCELLED", "UNKNOWN"] as const) {
      expect(isTerminal(state)).toBe(true);
      expect(nextState(state, "CLAIM")).toBeNull();
    }
  });
});

describe("Authorization marker revalidation", () => {
  it("accepts a complete, fresh, matching marker", () => {
    expect(check()).toEqual({ ok: true });
  });

  it("rejects a marker missing any required field", () => {
    for (const field of Object.keys(marker) as Array<keyof MarkerFields>) {
      const partial = { ...marker };
      delete partial[field];
      expect(check({ marker: partial }).failure, field).toBe("MARKER_INCOMPLETE");
    }
  });

  it("caps the marker TTL at fifteen seconds and at the lease", () => {
    expect(MARKER_MAX_TTL_MS).toBe(15_000);
    expect(check({ marker: { ...marker, expiresAt: new Date(NOW + 15_000).toISOString() } })).toEqual({ ok: true });
    expect(check({ marker: { ...marker, expiresAt: new Date(NOW + 15_001).toISOString() } }).failure)
      .toBe("MARKER_TTL_TOO_LONG");
    expect(
      check({
        marker: { ...marker, expiresAt: new Date(NOW + 12_000).toISOString() },
        leaseExpiresAtEpochMs: NOW + 11_000,
      }).failure,
    ).toBe("MARKER_BEYOND_LEASE");
  });

  it("rejects an expired marker", () => {
    expect(check({ nowEpochMs: NOW + 10_000 }).failure).toBe("MARKER_EXPIRED");
  });

  it("rejects a replayed marker nonce", () => {
    expect(check({ nonceAlreadyConsumed: true }).failure).toBe("MARKER_REPLAYED");
  });

  it("rejects a payload hash that no longer matches", () => {
    expect(check({ expectedPayloadSha256: "b".repeat(64) }).failure)
      .toBe("MARKER_PAYLOAD_MISMATCH");
  });

  it("rejects a stale fencing, session, control, or takeover version", () => {
    expect(check({ currentFencingToken: 8 }).failure).toBe("MARKER_STALE_VERSION");
    expect(check({ currentSessionGeneration: 6 }).failure).toBe("MARKER_STALE_VERSION");
    expect(check({ currentControlVersion: 3 }).failure).toBe("MARKER_STALE_VERSION");
    expect(check({ currentTakeoverVersion: 2 }).failure).toBe("MARKER_STALE_VERSION");
  });
});
