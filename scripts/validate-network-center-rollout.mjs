#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  REPO_ROOT,
  isEntrypoint,
  loadManifest,
  parseProjectRef,
  redactSecrets,
  sha256,
  sha256File,
} from "./network-center-rollout-common.mjs";
import { collectDeploymentFiles, computeSourceDigest } from "./deploy-edge-fn.mjs";

export async function validateLocalRollout({
  manifest,
  projectRef,
  isClean,
  isReviewedAncestor,
  hashes,
  reviewedHashes = hashes,
  releaseSha,
  headSha = releaseSha,
} = {}) {
  if (!isClean) throw new Error("Rollout blocked: Git worktree is dirty");
  if (!isReviewedAncestor) throw new Error("Rollout blocked: reviewed revision is not an ancestor");
  if (releaseSha && headSha && releaseSha !== headSha) {
    throw new Error("Rollout blocked: requested release revision is not clean HEAD");
  }
  if (projectRef !== manifest.projectRef) throw new Error("Rollout blocked: Supabase project mismatch");
  const expected = [
    ...manifest.migrations.map(({ path, sha256: digest }) => [path, digest]),
    [manifest.edgeFunction.path, manifest.edgeFunction.sha256],
  ];
  for (const [path, digest] of expected) {
    if (hashes.get(path) !== digest) throw new Error(`Rollout blocked: worktree digest mismatch for ${path}`);
    if (reviewedHashes.get(path) !== digest) {
      throw new Error(`Rollout blocked: reviewed revision digest mismatch for ${path}`);
    }
  }
  return {
    projectRef,
    reviewedGitSha: manifest.reviewedGitSha,
    releaseSha: releaseSha ?? headSha,
    migrationCount: manifest.migrations.length,
  };
}

function git(args, { repoRoot = REPO_ROOT, encoding = "utf8" } = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function buildWorktreeHashes(manifest, repoRoot) {
  const hashes = new Map();
  for (const migration of manifest.migrations) {
    hashes.set(migration.path, await sha256File(join(repoRoot, migration.path)));
  }
  const files = await collectDeploymentFiles({
    repoRoot,
    slug: manifest.edgeFunction.slug,
    expectedFiles: manifest.edgeFunction.files.map((file) => file.path),
  });
  hashes.set(manifest.edgeFunction.path, computeSourceDigest(files));
  return hashes;
}

function buildReviewedHashes(manifest, repoRoot) {
  const hashes = new Map();
  for (const migration of manifest.migrations) {
    const contents = git(["show", `${manifest.reviewedGitSha}:${migration.path}`], {
      repoRoot,
      encoding: null,
    });
    hashes.set(migration.path, sha256(contents));
  }
  const files = manifest.edgeFunction.files.map((file) => {
    const repositoryPath = `${manifest.edgeFunction.path}/${file.path}`;
    const contents = git(["show", `${manifest.reviewedGitSha}:${repositoryPath}`], {
      repoRoot,
      encoding: null,
    });
    return { path: file.path, sha256: sha256(contents) };
  });
  hashes.set(manifest.edgeFunction.path, computeSourceDigest(files));
  return hashes;
}

export async function validateRolloutCli({
  repoRoot = REPO_ROOT,
  revision,
  manifest,
} = {}) {
  manifest ??= await loadManifest();
  const headSha = git(["rev-parse", "HEAD"], { repoRoot }).trim();
  const releaseSha = revision ?? headSha;
  if (!/^[a-f0-9]{40}$/.test(releaseSha)) throw new Error("A full 40-character release revision is required");
  let isReviewedAncestor = true;
  try {
    git(["merge-base", "--is-ancestor", manifest.reviewedGitSha, releaseSha], { repoRoot });
  } catch {
    isReviewedAncestor = false;
  }
  const configToml = await readFile(join(repoRoot, "supabase", "config.toml"), "utf8");
  return validateLocalRollout({
    manifest,
    projectRef: parseProjectRef(configToml),
    isClean: git(["status", "--porcelain"], { repoRoot }).trim() === "",
    isReviewedAncestor,
    hashes: await buildWorktreeHashes(manifest, repoRoot),
    reviewedHashes: buildReviewedHashes(manifest, repoRoot),
    releaseSha,
    headSha,
  });
}

function parseArgs(argv) {
  let revision;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--revision") revision = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return { revision };
}

async function main() {
  const result = await validateRolloutCli(parseArgs(process.argv.slice(2)));
  process.stdout.write(
    `Network Center rollout validated: ${result.migrationCount} migrations, reviewed=${result.reviewedGitSha}, release=${result.releaseSha}\n`,
  );
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(redactSecrets(error?.message ?? error));
    process.exitCode = 1;
  });
}
