import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import ts from "typescript";
import { prepareVendorTree } from "./prepare.mjs";

export const SOURCE_DATE_EPOCH = 1_785_062_400;
export const PACKAGE_NAME = "@openclaw/zalouser";
export const PACKAGE_VERSION = "2026.7.1";
export const PLUGIN_ID = "zalouser";

const ENTRY_POINTS = [
  "api",
  "behavior-contract-api",
  "channel-plugin-api",
  "contract-api",
  "doctor-contract-api",
  "index",
  "runtime-api",
  "secret-contract-api",
  "setup-entry",
  "setup-plugin-api",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertEpoch(value) {
  if (value !== SOURCE_DATE_EPOCH) throw new Error(`SOURCE_DATE_EPOCH must be ${SOURCE_DATE_EPOCH}`);
}

function assertPreparedRoot(vendorRoot, preparedRoot) {
  const workRoot = `${resolve(vendorRoot, ".work")}${sep}`;
  const resolved = resolve(preparedRoot);
  if (!resolved.startsWith(workRoot) || !/^prepared-[0-9a-f-]+$/.test(basename(resolved))) {
    throw new Error("build source must be a unique tree produced by scripts/prepare.mjs");
  }
  if (!statSync(resolved).isDirectory()) throw new Error("prepared source tree is not a directory");
  return resolved;
}

function safeOutput(root, path) {
  const output = resolve(root, path);
  if (output !== resolve(root) && !output.startsWith(`${resolve(root)}${sep}`)) {
    throw new Error(`output escapes root: ${path}`);
  }
  return output;
}

function atomicWrite(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, bytes, { flag: "wx" });
  renameSync(temporary, path);
}

