import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const MAX_EVIDENCE_BYTES = 16 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;

export const CANONICAL_FINDING_SLUGS = Object.freeze([
  "ci-shadow-migration-production-lock",
  "worker-secret-unbound",
  "worker-heartbeat-global-view",
  "sftp-backup-unbounded-read",
  "backup-volume-unbounded-retention",
  "execute-queue-unbounded-admission",
  "duplicate-action-idempotency",
  "client-session-history-unbounded-retention",
  "aruba-inventory-unbounded-retention",
  "aruba-malformed-poll-poisoning",
  "protected-interface-rename-bypass",
  "bootstrap-recovery-cidr-broadening",
  "bootstrap-router-user-clobber",
  "false-success-reconciliation",
]);

const CANONICAL_RUNTIME_POLICY = new Map(
  CANONICAL_FINDING_SLUGS.map((slug) => [slug, { requiresRuntime: true }]),
);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedExecutables = new Set([
  "bun",
  "deno",
  "node",
  "npm",
  "npx",
  "pnpm",
  "psql",
  "yarn",
]);
const forbiddenCommandArguments = new Set([
  "--allow-no-tests",
  "--passWithNoTests",
  "--pass-with-no-tests",
  "--skip",
  "--todo",
]);
const secretKeyPattern = /(?:authorization|credential|password|secret|token)/i;

function regression(
  id,
  evidenceKind,
  path,
  command,
  exploitCaseId,
  legitimateControlCaseId,
) {
  return Object.freeze({
    id,
    evidenceKind,
    path,
    command: Object.freeze(command),
    exploitCaseId,
    legitimateControlCaseId,
  });
}

function finding(slug, regressions) {
  return Object.freeze({
    slug,
    regressions: Object.freeze(regressions),
  });
}

