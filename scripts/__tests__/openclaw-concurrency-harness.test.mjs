import { describe, expect, it, vi } from "vitest";

import {
  CONCURRENCY_SCENARIOS,
  DEMO_ORG_ID,
  PROD_ORG_ID,
  buildNativePostgresPoolConfig,
  parseConcurrencyHarnessArgs,
  runConcurrencyHarness,
} from "../test-openclaw-concurrency.mjs";

describe("OpenClaw concurrency harness", () => {
  it("covers every bounded race and lost-response family", () => {
    expect(CONCURRENCY_SCENARIOS).toEqual(
      expect.arrayContaining([
        "OUTBOX_SINGLE_CLAIM",
        "WORK_SINGLE_CLAIM",
        "EXPIRED_LEASE_RECLAIM",
        "STALE_FENCE_REJECTED",
        "PRE_HANDOFF_REQUEUE",
        "UNKNOWN_SINGLE_WINNER",
        "DUPLICATE_SCHEDULE_MATERIALIZER",
        "CRM_FANOUT_IDEMPOTENCY",
        "RETENTION_QUARANTINE_HOLD_RACE",
        "RETENTION_FINAL_DELETE_HOLD_RACE",
        "RETENTION_QUARANTINE_R2_INDEPENDENT",
        "RETENTION_FINAL_DELETE_GRACE_BARRIER",
        "RETENTION_DUPLICATE_PHASE_MATERIALIZER",
        "FORGED_DELETE_RECEIPT",
        "AUTHENTICATED_NOT_FOUND_RECEIPT",
        "LOST_GATEWAY_RESPONSE_REPLAY",
        "LOST_DB_FINALIZATION",
        "FORGED_AUDIT_RECEIPT",
        "LOST_AUDIT_ACKNOWLEDGEMENT",
      ]),
    );
    expect(new Set(CONCURRENCY_SCENARIOS).size).toBe(CONCURRENCY_SCENARIOS.length);
  });

  it("backs every declared scenario with a database behavior proof", async () => {
    const harness = await import("../test-openclaw-concurrency.mjs");
    expect(harness.BEHAVIOR_PROVEN_SCENARIOS).toEqual(CONCURRENCY_SCENARIOS);
  });

  it("requires one explicit bounded execution mode", () => {
    expect(parseConcurrencyHarnessArgs(["--local"])).toEqual({
      mode: "local",
      workers: 8,
    });
    expect(parseConcurrencyHarnessArgs(["--local", "--workers", "16"])).toEqual({
      mode: "local",
      workers: 16,
    });
    expect(() => parseConcurrencyHarnessArgs([])).toThrow(/explicit/i);
    expect(() =>
      parseConcurrencyHarnessArgs(["--local", "--workers", "0"]),
    ).toThrow(/between 1 and 30/i);
    expect(() =>
      parseConcurrencyHarnessArgs(["--local", "--workers", "31"]),
    ).toThrow(/between 1 and 30/i);
  });

  it("authenticates every native PostgreSQL pool session at startup", () => {
    const config = buildNativePostgresPoolConfig({
      port: 5432,
      maxConnections: 4,
    });

    expect(config).toMatchObject({
      max: 4,
      options:
        "-c request.jwt.claim.sub=99999999-9999-4999-8999-999999999999",
    });
  });

  it("never targets PROD and always invokes cleanup in finally", async () => {
    const cleanup = vi.fn();
    const executeScenario = vi.fn(async ({ scenario }) => {
      if (scenario === "PRE_HANDOFF_REQUEUE") throw new Error("injected race failure");
    });
    await expect(
      runConcurrencyHarness({
        args: ["--local"],
        organizationId: PROD_ORG_ID,
        executeScenario,
        cleanup,
      }),
    ).rejects.toThrow(/PROD/i);
    expect(executeScenario).not.toHaveBeenCalled();

    await expect(
      runConcurrencyHarness({
        args: ["--local"],
        organizationId: DEMO_ORG_ID,
        executeScenario,
        cleanup,
      }),
    ).rejects.toThrow(/injected race failure/i);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("uses bounded independent SQL sessions for the default local races", async () => {
    const result = await runConcurrencyHarness({
      args: ["--local", "--workers", "4"],
    });
    expect(result.transport).toMatchObject({
      kind: "native-postgres",
      maxConnections: 4,
      independentSessions: true,
      contentionBarrier: "advisory-lock",
      distinctBackendPids: true,
    });
    expect(result.transport.barrierPasses).toBeGreaterThanOrEqual(6);
    expect(result.completed).toEqual(CONCURRENCY_SCENARIOS);
  }, 30_000);

  it("propagates cleanup failures after attempting every native resource", async () => {
    const harness = await import("../test-openclaw-concurrency.mjs");
    const pool = {
      end: vi.fn(async () => {
        throw new Error("pool cleanup failed");
      }),
    };
    const postgres = { stop: vi.fn(async () => {}) };
    await expect(
      harness.defaultCleanup({ shared: { pool, postgres } }),
    ).rejects.toThrow(/pool cleanup failed/i);
    expect(pool.end).toHaveBeenCalledOnce();
    expect(postgres.stop).toHaveBeenCalledOnce();
  });
});
