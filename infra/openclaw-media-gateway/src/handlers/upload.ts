import type { MediaGatewayEnv } from "../env";
import { GatewayError } from "../gateway-error";
import { evaluateMediaPolicy, maximumBytesForContentType } from "../media-policy";
import {
  assertReceiptSignerCurrent,
  receiptClaimHash,
  prepareReceiptSigner,
  signReceipt,
  storedReceiptResponse,
} from "../receipts";
import { errorResponse, jsonResponse } from "../responses";
import {
  acquireWorkExecutionOrWait,
  acquireObjectMutationOrWait,
  beginWorkflow,
  getWorkState,
  ObjectFinalDeletedError,
  releaseObjectMutation,
  renewObjectMutation,
  releaseWorkExecution,
  storeWorkReceipt,
  TicketStateBusyError,
  TicketStateConflictError,
  TicketStateExpiredError,
  TicketStateRevokedError,
} from "../state-client";
import type { MediaTicketClaims } from "../ticket";
import { verifyTicketRequest } from "../ticket-verifier";
import { assertAuditClaims, verifyAuditDocument } from "./verify";

async function digest(bytes: Uint8Array): Promise<{ bytes: ArrayBuffer; hex: string }> {
  const value = await crypto.subtle.digest("SHA-256", bytes);
  return {
    bytes: value,
    hex: [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

const UPLOAD_BODY_READ_TIMEOUT_MS = 30_000;

export async function readBoundedBody(
  request: Request,
  byteLimit: number,
  timeoutMilliseconds = UPLOAD_BODY_READ_TIMEOUT_MS,
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const deadline = Date.now() + timeoutMilliseconds;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new GatewayError("MEDIA_POLICY_DENIED", 422);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new GatewayError("MEDIA_POLICY_DENIED", 422)),
            remaining,
          );
        }),
      ]).finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
      });
      if (next.done) break;
      if (next.value.byteLength > byteLimit - offset) {
        await reader.cancel("upload exceeds ticket-bound byte length");
        throw new GatewayError("MEDIA_POLICY_DENIED", 422);
      }
      chunks.push(next.value);
      offset += next.value.byteLength;
    }
  } catch (error) {
    await reader.cancel("upload body read failed").catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (offset !== byteLimit) throw new GatewayError("MEDIA_POLICY_DENIED", 422);
  const bytes = new Uint8Array(offset);
  let writeOffset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return bytes;
}

function requireRuntimeUploadTicket(ticket: MediaTicketClaims): asserts ticket is MediaTicketClaims & {
  accountId: string;
  cellId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
} {
  if (
    ticket.operation !== "PUT" || ticket.subject !== "RUNTIME" || ticket.accountId === null ||
    typeof ticket.cellId !== "string" || !Number.isSafeInteger(ticket.credentialGeneration) ||
    !Number.isSafeInteger(ticket.leaseGeneration) || !Number.isSafeInteger(ticket.fencingToken)
  ) throw new GatewayError("UPLOAD_TICKET_INVALID", 403);
}

function mediaIdFromKey(objectKey: string): string {
  const match = /\/media\/([0-9a-f-]{36})\/(?:original|thumbnail|preview)$/u.exec(objectKey);
  if (!match?.[1]) throw new GatewayError("UPLOAD_TICKET_INVALID", 403);
  return match[1];
}

function versionOrEtag(object: R2Object): string {
  const value = object.version || object.etag;
  if (!value || value.length > 512) throw new GatewayError("R2_VERSION_INVALID", 500);
  return value;
}

export function newReceiptId(
  uploadTicketJti: string,
  generate: () => string = () => crypto.randomUUID(),
): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const receiptId = generate();
    if (receiptId !== uploadTicketJti) return receiptId;
  }
  throw new GatewayError("RECEIPT_ID_GENERATION_FAILED", 500);
}

