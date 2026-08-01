import type { MediaGatewayEnv } from "../env";
import { auditVerificationKey } from "../audit-keys";
import { GatewayError } from "../gateway-error";
import { evaluateMediaPolicy, MAX_AUDIT_BYTES } from "../media-policy";
import {
  assertReceiptSignerCurrent,
  canonicalJson,
  maintenanceReceiptLineage,
  receiptClaimHash,
  requireMaintenanceTicket,
  prepareReceiptSigner,
  sha256Hex,
  signReceipt,
  storedReceiptResponse,
} from "../receipts";
import { errorResponse } from "../responses";
import {
  acquireWorkExecutionOrWait,
  admitTicket,
  beginWorkflow,
  getWorkState,
  getStoredWorkflowReceipt,
  releaseWorkExecution,
  storeWorkReceipt,
  TicketStateBusyError,
  TicketStateConflictError,
  TicketStateExpiredError,
  TicketStateRevokedError,
} from "../state-client";
import { verifyTicketRequest } from "../ticket-verifier";

const SHA256 = /^[0-9a-f]{64}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const AUDIT_DOCUMENT_KEYS = [
  "version", "signingDomain", "root", "canonicalRootJson", "signature", "signatureHash",
] as const;
const AUDIT_ROOT_KEYS = [
  "version", "organizationId", "rootDate", "firstSequence", "lastSequence", "eventCount",
  "previousRootHash", "merkleRootHash", "rootHash", "auditSigningKeyGeneration",
] as const;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=")),
    (character) => character.charCodeAt(0),
  );
}

