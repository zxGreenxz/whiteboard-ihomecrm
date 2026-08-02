import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import type { RouterCredential } from "./domain.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface WorkerConfig {
  edgeUrl: URL;
  workerKey: string;
  workerSecret: string;
  credentials: ReadonlyMap<string, RouterCredential>;
  credentialsFile: string;
  backupDirectory: string;
  pollIntervalMs: number;
  commandPollIntervalMs: number;
  heartbeatIntervalMs: number;
  connectionRefreshIntervalMs: number;
  requestTimeoutMs: number;
  commandTimeoutMs: number;
  leaseSeconds: number;
  releaseSha: string;
  pollConcurrency: number;
  commandConcurrency: number;
  commandClaimLimit: number;
  sftpConcurrency: number;
  emergencyStop: boolean;
}

interface FileAccess {
  readText(path: string): string;
  mode(path: string): number;
}

interface LoadConfigInput {
  env?: Record<string, string | undefined>;
  argv?: string[];
  files?: FileAccess;
  platform?: NodeJS.Platform | "linux";
}

const defaultFiles: FileAccess = {
  readText: (path) => readFileSync(path, "utf8"),
  mode: (path) => statSync(path).mode & 0o777,
};

const credentialEntrySchema = z.object({
  username: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._@+-]+$/),
  privateKeyFile: z.string().trim().min(1).max(1_024),
  privateKeyPassphraseFile: z.string().trim().min(1).max(1_024).optional(),
  backupPasswordFile: z.string().trim().min(1).max(1_024),
}).strict();

const credentialFileSchema = z.record(
  z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  credentialEntrySchema,
);

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required setting ${name}`);
  return value;
}

function integerSetting(
  env: Record<string, string | undefined>,
  name: string,
  bounds: { minimum: number; maximum: number; fallback?: number },
): number {
  const raw = env[name]?.trim();
  if (!raw && bounds.fallback !== undefined) return bounds.fallback;
  if (!raw || !/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
    throw new ConfigError(`${name} is outside its safe range`);
  }
  return value;
}

function booleanSetting(env: Record<string, string | undefined>, name: string): boolean {
  const raw = required(env, name).toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ConfigError(`${name} must be true or false`);
}

function assertSecretFile(path: string, files: FileAccess, platform: string): string {
  try {
    if (platform !== "win32") {
      const mode = files.mode(path) & 0o777;
      if ((mode & 0o077) !== 0 || (mode & 0o400) === 0) {
        throw new ConfigError(`Secret file ${path} must be owner-only (0600 or stricter)`);
      }
    }
    return files.readText(path);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Unable to read secure secret file ${path}`);
  }
}

function resolveSecretPath(path: string, credentialFile: string): string {
  return isAbsolute(path) ? path : resolve(credentialFile, "..", path);
}

function loadCredentials(
  path: string,
  files: FileAccess,
  platform: string,
): ReadonlyMap<string, RouterCredential> {
  const raw = assertSecretFile(path, files, platform);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("Router credential file must contain valid JSON");
  }
  const result = credentialFileSchema.safeParse(parsed);
  if (!result.success) throw new ConfigError("Router credential file has an invalid shape");

  const credentials = new Map<string, RouterCredential>();
  for (const [reference, entry] of Object.entries(result.data)) {
    const privateKeyPath = resolveSecretPath(entry.privateKeyFile, path);
    const backupPasswordPath = resolveSecretPath(entry.backupPasswordFile, path);
    const privateKey = assertSecretFile(privateKeyPath, files, platform).trim();
    const backupPassword = assertSecretFile(backupPasswordPath, files, platform).trim();
    if (!/-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----/.test(privateKey)) {
      throw new ConfigError(`Credential ${reference} does not reference a supported SSH private key`);
    }
    if (backupPassword.length < 16 || backupPassword.length > 512) {
      throw new ConfigError(`Credential ${reference} has an invalid backup password file`);
    }
    const privateKeyPassphrase = entry.privateKeyPassphraseFile
      ? assertSecretFile(
        resolveSecretPath(entry.privateKeyPassphraseFile, path),
        files,
        platform,
      ).trim()
      : undefined;
    credentials.set(reference, {
      username: entry.username,
      privateKey,
      backupPassword,
      ...(privateKeyPassphrase ? { privateKeyPassphrase } : {}),
    });
  }
  return credentials;
}

