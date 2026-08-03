import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileBackupStore,
  type BackupPolicy,
} from "../src/backupStore.js";
import {
  ROUTER_BACKUP_TIMEOUT_MS,
  type StagedSftpFile,
} from "../src/routeros/boundedSftpRead.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

const generousPolicy: BackupPolicy = Object.freeze({
  maxPerDevice: 20,
  maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  softVolumeBytes: 6 * 1024 ** 3,
  hardVolumeBytes: 8 * 1024 ** 3,
  minimumFreeBytes: 20 * 1024 ** 3,
  preserveNewestPerDevice: 2,
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "network-center-backups-"));
  temporaryDirectories.push(path);
  return path;
}

async function candidate(
  backupRoot: string,
  name: string,
  payload: Buffer,
  sha256 = createHash("sha256").update(payload).digest("hex"),
): Promise<StagedSftpFile> {
  const staging = join(backupRoot, ".staging");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const path = join(staging, `${name}.part`);
  await writeFile(path, payload, { flag: "wx", mode: 0o600 });
  return {
    path,
    bytes: payload.byteLength,
    sha256,
    async dispose() {
      await rm(path, { force: true });
    },
  };
}

function input(
  artifact: StagedSftpFile,
  sequence = 1,
  createdAt = new Date("2026-07-29T00:00:00.000Z"),
  deviceId = "40000000-0000-4000-8000-000000000001",
) {
  return {
    organizationId: "20000000-0000-4000-8000-000000000001",
    buildingId: "30000000-0000-4000-8000-000000000001",
    deviceId,
    commandId: `50000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    attemptNo: 1,
    createdAt,
    encryption: "ROUTEROS_EXPORT_PLAINTEXT" as const,
    artifact,
  };
}

describe("verified backup store", () => {
  it("atomically promotes one encrypted staged artifact and verifies hash readback", async () => {
    const backupRoot = await root();
    const payload = Buffer.from("encrypted-routeros-backup");
    const artifact = await candidate(backupRoot, "valid", payload);
    const store = new FileBackupStore(backupRoot, {
      policy: generousPolicy,
      diskFreeBytes: async () => 40 * 1024 ** 3,
    });

    const verified = await store.saveVerified(input(artifact));

    expect(verified).toMatchObject({
      bytes: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
      deviceId: "40000000-0000-4000-8000-000000000001",
    });
    expect(await readFile(verified.path)).toEqual(payload);
    await expect(stat(artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
    if (process.platform !== "win32") {
      expect((await stat(verified.path)).mode & 0o777).toBe(0o600);
    }
    verified.release();
  });

  it("rejects tampering after readback and deletes the invalid candidate", async () => {
    const backupRoot = await root();
    const artifact = await candidate(
      backupRoot,
      "tampered",
      Buffer.from("tampered"),
      "a".repeat(64),
    );
    const store = new FileBackupStore(backupRoot, {
      policy: generousPolicy,
      diskFreeBytes: async () => 40 * 1024 ** 3,
    });

    await expect(store.saveVerified(input(artifact))).rejects.toMatchObject({
      code: "BACKUP_HASH_MISMATCH",
    });
    await expect(stat(artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces age and count while preserving the newest two verified artifacts", async () => {
    const backupRoot = await root();
    const policy: BackupPolicy = {
      ...generousPolicy,
      maxPerDevice: 3,
      maxAgeMs: 1_000,
    };
    const store = new FileBackupStore(backupRoot, {
      policy,
      diskFreeBytes: async () => 40 * 1024 ** 3,
    });
    const receipts = [];
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      const artifact = await candidate(backupRoot, `rotation-${sequence}`, Buffer.from(`${sequence}`));
      const receipt = await store.saveVerified(input(
        artifact,
        sequence,
        new Date(`2026-07-29T00:00:0${sequence}.000Z`),
      ));
      receipt.release();
      receipts.push(receipt);
    }

    const deviceDirectory = join(
      backupRoot,
      "40000000-0000-4000-8000-000000000001",
    );
    expect(
      (await readdir(deviceDirectory)).filter((name) => name.endsWith(".rsc"))
        .length,
    ).toBeLessThanOrEqual(3);

    await store.rotate(new Date("2026-07-29T00:01:00.000Z"));
    const remaining = (await readdir(deviceDirectory)).filter((name) => name.endsWith(".rsc"));

    expect(remaining).toHaveLength(2);
    await expect(stat(receipts[0]!.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stat(receipts.at(-1)!.path)).toBeDefined();
    expect(await stat(receipts.at(-2)!.path)).toBeDefined();
  });

  it("never deletes an in-use artifact even when newer backups exceed the limit", async () => {
    const backupRoot = await root();
    const policy: BackupPolicy = {
      ...generousPolicy,
      maxPerDevice: 2,
      maxAgeMs: 1,
    };
    const store = new FileBackupStore(backupRoot, {
      policy,
      diskFreeBytes: async () => 40 * 1024 ** 3,
    });
    const protectedArtifact = await store.saveVerified(input(
      await candidate(backupRoot, "protected", Buffer.from("protected")),
      1,
      new Date("2026-07-29T00:00:01.000Z"),
    ));
    for (let sequence = 2; sequence <= 4; sequence += 1) {
      const receipt = await store.saveVerified(input(
        await candidate(backupRoot, `newer-${sequence}`, Buffer.from(`${sequence}`)),
        sequence,
        new Date(`2026-07-29T00:00:0${sequence}.000Z`),
      ));
      receipt.release();
    }

    await store.rotate(new Date("2026-07-29T00:01:00.000Z"));
    expect(await stat(protectedArtifact.path)).toBeDefined();
    protectedArtifact.release();
  });

  it("reports soft/hard pressure and rejects before promotion when host reserve is unavailable", async () => {
    const backupRoot = await root();
    const artifact = await candidate(backupRoot, "reserve", Buffer.alloc(4));
    const policy: BackupPolicy = {
      ...generousPolicy,
      softVolumeBytes: 8,
      hardVolumeBytes: 12,
      minimumFreeBytes: 20,
    };
    const store = new FileBackupStore(backupRoot, {
      policy,
      diskFreeBytes: async () => 19,
    });

    await expect(store.assertReserve(artifact.bytes)).rejects.toMatchObject({
      code: "BACKUP_RESERVE_UNAVAILABLE",
    });
    await expect(store.saveVerified(input(artifact))).rejects.toMatchObject({
      code: "BACKUP_RESERVE_UNAVAILABLE",
    });
    await expect(stat(artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent device saves so the global hard cap cannot be overcommitted", async () => {
    const backupRoot = await root();
    const policy: BackupPolicy = {
      ...generousPolicy,
      softVolumeBytes: 10,
      hardVolumeBytes: 10,
      minimumFreeBytes: 20,
    };
    let diskChecks = 0;
    let releaseDiskChecks!: () => void;
    const diskChecksMayProceed = new Promise<void>((resolve) => {
      releaseDiskChecks = resolve;
    });
    const fallback = setTimeout(releaseDiskChecks, 100);
    const store = new FileBackupStore(backupRoot, {
      policy,
      diskFreeBytes: async () => {
        diskChecks += 1;
        if (diskChecks === 2) {
          clearTimeout(fallback);
          releaseDiskChecks();
        }
        await diskChecksMayProceed;
        return 100;
      },
    });
    const first = await candidate(backupRoot, "concurrent-one", Buffer.alloc(6, 1));
    const second = await candidate(backupRoot, "concurrent-two", Buffer.alloc(6, 2));

    const results = await Promise.allSettled([
      store.saveVerified(input(
        first,
        1,
        new Date("2026-07-29T00:00:01.000Z"),
        "40000000-0000-4000-8000-000000000001",
      )),
      store.saveVerified(input(
        second,
        2,
        new Date("2026-07-29T00:00:02.000Z"),
        "40000000-0000-4000-8000-000000000002",
      )),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "BACKUP_RESERVE_UNAVAILABLE" },
    });
    expect((await store.pressure()).volumeBytes).toBeLessThanOrEqual(policy.hardVolumeBytes);
    for (const result of fulfilled) result.value.release();
  });

  it("reclaims abandoned staging files on restart and later rotations without deleting recent staging", async () => {
    const backupRoot = await root();
    const stagingRoot = join(backupRoot, ".staging");
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const stalePath = join(stagingRoot, "abandoned.backup.part");
    const recentPath = join(stagingRoot, "live.backup.part");
    await writeFile(stalePath, "stale", { flag: "wx", mode: 0o600 });
    await writeFile(recentPath, "live", { flag: "wx", mode: 0o600 });
    let currentTime = new Date("2026-07-29T12:00:00.000Z");
    const staleTime = new Date(currentTime.getTime() - ROUTER_BACKUP_TIMEOUT_MS * 3);
    await utimes(stalePath, staleTime, staleTime);
    await utimes(recentPath, currentTime, currentTime);

    const restartedStore = new FileBackupStore(backupRoot, {
      policy: generousPolicy,
      diskFreeBytes: async () => 40 * 1024 ** 3,
      now: () => currentTime,
    });

    await restartedStore.pressure();
    await expect(stat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(recentPath, "utf8")).toBe("live");

    currentTime = new Date(currentTime.getTime() + ROUTER_BACKUP_TIMEOUT_MS * 3);
    await restartedStore.rotate(currentTime);
    await expect(stat(recentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("promotes staged bytes at the exact free-space and hard-volume boundaries", async () => {
    const backupRoot = await root();
    const payload = Buffer.alloc(8, 7);
    const artifact = await candidate(backupRoot, "exact-boundary", payload);
    const policy: BackupPolicy = {
      ...generousPolicy,
      softVolumeBytes: payload.byteLength,
      hardVolumeBytes: payload.byteLength,
      minimumFreeBytes: 20,
    };
    const store = new FileBackupStore(backupRoot, {
      policy,
      // The staged file has already consumed its bytes on this same volume.
      diskFreeBytes: async () => policy.minimumFreeBytes,
    });

    const verified = await store.saveVerified(input(artifact));

    expect(verified.bytes).toBe(payload.byteLength);
    await expect(stat(artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.pressure()).volumeBytes).toBe(policy.hardVolumeBytes);
    verified.release();
  });
});
