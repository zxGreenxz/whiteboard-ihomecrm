import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildMinimalChildEnvironment } from "./gen-supabase-types.mjs";
import { redactSensitiveText } from "./test-openclaw-sql.mjs";

export const FULL_RESET_MANIFEST_DOMAIN = "ihome-openclaw-full-reset-plan-v1";
export const FULL_RESET_SYNTHETIC_BASE = 80_000_000_000_000;
export const FULL_RESET_EXPECTED_FILE_COUNT = 498;
export const FULL_RESET_EXPECTED_DUPLICATE_VERSION_GROUPS = 18;
export const SUPABASE_CLI_VERSION = "2.109.1";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const MIGRATION_FILE_PATTERN = /^\d+_[a-z0-9_-]+\.sql$/;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function buildFullResetPlan(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("The complete migration input set cannot be empty.");
  }
  const seen = new Set();
  const normalized = inputs.map(({ file, bytes }) => {
    if (
      typeof file !== "string" ||
      basename(file) !== file ||
      !MIGRATION_FILE_PATTERN.test(file)
    ) {
      throw new Error(`Unsafe migration filename: ${String(file)}`);
    }
    if (seen.has(file)) throw new Error(`Duplicate migration file: ${file}`);
    seen.add(file);
    const rawBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes ?? "");
    return {
      sourceFile: file,
      sourceVersion: file.slice(0, file.indexOf("_")),
      bytes: rawBytes,
    };
  }).sort((left, right) => compareUtf8(left.sourceFile, right.sourceFile));

  const versionCounts = new Map();
  for (const entry of normalized) {
    versionCounts.set(
      entry.sourceVersion,
      (versionCounts.get(entry.sourceVersion) ?? 0) + 1,
    );
  }
  const duplicateOriginalVersionGroups = [...versionCounts.values()]
    .filter((count) => count > 1).length;

  const entries = normalized.map((entry, index) => {
    const targetVersion = String(FULL_RESET_SYNTHETIC_BASE + index + 1);
    return {
      order: index + 1,
      sourceFile: entry.sourceFile,
      sourceVersion: entry.sourceVersion,
      targetVersion,
      targetFile: `${targetVersion}_${entry.sourceFile}`,
      rawSha256: createHash("sha256").update(entry.bytes).digest("hex"),
      bytes: entry.bytes,
    };
  });

  const aggregate = createHash("sha256")
    .update(FULL_RESET_MANIFEST_DOMAIN)
    .update(Buffer.from([0]));
  for (const entry of entries) {
    aggregate.update(entry.sourceFile).update(Buffer.from([0]));
    aggregate.update(entry.sourceVersion).update(Buffer.from([0]));
    aggregate.update(entry.targetFile).update(Buffer.from([0]));
    aggregate.update(entry.rawSha256).update(Buffer.from([0]));
  }
  return {
    entries,
    duplicateOriginalVersionGroups,
    aggregateSha256: aggregate.digest("hex"),
  };
}

export async function loadRepositoryMigrationInputs({
  repoRoot = repositoryRoot,
} = {}) {
  const migrationRoot = join(repoRoot, "supabase", "migrations");
  const directoryEntries = await readdir(migrationRoot, { withFileTypes: true });
  const files = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort(compareUtf8);
  return Promise.all(files.map(async (file) => ({
    file,
    bytes: await readFile(join(migrationRoot, file)),
  })));
}

function assertSafeTemporaryRoot(root) {
  const resolvedRoot = resolve(root);
  const resolvedTemporaryRoot = resolve(tmpdir());
  const relationship = relative(resolvedTemporaryRoot, resolvedRoot);
  if (
    !relationship ||
    relationship === ".." ||
    relationship.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    !basename(resolvedRoot).startsWith("openclaw-full-reset-")
  ) {
    throw new Error("Refusing to clean an unsafe full-reset temporary path.");
  }
  return resolvedRoot;
}

