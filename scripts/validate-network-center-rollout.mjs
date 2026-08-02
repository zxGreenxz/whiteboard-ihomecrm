#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MINIMUM_NETWORK_CENTER_ROLLOUT_MIGRATIONS,
  NETWORK_CENTER_MIGRATION_PATTERN,
  REPO_ROOT,
  discoverNetworkCenterMigrations,
  isEntrypoint,
  loadManifest,
  parseProjectRef,
  redactSecrets,
  sha256,
  sha256File,
} from "./network-center-rollout-common.mjs";
import { collectDeploymentFiles, computeSourceDigest } from "./deploy-edge-fn.mjs";
import { NETWORK_CENTER_ROLLOUT_LOCK, catalogDescriptorSql } from "./apply-network-center-rollout.mjs";

/**
 * Structural validation of the rollout contract itself.
 *
 * Digest checking alone is not validation. Until this existed, a manifest could
 * drop a migration entry, renumber the ordinals and still pass every check -
 * every file it DID list hashed correctly, so an incomplete rollout validated
 * clean. That is precisely how the manifest came to pin ten migrations while
 * fourteen existed on disk.
 *
 * Each rule below is load-bearing for apply-network-center-rollout.mjs:
 *   - completeness: the manifest must cover every Network Center migration in
 *     the repository, or production gets a partial schema.
 *   - apply order: stages run in array order; a swap applies a migration before
 *     its dependency.
 *   - cumulative postApply: stage N's in-lock precondition is stage N-1's list,
 *     and everything NOT in it is asserted absent. A shrinking list makes a
 *     healthy database look divergent and blocks the rollout mid-flight.
 *   - descriptor vocabulary: catalogDescriptorSql throws on anything it cannot
 *     verify. Better here than inside a transaction against production.
 */
