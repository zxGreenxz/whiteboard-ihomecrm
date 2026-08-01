import { describe, expect, it, vi } from "vitest";

import { base64UrlDecode, canonicalJson, sha256Hex, utf8 } from "../_shared/openclaw/crypto.ts";
import { createGenerationRevocationPropagator } from "./revocation.ts";

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

const REVOCATION = {
  version: 1 as const,
  organizationId: "dddd0000-0000-4000-8000-000000000001",
  accountId: "dddd1000-0000-4000-8000-000000000001",
  cellId: "dddd2000-0000-4000-8000-000000000001",
  runtimeCommandId: "dddd5000-0000-4000-8000-000000000001",
  revocationId: "dddd6000-0000-4000-8000-000000000001",
  revocationKind: "SESSION" as const,
  revokedGeneration: 4,
  minimumValidGeneration: 5,
  connectionState: "DISCONNECTING" as const,
  effectiveMode: "DRAFT_ONLY" as const,
};

async function acknowledgement(extra: Record<string, unknown> = {}): Promise<Response> {
  const canonical = {
    version: 1,
    revocationId: REVOCATION.revocationId,
    minimumValidGeneration: REVOCATION.minimumValidGeneration,
  };
  return new Response(JSON.stringify({
    ...canonical,
    acknowledgementHash: await sha256Hex(utf8(
      `ihome-openclaw-media-revocation-ack-v1\0${canonicalJson(canonical)}`,
    )),
    ...extra,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("signed media-generation revocation client", () => {
  it("signs one exact domain-separated body and validates the acknowledgement", async () => {
    const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const envelope = JSON.parse(new TextDecoder().decode(
        base64UrlDecode(headers.get("x-openclaw-revocation-envelope") ?? ""),
      ));
      const valid = await crypto.subtle.verify(
        "Ed25519",
        keyPair.publicKey,
        base64UrlDecode(headers.get("x-openclaw-revocation-signature") ?? ""),
        utf8(`ihome-openclaw-media-revocation-v1\0${canonicalJson(envelope)}`),
      );
      expect(valid).toBe(true);
      expect(envelope).toEqual({
        version: 1,
        audience: "openclaw-media-revocation",
        operation: "generation.revoke",
        timestamp: 1_785_062_400,
        nonce: "dddd7000-0000-4000-8000-000000000001",
        bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        keyGeneration: 2,
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        version: 1,
        organizationId: "dddd0000-0000-4000-8000-000000000001",
        principalKind: "CHANNEL",
        accountId: "dddd1000-0000-4000-8000-000000000001",
        cellId: "dddd2000-0000-4000-8000-000000000001",
        maintenancePrincipalId: null,
        revocationId: "dddd6000-0000-4000-8000-000000000001",
        revocationKind: "SESSION",
        revokedGeneration: 4,
        minimumValidGeneration: 5,
      });
      return acknowledgement();
    });
    const propagate = createGenerationRevocationPropagator({
      gatewayUrl: "https://openclaw-media.chillhome.io.vn",
      privateKeyPkcs8B64: base64(privateKey),
      keyGeneration: 2,
      fetch: fetch as typeof globalThis.fetch,
      nowEpochSeconds: () => 1_785_062_400,
      nonce: () => "dddd7000-0000-4000-8000-000000000001",
    });

    await expect(propagate(REVOCATION)).resolves.toEqual({
      acknowledgementHash: await sha256Hex(utf8(
        `ihome-openclaw-media-revocation-ack-v1\0${canonicalJson({
          version: 1,
          revocationId: REVOCATION.revocationId,
          minimumValidGeneration: REVOCATION.minimumValidGeneration,
        })}`,
      )),
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://openclaw-media.chillhome.io.vn/v1/internal/revoke-generation",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });

  it("rejects non-HTTPS gateway configuration before touching the network", () => {
    expect(() => createGenerationRevocationPropagator({
      gatewayUrl: "http://localhost:8787",
      privateKeyPkcs8B64: "AA==",
      keyGeneration: 1,
      fetch: vi.fn() as unknown as typeof fetch,
    })).toThrow(/HTTPS origin/i);
  });

  it.each([
    "https://evil.example",
    "https://127.0.0.1",
    "https://10.0.0.1",
    "https://openclaw-media.chillhome.io.vn.evil.example",
    "https://openclaw-media.chillhome.io.vn/v1/object",
  ])("rejects an untrusted gateway origin or route: %s", (gatewayUrl) => {
    expect(() => createGenerationRevocationPropagator({
      gatewayUrl,
      privateKeyPkcs8B64: "AA==",
      keyGeneration: 1,
      fetch: vi.fn() as unknown as typeof fetch,
    })).toThrow(/trusted HTTPS origin/i);
  });

  it("rejects a missing revocation private key during process wiring", () => {
    expect(() => createGenerationRevocationPropagator({
      gatewayUrl: "https://openclaw-media.chillhome.io.vn",
      privateKeyPkcs8B64: "",
      keyGeneration: 1,
      fetch: vi.fn() as unknown as typeof fetch,
    })).toThrow(/revocation key is invalid/i);
  });

  it("rejects malformed Ed25519 PKCS8 during process wiring", () => {
    expect(() => createGenerationRevocationPropagator({
      gatewayUrl: "https://openclaw-media.chillhome.io.vn",
      privateKeyPkcs8B64: base64(new Uint8Array(48)),
      keyGeneration: 1,
      fetch: vi.fn() as unknown as typeof fetch,
    })).toThrow(/revocation key is invalid/i);
  });

  it("starts private-key import during wiring instead of retaining raw key bytes until first use", async () => {
    const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    createGenerationRevocationPropagator({
      gatewayUrl: "https://openclaw-media.chillhome.io.vn",
      privateKeyPkcs8B64: base64(privateKey),
      keyGeneration: 2,
      fetch: vi.fn() as unknown as typeof fetch,
    });

    await vi.waitFor(() => expect(importKey).toHaveBeenCalledWith(
      "pkcs8",
      expect.any(ArrayBuffer),
      { name: "Ed25519" },
      false,
      ["sign"],
    ));
    importKey.mockRestore();
  });

  it("rejects a non-canonical acknowledgement with extra fields", async () => {
    const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const propagate = createGenerationRevocationPropagator({
      gatewayUrl: "https://openclaw-media.chillhome.io.vn",
      privateKeyPkcs8B64: base64(privateKey),
      keyGeneration: 2,
      fetch: vi.fn().mockResolvedValue(await acknowledgement({ internalState: "hidden" })),
      nowEpochSeconds: () => 1_785_062_400,
      nonce: () => "dddd7000-0000-4000-8000-000000000001",
    });

    await expect(propagate(REVOCATION)).rejects.toThrow(/acknowledgement is invalid/i);
  });

  it("rejects an oversized acknowledgement before consuming its body", async () => {
    const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const response = await acknowledgement();
    response.headers.set("content-length", "16385");
    const json = vi.spyOn(response, "json")
      .mockRejectedValue(new Error("oversized response must not be consumed"));
    const propagate = createGenerationRevocationPropagator({
      gatewayUrl: "https://openclaw-media.chillhome.io.vn",
      privateKeyPkcs8B64: base64(privateKey),
      keyGeneration: 2,
      fetch: vi.fn().mockResolvedValue(response),
      nowEpochSeconds: () => 1_785_062_400,
      nonce: () => "dddd7000-0000-4000-8000-000000000001",
    });

    await expect(propagate(REVOCATION)).rejects.toThrow(/too large/i);
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects a reused signing nonce before a second gateway request", async () => {
    const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const fetch = vi.fn().mockImplementation(() => acknowledgement());
    const propagate = createGenerationRevocationPropagator({
      gatewayUrl: "https://openclaw-media.chillhome.io.vn",
      privateKeyPkcs8B64: base64(privateKey),
      keyGeneration: 2,
      fetch,
      nowEpochSeconds: () => 1_785_062_400,
      nonce: () => "dddd7000-0000-4000-8000-000000000001",
    });

    await expect(propagate(REVOCATION)).resolves.toEqual({
      acknowledgementHash: await sha256Hex(utf8(
        `ihome-openclaw-media-revocation-ack-v1\0${canonicalJson({
          version: 1,
          revocationId: REVOCATION.revocationId,
          minimumValidGeneration: REVOCATION.minimumValidGeneration,
        })}`,
      )),
    });
    await expect(propagate(REVOCATION)).rejects.toThrow(/nonce/i);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a forged acknowledgement hash", async () => {
    const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const response = await acknowledgement();
    const value = await response.json() as Record<string, unknown>;
    value.acknowledgementHash = "f".repeat(64);
    const propagate = createGenerationRevocationPropagator({
      gatewayUrl: "https://openclaw-media.chillhome.io.vn",
      privateKeyPkcs8B64: base64(privateKey),
      keyGeneration: 2,
      fetch: vi.fn().mockResolvedValue(Response.json(value)),
      nowEpochSeconds: () => 1_785_062_400,
      nonce: () => "dddd7000-0000-4000-8000-000000000001",
    });

    await expect(propagate(REVOCATION)).rejects.toThrow(/acknowledgement is invalid/i);
  });
});