export const HARDENING_REGISTRY = Object.freeze({
  schemaVersion: 1,
  findings: Object.freeze([
    finding("ci-shadow-migration-production-lock", [
      regression(
        "disposable-target-runtime",
        "runtime",
        "scripts/__tests__/network-center-cross-tenant-target.test.mjs",
        ["node", "--test", "scripts/__tests__/network-center-cross-tenant-target.test.mjs"],
        "rejects production and unknown targets before database work",
        "accepts one unexpired per-run local Supabase identity",
      ),
    ]),
    finding("worker-secret-unbound", [
      regression(
        "edge-owned-worker-principal",
        "runtime",
        "supabase/functions/network-center-worker/index.test.ts",
        [
          "npx", "--yes", "deno", "test", "--config",
          "supabase/functions/network-center-worker/deno.json",
          "supabase/functions/network-center-worker/index.test.ts", "--allow-env",
        ],
        "spoofed workerId is rejected before any RPC",
        "credential digest reaches v2 RPC and Edge never supplies worker identity",
      ),
    ]),
    finding("worker-heartbeat-global-view", [
      regression(
        "tenant-heartbeat-projection-contract",
        "source-text",
        "src/lib/__tests__/networkCenterRealtimeExposureSafety.test.ts",
        ["npx", "vitest", "run", "src/lib/__tests__/networkCenterRealtimeExposureSafety.test.ts", "--reporter=verbose"],
        "replaces fleet-global heartbeat exposure with an RLS-scoped building projection",
        "replaces fleet-global heartbeat exposure with an RLS-scoped building projection",
      ),
    ]),
    finding("sftp-backup-unbounded-read", [
      regression(
        "bounded-sftp-stream-runtime",
        "runtime",
        "infra/network-center-worker/test/boundedSftpRead.test.ts",
        ["npm", "--prefix", "infra/network-center-worker", "test", "--", "boundedSftpRead.test.ts", "--reporter=verbose"],
        "rejects limit plus one before concatenation and destroys the source",
        "accepts an export exactly at the byte limit and destroys the source",
      ),
    ]),
    finding("backup-volume-unbounded-retention", [
      regression(
        "backup-pressure-runtime",
        "runtime",
        "infra/network-center-worker/test/backupStore.test.ts",
        ["npm", "--prefix", "infra/network-center-worker", "test", "--", "backupStore.test.ts", "--reporter=verbose"],
        "reports soft/hard pressure and rejects before promotion when host reserve is unavailable",
        "promotes staged bytes at the exact free-space and hard-volume boundaries",
      ),
    ]),
    finding("execute-queue-unbounded-admission", [
      regression(
        "atomic-queue-budget-contract",
        "source-text",
        "src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts",
        ["npx", "vitest", "run", "src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts", "--reporter=verbose"],
        "serializes idempotency, semantic suppression, and all queue budgets before insert",
        "replays a committed request before mutable router eligibility is re-evaluated",
      ),
    ]),
    finding("duplicate-action-idempotency", [
      regression(
        "stable-browser-intent-runtime",
        "runtime",
        "src/lib/__tests__/networkCenterIntentRegistry.test.ts",
        ["npx", "vitest", "run", "src/lib/__tests__/networkCenterIntentRegistry.test.ts", "--reporter=verbose"],
        "keeps one idempotency key across close and reopen until terminal",
        "uses a new exact-request token when the reason changes",
      ),
    ]),
    finding("client-session-history-unbounded-retention", [
      regression(
        "client-history-retention-contract",
        "source-text",
        "src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts",
        ["npx", "vitest", "run", "src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts", "--reporter=verbose"],
        "bounds client history to 16 values and expires sessions in indexed tenant batches",
        "purges only terminal 180-day commands after an append-only sanitized summary",
      ),
    ]),
    finding("aruba-inventory-unbounded-retention", [
      regression(
        "aruba-lifecycle-contract",
        "source-text",
        "src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts",
        ["npx", "vitest", "run", "src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts", "--reporter=verbose"],
        "ages only discovery lifecycle state in bounded retention windows",
        "keeps Aruba unlimited while binding observations to stable router-scoped identity",
      ),
    ]),
    finding("aruba-malformed-poll-poisoning", [
      regression(
        "aruba-item-isolation-runtime",
        "runtime",
        "infra/network-center-worker/test/sshConnector.test.ts",
        ["npm", "--prefix", "infra/network-center-worker", "test", "--", "sshConnector.test.ts", "--reporter=verbose"],
        "quarantines only the malformed Aruba item and never returns its raw identity",
        "deduplicates Aruba aliases by serial first and hardware MAC second",
      ),
    ]),
    finding("protected-interface-rename-bypass", [
      regression(
        "immutable-interface-runtime",
        "runtime",
        "infra/network-center-worker/test/sshConnector.test.ts",
        ["npm", "--prefix", "infra/network-center-worker", "test", "--", "sshConnector.test.ts", "--reporter=verbose"],
        "rejects renamed ether1 even when its display role looks like access",
        "targets only one live enrolled access port with matching current and immutable names",
      ),
    ]),
    finding("bootstrap-recovery-cidr-broadening", [
      regression(
        "bootstrap-recovery-boundary-runtime",
        "runtime",
        "infra/network-center-worker/test/bootstrap.test.ts",
        ["npm", "--prefix", "infra/network-center-worker", "test", "--", "bootstrap.test.ts", "--reporter=verbose"],
        "rejects broad or non-private recovery and arbitrary managed identity",
        "accepts an explicit non-WAN ether10 recovery interface",
      ),
    ]),
    finding("bootstrap-router-user-clobber", [
      regression(
        "bootstrap-user-ownership-runtime",
        "runtime",
        "infra/network-center-worker/test/bootstrap.test.ts",
        ["npm", "--prefix", "infra/network-center-worker", "test", "--", "bootstrap.test.ts", "--reporter=verbose"],
        "guards ownership before mutation and rolls back only the exact marked user",
        "generates deterministic staged, lockdown, rollback, and VPS configs",
      ),
    ]),
    finding("false-success-reconciliation", [
      regression(
        "typed-reconciliation-runtime",
        "runtime",
        "infra/network-center-worker/test/reconciliation.test.ts",
        ["npm", "--prefix", "infra/network-center-worker", "test", "--", "test/reconciliation.test.ts", "--reporter=verbose"],
        "never maps generic reachable health to success or failure",
        "accepts an exact DNS command ACK and keeps ambiguous transport uncertain",
      ),
    ]),
  ]),
});

function addFailure(failures, code, details = {}) {
  failures.push({ code, ...details });
}

function isSafeRelativePath(path) {
  return typeof path === "string"
    && path.length > 0
    && !isAbsolute(path)
    && !path.split(/[\\/]+/).includes("..");
}

function commandReferencesPath(command, path) {
  const normalizedPath = path.replaceAll("\\", "/");
  const fileName = basename(path);
  return command.some((argument) => {
    const normalizedArgument = argument.replaceAll("\\", "/");
    return normalizedArgument === normalizedPath
      || normalizedArgument === fileName
      || normalizedPath.endsWith(`/${normalizedArgument}`);
  });
}

