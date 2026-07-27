import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ALWAYS_FORBIDDEN = [
  { rule: "legacy-chat-zalo-path", pattern: /chat-zalo/gi },
  { rule: "legacy-use-zalo-chat", pattern: /useZaloChat/gi },
  { rule: "legacy-zalo-identifier", pattern: /\bzalo_[a-z0-9_]+\b/gi },
  { rule: "legacy-worker-path", pattern: /\bworker[\\/]/gi },
];

const RESTRICTED_DELIVERY = [
  { rule: "direct-zalouser-package", pattern: /@openclaw[\\/]zalouser\b/gi },
  {
    rule: "stock-generic-send",
    pattern:
      /(?:\b(?:call|invoke|request|rpc)\s*\(\s*["']send["']|\b(?:method|rpc(?:Name|Method)?)\s*[:=]\s*["']send["']|\bopenclaw(?:\s+|[./:-])(?:message\s+)?send\b)/gi,
  },
  {
    rule: "direct-adapter-tool-delivery",
    pattern:
      /\b(?:[a-z0-9_]*(?:adapter|tool)|adapter|tool)\s*\.\s*(?:send|sendText|sendMedia|sendLink|sendReaction|deliver|execute)\s*\(/gi,
  },
];

const APPROVED_DELIVERY_PATHS = new Set([
  "services/openclaw-zalo-bridge/src/adapters/zalouser-bridge-rpc-adapter.ts",
  "services/openclaw-zalo-bridge/test/upstream-contract.test.ts",
  "services/openclaw-zalo-bridge/test/zalouser-bridge-rpc-adapter.test.ts",
]);

const SKIPPED_DIRECTORY_NAMES = new Set([".git", "dist", "node_modules"]);

const SKIPPED_DIRECTORY_PATHS = [
  "infra/openclaw-media-gateway/.wrangler",
  "infra/openclaw-zalo/rendered",
  "infra/openclaw-zalo/secrets",
  "services/openclaw-zalo-bridge/.data",
  "services/openclaw-zalo-bridge/coverage",
  "services/openclaw-zalo-cell/.release",
  "services/openclaw-zalo-cell/.state",
  "services/openclaw-zalo-cell/vendor/zalouser-bridge/.work",
];

const SKIPPED_FILES = new Set([
  "infra/openclaw-media-gateway/.dev.vars",
  "infra/openclaw-zalo/.env",
]);

function normalizePath(path) {
  return path.split(sep).join("/");
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isSkippedDirectory(root, path, name) {
  if (SKIPPED_DIRECTORY_NAMES.has(name)) return true;
  const relativePath = normalizePath(relative(root, path));
  return SKIPPED_DIRECTORY_PATHS.some(
    (skippedPath) => relativePath === skippedPath || relativePath.startsWith(`${skippedPath}/`),
  );
}

function walkFiles(root, directory, files) {
  if (!isDirectory(directory)) return;

  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!isSkippedDirectory(root, path, entry.name)) walkFiles(root, path, files);
    } else if (entry.isFile()) {
      files.add(resolve(path));
    }
  }
}

function findNamedDirectories(directory, name, directories) {
  if (!isDirectory(directory)) return;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;

    const path = join(directory, entry.name);
    if (entry.name === name) {
      directories.add(resolve(path));
    } else {
      findNamedDirectories(path, name, directories);
    }
  }
}

function collectScopeRoots(root) {
  const directories = new Set();
  findNamedDirectories(join(root, "src"), "openclaw-zalo", directories);

  const services = join(root, "services");
  if (isDirectory(services)) {
    for (const entry of readdirSync(services, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        (entry.name === "openclaw-egress-broker" || entry.name.startsWith("openclaw-zalo-"))
      ) {
        directories.add(resolve(services, entry.name));
      }
    }
  }

  const infra = join(root, "infra");
  if (isDirectory(infra)) {
    for (const entry of readdirSync(infra, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("openclaw-")) {
        directories.add(resolve(infra, entry.name));
      }
    }
  }

  const contracts = join(root, "contracts", "openclaw-zalo");
  if (isDirectory(contracts)) directories.add(resolve(contracts));

  const sharedEdge = join(root, "supabase", "functions", "_shared", "openclaw");
  if (isDirectory(sharedEdge)) directories.add(resolve(sharedEdge));

  const edgeFunctions = join(root, "supabase", "functions");
  if (isDirectory(edgeFunctions)) {
    for (const entry of readdirSync(edgeFunctions, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("openclaw-")) {
        directories.add(resolve(edgeFunctions, entry.name));
      }
    }
  }

  return [...directories].sort();
}

function collectOpenClawFiles(root) {
  const files = new Set();
  for (const directory of collectScopeRoots(root)) walkFiles(root, directory, files);

  const migrations = join(root, "supabase", "migrations");
  if (isDirectory(migrations)) {
    for (const entry of readdirSync(migrations, { withFileTypes: true })) {
      if (entry.isFile() && /openclaw/i.test(entry.name) && entry.name.endsWith(".sql")) {
        files.add(resolve(migrations, entry.name));
      }
    }
  }

  return [...files].sort();
}

function isApprovedDeliveryPath(relativePath) {
  return (
    relativePath.startsWith("services/openclaw-zalo-cell/") ||
    APPROVED_DELIVERY_PATHS.has(relativePath)
  );
}

function locateMatch(source, index) {
  const before = source.slice(0, index);
  const line = before.split(/\r?\n/).length;
  const previousLineBreak = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"));
  return { line, column: index - previousLineBreak };
}

function scanPatterns(source, relativePath, patterns, findings) {
  for (const { rule, pattern } of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const { line, column } = locateMatch(source, match.index);
      findings.push({ file: relativePath, line, column, rule, match: match[0] });
    }
  }
}

function readTextFile(path) {
  const content = readFileSync(path);
  if (content.includes(0)) return null;
  return content.toString("utf8");
}

export function scanOpenClawFiles(root = process.cwd()) {
  const absoluteRoot = resolve(root);
  const findings = [];

  for (const file of collectOpenClawFiles(absoluteRoot)) {
    const relativePath = normalizePath(relative(absoluteRoot, file));
    if (SKIPPED_FILES.has(relativePath) || !isFile(file)) continue;

    scanPatterns(relativePath, relativePath, ALWAYS_FORBIDDEN, findings);

    const source = readTextFile(file);
    if (source === null) continue;

    scanPatterns(source, relativePath, ALWAYS_FORBIDDEN, findings);
    if (!isApprovedDeliveryPath(relativePath)) {
      scanPatterns(source, relativePath, RESTRICTED_DELIVERY, findings);
    }
  }

  return findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.rule.localeCompare(right.rule),
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const findings = scanOpenClawFiles();
  if (findings.length === 0) {
    console.log("OpenClaw isolation check passed: 0 forbidden references.");
  } else {
    console.error(`OpenClaw isolation check failed: ${findings.length} forbidden reference(s).`);
    for (const finding of findings) {
      console.error(
        `${finding.file}:${finding.line}:${finding.column} [${finding.rule}] ${JSON.stringify(finding.match)}`,
      );
    }
    process.exitCode = 1;
  }
}
