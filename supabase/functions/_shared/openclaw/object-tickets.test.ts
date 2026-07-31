import { describe, expect, it, vi } from "vitest";

import { signObjectTicket, verifyObjectTicket } from "./object-tickets";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CELL_ID = "dddd2000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "dddd4000-0000-4000-8000-000000000001";
const MESSAGE_ID = "dddd5000-0000-4000-8000-000000000001";
const MEDIA_ID = "dddd6000-0000-4000-8000-000000000001";
const JTI = "dddd7000-0000-4000-8000-000000000001";

function keyPair() {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

function claims() {
  return {
    version: 1 as const,
    aud: "openclaw-media-gateway" as const,
    operation: "PUT" as const,
    jti: JTI,
    organizationId: ORGANIZATION_ID,
    accountId: ACCOUNT_ID,
    cellId: CELL_ID,
    fencingToken: 9,
    sessionGeneration: 10,
    objectKey:
      `v1/org/${ORGANIZATION_ID}/account/${ACCOUNT_ID}` +
      `/conversation/${CONVERSATION_ID}/message/${MESSAGE_ID}` +
      `/media/${MEDIA_ID}/original`,
    sha256: "0".repeat(64),
    contentType: "image/png",
    contentLength: 123,
    gatewayKeyGeneration: 1,
    iat: 1_785_062_400,
    exp: 1_785_062_460,
  };
}

describe("OpenClaw object ticket cryptography", () => {
  it("signs and verifies a strict ES256 exact-key one-use ticket", async () => {
    const keys = await keyPair();
    const ticket = await signObjectTicket(claims(), keys.privateKey);
    const consumedJtis = new Set<string>();
    const consumeJti = vi.fn((ticketClaims: { jti: string }) => {
      if (consumedJtis.has(ticketClaims.jti)) {
        return Promise.reject(new Error("ticket replay"));
      }
      consumedJtis.add(ticketClaims.jti);
      return Promise.resolve();
    });
    const verified = await verifyObjectTicket({
      ticket,
      publicKey: keys.publicKey,
      nowEpochSeconds: 1_785_062_401,
      expected: {
        audience: "openclaw-media-gateway",
        operation: "PUT",
        organizationId: ORGANIZATION_ID,
        objectKey: claims().objectKey,
      },
      consumeJti,
    });

    expect(ticket.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(verified).toMatchObject({ jti: JTI, organizationId: ORGANIZATION_ID });
    expect(consumeJti).toHaveBeenCalledWith(expect.objectContaining({ jti: JTI }));
    await expect(verifyObjectTicket({
      ticket,
      publicKey: keys.publicKey,
      nowEpochSeconds: 1_785_062_401,
      expected: {
        audience: "openclaw-media-gateway",
        operation: "PUT",
        organizationId: ORGANIZATION_ID,
        objectKey: claims().objectKey,
      },
      consumeJti,
    })).rejects.toThrow(/replay/i);
  });

  it("rejects expiry, overlong TTL, wrong binding, extra claims, replay, and forgery", async () => {
    const keys = await keyPair();
    const otherKeys = await keyPair();
    const ticket = await signObjectTicket(claims(), keys.privateKey);
    const base = {
      ticket,
      publicKey: keys.publicKey,
      nowEpochSeconds: 1_785_062_401,
      expected: {
        audience: "openclaw-media-gateway" as const,
        operation: "PUT" as const,
        organizationId: ORGANIZATION_ID,
        objectKey: claims().objectKey,
      },
      consumeJti: async () => {},
    };

    await expect(verifyObjectTicket({ ...base, nowEpochSeconds: 1_785_062_461 }))
      .rejects.toThrow(/expired/i);
    await expect(verifyObjectTicket({
      ...base,
      expected: { ...base.expected, organizationId: ACCOUNT_ID },
    })).rejects.toThrow(/binding/i);
    await expect(verifyObjectTicket({ ...base, publicKey: otherKeys.publicKey }))
      .rejects.toThrow(/signature/i);
    await expect(verifyObjectTicket({
      ...base,
      consumeJti: () => Promise.reject(new Error("ticket replay")),
    })).rejects.toThrow(/replay/i);

    const overlong = await signObjectTicket(
      { ...claims(), exp: 1_785_062_461 },
      keys.privateKey,
    );
    await expect(verifyObjectTicket({ ...base, ticket: overlong }))
      .rejects.toThrow(/TTL/i);

    await expect(verifyObjectTicket({
      ...base,
      ticket: { ...ticket, extra: "forbidden" } as typeof ticket,
    })).rejects.toThrow(/strict/i);
  });

  it("rejects a non-string operation claim before cryptographic verification", async () => {
    const keys = await keyPair();
    const ticket = await signObjectTicket(claims(), keys.privateKey);

    await expect(verifyObjectTicket({
      ticket: { ...ticket, operation: ["PUT"] } as unknown as typeof ticket,
      publicKey: keys.publicKey,
      nowEpochSeconds: 1_785_062_401,
      expected: {
        audience: "openclaw-media-gateway",
        operation: "PUT",
        organizationId: ORGANIZATION_ID,
        objectKey: claims().objectKey,
      },
      consumeJti: async () => {},
    })).rejects.toMatchObject({ code: "TICKET_CLAIMS_INVALID" });
  });

  it("rejects a non-string signature with a structured ticket error", async () => {
    const keys = await keyPair();
    const ticket = await signObjectTicket(claims(), keys.privateKey);

    await expect(verifyObjectTicket({
      ticket: { ...ticket, signature: [ticket.signature] } as unknown as typeof ticket,
      publicKey: keys.publicKey,
      nowEpochSeconds: 1_785_062_401,
      expected: {
        audience: "openclaw-media-gateway",
        operation: "PUT",
        organizationId: ORGANIZATION_ID,
        objectKey: claims().objectKey,
      },
      consumeJti: async () => {},
    })).rejects.toMatchObject({ code: "TICKET_SIGNATURE_INVALID" });
  });

  it("rejects a non-finite verification clock without consuming the JTI", async () => {
    const keys = await keyPair();
    const ticket = await signObjectTicket(claims(), keys.privateKey);
    const consumeJti = vi.fn(() => Promise.resolve());

    await expect(verifyObjectTicket({
      ticket,
      publicKey: keys.publicKey,
      nowEpochSeconds: Number.NaN,
      expected: {
        audience: "openclaw-media-gateway",
        operation: "PUT",
        organizationId: ORGANIZATION_ID,
        objectKey: claims().objectKey,
      },
      consumeJti,
    })).rejects.toMatchObject({ code: "TICKET_TIME_INVALID" });
    expect(consumeJti).not.toHaveBeenCalled();
  });
});
