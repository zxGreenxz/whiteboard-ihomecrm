import { afterEach, describe, expect, it, vi } from "vitest";

import gateway from "../src/index";
import { newReceiptId } from "../src/handlers/upload";
import { validateTicketShape } from "../src/ticket";
import { verifyTicketRequest } from "../src/ticket-verifier";
import {
  acquireObjectMutationOrWait,
  getWorkState,
  raiseMinimumGeneration,
  releaseObjectMutation,
} from "../src/state-client";
import {
  canonical,
  base64,
  gatewayEnv,
  MEDIA_ID,
  OBJECT_KEY,
  ORGANIZATION_ID,
  png,
  receiptKeys,
  runtimeTicket,
  sha256Hex,
  signedTicketHeader,
  ticketKeys,
} from "./fixtures";

afterEach(() => vi.useRealTimers());

function request(
  method: "PUT" | "POST",
  path: string,
  ticket: string,
  body?: Uint8Array,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://openclaw-media.chillhome.io.vn${path}`, {
    method,
    headers: {
      "x-openclaw-media-ticket": ticket,
      ...headers,
    },
    body,
  });
}

function base64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

async function expectUploadReceiptSignature(
  receipt: Record<string, unknown>,
  publicKey: CryptoKey,
): Promise<void> {
  const { signature, ...claims } = receipt;
  expect(typeof signature).toBe("string");
  await expect(crypto.subtle.verify(
    "Ed25519",
    publicKey,
    Buffer.from(String(signature), "base64url"),
    new TextEncoder().encode(
      `ihome-openclaw-media-upload-receipt-v1\0${canonical(claims)}`,
    ),
  )).resolves.toBe(true);
}

async function auditDocument(privateKey: CryptoKey, auditRootId: string) {
  const root = {
    version: 1,
    organizationId: ORGANIZATION_ID,
    rootDate: "2026-08-01",
    firstSequence: 10,
    lastSequence: 12,
    eventCount: 3,
    previousRootHash: "c".repeat(64),
    merkleRootHash: "d".repeat(64),
    rootHash: "a".repeat(64),
    auditSigningKeyGeneration: 7,
  };
  const canonicalRootJson = canonical(root);
  const signatureBytes = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(`ihome-openclaw-audit-root-v1\0${canonicalRootJson}`),
  );
  const signature = base64Url(signatureBytes);
  const signatureHash = await sha256Hex(new Uint8Array(signatureBytes));
  const document = {
    version: 1,
    signingDomain: "ihome-openclaw-audit-root-v1\0",
    root,
    canonicalRootJson,
    signature,
    signatureHash,
  };
  return { bytes: new TextEncoder().encode(canonical(document)), signatureHash };
}

