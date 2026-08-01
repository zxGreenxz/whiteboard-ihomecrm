import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  canonicalJson,
  receiptHash,
  signReceipt,
  storedReceiptResponse,
} from "../src/receipts";
import { gatewayEnv, ticketKeys } from "./fixtures";

interface GoldenVector {
  name: string;
  schema: string;
  domain: string;
  value: Record<string, unknown>;
  canonicalJson: string;
  sha256: string;
}

const golden = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "..", "..", "..", "contracts", "openclaw-zalo", "golden-vectors.json"),
  "utf8",
)) as { vectors: GoldenVector[] };
const receiptSchema = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "..", "..", "..", "contracts", "openclaw-zalo", "receipts.schema.json"),
  "utf8",
)) as {
  $defs: {
    mediaUploadReceipt: { required: string[]; properties: Record<string, unknown> };
  };
};

describe("gateway receipt canonical hashes", () => {
  it.each([
    "retention-receipt",
    "audit-anchor-receipt",
    "media-upload-receipt",
  ])("matches the domain-separated full-receipt golden vector for %s", async (name) => {
    const vector = golden.vectors.find((candidate) => candidate.name === name);
    expect(vector).toBeDefined();
    expect(vector?.domain.endsWith("\0")).toBe(true);
    expect(canonicalJson(vector?.value)).toBe(vector?.canonicalJson);
    await expect(receiptHash(
      vector?.domain.slice(0, -1) ?? "",
      vector?.value ?? {},
    )).resolves.toBe(vector?.sha256);
  });

  it("consumes the shared exact MEDIA_UPLOAD schema and vector", () => {
    const vector = golden.vectors.find((candidate) => candidate.name === "media-upload-receipt");
    const definition = receiptSchema.$defs.mediaUploadReceipt;

    expect(vector?.schema).toBe("receipts.schema.json");
    expect(Object.keys(vector?.value ?? {}).sort()).toEqual([...definition.required].sort());
    expect(Object.keys(definition.properties).sort()).toEqual([...definition.required].sort());
  });

  it("stores and replays the exact full JCS receipt bytes that were hashed", async () => {
    const mediaKeys = await ticketKeys();
    const { env } = await gatewayEnv(mediaKeys);
    const domain = "ihome-openclaw-retention-receipt-v1";
    const stored = await signReceipt(env, domain, {
      version: 1,
      receiptKind: "RETENTION_FINAL_DELETE",
      objectStatus: "NOT_FOUND",
      gatewaySigningKeyGeneration: 1,
    });
    const fullReceipt = JSON.parse(stored.canonicalJson) as Record<string, unknown>;

    expect(fullReceipt.signature).toBe(stored.signature);
    expect(stored.canonicalJson).toBe(canonicalJson(fullReceipt));
    await expect(receiptHash(domain, fullReceipt)).resolves.toBe(stored.sha256);
    await expect(storedReceiptResponse(stored).text()).resolves.toBe(stored.canonicalJson);
  });

  it("signs unsigned claims but hashes the full signed receipt", async () => {
    const mediaKeys = await ticketKeys();
    const fixture = await gatewayEnv(mediaKeys);
    const domain = "ihome-openclaw-media-upload-receipt-v1";
    const unsigned = {
      version: 1,
      receiptKind: "MEDIA_UPLOAD",
      receiptId: "77777777-7777-4777-8777-777777777777",
      gatewaySigningKeyGeneration: 1,
    };
    const stored = await signReceipt(fixture.env, domain, unsigned);
    const fullReceipt = JSON.parse(stored.canonicalJson) as Record<string, unknown>;
    const signature = Buffer.from(stored.signature, "base64url");

    await expect(crypto.subtle.verify(
      "Ed25519",
      fixture.signingKeys.publicKey,
      signature,
      new TextEncoder().encode(`${domain}\0${canonicalJson(unsigned)}`),
    )).resolves.toBe(true);
    await expect(crypto.subtle.verify(
      "Ed25519",
      fixture.signingKeys.publicKey,
      signature,
      new TextEncoder().encode(`${domain}\0${stored.canonicalJson}`),
    )).resolves.toBe(false);
    await expect(receiptHash(domain, fullReceipt)).resolves.toBe(stored.sha256);
    await expect(receiptHash(domain, unsigned)).resolves.not.toBe(stored.sha256);
  });
});