export function loadWorkerConfig(input: LoadConfigInput = {}): WorkerConfig {
  const env = input.env ?? process.env;
  const argv = input.argv ?? process.argv;
  const files = input.files ?? defaultFiles;
  const platform = input.platform ?? process.platform;

  if (argv.length > 2) {
    throw new ConfigError("Worker does not accept command-line settings or secrets");
  }
  if (env.NETWORK_CENTER_MAX_CONCURRENCY?.trim()) {
    throw new ConfigError(
      "NETWORK_CENTER_MAX_CONCURRENCY was removed; configure each bounded concurrency setting explicitly",
    );
  }
  for (const forbidden of [
    "NETWORK_CENTER_WORKER_SECRET",
    "NETWORK_CENTER_ROUTER_PASSWORD",
    "NETWORK_CENTER_ROUTER_PRIVATE_KEY",
    "NETWORK_CENTER_BACKUP_PASSWORD",
  ]) {
    if (env[forbidden]?.trim()) {
      throw new ConfigError(`${forbidden} is forbidden; use a 0600 mounted file`);
    }
  }

  let edgeUrl: URL;
  try {
    edgeUrl = new URL(required(env, "NETWORK_CENTER_EDGE_URL"));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("NETWORK_CENTER_EDGE_URL must be a valid URL");
  }
  if (edgeUrl.protocol !== "https:" || edgeUrl.username || edgeUrl.password || edgeUrl.search || edgeUrl.hash) {
    throw new ConfigError("NETWORK_CENTER_EDGE_URL must be a clean HTTPS URL");
  }
  edgeUrl.pathname = edgeUrl.pathname.replace(/\/+$/, "");

  const workerKey = required(env, "NETWORK_CENTER_WORKER_KEY");
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(workerKey)) {
    throw new ConfigError("NETWORK_CENTER_WORKER_KEY is invalid");
  }
  const releaseSha = required(env, "NETWORK_CENTER_RELEASE_SHA").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(releaseSha)) {
    throw new ConfigError("NETWORK_CENTER_RELEASE_SHA must be a full reviewed Git revision");
  }

  const workerSecretFile = required(env, "NETWORK_CENTER_WORKER_SECRET_FILE");
  const workerSecret = assertSecretFile(workerSecretFile, files, platform).trim();
  if (workerSecret.length < 32 || workerSecret.length > 512) {
    throw new ConfigError("Worker secret file must contain between 32 and 512 characters");
  }
  const credentialsFile = required(env, "NETWORK_CENTER_CREDENTIALS_FILE");
  const credentials = loadCredentials(credentialsFile, files, platform);

  return Object.freeze({
    edgeUrl,
    workerKey,
    workerSecret,
    credentials,
    credentialsFile,
    backupDirectory: required(env, "NETWORK_CENTER_BACKUP_DIR"),
    pollIntervalMs: integerSetting(env, "NETWORK_CENTER_POLL_INTERVAL_MS", {
      minimum: 30_000,
      maximum: 3_600_000,
    }),
    commandPollIntervalMs: integerSetting(env, "NETWORK_CENTER_COMMAND_POLL_INTERVAL_MS", {
      minimum: 1_000,
      maximum: 60_000,
      fallback: 15_000,
    }),
    heartbeatIntervalMs: integerSetting(env, "NETWORK_CENTER_HEARTBEAT_INTERVAL_MS", {
      minimum: 10_000,
      maximum: 300_000,
      fallback: 60_000,
    }),
    connectionRefreshIntervalMs: integerSetting(env, "NETWORK_CENTER_CONNECTION_REFRESH_MS", {
      minimum: 10_000,
      maximum: 3_600_000,
      fallback: 60_000,
    }),
    requestTimeoutMs: integerSetting(env, "NETWORK_CENTER_REQUEST_TIMEOUT_MS", {
      minimum: 1_000,
      maximum: 60_000,
      fallback: 10_000,
    }),
    commandTimeoutMs: integerSetting(env, "NETWORK_CENTER_COMMAND_TIMEOUT_MS", {
      minimum: 5_000,
      maximum: 300_000,
      fallback: 60_000,
    }),
    leaseSeconds: integerSetting(env, "NETWORK_CENTER_LEASE_SECONDS", {
      minimum: 15,
      maximum: 300,
      fallback: 90,
    }),
    releaseSha,
    pollConcurrency: integerSetting(env, "NETWORK_CENTER_POLL_CONCURRENCY", {
      minimum: 1,
      maximum: 3,
      fallback: 3,
    }),
    commandConcurrency: integerSetting(env, "NETWORK_CENTER_COMMAND_CONCURRENCY", {
      minimum: 1,
      maximum: 3,
      fallback: 3,
    }),
    commandClaimLimit: integerSetting(env, "NETWORK_CENTER_COMMAND_CLAIM_LIMIT", {
      minimum: 1,
      maximum: 3,
      fallback: 3,
    }),
    sftpConcurrency: integerSetting(env, "NETWORK_CENTER_SFTP_CONCURRENCY", {
      minimum: 1,
      maximum: 1,
      fallback: 1,
    }),
    emergencyStop: booleanSetting(env, "NETWORK_CENTER_EMERGENCY_STOP"),
  });
}