function validateCommand(command, path, failureContext, failures) {
  const failureCount = failures.length;
  if (!Array.isArray(command) || command.length === 0) {
    addFailure(failures, "REGRESSION_COMMAND_MISSING", failureContext);
    return false;
  }
  if (command.some((argument) => (
    typeof argument !== "string"
    || argument.length === 0
    || /[\r\n;&|<>]/.test(argument)
  ))) {
    addFailure(failures, "REGRESSION_COMMAND_UNSAFE", failureContext);
    return false;
  }
  if (!allowedExecutables.has(command[0].toLowerCase())) {
    addFailure(failures, "REGRESSION_COMMAND_NOT_EXECUTABLE", failureContext);
  }
  if (command.some((argument) => forbiddenCommandArguments.has(argument))) {
    addFailure(failures, "REGRESSION_COMMAND_SKIPS_FAILURES", failureContext);
  }
  if (!commandReferencesPath(command, path)) {
    addFailure(failures, "REGRESSION_COMMAND_OMITS_FILE", failureContext);
  }
  return failures.length === failureCount;
}

function literalValue(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return undefined;
}

function objectDisablesExecution(node) {
  if (!ts.isObjectLiteralExpression(node)) return false;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      continue;
    }
    const name = propertyName(property.name);
    if (!["ignore", "skip", "todo"].includes(name)) continue;
    if (ts.isShorthandPropertyAssignment(property)) return true;
    return property.initializer.kind !== ts.SyntaxKind.FalseKeyword;
  }
  return false;
}

function classifyCall(call, sourceFile) {
  const expression = call.expression.getText(sourceFile).replace(/\s+/g, "");
  const parts = expression.split(".");
  const last = parts.at(-1);
  const modifiers = new Set(["runIf", "skip", "skipIf", "todo"]);
  const modifier = modifiers.has(last) ? last : undefined;
  const base = modifier ? parts.at(-2) : last;
  const disabledByName = ["skip", "skipIf", "runIf", "todo"].includes(modifier)
    || ["xdescribe", "xit", "xsuite", "xtest"].includes(base);
  const disabledByOptions = call.arguments.some(objectDisablesExecution);

  if (["describe", "suite", "xdescribe", "xsuite"].includes(base)) {
    return { kind: "suite", disabled: disabledByName || disabledByOptions };
  }
  if (!["it", "test", "xit", "xtest"].includes(base)) return undefined;

  const firstArgument = call.arguments[0];
  let title = firstArgument ? literalValue(firstArgument) : undefined;
  if (!title && firstArgument && ts.isObjectLiteralExpression(firstArgument)) {
    const nameProperty = firstArgument.properties.find((property) => (
      ts.isPropertyAssignment(property) && propertyName(property.name) === "name"
    ));
    if (nameProperty && ts.isPropertyAssignment(nameProperty)) {
      title = literalValue(nameProperty.initializer);
    }
  }
  return {
    kind: "test",
    title,
    disabled: disabledByName || disabledByOptions,
  };
}

function analyzeCases(source, path) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".ts") || path.endsWith(".tsx")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS,
  );
  const cases = new Map();

  function visit(node, ancestorDisabled = false) {
    let descendantsDisabled = ancestorDisabled;
    if (ts.isCallExpression(node)) {
      const classification = classifyCall(node, sourceFile);
      if (classification?.kind === "suite") {
        descendantsDisabled ||= classification.disabled;
      } else if (classification?.kind === "test" && classification.title) {
        const records = cases.get(classification.title) ?? [];
        records.push({ skipped: ancestorDisabled || classification.disabled });
        cases.set(classification.title, records);
      }
    }
    ts.forEachChild(node, (child) => visit(child, descendantsDisabled));
  }

  visit(sourceFile);
  return cases;
}

function resolveCase(cases, caseId, missingCode, skippedCode, ambiguousCode, context, failures) {
  const records = cases.get(caseId) ?? [];
  if (records.length === 0) {
    addFailure(failures, missingCode, { ...context, caseId });
    return false;
  }
  if (records.length > 1) {
    addFailure(failures, ambiguousCode, { ...context, caseId });
    return false;
  }
  if (records[0].skipped) {
    addFailure(failures, skippedCode, { ...context, caseId });
    return false;
  }
  return true;
}

