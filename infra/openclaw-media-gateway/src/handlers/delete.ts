import type { MediaGatewayEnv } from "../env";
import { GatewayError } from "../gateway-error";
import {
  assertReceiptSignerCurrent,
  maintenanceReceiptLineage,
  receiptClaimHash,
  requireMaintenanceTicket,
  prepareReceiptSigner,
  signReceipt,
  storedReceiptResponse,
  verifyDeleteAuthorization,
} from "../receipts";
import { errorResponse } from "../responses";
import {
  acquireWorkExecutionOrWait,
  acquireObjectMutationOrWait,
  admitTicket,
  beginWorkflow,
  getWorkState,
  getStoredWorkflowReceipt,
  markObjectFinalDeleted,
  releaseObjectMutation,
  releaseWorkExecution,
  renewObjectMutation,
  storeWorkReceipt,
  TicketStateBusyError,
  TicketStateConflictError,
  TicketStateExpiredError,
  TicketStateRevokedError,
} from "../state-client";
import type { StoredWorkState } from "../ticket-state";
import { verifyTicketRequest } from "../ticket-verifier";

interface DeleteProgress {
  objectExisted: boolean;
  versionOrEtag: string | null;
}

function deleteProgress(work: StoredWorkState): DeleteProgress | null {
  const progress = work.progress;
  if (!progress || typeof progress.objectExisted !== "boolean") return null;
  if (
    progress.versionOrEtag !== null && typeof progress.versionOrEtag !== "string"
  ) return null;
  return {
    objectExisted: progress.objectExisted,
    versionOrEtag: progress.versionOrEtag,
  };
}

function versionOrEtag(object: R2Object): string {
  const value = object.version || object.etag;
  if (!value || value.length > 512) throw new GatewayError("R2_VERSION_INVALID", 500);
  return value;
}

