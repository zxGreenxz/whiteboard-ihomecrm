import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createGatePlan, planFromGit } from "../lib/gate-plan.mjs";
import { aggregateGateEvidence } from "../lib/gate-evidence.mjs";
import { validAggregateForRun } from "../promote-to-production.mjs";
import {
  LOCAL_E2E_EVIDENCE_DIR, applyLocalE2eEvidence, classifyTarget, createLocalE2eReceipt,
  summarizePlaywrightReport, validateLocalE2eReceipt,
} from "../lib/gate-e2e-local-evidence.mjs";

const SPEC_A = ".e2e-fleet/specs/fixture-room-a.spec.ts";
const SPEC_B = ".e2e-fleet/specs/fixture-room-b.spec.ts";
const COMMIT = "c".repeat(40);
const TREE = "e".repeat(40);
const OTHER_TREE = "f".repeat(40);
const NOW = Date.parse("2026-10-19T10:00:00Z");
const COMMITTED = Date.parse("2026-10-19T08:00:00Z");
const row = (file, patch = {}) => ({ file, tests: 3, passed: 3, failed: 0, skipped: 0, flaky: 0, ...patch });
const receipt = (specs = [row(SPEC_A)], patch = {}) => ({
  ...createLocalE2eReceipt({
    commit: COMMIT, fleetTree: TREE, target: { kind: "loopback", origin: "http://localhost:8080" },
    runner: { node: "v22.20.0", playwright: "1.61.1" }, runId: "0b6c7a52-6a55-4b40-9a59-3b1f4bb2a001",
    startedAt: "2026-10-19T09:00:00.000Z", completedAt: "2026-10-19T09:10:00.000Z", specs,
  }), ...patch,
});
const known = { [COMMIT]: { fleetTree: TREE, committedAt: COMMITTED, isAncestor: true } };
const context = (patch = {}) => ({ planFleetTree: TREE, resolveCommit: (sha) => known[sha] ?? null, now: NOW, ...patch });
const obligation = (files = [SPEC_A]) => ({ suiteId: "e2e-fleet", kind: "live-browser", files, reason: "Live browser evidence requires affected preview/role; not default CI pass" });
const basePlan = (files) => ({ unavailable: [obligation(files)] });
const apply = (receipts, files, patch) => applyLocalE2eEvidence(basePlan(files), { receipts: receipts.map((r, i) => ({ path: `${LOCAL_E2E_EVIDENCE_DIR}/r${i}.json`, receipt: r })), ...context(patch) });

describe("plan declares which fleet specs need live evidence", () => {
  it("live-browser obligation carries the exact selected spec files", () => {
    const p = createGatePlan({ changes: [{ path: SPEC_A, before: "a", after: "b", status: "M" }], snapshot: { base: "b", head: "h", tree: "t", source: "fixture" }, testFiles: [SPEC_A] });
    expect(p.unavailable).toContainEqual(expect.objectContaining({ suiteId: "e2e-fleet", kind: "live-browser", files: [SPEC_A] }));
  });
});

