import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import ts from "typescript";

const ALWAYS_FORBIDDEN = [
  { rule: "legacy-chat-zalo-path", pattern: /chat-zalo/gi },
  { rule: "legacy-use-zalo-chat", pattern: /useZaloChat/gi },
  { rule: "legacy-zalo-identifier", pattern: /\bzalo_[a-z0-9_]+\b/gi },
  { rule: "legacy-worker-path", pattern: /\bworker[\\/]/gi },
];

const RESTRICTED_PACKAGE = [
  { rule: "direct-zalouser-package", pattern: /@openclaw[\\/]zalouser\b/gi },
];

const RAW_RESTRICTED_FALLBACK = [
  {
    rule: "stock-generic-send",
    pattern: /\bopenclaw(?:\s+|[./:-])(?:message\s+)?send\b/gi,
  },
];

const CODE_SCRIPT_KINDS = new Map([
  [".js", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
  [".ts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".json", ts.ScriptKind.JSON],
  [".jsonc", ts.ScriptKind.JSON],
]);

const GENERIC_RPC_CALLEES = new Set(["call", "invoke", "request", "rpc"]);
const GENERIC_RPC_KEYS = new Set(["method", "rpcname", "rpcmethod"]);
const DIRECT_DELIVERY_METHODS = new Set([
  "sendText",
  "sendMedia",
  "sendLink",
  "sendReaction",
  "deliver",
]);
const TOOL_DELIVERY_VERBS = new Set([
  "send",
  "deliver",
  "sendText",
  "sendMedia",
  "sendLink",
  "sendReaction",
  "business-send",
  "business_send",
]);

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

const KNOWN_BINARY_EXTENSIONS = new Set([
  ".db",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".sqlite",
  ".tar",
  ".tgz",
  ".wasm",
  ".webp",
  ".zip",
]);

function normalizePath(path) {
  return path.split(sep).join("/");
}

function compareCodePointStrings(left, right) {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalizeEscapedAscii(source) {
  return source.replace(
    /\\\/|\\x([0-9a-f]{2})|\\u([0-9a-f]{4})|\\u\{([0-9a-f]{1,6})\}/gi,
    (match, hexByte, hexWord, hexCodePoint) => {
      if (match === "\\/") return "/";
      const value = Number.parseInt(hexByte ?? hexWord ?? hexCodePoint, 16);
      return value <= 0x7f ? String.fromCodePoint(value) : match;
    },
  );
}

function pathError(action, path, error) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`OpenClaw isolation ${action} failed for ${path}: ${message}`, {
    cause: error,
  });
}

function lstatOptional(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw pathError("lstat", path, error);
  }
}

function readDirectory(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    throw pathError("readdir", path, error);
  }
}

function isSkippedPath(root, path, name) {
  if (SKIPPED_DIRECTORY_NAMES.has(name)) return true;
  const relativePath = normalizePath(relative(root, path));
  return (
    SKIPPED_FILES.has(relativePath) ||
    SKIPPED_DIRECTORY_PATHS.some(
      (skippedPath) =>
        relativePath === skippedPath || relativePath.startsWith(`${skippedPath}/`),
    )
  );
}

function addFilesystemFinding(root, path, match, findings) {
  pushFinding(findings, {
    file: normalizePath(relative(root, path)),
    line: 1,
    column: 1,
    rule: "unsafe-openclaw-filesystem-entry",
    match,
  });
}

function inspectEntry(root, path, findings) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw pathError("lstat", path, error);
  }
  if (stats.isSymbolicLink()) {
    addFilesystemFinding(root, path, "symbolic-link-or-junction", findings);
    return null;
  }
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  addFilesystemFinding(root, path, "unknown-filesystem-entry", findings);
  return null;
}

function isOptionalRealDirectory(root, path, findings) {
  const stats = lstatOptional(path);
  if (stats === null) return false;
  if (stats.isSymbolicLink()) {
    addFilesystemFinding(root, path, "symbolic-link-or-junction", findings);
    return false;
  }
  if (!stats.isDirectory()) {
    addFilesystemFinding(root, path, "scope-is-not-directory", findings);
    return false;
  }
  return true;
}

