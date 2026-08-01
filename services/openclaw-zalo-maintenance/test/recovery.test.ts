import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer as createNetServer } from "node:net";
import { describe, expect, it, vi } from "vitest";

import {
  closeMaintenanceHealthServer,
  createMaintenanceHealthServer,
  createMaintenanceHealthState,
  maintenanceHealthResponse,
} from "../src/health.js";
import {
  createMediaGatewayClient,
  MediaGatewayError,
  processMaintenanceBatch,
  readMaintenanceProcessConfiguration,
  readSecretFile,
  runMaintenanceLoop,
  startMaintenanceProcess,
} from "../src/main.js";
import { canonicalJson, sha256Hex } from "../src/runtime-client.js";
import {
  runRetentionWork,
  type MaintenanceWorkClaimV1,
} from "../src/retention-runner.js";
import { MaintenanceRetryableWorkError } from "../src/work-error.js";
import { validateRuntimeRequestBody } from "../../../supabase/functions/openclaw-runtime/contracts.js";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const MAINTENANCE_ID = "dddd3000-0000-4000-8000-000000000001";
const CLAIM_TOKEN = "claim-token-0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-08-01T00:00:00.000Z");
const NO_UNRESOLVED_FAILURES = Object.freeze({ retentionDelete: 0, auditAnchor: 0 });

function claimBatch(
  items: readonly unknown[],
  unresolvedFailures = NO_UNRESOLVED_FAILURES,
) {
  return { version: 1, items, unresolvedFailures } as const;
}

function failureRecorded(body: unknown) {
  const request = body as {
    workItemId: string;
    claimGeneration?: number;
    recoveryGeneration?: number;
    outcome: "RETRY" | "FAILED" | "DEAD_LETTER";
    evidenceHash: string;
  };
  const binding = request.recoveryGeneration === undefined
    ? { claimGeneration: request.claimGeneration }
    : { recoveryGeneration: request.recoveryGeneration };
  return {
    version: 1,
    state: "FAILURE_RECORDED",
    workItemId: request.workItemId,
    ...binding,
    outcome: request.outcome === "RETRY" ? "SAFE_RETRY" : request.outcome,
    canonicalEvidenceHash: request.evidenceHash,
    completedAt: request.outcome === "RETRY" ? null : "2026-08-01T00:00:01+00:00",
    retryNotBefore: request.outcome === "RETRY" ? "2026-08-01T00:00:05+00:00" : null,
  } as const;
}

async function unusedTcpPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new TypeError("test port is unavailable");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function baseClaim(index: number): Omit<MaintenanceWorkClaimV1, "payload"> {
  return {
    version: 1,
    workItemId: `dddd8000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    organizationId: ORGANIZATION_ID,
    maintenancePrincipalId: MAINTENANCE_ID,
    credentialGeneration: 2,
    leaseGeneration: 3,
    sourceKey: `source:${index}`,
    claimToken: CLAIM_TOKEN,
    claimGeneration: 4,
    fencingToken: 5,
    leaseExpiresAt: "2026-08-01T00:01:00.000Z",
  };
}

function retentionClaim(index: number): MaintenanceWorkClaimV1 {
  return {
    ...baseClaim(index),
    payload: {
      kind: "RETENTION_DELETE",
      deletePhase: "QUARANTINE",
      subjectKind: "MEDIA",
      subjectId: `dddd6000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      retentionVersion: 1,
      holdVersion: 0,
    },
  };
}

