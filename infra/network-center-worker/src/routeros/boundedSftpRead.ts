import { createHash } from "node:crypto";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable } from "node:stream";

import { RouterOperationError } from "../domain.js";

export const ROUTER_EXPORT_MAX_BYTES = 1 * 1024 * 1024;
export const ROUTER_BACKUP_MAX_BYTES = 16 * 1024 * 1024;
export const ROUTER_EXPORT_TIMEOUT_MS = 15_000;
export const ROUTER_BACKUP_TIMEOUT_MS = 45_000;

export interface BoundedSftpReadOptions {
  kind: "export" | "backup";
  maxBytes: number;
  timeoutMs: number;
}

export interface StagedSftpReadOptions extends BoundedSftpReadOptions {
  destinationPath: string;
}

export interface StagedSftpFile {
  path: string;
  bytes: number;
  sha256: string;
  dispose(): Promise<void>;
}

export interface SftpReadSession {
  createReadStream(path: string): Readable;
  end(): void;
}

function operationError(code: string, retryable: boolean): RouterOperationError {
  return new RouterOperationError(code, {
    retryable,
    mayHaveExecuted: false,
  });
}

function assertOptions(options: BoundedSftpReadOptions): void {
  if (
    !Number.isSafeInteger(options.maxBytes)
    || options.maxBytes < 1
    || options.maxBytes > ROUTER_BACKUP_MAX_BYTES
    || !Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1
    || options.timeoutMs > ROUTER_BACKUP_TIMEOUT_MS
  ) {
    throw operationError("SFTP_READ_OPTIONS_INVALID", false);
  }
}

async function consumeBounded(
  source: Readable,
  options: BoundedSftpReadOptions,
  consume: (chunk: Buffer) => Promise<void> | void,
): Promise<number> {
  assertOptions(options);
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    source.destroy(operationError("SFTP_READ_TIMEOUT", true));
  }, options.timeoutMs);

  try {
    for await (const value of source) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      if (total + chunk.byteLength > options.maxBytes) {
        throw operationError("SFTP_READ_LIMIT_EXCEEDED", false);
      }
      await consume(chunk);
      total += chunk.byteLength;
    }
    if (total < 1) throw operationError("SFTP_READ_EMPTY", true);
    return total;
  } catch (error) {
    if (timedOut) throw operationError("SFTP_READ_TIMEOUT", true);
    if (error instanceof RouterOperationError) throw error;
    throw operationError("SFTP_READ_FAILED", true);
  } finally {
    clearTimeout(timer);
    source.destroy();
  }
}

export async function readSftpFileBounded(
  source: Readable,
  options: BoundedSftpReadOptions,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await consumeBounded(source, options, (chunk) => {
    chunks.push(chunk);
  });
  return Buffer.concat(chunks);
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // The primary failure remains authoritative.
  }
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function stageSftpFileBounded(
  source: Readable,
  options: StagedSftpReadOptions,
): Promise<StagedSftpFile> {
  if (!isAbsolute(options.destinationPath)) {
    source.destroy();
    throw operationError("SFTP_STAGING_PATH_INVALID", false);
  }

  let handle: FileHandle | undefined;
  let ownsDestination = false;
  let completed = false;
  try {
    handle = await open(options.destinationPath, "wx", 0o600);
    ownsDestination = true;
    const hash = createHash("sha256");
    const bytes = await consumeBounded(source, options, async (chunk) => {
      try {
        await handle?.writeFile(chunk);
        hash.update(chunk);
      } catch {
        throw operationError("SFTP_STAGING_WRITE_FAILED", true);
      }
    });
    await handle.sync();
    await handle.close();
    handle = undefined;
    completed = true;
    return {
      path: options.destinationPath,
      bytes,
      sha256: hash.digest("hex"),
      dispose: () => unlinkQuietly(options.destinationPath),
    };
  } catch (error) {
    source.destroy();
    if (error instanceof RouterOperationError) throw error;
    throw operationError("SFTP_STAGING_FAILED", true);
  } finally {
    await closeQuietly(handle);
    if (ownsDestination && !completed) await unlinkQuietly(options.destinationPath);
  }
}

