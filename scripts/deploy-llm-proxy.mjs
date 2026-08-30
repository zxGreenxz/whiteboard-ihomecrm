#!/usr/bin/env node
// Standalone llm-proxy release path. This intentionally does not import the
// Network Center rollout manifest or validation chain.
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import releaseManifest from "./deploy-llm-proxy-manifest.mjs";

const SCRIPT_ROOT = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_ROOT, "..");
export const RELEASE_MANIFEST_PATH = join(SCRIPT_ROOT, "deploy-llm-proxy-manifest.mjs");
export const LLM_PROXY_PROJECT_REF = "tryymsxyyckgbrmmvozx";
export const LLM_PROXY_SLUG = "llm-proxy";
export const LLM_PROXY_ENTRYPOINT = "index.ts";

export const LLM_PROXY_RELEASE_MANIFEST = releaseManifest;

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ACCESS_TOKEN_PATTERN = /^sbp_[A-Za-z0-9_-]{8,}$/u;

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function validateLlmProxyManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("llm-proxy release manifest is invalid");
  if (manifest.projectRef !== LLM_PROXY_PROJECT_REF || !PROJECT_REF_PATTERN.test(manifest.projectRef)) {
    throw new Error(`llm-proxy projectRef must be pinned to ${LLM_PROXY_PROJECT_REF}`);
  }
  if (!SHA1_PATTERN.test(manifest.reviewedGitSha ?? "")) {
    throw new Error("llm-proxy reviewedGitSha must be a full 40-character revision");
  }
  const fn = manifest.function;
  if (!fn || fn.slug !== LLM_PROXY_SLUG || fn.entrypoint !== LLM_PROXY_ENTRYPOINT || fn.verifyJwt !== true) {
    throw new Error("llm-proxy release manifest must pin index.ts and verify_jwt=true");
  }
  if (!Array.isArray(fn.files) || fn.files.length !== 1 || fn.files[0]?.path !== LLM_PROXY_ENTRYPOINT) {
    throw new Error("llm-proxy release manifest must allowlist exactly index.ts");
  }
  if (!SHA256_PATTERN.test(fn.files[0].sha256 ?? "") || !SHA256_PATTERN.test(fn.bundleSha256 ?? "")) {
    throw new Error("llm-proxy release manifest must include index.ts and bundle SHA-256 digests");
  }
  return manifest;
}

export async function loadLlmProxyManifest(path = RELEASE_MANIFEST_PATH) {
  if (path.endsWith(".mjs")) {
    const module = await import(pathToFileURL(resolve(path)).href);
    return validateLlmProxyManifest(module.default ?? module.LLM_PROXY_RELEASE_MANIFEST);
  }
  return validateLlmProxyManifest(JSON.parse(await readFile(path, "utf8")));
}

export async function collectLlmProxyBundle({ repoRoot = REPO_ROOT, manifest }) {
  validateLlmProxyManifest(manifest);
  const functionRoot = join(resolve(repoRoot), "supabase", "functions", LLM_PROXY_SLUG);
  const indexPath = join(functionRoot, LLM_PROXY_ENTRYPOINT);
  const metadata = await lstat(indexPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("llm-proxy index.ts must be a regular non-symlink file");
  }
  const bytes = await readFile(indexPath);
  const indexSha256 = sha256(bytes);
  const expectedFile = manifest.function.files[0];
  if (indexSha256 !== expectedFile.sha256) {
    throw new Error(`llm-proxy index.ts SHA-256 mismatch: expected ${expectedFile.sha256}, got ${indexSha256}`);
  }
  const bundleSha256 = sha256(JSON.stringify([{ path: LLM_PROXY_ENTRYPOINT, sha256: indexSha256 }]));
  if (bundleSha256 !== manifest.function.bundleSha256) {
    throw new Error(`llm-proxy bundle SHA-256 mismatch: expected ${manifest.function.bundleSha256}, got ${bundleSha256}`);
  }
  return {
    files: [{ path: LLM_PROXY_ENTRYPOINT, bytes }],
    indexSha256,
    bundleSha256,
  };
}

export async function buildLlmProxyRelease({ repoRoot = REPO_ROOT, manifest, releaseSha }) {
  validateLlmProxyManifest(manifest);
  if (!SHA1_PATTERN.test(releaseSha ?? "")) throw new Error("A full 40-character release SHA is required");
  const bundle = await collectLlmProxyBundle({ repoRoot, manifest });
  return {
    projectRef: manifest.projectRef,
    reviewedGitSha: manifest.reviewedGitSha,
    releaseSha,
    slug: LLM_PROXY_SLUG,
    entrypoint: LLM_PROXY_ENTRYPOINT,
    verifyJwt: true,
    ...bundle,
  };
}

