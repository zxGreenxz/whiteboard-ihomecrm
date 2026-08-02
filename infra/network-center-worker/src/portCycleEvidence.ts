/**
 * Durable evidence that a managed access port was observed disabled and then
 * re-enabled.
 *
 * `CYCLE_ACCESS_PORT` is the only action whose postcondition depends on a
 * *transition* rather than on a state that is still readable afterwards. The
 * authoritative evaluator only calls the cycle SUCCEEDED when the post
 * observation carries `disabledObserved` and `enabledObserved` together with a
 * currently enabled port, and the connector can only assert `disabledObserved`
 * for a cycle it performed itself.
 *
 * A reconciliation pass runs on a brand-new connector — frequently in a brand-new
 * process — so that in-memory assertion is gone exactly when it is needed. This
 * store keeps the same evidence on disk, keyed by command, so a cycle that really
 * happened can still be proven on the next pass. It never manufactures evidence:
 * an entry is written only after the router itself reported the ordered
 * disable/enable readback, and it is scoped to one command and one managed port.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface PortCycleEvidence {
  commandId: string;
  managedResourceId: string;
  immutableKey: string;
  observedAt: string;
}

export interface PortCycleEvidenceStore {
  record(evidence: PortCycleEvidence): Promise<void>;
  read(commandId: string): Promise<PortCycleEvidence | null>;
}

/** Longest a cycle can stay reconcilable; the server deadline is far shorter. */
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_EVIDENCE_BYTES = 4_096;
const EVIDENCE_FILE = /^[a-f0-9]{32}\.json$/;

function nonEmptyString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

export class FilePortCycleEvidenceStore implements PortCycleEvidenceStore {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #retentionMs: number;

  constructor(
    directory: string,
    options: { now?: () => Date; retentionMs?: number } = {},
  ) {
    this.#root = resolve(directory);
    this.#now = options.now ?? (() => new Date());
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  /** Command ids are hashed so no caller-supplied text ever reaches the path. */
  #path(commandId: string): string {
    const digest = createHash("sha256").update(commandId).digest("hex").slice(0, 32);
    return join(this.#root, `${digest}.json`);
  }

  async record(evidence: PortCycleEvidence): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const path = this.#path(evidence.commandId);
    const temporary = `${path}.${createHash("sha256")
      .update(`${evidence.commandId}:${evidence.observedAt}`)
      .digest("hex")
      .slice(0, 8)}.part`;
    const payload = JSON.stringify({
      commandId: evidence.commandId,
      managedResourceId: evidence.managedResourceId,
      immutableKey: evidence.immutableKey,
      observedAt: evidence.observedAt,
    });
    if (Buffer.byteLength(payload, "utf8") > MAX_EVIDENCE_BYTES) {
      throw new RangeError("Access-port cycle evidence is too large to persist");
    }
    await writeFile(temporary, payload, { mode: 0o600 });
    await rename(temporary, path);
    await this.#prune();
  }

  async read(commandId: string): Promise<PortCycleEvidence | null> {
    return this.#load(this.#path(commandId), commandId);
  }

  async #load(path: string, expectedCommandId: string | null): Promise<PortCycleEvidence | null> {
    let raw: string;
    try {
      const details = await stat(path);
      if (!details.isFile() || details.size > MAX_EVIDENCE_BYTES) return null;
      raw = await readFile(path, "utf8");
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      !nonEmptyString(candidate.commandId, 200)
      || !nonEmptyString(candidate.managedResourceId, 200)
      || !nonEmptyString(candidate.immutableKey, 200)
      || !nonEmptyString(candidate.observedAt, 64)
    ) return null;
    if (expectedCommandId !== null && candidate.commandId !== expectedCommandId) return null;
    const observedAt = Date.parse(candidate.observedAt);
    if (!Number.isFinite(observedAt)) return null;
    if (this.#now().getTime() - observedAt > this.#retentionMs) return null;
    return {
      commandId: candidate.commandId,
      managedResourceId: candidate.managedResourceId,
      immutableKey: candidate.immutableKey,
      observedAt: candidate.observedAt,
    };
  }

  async #prune(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch {
      return;
    }
    const cutoff = this.#now().getTime() - this.#retentionMs;
    for (const entry of entries) {
      const path = join(this.#root, entry);
      if (EVIDENCE_FILE.test(entry)) {
        if (await this.#load(path, null) === null) await rm(path, { force: true });
        continue;
      }
      if (!entry.endsWith(".part")) continue;
      try {
        const details = await stat(path);
        if (details.mtimeMs < cutoff) await rm(path, { force: true });
      } catch {
        // A temporary file that disappeared underneath us needs no cleanup.
      }
    }
  }
}
