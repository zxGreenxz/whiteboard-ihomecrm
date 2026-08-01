/**
 * Durable-object-backed state for the media gateway.
 *
 * Three jobs, all of which must survive a crash at any boundary:
 *   1. consume every ticket `jti` exactly once;
 *   2. track the minimum valid session/credential generation per principal, so a
 *      disconnect invalidates every older ticket immediately;
 *   3. persist the retention/anchor state machine
 *      AUTHORIZED -> DELETE_IN_PROGRESS -> RECEIPT_STORED
 *      together with the one canonical signed receipt.
 */

export type DeletePhaseState = "AUTHORIZED" | "DELETE_IN_PROGRESS" | "RECEIPT_STORED";
export type WorkKind = "DELETE" | "VERIFY" | "UPLOAD";
export type WorkflowRecoveryReplacement = "NONE" | "AUTHORIZED_OR_EXPIRED";

export interface StoredWorkState {
  phase: DeletePhaseState;
  claimHash?: string;
  replayHash?: string;
  kind?: WorkKind;
  bindingJtis?: string[];
  progress?: Record<string, unknown>;
  receipt?: StoredReceipt;
  executorId?: string;
  executorLeaseExpiresAt?: number;
  expiresAtEpochSeconds?: number;
}

export interface WorkExecution {
  work: StoredWorkState;
  acquired: boolean;
}

export interface ObjectMutationLease {
  acquired: boolean;
  tombstoned: boolean;
}

export interface StoredReceipt {
  /** Canonical JSON bytes of the receipt, exactly as signed. */
  canonicalJson: string;
  signature: string;
  sha256: string;
}

export type GenerationDimension = "SESSION" | "CREDENTIAL" | "LEASE" | "CELL";
export type GenerationPrincipalKind = "CHANNEL" | "MAINTENANCE";

export interface GenerationPrincipal {
  organizationId: string;
  principalKind: GenerationPrincipalKind;
  accountId: string | null;
  cellId: string | null;
  maintenancePrincipalId: string | null;
}

export interface GenerationKey extends GenerationPrincipal {
  dimension: GenerationDimension;
}

export interface GenerationFloors {
  sessionGeneration: number;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
}

export interface AppliedRevocation {
  applied: boolean;
  generation: number;
  acknowledgement?: Record<string, unknown>;
}

export interface TicketAdmission {
  principal: GenerationPrincipal;
  generations: GenerationFloors;
  nowEpochSeconds?: number;
}

export interface TicketStateStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list?<T>(options: { prefix: string; end?: string; limit?: number }): Promise<Map<string, T>>;
}

function generationKey(key: GenerationKey): string {
  if (key.principalKind === "CHANNEL") {
    if (!key.accountId || key.maintenancePrincipalId !== null) {
      throw new Error("invalid channel generation principal");
    }
    if (key.dimension === "SESSION") {
      return `gen:SESSION:${key.organizationId}:${key.accountId}`;
    }
    if (!key.cellId) throw new Error("channel generation floor requires a cell");
    return `gen:${key.dimension}:${key.organizationId}:${key.accountId}:${key.cellId}`;
  }
  if (
    key.principalKind !== "MAINTENANCE" || key.accountId !== null || key.cellId !== null ||
    !key.maintenancePrincipalId || key.dimension === "SESSION"
  ) throw new Error("invalid maintenance generation principal");
  return `gen:${key.dimension}:${key.organizationId}:${key.maintenancePrincipalId}`;
}

function jtiKey(jti: string): string {
  return `jti:${jti}`;
}

interface BoundJti {
  expiresAtEpochSeconds: number;
  claimHash?: string;
}

interface StoredRevocationNonce {
  seenAtEpochSeconds: number;
  expiresAtEpochSeconds: number;
  revocationHash: string;
  acknowledgement: Record<string, unknown>;
}