function parseReadbackPayload(value) {
  if (Array.isArray(value)) return value.find((item) => item?.slug === LLM_PROXY_SLUG || item?.name === LLM_PROXY_SLUG);
  if (value && typeof value === "object") {
    if (value.slug === LLM_PROXY_SLUG || value.name === LLM_PROXY_SLUG) return value;
    if (Array.isArray(value.functions)) return parseReadbackPayload(value.functions);
  }
  return null;
}

async function readbackLlmProxy({ projectRef, accessToken, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}/functions`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`llm-proxy readback failed (${response.status})`);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("llm-proxy readback was not JSON"); }
  const deployed = parseReadbackPayload(payload);
  if (!deployed || deployed.slug !== LLM_PROXY_SLUG && deployed.name !== LLM_PROXY_SLUG) {
    throw new Error("llm-proxy readback did not find the deployed function");
  }
  if (deployed.verify_jwt !== true && deployed.verifyJwt !== true) {
    throw new Error("llm-proxy readback did not preserve verify_jwt=true");
  }
  return deployed;
}

export async function deployLlmProxy({
  repoRoot = REPO_ROOT,
  manifest,
  config,
  releaseSha,
  fetchImpl = fetch,
}) {
  const release = await buildLlmProxyRelease({ repoRoot, manifest, releaseSha });
  if (!config || config.projectRef !== release.projectRef) throw new Error("llm-proxy projectRef mismatch");
  if (!ACCESS_TOKEN_PATTERN.test(config.pat ?? "")) throw new Error("Supabase access token is unavailable");

  const form = new FormData();
  form.append("metadata", JSON.stringify({
    name: LLM_PROXY_SLUG,
    entrypoint_path: LLM_PROXY_ENTRYPOINT,
    verify_jwt: true,
  }));
  for (const file of release.files) {
    form.append("file", new Blob([file.bytes], { type: "application/typescript" }), file.path);
  }
  const deployResponse = await fetchImpl(
    `https://api.supabase.com/v1/projects/${release.projectRef}/functions/deploy?slug=${LLM_PROXY_SLUG}`,
    { method: "POST", headers: { Authorization: `Bearer ${config.pat}` }, body: form },
  );
  const deployText = await deployResponse.text();
  if (!deployResponse.ok) throw new Error(`llm-proxy deploy failed (${deployResponse.status})`);
  let deployed;
  try { deployed = JSON.parse(deployText); } catch { throw new Error("llm-proxy deploy response was not JSON"); }
  if (deployed.slug !== LLM_PROXY_SLUG || deployed.verify_jwt !== true) {
    throw new Error("llm-proxy deploy response did not preserve verify_jwt=true");
  }
  const readback = await readbackLlmProxy({ projectRef: release.projectRef, accessToken: config.pat, fetchImpl });
  return {
    ...release,
    version: deployed.version,
    readbackVersion: readback.version,
  };
}

export function parseDeployArgs(argv) {
  let releaseSha;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--release-sha" || argv[index] === "--revision") releaseSha = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!SHA1_PATTERN.test(releaseSha ?? "")) {
    throw new Error("Usage: node scripts/deploy-llm-proxy.mjs --release-sha <40-char-sha>");
  }
  return { releaseSha };
}

async function loadCliConfig() {
  const configToml = await readFile(join(REPO_ROOT, "supabase", "config.toml"), "utf8");
  const projectRef = configToml.match(/^\s*project_id\s*=\s*["']([a-z0-9]{20})["']/mu)?.[1];
  const pat = process.env.SUPABASE_ACCESS_TOKEN?.trim() || process.env.SUPABASE_PAT?.trim();
  if (!pat) throw new Error("Supabase access token is unavailable; set SUPABASE_ACCESS_TOKEN or SUPABASE_PAT");
  return { projectRef, pat };
}

async function main() {
  const { releaseSha } = parseDeployArgs(process.argv.slice(2));
  const manifest = await loadLlmProxyManifest();
  const config = await loadCliConfig();
  const result = await deployLlmProxy({ manifest, config, releaseSha });
  process.stdout.write(
    `Deployed ${result.slug} version=${result.version} verify_jwt=true ` +
    `projectRef=${result.projectRef} reviewedGitSha=${result.reviewedGitSha} ` +
    `releaseSha=${result.releaseSha} index_sha256=${result.indexSha256} bundle_sha256=${result.bundleSha256}\n`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}