function copyRegularFile(source, target) {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`non-regular build input: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function copyRegularTree(sourceRoot, outputRoot) {
  const walk = (sourceDirectory, relativeDirectory) => {
    const entries = readdirSync(sourceDirectory, { withFileTypes: true }).sort((left, right) =>
      utf8Compare(left.name, right.name),
    );
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const source = resolve(sourceDirectory, entry.name);
      const output = safeOutput(outputRoot, relativePath);
      if (entry.isSymbolicLink()) throw new Error(`symlink build input is forbidden: ${relativePath}`);
      if (entry.isDirectory()) {
        mkdirSync(output, { recursive: true });
        walk(source, relativePath);
      } else if (entry.isFile()) {
        copyRegularFile(source, output);
      } else {
        throw new Error(`non-regular build input is forbidden: ${relativePath}`);
      }
    }
  };
  mkdirSync(outputRoot, { recursive: true });
  walk(sourceRoot, "");
}

function normalizedMetafilePath(path) {
  return path.replaceAll("\\", "/");
}

function artifactOutputPath(path) {
  const normalized = normalizedMetafilePath(path);
  const marker = "/package/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex + 1);
  if (normalized.startsWith("package/")) return normalized;
  throw new Error(`esbuild output is outside the package root: ${path}`);
}

function outputGraph(metafile) {
  const graph = new Map();
  const entrypoints = new Map();
  for (const [rawPath, metadata] of Object.entries(metafile.outputs)) {
    const path = artifactOutputPath(rawPath);
    const imports = metadata.imports
      .filter(({ external }) => !external)
      .map(({ path: importedPath, kind }) => ({ path: artifactOutputPath(importedPath), kind }));
    graph.set(path, imports);
    if (metadata.entryPoint) {
      const entrypoint = normalizedMetafilePath(metadata.entryPoint);
      if (entrypoints.has(entrypoint)) throw new Error(`duplicate esbuild entrypoint output: ${entrypoint}`);
      entrypoints.set(entrypoint, path);
    }
  }
  for (const [path, imports] of graph) {
    for (const imported of imports) {
      if (!graph.has(imported.path)) throw new Error(`esbuild output ${path} imports unknown output ${imported.path}`);
    }
  }
  return { entrypoints, graph };
}

function outputClosure(graph, roots, includeDynamicImports) {
  const visited = new Set();
  const visit = (path) => {
    if (visited.has(path)) return;
    if (!graph.has(path)) throw new Error(`runtime closure root is not an esbuild output: ${path}`);
    visited.add(path);
    for (const imported of graph.get(path)) {
      if (includeDynamicImports || imported.kind !== "dynamic-import") visit(imported.path);
    }
  };
  for (const root of roots) visit(root);
  return [...visited].sort(utf8Compare);
}

function literalSpecifier(argument) {
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
  return null;
}

const FILESYSTEM_READ_CALLS = new Set([
  "access",
  "accessSync",
  "createReadStream",
  "existsSync",
  "lstat",
  "lstatSync",
  "open",
  "openSync",
  "readFile",
  "readFileSync",
  "stat",
  "statSync",
]);

const SOURCE_CODE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const OPTIONAL_EXTERNAL_REQUIRES = new Set(["bufferutil", "utf-8-validate"]);
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) => {
    const plain = name.startsWith("node:") ? name.slice("node:".length) : name;
    return [plain, `node:${plain}`];
  }),
);
const REVIEWED_EXTERNAL_RUNTIME_INPUTS = new Set(
  [
    ["node_modules/form-data/lib/form_data.js", "stat", "value.path", 2],
    ["node_modules/zca-js/dist/apis/changeAccountAvatar.js", "readFileSync", "avatarSource", 1],
    ["node_modules/zca-js/dist/apis/changeGroupAvatar.js", "readFileSync", "avatarSource", 1],
    ["node_modules/zca-js/dist/apis/sendMessage.js", "readFile", "source", 1],
    ["node_modules/zca-js/dist/apis/sendMessage.js", "readFile", "gif", 1],
    ["node_modules/zca-js/dist/apis/uploadAttachment.js", "existsSync", "source", 1],
    ["node_modules/zca-js/dist/apis/uploadAttachment.js", "readFile", "source", 1],
    ["node_modules/zca-js/dist/apis/uploadProductPhoto.js", "readFile", "payload.file", 1],
    ["node_modules/zca-js/dist/utils.js", "stat", "filePath", 1],
    ["node_modules/zca-js/dist/utils.js", "readFile", "source", 1],
    ["src/bridge/runtime-bootstrap.ts", "readFileSync", "BRIDGE_SECRET_FILE", 2],
    ["src/zalo-js.ts", "existsSync", "filePath", 1],
  ].map((record) => JSON.stringify(record)),
);

function calledIdentifier(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function scriptKindForPath(sourcePath) {
  const extension = sourcePath.slice(sourcePath.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".js":
    case ".cjs":
    case ".mjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function literalModuleSpecifier(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function bindNamedFunctions(name, namespaceSet, functionMap, namespaceKind) {
  if (ts.isIdentifier(name)) {
    namespaceSet.add(name.text);
    return;
  }
  if (!ts.isObjectBindingPattern(name)) return;
  for (const element of name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const imported = element.propertyName && ts.isIdentifier(element.propertyName)
      ? element.propertyName.text
      : element.name.text;
    if (namespaceKind === "fs" && imported === "promises") continue;
    if (FILESYSTEM_READ_CALLS.has(imported)) functionMap.set(element.name.text, imported);
  }
}

function requireCallSpecifier(node, requireIdentifiers) {
  if (
    !node ||
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    !requireIdentifiers.has(node.expression.text) ||
    node.arguments.length !== 1
  ) {
    return null;
  }
  return literalSpecifier(node.arguments[0]);
}

function collectRuntimeBindings(sourceFile, additionalRequireIdentifiers = []) {
  const requireIdentifiers = new Set(["require", ...additionalRequireIdentifiers]);
  const createRequireIdentifiers = new Set(["createRequire"]);
  const fsNamespaces = new Set();
  const fsPromiseNamespaces = new Set();
  const fsFunctions = new Map();

  const visitImports = (node) => {
    if (ts.isImportDeclaration(node)) {
      const moduleName = literalModuleSpecifier(node.moduleSpecifier);
      const clause = node.importClause;
      if (moduleName === "node:module" || moduleName === "module") {
        const named = clause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (imported === "createRequire") createRequireIdentifiers.add(element.name.text);
          }
        }
      }
      if (moduleName === "node:fs" || moduleName === "fs") {
        if (clause?.name) fsNamespaces.add(clause.name.text);
        const named = clause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) fsNamespaces.add(named.name.text);
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (imported === "promises") fsPromiseNamespaces.add(element.name.text);
            else if (FILESYSTEM_READ_CALLS.has(imported)) fsFunctions.set(element.name.text, imported);
          }
        }
      }
      if (moduleName === "node:fs/promises" || moduleName === "fs/promises") {
        if (clause?.name) fsPromiseNamespaces.add(clause.name.text);
        const named = clause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) fsPromiseNamespaces.add(named.name.text);
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (FILESYSTEM_READ_CALLS.has(imported)) fsFunctions.set(element.name.text, imported);
          }
        }
      }
    }
    ts.forEachChild(node, visitImports);
  };
  visitImports(sourceFile);

  const visitBindings = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        createRequireIdentifiers.has(node.initializer.expression.text)
      ) {
        if (ts.isIdentifier(node.name)) requireIdentifiers.add(node.name.text);
      }
      const required = requireCallSpecifier(node.initializer, requireIdentifiers);
      if (required === "node:fs" || required === "fs") {
        bindNamedFunctions(node.name, fsNamespaces, fsFunctions, "fs");
      } else if (required === "node:fs/promises" || required === "fs/promises") {
        bindNamedFunctions(node.name, fsPromiseNamespaces, fsFunctions, "fs-promises");
      } else if (
        ts.isPropertyAccessExpression(node.initializer) &&
        node.initializer.name.text === "promises" &&
        ["node:fs", "fs"].includes(requireCallSpecifier(node.initializer.expression, requireIdentifiers))
      ) {
        bindNamedFunctions(node.name, fsPromiseNamespaces, fsFunctions, "fs-promises");
      }
    }
    ts.forEachChild(node, visitBindings);
  };
  visitBindings(sourceFile);
  return { fsFunctions, fsNamespaces, fsPromiseNamespaces, requireIdentifiers };
}

function filesystemMethod(expression, bindings) {
  if (ts.isIdentifier(expression)) return bindings.fsFunctions.get(expression.text) ?? null;
  if (!ts.isPropertyAccessExpression(expression)) return null;
  const method = expression.name.text;
  if (!FILESYSTEM_READ_CALLS.has(method)) return null;
  if (ts.isIdentifier(expression.expression)) {
    if (
      bindings.fsNamespaces.has(expression.expression.text) ||
      bindings.fsPromiseNamespaces.has(expression.expression.text)
    ) {
      return method;
    }
  }
  if (
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "promises" &&
    ts.isIdentifier(expression.expression.expression) &&
    bindings.fsNamespaces.has(expression.expression.expression.text)
  ) {
    return method;
  }
  return null;
}

function sourceSite(sourceFile, sourcePath, node, values) {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    source: sourcePath,
    line: location.line + 1,
    column: location.character + 1,
    ...values,
  };
}

function externalRuntimeInputKey(sourcePath, method, node, sourceFile) {
  const firstArgument = node.arguments[0]?.getText(sourceFile) ?? "";
  return JSON.stringify([sourcePath, method, firstArgument, node.arguments.length]);
}

function compareRuntimeSites(left, right) {
  const bySource = utf8Compare(left.source, right.source);
  if (bySource !== 0) return bySource;
  if (left.line !== right.line) return left.line - right.line;
  if (left.column !== right.column) return left.column - right.column;
  const byOperation = utf8Compare(left.operation, right.operation);
  if (byOperation !== 0) return byOperation;
  return utf8Compare(left.surface ?? left.expression, right.surface ?? right.expression);
}

export function analyzeEmittedRuntimeSites(packageRoot, runtimeMembers) {
  const runtimeSet = new Set(runtimeMembers);
  const sites = [];
  for (const artifactPath of [...runtimeMembers].sort(utf8Compare)) {
    if (!artifactPath.startsWith("package/dist/") || !artifactPath.endsWith(".js")) {
      throw new Error(`emitted runtime member is invalid: ${artifactPath}`);
    }
    const relativePath = artifactPath.slice("package/".length);
    const absolutePath = resolve(packageRoot, relativePath);
    const sourceText = readFileSync(absolutePath, "utf8");
    const sourceFile = ts.createSourceFile(
      artifactPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const emittedRequireIdentifiers = new Set();
    const discoverEmittedRequires = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        /^__require\d*$/u.test(node.expression.text)
      ) {
        emittedRequireIdentifiers.add(node.expression.text);
      }
      ts.forEachChild(node, discoverEmittedRequires);
    };
    discoverEmittedRequires(sourceFile);
    const bindings = collectRuntimeBindings(sourceFile, emittedRequireIdentifiers);
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = node.arguments.length === 1 ? literalSpecifier(node.arguments[0]) : null;
        if (specifier === null || !specifier.startsWith(".")) {
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          throw new Error(`unclassified emitted dynamic import at ${artifactPath}:${location.line + 1}`);
        }
        const targetAbsolute = resolve(dirname(absolutePath), specifier);
        const targetRelative = normalizedMetafilePath(relative(packageRoot, targetAbsolute));
        const targetArtifactPath = `package/${targetRelative}`;
        if (!runtimeSet.has(targetArtifactPath)) {
          throw new Error(`emitted dynamic import escapes the runtime set: ${artifactPath} -> ${specifier}`);
        }
        sites.push(sourceSite(sourceFile, artifactPath, node, {
          operation: "dynamic-import",
          expression: node.arguments[0].getText(sourceFile),
          classification: "artifact-members",
          resolution: "literal",
          specifier,
          resolvedTarget: targetArtifactPath,
          expandedMembers: [targetArtifactPath],
        }));
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        emittedRequireIdentifiers.has(node.expression.text)
      ) {
        const specifier = node.arguments.length === 1 ? literalSpecifier(node.arguments[0]) : null;
        if (specifier === null) {
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          throw new Error(`unclassified emitted require at ${artifactPath}:${location.line + 1}`);
        }
        let classification;
        let resolution = "literal";
        let resolvedTarget;
        if (NODE_BUILTINS.has(specifier)) {
          classification = "node-builtin";
          const plain = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
          resolvedTarget = `node:${plain}`;
        } else if (OPTIONAL_EXTERNAL_REQUIRES.has(specifier)) {
          classification = "optional-external";
          resolution = "reviewed-finite";
          resolvedTarget = specifier;
        } else {
          throw new Error(`unclassified emitted external require: ${artifactPath} -> ${specifier}`);
        }
        sites.push(sourceSite(sourceFile, artifactPath, node, {
          operation: "require",
          expression: node.arguments[0].getText(sourceFile),
          classification,
          resolution,
          specifier,
          resolvedTarget,
          expandedMembers: [],
        }));
      } else if (ts.isCallExpression(node)) {
        const method = filesystemMethod(node.expression, bindings);
        if (method) {
          sites.push(sourceSite(sourceFile, artifactPath, node, {
            operation: "filesystem-read",
            expression: node.getText(sourceFile),
            classification: "external-runtime-input",
            resolution: "reviewed-finite",
            expandedMembers: [],
          }));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return sites.sort(compareRuntimeSites);
}

function isImportMetaResolve(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "resolve" &&
    ts.isMetaProperty(expression.expression) &&
    expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    expression.expression.name.text === "meta"
  );
}

export function createMetafileImportClaims(imports, sourcePath) {
  if (!Array.isArray(imports) || typeof sourcePath !== "string" || !sourcePath) {
    throw new TypeError("metafile import claims require an import array and source path");
  }
  const relevant = imports
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => ["dynamic-import", "require-call"].includes(record?.kind));
  const claimed = new Set();
  return Object.freeze({
    claim(predicate, label) {
      if (typeof predicate !== "function" || typeof label !== "string" || !label) {
        throw new TypeError("metafile import claim requires a predicate and label");
      }
      const match = relevant.find(({ record, index }) => !claimed.has(index) && predicate(record));
      if (!match) throw new Error(`metafile import claim is absent or already claimed: ${sourcePath} -> ${label}`);
      claimed.add(match.index);
      return match.record;
    },
    assertExhausted() {
      const unconsumed = relevant.filter(({ index }) => !claimed.has(index));
      if (unconsumed.length > 0) {
        const details = unconsumed.map(({ record }) => `${record.kind}:${record.original ?? record.path}`).join(", ");
        throw new Error(`unconsumed metafile runtime imports at ${sourcePath}: ${details}`);
      }
    },
  });
}

function runtimeReachabilityAnalysis(preparedRoot, metafile) {
  const { entrypoints, graph } = outputGraph(metafile);
  const publicRoots = ENTRY_POINTS.map((name) => {
    const entrypoint = `${name}.ts`;
    const output = entrypoints.get(entrypoint);
    if (!output) throw new Error(`public runtime entrypoint has no esbuild output: ${entrypoint}`);
    return output;
  });
  const sites = [];
  const inputMetadata = new Map(
    Object.entries(metafile.inputs).map(([path, metadata]) => [normalizedMetafilePath(path), metadata]),
  );
  const runtimeSourceInputs = [...inputMetadata.keys()]
    .filter((path) => SOURCE_CODE_EXTENSIONS.has(path.slice(path.lastIndexOf(".")).toLowerCase()))
    .sort(utf8Compare);
  const reviewedExternalInputsSeen = new Set();
  for (const sourcePath of runtimeSourceInputs) {
    const absoluteSource = resolve(preparedRoot, sourcePath);
    const preparedPrefix = `${resolve(preparedRoot)}${sep}`;
    if (!absoluteSource.startsWith(preparedPrefix) || !existsSync(absoluteSource)) {
      throw new Error(`esbuild runtime input is not a regular prepared source: ${sourcePath}`);
    }
    const sourceText = readFileSync(absoluteSource, "utf8");
    const sourceFile = ts.createSourceFile(
      sourcePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForPath(sourcePath),
    );
    const bindings = collectRuntimeBindings(sourceFile);
    const metadata = inputMetadata.get(sourcePath);
    const importClaims = createMetafileImportClaims(metadata?.imports ?? [], sourcePath);
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length !== 1) {
          throw new Error(`unclassified dynamic resolution at ${sourcePath}`);
        }
        const specifier = literalSpecifier(node.arguments[0]);
        if (specifier === null) {
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          throw new Error(`unclassified non-finite dynamic resolution at ${sourcePath}:${location.line + 1}`);
        }
        const inputImport = importClaims.claim(
          ({ kind, original }) => kind === "dynamic-import" && original === specifier,
          `dynamic-import:${specifier}`,
        );
        if (!inputImport || inputImport.external) {
          throw new Error(`dynamic resolution is absent from the esbuild graph: ${sourcePath} -> ${specifier}`);
        }
        const targetEntrypoint = normalizedMetafilePath(inputImport.path);
        const targetOutput = entrypoints.get(targetEntrypoint);
        if (!targetOutput) {
          throw new Error(`dynamic resolution has no finite esbuild output: ${sourcePath} -> ${specifier}`);
        }
        sites.push(sourceSite(sourceFile, sourcePath, node, {
          operation: "dynamic-import",
          expression: node.arguments[0].getText(sourceFile),
          classification: "artifact-members",
          resolution: "literal",
          specifier,
          resolvedTarget: targetEntrypoint,
          expandedMembers: outputClosure(graph, [targetOutput], false),
        }));
      } else if (ts.isCallExpression(node) && isImportMetaResolve(node.expression)) {
        const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        throw new Error(`unclassified import.meta.resolve site at ${sourcePath}:${location.line + 1}`);
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        !["createRequire"].includes(node.expression.text) &&
        bindings.requireIdentifiers.has(node.expression.text)
      ) {
        const specifier = node.arguments.length === 1 ? literalSpecifier(node.arguments[0]) : null;
        if (specifier === null) {
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          throw new Error(`unclassified non-finite require site at ${sourcePath}:${location.line + 1}`);
        }
        const inputImport = importClaims.claim(
          ({ kind, original, path, external }) =>
            kind === "require-call" && (external ? path === specifier : original === specifier),
          `require-call:${specifier}`,
        );
        if (!inputImport) {
          throw new Error(`require site is absent from the esbuild graph: ${sourcePath} -> ${specifier}`);
        }
        let classification;
        let resolution = "literal";
        let resolvedTarget = normalizedMetafilePath(inputImport.path);
        if (!inputImport.external) classification = "bundled-static";
        else if (NODE_BUILTINS.has(specifier) && NODE_BUILTINS.has(inputImport.path)) {
          classification = "node-builtin";
          const plain = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
          resolvedTarget = `node:${plain}`;
        } else if (OPTIONAL_EXTERNAL_REQUIRES.has(specifier) && inputImport.path === specifier) {
          classification = "optional-external";
          resolution = "reviewed-finite";
        } else {
          throw new Error(`unclassified external require site at ${sourcePath}: ${specifier}`);
        }
        sites.push(sourceSite(sourceFile, sourcePath, node, {
          operation: "require",
          expression: node.arguments[0].getText(sourceFile),
          classification,
          resolution,
          specifier,
          resolvedTarget,
          expandedMembers: [],
        }));
      } else if (ts.isCallExpression(node)) {
        const method = filesystemMethod(node.expression, bindings);
        if (method) {
          const reviewedKey = externalRuntimeInputKey(sourcePath, method, node, sourceFile);
          if (!REVIEWED_EXTERNAL_RUNTIME_INPUTS.has(reviewedKey)) {
            const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            throw new Error(`unclassified filesystem read site at ${sourcePath}:${location.line + 1}`);
          }
          reviewedExternalInputsSeen.add(reviewedKey);
          sites.push(sourceSite(sourceFile, sourcePath, node, {
            operation: "filesystem-read",
            expression: node.getText(sourceFile),
            classification: "external-runtime-input",
            resolution: "reviewed-finite",
            expandedMembers: [],
          }));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    importClaims.assertExhausted();
  }
  const expectedReviewedExternalInputs = [...REVIEWED_EXTERNAL_RUNTIME_INPUTS]
    .filter((key) => inputMetadata.has(JSON.parse(key)[0]))
    .sort(utf8Compare);
  if (
    JSON.stringify([...reviewedExternalInputsSeen].sort(utf8Compare)) !==
    JSON.stringify(expectedReviewedExternalInputs)
  ) {
    throw new Error("reviewed external runtime input inventory does not match the esbuild source universe");
  }

  const manifestSurfaces = [
    { surface: "main", entrypoint: "index.ts", expression: "./dist/index.js" },
    ...ENTRY_POINTS.map((name) => ({
      surface: `exports:${name === "index" ? "." : `./${name}`}`,
      entrypoint: `${name}.ts`,
      expression: `./dist/${name}.js`,
    })),
    { surface: "openclaw.extensions:0", entrypoint: "index.ts", expression: "./dist/index.js" },
    { surface: "openclaw.setupEntry", entrypoint: "setup-entry.ts", expression: "./dist/setup-entry.js" },
  ];
  for (const [index, manifestSite] of manifestSurfaces.entries()) {
    const targetOutput = entrypoints.get(manifestSite.entrypoint);
    if (!targetOutput) throw new Error(`package entrypoint has no emitted target: ${manifestSite.surface}`);
    sites.push({
      source: "package.json",
      line: 1,
      column: index + 1,
      operation: "package-entrypoint",
      surface: manifestSite.surface,
      expression: manifestSite.expression,
      classification: "artifact-members",
      resolution: "literal",
      resolvedTarget: targetOutput,
      expandedMembers: outputClosure(graph, [targetOutput], false),
    });
  }
  sites.sort(compareRuntimeSites);
  return {
    derivedRuntimeSet: outputClosure(graph, publicRoots, true),
    runtimeDynamicSiteInventory: sites,
  };
}

function normalizedPackageJson(preparedRoot) {
  const manifest = JSON.parse(readFileSync(resolve(preparedRoot, "package.json"), "utf8"));
  if (manifest.name !== PACKAGE_NAME || manifest.version !== PACKAGE_VERSION) {
    throw new Error(`prepared package identity must be ${PACKAGE_NAME}@${PACKAGE_VERSION}`);
  }
  const plugin = JSON.parse(readFileSync(resolve(preparedRoot, "openclaw.plugin.json"), "utf8"));
  if (plugin.id !== PLUGIN_ID || JSON.stringify(plugin.channels) !== JSON.stringify([PLUGIN_ID])) {
    throw new Error("prepared plugin identity must be zalouser");
  }
  const exports = Object.fromEntries(
    ENTRY_POINTS.map((name) => [name === "index" ? "." : `./${name}`, `./dist/${name}.js`]),
  );
  manifest.main = "./dist/index.js";
  manifest.exports = exports;
  manifest.files = ["dist", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses", "openclaw.plugin.json", "README.md"];
  manifest.dependencies = {};
  delete manifest.devDependencies;
  manifest.openclaw.extensions = ["./dist/index.js"];
  manifest.openclaw.setupEntry = "./dist/setup-entry.js";
  return manifest;
}

function normalizeTree(root, sourceDateEpoch) {
  const timestamp = new Date(sourceDateEpoch * 1000);
  const visit = (path) => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error(`symlink build output is forbidden: ${path}`);
    if (entry.isDirectory()) {
      for (const name of readdirSync(path).sort(utf8Compare)) visit(resolve(path, name));
      chmodSync(path, 0o755);
    } else if (entry.isFile()) {
      chmodSync(path, 0o644);
    } else {
      throw new Error(`non-regular build output is forbidden: ${path}`);
    }
    utimesSync(path, timestamp, timestamp);
  };
  visit(root);
}

function normalizeGeneratedIdentifiers(distRoot, preparedRoot) {
  const unstableIdentifier = basename(preparedRoot).replace(/[^A-Za-z0-9_$]/g, "_");
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        const source = readFileSync(path, "utf8");
        if (source.includes(unstableIdentifier)) {
          atomicWrite(path, Buffer.from(source.replaceAll(unstableIdentifier, "prepared_source"), "utf8"));
        }
      }
    }
  };
  visit(distRoot);
}

export function regularFileManifest(root) {
  const members = [];
  const visit = (directory, relativeDirectory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      utf8Compare(left.name, right.name),
    )) {
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink output is forbidden: ${path}`);
      if (entry.isDirectory()) visit(absolute, path);
      else if (entry.isFile()) {
        const bytes = readFileSync(absolute);
        members.push({ path, type: "file", mode: "0644", size: bytes.length, sha256: sha256(bytes) });
      } else throw new Error(`non-regular output is forbidden: ${path}`);
    }
  };
  visit(resolve(root), "");
  return members.sort((left, right) => utf8Compare(left.path, right.path));
}