describe("PUT /v1/object", () => {
  it("returns an explicit 410 when an authenticated expired upload has no workflow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);
    vi.setSystemTime(new Date("2026-08-01T00:02:00.000Z"));

    const response = await gateway.fetch(request(
      "PUT", "/v1/object", ticket.header, bytes,
      { "content-length": String(bytes.byteLength) },
    ), fixture.env);

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: { code: "TICKET_EXPIRED_NO_WORK" } });
    expect(fixture.r2.objects.size).toBe(0);
  });

  it("rejects runtime session generation zero before R2 mutation", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes, { sessionGeneration: 0 });

    const response = await gateway.fetch(request(
      "PUT", "/v1/object", ticket.header, bytes,
      { "content-length": String(bytes.byteLength) },
    ), fixture.env);

    expect(response.status).toBe(403);
    expect(fixture.r2.objects.size).toBe(0);
  });

  it("maps an atomic generation-floor rejection to 403 before R2 mutation", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes, { credentialGeneration: 5 });
    await raiseMinimumGeneration(fixture.env, {
      organizationId: ORGANIZATION_ID,
      principalKind: "CHANNEL",
      accountId: ticket.claims.accountId,
      cellId: ticket.claims.cellId ?? null,
      maintenancePrincipalId: null,
      dimension: "CREDENTIAL",
    }, 6);

    const response = await gateway.fetch(request(
      "PUT", "/v1/object", ticket.header, bytes,
      { "content-length": String(bytes.byteLength) },
    ), fixture.env);

    expect(response.status).toBe(403);
    expect(fixture.r2.objects.size).toBe(0);
  });

  it("rejects a receipt signer whose configured public identity does not match", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    fixture.env.OPENCLAW_RECEIPT_PUBLIC_KEY_SHA256 = "0".repeat(64);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);

    const response = await gateway.fetch(request(
      "PUT", "/v1/object", ticket.header, bytes,
      { "content-length": String(bytes.byteLength) },
    ), fixture.env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "RECEIPT_SIGNING_KEY_UNAVAILABLE" },
    });
    expect(fixture.r2.objects.size).toBe(0);
  });

  it("does not park a recoverable upload workflow before body validation", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const invalid = bytes.slice();
    invalid[8] = (invalid[8] ?? 0) ^ 0xff;
    const ticket = await runtimeTicket(keys.privateKey, bytes);

    const denied = await gateway.fetch(request(
      "PUT", "/v1/object", ticket.header, invalid,
      { "content-length": String(invalid.byteLength) },
    ), fixture.env);

    expect(denied.status).toBe(422);
    expect(await getWorkState(
      fixture.env,
      ticket.claims.organizationId,
      ticket.claims.accountId,
      `UPLOAD:${ticket.claims.jti}`,
    )).toBeNull();
    await raiseMinimumGeneration(fixture.env, {
      organizationId: ORGANIZATION_ID,
      principalKind: "CHANNEL",
      accountId: ticket.claims.accountId,
      cellId: ticket.claims.cellId ?? null,
      maintenancePrincipalId: null,
      dimension: "CREDENTIAL",
    }, 2);

    const retry = await gateway.fetch(request(
      "PUT", "/v1/object", ticket.header, bytes,
      { "content-length": String(bytes.byteLength) },
    ), fixture.env);
    expect(retry.status).toBe(403);
    expect(fixture.r2.objects.size).toBe(0);
  });

  it("authenticates the ticket and writes a validated object with an atomic no-overwrite condition", async () => {
    const runtimeContractsUrl = new URL(
      "../../../supabase/functions/openclaw-runtime/contracts.ts",
      import.meta.url,
    );
    const { validateRuntimeRequestBody } = await import(runtimeContractsUrl.href) as {
      validateRuntimeRequestBody: (path: string, value: unknown) => boolean;
    };
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const { env, r2 } = fixture;
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);
    expect(validateTicketShape(ticket.claims), JSON.stringify(ticket.claims)).toBe(true);
    const verifierProbe = await runtimeTicket(keys.privateKey, bytes);
    await expect(verifyTicketRequest(
      request("PUT", "/v1/object", verifierProbe.header, bytes),
      env,
      "PUT",
    )).resolves.toMatchObject({ subject: "RUNTIME", operation: "PUT" });

    const response = await gateway.fetch(request("PUT", "/v1/object", ticket.header, bytes, {
      "content-type": "image/png",
      "content-length": String(bytes.byteLength),
    }), env);

    expect(response.status).toBe(201);
    const receipt = await response.json<Record<string, unknown>>();
    expect(receipt).toMatchObject({
      version: 1,
      receiptKind: "MEDIA_UPLOAD",
      organizationId: ORGANIZATION_ID,
      accountId: ticket.claims.accountId,
      cellId: ticket.claims.cellId,
      mediaId: MEDIA_ID,
      objectKey: OBJECT_KEY,
      uploadTicketJti: ticket.claims.jti,
      sha256: ticket.claims.sha256,
      contentType: "image/png",
      contentLength: bytes.byteLength,
      credentialGeneration: ticket.claims.credentialGeneration,
      leaseGeneration: ticket.claims.leaseGeneration,
      fencingToken: ticket.claims.fencingToken,
      sessionGeneration: ticket.claims.sessionGeneration,
      objectVersionOrEtag: "version-1",
      gatewaySigningKeyGeneration: 1,
    });
    expect(Object.keys(receipt).sort()).toEqual([
      "accountId",
      "cellId",
      "contentLength",
      "contentType",
      "credentialGeneration",
      "fencingToken",
      "gatewaySigningKeyGeneration",
      "leaseGeneration",
      "mediaId",
      "objectKey",
      "objectVersionOrEtag",
      "organizationId",
      "receiptId",
      "receiptKind",
      "sessionGeneration",
      "sha256",
      "signature",
      "storedAt",
      "uploadTicketJti",
      "version",
    ]);
    expect(receipt.receiptId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(receipt.receiptId).not.toBe(receipt.uploadTicketJti);
    expect(receipt.storedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(validateRuntimeRequestBody("/v1/media/upload-complete", {
      version: 1,
      mediaId: MEDIA_ID,
      gatewayReceipt: receipt,
    })).toBe(true);
    expect(validateRuntimeRequestBody("/v1/media/upload-complete", {
      version: 1,
      mediaId: MEDIA_ID,
      gatewayReceipt: { ...receipt, receiptId: receipt.uploadTicketJti },
    })).toBe(false);
    expect(validateRuntimeRequestBody("/v1/media/upload-complete", {
      version: 1,
      mediaId: MEDIA_ID,
      gatewayReceipt: {
        ...receipt,
        objectKey: `v1/org/${ORGANIZATION_ID}/account/${ticket.claims.accountId}` +
          `/media/${MEDIA_ID}/original`,
      },
    })).toBe(false);
    await expectUploadReceiptSignature(receipt, fixture.signingKeys.publicKey);
    expect(r2.objects.get(OBJECT_KEY)?.bytes).toEqual(bytes);
    expect(r2.objects.get(OBJECT_KEY)?.customMetadata).toEqual({
      sha256: ticket.claims.sha256,
      uploadTicketJti: ticket.claims.jti,
    });
  });

  it("generates a receipt id distinct from the upload ticket jti", () => {
    const uploadTicketJti = "dddd7000-0000-4000-8000-000000000090";
    const receiptId = "dddd7000-0000-4000-8000-000000000092";
    const values = [uploadTicketJti, receiptId];

    expect(newReceiptId(uploadTicketJti, () => values.shift() ?? receiptId)).toBe(receiptId);
  });

  it("replays the byte-identical upload receipt after a lost gateway response", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);
    const makeRequest = () => request("PUT", "/v1/object", ticket.header, bytes, {
      "content-type": "image/png",
      "content-length": String(bytes.byteLength),
    });

    const first = await gateway.fetch(makeRequest(), fixture.env);
    const firstBody = await first.text();
    const replay = await gateway.fetch(makeRequest(), fixture.env);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstBody);
  });

  it("replays a stored receipt with a bounded historical ticket verification key", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);
    const makeRequest = () => request("PUT", "/v1/object", ticket.header, bytes, {
      "content-type": "image/png",
      "content-length": String(bytes.byteLength),
    });
    const first = await gateway.fetch(makeRequest(), fixture.env);
    const firstBody = await first.text();
    expect(first.status).toBe(201);

    const rotated = await ticketKeys();
    fixture.env.OPENCLAW_TICKET_RECOVERY_KEYRING_JSON = JSON.stringify([{
      generation: 1,
      publicKeyB64: fixture.env.OPENCLAW_TICKET_PUBLIC_KEY_B64,
      notBeforeEpochSeconds: 0,
      notAfterEpochSeconds: 4102444800,
      emergencyRevoked: false,
    }]);
    fixture.env.OPENCLAW_TICKET_PUBLIC_KEY_B64 = base64(
      await crypto.subtle.exportKey("spki", rotated.publicKey) as ArrayBuffer,
    );
    fixture.env.OPENCLAW_TICKET_KEY_GENERATION = "2";

    const replay = await gateway.fetch(makeRequest(), fixture.env);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstBody);
  });

  it("recovers a signed receipt when R2 stored the upload but its acknowledgement was lost", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);
    const originalPut = fixture.env.MEDIA.put.bind(fixture.env.MEDIA);
    let loseAcknowledgement = true;
    fixture.env.MEDIA.put = async (...args) => {
      const stored = await originalPut(...args);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("simulated lost R2 upload acknowledgement");
      }
      return stored;
    };
    const makeRequest = () => request("PUT", "/v1/object", ticket.header, bytes, {
      "content-type": "image/png",
    });

    expect((await gateway.fetch(makeRequest(), fixture.env)).status).toBe(500);
    const recovered = await gateway.fetch(makeRequest(), fixture.env);
    const receipt = await recovered.json<Record<string, unknown>>();

    expect(recovered.status).toBe(200);
    expect(receipt).toMatchObject({
      receiptKind: "MEDIA_UPLOAD",
      uploadTicketJti: ticket.claims.jti,
      objectVersionOrEtag: "version-1",
    });
    await expectUploadReceiptSignature(receipt, fixture.signingKeys.publicKey);
  });

  it("uses a bounded historical receipt signer to finish an in-flight upload after rotation", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);
    const oldPrivateKeyB64 = fixture.env.OPENCLAW_RECEIPT_PRIVATE_KEY_B64;
    const oldPublicKeySha256 = fixture.env.OPENCLAW_RECEIPT_PUBLIC_KEY_SHA256;
    const originalPut = fixture.env.MEDIA.put.bind(fixture.env.MEDIA);
    let loseAcknowledgement = true;
    fixture.env.MEDIA.put = async (...args) => {
      const stored = await originalPut(...args);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("simulated lost R2 upload acknowledgement");
      }
      return stored;
    };
    const makeRequest = () => request("PUT", "/v1/object", ticket.header, bytes, {
      "content-type": "image/png",
    });
    expect((await gateway.fetch(makeRequest(), fixture.env)).status).toBe(500);

    const rotated = await receiptKeys();
    const rotatedSpki = new Uint8Array(
      await crypto.subtle.exportKey("spki", rotated.publicKey) as ArrayBuffer,
    );
    fixture.env.OPENCLAW_RECEIPT_RECOVERY_KEYRING_JSON = JSON.stringify([{
      generation: 1,
      privateKeyB64: oldPrivateKeyB64,
      publicKeySha256: oldPublicKeySha256,
      notBeforeEpochSeconds: 0,
      notAfterEpochSeconds: 4102444800,
      emergencyRevoked: false,
    }]);
    fixture.env.OPENCLAW_RECEIPT_PRIVATE_KEY_B64 = base64(
      await crypto.subtle.exportKey("pkcs8", rotated.privateKey) as ArrayBuffer,
    );
    fixture.env.OPENCLAW_RECEIPT_PUBLIC_KEY_SHA256 = await sha256Hex(rotatedSpki);
    fixture.env.OPENCLAW_RECEIPT_KEY_GENERATION = "2";

    const recovered = await gateway.fetch(makeRequest(), fixture.env);
    const receipt = await recovered.json<Record<string, unknown>>();
    expect(recovered.status).toBe(200);
    expect(receipt.gatewaySigningKeyGeneration).toBe(1);
    await expectUploadReceiptSignature(receipt, fixture.signingKeys.publicKey);
  });

  it("does not recover an object stored by a different upload ticket", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);
    await fixture.r2.bucket.put(OBJECT_KEY, bytes, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        sha256: ticket.claims.sha256,
        uploadTicketJti: "dddd7000-0000-4000-8000-000000000099",
      },
    });
    const originalHead = fixture.env.MEDIA.head.bind(fixture.env.MEDIA);
    let firstHead = true;
    fixture.env.MEDIA.head = async (key) => {
      if (firstHead) {
        firstHead = false;
        return null;
      }
      return await originalHead(key);
    };

    const response = await gateway.fetch(request(
      "PUT",
      "/v1/object",
      ticket.header,
      bytes,
    ), fixture.env);

    expect(response.status).toBe(409);
  });

  it("does not sign a MEDIA_UPLOAD receipt with an out-of-contract R2 version", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);
    const originalPut = fixture.env.MEDIA.put.bind(fixture.env.MEDIA);
    fixture.env.MEDIA.put = (async (...args: Parameters<R2Bucket["put"]>) => {
      const stored = await originalPut(...args);
      return stored ? { ...stored, version: "v".repeat(513) } as R2Object : null;
    }) as R2Bucket["put"];

    const response = await gateway.fetch(request(
      "PUT",
      "/v1/object",
      ticket.header,
      bytes,
    ), fixture.env);

    expect(response.status).toBe(500);
  });

  it("rejects a forged ticket before touching R2", async () => {
    const keys = await ticketKeys();
    const attackerKeys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const { env, r2 } = fixture;
    const bytes = png();
    const forged = await runtimeTicket(attackerKeys.privateKey, bytes);

    const response = await gateway.fetch(request("PUT", "/v1/object", forged.header, bytes), env);

    expect(response.status).toBe(403);
    expect(r2.objects.size).toBe(0);
  });

  it("rejects browser-origin upload even when it carries a valid runtime ticket", async () => {
    const keys = await ticketKeys();
    const { env, r2 } = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);

    const response = await gateway.fetch(request(
      "PUT",
      "/v1/object",
      ticket.header,
      bytes,
      { origin: "https://ptcrm.vercel.app" },
    ), env);

    expect(response.status).toBe(403);
    expect(r2.objects.size).toBe(0);
  });

  it("does not expose CORS preflight on unknown paths", async () => {
    const keys = await ticketKeys();
    const { env } = await gatewayEnv(keys);
    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/not-an-endpoint",
      { method: "OPTIONS", headers: { origin: "https://ptcrm.vercel.app" } },
    ), env);

    expect(response.status).toBe(404);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("never overwrites an existing immutable key", async () => {
    const keys = await ticketKeys();
    const { env, r2 } = await gatewayEnv(keys);
    const bytes = png();
    const firstTicket = await runtimeTicket(keys.privateKey, bytes);
    const secondTicket = await runtimeTicket(keys.privateKey, bytes);

    expect((await gateway.fetch(request("PUT", "/v1/object", firstTicket.header, bytes), env)).status)
      .toBe(201);
    const original = r2.objects.get(OBJECT_KEY)?.bytes.slice();

    const response = await gateway.fetch(
      request("PUT", "/v1/object", secondTicket.header, bytes),
      env,
    );

    expect(response.status).toBe(409);
    expect(r2.objects.get(OBJECT_KEY)?.bytes).toEqual(original);
  });

  it("rejects content encoding and declared/actual byte mismatches without storing a partial object", async () => {
    const keys = await ticketKeys();
    const bytes = png();

    const encodedEnv = await gatewayEnv(keys);
    const encodedTicket = await runtimeTicket(keys.privateKey, bytes);
    const encoded = await gateway.fetch(request(
      "PUT",
      "/v1/object",
      encodedTicket.header,
      bytes,
      { "content-encoding": "gzip" },
    ), encodedEnv.env);
    expect(encoded.status).toBe(415);
    expect(encodedEnv.r2.objects.size).toBe(0);

    const partialEnv = await gatewayEnv(keys);
    const partialTicket = await runtimeTicket(keys.privateKey, bytes, {
      contentLength: bytes.byteLength + 1,
    });
    const partial = await gateway.fetch(
      request("PUT", "/v1/object", partialTicket.header, bytes),
      partialEnv.env,
    );
    expect(partial.status).toBe(422);
    expect(partialEnv.r2.objects.size).toBe(0);
  });

  it("rejects non-canonical Content-Length syntax before reading the upload body", async () => {
    const keys = await ticketKeys();
    const { env, r2 } = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);

    const response = await gateway.fetch(request(
      "PUT",
      "/v1/object",
      ticket.header,
      bytes,
      { "content-length": `${bytes.byteLength}.0` },
    ), env);

    expect(response.status).toBe(422);
    expect(r2.objects.size).toBe(0);
  });

  it("cancels an oversized chunked upload before buffering the whole body", async () => {
    const keys = await ticketKeys();
    const { env, r2 } = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);
    const cancel = vi.fn();
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunk += 1;
        if (chunk <= 3) controller.enqueue(new Uint8Array(32));
        else controller.close();
      },
      cancel,
    }, { highWaterMark: 0 });
    const upload = new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object",
      {
        method: "PUT",
        headers: { "x-openclaw-media-ticket": ticket.header },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );

    const response = await gateway.fetch(upload, env);

    expect(response.status).toBe(422);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(r2.objects.size).toBe(0);
  });

  it("bounds a stalled upload body read and cancels the stream", async () => {
    vi.useFakeTimers();
    const uploadModule = await import("../src/handlers/upload") as typeof import(
      "../src/handlers/upload"
    ) & {
      readBoundedBody?: (
        request: Request,
        byteLimit: number,
        timeoutMilliseconds: number,
      ) => Promise<Uint8Array>;
    };
    expect(uploadModule.readBoundedBody).toBeTypeOf("function");
    if (!uploadModule.readBoundedBody) return;
    const cancel = vi.fn();
    const stalled = new Request("https://openclaw-media.chillhome.io.vn/v1/object", {
      method: "PUT",
      body: new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel,
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const reading = expect(uploadModule.readBoundedBody(stalled, 1, 10))
      .rejects.toMatchObject({ code: "MEDIA_POLICY_DENIED" });
    await vi.advanceTimersByTimeAsync(11);

    await reading;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not PUT after an expired upload lease is taken over by delete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);
    const originalHead = fixture.env.MEDIA.head.bind(fixture.env.MEDIA);
    const blocker = "delete-takeover";
    let headCalls = 0;
    fixture.env.MEDIA.head = async (key) => {
      headCalls += 1;
      if (headCalls === 2) {
        vi.setSystemTime(new Date(Date.now() + 120_001));
        await acquireObjectMutationOrWait(fixture.env, key, "DELETE", blocker);
      }
      return await originalHead(key);
    };

    try {
      const response = await gateway.fetch(request(
        "PUT",
        "/v1/object",
        ticket.header,
        bytes,
        { "content-length": String(bytes.byteLength), "content-type": "image/png" },
      ), fixture.env);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "WORK_IN_PROGRESS" } });
      expect(fixture.r2.objects.size).toBe(0);
    } finally {
      await releaseObjectMutation(fixture.env, OBJECT_KEY, blocker);
    }
  });

  it("rechecks receipt signer revocation immediately before R2 PUT", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes);
    const originalHead = fixture.env.MEDIA.head.bind(fixture.env.MEDIA);
    let headCalls = 0;
    fixture.env.MEDIA.head = async (key) => {
      headCalls += 1;
      if (headCalls === 2) fixture.env.OPENCLAW_RECEIPT_KEY_EMERGENCY_REVOKED = "true";
      return await originalHead(key);
    };

    const response = await gateway.fetch(request(
      "PUT",
      "/v1/object",
      ticket.header,
      bytes,
      { "content-length": String(bytes.byteLength), "content-type": "image/png" },
    ), fixture.env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "RECEIPT_SIGNING_KEY_UNAVAILABLE" },
    });
    expect(fixture.r2.objects.size).toBe(0);
  });

  it("rejects an ANCHOR document before storage unless its exact bytes carry a valid audit signature", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const { env, r2 } = fixture;
    const auditRootId = "dddd4000-0000-4000-8000-000000000010";
    const objectKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${auditRootId}.json`;
    const bytes = new TextEncoder().encode(canonical({
      auditRootId,
      rootHash: "a".repeat(64),
      signatureHash: "b".repeat(64),
      version: 1,
    }));
    const now = Math.floor(Date.now() / 1_000);
    const claims = {
      version: 1 as const,
      aud: "openclaw-media-gateway" as const,
      operation: "ANCHOR" as const,
      subject: "MAINTENANCE" as const,
      jti: crypto.randomUUID(),
      organizationId: ORGANIZATION_ID,
      accountId: null,
      objectKey,
      sha256: await sha256Hex(bytes),
      contentType: "application/json",
      contentLength: bytes.byteLength,
      sessionGeneration: 0,
      gatewayKeyGeneration: 1,
      receiptSigningKeyGeneration: 1,
      iat: now,
      exp: now + 60,
      maintenancePrincipalId: "dddd2000-0000-4000-8000-000000000010",
      workItemId: "dddd3000-0000-4000-8000-000000000010",
      claimGeneration: 1,
      credentialGeneration: 2,
      leaseGeneration: 3,
      fencingToken: 4,
      auditRootId,
      rootHash: "a".repeat(64),
      signatureHash: "b".repeat(64),
      auditSigningKeyGeneration: 5,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    };
    const ticket = await signedTicketHeader(claims, keys.privateKey);

    const response = await gateway.fetch(request(
      "PUT",
      "/v1/object",
      ticket,
      bytes,
      { "content-type": "application/json" },
    ), env);

    expect(response.status).toBe(409);
    expect(r2.objects.has(objectKey)).toBe(false);
  });

  it("stores a canonical ANCHOR only after exact byte/hash/signature/generation verification", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const auditRootId = "dddd4000-0000-4000-8000-000000000010";
    const objectKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${auditRootId}.json`;
    const document = await auditDocument(fixture.auditKeys.privateKey, auditRootId);
    const now = Math.floor(Date.now() / 1_000);
    const claims = {
      version: 1 as const,
      aud: "openclaw-media-gateway" as const,
      operation: "ANCHOR" as const,
      subject: "MAINTENANCE" as const,
      jti: crypto.randomUUID(),
      organizationId: ORGANIZATION_ID,
      accountId: null,
      objectKey,
      sha256: await sha256Hex(document.bytes),
      contentType: "application/json",
      contentLength: document.bytes.byteLength,
      sessionGeneration: 0,
      gatewayKeyGeneration: 1,
      receiptSigningKeyGeneration: 1,
      iat: now,
      exp: now + 60,
      maintenancePrincipalId: "dddd2000-0000-4000-8000-000000000010",
      workItemId: "dddd3000-0000-4000-8000-000000000010",
      claimGeneration: 1,
      credentialGeneration: 2,
      leaseGeneration: 3,
      fencingToken: 4,
      auditRootId,
      rootHash: "a".repeat(64),
      signatureHash: document.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    };
    const ticket = await signedTicketHeader(claims, keys.privateKey);

    const response = await gateway.fetch(request(
      "PUT",
      "/v1/object",
      ticket,
      document.bytes,
      { "content-type": "application/json" },
    ), fixture.env);

    expect(response.status).toBe(201);
    expect(fixture.r2.objects.get(objectKey)?.bytes).toEqual(document.bytes);
  });
});