async function validatedUploadBytes(request: Request, ticket: MediaTicketClaims) {
  if (
    ticket.contentLength < 1 ||
    ticket.contentLength > maximumBytesForContentType(ticket.contentType)
  ) {
    throw new GatewayError("MEDIA_POLICY_DENIED", 422);
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType && contentType !== ticket.contentType) {
    throw new GatewayError("MEDIA_POLICY_DENIED", 422);
  }
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) !== ticket.contentLength)
  ) {
    throw new GatewayError("MEDIA_POLICY_DENIED", 422);
  }
  const bytes = await readBoundedBody(request, ticket.contentLength);
  const actual = await digest(bytes);
  const policy = evaluateMediaPolicy({
    bytes,
    declaredContentType: ticket.contentType,
    declaredContentLength: ticket.contentLength,
    declaredSha256: ticket.sha256,
    actualSha256: actual.hex,
  });
  if (!policy.ok) throw new GatewayError("MEDIA_POLICY_DENIED", 422);
  return { bytes, digest: actual };
}

async function validateRecoveredObject(env: MediaGatewayEnv, ticket: MediaTicketClaims): Promise<string> {
  const object = await env.MEDIA.get(ticket.objectKey);
  if (!object) throw new GatewayError("UPLOAD_RECOVERY_OBJECT_MISSING", 500);
  if (
    object.size !== ticket.contentLength || object.httpMetadata?.contentType !== ticket.contentType ||
    object.customMetadata?.sha256 !== ticket.sha256 ||
    object.customMetadata?.uploadTicketJti !== ticket.jti
  ) throw new GatewayError("UPLOAD_RECOVERY_METADATA_MISMATCH", 409);
  const bytes = await object.bytes();
  const policy = evaluateMediaPolicy({
    bytes,
    declaredContentType: ticket.contentType,
    declaredContentLength: ticket.contentLength,
    declaredSha256: ticket.sha256,
    actualSha256: (await digest(bytes)).hex,
  });
  if (!policy.ok) throw new GatewayError("UPLOAD_RECOVERY_INTEGRITY_MISMATCH", 409);
  return versionOrEtag(object);
}

