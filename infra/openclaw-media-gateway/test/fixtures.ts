import type { MediaGatewayEnv } from "../src/env";
import { TicketStateDurableObject } from "../src/ticket-state-do";
import type { MediaTicketClaims } from "../src/ticket";

export const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
export const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
export const CONVERSATION_ID = "dddd4000-0000-4000-8000-000000000001";
export const MESSAGE_ID = "dddd5000-0000-4000-8000-000000000001";
export const MEDIA_ID = "dddd6000-0000-4000-8000-000000000001";
export const OBJECT_KEY =
  `v1/org/${ORGANIZATION_ID}/account/${ACCOUNT_ID}` +
  `/conversation/${CONVERSATION_ID}/message/${MESSAGE_ID}/media/${MEDIA_ID}/original`;

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`
  ).join(",")}}`;
}

export function base64(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");
}

export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
}

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return Buffer.from(await crypto.subtle.digest("SHA-256", input)).toString("hex");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.byteLength);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(chunk.subarray(4, 8 + data.byteLength)));
  return chunk;
}

export function png(width = 2, height = 2): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const chunks = [
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    pngChunk("IEND", new Uint8Array()),
  ];
  const bytes = new Uint8Array(8 + chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesFromR2Value(value: unknown): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  throw new Error("unsupported fake R2 value");
}

interface FakeStoredObject {
  bytes: Uint8Array;
  version: string;
  etag: string;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  sha256: Uint8Array;
}

export class FakeR2 {
  readonly objects = new Map<string, FakeStoredObject>();
  readonly deletes: string[] = [];
  private version = 0;

  private metadata(key: string, object: FakeStoredObject): R2Object {
    return {
      key,
      version: object.version,
      size: object.bytes.byteLength,
      etag: object.etag,
      httpEtag: `"${object.etag}"`,
      checksums: {
        sha256: object.sha256.slice().buffer,
        toJSON: () => ({ sha256: Buffer.from(object.sha256).toString("base64") }),
      },
      uploaded: new Date("2026-08-01T00:00:00.000Z"),
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      storageClass: "Standard",
      writeHttpMetadata: () => undefined,
    } as R2Object;
  }

  private body(key: string, object: FakeStoredObject): R2ObjectBody {
    const bytes = object.bytes.slice();
    return {
      ...this.metadata(key, object),
      body: new Blob([bytes]).stream(),
      bodyUsed: false,
      arrayBuffer: async () => bytes.slice().buffer,
      bytes: async () => bytes.slice(),
      text: async () => new TextDecoder().decode(bytes),
      json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
      blob: async () => new Blob([bytes]),
    } as R2ObjectBody;
  }

  readonly bucket = {
    head: async (key: string) => {
      const object = this.objects.get(key);
      return object ? this.metadata(key, object) : null;
    },
    get: async (key: string) => {
      const object = this.objects.get(key);
      return object ? this.body(key, object) : null;
    },
    put: async (key: string, value: unknown, options?: R2PutOptions) => {
      if (options?.onlyIf && "etagDoesNotMatch" in options.onlyIf &&
        options.onlyIf.etagDoesNotMatch === "*" && this.objects.has(key)) {
        return null;
      }
      const bytes = bytesFromR2Value(value);
      const version = `version-${++this.version}`;
      const etag = await sha256Hex(bytes);
      const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const object = {
        bytes: bytes.slice(),
        version,
        etag,
        httpMetadata: options?.httpMetadata instanceof Headers ? undefined : options?.httpMetadata,
        customMetadata: options?.customMetadata,
        sha256,
      };
      this.objects.set(key, object);
      return this.metadata(key, object);
    },
    delete: async (key: string | string[]) => {
      for (const entry of Array.isArray(key) ? key : [key]) {
        this.deletes.push(entry);
        this.objects.delete(entry);
      }
    },
  } as unknown as R2Bucket;
}

export class FakeTicketStateNamespace {
  private readonly objects = new Map<string, TicketStateDurableObject>();

  readonly namespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        let durable = this.objects.get(id.name);
        if (!durable) {
          const values = new Map<string, unknown>();
          let transactionTail = Promise.resolve();
          const storage = {
            get: async <T>(key: string) => values.get(key) as T | undefined,
            put: async <T>(key: string, value: T) => { values.set(key, value); },
            delete: async (key: string) => values.delete(key),
          };
          const state = {
            storage: {
              ...storage,
              transaction: async <T>(closure: (transaction: typeof storage) => Promise<T>) => {
                const previous = transactionTail;
                let unlock!: () => void;
                transactionTail = new Promise<void>((resolve) => { unlock = resolve; });
                await previous;
                try {
                  return await closure(storage);
                } finally {
                  unlock();
                }
              },
            },
          } as unknown as DurableObjectState;
          durable = new TicketStateDurableObject(state);
          this.objects.set(id.name, durable);
        }
        return await durable.fetch(new Request(input, init));
      },
    }),
  } as unknown as DurableObjectNamespace;
}

export async function ticketKeys(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
}

export async function receiptKeys(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
}

export async function signedTicketHeader(
  claims: MediaTicketClaims,
  privateKey: CryptoKey,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(canonical(claims)),
  );
  return base64Url(new TextEncoder().encode(canonical({ ...claims, signature: base64Url(signature) })));
}

