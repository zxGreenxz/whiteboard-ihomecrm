import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

const credentialSchema = z.object({
  origin: z.string().url(), username: z.string().min(1).max(128), password: z.string().min(1).max(512),
}).strict();
export type CameraCredential = z.infer<typeof credentialSchema>;

export function validateCameraOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") throw new Error("CAMERA_ORIGIN_INVALID");
  // IP literals prevent DNS rebinding and accidental credential delivery to a public endpoint.
  const octets = url.hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255) ||
      !(octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 192 && octets[1] === 168))) throw new Error("CAMERA_ORIGIN_NOT_PRIVATE");
  return url.origin;
}

function secretFile(path: string): string {
  if (!isAbsolute(path)) throw new Error("CAMERA_SECRET_PATH_NOT_ABSOLUTE");
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    throw new Error("CAMERA_SECRET_PERMISSIONS_INVALID");
  }
  return readFileSync(path, "utf8");
}

export function loadCameraConfig(env: NodeJS.ProcessEnv = process.env) {
  const setting = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`CAMERA_SETTING_MISSING:${name}`);
    return value;
  };
  const edgeUrl = new URL(setting("NETWORK_CENTER_EDGE_URL"));
  if (edgeUrl.protocol !== "https:" || edgeUrl.username || edgeUrl.password || edgeUrl.search || edgeUrl.hash) {
    throw new Error("CAMERA_EDGE_URL_INVALID");
  }
  const workerSecret = secretFile(setting("CAMERA_WORKER_SECRET_FILE")).trim();
  if (workerSecret.length < 32 || workerSecret.length > 512) throw new Error("CAMERA_WORKER_SECRET_INVALID");
  const parsed = z.record(z.string().min(1).max(255), credentialSchema).safeParse(
    JSON.parse(secretFile(setting("CAMERA_CREDENTIALS_FILE"))),
  );
  if (!parsed.success) throw new Error("CAMERA_CREDENTIALS_INVALID");
  const credentials = new Map<string, CameraCredential>();
  for (const [key, value] of Object.entries(parsed.data)) credentials.set(key, { ...value, origin: validateCameraOrigin(value.origin) });
  const stateDirectory = setting("CAMERA_STATE_DIRECTORY");
  if (!isAbsolute(stateDirectory)) throw new Error("CAMERA_STATE_DIRECTORY_NOT_ABSOLUTE");
  return { edgeUrl, workerSecret, credentials, stateDirectory };
}
