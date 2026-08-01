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

export interface StoredReceipt {
  /** Canonical JSON bytes of the receipt, exactly as signed. */
  canonicalJson: string;
  signature: string;
  sha256: string;
}

export interface GenerationKey {
  organizationId: string;
  accountId: string | null;
}

export interface TicketStateStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

function generationKey(key: GenerationKey): string {
  return `gen:${key.organizationId}:${key.accountId ?? "-"}`;
}

function jtiKey(jti: string): string {
  return `jti:${jti}`;
}

function workKey(workClaimId: string): string {
  return `work:${workClaimId}`;
}

function nonceKey(nonce: string): string {
  return `nonce:${nonce}`;
}

export class TicketStateStore {
  constructor(private readonly storage: TicketStateStorage) {}

  /**
   * Returns true when this call is the one that consumed the ticket. A replay
   * returns false, which every caller must treat as a hard denial.
   */
  async consumeJti(jti: string, expiresAtEpochSeconds: number): Promise<boolean> {
    const existing = await this.storage.get<number>(jtiKey(jti));
    if (existing !== undefined) return false;
    await this.storage.put(jtiKey(jti), expiresAtEpochSeconds);
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

  /** One-time nonce for the internal revocation envelope. */
  async consumeRevocationNonce(nonce: string, seenAtEpochSeconds: number): Promise<boolean> {
    const existing = await this.storage.get<number>(nonceKey(nonce));
    if (existing !== undefined) return false;
    await this.storage.put(nonceKey(nonce), seenAtEpochSeconds);
    return true;
  }

  async workState(
    workClaimId: string,
  ): Promise<{ phase: DeletePhaseState; receipt?: StoredReceipt } | undefined> {
    return await this.storage.get(workKey(workClaimId));
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