function walkFiles(root, directory, files, findings) {
  const entries = readDirectory(directory).sort((left, right) =>
    compareCodePointStrings(left.name, right.name),
  );

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (isSkippedPath(root, path, entry.name)) continue;
    const type = inspectEntry(root, path, findings);
    if (type === "directory") walkFiles(root, path, files, findings);
    else if (type === "file") files.add(resolve(path));
  }
}

function findNamedDirectories(root, directory, name, directories, findings) {
  if (!isOptionalRealDirectory(root, directory, findings)) return;

  for (const entry of readDirectory(directory)) {
    if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;

    const path = join(directory, entry.name);
    if (entry.name === name) {
      const type = inspectEntry(root, path, findings);
      if (type === "directory") directories.add(resolve(path));
    } else if (entry.isSymbolicLink()) {
      addFilesystemFinding(root, path, "symbolic-link-or-junction", findings);
    } else if (entry.isDirectory()) {
      findNamedDirectories(root, path, name, directories, findings);
    }
  }
}

function addDirectScopeDirectories(root, parent, predicate, directories, findings) {
  if (!isOptionalRealDirectory(root, parent, findings)) return false;

  for (const entry of readDirectory(parent)) {
    if (!predicate(entry.name)) continue;
    const path = join(parent, entry.name);
    const type = inspectEntry(root, path, findings);
    if (type === "directory") directories.add(resolve(path));
  }
  return true;
}

function addExactScopeDirectory(root, path, directories, findings) {
  const stats = lstatOptional(path);
  if (stats === null) return;
  if (stats.isSymbolicLink()) {
    addFilesystemFinding(root, path, "symbolic-link-or-junction", findings);
  } else if (stats.isDirectory()) {
    directories.add(resolve(path));
  } else {
    addFilesystemFinding(root, path, "scope-is-not-directory", findings);
  }
}

function collectScopeRoots(root, findings) {
  const directories = new Set();
  findNamedDirectories(root, join(root, "src"), "openclaw-zalo", directories, findings);
  addDirectScopeDirectories(
    root,
    join(root, "services"),
    (name) => name === "openclaw-egress-broker" || name.startsWith("openclaw-zalo-"),
    directories,
    findings,
  );
  addDirectScopeDirectories(
    root,
    join(root, "infra"),
    (name) => name.startsWith("openclaw-"),
    directories,
    findings,
  );
  if (isOptionalRealDirectory(root, join(root, "contracts"), findings)) {
    addExactScopeDirectory(root, join(root, "contracts", "openclaw-zalo"), directories, findings);
  }
  if (isOptionalRealDirectory(root, join(root, "supabase"), findings)) {
    const functions = join(root, "supabase", "functions");
    if (
      addDirectScopeDirectories(
        root,
        functions,
        (name) => name.startsWith("openclaw-"),
        directories,
        findings,
      ) &&
      isOptionalRealDirectory(root, join(functions, "_shared"), findings)
    ) {
      addExactScopeDirectory(root, join(functions, "_shared", "openclaw"), directories, findings);
    }
  }

  return [...directories].sort(compareCodePointStrings);
}

function collectOpenClawFiles(root, findings) {
  const files = new Set();
  for (const directory of collectScopeRoots(root, findings)) {
    walkFiles(root, directory, files, findings);
  }

  const migrations = join(root, "supabase", "migrations");
  if (
    isOptionalRealDirectory(root, join(root, "supabase"), findings) &&
    isOptionalRealDirectory(root, migrations, findings)
  ) {
    for (const entry of readDirectory(migrations)) {
      if (!/openclaw/i.test(entry.name) || !entry.name.endsWith(".sql")) continue;
      const path = join(migrations, entry.name);
      const type = inspectEntry(root, path, findings);
      if (type === "file") files.add(resolve(path));
    }
  }

  return [...files].sort(compareCodePointStrings);
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

function pushFinding(findings, finding) {
  if (
    findings.some(
      (existing) =>
        existing.file === finding.file &&
        existing.line === finding.line &&
        existing.rule === finding.rule &&
        existing.match === finding.match,
    )
  ) {
    return;
  }
  findings.push(finding);
}

function scanPatterns(source, relativePath, patterns, findings) {
  for (const { rule, pattern } of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const { line, column } = locateMatch(source, match.index);
      pushFinding(findings, { file: relativePath, line, column, rule, match: match[0] });
    }
  }
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isPartiallyEmittedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function getStaticString(node) {
  if (!node) return null;
  const expression = unwrapExpression(node);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = getStaticString(expression.left);
    const right = getStaticString(expression.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function isStaticStringWrapper(node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isPartiallyEmittedExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
  );
}

function getTerminalName(node) {
  if (!node) return null;
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression) || ts.isPrivateIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) return getStaticString(expression.argumentExpression);
  return null;
}

