import { describe, expect, it } from "vitest";

import {
  evaluateTicket,
  MAX_TICKET_TTL_SECONDS,
  validateRevocationEnvelope,
  type MediaTicketClaims,
} from "../src/ticket";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const JTI = "dddd7000-0000-4000-8000-000000000001";
const NONCE = "dddd7000-0000-4000-8000-000000000009";
const OBJECT_KEY =
  `v1/org/${ORGANIZATION_ID}/account/${ACCOUNT_ID}` +
  "/conversation/dddd4000-0000-4000-8000-000000000001" +
  "/message/dddd5000-0000-4000-8000-000000000001" +
  "/media/dddd6000-0000-4000-8000-000000000001/original";

const NOW = 1_785_062_400;
const CELL_ID = "dddd2000-0000-4000-8000-000000000001";
const MAINTENANCE_PRINCIPAL_ID = "dddd2000-0000-4000-8000-000000000002";
const WORK_ITEM_ID = "dddd3000-0000-4000-8000-000000000001";

function runtimeTicket(overrides: Partial<MediaTicketClaims> = {}): MediaTicketClaims {
  return {
    version: 1,
    aud: "openclaw-media-gateway",
    operation: "PUT",
    subject: "RUNTIME",
    jti: JTI,
    organizationId: ORGANIZATION_ID,
    accountId: ACCOUNT_ID,
    objectKey: OBJECT_KEY,
    sha256: "a".repeat(64),
    contentType: "image/png",
    contentLength: 16,
    sessionGeneration: 5,
    cellId: CELL_ID,
    credentialGeneration: 2,
    leaseGeneration: 3,
    fencingToken: 4,
    gatewayKeyGeneration: 1,
    receiptSigningKeyGeneration: 1,
    iat: NOW,
    exp: NOW + 60,
    ...overrides,
  };
}

const browserProof = {
  userId: "dddd9000-0000-4000-8000-000000000001",
  sessionIdSha256: "b".repeat(64),
  accessTokenSha256: "c".repeat(64),
};

function browserTicket(overrides: Partial<MediaTicketClaims> = {}): MediaTicketClaims {
  const {
    cellId: _cellId,
    credentialGeneration: _credentialGeneration,
    leaseGeneration: _leaseGeneration,
    fencingToken: _fencingToken,
    receiptSigningKeyGeneration: _receiptSigningKeyGeneration,
    ...common
  } = runtimeTicket();
  return {
    ...common,
    subject: "BROWSER",
    operation: "GET",
    browserUserId: browserProof.userId,
    browserSessionIdSha256: browserProof.sessionIdSha256,
    browserAccessTokenSha256: browserProof.accessTokenSha256,
    ...overrides,
  };
}

function verify(overrides: Record<string, unknown> = {}) {
  return evaluateTicket({
    claims: runtimeTicket(),
    nowEpochSeconds: NOW + 1,
    expectedOperation: "PUT",
    expectedObjectKey: OBJECT_KEY,
    minimumGeneration: 0,
    ...overrides,
  } as Parameters<typeof evaluateTicket>[0]);
}