async function handleRuntimeUpload(
  request: Request,
  env: MediaGatewayEnv,
  ticket: MediaTicketClaims,
): Promise<Response> {
  requireRuntimeUploadTicket(ticket);
  const mediaId = mediaIdFromKey(ticket.objectKey);
  const workClaimId = `UPLOAD:${ticket.jti}`;
  const claimHash = await receiptClaimHash({ ticket });
  let work = await getWorkState(env, ticket.organizationId, ticket.accountId, workClaimId);
  if (work && work.claimHash !== claimHash) throw new TicketStateConflictError();
  if (work?.phase === "RECEIPT_STORED" && work.receipt) {
    work = await beginWorkflow(
      env,
      ticket.organizationId,
      ticket.accountId,
      workClaimId,
      claimHash,
      "UPLOAD",
      [{ jti: ticket.jti, expiresAtEpochSeconds: ticket.exp }],
      ticket,
    );
    if (work.receipt) return storedReceiptResponse(work.receipt);
  }
  const objectExecutorId = crypto.randomUUID();
  await acquireObjectMutationOrWait(env, ticket.objectKey, "UPLOAD", objectExecutorId);
  try {
    const existingBeforeAdmission = await env.MEDIA.head(ticket.objectKey);
  let recoveredVersionOrEtag: string | null = null;
  let preparedUpload: Awaited<ReturnType<typeof validatedUploadBytes>> | null = null;
  if (work && existingBeforeAdmission) {
    recoveredVersionOrEtag = await validateRecoveredObject(env, ticket);
  } else {
    if (Math.floor(Date.now() / 1_000) >= ticket.exp) {
      throw new GatewayError("TICKET_EXPIRED_NO_WORK", 410);
    }
    try {
      await verifyTicketRequest(request, env, "PUT", {
        consumeJti: false,
        skipStateAdmission: true,
      });
    } catch {
      throw new GatewayError("MEDIA_TICKET_INVALID", 403);
    }
    if (!existingBeforeAdmission) preparedUpload = await validatedUploadBytes(request, ticket);
  }
  work = await beginWorkflow(
    env,
    ticket.organizationId,
    ticket.accountId,
    workClaimId,
    claimHash,
    "UPLOAD",
    [{ jti: ticket.jti, expiresAtEpochSeconds: ticket.exp }],
    ticket,
    recoveredVersionOrEtag !== null,
  );
  if (work.phase === "RECEIPT_STORED" && work.receipt) {
    return storedReceiptResponse(work.receipt);
  }
  const receiptSigner = await prepareReceiptSigner(env, ticket);
  const receiptSigningKeyGeneration = receiptSigner.generation;

  const objectExistedBefore = work.phase === "AUTHORIZED"
    ? existingBeforeAdmission !== null
    : work.progress?.objectExistedBefore;
  if (typeof objectExistedBefore !== "boolean") {
    throw new GatewayError("UPLOAD_RECOVERY_STATE_INVALID", 500);
  }
  const executorId = crypto.randomUUID();
  let ownsExecution = false;
  const execution = await acquireWorkExecutionOrWait(
    env,
    ticket.organizationId,
    ticket.accountId,
    workClaimId,
    claimHash,
    { objectExistedBefore },
    executorId,
  );
  work = execution.work;
  if (work.phase === "RECEIPT_STORED" && work.receipt) {
    return storedReceiptResponse(work.receipt);
  }
  ownsExecution = execution.acquired;
  try {
    if (!ownsExecution || work.progress?.objectExistedBefore !== false) {
      throw new GatewayError(
        work.progress?.objectExistedBefore === true
          ? "OBJECT_ALREADY_EXISTS"
          : "UPLOAD_RECOVERY_STATE_INVALID",
        work.progress?.objectExistedBefore === true ? 409 : 500,
      );
    }

    const existing = await env.MEDIA.head(ticket.objectKey);
    let objectVersionOrEtag: string;
    let initialStore = false;
    if (existing) {
      objectVersionOrEtag = recoveredVersionOrEtag ?? await validateRecoveredObject(env, ticket);
    } else {
      if (!preparedUpload) throw new GatewayError("UPLOAD_RECOVERY_STATE_INVALID", 500);
      await assertReceiptSignerCurrent(env, receiptSigner);
      await renewObjectMutation(env, ticket.objectKey, "UPLOAD", objectExecutorId);
      await assertReceiptSignerCurrent(env, receiptSigner);
      let stored: R2Object | null;
      try {
        stored = await env.MEDIA.put(ticket.objectKey, preparedUpload.bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: ticket.contentType },
          customMetadata: { sha256: ticket.sha256, uploadTicketJti: ticket.jti },
          sha256: preparedUpload.digest.bytes,
        });
      } catch {
        throw new GatewayError("UPLOAD_FAILED", 500);
      }
      if (!stored) throw new GatewayError("OBJECT_ALREADY_EXISTS", 409);
      objectVersionOrEtag = versionOrEtag(stored);
      initialStore = true;
    }

    const receipt = await signReceipt(env, "ihome-openclaw-media-upload-receipt-v1", {
      version: 1,
      receiptKind: "MEDIA_UPLOAD",
      receiptId: newReceiptId(ticket.jti),
      organizationId: ticket.organizationId,
      accountId: ticket.accountId,
      cellId: ticket.cellId,
      mediaId,
      objectKey: ticket.objectKey,
      sha256: ticket.sha256,
      contentType: ticket.contentType,
      contentLength: ticket.contentLength,
      uploadTicketJti: ticket.jti,
      credentialGeneration: ticket.credentialGeneration,
      leaseGeneration: ticket.leaseGeneration,
      fencingToken: ticket.fencingToken,
      sessionGeneration: ticket.sessionGeneration,
      objectVersionOrEtag,
      storedAt: new Date().toISOString(),
      gatewaySigningKeyGeneration: receiptSigningKeyGeneration,
    }, receiptSigner);
    await assertReceiptSignerCurrent(env, receiptSigner);
    const storedReceipt = await storeWorkReceipt(
      env,
      ticket.organizationId,
      ticket.accountId,
      workClaimId,
      claimHash,
      receipt,
      executorId,
    );
    return storedReceiptResponse(storedReceipt, initialStore ? 201 : 200);
    } finally {
      if (ownsExecution) {
        await releaseWorkExecution(
          env, ticket.organizationId, ticket.accountId, workClaimId, claimHash, executorId,
        );
      }
    }
  } finally {
    await releaseObjectMutation(env, ticket.objectKey, objectExecutorId);
  }
}

