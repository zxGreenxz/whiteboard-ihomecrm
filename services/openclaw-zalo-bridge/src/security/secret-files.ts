import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { posix } from "node:path";

const SECRET_DIRECTORY = "/run/secrets";
const MAX_SECRET_BYTES = 16_384;

export interface SecretFileStat {
  kind: "file" | "directory" | "symlink" | "other";
  mode: number;
  size: number;
  uid: number;
}

export interface SecretFileHandle {
  stat(): Promise<SecretFileStat>;
  readFile(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface SecretFileOperations {
  getuid(): number | undefined;
  open(candidate: string, flags: number): Promise<SecretFileHandle>;
}

const defaultOperations: SecretFileOperations = {
  getuid: () => process.getuid?.(),
  open: async (candidate, flags) => {
    const handle = await open(candidate, flags);
    return {
      stat: async () => {
        const stat = await handle.stat();
        return {
          kind: stat.isFile()
            ? "file"
            : stat.isDirectory()
              ? "directory"
              : stat.isSymbolicLink()
                ? "symlink"
                : "other",
          mode: stat.mode,
          size: stat.size,
          uid: stat.uid,
        };
      },
      readFile: async () => handle.readFile(),
      close: async () => handle.close(),
    };
  },
};

function assertDirectSecretPath(candidate: string): void {
  const name = posix.basename(candidate);
  if (
    candidate.includes("\0") ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    candidate !== posix.join(SECRET_DIRECTORY, name)
  ) {
    throw new Error("Invalid secret path");
  }
}

function decodeSecret(contents: Buffer): string {
  if (contents.byteLength === 0 || contents.byteLength > MAX_SECRET_BYTES) {
    throw new Error("Invalid secret file size");
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error("Invalid secret value encoding");
  }

  if (decoded.endsWith("\r\n")) decoded = decoded.slice(0, -2);
  else if (decoded.endsWith("\n")) decoded = decoded.slice(0, -1);

  if (
    decoded.length === 0 ||
    decoded.includes("\0") ||
    decoded.includes("\n") ||
    decoded.includes("\r") ||
    decoded.trim() !== decoded
  ) {
    throw new Error("Invalid secret value");
  }
  return decoded;
}

/**
 * Reads one scalar secret through a no-follow descriptor and verifies the
 * already-opened inode before consuming any bytes.
 */
export async function readProtectedSecretFile(
  candidate: string,
  operations: SecretFileOperations = defaultOperations,
): Promise<string> {
  assertDirectSecretPath(candidate);
  const expectedUid = operations.getuid();
  if (expectedUid === undefined) throw new Error("Secret owner cannot be verified");

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  if (noFollow === 0 && operations === defaultOperations) {
    throw new Error("No-follow secret reads are unsupported");
  }

  const handle = await operations.open(candidate, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (stat.kind !== "file") throw new Error("Secret path is not a regular file");
    if (stat.uid !== expectedUid) throw new Error("Secret file owner mismatch");
    if ((stat.mode & 0o777) !== 0o400) {
      throw new Error("Secret file mode must be exactly 0400");
    }
    if (stat.size <= 0 || stat.size > MAX_SECRET_BYTES) {
      throw new Error("Invalid secret file size");
    }

    return decodeSecret(await handle.readFile());
  } finally {
    await handle.close();
  }
}
