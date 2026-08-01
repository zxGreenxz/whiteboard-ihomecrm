import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface BridgeStoragePaths {
  dataDirectory: string;
  spoolPath: string;
  tempDirectory: string;
}

function containedBy(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function validateBridgeStoragePaths(paths: BridgeStoragePaths): BridgeStoragePaths {
  if (
    !isAbsolute(paths.dataDirectory) || !isAbsolute(paths.spoolPath) ||
    !isAbsolute(paths.tempDirectory) || Object.values(paths).some((value) => value.includes("\0"))
  ) throw new TypeError("bridge storage paths must be absolute");
  const dataDirectory = resolve(paths.dataDirectory);
  const spoolPath = resolve(paths.spoolPath);
  const tempDirectory = resolve(paths.tempDirectory);
  if (!containedBy(dataDirectory, spoolPath) || !containedBy(dataDirectory, tempDirectory)) {
    throw new TypeError("bridge storage paths must stay contained by the data root");
  }
  return { dataDirectory, spoolPath, tempDirectory };
}

async function ownedDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError("bridge owned directory cannot be a symlink or reparse point");
  }
  await chmod(path, 0o700);
}

export async function prepareBridgeStoragePaths(
  input: BridgeStoragePaths,
): Promise<BridgeStoragePaths> {
  const paths = validateBridgeStoragePaths(input);
  await mkdir(paths.dataDirectory, { recursive: true, mode: 0o700 });
  await ownedDirectory(paths.dataDirectory);
  const spoolDirectory = dirname(paths.spoolPath);
  await mkdir(spoolDirectory, { recursive: true, mode: 0o700 });
  await ownedDirectory(spoolDirectory);
  await mkdir(paths.tempDirectory, { recursive: true, mode: 0o700 });
  await ownedDirectory(paths.tempDirectory);

  const realRoot = await realpath(paths.dataDirectory);
  const realSpoolDirectory = await realpath(spoolDirectory);
  const realTempDirectory = await realpath(paths.tempDirectory);
  if (
    (realSpoolDirectory !== realRoot && !containedBy(realRoot, realSpoolDirectory)) ||
    !containedBy(realRoot, realTempDirectory)
  ) throw new TypeError("bridge owned directory resolved outside the data root");

  try {
    const spoolMetadata = await lstat(paths.spoolPath);
    if (!spoolMetadata.isFile() || spoolMetadata.isSymbolicLink()) {
      throw new TypeError("bridge spool must be a regular owned file");
    }
    await chmod(paths.spoolPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return paths;
}
