import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileBackupStore,
  type BackupPolicy,
} from "../src/backupStore.js";
import type { StagedSftpFile } from "../src/routeros/boundedSftpRead.js";

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
) {
  return {
    organizationId: "20000000-0000-4000-8000-000000000001",
    buildingId: "30000000-0000-4000-8000-000000000001",
    deviceId: "40000000-0000-4000-8000-000000000001",
    commandId: `50000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    attemptNo: 1,
    createdAt,
    encryption: "ROUTEROS_AES_SHA256" as const,
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
      (await readdir(deviceDirectory)).filter((name) => name.endsWith(".backup"))
        .length,
    ).toBeLessThanOrEqual(3);

    await store.rotate(new Date("2026-07-29T00:01:00.000Z"));
    const remaining = (await readdir(deviceDirectory)).filter((name) => name.endsWith(".backup"));

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
});
