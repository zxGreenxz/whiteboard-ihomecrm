import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimeMigrationFiles = [
  "001_init.sql",
  "002_media_checkpoints.sql",
  "003_upgrade_legacy_spool.sql",
  "004_claim_invariant.sql",
];

export async function copyRuntimeAssets({
  sourceDirectory = resolve(serviceRoot, "src/spool/migrations"),
  destinationDirectory = resolve(serviceRoot, "dist/src/spool/migrations"),
} = {}) {
  await mkdir(destinationDirectory, { recursive: true });

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
  copyRuntimeAssets().catch(() => {
    console.error("failed to copy bridge runtime assets");
    process.exitCode = 1;
  });
}
