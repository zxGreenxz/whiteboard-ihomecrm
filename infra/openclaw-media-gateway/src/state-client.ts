import type { MediaGatewayEnv } from "./env";
import type {
  GenerationFloors,
  GenerationKey,
  GenerationPrincipal,
  StoredReceipt,
  StoredWorkState,
  WorkExecution,
  WorkKind,
  WorkflowRecoveryReplacement,
  TicketAdmission,
} from "./ticket-state";
import type { MediaTicketClaims } from "./ticket";

export class TicketStateConflictError extends Error {}
export class TicketStateBusyError extends Error {}
export class TicketStateRevokedError extends Error {}
export class TicketStateExpiredError extends Error {}
export class ObjectFinalDeletedError extends Error {}

async function statePost<T>(
  env: MediaGatewayEnv,
  name: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const id = env.TICKET_STATE.idFromName(name);
  const response = await env.TICKET_STATE.get(id).fetch(`https://ticket-state.invalid${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 409) {
    const payload: { error?: string } = await response.json<{ error?: string }>()
      .catch(() => ({}));
    if (payload.error === "TICKET_GENERATION_REVOKED") {
      throw new TicketStateRevokedError("TICKET_GENERATION_REVOKED");
    }
    if (payload.error === "WORKFLOW_EXPIRED") {
      throw new TicketStateExpiredError("WORKFLOW_EXPIRED");
    }
    if (payload.error === "OBJECT_MUTATION_LEASE_MISMATCH") {
      throw new TicketStateBusyError("OBJECT_MUTATION_LEASE_MISMATCH");
    }
    throw new TicketStateConflictError(payload.error ?? "ticket state claim conflict");
  }
  if (!response.ok) throw new Error("ticket state operation failed");
  return await response.json<T>();
}

export async function consumeRevocationNonce(
  env: MediaGatewayEnv,
  organizationId: string,
  accountId: string,
  nonce: string,
  seenAtEpochSeconds: number,
): Promise<boolean> {
  const result = await statePost<{ consumed: boolean }>(
    env,
    `${organizationId}:${accountId}`,
    "/consume-revocation-nonce",
    { nonce, seenAtEpochSeconds },
  );
  return result.consumed === true;
}

export async function applyGenerationRevocation(
  env: MediaGatewayEnv,
  key: GenerationKey,
  nonce: string,
  seenAtEpochSeconds: number,
  minimumValidGeneration: number,
  revocationHash: string,
  acknowledgement: Record<string, unknown>,
): Promise<{ applied: boolean; generation: number; acknowledgement?: Record<string, unknown> }> {
  return await statePost<{
    applied: boolean;
    generation: number;
    acknowledgement?: Record<string, unknown>;
  }>(
    env,
    generationStateName(key),
    "/apply-revocation",
    {
      ...key,
      nonce,
      seenAtEpochSeconds,
      minimumValidGeneration,
      revocationHash,
      acknowledgement,
    },
  );
}

export function admissionForTicket(ticket: MediaTicketClaims): TicketAdmission {
  const maintenance = ticket.subject === "MAINTENANCE";
  return {
    principal: maintenance
      ? {
        organizationId: ticket.organizationId,
        principalKind: "MAINTENANCE",
        accountId: null,
        cellId: null,
        maintenancePrincipalId: ticket.maintenancePrincipalId ?? null,
      }
      : {
        organizationId: ticket.organizationId,
        principalKind: "CHANNEL",
        accountId: ticket.accountId,
        cellId: ticket.subject === "RUNTIME" ? ticket.cellId ?? null : null,
        maintenancePrincipalId: null,
      },
    generations: {
      sessionGeneration: ticket.sessionGeneration,
      credentialGeneration: ticket.credentialGeneration ?? 0,
      leaseGeneration: ticket.leaseGeneration ?? 0,
      fencingToken: ticket.fencingToken ?? 0,
    },
    nowEpochSeconds: Math.floor(Date.now() / 1_000),
  };
}

export async function admitTicket(
  env: MediaGatewayEnv,
  ticket: MediaTicketClaims,
  consumeJti: boolean,
): Promise<void> {
  await statePost<{ admitted: true }>(
    env,
    generationStateName(admissionForTicket(ticket).principal),
    "/admit-ticket",
    {
      admission: admissionForTicket(ticket),
      jti: ticket.jti,
      expiresAtEpochSeconds: ticket.exp,
      consumeJti,
    },
  );
}

export async function raiseMinimumGeneration(
  env: MediaGatewayEnv,
  key: GenerationKey,
  minimumValidGeneration: number,
): Promise<number> {
  const result = await statePost<{ generation: number }>(
    env,
    generationStateName(key),
    "/raise-generation",
    { ...key, minimumValidGeneration },
  );
  return result.generation;
}

function generationStateName(principal: GenerationPrincipal): string {
  return `${principal.organizationId}:${
    principal.principalKind === "CHANNEL" ? principal.accountId : "-"
  }`;
}

export async function generationFloors(
  env: MediaGatewayEnv,
  principal: GenerationPrincipal,
): Promise<GenerationFloors> {
  const result = await statePost<{ floors: GenerationFloors }>(
    env,
    generationStateName(principal),
    "/generation-floors",
    { ...principal },
  );
  return result.floors;
}

export async function consumeTicketJti(
  env: MediaGatewayEnv,
  organizationId: string,
  accountId: string | null,
  jti: string,
  expiresAtEpochSeconds: number,
): Promise<boolean> {
  const result = await statePost<{ consumed: boolean }>(
    env,
    `${organizationId}:${accountId ?? "-"}`,
    "/consume-jti",
    { jti, expiresAtEpochSeconds },
  );
  return result.consumed === true;
}

function workStateName(organizationId: string, accountId: string | null): string {
  return `${organizationId}:${accountId ?? "-"}`;
}

function objectStateName(objectKey: string): string {
  return `OBJECT:${objectKey}`;
}

export async function acquireObjectMutationOrWait(
  env: MediaGatewayEnv,
  objectKey: string,
  kind: "UPLOAD" | "DELETE",
  executorId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lease = await statePost<{ acquired: boolean; tombstoned: boolean }>(
      env,
      objectStateName(objectKey),
      "/acquire-object-mutation",
      { kind, executorId, nowEpochMilliseconds: Date.now() },
    );
    if (lease.tombstoned && kind === "UPLOAD") {
      throw new ObjectFinalDeletedError("OBJECT_FINAL_DELETED");
    }
    if (lease.acquired) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new TicketStateBusyError("object mutation is already in progress");
}

export async function renewObjectMutation(
  env: MediaGatewayEnv,
  objectKey: string,
  kind: "UPLOAD" | "DELETE",
  executorId: string,
): Promise<void> {
  const lease = await statePost<{ acquired: boolean; tombstoned: boolean }>(
    env,
    objectStateName(objectKey),
    "/acquire-object-mutation",
    { kind, executorId, nowEpochMilliseconds: Date.now() },
  );
  if (lease.tombstoned && kind === "UPLOAD") {
    throw new ObjectFinalDeletedError("OBJECT_FINAL_DELETED");
  }
  if (!lease.acquired) throw new TicketStateBusyError("object mutation lease lost");
}

export async function markObjectFinalDeleted(
  env: MediaGatewayEnv,
  objectKey: string,
  executorId: string,
): Promise<void> {
  await statePost<Record<string, never>>(
    env,
    objectStateName(objectKey),
    "/mark-object-final-deleted",
    { executorId, nowEpochMilliseconds: Date.now() },
  );
}

export async function releaseObjectMutation(
  env: MediaGatewayEnv,
  objectKey: string,
  executorId: string,
): Promise<void> {
  await statePost<Record<string, never>>(
    env,
    objectStateName(objectKey),
    "/release-object-mutation",
    { executorId },
  );
}

export async function beginWorkflow(
  env: MediaGatewayEnv,
  organizationId: string,
  accountId: string | null,
  workClaimId: string,
  claimHash: string,
  kind: WorkKind,
  bindings: readonly { jti: string; expiresAtEpochSeconds: number }[],
  ticket: MediaTicketClaims,
  allowStaleRecovery = false,
  replayHash = claimHash,
  recoveryReplacement: WorkflowRecoveryReplacement = "NONE",
  replacementJtis: readonly string[] = [],
  initialPhase: "AUTHORIZED" | "DELETE_IN_PROGRESS" = "AUTHORIZED",
): Promise<StoredWorkState> {
  const result = await statePost<{ work: StoredWorkState }>(
    env,
    workStateName(organizationId, accountId),
    "/begin-workflow",
    {
      workClaimId,
      claimHash,
      kind,
      bindings,
      admission: admissionForTicket(ticket),
      allowStaleRecovery,
      replayHash,
      recoveryReplacement,
      replacementJtis,
      initialPhase,
    },
  );
  return result.work;
}

export async function getWorkState(
  env: MediaGatewayEnv,
  organizationId: string,
  accountId: string | null,
  workClaimId: string,
): Promise<StoredWorkState | null> {
  const result = await statePost<{ work: StoredWorkState | null }>(
    env,
    workStateName(organizationId, accountId),
    "/work-state",
    { workClaimId },
  );
  return result.work;
}

export async function getStoredWorkflowReceipt(
  env: MediaGatewayEnv,
  organizationId: string,
  accountId: string | null,
  workClaimId: string,
  claimHash: string,
  kind: WorkKind,
  replayHash: string,
): Promise<StoredWorkState | null> {
  const result = await statePost<{ work: StoredWorkState | null }>(
    env,
    workStateName(organizationId, accountId),
    "/begin-workflow",
    {
      workClaimId,
      claimHash,
      kind,
      replayHash,
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
      createIfMissing: false,
    },
  );
  return result.work;
}

export async function acquireWorkExecution(
  env: MediaGatewayEnv,
  organizationId: string,
  accountId: string | null,
  workClaimId: string,
  claimHash: string,
  progress: Record<string, unknown>,
  executorId: string,
): Promise<WorkExecution> {
  return await statePost<WorkExecution>(
    env,
    workStateName(organizationId, accountId),
    "/acquire-work-execution",
    { workClaimId, claimHash, progress, executorId, nowEpochMilliseconds: Date.now() },
  );
}

export async function acquireWorkExecutionOrWait(
  env: MediaGatewayEnv,
  organizationId: string,
  accountId: string | null,
  workClaimId: string,
  claimHash: string,
  progress: Record<string, unknown>,
  executorId: string,
): Promise<WorkExecution> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const execution = await acquireWorkExecution(
      env,
      organizationId,
      accountId,
      workClaimId,
      claimHash,
      progress,
      executorId,
    );
    if (execution.acquired || execution.work.phase === "RECEIPT_STORED") return execution;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new TicketStateBusyError("work execution is already in progress");
}

export async function releaseWorkExecution(
  env: MediaGatewayEnv,
  organizationId: string,
  accountId: string | null,
  workClaimId: string,
  claimHash: string,
  executorId: string,
): Promise<void> {
  await statePost<Record<string, never>>(
    env,
    workStateName(organizationId, accountId),
    "/release-work-execution",
    { workClaimId, claimHash, executorId },
  );
}

export async function markWorkInProgress(
  env: MediaGatewayEnv,
  organizationId: string,
  accountId: string | null,
  workClaimId: string,
  claimHash: string,
  progress: Record<string, unknown>,
): Promise<StoredWorkState> {
  const result = await statePost<{ work: StoredWorkState }>(
    env,
    workStateName(organizationId, accountId),
    "/mark-work-in-progress",
    { workClaimId, claimHash, progress },
  );
  return result.work;
}

export async function storeWorkReceipt(
  env: MediaGatewayEnv,
  organizationId: string,
  accountId: string | null,
  workClaimId: string,
  claimHash: string,
  receipt: StoredReceipt,
  executorId?: string,
): Promise<StoredReceipt> {
  const result = await statePost<{ receipt: StoredReceipt }>(
    env,
    workStateName(organizationId, accountId),
    "/store-work-receipt",
    { workClaimId, claimHash, receipt, executorId },
  );
  return result.receipt;
}
