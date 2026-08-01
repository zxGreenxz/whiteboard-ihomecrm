import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDeployPlan,
  nodeVersionIsSupported,
  parseDeployArguments,
  runBoundedCommand,
  stageReviewedConfig,
} from "./deploy-lib.mjs";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const wranglerEntry = resolve(packageRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const configPath = resolve(packageRoot, "wrangler.toml");
const sourcePath = resolve(packageRoot, "src", "index.ts");
const temporaryPrefix = join(tmpdir(), "openclaw-media-gateway-deploy-");
const outputLimit = 1_048_576;
const wranglerTimeoutMs = 5 * 60 * 1_000;
const maximumBundleBytes = 16 * 1_024 * 1_024;

if (!nodeVersionIsSupported(process.versions.node)) {
  throw new Error("Gateway deployment requires stable Node >=24.15.0 <25");
}
const { dryRun, expectedBundleSha256, expectedConfigSha256 } = parseDeployArguments(
  process.argv.slice(2),
);

async function runWrangler(args) {
  return await runBoundedCommand(process.execPath, [wranglerEntry, ...args], {
    cwd: packageRoot,
    outputLimit,
    timeoutMs: wranglerTimeoutMs,
  });
}

function workerVersionFrom(output) {
  const match = /Current Version ID:\s*([0-9a-f]{8}-[0-9a-f-]{27})/iu.exec(output);
  if (!match?.[1]) throw new Error("Wrangler did not report a Worker version ID");
  return match[1].toLowerCase();
}

const temporaryDirectory = await mkdtemp(temporaryPrefix);
const bundlePath = join(temporaryDirectory, "index.js");
const stagedConfigPath = join(temporaryDirectory, "wrangler.toml");
const { configSha256 } = await stageReviewedConfig(configPath, stagedConfigPath);
const plan = createDeployPlan({
  bundleDirectory: temporaryDirectory,
  bundlePath,
  sourcePath,
  stagedConfigPath,
});
try {
  await runWrangler(plan.bundleArgs);
  const entries = (await readdir(temporaryDirectory)).sort();
  if (entries.join(",") !== "README.md,index.js,index.js.map,wrangler.toml") {
    throw new Error(`Wrangler emitted an unexpected bundle closure: ${entries.join(",")}`);
  }
  const bundleStat = await stat(bundlePath);
  if (!bundleStat.isFile() || bundleStat.size < 1 || bundleStat.size > maximumBundleBytes) {
    throw new Error("Wrangler emitted an invalid bundle file");
  }
  const bundleBytes = await readFile(bundlePath);
  if (bundleBytes.subarray(0, 64).toString("utf8").includes("Content-Disposition:")) {
    throw new Error("Wrangler emitted transport framing instead of JavaScript");
  }
  const bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");
  let workerVersion = null;
  if (!dryRun) {
    if (bundleSha256 !== expectedBundleSha256) {
      throw new Error("Generated bundle SHA-256 does not match the reviewed artifact");
    }
    if (configSha256 !== expectedConfigSha256) {
      throw new Error("Wrangler config SHA-256 does not match the reviewed artifact");
    }
    const stagedConfigSha256 = createHash("sha256")
      .update(await readFile(stagedConfigPath)).digest("hex");
    if (stagedConfigSha256 !== configSha256) {
      throw new Error("Staged Wrangler config changed after review");
    }
    const deployed = await runWrangler(plan.uploadArgs);
    workerVersion = workerVersionFrom(`${deployed.stdout}\n${deployed.stderr}`);
  }
  process.stdout.write(`${JSON.stringify({
    version: 1,
    workerName: "openclaw-media-gateway",
    workerVersion,
    bundleSha256,
    configSha256,
    dryRun,
  })}\n`);
} finally {
  if (!temporaryDirectory.startsWith(temporaryPrefix)) {
    throw new Error("Refusing to remove an unexpected deploy directory");
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
