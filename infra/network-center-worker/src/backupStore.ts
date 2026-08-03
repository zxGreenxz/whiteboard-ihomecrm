import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  mkdir,
  open,
  readdir,
  rm,
  stat,
  statfs,
  unlink,
  utimes,
} from "node:fs/promises";
import { resolve, sep } from "node:path";

import { RouterOperationError } from "./domain.js";
import {
  ROUTER_BACKUP_TIMEOUT_MS,
  ROUTER_EXPORT_MAX_BYTES,
  type StagedSftpFile,
} from "./routeros/boundedSftpRead.js";

export interface BackupPolicy {
  maxPerDevice: number;
  maxAgeMs: number;
  softVolumeBytes: number;
  hardVolumeBytes: number;
  minimumFreeBytes: number;
  preserveNewestPerDevice: number;
}

export interface BackupCandidate {
  organizationId: string;
  buildingId: string;
  deviceId: string;
  commandId: string;
  attemptNo: number;
  createdAt: Date;
  /**
   * What the staged artifact actually IS, not what we wish it were.
   *
   * It used to read `ROUTEROS_AES_SHA256` because the artifact was a binary
   * `/system/backup/save` image encrypted with the worker's own backup password.
   * That path is gone — no policy set both completes it and denies the
   * credential the WireGuard private key — and the artifact is now the redacted
   * `/export terse hide-sensitive` text. Leaving the old label would have
   * asserted at-rest encryption that no longer exists, in the one field an
   * operator would consult to decide how to handle the file.
   *
   * The text carries no keys or passwords (`hide-sensitive` strips them at the
   * router), and it is written 0600 inside a 0700 directory, but it is
   * plaintext and the label says so.
   */
  encryption: "ROUTEROS_EXPORT_PLAINTEXT";
  artifact: StagedSftpFile;
}

export interface VerifiedBackup {
  path: string;
  deviceId: string;
  sha256: string;
  bytes: number;
  createdAt: Date;
  release(): void;
}

export interface BackupPressure {
  state: "OK" | "SOFT" | "HARD" | "RESERVE";
  volumeBytes: number;
  freeBytes: number;
}

export interface BackupRotationReport {
  deleted: number;
  reclaimedBytes: number;
  remainingBytes: number;
}

export interface BackupStore {
  pressure(): Promise<BackupPressure>;
  assertReserve(additionalBytes?: number): Promise<BackupPressure>;
  saveVerified(input: BackupCandidate): Promise<VerifiedBackup>;
  rotate(now: Date): Promise<BackupRotationReport>;
}

interface FileBackupStoreOptions {
  policy?: BackupPolicy;
  diskFreeBytes?: (path: string) => Promise<number>;
  now?: () => Date;
}

interface StoredFile {
  path: string;
  deviceId: string;
  bytes: number;
  modifiedAtMs: number;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// Leave a full timeout of slack so cleanup cannot race a bounded in-flight stage.
const STAGING_MAX_AGE_MS = ROUTER_BACKUP_TIMEOUT_MS * 2;

export const DEFAULT_BACKUP_POLICY: BackupPolicy = Object.freeze({
  maxPerDevice: 20,
  maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  softVolumeBytes: 6 * 1024 ** 3,
  hardVolumeBytes: 8 * 1024 ** 3,
  minimumFreeBytes: 20 * 1024 ** 3,
  preserveNewestPerDevice: 2,
});

function backupError(code: string, retryable = false): RouterOperationError {
  return new RouterOperationError(code, {
    retryable,
    mayHaveExecuted: false,
  });
}

function descendant(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedCandidate = process.platform === "win32"
    ? candidate.toLowerCase()
    : candidate;
  return normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function defaultDiskFreeBytes(path: string): Promise<number> {
  const value = await statfs(path);
  const blocks = typeof value.bavail === "bigint" ? value.bavail : BigInt(value.bavail);
  const size = typeof value.bsize === "bigint" ? value.bsize : BigInt(value.bsize);
  const bytes = blocks * size;
  return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
}

function assertPolicy(policy: BackupPolicy): void {
  if (
    !Number.isSafeInteger(policy.maxPerDevice)
    || policy.maxPerDevice < 2
    || !Number.isSafeInteger(policy.preserveNewestPerDevice)
    || policy.preserveNewestPerDevice < 2
    || policy.preserveNewestPerDevice > policy.maxPerDevice
    || !Number.isSafeInteger(policy.maxAgeMs)
    || policy.maxAgeMs < 1
    || !Number.isSafeInteger(policy.softVolumeBytes)
    || policy.softVolumeBytes < 1
    || !Number.isSafeInteger(policy.hardVolumeBytes)
    || policy.hardVolumeBytes < policy.softVolumeBytes
    || !Number.isSafeInteger(policy.minimumFreeBytes)
    || policy.minimumFreeBytes < 1
  ) {
    throw new TypeError("Invalid backup policy");
  }
}

export class FileBackupStore implements BackupStore {
  readonly #root: string;
  readonly #stagingRoot: string;
  readonly #policy: BackupPolicy;
  readonly #diskFreeBytes: (path: string) => Promise<number>;
  readonly #now: () => Date;
  readonly #active = new Set<string>();
  #readyPromise: Promise<void> | undefined;
  #saveTail: Promise<void> = Promise.resolve();

  constructor(root: string, options: FileBackupStoreOptions = {}) {
    this.#root = resolve(root);
    this.#stagingRoot = resolve(this.#root, ".staging");
    this.#policy = Object.freeze({ ...(options.policy ?? DEFAULT_BACKUP_POLICY) });
    assertPolicy(this.#policy);
    this.#diskFreeBytes = options.diskFreeBytes ?? defaultDiskFreeBytes;
    this.#now = options.now ?? (() => new Date());
  }

  async #ensureDirectories(): Promise<void> {
    this.#readyPromise ??= (async () => {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      await mkdir(this.#stagingRoot, { recursive: true, mode: 0o700 });
      await this.#cleanupStaging(this.#now().getTime());
    })();
    await this.#readyPromise;
  }