const REVOCATION_NONCE_RETENTION_SECONDS = 300;
const WORK_RETENTION_SECONDS = 7 * 24 * 60 * 60;

function expiryKey(expiresAtEpochSeconds: number, targetKey: string): string {
  return `expiry:${String(expiresAtEpochSeconds).padStart(12, "0")}:${targetKey}`;
}

function workKey(workClaimId: string): string {
  return `work:${workClaimId}`;
}

function nonceKey(nonce: string): string {
  return `nonce:${nonce}`;
}

interface StoredObjectMutationLease {
  executorId: string;
  kind: "UPLOAD" | "DELETE";
  expiresAtEpochMilliseconds: number;
}

const OBJECT_MUTATION_LEASE_KEY = "object-mutation-lease";
const OBJECT_FINAL_DELETE_TOMBSTONE_KEY = "object-final-delete-tombstone";

export class TicketStateStore {
  constructor(private readonly storage: TicketStateStorage) {}

  async acquireObjectMutation(
    kind: "UPLOAD" | "DELETE",
    executorId: string,
    nowEpochMilliseconds: number,
    leaseMilliseconds: number,
  ): Promise<ObjectMutationLease> {
    const tombstoned = await this.storage.get<boolean>(OBJECT_FINAL_DELETE_TOMBSTONE_KEY) === true;
    if (tombstoned && kind === "UPLOAD") return { acquired: false, tombstoned: true };
    const existing = await this.storage.get<StoredObjectMutationLease>(OBJECT_MUTATION_LEASE_KEY);
    if (
      existing && existing.executorId !== executorId &&
      existing.expiresAtEpochMilliseconds > nowEpochMilliseconds
    ) return { acquired: false, tombstoned };
    await this.storage.put<StoredObjectMutationLease>(OBJECT_MUTATION_LEASE_KEY, {
      executorId,
      kind,
      expiresAtEpochMilliseconds: nowEpochMilliseconds + leaseMilliseconds,
    });
    return { acquired: true, tombstoned };
  }

  async markObjectFinalDeleted(
    executorId: string,
    nowEpochMilliseconds: number,
  ): Promise<void> {
    const lease = await this.storage.get<StoredObjectMutationLease>(OBJECT_MUTATION_LEASE_KEY);
    if (
      !lease || lease.executorId !== executorId || lease.kind !== "DELETE" ||
      lease.expiresAtEpochMilliseconds <= nowEpochMilliseconds
    ) {
      throw new Error("object mutation lease mismatch");
    }
    await this.storage.put(OBJECT_FINAL_DELETE_TOMBSTONE_KEY, true);
  }

  async releaseObjectMutation(executorId: string): Promise<void> {
    const lease = await this.storage.get<StoredObjectMutationLease>(OBJECT_MUTATION_LEASE_KEY);
    if (lease?.executorId === executorId) await this.storage.delete(OBJECT_MUTATION_LEASE_KEY);
  }

  /**
   * Returns true when this call is the one that consumed the ticket. A replay
   * returns false, which every caller must treat as a hard denial.
   */
  async consumeJti(jti: string, expiresAtEpochSeconds: number): Promise<boolean> {
    const existing = await this.storage.get<number | BoundJti>(jtiKey(jti));
    if (existing !== undefined) return false;
    const target = jtiKey(jti);
    await this.storage.put<BoundJti>(target, { expiresAtEpochSeconds });
    await this.storage.put(expiryKey(expiresAtEpochSeconds, target), target);
    return true;
  }

  async minimumGeneration(key: GenerationKey): Promise<number> {
    return (await this.storage.get<number>(generationKey(key))) ?? 0;
  }

