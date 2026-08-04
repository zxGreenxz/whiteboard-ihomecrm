#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MANIFEST_PATH,
  RECEIPT_ROOT,
  REPO_ROOT,
  isEntrypoint,
  loadManagementConfig,
  loadManifest,
  redactSecrets,
  sha256,
} from "./network-center-rollout-common.mjs";
import { writeReceiptAtomic } from "./apply-network-center-rollout.mjs";

const WORKER_SLUG = "network-center-worker";
const WORKER_FILES = ["deno.json", "deno.lock", "index.ts", "workerAuth.ts"];

export function buildDeploymentMetadata(slug, sourceDigest, args = []) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug ?? "")) {
    throw new Error("Invalid Edge function slug");
  }
  if (!/^[a-f0-9]{64}$/.test(sourceDigest ?? "")) {
    throw new Error("Invalid Edge source digest");
  }
  const requestedNoVerify = args.includes("--no-verify-jwt");
  if (requestedNoVerify && slug !== WORKER_SLUG) {
    throw new Error("--no-verify-jwt is allowed only for network-center-worker");
  }
  return {
    name: slug,
    entrypoint_path: "index.ts",
    verify_jwt: slug === WORKER_SLUG ? false : true,
    source_digest: sourceDigest,
  };
}

export function computeSourceDigest(fileDescriptors) {
  const normalized = [...fileDescriptors]
    .map(({ path, sha256: digest }) => ({ path: path.replaceAll("\\", "/"), sha256: digest }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha256(JSON.stringify(normalized));
}

export async function collectDeploymentFiles({
  repoRoot = REPO_ROOT,
  slug,
  expectedFiles,
} = {}) {
  const names = expectedFiles ?? (slug === WORKER_SLUG ? WORKER_FILES : null);
  if (!names?.length) throw new Error(`No explicit deployment file allowlist for ${slug}`);
  const functionRoot = join(repoRoot, "supabase", "functions", slug);
  const files = [];
  for (const path of [...names].sort()) {
    if (path.includes("..") || path.startsWith("/") || path.includes("\\")) {
      throw new Error(`Unsafe Edge deployment path: ${path}`);
    }
    const absolutePath = join(functionRoot, path);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Edge deployment file must be a regular non-symlink file: ${path}`);
    }
    const contents = await readFile(absolutePath);
    files.push({ path, absolutePath, contents, sha256: sha256(contents) });
  }
  return files;
}

export async function deployEdgeFunction({
  slug,
  args = [],
  revision,
  manifest,
  config,
  fetchImpl = fetch,
  writeReceipt = writeReceiptAtomic,
  receiptRoot = RECEIPT_ROOT,
  manifestDigest,
} = {}) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? "")) {
    throw new Error("A full release revision is required");
  }
  manifest ??= await loadManifest(MANIFEST_PATH);
  config ??= await loadManagementConfig();
  manifestDigest ??= sha256(await readFile(MANIFEST_PATH));
  if (slug !== manifest.edgeFunction.slug) throw new Error("Edge slug does not match rollout manifest");
  if (config.projectRef !== manifest.projectRef) throw new Error("Edge deploy project mismatch");
  const files = await collectDeploymentFiles({
    slug,
    expectedFiles: manifest.edgeFunction.files.map((file) => file.path),
  });
  for (const file of files) {
    const expected = manifest.edgeFunction.files.find((candidate) => candidate.path === file.path);
    if (expected?.sha256 !== file.sha256) throw new Error(`Edge source digest mismatch: ${file.path}`);
  }
  const sourceDigest = computeSourceDigest(files);
  if (sourceDigest !== manifest.edgeFunction.sha256) throw new Error("Edge bundle digest mismatch");
  const metadata = buildDeploymentMetadata(slug, sourceDigest, args);
  const { source_digest: ignoredDigest, ...apiMetadata } = metadata;
  const form = new FormData();
  form.append("metadata", JSON.stringify(apiMetadata));
  for (const file of files) {
    form.append("file", new Blob([file.contents], { type: "application/octet-stream" }), file.path);
  }
  const response = await fetchImpl(
    `https://api.supabase.com/v1/projects/${config.projectRef}/functions/deploy?slug=${slug}`,
    { method: "POST", headers: { Authorization: `Bearer ${config.pat}` }, body: form },
  );
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      redactSecrets(`Edge deploy failed (${response.status}): ${responseText.slice(0, 2_000)}`, [config.pat]),
    );
  }
  const deployed = JSON.parse(responseText);
  if (deployed.slug !== slug || deployed.verify_jwt !== false) {
    throw new Error("Edge deploy readback did not preserve worker slug and verify_jwt=false");
  }
  await writeReceipt(
    {
      schemaVersion: 1,
      manifestDigest,
      projectRef: config.projectRef,
      reviewedGitSha: manifest.reviewedGitSha,
      releaseSha: revision,
      ordinal: 0,
      migration: `edge:${slug}`,
      migrationSha256: sourceDigest,
      outcome: "committed",
      startedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      beforeCatalogFingerprint: "edge-deploy",
      afterCatalogFingerprint: `version:${deployed.version}`,
    },
    { receiptRoot },
  );
  return { slug, version: deployed.version, verify_jwt: false, source_digest: sourceDigest };
}

function parseCliArgs(argv) {
  const slug = argv[0];
  let revision;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--revision") revision = argv[++index];
    else if (argv[index] !== "--no-verify-jwt") throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return { slug, revision, args: argv.filter((arg) => arg === "--no-verify-jwt") };
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (!options.slug) {
    throw new Error(
      "Usage: node scripts/deploy-edge-fn.mjs <slug> [--no-verify-jwt] --revision <40-char-sha>",
    );
  }
  const { validateRolloutCli } = await import("./validate-network-center-rollout.mjs");
  const validation = await validateRolloutCli({ revision: options.revision });
  options.revision = validation.releaseSha;
  const result = await deployEdgeFunction(options);
  process.stdout.write(
    `Deployed ${result.slug} version=${result.version} verify_jwt=${result.verify_jwt} source_digest=${result.source_digest}\n`,
  );
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(redactSecrets(error?.message ?? error));
    process.exitCode = 1;
  });
}