describe("POST /v1/object/read", () => {
  it("returns only the ticket-bound object as a private attachment", async () => {
    const keys = await ticketKeys();
    const { env } = await gatewayEnv(keys);
    const bytes = png();
    const uploadTicket = await runtimeTicket(keys.privateKey, bytes);
    expect((await gateway.fetch(request("PUT", "/v1/object", uploadTicket.header, bytes), env)).status)
      .toBe(201);

    const readTicket = await runtimeTicket(keys.privateKey, bytes, { operation: "GET" });
    const response = await gateway.fetch(
      request("POST", "/v1/object/read", readTicket.header),
      env,
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("strict-transport-security"))
      .toBe("max-age=31536000; includeSubDomains");
    expect(response.headers.get("content-security-policy"))
      .toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy"))
      .toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);

    const replay = await gateway.fetch(
      request("POST", "/v1/object/read", readTicket.header),
      env,
    );
    expect(replay.status).toBe(403);
  });

  it("does not return an object whose R2 bytes no longer match the signed ticket", async () => {
    const keys = await ticketKeys();
    const { env, r2 } = await gatewayEnv(keys);
    const expected = png();
    const ticket = await runtimeTicket(keys.privateKey, expected, { operation: "GET" });
    const corrupted = png(3, 3);
    await r2.bucket.put(OBJECT_KEY, corrupted, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { sha256: await (await runtimeTicket(keys.privateKey, corrupted)).claims.sha256 },
    });

    const response = await gateway.fetch(
      request("POST", "/v1/object/read", ticket.header),
      env,
    );

    expect(response.status).toBe(409);
    expect(await response.arrayBuffer()).toHaveProperty("byteLength", expect.any(Number));
  });

  it("rejects an R2 size mismatch without buffering the object body", async () => {
    const keys = await ticketKeys();
    const { env } = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes, { operation: "GET" });
    const readBytes = vi.fn(async () => {
      throw new Error("object body must not be read");
    });
    env.MEDIA.get = vi.fn(async () => ({
      key: OBJECT_KEY,
      version: "version-oversized",
      size: bytes.byteLength + 1,
      etag: "etag-oversized",
      httpEtag: '"etag-oversized"',
      checksums: { toJSON: () => ({}) },
      uploaded: new Date(),
      storageClass: "Standard",
      writeHttpMetadata: () => undefined,
      body: new ReadableStream(),
      bodyUsed: false,
      bytes: readBytes,
    } as unknown as R2ObjectBody));

    const response = await gateway.fetch(
      request("POST", "/v1/object/read", ticket.header),
      env,
    );

    expect(response.status).toBe(409);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("streams a checksum-bound R2 body without calling bytes", async () => {
    const keys = await ticketKeys();
    const { env } = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes, { operation: "GET" });
    const readBytes = vi.fn(async () => {
      throw new Error("streaming reads must not buffer the object");
    });
    env.MEDIA.get = vi.fn(async () => ({
      key: OBJECT_KEY,
      version: "version-streamed",
      size: bytes.byteLength,
      etag: "etag-streamed",
      httpEtag: '"etag-streamed"',
      checksums: {
        sha256: Uint8Array.from(Buffer.from(ticket.claims.sha256, "hex")).buffer,
        toJSON: () => ({}),
      },
      uploaded: new Date(),
      httpMetadata: { contentType: "image/png" },
      customMetadata: { sha256: ticket.claims.sha256 },
      storageClass: "Standard",
      writeHttpMetadata: () => undefined,
      body: new Blob([bytes]).stream(),
      bodyUsed: false,
      bytes: readBytes,
    } as unknown as R2ObjectBody));

    const response = await gateway.fetch(
      request("POST", "/v1/object/read", ticket.header),
      env,
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("atomically allows only one of two concurrent requests for the same read ticket", async () => {
    const keys = await ticketKeys();
    const { env, r2 } = await gatewayEnv(keys);
    const bytes = png();
    await r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await runtimeTicket(keys.privateKey, bytes, { operation: "GET" });

    const responses = await Promise.all([
      gateway.fetch(request("POST", "/v1/object/read", ticket.header), env),
      gateway.fetch(request("POST", "/v1/object/read", ticket.header), env),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
  });
});
