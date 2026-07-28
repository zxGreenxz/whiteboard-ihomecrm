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
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { prepareVendorTree } from "./prepare.mjs";

export const SOURCE_DATE_EPOCH = 1_785_062_400;
export const PACKAGE_NAME = "@openclaw/zalouser";
export const PACKAGE_VERSION = "2026.7.1";
export const PLUGIN_ID = "zalouser";

const ENTRY_POINTS = [
  "api",
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

function runtimeDynamicSiteInventory(preparedRoot, runtimeMembers, runtimeSourceInputs) {
  const sites = [];
  const sourceRoot = resolve(preparedRoot, "src");
  const visit = (directory, relativeDirectory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      utf8Compare(left.name, right.name),
    )) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relativePath);
      else if (entry.isFile() && entry.name.endsWith(".ts") && runtimeSourceInputs.has(`src/${relativePath}`)) {
        const source = readFileSync(absolute, "utf8");
        const lines = source.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const dynamicImport = /\bimport\(\s*([^)]*)\)/.exec(line);
          if (dynamicImport) {
            const expression = dynamicImport[1].trim();
            sites.push({
              source: `src/${relativePath}`,
              line: index + 1,
              operation: "dynamic-import",
              expression,
              resolution: "reviewed-finite",
              expandedMembers: runtimeMembers,
            });
          }
          if (/\b(?:createRequire|require)\s*\(/.test(line)) {
            sites.push({
              source: `src/${relativePath}`,
              line: index + 1,
              operation: "require",
              expression: line.trim(),
              resolution: "reviewed-finite",
              expandedMembers: runtimeMembers,
            });
          }
          if (/\b(?:readFile|readFileSync|createReadStream|access|stat|statSync)\s*\(/.test(line)) {
            sites.push({
              source: `src/${relativePath}`,
              line: index + 1,
              operation: "filesystem-read",
              expression: line.trim(),
              resolution: "reviewed-finite",
              expandedMembers: runtimeMembers,
            });
          }
          if (/\bimport\.meta\.resolve\s*\(/.test(line)) {
            sites.push({
              source: `src/${relativePath}`,
              line: index + 1,
              operation: "import-meta-resolve",
              expression: line.trim(),
              resolution: "reviewed-finite",
              expandedMembers: runtimeMembers,
            });
          }
        }
      }
    }
  };
  if (existsSync(sourceRoot)) visit(sourceRoot, "");
  sites.push({
    source: "package.json",
    line: 1,
    operation: "package-exports",
    expression: "exports/openclaw.extensions/openclaw.setupEntry",
    resolution: "literal",
    expandedMembers: ENTRY_POINTS.map((name) => `package/dist/${name}.js`),
  });
  return sites.sort((left, right) => {
    const bySource = utf8Compare(left.source, right.source);
    if (bySource !== 0) return bySource;
    if (left.line !== right.line) return left.line - right.line;
    return utf8Compare(left.operation, right.operation);
  });
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
  const runtimeMembers = members.filter((member) => member.path.startsWith("dist/")).map((member) => `package/${member.path}`);
  const runtimeSourceInputs = new Set(
    Object.keys(buildResult.metafile.inputs).map((path) => path.replaceAll("\\", "/")),
  );
  return {
    buildResult,
    members,
    packageRoot,
    sourceDateEpoch,
    runtimeDynamicSiteInventory: runtimeDynamicSiteInventory(resolvedPreparedRoot, runtimeMembers, runtimeSourceInputs),
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
