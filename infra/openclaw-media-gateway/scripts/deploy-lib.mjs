import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const SHA256 = /^[0-9a-f]{64}$/u;

export function nodeVersionIsSupported(version) {
  const match = /^24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  return match !== null && Number(match[1]) >= 15;
}

export function parseDeployArguments(args) {
  if (args.length === 1 && args[0] === "--dry-run") {
    return { dryRun: true, expectedBundleSha256: null, expectedConfigSha256: null };
  }
  if (
    args.length === 4 && args[0] === "--expected-bundle-sha256" &&
    SHA256.test(args[1] ?? "") && args[2] === "--expected-config-sha256" &&
    SHA256.test(args[3] ?? "")
  ) {
    return {
      dryRun: false,
      expectedBundleSha256: args[1],
      expectedConfigSha256: args[3],
    };
  }
  throw new Error(
    "Usage: node scripts/deploy.mjs --dry-run | " +
      "--expected-bundle-sha256 <lowercase-sha256> " +
      "--expected-config-sha256 <lowercase-sha256>",
  );
}

export async function stageReviewedConfig(sourcePath, stagedConfigPath) {
  const bytes = await readFile(sourcePath);
  const configSha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(stagedConfigPath, bytes, { flag: "wx" });
  const staged = await readFile(stagedConfigPath);
  if (!staged.equals(bytes)) throw new Error("Staged Wrangler config differs from reviewed bytes");
  return { configPath: stagedConfigPath, configSha256 };
}

export function createDeployPlan({ bundleDirectory, bundlePath, sourcePath, stagedConfigPath }) {
  return {
    bundleArgs: [
      "deploy", sourcePath, "--dry-run", "--minify", "--keep-vars",
      "--outdir", bundleDirectory, "--config", stagedConfigPath,
    ],
    uploadArgs: [
      "deploy", bundlePath, "--no-bundle", "--keep-vars", "--config", stagedConfigPath,
    ],
  };
}

export function boundedSpawnOptions(platform) {
  return {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32",
  };
}

export function posixProcessGroupId(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("child pid invalid");
  return -pid;
}

function terminateChildTree(child, terminateGraceMs) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => child.kill());
    killer.once("close", () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    return;
  }
  const killGroup = (signal) => {
    try {
      process.kill(posixProcessGroupId(child.pid), signal);
    } catch {
      child.kill(signal);
    }
  };
  killGroup("SIGTERM");
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) killGroup("SIGKILL");
  }, terminateGraceMs);
  escalation.unref();
}

export function runBoundedCommand(
  executable,
  args,
  { cwd, env = process.env, outputLimit, timeoutMs, terminateGraceMs = 5_000 },
) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      ...boundedSpawnOptions(process.platform),
    });
    let stdout = "";
    let stderr = "";
    let terminalError = null;
    let spawnError = null;

    const terminate = (error) => {
      if (terminalError !== null) return;
      terminalError = error;
      terminateChildTree(child, terminateGraceMs);
    };
    const append = (current, chunk) => {
      if (terminalError !== null) return current;
      const next = current + String(chunk);
      if (Buffer.byteLength(next, "utf8") > outputLimit) {
        terminate(new Error("Child output exceeded the bounded capture limit"));
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => { spawnError = error; });
    const timeout = setTimeout(() => {
      terminate(new Error("Child exceeded the bounded execution timeout"));
    }, timeoutMs);
    timeout.unref();
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (terminalError) {
        rejectRun(terminalError);
      } else if (spawnError) {
        rejectRun(spawnError);
      } else if (code !== 0) {
        rejectRun(new Error(
          `Child exited with code ${String(code)} signal ${String(signal)}: ${stderr.slice(0, 4096)}`,
        ));
      } else {
        resolveRun({ stdout, stderr });
      }
    });
  });
}
