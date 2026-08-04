#!/usr/bin/env node
// Prove, by evidence, that no disposable Network Center database survived the
// job that created it.
//
// WHY THIS EXISTS
// On 2026-07-29 a disposable Supabase stack created by an automated session was
// never cleaned up. Container supabase_db_ihome-nc-disposable-... ran for three
// days with RestartPolicy=unless-stopped and published 0.0.0.0:54322 -> 5432.
// The host firewall allowed only 22/80/443, but Docker installs its own nat
// PREROUTING DNAT rules that BYPASS the firewall, so the database was reachable
// from the public internet and held a full schema replica. It was confirmed
// exploitable by a TCP connect from an unrelated workstation.
//
// The lesson recorded at the time: "guaranteed teardown" claimed by calling a
// cleanup function is not teardown. Teardown is a state you assert. This script
// asserts three things:
//
//   1. no Docker container beyond the recorded baseline is still present, and
//      no surviving container carries a restart policy;
//   2. no nat DNAT rule forwards a non-loopback destination to a database port;
//   3. nothing is listening on a non-loopback address on the disposable port
//      range.
//
// A check that cannot run on this platform is reported as "unavailable" and
// does NOT count as a pass. Exit code is 1 if any check fails, and 1 if every
// check is unavailable, because then nothing was actually verified.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Supabase CLI defaults plus the ephemeral range this repository's disposable
// runners allocate from.
export const DISPOSABLE_DB_PORTS = Object.freeze([
  5432, 54320, 54321, 54322, 54323, 54324, 54325, 54326, 54327, 54328, 54329,
]);
const COMMAND_TIMEOUT_MS = 30_000;

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return { available: false, stdout: "", stderr: String(result.stderr ?? "") };
  }
  return { available: true, stdout: result.stdout ?? "", stderr: "" };
}

export function parseDockerContainers(stdout) {
  return String(stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function findWideDnatRules(natRules) {
  return String(natRules)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /\bDNAT\b/u.test(line))
    .filter((line) => {
      const destination = /--to-destination\s+(\S+)/u.exec(line);
      const port = /--dport\s+(\d+)/u.exec(line);
      if (!port || !DISPOSABLE_DB_PORTS.includes(Number.parseInt(port[1], 10))) {
        return false;
      }
      // A rule that lands on loopback cannot be reached from off-host.
      return !destination || !destination[1].startsWith("127.");
    });
}

export function findExposedListeners(listenerOutput) {
  return String(listenerOutput)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /LISTEN/u.test(line))
    .filter((line) => {
      const address = /(?:^|\s)((?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\]|\*):(\d+)\b/iu
        .exec(line);
      if (!address) return false;
      const host = address[1];
      const port = Number.parseInt(address[2], 10);
      if (!DISPOSABLE_DB_PORTS.includes(port)) return false;
      return !(host === "127.0.0.1" || host === "[::1]");
    });
}

export function verifyDisposableTeardown({
  baselineContainersPath,
  runner = run,
} = {}) {
  const failures = [];
  const checks = {};

  const dockerList = runner("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  if (!dockerList.available) {
    checks.containers = "unavailable";
  } else {
    const observed = parseDockerContainers(dockerList.stdout);
    let baseline = [];
    if (baselineContainersPath && existsSync(baselineContainersPath)) {
      baseline = parseDockerContainers(
        readFileSync(baselineContainersPath, "utf8"),
      );
    }
    const added = observed.filter((name) => !baseline.includes(name));
    const leaked = added.filter((name) =>
      /^supabase[_-]|network[-_]center|ihome[-_]nc/iu.test(name),
    );
    checks.containers = leaked.length === 0 ? "pass" : "fail";
    for (const name of leaked) {
      failures.push({ code: "DISPOSABLE_CONTAINER_SURVIVED", container: name });
    }
    // A restart policy on anything ephemeral is what made the previous leak
    // unkillable by a janitor, so flag it even for baseline containers.
    for (const name of observed) {
      const policy = runner("docker", [
        "inspect",
        "--format",
        "{{.HostConfig.RestartPolicy.Name}}",
        name,
      ]);
      if (!policy.available) continue;
      const value = policy.stdout.trim();
      if (
        value
        && value !== "no"
        && value !== "<no value>"
        && /^supabase[_-]|network[-_]center|ihome[-_]nc/iu.test(name)
      ) {
        failures.push({
          code: "DISPOSABLE_RESTART_POLICY",
          container: name,
          policy: value,
        });
        checks.containers = "fail";
      }
    }
  }

  const nat = runner("iptables", ["-t", "nat", "-S"]);
  if (!nat.available) {
    checks.dnat = "unavailable";
  } else {
    const wide = findWideDnatRules(nat.stdout);
    checks.dnat = wide.length === 0 ? "pass" : "fail";
    for (const rule of wide) {
      failures.push({ code: "DISPOSABLE_DNAT_RULE_SURVIVED", rule });
    }
  }

  let listeners = runner("ss", ["-lntp"]);
  if (!listeners.available) listeners = runner("netstat", ["-an"]);
  if (!listeners.available) {
    checks.listeners = "unavailable";
  } else {
    const exposed = findExposedListeners(listeners.stdout);
    checks.listeners = exposed.length === 0 ? "pass" : "fail";
    for (const line of exposed) {
      failures.push({ code: "DISPOSABLE_PORT_STILL_EXPOSED", listener: line });
    }
  }

  const performed = Object.values(checks).filter(
    (state) => state !== "unavailable",
  ).length;
  if (performed === 0) {
    failures.push({
      code: "TEARDOWN_UNVERIFIABLE",
      message:
        "No teardown check could run on this platform; teardown is unproven, not proven",
    });
  }

  return { ok: failures.length === 0, checks, failures };
}

function main(argv) {
  const baselineIndex = argv.indexOf("--baseline-containers");
  const baselineContainersPath =
    baselineIndex >= 0 && argv[baselineIndex + 1]
      ? resolve(argv[baselineIndex + 1])
      : undefined;
  const result = verifyDisposableTeardown({ baselineContainersPath });
  process.stdout.write(
    `${JSON.stringify({ status: result.ok ? "PASS" : "FAIL", ...result })}\n`,
  );
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
