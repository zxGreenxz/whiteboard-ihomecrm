import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { copyRuntimeAssets } from "../scripts/copy-runtime-assets.mjs";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bridge runtime assets", () => {
  it("copies every SQLite migration beside the emitted spool module", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-bridge-assets-"));
    cleanup.push(root);
    const sourceDirectory = join(root, "src", "spool", "migrations");
    const destinationDirectory = join(root, "dist", "src", "spool", "migrations");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, "001_init.sql"), "PRAGMA journal_mode=WAL;\n", "utf8");
    await writeFile(join(sourceDirectory, "002_media_checkpoints.sql"), "CREATE TABLE media;\n", "utf8");
    await writeFile(join(sourceDirectory, "003_upgrade_legacy_spool.sql"), "ALTER TABLE legacy;\n", "utf8");
    await writeFile(join(sourceDirectory, "004_claim_invariant.sql"), "CREATE TRIGGER claim_guard;\n", "utf8");

    await copyRuntimeAssets({ sourceDirectory, destinationDirectory });

    expect(await readFile(join(destinationDirectory, "001_init.sql"), "utf8"))
      .toBe("PRAGMA journal_mode=WAL;\n");
    expect(await readFile(join(destinationDirectory, "002_media_checkpoints.sql"), "utf8"))
      .toBe("CREATE TABLE media;\n");
    expect(await readFile(join(destinationDirectory, "003_upgrade_legacy_spool.sql"), "utf8"))
      .toBe("ALTER TABLE legacy;\n");
    expect(await readFile(join(destinationDirectory, "004_claim_invariant.sql"), "utf8"))
      .toBe("CREATE TRIGGER claim_guard;\n");
  });
});