export async function verifyAuditDocument(
  anchor: unknown,
  canonicalText: string,
  ticket: Awaited<ReturnType<typeof verifyTicketRequest>> & {
    auditRootId: string;
    rootHash: string;
    signatureHash: string;
    auditSigningKeyGeneration: number;
    auditSigningPublicKeyHash: string;
  },
  env: MediaGatewayEnv,
  allowHistoricalAuditKey = false,
): Promise<void> {
  if (!exact(anchor, AUDIT_DOCUMENT_KEYS) || canonicalJson(anchor) !== canonicalText) {
    throw new GatewayError("AUDIT_ANCHOR_INVALID", 409);
  }
  const root = anchor.root;
  if (!exact(root, AUDIT_ROOT_KEYS)) throw new GatewayError("AUDIT_ANCHOR_INVALID", 409);
  const rootDate = String(root.rootDate);
  if (
    anchor.version !== 1 || root.organizationId !== ticket.organizationId ||
    root.rootHash !== ticket.rootHash ||
    anchor.signatureHash !== ticket.signatureHash ||
    root.auditSigningKeyGeneration !== ticket.auditSigningKeyGeneration ||
    anchor.signingDomain !== "ihome-openclaw-audit-root-v1\0" ||
    typeof anchor.canonicalRootJson !== "string" || typeof anchor.signature !== "string" ||
    !SIGNATURE.test(anchor.signature) || !DATE.test(rootDate) ||
    ticket.objectKey !==
      `v1/org/${ticket.organizationId}/audit/${rootDate}/${ticket.auditRootId}.json`
  ) throw new GatewayError("AUDIT_ANCHOR_INVALID", 409);
  const parsedDate = Date.parse(`${rootDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0, 10) !== rootDate) {
    throw new GatewayError("AUDIT_ANCHOR_INVALID", 409);
  }
  let parsedRoot: unknown;
  try {
    parsedRoot = JSON.parse(anchor.canonicalRootJson);
  } catch {
    throw new GatewayError("AUDIT_ANCHOR_INVALID", 409);
  }
  if (
    !exact(parsedRoot, AUDIT_ROOT_KEYS) || canonicalJson(root) !== anchor.canonicalRootJson ||
    canonicalJson(parsedRoot) !== anchor.canonicalRootJson || root.version !== 1 ||
    root.organizationId !== ticket.organizationId || root.rootDate !== rootDate ||
    root.rootHash !== ticket.rootHash ||
    !Number.isSafeInteger(root.firstSequence) || Number(root.firstSequence) < 1 ||
    !Number.isSafeInteger(root.lastSequence) || Number(root.lastSequence) < Number(root.firstSequence) ||
    !Number.isSafeInteger(root.eventCount) ||
    Number(root.eventCount) !== Number(root.lastSequence) - Number(root.firstSequence) + 1 ||
    !(root.previousRootHash === null ||
      (typeof root.previousRootHash === "string" && SHA256.test(root.previousRootHash))) ||
    typeof root.merkleRootHash !== "string" || !SHA256.test(root.merkleRootHash) ||
    typeof root.rootHash !== "string" || !SHA256.test(root.rootHash)
  ) throw new GatewayError("AUDIT_ANCHOR_INVALID", 409);
  const publicKey = await auditVerificationKey(
    env,
    ticket.auditSigningKeyGeneration,
    ticket.auditSigningPublicKeyHash,
    allowHistoricalAuditKey,
  );
  try {
    const signature = base64UrlDecode(anchor.signature);
    if (await sha256Hex(signature) !== anchor.signatureHash) throw new Error("signature hash");
    if (!await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      signature,
      new TextEncoder().encode(`ihome-openclaw-audit-root-v1\0${anchor.canonicalRootJson}`),
    )) throw new Error("signature invalid");
  } catch {
    throw new GatewayError("AUDIT_ANCHOR_INVALID", 409);
  }
}

export function assertAuditClaims(ticket: Awaited<ReturnType<typeof verifyTicketRequest>>): asserts ticket is
  Awaited<ReturnType<typeof verifyTicketRequest>> & {
    maintenancePrincipalId: string;
    workItemId: string;
    credentialGeneration: number;
    leaseGeneration: number;
    fencingToken: number;
    auditRootId: string;
    rootHash: string;
    signatureHash: string;
    auditSigningKeyGeneration: number;
    auditSigningPublicKeyHash: string;
  } {
  requireMaintenanceTicket(ticket);
  if (
    typeof ticket.auditRootId !== "string" || typeof ticket.rootHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(ticket.rootHash) || typeof ticket.signatureHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(ticket.signatureHash) ||
    !Number.isSafeInteger(ticket.auditSigningKeyGeneration) ||
    Number(ticket.auditSigningKeyGeneration) < 1 ||
    typeof ticket.auditSigningPublicKeyHash !== "string" ||
    !SHA256.test(ticket.auditSigningPublicKeyHash)
  ) throw new GatewayError("AUDIT_TICKET_INVALID", 403);
}

function objectVersion(object: R2Object): string {
  const value = object.version || object.etag;
  if (!value || value.length > 512) throw new GatewayError("R2_VERSION_INVALID", 500);
  return value;
}

export async function handleVerify(request: Request, env: MediaGatewayEnv): Promise<Response> {
  let ticket;
  let replayProbe: (() => Promise<Response | null>) | undefined;
  try {
    ticket = await verifyTicketRequest(request, env, "ANCHOR_VERIFY", {
      consumeJti: false,
      allowExpiredForReplay: true,
      skipStateAdmission: true,
    });
    assertAuditClaims(ticket);
  } catch (error) {
    if (error instanceof GatewayError) return errorResponse(error.code, error.status);
    return errorResponse("MEDIA_TICKET_INVALID", 403);
  }

  try {
    const workClaimId = `VERIFY:${ticket.workItemId}`;
    const lineage = maintenanceReceiptLineage(ticket);
    const replayHash = ticket.recoveryKind === "AUDIT_VERIFY_AUTHORIZED"
      ? await receiptClaimHash({
        kind: "AUDIT_ANCHOR_VERIFY_RECOVERY",
        organizationId: ticket.organizationId,
        workItemId: ticket.workItemId,
        currentMaintenancePrincipalId: ticket.maintenancePrincipalId,
        currentCredentialGeneration: ticket.credentialGeneration,
        currentLeaseGeneration: ticket.leaseGeneration,
        currentFencingToken: ticket.fencingToken,
        recoveryGeneration: ticket.recoveryGeneration,
        replacesVerifyTicketJti: ticket.replacesVerifyTicketJti,
        frozenClaim: lineage,
        verifyTicketJti: ticket.jti,
        objectKey: ticket.objectKey,
      })
      : await receiptClaimHash({
      kind: "AUDIT_ANCHOR_VERIFY_REPLAY",
      organizationId: ticket.organizationId,
      maintenancePrincipalId: ticket.maintenancePrincipalId,
      workItemId: ticket.workItemId,
      objectKey: ticket.objectKey,
      sha256: ticket.sha256,
      contentType: ticket.contentType,
      contentLength: ticket.contentLength,
      auditRootId: ticket.auditRootId,
      rootHash: ticket.rootHash,
      signatureHash: ticket.signatureHash,
      auditSigningKeyGeneration: ticket.auditSigningKeyGeneration,
      auditSigningPublicKeyHash: ticket.auditSigningPublicKeyHash,
    });
    const claimHash = ticket.recoveryKind === "AUDIT_VERIFY_AUTHORIZED"
      ? replayHash
      : await receiptClaimHash({
      kind: "AUDIT_ANCHOR_VERIFY",
      organizationId: ticket.organizationId,
      maintenancePrincipalId: ticket.maintenancePrincipalId,
      workItemId: ticket.workItemId,
      claimGeneration: ticket.claimGeneration,
      credentialGeneration: ticket.credentialGeneration,
      leaseGeneration: ticket.leaseGeneration,
      fencingToken: ticket.fencingToken,
      objectKey: ticket.objectKey,
      sha256: ticket.sha256,
      contentType: ticket.contentType,
      contentLength: ticket.contentLength,
      auditRootId: ticket.auditRootId,
      rootHash: ticket.rootHash,
      signatureHash: ticket.signatureHash,
      auditSigningKeyGeneration: ticket.auditSigningKeyGeneration,
      auditSigningPublicKeyHash: ticket.auditSigningPublicKeyHash,
      verifyTicketJti: ticket.jti,
      receiptSigningKeyGeneration: ticket.receiptSigningKeyGeneration,
    });
    let work = await getWorkState(
      env,
      ticket.organizationId,
      ticket.accountId,
      workClaimId,
    );
    const workflowExpired = work?.expiresAtEpochSeconds !== undefined &&
      work.expiresAtEpochSeconds <= Math.floor(Date.now() / 1_000);
    const recoveryCanReplace = ticket.recoveryKind === "AUDIT_VERIFY_AUTHORIZED" &&
      (workflowExpired || work?.phase === "AUTHORIZED");
    if (work && work.claimHash !== claimHash && !recoveryCanReplace) {
      throw new TicketStateConflictError();
    }
    if (
      work?.claimHash === claimHash && work.phase === "RECEIPT_STORED" && work.receipt &&
      !workflowExpired
    ) return storedReceiptResponse(work.receipt);
    replayProbe = async () => {
      try {
        const stored = await getStoredWorkflowReceipt(
          env,
          ticket.organizationId,
          ticket.accountId,
          workClaimId,
          claimHash,
          "VERIFY",
          replayHash,
        );
        return stored?.receipt ? storedReceiptResponse(stored.receipt) : null;
      } catch (error) {
        if (
          ticket.recoveryKind === "AUDIT_VERIFY_AUTHORIZED" &&
          (error instanceof TicketStateConflictError || error instanceof TicketStateExpiredError)
        ) return null;
        throw error;
      }
    };
    const racedReceipt = await replayProbe();
    if (racedReceipt) return racedReceipt;
    const exactInProgress = work?.claimHash === claimHash &&
      work.phase === "DELETE_IN_PROGRESS" && work.kind === "VERIFY" &&
      work.replayHash === replayHash;
    if (!exactInProgress) {
      if (Math.floor(Date.now() / 1_000) >= ticket.exp) {
        throw new GatewayError("TICKET_EXPIRED_NO_WORK", 410);
      }
      try {
        await verifyTicketRequest(request, env, "ANCHOR_VERIFY", {
          consumeJti: false,
          skipStateAdmission: true,
        });
      } catch {
        throw new GatewayError("MEDIA_TICKET_INVALID", 403);
      }
      await admitTicket(env, ticket, false);
    }
    const executorId = crypto.randomUUID();
    let ownsExecution = false;
    const receiptSigner = await prepareReceiptSigner(env, ticket);
    const receiptSigningKeyGeneration = receiptSigner.generation;

    if (ticket.contentLength > MAX_AUDIT_BYTES) {
      throw new GatewayError("AUDIT_ANCHOR_INVALID", 409);
    }
    const object = await env.MEDIA.get(ticket.objectKey);
    if (!object) throw new GatewayError("OBJECT_NOT_FOUND", 404);
    const version = objectVersion(object);
    if (object.size !== ticket.contentLength) {
      throw new GatewayError("OBJECT_INTEGRITY_MISMATCH", 409);
    }
    if (
      work?.phase === "DELETE_IN_PROGRESS" &&
      work.progress?.versionOrEtag !== version
    ) throw new GatewayError("OBJECT_VERSION_CONFLICT", 409);
    const bytes = await object.bytes();
    const policy = evaluateMediaPolicy({
      bytes,
      declaredContentType: ticket.contentType,
      declaredContentLength: ticket.contentLength,
      declaredSha256: ticket.sha256,
      actualSha256: await sha256Hex(bytes),
    });
    if (!policy.ok) throw new GatewayError("OBJECT_INTEGRITY_MISMATCH", 409);
    let anchor: unknown;
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    try {
      anchor = JSON.parse(text);
    } catch {
      throw new GatewayError("AUDIT_ANCHOR_INVALID", 409);
    }
    await verifyAuditDocument(
      anchor,
      text,
      ticket,
      env,
      exactInProgress || ticket.recoveryKind === "AUDIT_VERIFY_AUTHORIZED",
    );
    await assertReceiptSignerCurrent(env, receiptSigner);

    work = await beginWorkflow(
      env,
      ticket.organizationId,
      ticket.accountId,
      workClaimId,
      claimHash,
      "VERIFY",
      [{ jti: ticket.jti, expiresAtEpochSeconds: ticket.exp }],
      ticket,
      exactInProgress,
      replayHash,
      ticket.recoveryKind === "AUDIT_VERIFY_AUTHORIZED"
        ? "AUTHORIZED_OR_EXPIRED"
        : "NONE",
      ticket.recoveryKind === "AUDIT_VERIFY_AUTHORIZED"
        ? [ticket.replacesVerifyTicketJti as string]
        : [],
      "DELETE_IN_PROGRESS",
    );
    if (work.phase === "RECEIPT_STORED" && work.receipt) {
      return storedReceiptResponse(work.receipt);
    }

    const execution = await acquireWorkExecutionOrWait(
      env,
      ticket.organizationId,
      ticket.accountId,
      workClaimId,
      claimHash,
      { versionOrEtag: version },
      executorId,
    );
    work = execution.work;
    if (work.phase === "RECEIPT_STORED" && work.receipt) {
      return storedReceiptResponse(work.receipt);
    }
    ownsExecution = execution.acquired;
    if (!ownsExecution) throw new GatewayError("VERIFY_RECOVERY_STATE_INVALID", 500);

    try {
      const receipt = await signReceipt(env, "ihome-openclaw-audit-receipt-v1", {
      version: 1,
      receiptKind: "AUDIT_ANCHOR_VERIFY",
      receiptId: crypto.randomUUID(),
      organizationId: ticket.organizationId,
      maintenancePrincipalId: lineage.maintenancePrincipalId,
      workItemId: ticket.workItemId,
      claimGeneration: lineage.claimGeneration,
      credentialGeneration: lineage.credentialGeneration,
      leaseGeneration: lineage.leaseGeneration,
      fencingToken: lineage.fencingToken,
      auditRootId: ticket.auditRootId,
      rootHash: ticket.rootHash,
      anchorKey: ticket.objectKey,
      signatureHash: ticket.signatureHash,
      auditSigningKeyGeneration: ticket.auditSigningKeyGeneration,
      verifyTicketJti: ticket.jti,
      objectVersionOrEtag: version,
      verifiedAt: new Date().toISOString(),
      gatewaySigningKeyGeneration: receiptSigningKeyGeneration,
      }, receiptSigner);
      await assertReceiptSignerCurrent(env, receiptSigner);
      const stored = await storeWorkReceipt(
        env,
        ticket.organizationId,
        ticket.accountId,
        workClaimId,
        claimHash,
        receipt,
        executorId,
      );
      return storedReceiptResponse(stored);
    } finally {
      if (ownsExecution) {
        await releaseWorkExecution(
          env,
          ticket.organizationId,
          ticket.accountId,
          workClaimId,
          claimHash,
          executorId,
        );
      }
    }
  } catch (caught) {
    let error = caught;
    if (replayProbe) {
      try {
        const racedReceipt = await replayProbe();
        if (racedReceipt) return racedReceipt;
      } catch (probeError) {
        error = probeError;
      }
    }
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
    if (error instanceof GatewayError) return errorResponse(error.code, error.status);
    return errorResponse("VERIFY_FAILED", 500);
  }
}