function windowsNpmSpawn(command) {
  if (process.platform !== "win32" || !["npm", "npx"].includes(command[0])) {
    return { executable: command[0], arguments: command.slice(1) };
  }
  const cliName = command[0] === "npm" ? "npm-cli.js" : "npx-cli.js";
  return {
    executable: process.execPath,
    arguments: [
      resolve(dirname(process.execPath), "node_modules/npm/bin", cliName),
      ...command.slice(1),
    ],
  };
}

function runCommand(command, { cwd, timeoutMs, maxOutputBytes }) {
  return new Promise((resolveResult) => {
    const { executable, arguments: spawnArguments } = windowsNpmSpawn(command);
    const environment = {
      ...process.env,
      CI: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    delete environment.NODE_TEST_CONTEXT;
    let child;
    try {
      child = spawn(executable, spawnArguments, {
        cwd,
        env: environment,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolveResult({ ok: false, spawnError: error?.code ?? "SPAWN_FAILED", stdout: "", stderr: "" });
      return;
    }

    const output = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let outputLimited = false;
    let spawnError;
    let timedOut = false;

    const collect = (streamName, chunk) => {
      const buffer = Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - sizes[streamName]);
      if (remaining > 0) output[streamName].push(buffer.subarray(0, remaining));
      sizes[streamName] += buffer.length;
      if (sizes[streamName] > maxOutputBytes && !outputLimited) {
        outputLimited = true;
        child.kill();
      }
    };

    child.stdout?.on("data", (chunk) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", (error) => { spawnError = error?.code ?? "SPAWN_FAILED"; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref();

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(output.stdout).toString("utf8");
      const stderr = Buffer.concat(output.stderr).toString("utf8");
      resolveResult({
        ok: !spawnError && !timedOut && !outputLimited && exitCode === 0,
        exitCode,
        signal,
        spawnError,
        timedOut,
        outputLimited,
        stdout,
        stderr,
      });
    });
  });
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

async function verifyRegression(regressionEntry, context, rootDir, failures) {
  const failureCount = failures.length;
  const failureContext = {
    slug: context.slug,
    regressionId: regressionEntry?.id,
  };
  if (!regressionEntry || typeof regressionEntry !== "object") {
    addFailure(failures, "REGRESSION_INVALID", { slug: context.slug });
    return undefined;
  }
  if (typeof regressionEntry.id !== "string" || regressionEntry.id.length === 0) {
    addFailure(failures, "REGRESSION_ID_MISSING", { slug: context.slug });
  }
  if (!["runtime", "source-text"].includes(regressionEntry.evidenceKind)) {
    addFailure(failures, "EVIDENCE_KIND_INVALID", failureContext);
  }
  if (!isSafeRelativePath(regressionEntry.path)) {
    addFailure(failures, "REGRESSION_PATH_INVALID", failureContext);
    return undefined;
  }

  const commandValid = validateCommand(
    regressionEntry.command,
    regressionEntry.path,
    failureContext,
    failures,
  );

  const absolutePath = resolve(rootDir, regressionEntry.path);
  const relativePath = relative(rootDir, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    addFailure(failures, "REGRESSION_PATH_OUTSIDE_ROOT", failureContext);
    return undefined;
  }

  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) throw new Error("not a file");
  } catch {
    addFailure(failures, "REGRESSION_FILE_MISSING", {
      ...failureContext,
      path: regressionEntry.path,
    });
    return undefined;
  }

  let source;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch {
    addFailure(failures, "REGRESSION_FILE_UNREADABLE", failureContext);
    return undefined;
  }

  const exploitCaseId = regressionEntry.exploitCaseId;
  const controlCaseId = regressionEntry.legitimateControlCaseId;
  if (typeof exploitCaseId !== "string" || exploitCaseId.trim().length === 0) {
    addFailure(failures, "EXPLOIT_CASE_MISSING", failureContext);
  }
  if (typeof controlCaseId !== "string" || controlCaseId.trim().length === 0) {
    addFailure(failures, "CONTROL_CASE_MISSING", failureContext);
  }
  if (exploitCaseId && controlCaseId && exploitCaseId === controlCaseId) {
    addFailure(failures, "CONTROL_CASE_NOT_INDEPENDENT", failureContext);
  }

  const cases = analyzeCases(source, regressionEntry.path);
  if (typeof exploitCaseId === "string" && exploitCaseId.length > 0) {
    resolveCase(
      cases, exploitCaseId,
      "EXPLOIT_CASE_MISSING", "EXPLOIT_CASE_SKIPPED", "EXPLOIT_CASE_AMBIGUOUS",
      failureContext, failures,
    );
  }
  if (typeof controlCaseId === "string" && controlCaseId.length > 0) {
    resolveCase(
      cases, controlCaseId,
      "CONTROL_CASE_MISSING", "CONTROL_CASE_SKIPPED", "CONTROL_CASE_AMBIGUOUS",
      failureContext, failures,
    );
  }

  if (!commandValid) return undefined;
  return {
    ...failureContext,
    command: regressionEntry.command,
    commandKey: JSON.stringify(regressionEntry.command),
    evidenceKind: regressionEntry.evidenceKind,
    exploitCaseId,
    controlCaseId,
    staticValid: failures.length === failureCount,
    executionValid: false,
  };
}

