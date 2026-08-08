import { createHash, webcrypto } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { base64UrlEncode, canonicalJson, utf8 } from "../src/canonical-json.js";
import { createGatewayHandler } from "../src/server.js";
import { FilesystemObjectStore } from "../src/storage.js";

const ORGANIZATION = "aaaa0000-0000-4000-8000-000000000001";
const ACCOUNT = "aaaa1000-0000-4000-8000-000000000001";
const CELL = "dddd2000-0000-4000-8000-000000000001";
const MEDIA = "cccc3000-0000-4000-8000-000000000001";
const OBJECT_KEY = `org/${ORGANIZATION}/account/${ACCOUNT}/media/${MEDIA}/original`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harness(options: { now?: Date } = {}) {
  const ticketKeys = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  ) as webcrypto.CryptoKeyPair;
  const receiptKeys = await webcrypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]) as webcrypto.CryptoKeyPair;
  const root = await mkdtemp(join(tmpdir(), "openclaw-media-"));
  const handler = createGatewayHandler({
    store: new FilesystemObjectStore(root),
    ticketPublicKeyEs256: ticketKeys.publicKey,
    ticketKeyGeneration: 1,
    receiptSigningKey: receiptKeys.privateKey,
    receiptKeyGeneration: 1,
    maxContentLength: 5 * 1024 * 1024,
    now: () => options.now ?? new Date("2026-08-08T13:01:00.000Z"),
  });
  const server: Server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  async function ticketHeader(overrides: Record<string, unknown> = {}, bytes = PNG) {
    const claims: Record<string, unknown> = {
      version: 1,
      aud: "openclaw-media-gateway",
      operation: "PUT",
      subject: "RUNTIME",
      jti: "eeee4000-0000-4000-8000-000000000001",
      organizationId: ORGANIZATION,
      accountId: ACCOUNT,
      cellId: CELL,
      objectKey: OBJECT_KEY,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentType: "image/png",
      contentLength: bytes.byteLength,
      sessionGeneration: 1,
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      gatewayKeyGeneration: 1,
      receiptSigningKeyGeneration: 1,
      iat: "2026-08-08T13:00:00.000Z",
      exp: "2026-08-08T13:05:00.000Z",
      ...overrides,
    };
    const signature = base64UrlEncode(new Uint8Array(await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      ticketKeys.privateKey,
      utf8(canonicalJson(claims)),
    )));
    return Buffer.from(canonicalJson({ ...claims, signature }), "utf8").toString("base64url");
  }

  const put = async (header: string | null, bytes: Uint8Array) =>
    await fetch(`http://127.0.0.1:${port}/v1/object`, {
      method: "PUT",
      headers: {
        "content-type": "image/png",
        ...(header === null ? {} : { "x-openclaw-media-ticket": header }),
      },
      body: bytes,
    });

  return { port, root, ticketHeader, put, receiptKeys };
}

describe("media gateway HTTP surface", () => {
  it("stores the bytes and returns a signed receipt", async () => {
    const { put, ticketHeader, root, receiptKeys } = await harness();
    const response = await put(await ticketHeader(), PNG);

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json");
    const receipt = await response.json() as Record<string, unknown>;
    expect(receipt.receiptKind).toBe("MEDIA_UPLOAD");
    expect(receipt.objectKey).toBe(OBJECT_KEY);
    expect(receipt.mediaId).toBe(MEDIA);

    const stored = await readFile(join(root, OBJECT_KEY));
    expect(new Uint8Array(stored)).toEqual(PNG);

    const unsigned = { ...receipt };
    delete unsigned.signature;
    expect(await webcrypto.subtle.verify(
      "Ed25519",
      receiptKeys.publicKey,
      Buffer.from(receipt.signature as string, "base64url"),
      utf8(`ihome-openclaw-media-upload-receipt-v1\0${canonicalJson(unsigned)}`),
    )).toBe(true);
  });

  it("is safe to retry: the same bytes get a receipt instead of a collision", async () => {
    const { put, ticketHeader } = await harness();
    expect((await put(await ticketHeader(), PNG)).status).toBe(201);
    const retry = await put(await ticketHeader(), PNG);
    expect(retry.status).toBe(200);
    expect((await retry.json() as Record<string, unknown>).objectKey).toBe(OBJECT_KEY);
  });

  it("answers an expired ticket in the shape the bridge re-tickets on", async () => {
    const { put, ticketHeader } = await harness({ now: new Date("2026-08-08T13:06:00.000Z") });
    const response = await put(await ticketHeader(), PNG);
    expect(response.status).toBe(410);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: { code: "TICKET_EXPIRED_NO_WORK" } });
  });

  it("stores nothing without a ticket", async () => {
    const { put } = await harness();
    const response = await put(null, PNG);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "TICKET_MISSING" } });
  });

  it("refuses bytes that do not match the ticket checksum", async () => {
    const { put, ticketHeader } = await harness();
    const header = await ticketHeader();
    const tampered = new Uint8Array(PNG);
    tampered[9] = 0x99;
    const response = await put(header, tampered);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "CONTENT_CHECKSUM_MISMATCH" } });
  });

  it("exposes no other route or method", async () => {
    const { port } = await harness();
    const listing = await fetch(`http://127.0.0.1:${port}/v1/object/`, { method: "GET" });
    expect(listing.status).toBe(404);
    const read = await fetch(`http://127.0.0.1:${port}/v1/object`, { method: "GET" });
    expect(read.status).toBe(405);
  });

  it("says plainly that retention delete is not built yet, instead of denying it as a method", async () => {
    const { port } = await harness();
    const deletion = await fetch(`http://127.0.0.1:${port}/v1/object`, { method: "DELETE" });
    expect(deletion.status).toBe(501);
    expect(await deletion.json()).toEqual({ error: { code: "RETENTION_DELETE_NOT_IMPLEMENTED" } });
  });
});