function manifestJson(plan) {
  return `${JSON.stringify({
    schema: 1,
    domain: FULL_RESET_MANIFEST_DOMAIN,
    fileCount: plan.entries.length,
    duplicateOriginalVersionGroups: plan.duplicateOriginalVersionGroups,
    aggregateSha256: plan.aggregateSha256,
    entries: plan.entries.map((entry) => ({
      order: entry.order,
      sourceFile: entry.sourceFile,
      sourceVersion: entry.sourceVersion,
      targetVersion: entry.targetVersion,
      targetFile: entry.targetFile,
      rawSha256: entry.rawSha256,
    })),
  }, null, 2)}\n`;
}

export async function prepareDisposableFullResetProject({
  inputs,
  configToml,
  repoRoot = repositoryRoot,
} = {}) {
  const migrationInputs = inputs ?? await loadRepositoryMigrationInputs({ repoRoot });
  const sourceConfig = configToml ?? await readFile(
    join(repoRoot, "supabase", "config.toml"),
    "utf8",
  );
  const projectRows = sourceConfig.match(/^project_id\s*=\s*"[^"]*"\s*$/gm) ?? [];
  if (projectRows.length !== 1) {
    throw new Error("Supabase config must contain exactly one project_id binding.");
  }
  const preparedConfig = sourceConfig.replace(
    /^project_id\s*=\s*"[^"]*"\s*$/m,
    'project_id = "openclaw_task12_ephemeral"',
  );
  const plan = buildFullResetPlan(migrationInputs);
  const root = await mkdtemp(join(tmpdir(), "openclaw-full-reset-"));
  const safeRoot = assertSafeTemporaryRoot(root);
  let prepared = false;
  try {
    const supabaseRoot = join(safeRoot, "supabase");
    const migrationRoot = join(supabaseRoot, "migrations");
    await mkdir(migrationRoot, { recursive: true });
    await writeFile(join(supabaseRoot, "config.toml"), preparedConfig, {
      encoding: "utf8",
      flag: "wx",
    });
    await Promise.all(plan.entries.map((entry) =>
      writeFile(join(migrationRoot, entry.targetFile), entry.bytes, { flag: "wx" })
    ));
    await writeFile(
      join(safeRoot, "openclaw-full-reset-manifest.json"),
      manifestJson(plan),
      { encoding: "utf8", flag: "wx" },
    );
    prepared = true;
  } finally {
    if (!prepared) await rm(safeRoot, { recursive: true, force: true });
  }
  let cleaned = false;
  return {
    root: safeRoot,
    plan,
    cleanup: async () => {
      if (cleaned) return;
      assertSafeTemporaryRoot(safeRoot);
      await rm(safeRoot, { recursive: true, force: true, maxRetries: 3 });
      cleaned = true;
    },
  };
}

export function parseFullResetArgs(args) {
  if (args.length === 1 && args[0] === "--plan-only") return { mode: "plan-only" };
  if (args.length === 1 && args[0] === "--local") return { mode: "local" };
  throw new Error("An explicit --plan-only or --local full-reset mode is required.");
}

function appendBounded(chunks, state, chunk) {
  if (state.bytes >= MAX_CAPTURE_BYTES) return;
  const remaining = MAX_CAPTURE_BYTES - state.bytes;
  const bounded = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(bounded);
  state.bytes += bounded.length;
}

