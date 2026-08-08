// Process entry. Everything the gateway trusts arrives as a file or an integer:
// two keys, a storage root, two key generations and a size ceiling. There is no
// discovery, no admin surface and no way to widen what it accepts at runtime.

import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute } from "node:path";
import { webcrypto } from "node:crypto";

import { createGatewayHandler } from "../server.js";
import { FilesystemObjectStore } from "../storage.js";

const DEFAULT_MAX_CONTENT_LENGTH = 5 * 1024 * 1024;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function environmentInteger(name: string, minimum: number, fallback?: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    if (fallback === undefined) throw new TypeError(`${name} is required`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} is invalid`);
  return value;
}

/** Secrets are mounted read-only for the owner; anything looser is a misdeploy. */
async function readSecretFile(name: string): Promise<Buffer> {
  const path = requiredEnvironment(name);
  if (!isAbsolute(path)) throw new TypeError(`${name} must be an absolute path`);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new TypeError(`${name} must be a regular file`);
  const mode = metadata.mode & 0o777;
  const readOnlyForOwner = process.platform === "win32" ? mode === 0o444 : mode === 0o400;
  if (!readOnlyForOwner) throw new TypeError(`${name} must use mode 0400`);
  if (metadata.size < 1 || metadata.size > 16_384) throw new TypeError(`${name} size is invalid`);
  return await readFile(path);
}

function base64(value: Buffer): Uint8Array {
  const text = value.toString("utf8").trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new TypeError("key material is not base64");
  }
  return new Uint8Array(Buffer.from(text, "base64"));
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function main(): Promise<void> {
  const [ticketKeyMaterial, receiptKeyMaterial] = await Promise.all([
    readSecretFile("OPENCLAW_MEDIA_TICKET_PUBLIC_KEY_FILE"),
    readSecretFile("OPENCLAW_MEDIA_RECEIPT_PRIVATE_KEY_FILE"),
  ]);

  const ticketPublicKeyEs256 = await webcrypto.subtle.importKey(
    "spki",
    ownedArrayBuffer(base64(ticketKeyMaterial)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const receiptSigningKey = await webcrypto.subtle.importKey(
    "pkcs8",
    ownedArrayBuffer(base64(receiptKeyMaterial)),
    "Ed25519",
    false,
    ["sign"],
  );

  const storageRoot = requiredEnvironment("OPENCLAW_MEDIA_STORAGE_ROOT");
  if (!isAbsolute(storageRoot)) throw new TypeError("OPENCLAW_MEDIA_STORAGE_ROOT must be absolute");

  const handler = createGatewayHandler({
    store: new FilesystemObjectStore(storageRoot),
    ticketPublicKeyEs256,
    ticketKeyGeneration: environmentInteger("OPENCLAW_MEDIA_TICKET_KEY_GENERATION", 1),
    receiptSigningKey,
    receiptKeyGeneration: environmentInteger("OPENCLAW_MEDIA_RECEIPT_KEY_GENERATION", 1),
    maxContentLength: environmentInteger(
      "OPENCLAW_MEDIA_MAX_CONTENT_LENGTH",
      1,
      DEFAULT_MAX_CONTENT_LENGTH,
    ),
  });

  const server = createServer((request, response) => {
    void handler(request, response);
  });
  // Slow-loris protection: a stalled upload must not hold a connection open.
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;

  const host = process.env.OPENCLAW_MEDIA_HOST?.trim() || "0.0.0.0";
  const port = environmentInteger("OPENCLAW_MEDIA_PORT", 1, 8080);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.log(JSON.stringify({ event: "media_gateway_listening", host, port }));
}

await main();