describe("local E2E receipt satisfies only an exact, fully green fleet obligation", () => {
  it("missing receipt keeps the obligation blocking", () => {
    const p = apply([], [SPEC_A]);
    expect(p.unavailable).toHaveLength(1);
    expect(p.unavailable[0].localEvidence.missing).toEqual([SPEC_A]);
    expect(p.localEvidence).toEqual([]);
  });
  it("matching receipt clears the obligation and records what was accepted", () => {
    const p = apply([receipt()], [SPEC_A]);
    expect(p.unavailable).toEqual([]);
    expect(p.localEvidence).toEqual([expect.objectContaining({ suiteId: "e2e-fleet", files: [SPEC_A], fleetTree: TREE, receipts: [expect.objectContaining({ commit: COMMIT })] })]);
  });
  it("spec changed after the run (different fleet tree) blocks", () => {
    const p = apply([receipt()], [SPEC_A], { planFleetTree: OTHER_TREE });
    expect(p.unavailable).toHaveLength(1);
    expect(validateLocalE2eReceipt(receipt(), context({ planFleetTree: OTHER_TREE })).problems).toContain("Fleet tree changed after the run");
    expect(apply([receipt()], [SPEC_A], { planFleetTree: null }).unavailable).toHaveLength(1);
  });
  it("one red spec blocks, even when another green receipt at the same tree covers it", () => {
    const red = receipt([row(SPEC_A, { passed: 2, failed: 1 })]);
    expect(apply([red], [SPEC_A]).unavailable).toHaveLength(1);
    const p = apply([receipt(), red], [SPEC_A]);
    expect(p.unavailable).toHaveLength(1);
    expect(p.unavailable[0].localEvidence.failedReceipts).toEqual([`${LOCAL_E2E_EVIDENCE_DIR}/r1.json`]);
    for (const patch of [{ skipped: 1, passed: 2 }, { flaky: 1, passed: 2 }, { tests: 0, passed: 0 }, { passed: 2 }]) {
      expect(apply([receipt([row(SPEC_A, patch)])], [SPEC_A]).unavailable).toHaveLength(1);
      // A hand-edited "passed" status cannot hide the row; it still blocks a green receipt.
      const lying = receipt([row(SPEC_A, patch)], { status: "passed" });
      expect(validateLocalE2eReceipt(lying, context()).failedFiles).toEqual([SPEC_A]);
      expect(apply([receipt(), lying], [SPEC_A]).unavailable).toHaveLength(1);
    }
    expect(apply([receipt(undefined, { status: "failed" })], [SPEC_A]).unavailable).toHaveLength(1);
  });
  it("forged commit SHA or tree blocks", () => {
    expect(apply([receipt(undefined, { commit: "d".repeat(40) })], [SPEC_A]).unavailable).toHaveLength(1);
    const forgedTree = { [COMMIT]: { ...known[COMMIT], fleetTree: OTHER_TREE } };
    expect(apply([receipt()], [SPEC_A], { resolveCommit: (sha) => forgedTree[sha] }).unavailable).toHaveLength(1);
    expect(apply([receipt(undefined, { commit: COMMIT.slice(0, 12) })], [SPEC_A]).unavailable).toHaveLength(1);
    const notAncestor = { [COMMIT]: { ...known[COMMIT], isAncestor: false } };
    expect(apply([receipt()], [SPEC_A], { resolveCommit: (sha) => notAncestor[sha] }).unavailable).toHaveLength(1);
    expect(apply([receipt()], [SPEC_A], { resolveCommit: () => { throw new Error("git"); } }).unavailable).toHaveLength(1);
    expect(apply([receipt(undefined, { startedAt: "2026-10-19T07:00:00.000Z" })], [SPEC_A]).unavailable).toHaveLength(1);
  });
  it("partial coverage blocks; two valid receipts at the same tree may cover together", () => {
    expect(apply([receipt()], [SPEC_A, SPEC_B]).unavailable[0].localEvidence.missing).toEqual([SPEC_B]);
    expect(apply([receipt(), receipt([row(SPEC_B)])], [SPEC_A, SPEC_B]).unavailable).toEqual([]);
  });
  it("rejects non-TEST targets, extra fields and malformed receipts", () => {
    for (const patch of [
      { environment: "PRODUCTION" }, { target: { kind: "loopback", origin: "https://ptcrm.vercel.app" } },
      { target: { kind: "test-env-preview", origin: "https://ptcrm.vercel.app" } }, { token: "x" },
      { schemaVersion: 2 }, { suiteId: "voucher-detail-read-test" }, { completedAt: "2026-10-20T00:00:00.000Z" },
      { runId: "local" }, { specs: [] }, { specs: [{ ...row(SPEC_A), title: "x" }] }, { specs: [row(SPEC_A), row(SPEC_A)] },
      { specs: [row("src/foo.spec.ts")] }, { runner: { node: "v22", playwright: "1", password: "x" } },
    ]) expect(validateLocalE2eReceipt(receipt(undefined, patch), context()).valid, JSON.stringify(patch)).toBe(false);
    expect(validateLocalE2eReceipt(null, context()).valid).toBe(false);
    expect(apply([null], [SPEC_A]).unavailable).toHaveLength(1);
  });
  it("never satisfies other suites or obligations without the live-browser kind", () => {
    const plan = { unavailable: [{ ...obligation(), suiteId: "voucher-detail-read-test" }, { suiteId: "e2e-fleet", reason: "Selected mapping has no owned active tests" }, { suiteId: "e2e-fleet", files: [SPEC_A], reason: "Runner belongs to a separate workflow" }] };
    const p = applyLocalE2eEvidence(plan, { receipts: [{ path: "r.json", receipt: receipt() }], ...context() });
    expect(p.unavailable).toEqual(plan.unavailable);
  });
});