/**
 * Every `SFTP_*` failure `stageSftpFileBounded` can raise, mapped to the name an
 * operator should see when the bytes came off STDOUT and no SFTP session was
 * ever opened. A pre-action snapshot that fails with `SFTP_READ_EMPTY` on a
 * router the worker never opened SFTP to would send an incident straight at the
 * wrong subsystem.
 */
const EXPORT_STAGING_ERROR_CODES: Readonly<Record<string, string>> = Object.freeze({
  SFTP_READ_EMPTY: "ROUTER_EXPORT_EMPTY",
  SFTP_READ_LIMIT_EXCEEDED: "ROUTER_EXPORT_TOO_LARGE",
  SFTP_READ_TIMEOUT: "ROUTER_EXPORT_STAGING_TIMEOUT",
  SFTP_READ_FAILED: "ROUTER_EXPORT_STAGING_FAILED",
  SFTP_READ_OPTIONS_INVALID: "ROUTER_EXPORT_STAGING_OPTIONS_INVALID",
  SFTP_STAGING_PATH_INVALID: "ROUTER_EXPORT_STAGING_PATH_INVALID",
  SFTP_STAGING_WRITE_FAILED: "ROUTER_EXPORT_STAGING_WRITE_FAILED",
  SFTP_STAGING_FAILED: "ROUTER_EXPORT_STAGING_FAILED",
});

/**
 * Stages a text config export that was read off the command channel.
 *
 * Deliberately routed through `stageSftpFileBounded` rather than a fresh
 * `writeFile`: that function is where the exclusive `wx` create, mode `0600`,
 * the byte ceiling, the streaming sha256, the `fsync` and the delete-on-failure
 * live, and the snapshot artifact must keep every one of them just because its
 * bytes now arrive over stdout instead of over SFTP. An empty export stays a
 * hard failure — `SFTP_READ_EMPTY` becomes `ROUTER_EXPORT_EMPTY` — because a
 * zero-byte pre-action snapshot is the failure mode being designed out.
 */
export async function stageExportTextBounded(
  text: string,
  options: { destinationPath: string },
): Promise<StagedSftpFile> {
  try {
    return await stageSftpFileBounded(Readable.from([Buffer.from(text, "utf8")]), {
      kind: "export",
      destinationPath: options.destinationPath,
      maxBytes: ROUTER_EXPORT_MAX_BYTES,
      timeoutMs: ROUTER_EXPORT_TIMEOUT_MS,
    });
  } catch (error) {
    const mapped = error instanceof RouterOperationError
      ? EXPORT_STAGING_ERROR_CODES[error.code]
      : undefined;
    if (!mapped || !(error instanceof RouterOperationError)) throw error;
    throw new RouterOperationError(mapped, {
      retryable: error.retryable,
      mayHaveExecuted: false,
    });
  }
}

function closeSftpQuietly(session: SftpReadSession): void {
  try {
    session.end();
  } catch {
    // The read result or primary failure remains authoritative.
  }
}

export async function readSftpRemoteFileBounded(
  session: SftpReadSession,
  remotePath: string,
  options: BoundedSftpReadOptions,
): Promise<Buffer> {
  let source: Readable | undefined;
  try {
    source = session.createReadStream(remotePath);
    return await readSftpFileBounded(source, options);
  } catch (error) {
    source?.destroy();
    if (error instanceof RouterOperationError) throw error;
    throw operationError("SFTP_READ_FAILED", true);
  } finally {
    closeSftpQuietly(session);
  }
}

export async function stageSftpRemoteFileBounded(
  session: SftpReadSession,
  remotePath: string,
  options: StagedSftpReadOptions,
): Promise<StagedSftpFile> {
  let source: Readable | undefined;
  try {
    source = session.createReadStream(remotePath);
    return await stageSftpFileBounded(source, options);
  } catch (error) {
    source?.destroy();
    if (error instanceof RouterOperationError) throw error;
    throw operationError("SFTP_READ_FAILED", true);
  } finally {
    closeSftpQuietly(session);
  }
}