export async function verifyHardeningRegistry(registry, {
  rootDir = repositoryRoot,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  maxCommandOutputBytes = DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
} = {}) {
  const failures = [];
  const findings = Array.isArray(registry?.findings) ? registry.findings : [];
  if (registry?.schemaVersion !== 1) {
    addFailure(failures, "REGISTRY_SCHEMA_VERSION_INVALID");
  }
  if (!Array.isArray(registry?.findings)) {
    addFailure(failures, "REGISTRY_FINDINGS_MISSING");
  }

  const counts = new Map();
  const verifiedRegressions = [];
  for (const findingEntry of findings) {
    const slug = findingEntry?.slug;
    if (typeof slug !== "string" || slug.length === 0) {
      addFailure(failures, "FINDING_SLUG_MISSING");
      continue;
    }
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
    if (!CANONICAL_FINDING_SLUGS.includes(slug)) {
      addFailure(failures, "UNEXPECTED_FINDING_SLUG", { slug });
    }
  }

  for (const slug of CANONICAL_FINDING_SLUGS) {
    const count = counts.get(slug) ?? 0;
    if (count === 0) addFailure(failures, "MISSING_CANONICAL_FINDING", { slug });
    if (count > 1) addFailure(failures, "DUPLICATE_FINDING_SLUG", { slug });
  }

  for (const findingEntry of findings) {
    if (!findingEntry || typeof findingEntry !== "object") continue;
    const { slug } = findingEntry;
    const regressions = Array.isArray(findingEntry.regressions)
      ? findingEntry.regressions
      : [];
    if (regressions.length === 0) {
      addFailure(failures, "REGRESSION_MISSING", { slug });
      continue;
    }
    const regressionIds = new Set();
    for (const regressionEntry of regressions) {
      if (regressionIds.has(regressionEntry?.id)) {
        addFailure(failures, "DUPLICATE_REGRESSION_ID", {
          slug,
          regressionId: regressionEntry?.id,
        });
      }
      regressionIds.add(regressionEntry?.id);
      const verified = await verifyRegression(
        regressionEntry,
        findingEntry,
        rootDir,
        failures,
      );
      if (verified) verifiedRegressions.push(verified);
    }
  }

  const commandResults = new Map();
  for (const regressionEntry of verifiedRegressions) {
    if (commandResults.has(regressionEntry.commandKey)) continue;
    const result = await runCommand(regressionEntry.command, {
      cwd: rootDir,
      timeoutMs: commandTimeoutMs,
      maxOutputBytes: maxCommandOutputBytes,
    });
    commandResults.set(regressionEntry.commandKey, result);
    const commandContext = {
      slug: regressionEntry.slug,
      regressionId: regressionEntry.regressionId,
    };
    if (result.spawnError) {
      addFailure(failures, "REGRESSION_COMMAND_SPAWN_FAILED", {
        ...commandContext,
        reason: result.spawnError,
      });
    } else if (result.outputLimited) {
      addFailure(failures, "REGRESSION_COMMAND_OUTPUT_LIMIT", commandContext);
    } else if (result.timedOut) {
      addFailure(failures, "REGRESSION_COMMAND_TIMEOUT", commandContext);
    } else if (result.exitCode !== 0) {
      addFailure(failures, "REGRESSION_COMMAND_FAILED", {
        ...commandContext,
        exitCode: result.exitCode,
        signal: result.signal,
      });
    }
  }

  for (const regressionEntry of verifiedRegressions) {
    const result = commandResults.get(regressionEntry.commandKey);
    if (!result?.ok) continue;
    const evidence = stripAnsi(`${result.stdout}\n${result.stderr}`);
    const exploitResolved = evidence.includes(regressionEntry.exploitCaseId);
    const controlResolved = evidence.includes(regressionEntry.controlCaseId);
    if (!exploitResolved) {
      addFailure(failures, "EXPLOIT_CASE_EVIDENCE_MISSING", {
        slug: regressionEntry.slug,
        regressionId: regressionEntry.regressionId,
      });
    }
    if (!controlResolved) {
      addFailure(failures, "CONTROL_CASE_EVIDENCE_MISSING", {
        slug: regressionEntry.slug,
        regressionId: regressionEntry.regressionId,
      });
    }
    regressionEntry.executionValid = exploitResolved && controlResolved;
  }

  const runtimeVerifiedSlugs = new Set();
  for (const slug of CANONICAL_FINDING_SLUGS) {
    const policy = CANONICAL_RUNTIME_POLICY.get(slug);
    if (!policy?.requiresRuntime) continue;
    const runtimeVerified = verifiedRegressions.some((entry) => (
      entry.slug === slug
      && entry.evidenceKind === "runtime"
      && entry.staticValid
      && entry.executionValid
    ));
    if (runtimeVerified) {
      runtimeVerifiedSlugs.add(slug);
    } else if (counts.get(slug) === 1) {
      addFailure(failures, "RUNTIME_WRAPPER_MISSING", { slug });
    }
  }

  const uniqueCanonicalFindings = CANONICAL_FINDING_SLUGS.filter(
    (slug) => counts.get(slug) === 1,
  ).length;
  return {
    ok: failures.length === 0,
    failures,
    summary: {
      canonicalFindings: CANONICAL_FINDING_SLUGS.length,
      findingsVerified: Math.min(uniqueCanonicalFindings, runtimeVerifiedSlugs.size),
      regressionsChecked: findings.reduce(
        (total, entry) => total + (Array.isArray(entry?.regressions) ? entry.regressions.length : 0),
        0,
      ),
      commandsExecuted: commandResults.size,
    },
  };
}

