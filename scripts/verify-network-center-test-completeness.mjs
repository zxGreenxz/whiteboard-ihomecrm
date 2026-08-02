#!/usr/bin/env node
// Fail a CI job when a security-relevant test suite quietly ran fewer tests
// than it claims to own.
//
// WHY THIS EXISTS
// Roughly 56 host-hardening tests in this project were skipped silently outside
// Windows for weeks. Nothing went red, because a skipped test is reported as a
// success by every runner used here. A security regression suite that runs zero
// tests is indistinguishable from a passing one unless something asserts the
// difference, so this does.
//
// Usage: node scripts/verify-network-center-test-completeness.mjs <runner> <logfile>
//   runner: vitest | deno | node
//
// Fail-closed by design: an unparsable log, a missing summary, or zero executed
// tests all exit non-zero. "We could not tell" is not "it passed".
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_RUNNERS = Object.freeze(["vitest", "deno", "node"]);

function stripAnsi(value) {
  return value.replace(/\[[0-?]*[ -/]*[@-~]/g, "");
}

function lastMatch(source, pattern) {
  let result;
  for (const match of source.matchAll(pattern)) result = match;
  return result;
}

export function analyzeTestLog(runner, rawLog) {
  const log = stripAnsi(String(rawLog ?? ""));
  if (log.trim().length === 0) {
    return { ok: false, reason: "TEST_LOG_EMPTY", runner };
  }

  if (runner === "vitest") {
    // "Tests  9 passed (9)" / "Tests  9 passed | 2 skipped (11)"
    const tests = lastMatch(log, /^\s*Tests\s+(.+)$/gmu);
    const files = lastMatch(log, /^\s*Test Files\s+(.+)$/gmu);
    if (!tests || !files) {
      return { ok: false, reason: "VITEST_SUMMARY_MISSING", runner };
    }
    const summary = `${files[1]} | ${tests[1]}`;
    const skipped = /(\d+)\s+(?:skipped|todo)/u.exec(summary);
    const passed = /(\d+)\s+passed/u.exec(tests[1]);
    const executed = passed ? Number.parseInt(passed[1], 10) : 0;
    if (skipped && Number.parseInt(skipped[1], 10) > 0) {
      return { ok: false, reason: "TESTS_SKIPPED", runner, summary };
    }
    if (executed === 0) {
      return { ok: false, reason: "NO_TESTS_EXECUTED", runner, summary };
    }
    return { ok: true, runner, executed, summary };
  }

  if (runner === "node") {
    // node:test TAP summary lines: "# pass 8" / "# skipped 0" / "# todo 0"
    const counter = (name) => {
      const match = lastMatch(log, new RegExp(`^#\\s*${name}\\s+(\\d+)\\s*$`, "gmu"));
      return match ? Number.parseInt(match[1], 10) : null;
    };
    const pass = counter("pass");
    const fail = counter("fail");
    const skipped = counter("skipped");
    const todo = counter("todo");
    if (pass === null || fail === null || skipped === null || todo === null) {
      return { ok: false, reason: "NODE_SUMMARY_MISSING", runner };
    }
    const summary = `pass ${pass} fail ${fail} skipped ${skipped} todo ${todo}`;
    if (skipped > 0 || todo > 0) {
      return { ok: false, reason: "TESTS_SKIPPED", runner, summary };
    }
    if (pass === 0) {
      return { ok: false, reason: "NO_TESTS_EXECUTED", runner, summary };
    }
    return { ok: true, runner, executed: pass, summary };
  }

  if (runner === "deno") {
    // "ok | 22 passed | 0 failed | 1 ignored (123ms)"
    const match = lastMatch(
      log,
      /(\d+)\s+passed(?:\s*\([^)]*\))?\s*\|\s*(\d+)\s+failed(?:\s*\([^)]*\))?(?:\s*\|\s*(\d+)\s+ignored)?/gmu,
    );
    if (!match) {
      return { ok: false, reason: "DENO_SUMMARY_MISSING", runner };
    }
    const passed = Number.parseInt(match[1], 10);
    const ignored = match[3] ? Number.parseInt(match[3], 10) : 0;
    const summary = `passed ${passed} failed ${match[2]} ignored ${ignored}`;
    if (ignored > 0) {
      return { ok: false, reason: "TESTS_SKIPPED", runner, summary };
    }
    if (passed === 0) {
      return { ok: false, reason: "NO_TESTS_EXECUTED", runner, summary };
    }
    return { ok: true, runner, executed: passed, summary };
  }

  return { ok: false, reason: "UNSUPPORTED_RUNNER", runner };
}

function main(argv) {
  const [runner, logPath] = argv;
  if (!SUPPORTED_RUNNERS.includes(runner) || !logPath) {
    process.stdout.write(
      `${JSON.stringify({
        status: "FAIL",
        ok: false,
        failures: [{
          code: "ARGUMENTS_INVALID",
          message: `Usage: node scripts/verify-network-center-test-completeness.mjs (${SUPPORTED_RUNNERS.join("|")}) <logfile>`,
        }],
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  let log;
  try {
    log = readFileSync(logPath, "utf8");
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        status: "FAIL",
        ok: false,
        failures: [{
          code: "TEST_LOG_UNREADABLE",
          message: error instanceof Error ? error.message : "unreadable log",
        }],
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const result = analyzeTestLog(runner, log);
  process.stdout.write(
    `${JSON.stringify({
      status: result.ok ? "PASS" : "FAIL",
      ...result,
    })}\n`,
  );
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
