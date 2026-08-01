import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export const INBOUND_TEMP_PREFIX = "openclaw-inbound-";
export const INBOUND_TEMP_MAX_AGE_MS = 60 * 60 * 1_000;

async function assertOwnedTempDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError("inbound temp directory must be an owned regular directory");
  }
  await chmod(directory, 0o700);
}

export async function createInboundTempFile(directory: string): Promise<{
  path: string;
  handle: Awaited<ReturnType<typeof open>>;
}> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertOwnedTempDirectory(directory);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const path = join(directory, `${INBOUND_TEMP_PREFIX}${crypto.randomUUID()}.part`);
    try {
      const handle = await open(path, "wx", 0o600);
      return { path, handle };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("unable to allocate inbound media temp file");
}

export async function removeInboundTempFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function cleanupStaleInboundTempFiles(options: {
  directory: string;
  nowMs?: number;
  maxAgeMs?: number;
}): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? INBOUND_TEMP_MAX_AGE_MS;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) throw new RangeError("maxAgeMs is invalid");
  let entries;
  try {
    await assertOwnedTempDirectory(options.directory);
    entries = await readdir(options.directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(INBOUND_TEMP_PREFIX) || !entry.name.endsWith(".part")) {
      continue;
    }
    const path = join(options.directory, entry.name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    if (nowMs - metadata.mtimeMs >= maxAgeMs) {
      await rm(path, { force: true });
      removed += 1;
    }
  }
  return removed;
}