function getReceiverName(callee) {
  const expression = unwrapExpression(callee);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return getTerminalName(expression.expression);
  }
  return null;
}

function getPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return getStaticString(name.expression);
  return null;
}

function getAssignmentKey(node) {
  const target = unwrapExpression(node);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target)) return getStaticString(target.argumentExpression);
  return null;
}

function addNodeFinding(sourceFile, node, relativePath, rule, match, findings) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  pushFinding(findings, {
    file: relativePath,
    line: position.line + 1,
    column: position.character + 1,
    rule,
    match,
  });
}

function scanDecodedLegacyValue(sourceFile, node, value, relativePath, findings) {
  for (const { rule, pattern } of ALWAYS_FORBIDDEN) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      addNodeFinding(sourceFile, node, relativePath, rule, match[0], findings);
    }
  }
}

function scanCodeSemantics(source, relativePath, approvedDeliveryPath, findings) {
  const scriptKind = CODE_SCRIPT_KINDS.get(extname(relativePath).toLowerCase());
  if (scriptKind === undefined) return false;

  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
  for (const diagnostic of parseDiagnostics) {
    const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    pushFinding(findings, {
      file: relativePath,
      line: position.line + 1,
      column: position.character + 1,
      rule: "unscannable-openclaw-source",
      match: `parse-error: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    });
  }

  function visit(node) {
    const staticValue = getStaticString(node);
    if (staticValue !== null && (!node.parent || !isStaticStringWrapper(node.parent))) {
      scanDecodedLegacyValue(sourceFile, node, staticValue, relativePath, findings);
      if (!approvedDeliveryPath && staticValue.includes("@openclaw/zalouser")) {
        addNodeFinding(
          sourceFile,
          node,
          relativePath,
          "direct-zalouser-package",
          "@openclaw/zalouser",
          findings,
        );
      }
    } else if (ts.isIdentifier(node)) {
      scanDecodedLegacyValue(sourceFile, node, node.text, relativePath, findings);
    }

    if (!approvedDeliveryPath && ts.isCallExpression(node)) {
      const calleeName = getTerminalName(node.expression);
      const receiverName = getReceiverName(node.expression);
      const firstArgument = getStaticString(node.arguments[0]);

      if (GENERIC_RPC_CALLEES.has(calleeName) && firstArgument === "send") {
        addNodeFinding(
          sourceFile,
          node.expression,
          relativePath,
          "stock-generic-send",
          `${calleeName}("send")`,
          findings,
        );
      }

      if (
        DIRECT_DELIVERY_METHODS.has(calleeName) ||
        (calleeName === "send" && /(?:adapter|sender|provider|channel)$/i.test(receiverName ?? "")) ||
        (calleeName === "execute" &&
          /tool$/i.test(receiverName ?? "") &&
          TOOL_DELIVERY_VERBS.has(firstArgument))
      ) {
        addNodeFinding(
          sourceFile,
          node.expression,
          relativePath,
          "direct-adapter-tool-delivery",
          calleeName,
          findings,
        );
      }
    }

    if (!approvedDeliveryPath && ts.isPropertyAssignment(node)) {
      const key = getPropertyName(node.name)?.toLowerCase();
      if (GENERIC_RPC_KEYS.has(key) && getStaticString(node.initializer) === "send") {
        addNodeFinding(
          sourceFile,
          node,
          relativePath,
          "stock-generic-send",
          `${key}: send`,
          findings,
        );
      }
    }

    if (
      !approvedDeliveryPath &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const key = getAssignmentKey(node.left)?.toLowerCase();
      if (GENERIC_RPC_KEYS.has(key) && getStaticString(node.right) === "send") {
        addNodeFinding(
          sourceFile,
          node,
          relativePath,
          "stock-generic-send",
          `${key} = send`,
          findings,
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return parseDiagnostics.length === 0;
}

function addUnscannableFinding(relativePath, match, findings) {
  pushFinding(findings, {
    file: relativePath,
    line: 1,
    column: 1,
    rule: "unscannable-openclaw-source",
    match,
  });
}

function readTextFile(path, relativePath, findings) {
  if (KNOWN_BINARY_EXTENSIONS.has(extname(relativePath).toLowerCase())) return null;

  let content;
  try {
    content = readFileSync(path);
  } catch (error) {
    throw pathError("read", path, error);
  }

  let source;
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    const bytes = content.subarray(2);
    if (bytes.length % 2 !== 0) {
      addUnscannableFinding(relativePath, "invalid-utf16le-byte-length", findings);
      return null;
    }
    try {
      source = new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
    } catch {
      addUnscannableFinding(relativePath, "invalid-utf16le-source", findings);
      return null;
    }
  } else if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
    const bytes = content.subarray(2);
    if (bytes.length % 2 !== 0) {
      addUnscannableFinding(relativePath, "invalid-utf16be-byte-length", findings);
      return null;
    }
    try {
      source = new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
    } catch {
      addUnscannableFinding(relativePath, "invalid-utf16be-source", findings);
      return null;
    }
  } else {
    if (content.includes(0)) {
      addUnscannableFinding(relativePath, "nul-byte-in-text-source", findings);
      return null;
    }
    const bytes =
      content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
        ? content.subarray(3)
        : content;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      addUnscannableFinding(relativePath, "unsupported-or-invalid-text-encoding", findings);
      return null;
    }
  }

  if (source.includes("\0")) {
    addUnscannableFinding(relativePath, "nul-character-in-text-source", findings);
    return null;
  }
  return source;
}

function validateRoot(root) {
  const stats = lstatOptional(root);
  if (stats === null) throw new Error(`OpenClaw isolation root does not exist: ${root}`);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`OpenClaw isolation root must be a real directory: ${root}`);
  }
}

export function scanOpenClawFiles(root = process.cwd()) {
  const absoluteRoot = resolve(root);
  const findings = [];
  validateRoot(absoluteRoot);

  for (const file of collectOpenClawFiles(absoluteRoot, findings)) {
    const relativePath = normalizePath(relative(absoluteRoot, file));
    if (SKIPPED_FILES.has(relativePath)) continue;

    scanPatterns(relativePath, relativePath, ALWAYS_FORBIDDEN, findings);
    const approvedDeliveryPath = isApprovedDeliveryPath(relativePath);
    if (!approvedDeliveryPath) {
      scanPatterns(relativePath, relativePath, RESTRICTED_PACKAGE, findings);
    }

    const source = readTextFile(file, relativePath, findings);
    if (source === null) continue;

    scanPatterns(source, relativePath, ALWAYS_FORBIDDEN, findings);
    const parsedAsCode = scanCodeSemantics(source, relativePath, approvedDeliveryPath, findings);
    if (!approvedDeliveryPath && !parsedAsCode) {
      const canonicalSource = canonicalizeEscapedAscii(source);
      scanPatterns(canonicalSource, relativePath, ALWAYS_FORBIDDEN, findings);
      scanPatterns(canonicalSource, relativePath, RESTRICTED_PACKAGE, findings);
      scanPatterns(canonicalSource, relativePath, RAW_RESTRICTED_FALLBACK, findings);
    }
  }

  return findings.sort(
    (left, right) =>
      compareCodePointStrings(left.file, right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      compareCodePointStrings(left.rule, right.rule) ||
      compareCodePointStrings(left.match, right.match),
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const findings = scanOpenClawFiles(process.argv[2] ?? process.cwd());
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
  } catch (error) {
    console.error(
      `OpenClaw isolation check error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