function sanitizeEvidence(value, key = "", depth = 0) {
  if (secretKeyPattern.test(key)) return "[REDACTED]";
  if (depth >= 6) return "[TRUNCATED]";
  if (typeof value === "string") {
    return value.length <= 512 ? value : `${value.slice(0, 509)}...`;
  }
  if (Array.isArray(value)) {
    const output = value.slice(0, 32).map((item) => sanitizeEvidence(item, "", depth + 1));
    if (value.length > 32) output.push(`[TRUNCATED ${value.length - 32} ITEMS]`);
    return output;
  }
  if (value && typeof value === "object") {
    const output = {};
    const entries = Object.entries(value);
    for (const [entryKey, entryValue] of entries.slice(0, 64)) {
      output[entryKey] = sanitizeEvidence(entryValue, entryKey, depth + 1);
    }
    if (entries.length > 64) output.truncatedKeys = entries.length - 64;
    return output;
  }
  return value;
}

export function formatEvidenceJson(value) {
  const sanitized = sanitizeEvidence(value);
  let json = JSON.stringify(sanitized);
  if (Buffer.byteLength(json, "utf8") <= MAX_EVIDENCE_BYTES) return json;

  json = JSON.stringify({
    ok: sanitized?.ok ?? false,
    status: sanitized?.status ?? "FAIL",
    summary: sanitized?.summary ?? {},
    failures: Array.isArray(sanitized?.failures)
      ? sanitized.failures.slice(0, 8)
      : [],
    truncated: true,
  });
  return Buffer.byteLength(json, "utf8") <= MAX_EVIDENCE_BYTES
    ? json
    : JSON.stringify({ ok: false, status: "FAIL", truncated: true });
}

function parseArguments(argv) {
  const options = { rootDir: repositoryRoot, registryPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root" && argv[index + 1]) {
      options.rootDir = resolve(argv[index + 1]);
      index += 1;
    } else if (argument === "--registry" && argv[index + 1]) {
      options.registryPath = resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new Error("Unsupported or incomplete verifier argument");
    }
  }
  return options;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const registry = options.registryPath
      ? JSON.parse(await readFile(options.registryPath, "utf8"))
      : HARDENING_REGISTRY;
    const result = await verifyHardeningRegistry(registry, {
      rootDir: options.rootDir,
    });
    const evidence = {
      status: result.ok ? "PASS" : "FAIL",
      ...result,
    };
    process.stdout.write(`${formatEvidenceJson(evidence)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${formatEvidenceJson({
      status: "FAIL",
      ok: false,
      failures: [{
        code: "VERIFIER_EXECUTION_FAILED",
        message: error instanceof Error ? error.message : "Unknown verifier failure",
      }],
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
