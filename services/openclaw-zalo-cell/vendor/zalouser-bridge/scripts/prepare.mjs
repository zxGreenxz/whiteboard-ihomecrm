import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectTarball, verifyCommittedInputs } from "./verify-upstream.mjs";

function assertStableNode() {
  const match = /^v24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(process.version);
  if (!match || Number(match[1]) < 15) throw new Error("Official stable Node >=24.15.0 <25 is required");
}

function safeOutput(root, path) {
  const output = resolve(root, path);
  const prefix = `${resolve(root)}${sep}`;
  if (!output.startsWith(prefix)) throw new Error(`output escapes root: ${path}`);
  return output;
}

function atomicWrite(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, bytes, { flag: "wx" });
  renameSync(temporary, path);
}

function noticeBytes(vendorRoot, manifest) {
  const upstream = readFileSync(resolve(vendorRoot, "upstream/THIRD_PARTY_NOTICES.openclaw.md"), "utf8");
  const packages = manifest.packages.map((item) => `${item.package} | ${item.selectedSpdx}`).join("\n");
  const carriers = manifest.carriers.map((item) => `${item.package} | ${item.outputPath}`).join("\n");
  return Buffer.from(
    `${upstream.trimEnd()}\n\n# iHomeCRM reviewed dependency inventory\n\n${packages}\n\n` +
      `# Reviewed carrier paths\n\n${carriers}\n\n` +
      "pako@2.2.0 has two required carriers: its MIT LICENSE and bundled zlib README.\n" +
      "spark-md5@3.0.2 selects the bundled WTFPL carrier; LICENSE2 is absent and must never be fetched or synthesized.\n",
    "utf8",
  );
}

export function renderLegalOutputs({ vendorRoot, tarballBytes }) {
  const upstream = JSON.parse(readFileSync(resolve(vendorRoot, "UPSTREAM.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(vendorRoot, "licenses/manifest.json"), "utf8"));
  if (manifest.packageRootCount !== 38 || manifest.packages.length !== 38) throw new Error("license package inventory mismatch");
  if (manifest.carrierCount !== 39 || manifest.carriers.length !== 39) throw new Error("license carrier inventory mismatch");
  const { entries } = inspectTarball(tarballBytes, upstream);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  atomicWrite(resolve(vendorRoot, "LICENSE"), readFileSync(resolve(vendorRoot, "upstream/LICENSE.openclaw")));
  atomicWrite(resolve(vendorRoot, "THIRD_PARTY_NOTICES.md"), noticeBytes(vendorRoot, manifest));
  for (const item of manifest.carriers) {
    const entry = byPath.get(item.sourcePath);
    if (!entry || entry.size !== item.size) throw new Error(`missing reviewed license carrier: ${item.sourcePath}`);
    const output = safeOutput(vendorRoot, item.outputPath);
    atomicWrite(output, entry.bytes);
  }
  return { carrierCount: manifest.carriers.length, packageCount: manifest.packages.length };
}

function copyPreparedSources(vendorRoot, preparedRoot, upstream) {
  for (const item of upstream.sourceManifest) {
    const source = resolve(vendorRoot, item.outputPath);
    const target = safeOutput(preparedRoot, relative("upstream/package", item.outputPath).split(sep).join("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function copyOverlay(vendorRoot, preparedRoot) {
  for (const name of [
    "authorize-client.ts",
    "control-traffic.ts",
    "inbound-listener.ts",
    "outbound-rpc.ts",
    "send-context.ts",
  ]) {
    const target = resolve(preparedRoot, "src/bridge", name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(vendorRoot, "src/bridge", name), target);
  }
}

function copyRuntimeDependencies(preparedRoot, entries) {
  for (const entry of entries) {
    if (!entry.path.startsWith("package/node_modules/")) continue;
    const output = safeOutput(preparedRoot, entry.path.slice("package/".length));
    atomicWrite(output, entry.bytes);
  }
}

export async function prepareVendorTree({ repoRoot, tarballPath, vendorRoot }) {
  const verified = await verifyCommittedInputs({ repoRoot, vendorRoot });
  const tarballBytes = readFileSync(tarballPath);
  const inspected = inspectTarball(tarballBytes, verified.upstream);
  renderLegalOutputs({ vendorRoot, tarballBytes });
  const preparedRoot = resolve(vendorRoot, ".work", `prepared-${randomUUID()}`);
  mkdirSync(preparedRoot, { recursive: false });
  copyPreparedSources(vendorRoot, preparedRoot, verified.upstream);
  copyRuntimeDependencies(preparedRoot, inspected.entries);
  const series = readFileSync(resolve(vendorRoot, "patches/series"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const preparedDirectory = relative(repoRoot, preparedRoot).split(sep).join("/");
  for (const patch of series) {
    execFileSync("git", ["apply", "--whitespace=nowarn", `--directory=${preparedDirectory}`, resolve(vendorRoot, "patches", patch)], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
  copyOverlay(vendorRoot, preparedRoot);
  copyFileSync(resolve(vendorRoot, "LICENSE"), resolve(preparedRoot, "LICENSE"));
  copyFileSync(resolve(vendorRoot, "THIRD_PARTY_NOTICES.md"), resolve(preparedRoot, "THIRD_PARTY_NOTICES.md"));
  for (const item of JSON.parse(readFileSync(resolve(vendorRoot, "licenses/manifest.json"), "utf8")).carriers) {
    const output = safeOutput(preparedRoot, item.outputPath);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(resolve(vendorRoot, item.outputPath), output);
  }
  return preparedRoot;
}

function parseArgument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  assertStableNode();
  const vendorRoot = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
  const repoRoot = resolve(vendorRoot, "../../../..");
  const tarballPath = resolve(parseArgument("--tarball") ?? resolve(vendorRoot, ".work/upstream.tgz"));
  if (process.argv.includes("--render-legal")) {
    const verified = await verifyCommittedInputs({ repoRoot, vendorRoot });
    const result = renderLegalOutputs({ vendorRoot, tarballBytes: readFileSync(tarballPath), upstream: verified.upstream });
    process.stdout.write(`Rendered ${result.carrierCount} legal carriers.\n`);
  } else {
    const output = await prepareVendorTree({ repoRoot, tarballPath, vendorRoot });
    process.stdout.write(`${output}\n`);
  }
}
