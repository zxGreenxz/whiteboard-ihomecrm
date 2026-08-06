import { copyFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Which migrations ship beside the emitted spool module.
 *
 * Read from the source directory, never hand-listed. A hand-written list is how
 * the image shipped without `005_runtime_command_journal.sql` and
 * `006_stable_mapping_lifecycle.sql`: `sqlite-spool.ts` reads every migration at
 * module load, so a missing file is not a degraded spool, it is a bridge that
 * cannot boot at all - ENOENT before the first line of application code. The
 * list only had to fall one file behind.
 */
const MIGRATION_FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/u;

export async function copyRuntimeAssets({
  sourceDirectory = resolve(serviceRoot, "src/spool/migrations"),
  destinationDirectory = resolve(serviceRoot, "dist/src/spool/migrations"),
} = {}) {
  await mkdir(destinationDirectory, { recursive: true });

  const runtimeMigrationFiles = (await readdir(sourceDirectory))
    .filter((file) => MIGRATION_FILE_PATTERN.test(file))
    .sort();
  // A silent zero-file copy produces the same ENOENT at runtime, one build later
  // and far from its cause.
  if (runtimeMigrationFiles.length === 0) {
    throw new Error(`no bridge spool migrations found in ${sourceDirectory}`);
  }

  const destinations = [];
  for (const file of runtimeMigrationFiles) {
    const destination = resolve(destinationDirectory, file);
    await copyFile(resolve(sourceDirectory, file), destination);
    destinations.push(destination);
  }

  return destinations;
}

const invoked = process.argv[1];
if (invoked !== undefined && resolve(invoked) === resolve(fileURLToPath(import.meta.url))) {
  copyRuntimeAssets().catch((error) => {
    console.error("failed to copy bridge runtime assets", error);
    process.exitCode = 1;
  });
}