describe("OpenClaw media ticket verification", () => {
  it("accepts a well-bound runtime ticket", () => {
    expect(verify()).toEqual({ ok: true });
  });

  it("caps the ticket lifetime at sixty seconds", () => {
    expect(MAX_TICKET_TTL_SECONDS).toBe(60);
    expect(verify({ claims: runtimeTicket({ exp: NOW + 61 }) }).failure).toBe("TICKET_TTL");
    expect(verify({ claims: runtimeTicket({ exp: NOW }) }).failure).toBe("TICKET_TTL");
  });

  it("rejects an expired ticket", () => {
    expect(verify({ nowEpochSeconds: NOW + 60 }).failure).toBe("TICKET_EXPIRED");
  });

  it("rejects a wrong audience or operation", () => {
    expect(verify({ claims: runtimeTicket({ aud: "other" as never }) }).failure)
      .toBe("TICKET_MALFORMED");
    expect(verify({ claims: runtimeTicket({ operation: "DELETE" }) }).failure)
      .toBe("TICKET_MALFORMED");
  });

  it("rejects a ticket minted for a different object key", () => {
    expect(verify({ expectedObjectKey: `${OBJECT_KEY}-other` }).failure)
      .toBe("TICKET_KEY_MISMATCH");
  });

  it("denies every ticket below the revoked generation floor", () => {
    expect(verify({ minimumGeneration: 5 })).toEqual({ ok: true });
    expect(verify({ minimumGeneration: 6 }).failure).toBe("TICKET_GENERATION_REVOKED");
  });

  it("makes a stolen browser ticket useless without the live token proof", () => {
    expect(
      evaluateTicket({
        claims: browserTicket(),
        nowEpochSeconds: NOW + 1,
        expectedOperation: "GET",
        expectedObjectKey: OBJECT_KEY,
        minimumGeneration: 0,
        browserProof: null,
      }).failure,
    ).toBe("BROWSER_PROOF_MISSING");

    expect(
      evaluateTicket({
        claims: browserTicket(),
        nowEpochSeconds: NOW + 1,
        expectedOperation: "GET",
        expectedObjectKey: OBJECT_KEY,
        minimumGeneration: 0,
        browserProof: { ...browserProof, accessTokenSha256: "d".repeat(64) },
      }).failure,
    ).toBe("BROWSER_PROOF_MISMATCH");

    expect(
      evaluateTicket({
        claims: browserTicket(),
        nowEpochSeconds: NOW + 1,
        expectedOperation: "GET",
        expectedObjectKey: OBJECT_KEY,
        minimumGeneration: 0,
        browserProof: { ...browserProof, userId: "user-2" },
      }).failure,
    ).toBe("BROWSER_PROOF_MISMATCH");

    expect(
      evaluateTicket({
        claims: browserTicket(),
        nowEpochSeconds: NOW + 1,
        expectedOperation: "GET",
        expectedObjectKey: OBJECT_KEY,
        minimumGeneration: 0,
        browserProof,
      }),
    ).toEqual({ ok: true });
  });

  it("requires the exact runtime cell/session/credential/lease/fence claim set", () => {
    const exactRuntime = runtimeTicket({
      cellId: CELL_ID,
      credentialGeneration: 2,
      leaseGeneration: 3,
      fencingToken: 4,
    });
    expect(verify({ claims: exactRuntime })).toEqual({ ok: true });

    for (const field of ["cellId", "credentialGeneration", "leaseGeneration", "fencingToken"]) {
      const incomplete = { ...exactRuntime } as Record<string, unknown>;
      delete incomplete[field];
      expect(verify({ claims: incomplete }).failure, field).toBe("TICKET_MALFORMED");
    }
    expect(verify({ claims: { ...exactRuntime, browserUserId: "foreign-principal" } }).failure)
      .toBe("TICKET_MALFORMED");
  });

  it("allows only an exact browser GET claim set", () => {
    expect(
      evaluateTicket({
        claims: browserTicket({ operation: "PUT" }),
        nowEpochSeconds: NOW + 1,
        expectedOperation: "PUT",
        expectedObjectKey: OBJECT_KEY,
        minimumGeneration: 0,
        browserProof,
      }).failure,
    ).toBe("TICKET_MALFORMED");
    expect(
      evaluateTicket({
        claims: { ...browserTicket(), cellId: CELL_ID },
        nowEpochSeconds: NOW + 1,
        expectedOperation: "GET",
        expectedObjectKey: OBJECT_KEY,
        minimumGeneration: 0,
        browserProof,
      }).failure,
    ).toBe("TICKET_MALFORMED");
  });
});