  async #cleanupStaging(nowMs: number): Promise<void> {
    if (!Number.isFinite(nowMs)) return;
    for (const entry of await readdir(this.#stagingRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".part")) continue;
      const path = resolve(this.#stagingRoot, entry.name);
      if (!descendant(this.#stagingRoot, path)) continue;
      let details;
      try {
        details = await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (nowMs - details.mtimeMs <= STAGING_MAX_AGE_MS) continue;
      await rm(path, { force: true });
    }
  }

  async #files(): Promise<StoredFile[]> {
    await this.#ensureDirectories();
    const output: StoredFile[] = [];
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".staging" || !UUID.test(entry.name)) continue;
      const directory = resolve(this.#root, entry.name);
      for (const child of await readdir(directory, { withFileTypes: true })) {
        // `.rsc` is what this store writes now that the artifact is a text
        // export. `.backup` is still swept because a host that ever promoted a
        // binary image must keep counting it toward the volume budget and keep
        // rotating it — an extension change that quietly orphaned old artifacts
        // would leak disk on exactly the hosts with the most to clean up.
        if (!child.isFile() || !/\.(?:rsc|backup)$/.test(child.name)) continue;
        const path = resolve(directory, child.name);
        if (!descendant(this.#root, path)) continue;
        const details = await stat(path);
        output.push({
          path,
          deviceId: entry.name,
          bytes: details.size,
          modifiedAtMs: details.mtimeMs,
        });
      }
    }
    return output;
  }

  async pressure(): Promise<BackupPressure> {
    const files = await this.#files();
    const volumeBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const freeBytes = await this.#diskFreeBytes(this.#root);
    const state = freeBytes < this.#policy.minimumFreeBytes
      ? "RESERVE"
      : volumeBytes >= this.#policy.hardVolumeBytes
        ? "HARD"
        : volumeBytes >= this.#policy.softVolumeBytes
          ? "SOFT"
          : "OK";
    return { state, volumeBytes, freeBytes };
  }

  async assertReserve(additionalBytes = 0): Promise<BackupPressure> {
    return this.#assertReserveFor(additionalBytes, additionalBytes);
  }

  async #assertReserveFor(
    additionalVolumeBytes: number,
    additionalFreeBytes: number,
  ): Promise<BackupPressure> {
    if (
      !Number.isSafeInteger(additionalVolumeBytes)
      || additionalVolumeBytes < 0
      || !Number.isSafeInteger(additionalFreeBytes)
      || additionalFreeBytes < 0
    ) {
      throw backupError("BACKUP_SIZE_INVALID");
    }
    await this.rotate(this.#now());
    let current = await this.pressure();
    if (current.volumeBytes + additionalVolumeBytes > this.#policy.softVolumeBytes) {
      await this.rotate(this.#now());
      current = await this.pressure();
    }
    if (
      current.freeBytes < this.#policy.minimumFreeBytes + additionalFreeBytes
      || current.volumeBytes + additionalVolumeBytes > this.#policy.hardVolumeBytes
    ) {
      throw backupError("BACKUP_RESERVE_UNAVAILABLE", true);
    }
    return current;
  }

  async #withSaveLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#saveTail;
    let release!: () => void;
    this.#saveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async saveVerified(input: BackupCandidate): Promise<VerifiedBackup> {
    const artifactPath = resolve(input.artifact.path);
    const createdAtMs = input.createdAt.getTime();
    if (
      !UUID.test(input.organizationId)
      || !UUID.test(input.buildingId)
      || !UUID.test(input.deviceId)
      || !UUID.test(input.commandId)
      || !Number.isSafeInteger(input.attemptNo)
      || input.attemptNo < 1
      || input.attemptNo > 1_000
      || !Number.isFinite(createdAtMs)
      || input.encryption !== "ROUTEROS_EXPORT_PLAINTEXT"
      || input.artifact.bytes < 1
      || input.artifact.bytes > ROUTER_EXPORT_MAX_BYTES
      || !/^[a-f0-9]{64}$/.test(input.artifact.sha256)
      || !descendant(this.#stagingRoot, artifactPath)
    ) {
      await input.artifact.dispose();
      throw backupError("BACKUP_CANDIDATE_INVALID");
    }

    return this.#withSaveLock(async () => {
      await this.#ensureDirectories();
      let promotedTarget: string | undefined;
      try {
        // Promotion links within the same volume, so staged bytes add volume usage but no new free-space demand.
        await this.#assertReserveFor(input.artifact.bytes, 0);
        const sourceStat = await stat(artifactPath);
        if (sourceStat.size !== input.artifact.bytes) {
          throw backupError("BACKUP_SIZE_MISMATCH");
        }
        const sourceHash = await sha256File(artifactPath);
        if (sourceHash !== input.artifact.sha256) {
          throw backupError("BACKUP_HASH_MISMATCH");
        }

        const deviceDirectory = resolve(this.#root, input.deviceId);
        await mkdir(deviceDirectory, { recursive: true, mode: 0o700 });
        const timestamp = String(Math.trunc(createdAtMs)).padStart(13, "0");
        const name = `${timestamp}-${input.commandId}-${input.attemptNo}-${sourceHash}.rsc`;
        const target = resolve(deviceDirectory, name);
        if (!descendant(this.#root, target)) throw backupError("BACKUP_PATH_INVALID");

        await link(artifactPath, target);
        promotedTarget = target;
        await unlink(artifactPath);
        await utimes(target, input.createdAt, input.createdAt);
        const targetHandle = await open(target, "r+");
        try {
          await targetHandle.sync();
        } finally {
          await targetHandle.close();
        }
        const targetStat = await stat(target);
        const targetHash = await sha256File(target);
        if (targetStat.size !== input.artifact.bytes || targetHash !== sourceHash) {
          await rm(target, { force: true });
          promotedTarget = undefined;
          throw backupError("BACKUP_HASH_MISMATCH");
        }

        this.#active.add(target);
        await this.rotate(this.#now());
        let released = false;
        return {
          path: target,
          deviceId: input.deviceId,
          sha256: targetHash,
          bytes: targetStat.size,
          createdAt: new Date(createdAtMs),
          release: () => {
            if (released) return;
            released = true;
            this.#active.delete(target);
          },
        };
      } catch (error) {
        if (promotedTarget) {
          this.#active.delete(promotedTarget);
          await rm(promotedTarget, { force: true });
        }
        await input.artifact.dispose();
        if (error instanceof RouterOperationError) throw error;
        throw backupError("BACKUP_SAVE_FAILED", true);
      }
    });
  }

  async rotate(now: Date): Promise<BackupRotationReport> {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw backupError("BACKUP_ROTATION_TIME_INVALID");
    await this.#ensureDirectories();
    await this.#cleanupStaging(nowMs);
    const files = await this.#files();
    const protectedPaths = new Set(this.#active);
    const byDevice = new Map<string, StoredFile[]>();
    for (const file of files) {
      const entries = byDevice.get(file.deviceId) ?? [];
      entries.push(file);
      byDevice.set(file.deviceId, entries);
    }
    for (const entries of byDevice.values()) {
      entries.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
      for (const file of entries.slice(0, this.#policy.preserveNewestPerDevice)) {
        protectedPaths.add(file.path);
      }
    }

    const deleted = new Set<string>();
    let reclaimedBytes = 0;
    const remove = async (file: StoredFile) => {
      if (deleted.has(file.path) || protectedPaths.has(file.path)) return;
      await rm(file.path, { force: true });
      deleted.add(file.path);
      reclaimedBytes += file.bytes;
    };

    for (const entries of byDevice.values()) {
      for (let index = 0; index < entries.length; index += 1) {
        const file = entries[index];
        if (!file) continue;
        const overCount = index >= this.#policy.maxPerDevice;
        const tooOld = nowMs - file.modifiedAtMs > this.#policy.maxAgeMs;
        if (overCount || tooOld) await remove(file);
      }
    }

    let remainingBytes = files.reduce((sum, file) => sum + file.bytes, 0) - reclaimedBytes;
    if (remainingBytes > this.#policy.softVolumeBytes) {
      const oldestFirst = [...files].sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
      for (const file of oldestFirst) {
        if (remainingBytes <= this.#policy.softVolumeBytes) break;
        const before = reclaimedBytes;
        await remove(file);
        remainingBytes -= reclaimedBytes - before;
      }
    }

    return {
      deleted: deleted.size,
      reclaimedBytes,
      remainingBytes,
    };
  }
}
