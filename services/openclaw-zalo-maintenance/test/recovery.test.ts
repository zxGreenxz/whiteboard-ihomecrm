import { describe, expect, it } from "vitest";

import { evaluateMaintenanceReadiness } from "../src/health.js";
import { authorizeMaintenance } from "../src/runtime-client.js";
import { AnchorReceiptStore } from "../src/audit-anchor-runner.js";
import { planRetentionWork } from "../src/retention-runner.js";

const NOW = 1_785_062_400_000;
const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";

describe("Maintenance survives channel outage", () => {
  it("stays ready while the channel is paused or the cell is offline", () => {
    expect(
      evaluateMaintenanceReadiness({
        credentialValid: true,
        leaseActive: true,
        fencingCurrent: true,
        channelPaused: true,
        channelCellOffline: true,
      }),
    ).toEqual({ retentionReady: true, auditReady: true });
  });

  it("stops when its own credential, lease, or fencing is invalid", () => {
    expect(
      evaluateMaintenanceReadiness({
        credentialValid: false,
        leaseActive: true,
        fencingCurrent: true,
      }).retentionReady,
    ).toBe(false);
    expect(
      evaluateMaintenanceReadiness({
        credentialValid: true,
        leaseActive: false,
        fencingCurrent: true,
      }).auditReady,
    ).toBe(false);
    expect(
      evaluateMaintenanceReadiness({
        credentialValid: true,
        leaseActive: true,
        fencingCurrent: false,
      }).retentionReady,
    ).toBe(false);
  });

  it("authorizes work with no channel account present at all", () => {
    const verdict = authorizeMaintenance({
      state: {
        principal: {
          version: 1,
          principalKind: "MAINTENANCE",
          organizationId: ORGANIZATION_ID,
          maintenancePrincipalId: "dddd3000-0000-4000-8000-000000000001",
          credentialGeneration: 1,
          leaseGeneration: 1,
          fencingToken: 1,
        },
        credentialEnabled: true,
        credentialRevoked: false,
        leaseStatus: "ACTIVE",
        leaseExpiresAtEpochMs: NOW + 10_000,
        currentCredentialGeneration: 1,
        currentLeaseGeneration: 1,
        currentFencingToken: 1,
        allowedScopes: ["maintenance.claim", "maintenance.complete"],
      },
      expectedOrganizationId: ORGANIZATION_ID,
      operation: "maintenance.complete",
      workKind: "AUDIT_ANCHOR",
      nowEpochMs: NOW,
    });

    expect(verdict).toEqual({ allowed: true });
  });
});

describe("Crash recovery boundaries", () => {
  it("never repeats an unsafe delete after a crash between phases", () => {
    const item = {
      workClaimId: "dddd8000-0000-4000-8000-000000000001",
      organizationId: ORGANIZATION_ID,
      deletePhase: "FINAL_DELETE" as const,
      objectKey: "v1/org/x/account/y/conversation/c/message/m/media/d/original",
      quarantineVersion: 1,
      finalDeleteNotBeforeEpochMs: NOW - 1,
    };

    // After a crash the authorization proof has expired, so the resumed run must
    // not delete blindly; it needs a fresh authorization.
    const resumed = planRetentionWork({
      item,
      authorization: {
        version: 1,
        workClaimId: item.workClaimId,
        objectKey: item.objectKey,
        issuedAtEpochMs: NOW - 60_000,
        expiresAtEpochMs: NOW - 55_000,
        nonce: "n1",
      },
      nowEpochMs: NOW,
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.mayCallR2).toBe(false);
  });

  it("returns one canonical receipt no matter how many retries occur", () => {
    const store = new AnchorReceiptStore();
    const base = {
      version: 1 as const,
      workClaimId: "w1",
      organizationId: ORGANIZATION_ID,
      utcDate: "2026-08-01",
      auditRootId: "r1",
      objectKey: "v1/org/x/audit/2026-08-01/r1.json",
      rootSha256: "a".repeat(64),
      documentSha256: "b".repeat(64),
      documentByteLength: 10,
      verifyTicketJti: "j1",
      signatureKeyGeneration: 1,
      signature: "s".repeat(86),
      completedAtEpochMs: NOW,
    };

    const results = [
      store.store(base),
      store.store({ ...base, signature: "x".repeat(86) }),
      store.store({ ...base, completedAtEpochMs: NOW + 5 }),
    ];

    expect(new Set(results.map((entry) => JSON.stringify(entry))).size).toBe(1);
  });
});