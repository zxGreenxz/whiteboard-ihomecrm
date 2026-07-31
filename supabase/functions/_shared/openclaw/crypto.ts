const encoder = new TextEncoder();

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Unsupported canonical JSON value.");
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url value.");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function importHmacKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.byteLength < 32) throw new Error("Runtime signing key is too short.");
  return crypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signHmacSha256(
  key: Uint8Array,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await importHmacKey(key);
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, ownedArrayBuffer(bytes)),
  );
}

export async function verifyHmacSha256(
  key: Uint8Array,
  bytes: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const cryptoKey = await importHmacKey(key);
  return crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    ownedArrayBuffer(signature),
    ownedArrayBuffer(bytes),
  );
}

export async function signEs256(
  privateKey: CryptoKey,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    ownedArrayBuffer(bytes),
  ));
}

export function verifyEs256(
  publicKey: CryptoKey,
  bytes: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    ownedArrayBuffer(signature),
    ownedArrayBuffer(bytes),
  );
}