export function assertManifestStructure(manifest, { expectedMigrationPaths } = {}) {
  if (manifest?.schemaVersion !== 1) throw new Error("Manifest rejected: unsupported schemaVersion");
  if (!/^[a-z0-9]{20}$/.test(manifest.projectRef ?? "")) {
    throw new Error("Manifest rejected: projectRef is not a Supabase project reference");
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.reviewedGitSha ?? "")) {
    throw new Error("Manifest rejected: reviewedGitSha must be a full 40-character revision");
  }
  if (manifest.lockName !== NETWORK_CENTER_ROLLOUT_LOCK) {
    throw new Error("Manifest rejected: lockName does not match the rollout advisory lock");
  }
  const migrations = manifest.migrations;
  if (!Array.isArray(migrations) || !migrations.length) {
    throw new Error("Manifest rejected: migrations must be a non-empty ordered list");
  }
  // Completeness before the floor: when a migration has been dropped, naming it
  // is worth more than reporting that the count is one short.
  if (expectedMigrationPaths) {
    const listed = migrations.map((migration) => migration?.path);
    const missing = expectedMigrationPaths.filter((path) => !listed.includes(path));
    const extra = listed.filter((path) => !expectedMigrationPaths.includes(path));
    if (missing.length || extra.length) {
      throw new Error(
        "Manifest rejected: it does not cover every Network Center migration in the repository" +
          `${missing.length ? `; missing ${missing.join(", ")}` : ""}` +
          `${extra.length ? `; unknown ${extra.join(", ")}` : ""}`,
      );
    }
  }
  if (migrations.length < MINIMUM_NETWORK_CENTER_ROLLOUT_MIGRATIONS) {
    throw new Error(
      `Manifest rejected: expected at least ${MINIMUM_NETWORK_CENTER_ROLLOUT_MIGRATIONS} migrations, found ${migrations.length}`,
    );
  }
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    const path = String(migration?.path ?? "");
    if (!path.startsWith("supabase/migrations/")) {
      throw new Error(`Manifest rejected: migration path is outside supabase/migrations: ${path}`);
    }
    if (!NETWORK_CENTER_MIGRATION_PATTERN.test(path.slice("supabase/migrations/".length))) {
      throw new Error(`Manifest rejected: migration path is not a Network Center migration: ${path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(migration?.sha256 ?? "")) {
      throw new Error(`Manifest rejected: migration digest is malformed for ${path}`);
    }
    if (migration?.ordinal !== index + 1) {
      throw new Error(
        `Manifest rejected: ordinal ${migration?.ordinal} does not match apply position ${index + 1} for ${path}`,
      );
    }
    if (index > 0 && migrations[index - 1].path >= path) {
      throw new Error(
        `Manifest rejected: apply order is not strictly ascending at ${path}; migrations run in array order`,
      );
    }
  }
  const descriptorGroups = [
    ["preflight.required", manifest.preflight?.required ?? []],
    ["preflight.absent", manifest.preflight?.absent ?? []],
    ["postApply.required", manifest.postApply?.required ?? []],
    ...migrations.map((migration) => [`${migration.path}.postApply`, migration.postApply?.required ?? []]),
  ];
  for (const [label, descriptors] of descriptorGroups) {
    if (!Array.isArray(descriptors)) throw new Error(`Manifest rejected: ${label} is not a list`);
    for (const descriptor of descriptors) {
      try {
        catalogDescriptorSql(descriptor);
      } catch (error) {
        throw new Error(`Manifest rejected: unverifiable descriptor in ${label}: ${error.message}`);
      }
    }
    if (new Set(descriptors).size !== descriptors.length) {
      throw new Error(`Manifest rejected: duplicate descriptor in ${label}`);
    }
  }
  if (!(manifest.preflight?.required ?? []).length) {
    throw new Error("Manifest rejected: preflight.required must name the foundation objects");
  }
  for (let index = 1; index < migrations.length; index += 1) {
    const previous = new Set(migrations[index - 1].postApply?.required ?? []);
    const current = new Set(migrations[index].postApply?.required ?? []);
    const lost = [...previous].filter((descriptor) => !current.has(descriptor));
    if (lost.length) {
      throw new Error(
        `Manifest rejected: postApply assertions are not cumulative at ${migrations[index].path}; ` +
          `stage ${index} required ${lost.slice(0, 3).join(", ")} and stage ${index + 1} no longer does`,
      );
    }
  }
  const finalRequired = new Set(migrations[migrations.length - 1].postApply?.required ?? []);
  const unbacked = (manifest.postApply?.required ?? []).filter(
    (descriptor) => !finalRequired.has(descriptor),
  );
  if (unbacked.length) {
    throw new Error(
      `Manifest rejected: postApply.required asserts objects no stage guarantees: ${unbacked.slice(0, 3).join(", ")}`,
    );
  }
  const edge = manifest.edgeFunction;
  if (!edge?.slug || !edge?.path || !Array.isArray(edge.files) || !edge.files.length) {
    throw new Error("Manifest rejected: edgeFunction must pin an explicit file allowlist");
  }
  for (const file of edge.files) {
    if (!/^[a-f0-9]{64}$/.test(file?.sha256 ?? "")) {
      throw new Error(`Manifest rejected: edge file digest is malformed for ${file?.path}`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(edge.sha256 ?? "")) {
    throw new Error("Manifest rejected: edgeFunction bundle digest is malformed");
  }
  return { migrationCount: migrations.length };
}

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

// A CR byte in a pinned file is not a style nit here, it is an unfixable digest
// mismatch. This repository sets core.autocrlf=true and .gitattributes pins
// eol=lf only for *.sh, *.service, *.ps1 and the deploy *.conf files - not for
// *.sql. So a migration saved with CRLF is stored as LF in the object database:
// the worktree digest and the reviewed-revision digest can never agree, and the
// rollout blocks forever with a mismatch that looks like tampering. Say what it
// actually is.
async function readPinnedFile(repoRoot, path) {
  const contents = await readFile(join(repoRoot, path));
  if (contents.includes(0x0d)) {
    throw new Error(
      `Rollout blocked: ${path} contains CRLF line endings. git stores it as LF (core.autocrlf), ` +
        "so its worktree digest can never match its reviewed-revision digest. Normalize the file to " +
        "LF, commit, and regenerate the manifest.",
    );
  }
  return contents;
}

async function buildWorktreeHashes(manifest, repoRoot) {
  const hashes = new Map();
  for (const migration of manifest.migrations) {
    hashes.set(migration.path, sha256(await readPinnedFile(repoRoot, migration.path)));
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
  // Structure first: a malformed or incomplete contract is a defect in the
  // contract, and saying so beats reporting whatever the git state happens to
  // be that day.
  assertManifestStructure(manifest, {
    expectedMigrationPaths: await discoverNetworkCenterMigrations(repoRoot),
  });
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
  const hashes = await buildWorktreeHashes(manifest, repoRoot);
  // Reading the reviewed revision only makes sense once that revision is known
  // to be reachable. Reading it first turns "reviewed revision is not an
  // ancestor" - the actionable message - into a raw `git show` failure.
  return validateLocalRollout({
    manifest,
    projectRef: parseProjectRef(configToml),
    isClean: git(["status", "--porcelain"], { repoRoot }).trim() === "",
    isReviewedAncestor,
    hashes,
    reviewedHashes: isReviewedAncestor ? buildReviewedHashes(manifest, repoRoot) : hashes,
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