describe("aggregate and promote carry the accepted local evidence", () => {
  const gate = { id: "check-docs", command: "node", args: ["scripts/check-docs.mjs"], job: "quality-gates", evidenceClass: "static" };
  it("aggregate fails while the obligation is open and passes once it is satisfied", () => {
    const plan = { schemaVersion: 1, snapshot: { head: "a".repeat(40), tree: "b".repeat(40), source: "commit", base: null }, policyDigest: "p", runtimeDigest: "r", inputDigest: "i", gateIds: [gate.id], requiredJobs: [gate.job] };
    const input = { receipts: [], jobs: { "quality-gates": "success" }, registry: { [gate.id]: gate }, runId: "1:1", now: NOW };
    const open = aggregateGateEvidence({ ...input, plan: { ...plan, ...apply([], [SPEC_A]) } });
    expect(open.failures.some((f) => f.startsWith("Unverifiable required obligation"))).toBe(true);
    const done = aggregateGateEvidence({ ...input, plan: { ...plan, ...apply([receipt()], [SPEC_A]) } });
    expect(done.failures.some((f) => f.startsWith("Unverifiable required obligation"))).toBe(false);
    expect(done.localEvidence).toHaveLength(1);
  });
  it("promote rejects malformed local evidence in an otherwise valid aggregate", () => {
    const run = { id: 1, run_attempt: 1 };
    const aggregate = { schemaVersion: 1, status: "passed", runId: "1:1", snapshot: { head: "abc", base: "b".repeat(40) }, gateIds: ["check-docs"], policyDigest: "p", runtimeDigest: "r", inputDigest: "i", requiredExternalWorkflows: [] };
    const good = apply([receipt()], [SPEC_A]).localEvidence;
    expect(validAggregateForRun(aggregate, run, "abc")).toBe(true);
    expect(validAggregateForRun({ ...aggregate, localEvidence: good }, run, "abc")).toBe(true);
    for (const bad of [null, [{ ...good[0], suiteId: "voucher-detail-read-test" }], [{ ...good[0], receipts: [] }], [{ ...good[0], fleetTree: "x" }]]) {
      expect(validAggregateForRun({ ...aggregate, localEvidence: bad }, run, "abc")).toBe(false);
    }
  });
});

describe("runner helpers", () => {
  it("summarizes Playwright JSON by file without titles or errors", () => {
    const test = (status, results) => ({ status, results: results.map((s) => ({ status: s, error: { message: "secret" } })) });
    const report = { suites: [{ file: "fixture-room-a.spec.ts", specs: [
      { file: "fixture-room-a.spec.ts", title: "secret title", tests: [test("expected", ["passed"]), test("skipped", ["skipped"])] },
    ], suites: [{ file: "fixture-room-a.spec.ts", specs: [{ file: "fixture-room-a.spec.ts", tests: [test("flaky", ["failed", "passed"]), test("unexpected", ["failed"]), test("expected", ["failed"])] }] }] }] };
    const rows = summarizePlaywrightReport(report);
    expect(rows).toEqual([{ file: SPEC_A, tests: 5, passed: 1, failed: 2, skipped: 1, flaky: 1 }]);
    expect(JSON.stringify(rows)).not.toContain("secret");
  });
  it("accepts only TEST targets and keeps the origin only", () => {
    expect(classifyTarget("https://ihomecrm-git-test-env-abc-team.vercel.app/path?token=x")).toEqual({ kind: "test-env-preview", origin: "https://ihomecrm-git-test-env-abc-team.vercel.app" });
    expect(classifyTarget("http://localhost:8080/")).toEqual({ kind: "loopback", origin: "http://localhost:8080" });
    for (const url of ["https://ptcrm.vercel.app", "https://ihomecrm-git-main-x.vercel.app", "http://evil.test:80", undefined, "not a url"]) expect(classifyTarget(url)).toBeNull();
  });
});