describe("OpenClaw retention delete tickets", () => {
  function deleteTicket(overrides: Partial<MediaTicketClaims> = {}) {
    const {
      cellId: _cellId,
      credentialGeneration: _credentialGeneration,
      leaseGeneration: _leaseGeneration,
      fencingToken: _fencingToken,
      ...common
    } = runtimeTicket();
    return {
      ...common,
      subject: "MAINTENANCE",
      operation: "DELETE",
      accountId: null,
      sessionGeneration: 0,
      maintenancePrincipalId: MAINTENANCE_PRINCIPAL_ID,
      workItemId: WORK_ITEM_ID,
      claimGeneration: 2,
      credentialGeneration: 3,
      leaseGeneration: 4,
      fencingToken: 5,
      holdVersion: 0,
      deletePhase: "FINAL_DELETE",
      quarantineVersion: 2,
      finalDeleteNotBefore: NOW - 10,
      ...overrides,
    } as MediaTicketClaims;
  }

  function exactDeleteTicket(overrides: Partial<MediaTicketClaims> = {}) {
    return deleteTicket({
      sessionGeneration: 0,
      maintenancePrincipalId: MAINTENANCE_PRINCIPAL_ID,
      workItemId: WORK_ITEM_ID,
      claimGeneration: 2,
      credentialGeneration: 3,
      leaseGeneration: 4,
      fencingToken: 5,
      holdVersion: 0,
      ...overrides,
    });
  }

  function verifyDelete(overrides: Record<string, unknown> = {}) {
    return evaluateTicket({
      claims: deleteTicket(),
      nowEpochSeconds: NOW + 1,
      expectedOperation: "DELETE",
      expectedObjectKey: OBJECT_KEY,
      minimumGeneration: 0,
      deleteAuthorizationPresent: true,
      ...overrides,
    } as Parameters<typeof evaluateTicket>[0]);
  }

  it("accepts a grace-eligible FINAL_DELETE with its authorization proof", () => {
    expect(verifyDelete()).toEqual({ ok: true });
  });

  it("refuses a QUARANTINE ticket on the delete path", () => {
    expect(verifyDelete({ claims: deleteTicket({ deletePhase: "QUARANTINE" }) }).failure)
      .toBe("TICKET_MALFORMED");
  });

  it("refuses a delete before the grace period elapses", () => {
    expect(verifyDelete({ claims: deleteTicket({ finalDeleteNotBefore: NOW + 3600 }) }).failure)
      .toBe("DELETE_PHASE_INVALID");
  });

  it("refuses a delete without a prior quarantine version", () => {
    expect(verifyDelete({ claims: deleteTicket({ quarantineVersion: 0 }) }).failure)
      .toBe("TICKET_MALFORMED");
  });

  it("refuses a delete ticket that arrives without the authorization proof", () => {
    expect(verifyDelete({ deleteAuthorizationPresent: false }).failure)
      .toBe("DELETE_AUTHORIZATION_REQUIRED");
  });

  it("requires the exact maintenance work/credential/lease/fence claim set", () => {
    const exact = exactDeleteTicket();
    expect(verifyDelete({ claims: exact })).toEqual({ ok: true });
    for (const field of [
      "maintenancePrincipalId",
      "workItemId",
      "claimGeneration",
      "credentialGeneration",
      "leaseGeneration",
      "fencingToken",
      "holdVersion",
    ]) {
      const incomplete = { ...exact } as Record<string, unknown>;
      delete incomplete[field];
      expect(verifyDelete({ claims: incomplete }).failure, field).toBe("TICKET_MALFORMED");
    }
    expect(verifyDelete({ claims: { ...exact, cellId: CELL_ID } }).failure)
      .toBe("TICKET_MALFORMED");
  });

  it("accepts the exact SQL-shaped recovery union with current admission and frozen lineage", () => {
    const original = exactDeleteTicket();
    const recovery = { ...original } as Record<string, unknown>;
    delete recovery.claimGeneration;
    Object.assign(recovery, {
      jti: "dddd7000-0000-4000-8000-000000000011",
      credentialGeneration: 13,
      leaseGeneration: 14,
      fencingToken: 15,
      recoveryKind: "RETENTION_DELETE_AUTHORIZED",
      recoveryGeneration: 2,
      replacesTicketJti: original.jti,
      replacesDeleteAuthorizationJti: "dddd7000-0000-4000-8000-000000000012",
      frozenClaim: {
        maintenancePrincipalId: original.maintenancePrincipalId,
        credentialGeneration: original.credentialGeneration,
        leaseGeneration: original.leaseGeneration,
        fencingToken: original.fencingToken,
        claimGeneration: original.claimGeneration,
      },
    });
    expect(verifyDelete({
      claims: recovery,
      generationFloors: {
        sessionGeneration: 0,
        credentialGeneration: 13,
        leaseGeneration: 14,
        fencingToken: 15,
      },
    })).toEqual({ ok: true });
    expect(verifyDelete({ claims: { ...recovery, claimGeneration: 2 } }).failure)
      .toBe("TICKET_MALFORMED");
    expect(verifyDelete({
      claims: { ...recovery, frozenClaim: { ...recovery.frozenClaim as object, extra: true } },
    }).failure).toBe("TICKET_MALFORMED");
  });
});

describe("OpenClaw internal generation revocation envelope", () => {
  const envelope = {
    version: 1 as const,
    aud: "openclaw-media-revocation" as const,
    operation: "generation.revoke" as const,
    nonce: NONCE,
    issuedAt: NOW,
    bodySha256: "e".repeat(64),
    organizationId: ORGANIZATION_ID,
    accountId: ACCOUNT_ID,
    sessionGeneration: 7,
  };

  it("accepts the dedicated audience and operation", () => {
    expect(validateRevocationEnvelope(envelope, NOW)).toEqual({ ok: true });
  });

  it("rejects any other audience or operation", () => {
    expect(validateRevocationEnvelope({ ...envelope, aud: "openclaw-media-gateway" }, NOW).failure)
      .toBe("ENVELOPE_AUDIENCE");
    expect(validateRevocationEnvelope({ ...envelope, operation: "media.read" }, NOW).failure)
      .toBe("ENVELOPE_OPERATION");
  });

  it("enforces a sixty-second clock skew window", () => {
    expect(validateRevocationEnvelope(envelope, NOW + 60).ok).toBe(true);
    expect(validateRevocationEnvelope(envelope, NOW + 61).failure).toBe("ENVELOPE_CLOCK");
    expect(validateRevocationEnvelope(envelope, NOW - 61).failure).toBe("ENVELOPE_CLOCK");
  });

  it("requires a body hash and a one-time nonce", () => {
    expect(validateRevocationEnvelope({ ...envelope, bodySha256: "short" }, NOW).failure)
      .toBe("ENVELOPE_BODY_HASH");
    expect(validateRevocationEnvelope({ ...envelope, nonce: "not-a-uuid" }, NOW).failure)
      .toBe("ENVELOPE_NONCE");
  });
});