function auditClaim(index: number): MaintenanceWorkClaimV1 {
  const auditRootId = `aaaa7000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const merkleRootHash = "b".repeat(64);
  return {
    ...baseClaim(index),
    payload: {
      kind: "AUDIT_ANCHOR",
      auditRootId,
      rootDate: "2026-08-01",
      firstSequence: 1,
      lastSequence: 1,
      eventCount: 1,
      previousRootHash: null,
      merkleRootHash,
      rootHash: sha256Hex(
        "ihome-openclaw-audit-lineage-root-v1\0" + canonicalJson({
          version: 1,
          organizationId: ORGANIZATION_ID,
          rootDate: "2026-08-01",
          firstSequence: 1,
          lastSequence: 1,
          eventCount: 1,
          previousRootHash: null,
          merkleRootHash,
        }),
      ),
      auditSigningKeyGeneration: 6,
      auditSigningPublicKeyHash: "d".repeat(64),
      anchorKey: `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${auditRootId}.json`,
    },
  };
}

function retentionRecoveryClaim(index: number) {
  const workItemId = `dddd8000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const subjectId = `dddd6000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    version: 1,
    recoveryKind: "RETENTION_DELETE_AUTHORIZED",
    workItemId,
    organizationId: ORGANIZATION_ID,
    maintenancePrincipalId: MAINTENANCE_ID,
    credentialGeneration: 12,
    leaseGeneration: 13,
    fencingToken: 15,
    sourceKey: `RETENTION:MEDIA:${subjectId}:FINAL_DELETE`,
    claimToken: CLAIM_TOKEN,
    recoveryGeneration: 2,
    recoveryLeaseExpiresAt: "2026-08-01T00:01:00.000Z",
    frozenClaim: {
      maintenancePrincipalId: MAINTENANCE_ID,
      credentialGeneration: 2,
      leaseGeneration: 3,
      fencingToken: 5,
      claimGeneration: 4,
    },
    payload: {
      kind: "RETENTION_DELETE",
      deletePhase: "FINAL_DELETE",
      subjectKind: "MEDIA",
      subjectId,
      objectKey:
        `v1/org/${ORGANIZATION_ID}/account/dddd1000-0000-4000-8000-000000000001/` +
        "conversation/dddd4000-0000-4000-8000-000000000001/" +
        `message/dddd5000-0000-4000-8000-000000000001/media/${subjectId}/original`,
      retentionVersion: 1,
      holdVersion: 0,
      quarantineVersion: 1,
      finalDeleteNotBefore: "2026-07-31T23:59:59.000Z",
    },
    ticketId: "dddd7000-0000-4000-8000-000000000001",
    ticketHash: "a".repeat(64),
    ticket: {},
    authorizationHash: "b".repeat(64),
    authorization: {},
    authorizationExpiresAt: "2026-07-31T23:59:00.000Z",
    gatewayReceipt: null,
  } as const;
}

function auditRecoveryClaim(index: number) {
  const normal = auditClaim(index);
  return {
    version: 1,
    recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
    workItemId: normal.workItemId,
    organizationId: ORGANIZATION_ID,
    maintenancePrincipalId: MAINTENANCE_ID,
    credentialGeneration: 12,
    leaseGeneration: 13,
    fencingToken: 15,
    sourceKey: normal.sourceKey,
    claimToken: CLAIM_TOKEN,
    recoveryGeneration: 2,
    recoveryLeaseExpiresAt: "2026-08-01T00:01:00.000Z",
    frozenClaim: {
      maintenancePrincipalId: MAINTENANCE_ID,
      credentialGeneration: 2,
      leaseGeneration: 3,
      fencingToken: 5,
      claimGeneration: 4,
    },
    payload: normal.payload,
    verifyTicketId: "dddd7000-0000-4000-8000-000000000001",
    verifyTicketHash: "a".repeat(64),
    verifyTicket: {},
    gatewayReceipt: null,
  } as const;
}

describe("bounded maintenance worker", () => {
  it("claims a bounded batch and routes only the two maintenance work kinds", async () => {
    const items = [retentionClaim(1), auditClaim(2), retentionClaim(3), auditClaim(4)];
    const runtime = {
      post: vi.fn().mockResolvedValue(claimBatch(items)),
    };
    let active = 0;
    let maximumActive = 0;
    const handled: string[] = [];
    const runner = async (claim: MaintenanceWorkClaimV1) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      handled.push(`${claim.payload.kind}:${claim.workItemId}`);
      await Promise.resolve();
      active -= 1;
      return { version: 1 };
    };
    const health = createMaintenanceHealthState({ staleAfterMs: 90_000 });

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 8,
      leaseSeconds: 47,
      concurrency: 4,
      runRetention: runner,
      runAudit: runner,
      health,
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 4, completed: 4, failed: 0 });

    expect(runtime.post).toHaveBeenCalledWith("/v1/maintenance/work/claim", {
      version: 1,
      claimToken: CLAIM_TOKEN,
      limit: 4,
      leaseSeconds: 47,
      requestedKinds: ["RETENTION_DELETE", "AUDIT_ANCHOR"],
    });
    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(handled).toHaveLength(4);
    expect(health.snapshot(NOW)).toEqual({
      retentionReady: true,
      auditReady: true,
      runtimeReachable: true,
      stale: false,
    });
  });

  it("claims only one immediately runnable item for limit 25 and concurrency 1", async () => {
    const item = auditClaim(1);
    const runtime = { post: vi.fn().mockResolvedValue(claimBatch([item])) };
    const runAudit = vi.fn().mockResolvedValue({ version: 1 });

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 25,
      leaseSeconds: 60,
      concurrency: 1,
      runRetention: vi.fn(),
      runAudit,
      health: createMaintenanceHealthState(),
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 1, completed: 1, failed: 0 });

    expect(runtime.post).toHaveBeenCalledWith("/v1/maintenance/work/claim", {
      version: 1,
      claimToken: CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 60,
      requestedKinds: ["RETENTION_DELETE", "AUDIT_ANCHOR"],
    });
  });

  it("uses a valid 47-second lease when processMaintenanceBatch omits the option", async () => {
    const runtime = { post: vi.fn().mockResolvedValue(claimBatch([])) };

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      concurrency: 1,
      runRetention: vi.fn(),
      runAudit: vi.fn(),
      health: createMaintenanceHealthState(),
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 0, completed: 0, failed: 0 });

    expect(runtime.post).toHaveBeenCalledWith("/v1/maintenance/work/claim", {
      version: 1,
      claimToken: CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      requestedKinds: ["RETENTION_DELETE", "AUDIT_ANCHOR"],
    });
  });

  it("accepts SQL-shaped RFC3339 offsets in normal and recovery claims without rewriting them", async () => {
    const normal = {
      ...baseClaim(1),
      leaseExpiresAt: "2026-08-01T07:01:00+07:00",
      payload: {
        ...retentionRecoveryClaim(1).payload,
        finalDeleteNotBefore: "2026-08-01T06:59:59+07:00",
      },
    };
    const retentionRecovery = {
      ...retentionRecoveryClaim(2),
      recoveryLeaseExpiresAt: "2026-08-01T07:01:00+07:00",
      authorizationExpiresAt: "2026-08-01T06:59:00+07:00",
      payload: {
        ...retentionRecoveryClaim(2).payload,
        finalDeleteNotBefore: "2026-08-01T06:59:59+07:00",
      },
    };
    const auditRecovery = {
      ...auditRecoveryClaim(3),
      recoveryLeaseExpiresAt: "2026-08-01T00:01:00+00:00",
    };
    const runRetention = vi.fn().mockResolvedValue({ version: 1 });
    const runAudit = vi.fn().mockResolvedValue({ version: 1 });

    await expect(processMaintenanceBatch({
      runtime: {
        post: vi.fn().mockResolvedValue(claimBatch([normal, retentionRecovery, auditRecovery])),
      },
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 3,
      leaseSeconds: 47,
      concurrency: 3,
      runRetention,
      runAudit,
      health: createMaintenanceHealthState(),
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 3, completed: 3, failed: 0 });

    expect(runRetention.mock.calls[0]?.[0]).toMatchObject({
      leaseExpiresAt: "2026-08-01T07:01:00+07:00",
      payload: { finalDeleteNotBefore: "2026-08-01T06:59:59+07:00" },
    });
    expect(runRetention.mock.calls[1]?.[0]).toMatchObject({
      recoveryLeaseExpiresAt: "2026-08-01T07:01:00+07:00",
      authorizationExpiresAt: "2026-08-01T06:59:00+07:00",
      payload: { finalDeleteNotBefore: "2026-08-01T06:59:59+07:00" },
    });
    expect(runAudit).toHaveBeenCalledWith(expect.objectContaining({
      recoveryLeaseExpiresAt: "2026-08-01T00:01:00+00:00",
    }));
  });

  it("isolates a failed work item and continues the rest of the claimed batch", async () => {
    const runtime = {
      post: vi.fn(async (path: string, body: unknown) => path.endsWith("/claim")
        ? claimBatch([retentionClaim(1), auditClaim(2), retentionClaim(3)])
        : failureRecorded(body)),
    };
    const handled: string[] = [];

    const result = await processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 3,
      leaseSeconds: 47,
      concurrency: 3,
      runRetention: async (claim) => {
        handled.push(claim.workItemId);
        if (claim.workItemId.endsWith("000000000001")) throw new Error("one job failed");
        return { version: 1 };
      },
      runAudit: async (claim) => {
        handled.push(claim.workItemId);
        return { version: 1 };
      },
      health: createMaintenanceHealthState(),
      now: () => NOW,
    });

    expect(result).toEqual({ version: 1, claimed: 3, completed: 2, failed: 1 });
    expect(handled).toHaveLength(3);
  });

  it.each([
    {
      name: "local invariant",
      error: new TypeError("invalid signed artifact"),
      expectedOutcome: "DEAD_LETTER",
      expectedReasonCode: "MAINTENANCE_WORK_DEAD_LETTER",
      expectedStatus: null,
    },
    {
      name: "permanent HTTP failure",
      error: Object.assign(new Error("forbidden"), { status: 403 }),
      expectedOutcome: "FAILED",
      expectedReasonCode: "MAINTENANCE_WORK_FAILED",
      expectedStatus: 403,
    },
    {
      name: "retryable HTTP failure",
      error: Object.assign(new Error("rate limited"), { status: 429 }),
      expectedOutcome: "RETRY",
      expectedReasonCode: "MAINTENANCE_WORK_RETRY",
      expectedStatus: 429,
    },
    {
      name: "unknown transport failure",
      error: new Error("socket closed"),
      expectedOutcome: "RETRY",
      expectedReasonCode: "MAINTENANCE_WORK_RETRY",
      expectedStatus: null,
    },
  ] as const)("records an exact $name outcome before returning from the batch", async ({
    error,
    expectedOutcome,
    expectedReasonCode,
    expectedStatus,
  }) => {
    const item = retentionClaim(1);
    const runtime = { post: vi.fn(async (path: string, body: unknown) => {
      if (path.endsWith("/claim")) return claimBatch([item]);
      const evidence = {
        version: 1,
        evidenceKind: "WORK_FAILURE",
        reasonCode: expectedReasonCode,
        failureFingerprint: sha256Hex(
          "ihome-openclaw-maintenance-failure-fingerprint-v1\0" + canonicalJson({
            workKind: "RETENTION_DELETE",
            errorName: error.name,
            statusOrNull: expectedStatus,
            reasonCode: expectedReasonCode,
          }),
        ),
      };
      const evidenceHash = sha256Hex(
        "ihome-openclaw-maintenance-work-failure-v1\0" + canonicalJson(evidence),
      );
      expect(body).toEqual({
        version: 1,
        workItemId: item.workItemId,
        organizationId: item.organizationId,
        maintenancePrincipalId: item.maintenancePrincipalId,
        credentialGeneration: item.credentialGeneration,
        leaseGeneration: item.leaseGeneration,
        fencingToken: item.fencingToken,
        claimToken: item.claimToken,
        claimGeneration: item.claimGeneration,
        outcome: expectedOutcome,
        evidence,
        evidenceHash,
        retryAfterSeconds: expectedOutcome === "RETRY" ? 5 : null,
      });
      return {
        version: 1,
        state: "FAILURE_RECORDED",
        workItemId: item.workItemId,
        claimGeneration: item.claimGeneration,
        outcome: expectedOutcome === "RETRY" ? "SAFE_RETRY" : expectedOutcome,
        canonicalEvidenceHash: evidenceHash,
        completedAt: expectedOutcome === "RETRY" ? null : "2026-08-01T00:00:01+00:00",
        retryNotBefore: expectedOutcome === "RETRY" ? "2026-08-01T00:00:05+00:00" : null,
      };
    }) };
    const health = createMaintenanceHealthState();

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      concurrency: 1,
      runRetention: vi.fn().mockRejectedValue(error),
      runAudit: vi.fn(),
      health,
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 1, completed: 0, failed: 1 });

    expect(runtime.post).toHaveBeenCalledTimes(2);
    expect(health.snapshot(NOW)).toMatchObject({
      retentionReady: false,
      runtimeReachable: true,
    });
  });

  it("records an exact RETRY completion for an audit-specific retryable error", async () => {
    const item = auditClaim(1);
    const error = new MaintenanceRetryableWorkError("audit signing key generation mismatch");
    const evidence = {
      version: 1,
      evidenceKind: "WORK_FAILURE",
      reasonCode: "MAINTENANCE_WORK_RETRY",
      failureFingerprint: sha256Hex(
        "ihome-openclaw-maintenance-failure-fingerprint-v1\0" + canonicalJson({
          workKind: "AUDIT_ANCHOR",
          errorName: error.name,
          statusOrNull: null,
          reasonCode: "MAINTENANCE_WORK_RETRY",
        }),
      ),
    };
    const evidenceHash = sha256Hex(
      "ihome-openclaw-maintenance-work-failure-v1\0" + canonicalJson(evidence),
    );
    const runtime = { post: vi.fn(async (path: string, body: unknown) => {
      if (path.endsWith("/claim")) return claimBatch([item]);
      expect(validateRuntimeRequestBody(path, body)).toBe(true);
      expect(body).toEqual({
        version: 1,
        workItemId: item.workItemId,
        organizationId: item.organizationId,
        maintenancePrincipalId: item.maintenancePrincipalId,
        credentialGeneration: item.credentialGeneration,
        leaseGeneration: item.leaseGeneration,
        fencingToken: item.fencingToken,
        claimToken: item.claimToken,
        claimGeneration: item.claimGeneration,
        outcome: "RETRY",
        evidence,
        evidenceHash,
        retryAfterSeconds: 5,
      });
      return failureRecorded(body);
    }) };

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      concurrency: 1,
      runRetention: vi.fn(),
      runAudit: vi.fn().mockRejectedValue(error),
      health: createMaintenanceHealthState(),
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 1, completed: 0, failed: 1 });

    expect(runtime.post).toHaveBeenCalledTimes(2);
  });

  it("reports a recovery failure with current admission and exact frozen lineage", async () => {
    const item = retentionRecoveryClaim(1);
    const runtime = { post: vi.fn(async (path: string, body: unknown) => {
      if (path.endsWith("/claim")) return claimBatch([item]);
      expect(Object.keys(body as Record<string, unknown>).sort()).toEqual([
        "version", "workItemId", "organizationId", "maintenancePrincipalId",
        "credentialGeneration", "leaseGeneration", "fencingToken", "claimToken",
        "recoveryKind", "recoveryGeneration", "frozenClaim", "outcome", "evidence",
        "evidenceHash", "retryAfterSeconds",
      ].sort());
      expect(body).toMatchObject({
        version: 1,
        recoveryKind: "RETENTION_DELETE_AUTHORIZED",
        workItemId: item.workItemId,
        maintenancePrincipalId: item.maintenancePrincipalId,
        credentialGeneration: item.credentialGeneration,
        leaseGeneration: item.leaseGeneration,
        fencingToken: item.fencingToken,
        recoveryGeneration: item.recoveryGeneration,
        frozenClaim: item.frozenClaim,
        outcome: "DEAD_LETTER",
        retryAfterSeconds: null,
      });
      expect(body).not.toHaveProperty("claimGeneration");
      const request = body as { evidenceHash: string };
      return {
        version: 1,
        state: "FAILURE_RECORDED",
        workItemId: item.workItemId,
        recoveryGeneration: item.recoveryGeneration,
        outcome: "DEAD_LETTER",
        canonicalEvidenceHash: request.evidenceHash,
        completedAt: "2026-08-01T00:00:01+00:00",
        retryNotBefore: null,
      };
    }) };

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      concurrency: 1,
      runRetention: vi.fn().mockRejectedValue(new TypeError("frozen lineage invalid")),
      runAudit: vi.fn(),
      health: createMaintenanceHealthState(),
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 1, completed: 0, failed: 1 });

    expect(runtime.post).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "remaining lease budget",
      leaseExpiresAt: "2026-08-01T00:00:01+00:00",
      finalDeleteNotBefore: "2026-07-31T23:59:59+00:00",
    },
    {
      name: "retention grace period",
      leaseExpiresAt: "2026-08-01T00:01:00+00:00",
      finalDeleteNotBefore: "2026-08-01T00:00:30+00:00",
    },
  ])("records transient $name failures as RETRY instead of dead-letter", async ({
    leaseExpiresAt,
    finalDeleteNotBefore,
  }) => {
    const item = {
      ...baseClaim(9),
      leaseExpiresAt,
      payload: {
        ...retentionRecoveryClaim(9).payload,
        finalDeleteNotBefore,
      },
    };
    let failureBody: unknown;
    const runtime = { post: vi.fn(async (path: string, body: unknown) => {
      if (path.endsWith("/claim")) return claimBatch([item]);
      failureBody = body;
      return failureRecorded(body);
    }) };

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      concurrency: 1,
      runRetention: (claim) => runRetentionWork({
        claim,
        runtime,
        gateway: { deleteObject: vi.fn() },
        now: () => NOW,
      }),
      runAudit: vi.fn(),
      health: createMaintenanceHealthState(),
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 1, completed: 0, failed: 1 });

    expect(runtime.post).toHaveBeenCalledTimes(2);
    expect(failureBody).toMatchObject({
      outcome: "RETRY",
      retryAfterSeconds: 5,
      evidence: { reasonCode: "MAINTENANCE_WORK_RETRY" },
    });
  });

  it("routes an exact authorized-delete recovery claim to the retention runner", async () => {
    const recovery = retentionRecoveryClaim(1);
    const runRetention = vi.fn().mockResolvedValue({ version: 1 });
    const runAudit = vi.fn();

    await expect(processMaintenanceBatch({
      runtime: { post: vi.fn().mockResolvedValue(claimBatch([recovery])) },
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 60,
      concurrency: 1,
      runRetention,
      runAudit,
      health: createMaintenanceHealthState(),
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 1, completed: 1, failed: 0 });

    expect(runRetention).toHaveBeenCalledWith(recovery);
    expect(runAudit).not.toHaveBeenCalled();
  });

  it("routes an exact audit verify recovery claim to the audit runner", async () => {
    const recovery = auditRecoveryClaim(2);
    const runRetention = vi.fn();
    const runAudit = vi.fn().mockResolvedValue({ version: 1 });

    await expect(processMaintenanceBatch({
      runtime: { post: vi.fn().mockResolvedValue(claimBatch([recovery])) },
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 60,
      concurrency: 1,
      runRetention,
      runAudit,
      health: createMaintenanceHealthState(),
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 1, completed: 1, failed: 0 });

    expect(runAudit).toHaveBeenCalledWith(recovery);
    expect(runRetention).not.toHaveBeenCalled();
  });

  it("fails only the broken dependency readiness and logs a redacted item error", async () => {
    const secret = "claim-token-must-never-be-logged";
    const logs: string[] = [];
    const health = createMaintenanceHealthState();

    await expect(processMaintenanceBatch({
      runtime: {
        post: vi.fn(async (path: string, body: unknown) => path.endsWith("/claim")
          ? claimBatch([retentionClaim(1), auditClaim(2)])
          : failureRecorded(body)),
      },
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 2,
      leaseSeconds: 60,
      concurrency: 2,
      runRetention: async () => {
        throw new Error(`permanent gateway failure ${secret}`);
      },
      runAudit: async () => ({ version: 1 }),
      health,
      now: () => NOW,
      log: (line) => logs.push(line),
    })).resolves.toEqual({ version: 1, claimed: 2, completed: 1, failed: 1 });

    expect(health.snapshot(NOW)).toMatchObject({
      retentionReady: false,
      auditReady: true,
      runtimeReachable: true,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"event":"maintenance_work_failed"');
    expect(logs[0]).toContain('"workKind":"RETENTION_DELETE"');
    expect(logs[0]).not.toContain(secret);
  });

  it("keeps same-kind readiness failed for mixed results", async () => {
    const health = createMaintenanceHealthState();

    await expect(processMaintenanceBatch({
      runtime: {
        post: vi.fn(async (path: string, body: unknown) => path.endsWith("/claim")
          ? claimBatch([retentionClaim(1), retentionClaim(2)])
          : failureRecorded(body)),
      },
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 2,
      leaseSeconds: 47,
      concurrency: 2,
      runRetention: async (item) => {
        if (item.workItemId.endsWith("000000000001")) throw new Error("permanent failure");
        return { version: 1 };
      },
      runAudit: vi.fn(),
      health,
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 2, completed: 1, failed: 1 });

    expect(health.snapshot(NOW)).toMatchObject({
      retentionReady: false,
      auditReady: false,
      runtimeReachable: true,
    });
  });

  it("reconstructs unresolved readiness after restart from authoritative claim counts", async () => {
    const healthAfterRestart = createMaintenanceHealthState();
    const runtime = {
      post: vi.fn()
        .mockResolvedValueOnce(claimBatch(
          [retentionClaim(2)],
          { retentionDelete: 1, auditAnchor: 0 },
        ))
        .mockResolvedValueOnce(claimBatch([], { retentionDelete: 0, auditAnchor: 0 })),
    };

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      concurrency: 1,
      runRetention: vi.fn().mockResolvedValue({ version: 1 }),
      runAudit: vi.fn(),
      health: healthAfterRestart,
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 1, completed: 1, failed: 0 });

    expect(healthAfterRestart.snapshot(NOW).retentionReady).toBe(false);

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      concurrency: 1,
      runRetention: vi.fn(),
      runAudit: vi.fn(),
      health: healthAfterRestart,
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 0, completed: 0, failed: 0 });

    expect(healthAfterRestart.snapshot(NOW).retentionReady).toBe(true);
  });

  it("keeps an unreported local failure red until that exact item later succeeds", async () => {
    const first = retentionClaim(1);
    const other = retentionClaim(2);
    const claims = [claimBatch([first]), claimBatch([other]), claimBatch([first])];
    const runtime = { post: vi.fn(async (path: string) => {
      if (path.endsWith("/claim")) return claims.shift();
      throw new Error("failure report transport lost");
    }) };
    const health = createMaintenanceHealthState();
    let firstAttempt = true;
    const runRetention = vi.fn(async (item: MaintenanceWorkClaimV1) => {
      if (item.workItemId === first.workItemId && firstAttempt) {
        firstAttempt = false;
        throw new Error("gateway unavailable");
      }
      return { version: 1 };
    });
    const runBatch = () => processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      concurrency: 1,
      runRetention,
      runAudit: vi.fn(),
      health,
      now: () => NOW,
    });

    await expect(runBatch()).resolves.toEqual({
      version: 1, claimed: 1, completed: 0, failed: 1,
    });
    expect(health.snapshot(NOW).runtimeReachable).toBe(false);

    await expect(runBatch()).resolves.toEqual({
      version: 1, claimed: 1, completed: 1, failed: 0,
    });
    expect(health.snapshot(NOW)).toMatchObject({
      retentionReady: false,
      runtimeReachable: true,
    });

    await expect(runBatch()).resolves.toEqual({
      version: 1, claimed: 1, completed: 1, failed: 0,
    });
    expect(health.snapshot(NOW).retentionReady).toBe(true);
  });

  it("moves an exact local failure into authoritative state when a later report succeeds", async () => {
    const failedItem = retentionClaim(1);
    const successfulItem = retentionClaim(2);
    const claims = [
      claimBatch([failedItem]),
      claimBatch([failedItem]),
      claimBatch([successfulItem], { retentionDelete: 0, auditAnchor: 0 }),
    ];
    let rejectFirstReport = true;
    const runtime = { post: vi.fn(async (path: string, body: unknown) => {
      if (path.endsWith("/claim")) return claims.shift();
      if (rejectFirstReport) {
        rejectFirstReport = false;
        throw new Error("first report lost");
      }
      return failureRecorded(body);
    }) };
    const health = createMaintenanceHealthState();
    const runBatch = (runRetention: (item: MaintenanceWorkClaimV1) => Promise<unknown>) =>
      processMaintenanceBatch({
        runtime,
        claimTokenFactory: () => CLAIM_TOKEN,
        limit: 1,
        leaseSeconds: 47,
        concurrency: 1,
        runRetention,
        runAudit: vi.fn(),
        health,
        now: () => NOW,
      });

    await runBatch(async () => { throw new Error("unreported failure"); });
    await runBatch(async () => { throw new TypeError("reported dead-letter"); });
    await runBatch(async () => ({ version: 1 }));

    expect(health.snapshot(NOW)).toMatchObject({
      retentionReady: true,
      runtimeReachable: true,
    });
  });

  it("does not record a false work failure when process shutdown aborts the batch", async () => {
    const controller = new AbortController();
    const runtime = { post: vi.fn().mockResolvedValue(claimBatch([retentionClaim(1)])) };
    const logs: string[] = [];

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      concurrency: 1,
      runRetention: vi.fn(async () => {
        controller.abort();
        throw new DOMException("shutdown", "AbortError");
      }),
      runAudit: vi.fn(),
      health: createMaintenanceHealthState(),
      signal: controller.signal,
      now: () => NOW,
      log: (line) => logs.push(line),
    })).resolves.toEqual({ version: 1, claimed: 1, completed: 0, failed: 1 });

    expect(runtime.post).toHaveBeenCalledOnce();
    expect(logs).toEqual([expect.stringContaining('"event":"maintenance_work_aborted"')]);
  });

  it("rejects non-integer unresolved failure counts", async () => {
    await expect(processMaintenanceBatch({
      runtime: {
        post: vi.fn().mockResolvedValue(claimBatch([], {
          retentionDelete: -1,
          auditAnchor: 0,
        })),
      },
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      concurrency: 1,
      runRetention: vi.fn(),
      runAudit: vi.fn(),
      health: createMaintenanceHealthState(),
      now: () => NOW,
    })).rejects.toThrow(/unresolved failure/i);
  });

  it("does not mark an unprocessed work kind ready after a successful claim", async () => {
    const health = createMaintenanceHealthState();

    await expect(processMaintenanceBatch({
      runtime: { post: vi.fn().mockResolvedValue(claimBatch([retentionClaim(1)])) },
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      concurrency: 1,
      runRetention: async () => ({ version: 1 }),
      runAudit: vi.fn(),
      health,
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 1, completed: 1, failed: 0 });

    expect(health.snapshot(NOW)).toEqual({
      retentionReady: true,
      auditReady: false,
      runtimeReachable: true,
      stale: false,
    });
  });

  it("rejects a configured lease that cannot also cover a bounded failure report", async () => {
    const runtime = { post: vi.fn() };

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 46,
      concurrency: 1,
      runRetention: vi.fn(),
      runAudit: vi.fn(),
      health: createMaintenanceHealthState(),
      now: () => NOW,
    })).rejects.toThrow(/lease seconds/i);

    expect(runtime.post).not.toHaveBeenCalled();
  });

  it("reserves failure-report time after a 10-second claim and 31-second audit envelope", async () => {
    let clock = NOW;
    const claimed = {
      ...auditClaim(1),
      leaseExpiresAt: new Date(NOW.getTime() + 47_000).toISOString(),
    };
    const runtime = { post: vi.fn(async () => {
      clock = new Date(NOW.getTime() + 11_000);
      return claimBatch([claimed]);
    }) };
    const runAudit = vi.fn(async (item: MaintenanceWorkClaimV1) => {
      expect(Date.parse(item.leaseExpiresAt) - clock.getTime()).toBe(36_000);
      return { version: 1 };
    });

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      concurrency: 1,
      runRetention: vi.fn(),
      runAudit,
      health: createMaintenanceHealthState(),
      now: () => clock,
    })).resolves.toEqual({ version: 1, claimed: 1, completed: 1, failed: 0 });

    expect(runtime.post).toHaveBeenCalledWith("/v1/maintenance/work/claim", {
      version: 1,
      claimToken: CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      requestedKinds: ["RETENTION_DELETE", "AUDIT_ANCHOR"],
    });
  });

  it("reports a late runner failure while the reserved five-second envelope is still live", async () => {
    let clock = NOW;
    const item = {
      ...retentionClaim(1),
      leaseExpiresAt: new Date(NOW.getTime() + 47_000).toISOString(),
    };
    const health = createMaintenanceHealthState();
    const runtime = { post: vi.fn(async (
      path: string,
      body: unknown,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => {
      if (path.endsWith("/claim")) {
        clock = new Date(NOW.getTime() + 10_000);
        return claimBatch([item]);
      }
      expect(Date.parse(item.leaseExpiresAt) - clock.getTime()).toBe(6_000);
      expect(options?.signal?.aborted).toBe(false);
      return failureRecorded(body);
    }) };

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      concurrency: 1,
      runRetention: vi.fn(async () => {
        clock = new Date(NOW.getTime() + 41_000);
        throw new Error("late transport failure");
      }),
      runAudit: vi.fn(),
      health,
      now: () => clock,
    })).resolves.toEqual({ version: 1, claimed: 1, completed: 0, failed: 1 });

    expect(health.snapshot(clock)).toMatchObject({
      retentionReady: false,
      runtimeReachable: true,
    });
  });

  it("times out failure reporting within its bound and keeps local/runtime readiness red", async () => {
    const item = retentionClaim(1);
    const health = createMaintenanceHealthState();
    let reportSignal: AbortSignal | undefined;
    const runtime = { post: vi.fn(async (
      path: string,
      _body: unknown,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => {
      if (path.endsWith("/claim")) return claimBatch([item]);
      reportSignal = options?.signal;
      return await new Promise((_, reject) => {
        reportSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("timed out", "AbortError")),
          { once: true },
        );
      });
    }) };
    const startedAt = Date.now();

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 47,
      concurrency: 1,
      failureReportTimeoutMs: 25,
      runRetention: vi.fn().mockRejectedValue(new Error("gateway unavailable")),
      runAudit: vi.fn(),
      health,
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 1, completed: 0, failed: 1 });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(reportSignal?.aborted).toBe(true);
    expect(health.snapshot(NOW)).toMatchObject({
      retentionReady: false,
      runtimeReachable: false,
    });
  });

  it("dead-letters a safely bound invalid claim without suppressing valid retention work", async () => {
    const invalidClaim: MaintenanceWorkClaimV1 = {
      ...baseClaim(1),
      payload: {
        kind: "RETENTION_DELETE",
        deletePhase: "FINAL_DELETE",
        subjectKind: "MEDIA",
        subjectId: "dddd6000-0000-4000-8000-000000000001",
        objectKey:
          "v1/org/dddd0000-0000-4000-8000-000000000099/account/" +
          "dddd1000-0000-4000-8000-000000000001/conversation/" +
          "dddd4000-0000-4000-8000-000000000001/message/" +
          "dddd5000-0000-4000-8000-000000000001/media/" +
          "dddd6000-0000-4000-8000-000000000001/original",
        retentionVersion: 1,
        holdVersion: 0,
        quarantineVersion: 1,
        finalDeleteNotBefore: "2026-07-31T23:59:59.000Z",
      },
    };
    const validClaim = retentionClaim(2);
    const runRetention = vi.fn().mockResolvedValue({ version: 1 });
    const runtime = { post: vi.fn(async (path: string, body: unknown) => {
      if (path.endsWith("/claim")) return claimBatch([invalidClaim, validClaim]);
      expect(validateRuntimeRequestBody(path, body)).toBe(true);
      return failureRecorded(body);
    }) };
    const health = createMaintenanceHealthState();

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 2,
      leaseSeconds: 47,
      concurrency: 2,
      runRetention,
      runAudit: vi.fn(),
      health,
      now: () => NOW,
    })).resolves.toEqual({ version: 1, claimed: 2, completed: 1, failed: 1 });

    expect(runRetention).toHaveBeenCalledOnce();
    expect(runRetention).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: validClaim.workItemId,
    }));
    expect(runtime.post).toHaveBeenCalledTimes(2);
    expect(runtime.post.mock.calls[1]?.[1]).toMatchObject({
      version: 1,
      workItemId: invalidClaim.workItemId,
      claimGeneration: invalidClaim.claimGeneration,
      outcome: "DEAD_LETTER",
      evidence: {
        version: 1,
        evidenceKind: "WORK_FAILURE",
        reasonCode: "MAINTENANCE_WORK_DEAD_LETTER",
      },
      retryAfterSeconds: null,
    });
    expect(health.snapshot(NOW)).toMatchObject({
      retentionReady: false,
      runtimeReachable: true,
    });
  });

  it("dead-letters an audit lineage mismatch without suppressing valid retention work", async () => {
    const base = auditClaim(1);
    const invalidAuditClaim = {
      ...base,
      payload: { ...base.payload, rootHash: "f".repeat(64) },
    };
    const validClaim = retentionClaim(2);
    const runRetention = vi.fn().mockResolvedValue({ version: 1 });
    const runAudit = vi.fn().mockResolvedValue({ version: 1 });
    const runtime = { post: vi.fn(async (path: string, body: unknown) => {
      if (path.endsWith("/claim")) return claimBatch([invalidAuditClaim, validClaim]);
      expect(validateRuntimeRequestBody(path, body)).toBe(true);
      return failureRecorded(body);
    }) };

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 2,
      leaseSeconds: 47,
      concurrency: 2,
      runRetention,
      runAudit,
      health: createMaintenanceHealthState(),
      now: () => NOW,
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
    })).resolves.toEqual({ version: 1, claimed: 2, completed: 1, failed: 1 });

    expect(runAudit).not.toHaveBeenCalled();
    expect(runRetention).toHaveBeenCalledOnce();
    expect(runtime.post.mock.calls[1]?.[1]).toMatchObject({
      workItemId: invalidAuditClaim.workItemId,
      outcome: "DEAD_LETTER",
      evidence: { reasonCode: "MAINTENANCE_WORK_DEAD_LETTER" },
    });
  });

  it("attributes contradictory recovery payloads to the authoritative recovery capability", async () => {
    const recovery = retentionRecoveryClaim(1);
    const contradictoryRecovery = {
      ...recovery,
      payload: auditClaim(1).payload,
    };
    const health = createMaintenanceHealthState();
    const runRetention = vi.fn().mockResolvedValue({ version: 1 });
    const runAudit = vi.fn().mockResolvedValue({ version: 1 });
    const runtime = { post: vi.fn().mockResolvedValue(claimBatch([
      contradictoryRecovery,
      retentionClaim(2),
      auditClaim(3),
    ])) };

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 3,
      leaseSeconds: 47,
      concurrency: 3,
      runRetention,
      runAudit,
      health,
      now: () => NOW,
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
    })).resolves.toEqual({ version: 1, claimed: 3, completed: 2, failed: 1 });

    expect(runtime.post).toHaveBeenCalledOnce();
    expect(runRetention).toHaveBeenCalledOnce();
    expect(runAudit).toHaveBeenCalledOnce();
    expect(health.snapshot(NOW)).toMatchObject({
      retentionReady: false,
      auditReady: true,
      runtimeReachable: true,
    });
  });

  it.each([
    {
      name: "malformed work-item identity",
      invalidClaim: { ...retentionClaim(1), workItemId: "not-a-work-item-id" },
      sensitiveValue: "not-a-work-item-id",
    },
    {
      name: "foreign organization binding",
      invalidClaim: {
        ...retentionClaim(1),
        organizationId: "dddd0000-0000-4000-8000-000000000099",
      },
      sensitiveValue: "dddd0000-0000-4000-8000-000000000099",
    },
    {
      name: "mismatched claim token",
      invalidClaim: {
        ...retentionClaim(1),
        claimToken: "foreign-claim-token-0123456789abcdef0123456789",
      },
      sensitiveValue: "foreign-claim-token-0123456789abcdef0123456789",
    },
  ])("skips $name without fabricating a failure completion", async ({
    invalidClaim,
    sensitiveValue,
  }) => {
    const validClaim = retentionClaim(2);
    const runRetention = vi.fn().mockResolvedValue({ version: 1 });
    const runtime = { post: vi.fn().mockResolvedValue(claimBatch([
      invalidClaim,
      validClaim,
    ])) };
    const health = createMaintenanceHealthState();
    const logs: string[] = [];

    await expect(processMaintenanceBatch({
      runtime,
      claimTokenFactory: () => CLAIM_TOKEN,
      limit: 2,
      leaseSeconds: 47,
      concurrency: 2,
      runRetention,
      runAudit: vi.fn(),
      health,
      now: () => NOW,
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      log: (line) => logs.push(line),
    })).resolves.toEqual({ version: 1, claimed: 2, completed: 1, failed: 1 });

    expect(runRetention).toHaveBeenCalledOnce();
    expect(runRetention).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: validClaim.workItemId,
    }));
    expect(runtime.post).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([expect.stringContaining('"event":"maintenance_claim_item_invalid"')]);
    expect(logs[0]).not.toContain(sensitiveValue);
    expect(health.snapshot(NOW)).toMatchObject({
      retentionReady: false,
      runtimeReachable: true,
    });
  });

  it("stops its poll loop promptly when aborted", async () => {
    const controller = new AbortController();
    let batches = 0;
    const loop = runMaintenanceLoop({
      signal: controller.signal,
      pollIntervalMs: 60_000,
      runBatch: async () => {
        batches += 1;
        controller.abort();
        return { version: 1, claimed: 0, completed: 0, failed: 0 };
      },
    });

    await expect(loop).resolves.toBeUndefined();
    expect(batches).toBe(1);
  });

  it("boundedly drains even when an active batch ignores shutdown", async () => {
    const controller = new AbortController();
    const loop = runMaintenanceLoop({
      signal: controller.signal,
      pollIntervalMs: 60_000,
      runBatch: () => new Promise(() => {}),
    });
    controller.abort();

    const outcome = await Promise.race([
      loop.then(() => "stopped"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ]);
    expect(outcome).toBe("stopped");
  });

  it("removes each batch abort listener after the batch settles", async () => {
    const controller = new AbortController();
    const listenerCounts: number[] = [];
    let batches = 0;
    const loop = runMaintenanceLoop({
      signal: controller.signal,
      pollIntervalMs: 100,
      runBatch: async () => {
        batches += 1;
        listenerCounts.push(getEventListeners(controller.signal, "abort").length);
        if (batches === 3) controller.abort();
      },
    });

    await loop;
    expect(listenerCounts).toEqual([1, 1, 1]);
  });
});

describe("maintenance-only health", () => {
  it("reports live independently and readiness only from maintenance state", () => {
    const health = createMaintenanceHealthState({ staleAfterMs: 90_000 });
    expect(maintenanceHealthResponse("/livez", health, NOW)).toEqual({
      status: 200,
      body: { version: 1, live: true },
    });
    expect(maintenanceHealthResponse("/readyz", health, NOW).status).toBe(503);

    health.markRuntimeHealthy(NOW);
    expect(maintenanceHealthResponse("/readyz", health, NOW)).toEqual({
      status: 503,
      body: {
        version: 1,
        retentionReady: false,
        auditReady: false,
        runtimeReachable: true,
        stale: false,
      },
    });
    expect(JSON.stringify(maintenanceHealthResponse("/readyz", health, NOW)))
      .not.toMatch(/channel|account|cell|credential|token/i);
  });

  it("rejects startup configuration without the reserved failure-report envelope", () => {
    expect(() => readMaintenanceProcessConfiguration({
      OPENCLAW_FUNCTIONS_BASE_URL: "https://project.supabase.co/functions/v1/",
      OPENCLAW_MEDIA_GATEWAY_URL: "https://openclaw-media.chillhome.io.vn/",
      OPENCLAW_MAINTENANCE_ORGANIZATION_ID: ORGANIZATION_ID,
      OPENCLAW_MAINTENANCE_PRINCIPAL_ID: MAINTENANCE_ID,
      OPENCLAW_MAINTENANCE_CREDENTIAL_FILE: "C:\\secrets\\maintenance",
      OPENCLAW_AUDIT_PRIVATE_KEY_FILE: "C:\\secrets\\audit",
      OPENCLAW_AUDIT_SIGNING_KEY_GENERATION: "6",
      OPENCLAW_MAINTENANCE_LEASE_SECONDS: "46",
    })).toThrow(/OPENCLAW_MAINTENANCE_LEASE_SECONDS/);
  });

  it("fails readiness after runtime auth/network failure or stale claims", () => {
    const health = createMaintenanceHealthState({ staleAfterMs: 90_000 });
    health.markRuntimeHealthy(NOW);
    expect(health.snapshot(new Date(NOW.getTime() + 90_001)).stale).toBe(true);
    health.markRuntimeFailure();
    expect(health.snapshot(NOW).runtimeReachable).toBe(false);
  });

  it("force-closes a partial HTTP connection within the shutdown bound", async () => {
    const server = createMaintenanceHealthServer({ health: createMaintenanceHealthState() });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new TypeError("health address unavailable");
    const accepted = new Promise<void>((resolve) => server.once("connection", () => resolve()));
    const socket = connect(address.port, "127.0.0.1");
    await Promise.all([
      accepted,
      new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      }),
    ]);
    socket.write("GET /readyz HTTP/1.1\r\nHost: maintenance.invalid\r\n");
    const socketClosed = new Promise<boolean>((resolve) => {
      socket.once("close", () => resolve(true));
    });

    const outcome = await Promise.race([
      closeMaintenanceHealthServer(server, 25).then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 250)),
    ]);

    expect(outcome).toBe("closed");
    await expect(Promise.race([
      socketClosed,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ])).resolves.toBe(true);
    socket.destroy();
  });
});

describe("gateway transport and secret files", () => {
  it("binds every gateway fetch to the process shutdown signal", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const gateway = createMediaGatewayClient({
      baseUrl: "https://openclaw-media.chillhome.io.vn/",
      fetch,
      signal: controller.signal,
    });

    await gateway.verifyObject({ ticketHeader: "verify-header" });
    const requestSignal = fetch.mock.calls[0]?.[1]?.signal;
    controller.abort(new Error("maintenance shutdown"));

    expect(requestSignal?.aborted).toBe(true);
  });

  it("sends private gateway requests with exact sensitive headers and no redirects", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        status: "STORED",
        versionOrEtag: "v1",
      }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, receiptKind: "X" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, receiptKind: "Y" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const gateway = createMediaGatewayClient({
      baseUrl: "https://openclaw-media.chillhome.io.vn/",
      fetch,
    });
    const bytes = new TextEncoder().encode("{}");

    await gateway.putObject({ ticketHeader: "ticket-header", contentType: "application/json", bytes });
    await gateway.verifyObject({ ticketHeader: "verify-header" });
    await gateway.deleteObject({
      ticketHeader: "delete-header",
      deleteAuthorizationHeader: "authorization-header",
    });

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://openclaw-media.chillhome.io.vn/v1/object",
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      "https://openclaw-media.chillhome.io.vn/v1/object",
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["PUT", "POST", "DELETE"]);
    for (const [, init] of fetch.mock.calls) expect(init?.redirect).toBe("error");
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("x-openclaw-media-ticket"))
      .toBe("ticket-header");
    expect(new Headers(fetch.mock.calls[2]![1]?.headers).get("x-openclaw-delete-authorization"))
      .toBe("authorization-header");
  });

  it("rejects an oversized gateway response before consuming its body", async () => {
    const response = new Response("{}", {
      status: 200,
      headers: {
        "content-length": String(1_048_577),
        "content-type": "application/json",
      },
    });
    const text = vi.spyOn(response, "text")
      .mockRejectedValue(new Error("oversized body must not be consumed"));
    const gateway = createMediaGatewayClient({
      baseUrl: "https://openclaw-media.chillhome.io.vn/",
      fetch: vi.fn().mockResolvedValue(response),
    });

    await expect(gateway.verifyObject({ ticketHeader: "verify-header" }))
      .rejects.toThrow("response is too large");
    expect(text).not.toHaveBeenCalled();
  });

  it("sanitizes a gateway response-stream failure", async () => {
    const leaked = "sensitive-upstream-detail";
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(leaked));
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const gateway = createMediaGatewayClient({
      baseUrl: "https://openclaw-media.chillhome.io.vn/",
      fetch: vi.fn().mockResolvedValue(response),
    });

    const error = await gateway.verifyObject({ ticketHeader: "verify-header" })
      .catch((value: unknown) => value);
    expect(String(error)).toContain("response body failed");
    expect(String(error)).not.toContain(leaked);
  });

  it("preserves only the exact Gateway denial code needed for safe recovery refresh", async () => {
    const gateway = createMediaGatewayClient({
      baseUrl: "https://openclaw-media.chillhome.io.vn/",
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: { code: "TICKET_EXPIRED_NO_WORK" },
      }), {
        status: 410,
        headers: { "content-type": "application/json" },
      })),
    });

    const error = await gateway.verifyObject({ ticketHeader: "verify-header" })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(MediaGatewayError);
    expect(error).toMatchObject({ status: 410, code: "TICKET_EXPIRED_NO_WORK" });
    expect(String(error)).not.toContain("verify-header");
  });

  it("accepts only an absolute non-symlink 0400 single-line secret file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-maintenance-secret-"));
    try {
      const secretPath = join(directory, "credential");
      await writeFile(secretPath, "secret-value-0123456789abcdef0123456789", { mode: 0o400 });
      await chmod(secretPath, 0o400);
      await expect(readSecretFile(secretPath)).resolves
        .toBe("secret-value-0123456789abcdef0123456789");

      await chmod(secretPath, 0o600);
      await expect(readSecretFile(secretPath)).rejects.toThrow("mode 0400");
      await expect(readSecretFile("relative-secret")).rejects.toThrow("absolute");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an invalid audit PKCS8 key before listen, health, or Runtime I/O", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-maintenance-startup-"));
    let started: Awaited<ReturnType<typeof startMaintenanceProcess>> | null = null;
    try {
      const credentialPath = join(directory, "credential");
      const auditKeyPath = join(directory, "audit-key");
      await writeFile(
        credentialPath,
        "maintenance-root-credential-0123456789abcdef",
        { mode: 0o400 },
      );
      await writeFile(auditKeyPath, "not-an-ed25519-pkcs8-key", { mode: 0o400 });
      await chmod(credentialPath, 0o400);
      await chmod(auditKeyPath, 0o400);
      const port = await unusedTcpPort();
      const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
        const isTokenExchange = String(input).endsWith("openclaw-runtime-token");
        return new Response(JSON.stringify({
          version: 1,
          requestId: "dddd7000-0000-4000-8000-000000000011",
          result: isTokenExchange
            ? { version: 1, token: "short-lived-maintenance-token", expiresInSeconds: 60 }
            : claimBatch([]),
        }), { status: 200, headers: { "content-type": "application/json" } });
      });
      const logs: string[] = [];
      let startupError: unknown;

      try {
        started = await startMaintenanceProcess({
          env: {
            OPENCLAW_FUNCTIONS_BASE_URL: "https://project.supabase.co/functions/v1/",
            OPENCLAW_MEDIA_GATEWAY_URL: "https://openclaw-media.chillhome.io.vn/",
            OPENCLAW_MAINTENANCE_ORGANIZATION_ID: ORGANIZATION_ID,
            OPENCLAW_MAINTENANCE_PRINCIPAL_ID: MAINTENANCE_ID,
            OPENCLAW_MAINTENANCE_CREDENTIAL_FILE: credentialPath,
            OPENCLAW_AUDIT_PRIVATE_KEY_FILE: auditKeyPath,
            OPENCLAW_AUDIT_SIGNING_KEY_GENERATION: "6",
            OPENCLAW_MAINTENANCE_HOST: "127.0.0.1",
            OPENCLAW_MAINTENANCE_PORT: String(port),
          },
          fetch,
          log: (line) => logs.push(line),
        });
      } catch (error) {
        startupError = error;
      }

      expect(startupError).toBeInstanceOf(TypeError);
      expect(String(startupError)).toContain("audit signing key is invalid");
      expect(fetch).not.toHaveBeenCalled();
      expect(logs).not.toContainEqual(expect.stringContaining("maintenance_listening"));
    } finally {
      await started?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symbolic link even when its target has the required mode",
    async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-maintenance-symlink-"));
    try {
      const targetPath = join(directory, "credential-target");
      const linkPath = join(directory, "credential-link");
      await writeFile(targetPath, "secret-value-0123456789abcdef0123456789", { mode: 0o400 });
      await chmod(targetPath, 0o400);
      await symlink(targetPath, linkPath, "file");

      await expect(readSecretFile(linkPath)).rejects.toThrow("non-symlink");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    },
  );
});

describe("maintenance deployment contract", () => {
  it("pins Node 24, ships an unprivileged image, and documents the one canonical flow", async () => {
    const packageJson = JSON.parse(await readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    )) as {
      engines: { node: string };
      scripts: Record<string, string>;
    };
    const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
    const dockerignore = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

    expect(packageJson.engines.node).toBe(">=24.15.0 <25");
    expect(packageJson.scripts).toMatchObject({
      start: "node dist/src/main.js",
      build: "tsc -p tsconfig.json",
      test: "vitest run",
      typecheck: "tsc --noEmit -p tsconfig.json",
    });
    const nodeBase =
      "node:24.18.0-bookworm-slim@sha256:" +
      "6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
    expect(dockerfile.match(/^FROM .+$/gmu)).toEqual([
      `FROM ${nodeBase} AS build`,
      `FROM ${nodeBase} AS runtime`,
    ]);
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("/livez");
    expect(dockerfile).toContain('CMD ["npm", "start"]');
    expect(dockerignore).toMatch(/node_modules/);
    expect(readme).toContain("QUARANTINE");
    expect(readme).toContain("FINAL_DELETE");
    expect(readme).toContain("0400");
    expect(readme).toContain("/readyz");
    expect(readme).toContain("auditSigningPublicKeyHash");
    expect(readme).not.toContain("OPENCLAW_GATEWAY_RECEIPT_PUBLIC_KEY_B64");
    expect(readme).toContain("delete-ticket -> authorize-delete -> Gateway");
    expect(readme).toContain("RETENTION_DELETE_AUTHORIZED");
    expect(readme).toContain("AUDIT_VERIFY_AUTHORIZED");
    expect(readme).toContain("TICKET_EXPIRED_NO_WORK");
  });
});