export async function handleDelete(request: Request, env: MediaGatewayEnv): Promise<Response> {
  let ticket;
  let authorization;
  let replayProbe: (() => Promise<Response | null>) | undefined;
  try {
    ticket = await verifyTicketRequest(request, env, "DELETE", {
      deleteAuthorizationPresent: request.headers.has("x-openclaw-delete-authorization"),
      consumeJti: false,
      allowExpiredForReplay: true,
      skipStateAdmission: true,
    });
    requireMaintenanceTicket(ticket);
    authorization = await verifyDeleteAuthorization(request, env, ticket, new Date(), true);
  } catch (error) {
    if (error instanceof GatewayError) return errorResponse(error.code, error.status);
    return errorResponse("MEDIA_TICKET_INVALID", 403);
  }

  try {
    const workClaimId = `DELETE:${ticket.workItemId}`;
    const lineage = maintenanceReceiptLineage(ticket);
    const replayHash = ticket.recoveryKind === "RETENTION_DELETE_AUTHORIZED"
      ? await receiptClaimHash({
        kind: "RETENTION_FINAL_DELETE_RECOVERY",
        organizationId: ticket.organizationId,
        workItemId: ticket.workItemId,
        currentMaintenancePrincipalId: ticket.maintenancePrincipalId,
        currentCredentialGeneration: ticket.credentialGeneration,
        currentLeaseGeneration: ticket.leaseGeneration,
        currentFencingToken: ticket.fencingToken,
        recoveryGeneration: ticket.recoveryGeneration,
        replacesTicketJti: ticket.replacesTicketJti,
        replacesDeleteAuthorizationJti: ticket.replacesDeleteAuthorizationJti,
        frozenClaim: lineage,
        deleteTicketJti: ticket.jti,
        deleteAuthorizationJti: authorization.authorizationJti,
        objectKey: ticket.objectKey,
      })
      : await receiptClaimHash({
      kind: "RETENTION_FINAL_DELETE_REPLAY",
      organizationId: ticket.organizationId,
      maintenancePrincipalId: ticket.maintenancePrincipalId,
      workItemId: ticket.workItemId,
      objectKey: ticket.objectKey,
      sha256: ticket.sha256,
      contentType: ticket.contentType,
      contentLength: ticket.contentLength,
      deletePhase: ticket.deletePhase,
      quarantineVersion: authorization.quarantineVersion,
      holdVersion: authorization.holdVersion,
      finalDeleteNotBefore: ticket.finalDeleteNotBefore,
    });
    const claimHash = ticket.recoveryKind === "RETENTION_DELETE_AUTHORIZED"
      ? replayHash
      : await receiptClaimHash({
      kind: "RETENTION_FINAL_DELETE",
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
      deletePhase: ticket.deletePhase,
      quarantineVersion: authorization.quarantineVersion,
      holdVersion: authorization.holdVersion,
      finalDeleteNotBefore: ticket.finalDeleteNotBefore,
      deleteTicketJti: ticket.jti,
      deleteAuthorizationJti: authorization.authorizationJti,
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
    const recoveryCanReplace = ticket.recoveryKind === "RETENTION_DELETE_AUTHORIZED" &&
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
          "DELETE",
          replayHash,
        );
        return stored?.receipt ? storedReceiptResponse(stored.receipt) : null;
      } catch (error) {
        if (
          ticket.recoveryKind === "RETENTION_DELETE_AUTHORIZED" &&
          (error instanceof TicketStateConflictError || error instanceof TicketStateExpiredError)
        ) return null;
        throw error;
      }
    };
    const racedReceipt = await replayProbe();
    if (racedReceipt) return racedReceipt;
    const exactInProgress = work?.claimHash === claimHash &&
      work.phase === "DELETE_IN_PROGRESS" && work.kind === "DELETE" &&
      work.replayHash === replayHash;
    if (!exactInProgress) {
      // Expiry is bypassed only to authenticate an already-persisted replay.
      // New work must still present a currently valid ticket and five-second proof.
      if (
        Math.floor(Date.now() / 1_000) >= ticket.exp ||
        Date.now() >= Date.parse(authorization.exp)
      ) throw new GatewayError("TICKET_EXPIRED_NO_WORK", 410);
      try {
        await verifyTicketRequest(request, env, "DELETE", {
          deleteAuthorizationPresent: true,
          consumeJti: false,
          skipStateAdmission: true,
        });
      } catch {
        throw new GatewayError("MEDIA_TICKET_INVALID", 403);
      }
      await verifyDeleteAuthorization(request, env, ticket);
      await admitTicket(env, ticket, false);
    }
    const receiptSigner = await prepareReceiptSigner(env, ticket);
    const receiptSigningKeyGeneration = receiptSigner.generation;
    await assertReceiptSignerCurrent(env, receiptSigner);
    const executorId = crypto.randomUUID();
    let ownsExecution = false;
    const objectExecutorId = crypto.randomUUID();
    await acquireObjectMutationOrWait(env, ticket.objectKey, "DELETE", objectExecutorId);
    try {
      await renewObjectMutation(env, ticket.objectKey, "DELETE", objectExecutorId);
      await assertReceiptSignerCurrent(env, receiptSigner);
      work = await beginWorkflow(
        env,
        ticket.organizationId,
        ticket.accountId,
        workClaimId,
        claimHash,
        "DELETE",
        [
          { jti: ticket.jti, expiresAtEpochSeconds: ticket.exp },
          {
            jti: authorization.authorizationJti,
            expiresAtEpochSeconds: Math.floor(Date.parse(authorization.exp) / 1_000),
          },
        ],
        ticket,
        exactInProgress,
        replayHash,
        ticket.recoveryKind === "RETENTION_DELETE_AUTHORIZED"
          ? "AUTHORIZED_OR_EXPIRED"
          : "NONE",
        ticket.recoveryKind === "RETENTION_DELETE_AUTHORIZED"
          ? [ticket.replacesTicketJti as string, ticket.replacesDeleteAuthorizationJti as string]
          : [],
        "DELETE_IN_PROGRESS",
      );
      if (work.phase === "RECEIPT_STORED" && work.receipt) {
        return storedReceiptResponse(work.receipt);
      }

      let progress = deleteProgress(work);
      if (!progress) {
        await renewObjectMutation(env, ticket.objectKey, "DELETE", objectExecutorId);
        await assertReceiptSignerCurrent(env, receiptSigner);
        const object = await env.MEDIA.head(ticket.objectKey);
        progress = {
          objectExisted: object !== null,
          versionOrEtag: object ? versionOrEtag(object) : null,
        };
      }
      if (!progress) throw new GatewayError("DELETE_RECOVERY_STATE_INVALID", 500);

      const execution = await acquireWorkExecutionOrWait(
        env,
        ticket.organizationId,
        ticket.accountId,
        workClaimId,
        claimHash,
        { ...progress },
        executorId,
      );
      work = execution.work;
      if (work.phase === "RECEIPT_STORED" && work.receipt) {
        return storedReceiptResponse(work.receipt);
      }
      ownsExecution = execution.acquired;
      progress = deleteProgress(work);
      if (!ownsExecution || !progress) throw new GatewayError("DELETE_RECOVERY_STATE_INVALID", 500);

      try {
      await assertReceiptSignerCurrent(env, receiptSigner);
      await renewObjectMutation(env, ticket.objectKey, "DELETE", objectExecutorId);
      await assertReceiptSignerCurrent(env, receiptSigner);
      await markObjectFinalDeleted(env, ticket.objectKey, objectExecutorId);
      let objectStatus: "DELETED" | "NOT_FOUND";
      if (!progress.objectExisted) {
        objectStatus = "NOT_FOUND";
      } else {
        if (!progress.versionOrEtag) throw new GatewayError("DELETE_RECOVERY_STATE_INVALID", 500);
        const current = await env.MEDIA.head(ticket.objectKey);
        if (current) {
          if (versionOrEtag(current) !== progress.versionOrEtag) {
            throw new GatewayError("OBJECT_VERSION_CONFLICT", 409);
          }
          await assertReceiptSignerCurrent(env, receiptSigner);
          await renewObjectMutation(env, ticket.objectKey, "DELETE", objectExecutorId);
          await assertReceiptSignerCurrent(env, receiptSigner);
          await env.MEDIA.delete(ticket.objectKey);
          if (await env.MEDIA.head(ticket.objectKey)) {
            throw new GatewayError("OBJECT_DELETE_UNCONFIRMED", 500);
          }
        }
        objectStatus = "DELETED";
      }

      await renewObjectMutation(env, ticket.objectKey, "DELETE", objectExecutorId);
      await assertReceiptSignerCurrent(env, receiptSigner);
      const receipt = await signReceipt(env, "ihome-openclaw-retention-receipt-v1", {
      version: 1,
      receiptKind: "RETENTION_FINAL_DELETE",
      receiptId: crypto.randomUUID(),
      organizationId: ticket.organizationId,
      maintenancePrincipalId: lineage.maintenancePrincipalId,
      workItemId: ticket.workItemId,
      claimGeneration: lineage.claimGeneration,
      credentialGeneration: lineage.credentialGeneration,
      leaseGeneration: lineage.leaseGeneration,
      fencingToken: lineage.fencingToken,
      objectKey: ticket.objectKey,
      deletePhase: "FINAL_DELETE",
      holdVersion: authorization.holdVersion,
      quarantineVersion: authorization.quarantineVersion,
      deleteTicketJti: ticket.jti,
      deleteAuthorizationJti: authorization.authorizationJti,
      proofJti: authorization.authorizationJti,
      objectStatus,
      r2VersionOrEtag: objectStatus === "DELETED" ? progress.versionOrEtag : null,
      completedAt: new Date().toISOString(),
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
    } finally {
      await releaseObjectMutation(env, ticket.objectKey, objectExecutorId);
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
    return errorResponse("DELETE_FAILED", 500);
  }
}