export async function runtimeTicket(
  privateKey: CryptoKey,
  bytes: Uint8Array,
  overrides: Partial<MediaTicketClaims> = {},
): Promise<{ claims: MediaTicketClaims; header: string }> {
  const now = Math.floor(Date.now() / 1_000);
  const claims: MediaTicketClaims = {
    version: 1,
    aud: "openclaw-media-gateway",
    operation: "PUT",
    subject: "RUNTIME",
    jti: crypto.randomUUID(),
    organizationId: ORGANIZATION_ID,
    accountId: ACCOUNT_ID,
    objectKey: OBJECT_KEY,
    sha256: await sha256Hex(bytes),
    contentType: "image/png",
    contentLength: bytes.byteLength,
    sessionGeneration: 1,
    gatewayKeyGeneration: 1,
    iat: now,
    exp: now + 60,
    ...overrides,
  };
  if (claims.subject === "RUNTIME") {
    claims.cellId ??= "dddd2000-0000-4000-8000-000000000001";
    claims.credentialGeneration ??= 1;
    claims.leaseGeneration ??= 1;
    claims.fencingToken ??= 1;
    claims.receiptSigningKeyGeneration ??= 1;
  } else if (claims.subject === "MAINTENANCE") {
    claims.receiptSigningKeyGeneration ??= 1;
  }
  return { claims, header: await signedTicketHeader(claims, privateKey) };
}

export async function gatewayEnv(
  keys: CryptoKeyPair,
  r2 = new FakeR2(),
  state = new FakeTicketStateNamespace(),
  signingKeys?: CryptoKeyPair,
): Promise<{
  env: MediaGatewayEnv;
  r2: FakeR2;
  state: FakeTicketStateNamespace;
  signingKeys: CryptoKeyPair;
  auditKeys: CryptoKeyPair;
  auditSigningPublicKeyHash: string;
}> {
  const activeSigningKeys = signingKeys ?? await receiptKeys();
  const receiptPublicKeySpki = new Uint8Array(
    await crypto.subtle.exportKey("spki", activeSigningKeys.publicKey) as ArrayBuffer,
  );
  const auditKeys = await receiptKeys();
  const auditPublicKeySpki = new Uint8Array(
    await crypto.subtle.exportKey("spki", auditKeys.publicKey) as ArrayBuffer,
  );
  const auditSigningPublicKeyHash = await sha256Hex(auditPublicKeySpki);
  const env = {
    MEDIA: r2.bucket,
    TICKET_STATE: state.namespace,
    OPENCLAW_TICKET_PUBLIC_KEY_B64: base64(
      await crypto.subtle.exportKey("spki", keys.publicKey) as ArrayBuffer,
    ),
    OPENCLAW_TICKET_KEY_GENERATION: "1",
    OPENCLAW_TICKET_KEY_NOT_BEFORE_EPOCH_SECONDS: "0",
    OPENCLAW_TICKET_KEY_NOT_AFTER_EPOCH_SECONDS: "4102444800",
    OPENCLAW_TICKET_KEY_EMERGENCY_REVOKED: "false",
    OPENCLAW_TICKET_RECOVERY_KEYRING_JSON: "[]",
    OPENCLAW_REVOCATION_PUBLIC_KEY_B64: base64(auditPublicKeySpki),
    OPENCLAW_REVOCATION_KEY_GENERATION: "1",
    OPENCLAW_BROWSER_ORIGINS: "https://ptcrm.vercel.app",
    OPENCLAW_SUPABASE_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
    OPENCLAW_RECEIPT_PRIVATE_KEY_B64: base64(
      await crypto.subtle.exportKey("pkcs8", activeSigningKeys.privateKey) as ArrayBuffer,
    ),
    OPENCLAW_RECEIPT_PUBLIC_KEY_SHA256: await sha256Hex(receiptPublicKeySpki),
    OPENCLAW_RECEIPT_KEY_GENERATION: "1",
    OPENCLAW_RECEIPT_KEY_NOT_BEFORE_EPOCH_SECONDS: "0",
    OPENCLAW_RECEIPT_KEY_NOT_AFTER_EPOCH_SECONDS: "4102444800",
    OPENCLAW_RECEIPT_KEY_EMERGENCY_REVOKED: "false",
    OPENCLAW_RECEIPT_RECOVERY_KEYRING_JSON: "[]",
    OPENCLAW_AUDIT_PUBLIC_KEY_B64: base64(
      auditPublicKeySpki,
    ),
    OPENCLAW_AUDIT_PUBLIC_KEY_SHA256: auditSigningPublicKeyHash,
    OPENCLAW_AUDIT_KEY_GENERATION: "7",
    OPENCLAW_AUDIT_KEY_NOT_BEFORE_EPOCH_SECONDS: "0",
    OPENCLAW_AUDIT_KEY_NOT_AFTER_EPOCH_SECONDS: "4102444800",
    OPENCLAW_AUDIT_KEY_EMERGENCY_REVOKED: "false",
    OPENCLAW_AUDIT_RECOVERY_KEYRING_JSON: "[]",
  } as MediaGatewayEnv;
  return {
    env,
    r2,
    state,
    signingKeys: activeSigningKeys,
    auditKeys,
    auditSigningPublicKeyHash,
  };
}
