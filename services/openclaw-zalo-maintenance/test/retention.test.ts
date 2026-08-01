import { describe, expect, it } from "vitest";

import {
  DELETE_AUTHORIZATION_MAX_TTL_MS,
  planRetentionWork,
  validateRetentionReceipt,
  type DeleteAuthorization,
  type RetentionWorkItem,
} from "../src/retention-runner.js";

const NOW = 1_785_062_400_000;
const OBJECT_KEY =
  "v1/org/dddd0000-0000-4000-8000-000000000001/account/dddd1000-0000-4000-8000-000000000001" +
  "/conversation/dddd4000-0000-4000-8000-000000000001" +
  "/message/dddd5000-0000-4000-8000-000000000001" +
  "/media/dddd6000-0000-4000-8000-000000000001/original";

function item(overrides: Partial<RetentionWorkItem> = {}): RetentionWorkItem {
  return {
    workClaimId: "dddd8000-0000-4000-8000-000000000001",
    organizationId: "dddd0000-0000-4000-8000-000000000001",
    deletePhase: "FINAL_DELETE",
    objectKey: OBJECT_KEY,
    quarantineVersion: 2,
    finalDeleteNotBeforeEpochMs: NOW - 1_000,
    ...overrides,
  };
}

function authorization(overrides: Partial<DeleteAuthorization> = {}): DeleteAuthorization {
  return {
    version: 1,
    workClaimId: "dddd8000-0000-4000-8000-000000000001",
    objectKey: OBJECT_KEY,
    issuedAtEpochMs: NOW,
    expiresAtEpochMs: NOW + 5_000,
    nonce: "dddd7000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

describe("QUARANTINE phase", () => {
  it("never issues an R2 request", () => {
    const decision = planRetentionWork({
      item: item({ deletePhase: "QUARANTINE", objectKey: null }),
      authorization: null,
      nowEpochMs: NOW,
    });
    expect(decision.ok).toBe(true);
    expect(decision.mayCallR2).toBe(false);
  });

  it("refuses a quarantine that arrives with a delete authorization", () => {
    const decision = planRetentionWork({
      item: item({ deletePhase: "QUARANTINE" }),
      authorization: authorization(),
      nowEpochMs: NOW,
    });
    expect(decision.refusal).toBe("QUARANTINE_MUST_NOT_TOUCH_R2");
  });
});

describe("FINAL_DELETE phase", () => {
  it("proceeds only with a grace-elapsed item and a fresh authorization", () => {
    const decision = planRetentionWork({
      item: item(),
      authorization: authorization(),
      nowEpochMs: NOW,
    });
    expect(decision.ok).toBe(true);
    expect(decision.mayCallR2).toBe(true);
  });

  it("refuses before the grace period elapses", () => {
    expect(
      planRetentionWork({
        item: item({ finalDeleteNotBeforeEpochMs: NOW + 3_600_000 }),
        authorization: authorization(),
        nowEpochMs: NOW,
      }).refusal,
    ).toBe("GRACE_NOT_ELAPSED");
  });

  it("refuses without a prior quarantine version", () => {
    expect(
      planRetentionWork({
        item: item({ quarantineVersion: 0 }),
        authorization: authorization(),
        nowEpochMs: NOW,
      }).refusal,
    ).toBe("MISSING_QUARANTINE_VERSION");
  });

  it("refuses a delete ticket without its authorization proof", () => {
    expect(
      planRetentionWork({ item: item(), authorization: null, nowEpochMs: NOW }).refusal,
    ).toBe("AUTHORIZATION_MISSING");
  });

  it("caps the authorization proof at five seconds", () => {
    expect(DELETE_AUTHORIZATION_MAX_TTL_MS).toBe(5_000);
    expect(
      planRetentionWork({
        item: item(),
        authorization: authorization({ expiresAtEpochMs: NOW + 5_001 }),
        nowEpochMs: NOW,
      }).refusal,
    ).toBe("AUTHORIZATION_EXPIRED");
    expect(
      planRetentionWork({
        item: item(),
        authorization: authorization(),
        nowEpochMs: NOW + 5_000,
      }).refusal,
    ).toBe("AUTHORIZATION_EXPIRED");
  });

  it("refuses a replayed authorization nonce", () => {
    expect(
      planRetentionWork({
        item: item(),
        authorization: authorization(),
        nowEpochMs: NOW,
        authorizationNonceAlreadyUsed: true,
      }).refusal,
    ).toBe("AUTHORIZATION_REPLAYED");
  });

  it("refuses an authorization bound to another claim or another object", () => {
    expect(
      planRetentionWork({
        item: item(),
        authorization: authorization({ workClaimId: "dddd8000-0000-4000-8000-000000000002" }),
        nowEpochMs: NOW,
      }).refusal,
    ).toBe("AUTHORIZATION_MISMATCH");
    expect(
      planRetentionWork({
        item: item(),
        authorization: authorization({ objectKey: `${OBJECT_KEY}-other` }),
        nowEpochMs: NOW,
      }).refusal,
    ).toBe("AUTHORIZATION_MISMATCH");
  });
});

describe("Retention receipt shape", () => {
  it("requires an R2 version and ETag for DELETED", () => {
    expect(
      validateRetentionReceipt({
        version: 1,
        workClaimId: "w1",
        objectKey: OBJECT_KEY,
        outcome: "DELETED",
        r2VersionId: "v1",
        r2ETag: "etag",
        completedAtEpochMs: NOW,
      }),
    ).toBe(true);

    expect(
      validateRetentionReceipt({
        version: 1,
        workClaimId: "w1",
        objectKey: OBJECT_KEY,
        outcome: "DELETED",
        r2VersionId: null,
        r2ETag: null,
        completedAtEpochMs: NOW,
      }),
    ).toBe(false);
  });

  it("requires null version and ETag for an authenticated NOT_FOUND", () => {
    expect(
      validateRetentionReceipt({
        version: 1,
        workClaimId: "w1",
        objectKey: OBJECT_KEY,
        outcome: "NOT_FOUND",
        r2VersionId: null,
        r2ETag: null,
        completedAtEpochMs: NOW,
      }),
    ).toBe(true);

    expect(
      validateRetentionReceipt({
        version: 1,
        workClaimId: "w1",
        objectKey: OBJECT_KEY,
        outcome: "NOT_FOUND",
        r2VersionId: "v1",
        r2ETag: "etag",
        completedAtEpochMs: NOW,
      }),
    ).toBe(false);
  });
});