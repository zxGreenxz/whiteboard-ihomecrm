import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MANIFEST_PATH = join(REPO_ROOT, "scripts", "network-center-rollout-manifest.json");
export const RECEIPT_ROOT = join(REPO_ROOT, ".network-center-rollout");
export const MANAGEMENT_API_ROOT = "https://api.supabase.com/v1";
export const PAT_PATTERN = /\bsbp_[A-Za-z0-9_-]+\b/;

// The rollout contract covers EVERY Network Center migration in the repository,
// not a hand-kept list. The pattern is deliberately wider than the 20260729
// batch that exists today: a fifteenth migration authored on a later date must
// be caught by the manifest generator and by the validator's completeness
// check, never silently omitted. An incomplete manifest applied to production
// is the exact failure this contract exists to prevent.
export const NETWORK_CENTER_MIGRATION_PATTERN = /^\d{14}_network_center_[a-z0-9_]+\.sql$/;

// A floor, not an expectation: the set may grow, but a SHRINK means either a
// deleted migration or a rotted discovery rule, and both must fail loudly.
export const MINIMUM_NETWORK_CENTER_ROLLOUT_MIGRATIONS = 14;

export async function discoverNetworkCenterMigrations(repoRoot = REPO_ROOT) {
  const migrationRoot = join(repoRoot, "supabase", "migrations");
  const names = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && NETWORK_CENTER_MIGRATION_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length < MINIMUM_NETWORK_CENTER_ROLLOUT_MIGRATIONS) {
    throw new Error(
      `Network Center migration set shrank to ${names.length}; expected at least ` +
        `${MINIMUM_NETWORK_CENTER_ROLLOUT_MIGRATIONS}. Raise the floor deliberately or restore the file.`,
    );
  }
  return names.map((name) => `supabase/migrations/${name}`);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path) {
  return sha256(await readFile(path));
}

export function redactSecrets(value, knownSecrets = []) {
  let result = String(value ?? "");
  for (const secret of knownSecrets) {
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result.replace(/\bsbp_[A-Za-z0-9_-]+\b/g, "[REDACTED]");
}

export async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export async function loadLocalRuntimeConfig(repoRoot = REPO_ROOT) {
  const primary = join(repoRoot, "CLAUDE.local.md");
  const worktreeParent = resolve(repoRoot, "..", "..", "..", "CLAUDE.local.md");
  const primaryContents = await readOptional(primary);
  if (primaryContents) return primaryContents;
  const normalizedRoot = resolve(repoRoot).replaceAll("\\", "/");
  if (normalizedRoot.includes("/.claude/worktrees/") && worktreeParent !== primary) {
    return readOptional(worktreeParent);
  }
  return "";
}

export function parseProjectRef(configToml) {
  const projectRef = String(configToml).match(/^\s*project_id\s*=\s*["']([a-z0-9]{20})["']/m)?.[1];
  if (!projectRef) throw new Error("Could not resolve the Supabase project ref");
  return projectRef;
}

export function extractManagementPat({ environment = process.env, localConfig = "" } = {}) {
  const pat =
    environment.SUPABASE_ACCESS_TOKEN?.trim() ||
    environment.SUPABASE_PAT?.trim() ||
    String(localConfig).match(PAT_PATTERN)?.[0] ||
    "";
  if (!PAT_PATTERN.test(pat)) throw new Error("Supabase Management API PAT is unavailable");
  return pat;
}

export async function loadManifest(path = MANIFEST_PATH) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadManagementConfig({ repoRoot = REPO_ROOT, environment = process.env } = {}) {
  const [configToml, localConfig] = await Promise.all([
    readFile(join(repoRoot, "supabase", "config.toml"), "utf8"),
    loadLocalRuntimeConfig(repoRoot),
  ]);
  return {
    projectRef: parseProjectRef(configToml),
    pat: extractManagementPat({ environment, localConfig }),
  };
}

export async function executeManagementQuery({
  projectRef,
  pat,
  sql,
  fetchImpl = fetch,
}) {
  let response;
  try {
    response = await fetchImpl(`${MANAGEMENT_API_ROOT}/projects/${projectRef}/database/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    });
  } catch (error) {
    throw new Error(redactSecrets(`Management API request failed: ${error?.message}`, [pat]));
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      redactSecrets(`Management API query failed (${response.status}): ${text.slice(0, 2_000)}`, [pat]),
    );
  }
  try {
    return text ? JSON.parse(text) : [];
  } catch {
    throw new Error("Management API returned invalid JSON");
  }
}

export function isEntrypoint(metaUrl) {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === metaUrl;
}

export function relativeToRepo(path, repoRoot = REPO_ROOT) {
  const root = resolve(repoRoot);
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
    throw new Error("Path escapes the repository root");
  }
  return target.slice(root.length + (target === root ? 0 : 1)).replaceAll("\\", "/");
}

export function manifestDirectory(path = MANIFEST_PATH) {
  return dirname(path);
}
