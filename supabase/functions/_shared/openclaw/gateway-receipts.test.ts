import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { base64UrlEncode, canonicalJson } from "./crypto.ts";
import { parseOpenClawEnvironment } from "./env.ts";
import { verifyGatewayReceipt } from "./gateway-receipts.ts";

const DOMAIN = "ihome-openclaw-retention-receipt-v1" as const;

function base64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

async function signedReceipt() {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const unsigned = {
    version: 1,
    receiptKind: "RETENTION_FINAL_DELETE",
    receiptId: "77777777-7777-4777-8777-777777777777",
    gatewaySigningKeyGeneration: 7,
    objectStatus: "DELETED",
    r2VersionOrEtag: "etag-1",
    completedAt: "2026-08-01T00:00:00.000Z",
  };
  const signature = base64UrlEncode(new Uint8Array(await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(`${DOMAIN}\0${canonicalJson(unsigned)}`),
  )));
  return {
    receipt: { ...unsigned, signature },
    publicKey: base64(await crypto.subtle.exportKey("spki", keys.publicKey)),
  };
}

async function signedAuditReceipt() {
  const domain = "ihome-openclaw-audit-receipt-v1" as const;
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const unsigned = {
    version: 1,
    receiptKind: "AUDIT_ANCHOR_VERIFY",
    receiptId: "77777777-7777-4777-8777-777777777778",
    gatewaySigningKeyGeneration: 7,
    verifiedAt: "2026-08-01T00:00:00.000Z",
  };
  const signature = base64UrlEncode(new Uint8Array(await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(`${domain}\0${canonicalJson(unsigned)}`),
  )));
  return {
    domain,
    receipt: { ...unsigned, signature },
    publicKey: base64(await crypto.subtle.exportKey("spki", keys.publicKey)),
  };
}

describe("OpenClaw gateway receipt verification", () => {
  it("loads a versioned public-key registry for fail-closed runtime verification", async () => {
    const fixture = await signedReceipt();
    const environment = parseOpenClawEnvironment({
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      OPENCLAW_RUNTIME_TOKEN_SIGNING_KEY: "x".repeat(32),
      OPENCLAW_BROWSER_ORIGINS: "https://ptcrm.vercel.app",
      OPENCLAW_GATEWAY_RECEIPT_PUBLIC_KEYS_JSON: JSON.stringify([{
        generation: 7,
        publicKeySpkiBase64: fixture.publicKey,
        activatesAt: "2026-07-01T00:00:00.000Z",
        retiresAt: "2026-09-01T00:00:00.000Z",
        revokedAt: null,
      }]),
    });

    expect(environment.gatewayReceiptKeyRegistry).toEqual({
      "7": {
        generation: 7,
        publicKeySpkiBase64: fixture.publicKey,
        activatesAt: "2026-07-01T00:00:00.000Z",
        retiresAt: "2026-09-01T00:00:00.000Z",
        revokedAt: null,
      },
    });
  });

  it("verifies Ed25519 over the unsigned JCS receipt and hashes the full signed receipt with its domain", async () => {
    const fixture = await signedReceipt();

    const verified = await verifyGatewayReceipt({
      domain: DOMAIN,
      receipt: fixture.receipt,
      keyRegistry: {
        "7": {
          generation: 7,
          publicKeySpkiBase64: fixture.publicKey,
          activatesAt: "2026-07-01T00:00:00.000Z",
          retiresAt: "2026-09-01T00:00:00.000Z",
          revokedAt: null,
        },
      },
    });

    expect(verified.receiptHash).toBe(createHash("sha256")
      .update(`${DOMAIN}\0${canonicalJson(fixture.receipt)}`)
      .digest("hex"));
  });

  it("fails closed for a forged claim or an unregistered key generation", async () => {
    const fixture = await signedReceipt();

    await expect(verifyGatewayReceipt({
      domain: DOMAIN,
      receipt: { ...fixture.receipt, objectStatus: "NOT_FOUND" },
      keyRegistry: {
        "7": {
          generation: 7,
          publicKeySpkiBase64: fixture.publicKey,
          activatesAt: "2026-07-01T00:00:00.000Z",
          retiresAt: "2026-09-01T00:00:00.000Z",
          revokedAt: null,
        },
      },
    })).rejects.toMatchObject({ code: "GATEWAY_RECEIPT_INVALID", status: 403 });

    await expect(verifyGatewayReceipt({
      domain: DOMAIN,
      receipt: fixture.receipt,
      keyRegistry: {},
    })).rejects.toMatchObject({ code: "GATEWAY_RECEIPT_INVALID", status: 403 });
  });

  it("accepts overlap and delayed old-key receipts only inside their signed validity window", async () => {
    const fixture = await signedReceipt();
    const keyRegistry = {
      "7": {
        generation: 7,
        publicKeySpkiBase64: fixture.publicKey,
        activatesAt: "2026-07-01T00:00:00.000Z",
        retiresAt: "2026-08-02T00:00:00.000Z",
        revokedAt: null,
      },
    } as const;

    await expect(verifyGatewayReceipt({
      domain: DOMAIN,
      receipt: fixture.receipt,
      keyRegistry,
    })).resolves.toMatchObject({ gatewaySigningKeyGeneration: 7 });

    await expect(verifyGatewayReceipt({
      domain: DOMAIN,
      receipt: { ...fixture.receipt, completedAt: "2026-08-03T00:00:00.000Z" },
      keyRegistry,
    })).rejects.toMatchObject({ code: "GATEWAY_RECEIPT_INVALID" });
  });

  it("rejects emergency-revoked generations at and after the revocation instant", async () => {
    const fixture = await signedReceipt();
    const keyRegistry = {
      "7": {
        generation: 7,
        publicKeySpkiBase64: fixture.publicKey,
        activatesAt: "2026-07-01T00:00:00.000Z",
        retiresAt: null,
        revokedAt: "2026-08-01T00:00:00.000Z",
      },
    } as const;

    await expect(verifyGatewayReceipt({
      domain: DOMAIN,
      receipt: fixture.receipt,
      keyRegistry,
    })).rejects.toMatchObject({ code: "GATEWAY_RECEIPT_INVALID" });
  });

  it("uses the audit receipt verifiedAt timestamp for rotation-window checks", async () => {
    const fixture = await signedAuditReceipt();
    await expect(verifyGatewayReceipt({
      domain: fixture.domain,
      receipt: fixture.receipt,
      keyRegistry: {
        "7": {
          generation: 7,
          publicKeySpkiBase64: fixture.publicKey,
          activatesAt: "2026-07-01T00:00:00.000Z",
          retiresAt: "2026-09-01T00:00:00.000Z",
          revokedAt: null,
        },
      },
    })).resolves.toMatchObject({ gatewaySigningKeyGeneration: 7 });
  });

  it("rejects legacy key-only environment maps", async () => {
    const fixture = await signedReceipt();
    expect(() => parseOpenClawEnvironment({
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      OPENCLAW_RUNTIME_TOKEN_SIGNING_KEY: "x".repeat(32),
      OPENCLAW_BROWSER_ORIGINS: "https://ptcrm.vercel.app",
      OPENCLAW_GATEWAY_RECEIPT_PUBLIC_KEYS_JSON: JSON.stringify({ "7": fixture.publicKey }),
    })).toThrow(/registry/i);
  });
});
