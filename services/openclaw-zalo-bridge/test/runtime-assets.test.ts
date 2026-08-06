import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { copyRuntimeAssets } from "../scripts/copy-runtime-assets.mjs";

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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

  // The previous version of this test seeded exactly the four files the copier
  // hard-coded, so it passed while the image shipped without 005 and 006 - and the
  // bridge could not boot at all. A migration the copier has never heard of is the
  // case that matters.
  it("copies a migration that was added after the copier was written", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-bridge-assets-new-"));
    cleanup.push(root);
    const sourceDirectory = join(root, "src", "spool", "migrations");
    const destinationDirectory = join(root, "dist", "src", "spool", "migrations");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, "001_init.sql"), "PRAGMA journal_mode=WAL;\n", "utf8");
    await writeFile(join(sourceDirectory, "099_far_future.sql"), "CREATE TABLE later;\n", "utf8");
    await writeFile(join(sourceDirectory, "notes.md"), "not a migration\n", "utf8");

    await copyRuntimeAssets({ sourceDirectory, destinationDirectory });

    expect((await readdir(destinationDirectory)).sort())
      .toEqual(["001_init.sql", "099_far_future.sql"]);
  });

  // The guarantee that matters in production: every migration `sqlite-spool.ts`
  // reads at module load is present in `dist`.
  it("copies every migration the real service ships", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-bridge-assets-real-"));
    cleanup.push(root);
    const sourceDirectory = join(serviceRoot, "src", "spool", "migrations");
    const destinationDirectory = join(root, "dist", "src", "spool", "migrations");

    await copyRuntimeAssets({ sourceDirectory, destinationDirectory });

    const expected = (await readdir(sourceDirectory)).filter(file => file.endsWith(".sql")).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect((await readdir(destinationDirectory)).sort()).toEqual(expected);
  });

  it("refuses an empty migration directory instead of shipping a bridge that cannot boot", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-bridge-assets-empty-"));
    cleanup.push(root);
    const sourceDirectory = join(root, "src", "spool", "migrations");
    await mkdir(sourceDirectory, { recursive: true });

    await expect(copyRuntimeAssets({
      sourceDirectory,
      destinationDirectory: join(root, "dist", "src", "spool", "migrations"),
    })).rejects.toThrow(/no bridge spool migrations/u);
  });
});