const fixtures = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "ihome-e2e-receipt-")); fixtures.push(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put = (path, text) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
  git("init", "-q"); git("config", "user.name", "Gate fixture"); git("config", "user.email", "fixture@example.test"); git("config", "core.autocrlf", "false");
  for (const file of ["tooling/risk-map.json", "tooling/test-matrix.json"]) put(file, readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"));
  put(SPEC_A, "test('a', () => {});\n");
  git("add", "-A"); git("commit", "-qm", "base");
  return { root, git, put };
}
function writeReceipt({ git, put }, name, patch = {}) {
  const commit = git("rev-parse", "HEAD");
  const r = createLocalE2eReceipt({
    commit, fleetTree: git("rev-parse", "HEAD:.e2e-fleet"), target: { kind: "loopback", origin: "http://127.0.0.1:5173" },
    runner: { node: process.version, playwright: "1.61.1" }, runId: "0b6c7a52-6a55-4b40-9a59-3b1f4bb2a002",
    // Committer time is floored to seconds, so "now" is never before the commit.
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), specs: [row(SPEC_A)],
  });
  put(`${LOCAL_E2E_EVIDENCE_DIR}/${name}.json`, JSON.stringify({ ...r, ...patch }));
  git("add", "-A"); git("commit", "-qm", `receipt ${name}`);
}
const fleetBlocked = (p) => p.unavailable.some((u) => u.suiteId === "e2e-fleet");

describe("planFromGit reads committed receipts from the planned snapshot", () => {
  it("binds the receipt to Git history: green passes, later spec edit and forged SHA block", () => {
    const fx = gitFixture(); const base = fx.git("rev-parse", "HEAD");
    fx.put(SPEC_A, "test('a2', () => {});\n"); fx.git("add", "-A"); fx.git("commit", "-qm", "spec");
    expect(fleetBlocked(planFromGit({ root: fx.root, mode: "commit", base, head: "HEAD" }))).toBe(true);
    writeReceipt(fx, "green");
    const ok = planFromGit({ root: fx.root, mode: "commit", base, head: "HEAD" });
    expect(fleetBlocked(ok)).toBe(false);
    expect(ok.localEvidence[0].files).toEqual([SPEC_A]);
    expect(fleetBlocked(planFromGit({ root: fx.root, mode: "commit", base, head: "HEAD", localEvidence: false }))).toBe(true);
    // Staged snapshot (gate:truoc-push) reads the same receipt from the index.
    fx.put("docs/note.md", "x"); fx.git("add", "docs/note.md");
    expect(fleetBlocked(planFromGit({ root: fx.root, mode: "staged", base, head: "HEAD" }))).toBe(false);
    fx.git("commit", "-qm", "docs");
    fx.put(SPEC_A, "test('a3', () => {});\n"); fx.git("add", "-A"); fx.git("commit", "-qm", "edit after run");
    const stale = planFromGit({ root: fx.root, mode: "commit", base, head: "HEAD" });
    expect(fleetBlocked(stale)).toBe(true);
    expect(stale.unavailable.find((u) => u.suiteId === "e2e-fleet").localEvidence.rejected[0].problems).toContain("Fleet tree changed after the run");
  });
  it("a receipt naming a commit that does not exist, or a foreign tree, is rejected", () => {
    const fx = gitFixture(); const base = fx.git("rev-parse", "HEAD");
    fx.put(SPEC_A, "test('a2', () => {});\n"); fx.git("add", "-A"); fx.git("commit", "-qm", "spec");
    writeReceipt(fx, "forged", { commit: "1".repeat(40) });
    expect(fleetBlocked(planFromGit({ root: fx.root, mode: "commit", base, head: "HEAD" }))).toBe(true);
    writeReceipt(fx, "foreign-tree", { fleetTree: fx.git("rev-parse", `${base}:.e2e-fleet`) });
    expect(fleetBlocked(planFromGit({ root: fx.root, mode: "commit", base, head: "HEAD" }))).toBe(true);
    // Same bytes, but a commit outside the planned history (e.g. a rebased/squashed copy).
    const orphan = fx.git("commit-tree", "HEAD^{tree}", "-m", "orphan copy");
    writeReceipt(fx, "orphan", { commit: orphan });
    expect(fleetBlocked(planFromGit({ root: fx.root, mode: "commit", base, head: "HEAD" }))).toBe(true);
    // An annotated tag peels to the right commit, but the receipt must name the commit itself.
    fx.git("tag", "-a", "-m", "tag", "run-tag", "HEAD");
    writeReceipt(fx, "tag", { commit: fx.git("rev-parse", "run-tag") });
    expect(fleetBlocked(planFromGit({ root: fx.root, mode: "commit", base, head: "HEAD" }))).toBe(true);
  });
});