export async function handleUpload(request: Request, env: MediaGatewayEnv): Promise<Response> {
  let ticket: MediaTicketClaims;
  try {
    const encoding = request.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      throw new GatewayError("CONTENT_ENCODING_FORBIDDEN", 415);
    }
    ticket = await verifyTicketRequest(request, env, ["PUT", "ANCHOR"], {
      consumeJti: false,
      allowExpiredForReplay: true,
      skipStateAdmission: true,
    });
  } catch (error) {
    if (error instanceof GatewayError) return errorResponse(error.code, error.status);
    return errorResponse("MEDIA_TICKET_INVALID", 403);
  }

  try {
    if (ticket.operation === "PUT") return await handleRuntimeUpload(request, env, ticket);
    // Audit uploads deliberately do not produce MEDIA_UPLOAD receipts. Their
    // authoritative completion evidence is the later AuditAnchorReceiptV1.
    if (Math.floor(Date.now() / 1_000) >= ticket.exp) {
      throw new GatewayError("TICKET_EXPIRED_NO_WORK", 410);
    }
    try {
      await verifyTicketRequest(request, env, "ANCHOR");
    } catch {
      throw new GatewayError("MEDIA_TICKET_INVALID", 403);
    }
    const objectExecutorId = crypto.randomUUID();
    await acquireObjectMutationOrWait(env, ticket.objectKey, "UPLOAD", objectExecutorId);
    try {
      const upload = await validatedUploadBytes(request, ticket);
      assertAuditClaims(ticket);
      let document: unknown;
      const canonicalText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(upload.bytes);
      try {
        document = JSON.parse(canonicalText);
      } catch {
        throw new GatewayError("AUDIT_ANCHOR_INVALID", 409);
      }
      await verifyAuditDocument(document, canonicalText, ticket, env);

      await renewObjectMutation(env, ticket.objectKey, "UPLOAD", objectExecutorId);
      const stored = await env.MEDIA.put(ticket.objectKey, upload.bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: ticket.contentType },
        customMetadata: { sha256: ticket.sha256 },
        sha256: upload.digest.bytes,
      });
      if (!stored) throw new GatewayError("OBJECT_ALREADY_EXISTS", 409);
      return jsonResponse({
        version: 1,
        status: "STORED",
        versionOrEtag: stored.version || stored.etag,
      }, 201);
    } finally {
      await releaseObjectMutation(env, ticket.objectKey, objectExecutorId);
    }
  } catch (error) {
    if (error instanceof TicketStateConflictError) {
      return errorResponse("WORK_CLAIM_CONFLICT", 409);
    }
    if (error instanceof TicketStateRevokedError) {
      return errorResponse("TICKET_GENERATION_REVOKED", 403);
    }
    if (error instanceof TicketStateExpiredError) {
      return errorResponse("TICKET_EXPIRED_NO_WORK", 410);
    }
    if (error instanceof TicketStateBusyError) return errorResponse("WORK_IN_PROGRESS", 409);
    if (error instanceof ObjectFinalDeletedError) {
      return errorResponse("OBJECT_FINAL_DELETED", 409);
    }
    if (error instanceof GatewayError) return errorResponse(error.code, error.status);
    return errorResponse("UPLOAD_FAILED", 500);
  }
}