function assertRuntimeOutput(packageRoot, members) {
  for (const member of members) {
    if (member.path === "FORK.json" || member.path.endsWith(".ts") || member.path.endsWith(".map")) {
      throw new Error(`source/control output is forbidden: ${member.path}`);
    }
    if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:^|\.)test\.[^/]+$/i.test(member.path)) {
      throw new Error(`test output is forbidden: ${member.path}`);
    }
    if (member.path.endsWith(".js")) {
      const source = readFileSync(resolve(packageRoot, member.path), "utf8");
      if (/sourceMappingURL\s*=/.test(source)) throw new Error(`inline source map reference is forbidden: ${member.path}`);
    }
  }
}

export async function buildPreparedTree({
  vendorRoot,
  preparedRoot,
  outputRoot,
  sourceDateEpoch = SOURCE_DATE_EPOCH,
}) {
  assertEpoch(sourceDateEpoch);
  const resolvedVendorRoot = resolve(vendorRoot);
  const resolvedPreparedRoot = assertPreparedRoot(resolvedVendorRoot, preparedRoot);
  const resolvedOutputRoot = resolve(outputRoot);
  const outputPrefix = `${resolvedOutputRoot}${sep}`;
  if (
    dirname(resolvedOutputRoot) === resolvedOutputRoot ||
    [resolvedVendorRoot, resolvedPreparedRoot, dirname(resolvedPreparedRoot)].includes(resolvedOutputRoot) ||
    resolvedVendorRoot.startsWith(outputPrefix) ||
    resolvedPreparedRoot.startsWith(outputPrefix)
  ) {
    throw new Error("refusing to replace vendor or prepared source directories");
  }
  rmSync(resolvedOutputRoot, { force: true, recursive: true });
  const packageRoot = resolve(resolvedOutputRoot, "package");
  const distRoot = resolve(packageRoot, "dist");
  mkdirSync(distRoot, { recursive: true });

  const entryPoints = Object.fromEntries(
    ENTRY_POINTS.map((name) => [name, `${name}.ts`]),
  );
  const buildResult = await esbuild({
    absWorkingDir: resolvedPreparedRoot,
    banner: {
      js: 'import { createRequire as __ihomeCreateRequire } from "node:module";\nvar require = __ihomeCreateRequire(import.meta.url);',
    },
    bundle: true,
    chunkNames: "chunks/[name]-[hash]",
    entryNames: "[name]",
    entryPoints,
    external: ["openclaw", "openclaw/*", "@openclaw/plugin-sdk", "@openclaw/plugin-sdk/*"],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
    minify: false,
    outdir: distRoot,
    platform: "node",
    sourcemap: false,
    splitting: true,
    target: "node24",
    treeShaking: true,
  });
  normalizeGeneratedIdentifiers(distRoot, resolvedPreparedRoot);

  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "openclaw.plugin.json"]) {
    copyRegularFile(resolve(resolvedPreparedRoot, name), resolve(packageRoot, name));
  }
  copyRegularTree(resolve(resolvedPreparedRoot, "licenses"), resolve(packageRoot, "licenses"));
  atomicWrite(
    resolve(packageRoot, "package.json"),
    Buffer.from(`${JSON.stringify(normalizedPackageJson(resolvedPreparedRoot), null, 2)}\n`, "utf8"),
  );
  normalizeTree(packageRoot, sourceDateEpoch);
  const members = regularFileManifest(packageRoot);
  assertRuntimeOutput(packageRoot, members);
  const runtimeMembers = members
    .filter((member) => member.path.startsWith("dist/"))
    .map((member) => `package/${member.path}`)
    .sort(utf8Compare);
  const reachability = runtimeReachabilityAnalysis(resolvedPreparedRoot, buildResult.metafile);
  if (JSON.stringify(reachability.derivedRuntimeSet) !== JSON.stringify(runtimeMembers)) {
    throw new Error("derived runtime closure does not equal the exact emitted runtime set");
  }
  return {
    buildResult,
    derivedRuntimeSet: reachability.derivedRuntimeSet,
    emittedRuntimeSiteInventory: analyzeEmittedRuntimeSites(packageRoot, runtimeMembers),
    members,
    packageRoot,
    sourceDateEpoch,
    runtimeDynamicSiteInventory: reachability.runtimeDynamicSiteInventory,
  };
}

function parseArgument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const vendorRoot = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
  const repoRoot = resolve(vendorRoot, "../../../..");
  const sourceDateEpoch = Number(parseArgument("--source-date-epoch") ?? SOURCE_DATE_EPOCH);
  const preparedRoot = parseArgument("--prepared")
    ? resolve(parseArgument("--prepared"))
    : await prepareVendorTree({
        repoRoot,
        tarballPath: resolve(vendorRoot, ".work/verified-upstream.tgz"),
        vendorRoot,
      });
  const outputRoot = resolve(parseArgument("--output") ?? resolve(vendorRoot, ".work/build"));
  const result = await buildPreparedTree({ vendorRoot, preparedRoot, outputRoot, sourceDateEpoch });
  process.stdout.write(`${result.packageRoot}\n`);
}