function buildPinnedInvocation(args, environment = process.env) {
  if (process.platform === "win32") {
    const npmCliPath = environment.npm_execpath ?? join(
      dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    return {
      command: process.execPath,
      args: [
        npmCliPath,
        "exec",
        "--yes",
        "--package",
        `supabase@${SUPABASE_CLI_VERSION}`,
        "--",
        "supabase",
        ...args,
      ],
    };
  }
  return {
    command: "npx",
    args: ["--yes", `supabase@${SUPABASE_CLI_VERSION}`, ...args],
  };
}

export function runPinnedSupabaseCli(
  args,
  { cwd = repositoryRoot, environment = process.env } = {},
) {
  const invocation = buildPinnedInvocation(args, environment);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: buildMinimalChildEnvironment(environment),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    child.stdout.on("data", (chunk) => appendBounded(stdout, stdoutState, chunk));
    child.stderr.on("data", (chunk) => appendBounded(stderr, stderrState, chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function assertFrozenPlan(plan) {
  if (plan.entries.length !== FULL_RESET_EXPECTED_FILE_COUNT) {
    throw new Error(
      `Full-reset migration cardinality drifted: ${plan.entries.length}.`,
    );
  }
  if (
    plan.duplicateOriginalVersionGroups !==
    FULL_RESET_EXPECTED_DUPLICATE_VERSION_GROUPS
  ) {
    throw new Error(
      "Full-reset duplicate-version group cardinality drifted.",
    );
  }
}

function cliFailure(label, result) {
  const details = redactSensitiveText(
    `${result.stderr ?? ""}\n${result.stdout ?? ""}`,
  ).trim().slice(0, 4_000);
  return new Error(`${label} failed.${details ? ` ${details}` : ""}`);
}

export async function runFullResetHarness({
  args = process.argv.slice(2),
  environment = process.env,
  dependencies = {},
} = {}) {
  const options = parseFullResetArgs(args);
  const loadInputs = dependencies.loadInputs ?? loadRepositoryMigrationInputs;
  if (options.mode === "plan-only") {
    const plan = buildFullResetPlan(await loadInputs());
    assertFrozenPlan(plan);
    return {
      mode: options.mode,
      summary: `PASS OpenClaw full-reset plan: ${plan.entries.length}-file chain`,
      migrationManifestSha256: plan.aggregateSha256,
    };
  }

  const prepareProject =
    dependencies.prepareProject ?? prepareDisposableFullResetProject;
  const runCli = dependencies.runCli ?? ((cliArgs, cliOptions) =>
    runPinnedSupabaseCli(cliArgs, cliOptions));
  const prepared = await prepareProject();
  let primaryError;
  let result;
  let shouldStop = false;
  try {
    assertFrozenPlan(prepared.plan);
    const version = await runCli(["--version"], {
      cwd: prepared.root,
      environment,
    });
    if (
      version.code !== 0 ||
      version.stdout.trim() !== SUPABASE_CLI_VERSION
    ) {
      throw cliFailure("Pinned Supabase CLI verification", version);
    }
    shouldStop = true;
    const started = await runCli(
      ["db", "start", "--workdir", prepared.root],
      { cwd: prepared.root, environment },
    );
    if (started.code !== 0) throw cliFailure("Disposable Supabase start", started);
    const reset = await runCli([
      "db",
      "reset",
      "--local",
      "--no-seed",
      "--workdir",
      prepared.root,
    ], { cwd: prepared.root, environment });
    if (reset.code !== 0) throw cliFailure("Complete migration reset", reset);
    result = {
      mode: options.mode,
      summary: `PASS OpenClaw complete ${prepared.plan.entries.length}-file Supabase reset`,
      migrationManifestSha256: prepared.plan.aggregateSha256,
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (shouldStop) {
    try {
      const stopped = await runCli(
        ["stop", "--no-backup", "--workdir", prepared.root],
        { cwd: prepared.root, environment },
      );
      if (stopped.code !== 0) {
        cleanupErrors.push(cliFailure("Supabase stop", stopped));
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await prepared.cleanup();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (primaryError || cleanupErrors.length > 0) {
    const errors = [primaryError, ...cleanupErrors].filter(Boolean);
    throw new AggregateError(
      errors,
      errors.map((error) => String(error?.message ?? error)).join("; "),
    );
  }
  return result;
}

async function main() {
  const result = await runFullResetHarness();
  process.stdout.write(`${result.summary}\n`);
  if (result.migrationManifestSha256) {
    process.stdout.write(
      `Migration manifest SHA-256: ${result.migrationManifestSha256}\n`,
    );
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    console.error(redactSensitiveText(error?.message ?? error));
    process.exitCode = 1;
  });
}