  /**
   * Generations only ever move forward. A replayed or stale revocation cannot
   * lower the floor and re-enable an old ticket.
   */
  async raiseMinimumGeneration(key: GenerationKey, generation: number): Promise<number> {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error("generation must be a non-negative safe integer");
    }
    const current = await this.minimumGeneration(key);
    if (generation <= current) return current;
    await this.storage.put(generationKey(key), generation);
    return generation;
  }

  async isGenerationCurrent(key: GenerationKey, generation: number): Promise<boolean> {
    return generation >= (await this.minimumGeneration(key));
  }

  async generationFloors(principal: GenerationPrincipal): Promise<GenerationFloors> {
    const floor = async (dimension: GenerationDimension): Promise<number> =>
      await this.minimumGeneration({ ...principal, dimension });
    const hasPrincipalSpecificFloors =
      principal.principalKind === "MAINTENANCE" || principal.cellId !== null;
    return {
      sessionGeneration: principal.principalKind === "CHANNEL" ? await floor("SESSION") : 0,
      credentialGeneration: hasPrincipalSpecificFloors ? await floor("CREDENTIAL") : 0,
      leaseGeneration: hasPrincipalSpecificFloors ? await floor("LEASE") : 0,
      fencingToken: hasPrincipalSpecificFloors ? await floor("CELL") : 0,
    };
  }

  private async assertAdmissionCurrent(admission: TicketAdmission): Promise<void> {
    const floors = await this.generationFloors(admission.principal);
    const generations = admission.generations;
    if (
      generations.sessionGeneration < floors.sessionGeneration ||
      generations.credentialGeneration < floors.credentialGeneration ||
      generations.leaseGeneration < floors.leaseGeneration ||
      generations.fencingToken < floors.fencingToken
    ) throw new Error("ticket generation revoked");
  }

  async admitTicket(
    admission: TicketAdmission,
    binding: { jti: string; expiresAtEpochSeconds: number },
    consumeJti: boolean,
  ): Promise<void> {
    if (Number.isSafeInteger(admission.nowEpochSeconds)) {
      await this.pruneExpired(Number(admission.nowEpochSeconds), 16);
    }
    await this.assertAdmissionCurrent(admission);
    if (consumeJti && !await this.consumeJti(binding.jti, binding.expiresAtEpochSeconds)) {
      throw new Error("ticket replay");
    }
  }

  /** One-time nonce for the internal revocation envelope. */
  async consumeRevocationNonce(nonce: string, seenAtEpochSeconds: number): Promise<boolean> {
    const existing = await this.storage.get<number>(nonceKey(nonce));
    if (existing !== undefined) return false;
    const target = nonceKey(nonce);
    const expiresAtEpochSeconds = seenAtEpochSeconds + REVOCATION_NONCE_RETENTION_SECONDS;
    await this.storage.put<StoredRevocationNonce>(target, {
      seenAtEpochSeconds,
      expiresAtEpochSeconds,
      revocationHash: "",
      acknowledgement: {},
    });
    await this.storage.put(expiryKey(expiresAtEpochSeconds, target), target);
    return true;
  }

  /**
   * This method must be called with transaction-backed storage in the Durable
   * Object. It couples nonce consumption and the monotonic floor update so a
   * crash can never persist only half of a revocation.
   */
  async applyRevocation(
    key: GenerationKey,
    nonce: string,
    seenAtEpochSeconds: number,
    minimumValidGeneration: number,
    revocationHash?: string,
    acknowledgement?: Record<string, unknown>,
  ): Promise<AppliedRevocation> {
    if (!Number.isSafeInteger(minimumValidGeneration) || minimumValidGeneration < 0) {
      throw new Error("generation must be a non-negative safe integer");
    }
    await this.pruneExpired(seenAtEpochSeconds, 16);
    const current = await this.minimumGeneration(key);
    const existing = await this.storage.get<number | StoredRevocationNonce>(nonceKey(nonce));
    if (existing !== undefined) {
      if (
        typeof existing !== "number" && revocationHash !== undefined &&
        existing.revocationHash === revocationHash
      ) {
        return { applied: false, generation: current, acknowledgement: existing.acknowledgement };
      }
      throw new Error("revocation nonce conflict");
    }
    if (revocationHash !== undefined && acknowledgement !== undefined) {
      await this.storage.put<StoredRevocationNonce>(nonceKey(nonce), {
        seenAtEpochSeconds,
        expiresAtEpochSeconds: seenAtEpochSeconds + REVOCATION_NONCE_RETENTION_SECONDS,
        revocationHash,
        acknowledgement,
      });
    } else {
      await this.storage.put(nonceKey(nonce), seenAtEpochSeconds);
    }
    await this.storage.put(
      expiryKey(seenAtEpochSeconds + REVOCATION_NONCE_RETENTION_SECONDS, nonceKey(nonce)),
      nonceKey(nonce),
    );
    const generation = Math.max(current, minimumValidGeneration);
    if (generation !== current) await this.storage.put(generationKey(key), generation);
    return { applied: true, generation, acknowledgement };
  }

  async workState(
    workClaimId: string,
  ): Promise<StoredWorkState | undefined> {
    return await this.storage.get(workKey(workClaimId));
  }

  async storedWorkflowReceipt(
    workClaimId: string,
    claimHash: string,
    kind: WorkKind,
    replayHash: string,
    nowEpochSeconds: number,
  ): Promise<StoredWorkState | null> {
    const existing = await this.workState(workClaimId);
    if (!existing) return null;
    if (
      existing.expiresAtEpochSeconds !== undefined &&
      existing.expiresAtEpochSeconds <= nowEpochSeconds
    ) throw new Error("workflow expired");
    if (
      existing.claimHash !== claimHash || existing.kind !== kind ||
      existing.replayHash !== replayHash
    ) throw new Error("work claim mismatch");
    return existing.phase === "RECEIPT_STORED" && existing.receipt ? existing : null;
  }

  /**
   * Transactional workflow admission. The Durable Object invokes this method
   * with transaction-backed storage so JTI ownership and AUTHORIZED state are
   * committed together or not at all.
   */
  async beginWorkflow(
    workClaimId: string,
    claimHash: string,
    kind: WorkKind,
    bindings: readonly { jti: string; expiresAtEpochSeconds: number }[],
    admission?: TicketAdmission,
    allowStaleRecovery = false,
    replayHash = claimHash,
    recoveryReplacement: WorkflowRecoveryReplacement = "NONE",
    replacementJtis: readonly string[] = [],
    initialPhase: Exclude<DeletePhaseState, "RECEIPT_STORED"> = "AUTHORIZED",
  ): Promise<StoredWorkState> {
    if (bindings.length < 1 || bindings.length > 2) throw new Error("invalid workflow bindings");
    const unique = new Set(bindings.map((binding) => binding.jti));
    if (unique.size !== bindings.length) throw new Error("workflow jtis must be distinct");
    if (initialPhase === "DELETE_IN_PROGRESS" && kind === "UPLOAD") {
      throw new Error("invalid initial workflow phase");
    }
    let existingWork = await this.workState(workClaimId);
    const nowEpochSeconds = Number.isSafeInteger(admission?.nowEpochSeconds)
      ? Number(admission?.nowEpochSeconds)
      : null;
    const existingExpired =
      existingWork?.expiresAtEpochSeconds !== undefined && nowEpochSeconds !== null &&
      existingWork.expiresAtEpochSeconds <= nowEpochSeconds;
    const recoveryCanReplace = recoveryReplacement === "AUTHORIZED_OR_EXPIRED" &&
      (existingExpired || existingWork?.phase === "AUTHORIZED");
    if (existingExpired && !recoveryCanReplace) throw new Error("workflow expired");
    if (existingWork && recoveryCanReplace) {
      if (
        existingWork.kind !== kind || !existingWork.bindingJtis ||
        existingWork.bindingJtis.length !== replacementJtis.length ||
        !existingWork.bindingJtis.every((jti, index) => jti === replacementJtis[index])
      ) throw new Error("workflow replacement mismatch");
      await this.storage.delete(workKey(workClaimId));
      existingWork = undefined;
    }
    if (existingWork &&
      (existingWork.claimHash !== claimHash || existingWork.kind !== kind ||
        existingWork.replayHash !== replayHash)) throw new Error("work claim mismatch");
    if (existingWork?.phase === "RECEIPT_STORED") return existingWork;
    if (existingWork) {
      if (admission && !(allowStaleRecovery && existingWork.phase === "DELETE_IN_PROGRESS")) {
        await this.assertAdmissionCurrent(admission);
      }
      if (existingWork.phase === "AUTHORIZED" && initialPhase === "DELETE_IN_PROGRESS") {
        const updated: StoredWorkState = { ...existingWork, phase: "DELETE_IN_PROGRESS" };
        await this.storage.put(workKey(workClaimId), updated);
        return updated;
      }
      return existingWork;
    }
    if (nowEpochSeconds !== null) await this.pruneExpired(nowEpochSeconds, 16);
    if (admission) await this.assertAdmissionCurrent(admission);
    const existingBindings = await Promise.all(bindings.map(async (binding) =>
      await this.storage.get<number | BoundJti>(jtiKey(binding.jti))
    ));
    if (existingBindings.some((value) =>
      value !== undefined && (typeof value === "number" || value.claimHash !== claimHash)
    )) throw new Error("workflow jti claim mismatch");

    for (let index = 0; index < bindings.length; index += 1) {
      const binding = bindings[index] as { jti: string; expiresAtEpochSeconds: number };
      if (existingBindings[index] === undefined) {
        await this.storage.put<BoundJti>(jtiKey(binding.jti), {
          expiresAtEpochSeconds: binding.expiresAtEpochSeconds,
          claimHash,
        });
        await this.storage.put(
          expiryKey(binding.expiresAtEpochSeconds, jtiKey(binding.jti)),
          jtiKey(binding.jti),
        );
      }
    }
    const expiresAtEpochSeconds = Math.max(...bindings.map((binding) =>
      binding.expiresAtEpochSeconds
    )) + WORK_RETENTION_SECONDS;
    const created: StoredWorkState = {
      phase: initialPhase,
      claimHash,
      replayHash,
      kind,
      bindingJtis: bindings.map((binding) => binding.jti),
      expiresAtEpochSeconds,
    };
    const target = workKey(workClaimId);
    await this.storage.put(target, created);
    await this.storage.put(expiryKey(expiresAtEpochSeconds, target), target);
    return created;
  }

  async pruneExpired(nowEpochSeconds: number, limit: number): Promise<number> {
    if (!this.storage.list || !Number.isSafeInteger(nowEpochSeconds) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 64) return 0;
    const entries = await this.storage.list<string>({
      prefix: "expiry:",
      end: `expiry:${String(nowEpochSeconds + 1).padStart(12, "0")}`,
      limit,
    });
    let removed = 0;
    for (const [indexKey, targetKey] of entries) {
      const value = await this.storage.get<number | BoundJti | StoredRevocationNonce | StoredWorkState>(
        targetKey,
      );
      const expiresAt = typeof value === "number"
        ? value + (targetKey.startsWith("nonce:") ? REVOCATION_NONCE_RETENTION_SECONDS : 0)
        : value?.expiresAtEpochSeconds;
      if (expiresAt !== undefined && expiresAt <= nowEpochSeconds) {
        await this.storage.delete(targetKey);
      }
      await this.storage.delete(indexKey);
      removed += 1;
    }
    return removed;
  }

  async markWorkInProgress(
    workClaimId: string,
    claimHash: string,
    progress: Record<string, unknown>,
  ): Promise<StoredWorkState> {
    const existing = await this.workState(workClaimId);
    if (!existing || existing.claimHash !== claimHash) {
      throw new Error("work claim mismatch");
    }
    if (existing.phase !== "AUTHORIZED") return existing;
    const updated: StoredWorkState = {
      ...existing,
      phase: "DELETE_IN_PROGRESS",
      progress,
    };
    await this.storage.put(workKey(workClaimId), updated);
    return updated;
  }

  async acquireWorkExecution(
    workClaimId: string,
    claimHash: string,
    progress: Record<string, unknown>,
    executorId: string,
    nowEpochMilliseconds: number,
    leaseMilliseconds: number,
  ): Promise<WorkExecution> {
    const existing = await this.workState(workClaimId);
    if (!existing || existing.claimHash !== claimHash) {
      throw new Error("work claim mismatch");
    }
    if (existing.phase === "RECEIPT_STORED") return { work: existing, acquired: false };
    const anotherExecutorIsLive =
      existing.executorId !== undefined && existing.executorId !== executorId &&
      (existing.executorLeaseExpiresAt ?? 0) > nowEpochMilliseconds;
    if (anotherExecutorIsLive) return { work: existing, acquired: false };
    const updated: StoredWorkState = {
      ...existing,
      phase: "DELETE_IN_PROGRESS",
      progress: existing.progress ?? progress,
      executorId,
      executorLeaseExpiresAt: nowEpochMilliseconds + leaseMilliseconds,
    };
    await this.storage.put(workKey(workClaimId), updated);
    return { work: updated, acquired: true };
  }

  async releaseWorkExecution(
    workClaimId: string,
    claimHash: string,
    executorId: string,
  ): Promise<void> {
    const existing = await this.workState(workClaimId);
    if (!existing || existing.claimHash !== claimHash) throw new Error("work claim mismatch");
    if (existing.phase === "RECEIPT_STORED" || existing.executorId !== executorId) return;
    const { executorId: _executorId, executorLeaseExpiresAt: _lease, ...released } = existing;
    await this.storage.put(workKey(workClaimId), released);
  }

  async storeWorkReceipt(
    workClaimId: string,
    claimHash: string,
    receipt: StoredReceipt,
    executorId?: string,
  ): Promise<StoredReceipt> {
    const existing = await this.workState(workClaimId);
    if (!existing || existing.claimHash !== claimHash) {
      throw new Error("work claim mismatch");
    }
    if (existing.phase === "RECEIPT_STORED" && existing.receipt) return existing.receipt;
    if (executorId !== undefined && existing.executorId !== executorId) {
      throw new Error("work executor mismatch");
    }
    await this.storage.put(workKey(workClaimId), {
      phase: "RECEIPT_STORED",
      claimHash: existing.claimHash,
      replayHash: existing.replayHash,
      kind: existing.kind,
      bindingJtis: existing.bindingJtis,
      progress: existing.progress,
      receipt,
      expiresAtEpochSeconds: existing.expiresAtEpochSeconds,
    });
    return receipt;
  }

  async markAuthorized(workClaimId: string): Promise<void> {
    const existing = await this.workState(workClaimId);
    if (existing) return;
    await this.storage.put(workKey(workClaimId), { phase: "AUTHORIZED" as const });
  }

  async markDeleteInProgress(workClaimId: string): Promise<void> {
    const existing = await this.workState(workClaimId);
    if (existing?.phase === "RECEIPT_STORED") return;
    await this.storage.put(workKey(workClaimId), { phase: "DELETE_IN_PROGRESS" as const });
  }

  /**
   * Stores the single canonical receipt. A repeated call after a lost response
   * returns the original bytes so the client always sees identical evidence.
   */
  async storeReceipt(workClaimId: string, receipt: StoredReceipt): Promise<StoredReceipt> {
    const existing = await this.workState(workClaimId);
    if (existing?.phase === "RECEIPT_STORED" && existing.receipt) return existing.receipt;
    await this.storage.put(workKey(workClaimId), {
      phase: "RECEIPT_STORED" as const,
      receipt,
    });
    return receipt;
  }
}
