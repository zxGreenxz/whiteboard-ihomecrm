import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createGatePlan, planFromGit } from "../lib/gate-plan.mjs";
import { aggregateGateEvidence } from "../lib/gate-evidence.mjs";
import { readGateEvidence, validAggregateForRun } from "../promote-to-production.mjs";
import {
  LOCAL_E2E_EVIDENCE_DIR, PROD_SUPABASE_REF, TEST_SUPABASE_REF, applyLocalE2eEvidence, classifyTarget, createLocalE2eReceipt,
  describeLocalEvidence, summarizePlaywrightReport, validateLocalE2eReceipt,
} from "../lib/gate-e2e-local-evidence.mjs";
import { dirtyEntries, extractBuildSha, extractSupabaseRefs, probeTarget, referencedScripts, verifyTestTarget } from "../lib/e2e-fleet-runner.mjs";

const SPEC_A = ".e2e-fleet/specs/fixture-room-a.spec.ts";
const SPEC_B = ".e2e-fleet/specs/fixture-room-b.spec.ts";
const COMMIT = "c".repeat(40);
const TREE = "e".repeat(40);
const OTHER_TREE = "f".repeat(40);
const NOW = Date.parse("2026-10-19T10:00:00Z");
const COMMITTED = Date.parse("2026-10-19T08:00:00Z");
const row = (file, patch = {}) => ({ file, tests: 3, passed: 3, failed: 0, skipped: 0, flaky: 0, ...patch });
const IDENTITY = { targetSupabaseRef: TEST_SUPABASE_REF, targetBuildSha: null, actor: { gitUser: "Fixture", host: "fixture-host" }, reportSha256: "a".repeat(64) };
const receipt = (specs = [row(SPEC_A)], patch = {}) => ({
  ...createLocalE2eReceipt({
    commit: COMMIT, fleetTree: TREE, target: { kind: "loopback", origin: "http://localhost:8080" }, ...IDENTITY,
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
      { targetSupabaseRef: PROD_SUPABASE_REF }, { targetSupabaseRef: "abcdefghijklmnopqrst" }, { targetSupabaseRef: undefined },
      { targetBuildSha: "abc" }, { targetBuildSha: "A".repeat(40) }, { actor: { gitUser: "x" } }, { actor: { gitUser: "x", host: "h", email: "e" } },
      { actor: { gitUser: "x\ny", host: "h" } }, { actor: { gitUser: "", host: "h" } }, { reportSha256: "a".repeat(63) }, { reportSha256: null },
    ]) expect(validateLocalE2eReceipt(receipt(undefined, patch), context()).valid, JSON.stringify(patch)).toBe(false);
    expect(validateLocalE2eReceipt(null, context()).valid).toBe(false);
    expect(apply([null], [SPEC_A]).unavailable).toHaveLength(1);
    // targetBuildSha is recorded, never required.
    expect(validateLocalE2eReceipt(receipt(undefined, { targetBuildSha: "9".repeat(40) }), context()).valid).toBe(true);
  });
  it("a run that did not finish cleanly is a red receipt even when every row is green", () => {
    const base = receipt();
    const red = createLocalE2eReceipt({ ...base, target: base.target, runOk: false });
    expect(red.status).toBe("failed");
    expect(apply([red], [SPEC_A]).unavailable).toHaveLength(1);
  });
  it("diagnostics show the newest receipt at the current tree first", () => {
    const old = Array.from({ length: 7 }, (_, i) => receipt(undefined, { fleetTree: OTHER_TREE, completedAt: `2026-10-0${i + 1}T00:00:00.000Z`, startedAt: `2026-10-0${i + 1}T00:00:00.000Z` }));
    const fresh = receipt(undefined, { targetSupabaseRef: PROD_SUPABASE_REF });
    const p = apply([...old, fresh], [SPEC_A]);
    const rejected = p.unavailable[0].localEvidence.rejected;
    expect(rejected[0].path).toBe(`${LOCAL_E2E_EVIDENCE_DIR}/r7.json`);
    expect(rejected[0].problems).toContain("Target Supabase project is not TEST");
    expect(rejected[1].path).toBe(`${LOCAL_E2E_EVIDENCE_DIR}/r6.json`);
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
  it("promote surfaces which local receipts the covering aggregate accepted", async () => {
    const tip = "b".repeat(40);
    const good = apply([receipt()], [SPEC_A]).localEvidence;
    const step = { name: "aggregate", status: "completed", conclusion: "success" };
    const jobs = [{ name: "gate-aggregate", status: "completed", conclusion: "success", steps: [step] }];
    const run = { id: 1, run_attempt: 1, name: "CI Gates", path: ".github/workflows/ci-gates.yml", head_branch: "main", event: "push", head_sha: "abc", status: "completed", conclusion: "success" };
    const aggregate = { schemaVersion: 1, status: "passed", runId: "1:1", snapshot: { head: "abc", base: tip, source: "commit-range" }, gateIds: ["check-docs"], policyDigest: "p", runtimeDigest: "r", inputDigest: "i", requiredExternalWorkflows: [], localEvidence: good };
    const { verdict } = await readGateEvidence("o/r", "abc", "t", async (path) => {
      if (path.startsWith("/repos/o/r/actions/runs?")) return { total_count: 1, workflow_runs: [run] };
      if (path.includes("/jobs?")) return { total_count: 1, jobs };
      if (path === "/repos/o/r/git/ref/heads/production") return { object: { sha: tip } };
      throw new Error(`Unexpected API request: ${path}`);
    }, async () => aggregate);
    expect(verdict.datDieuKien).toBe(true);
    expect(verdict.localEvidence).toEqual(good);
    expect(describeLocalEvidence(verdict.localEvidence)).toEqual([`e2e-fleet: 1 spec · ${LOCAL_E2E_EVIDENCE_DIR}/r0.json · commit ${COMMIT.slice(0, 12)} · run 0b6c7a52 · 2026-10-19T09:10:00.000Z`]);
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
    expect(classifyTarget("https://ihomecrm-git-test-env-zxgreenxzs-projects.vercel.app/path?token=x")).toEqual({ kind: "test-env-preview", origin: "https://ihomecrm-git-test-env-zxgreenxzs-projects.vercel.app" });
    expect(classifyTarget("http://localhost:8080/")).toEqual({ kind: "loopback", origin: "http://localhost:8080" });
    for (const url of ["https://ptcrm.vercel.app", "https://ihomecrm-git-test-env-other-team.vercel.app", "https://ihomecrm-git-main-x.vercel.app", "http://evil.test:80", undefined, "not a url"]) expect(classifyTarget(url)).toBeNull();
  });
  it("treats any modified, staged or untracked entry as a dirty worktree", () => {
    expect(dirtyEntries("")).toEqual([]);
    expect(dirtyEntries("\n")).toEqual([]);
    expect(dirtyEntries(" M src/a.ts\nA  b.ts\n?? c.txt\n")).toEqual([" M src/a.ts", "A  b.ts", "?? c.txt"]);
  });
  it("reads the Supabase ref and build SHA the target really serves", () => {
    const test = `https://${TEST_SUPABASE_REF}.supabase.co`; const prod = `https://${PROD_SUPABASE_REF}.supabase.co`;
    expect(extractSupabaseRefs(`a="${test}/rest";b='${test}';c=\`${prod}\``)).toEqual([PROD_SUPABASE_REF, TEST_SUPABASE_REF].sort());
    // appEnvironment.ts ships the bare production ref as a literal; only hosts count.
    expect(extractSupabaseRefs(`const PROD_REF="${PROD_SUPABASE_REF}";x("${test}")`)).toEqual([TEST_SUPABASE_REF]);
    expect(extractBuildSha(`<meta name="build-sha" content="${"A1".repeat(20)}" />`)).toBe("a1".repeat(20));
    expect(extractBuildSha('<meta name="build-sha" content="%VITE_BUILD_SHA%" />')).toBeNull();
    expect(extractBuildSha('<meta name="build-sha" content="" />')).toBeNull();
    expect(referencedScripts('<script type="module" src="/assets/index-a.js"></script><link rel="modulepreload" href="/assets/v.js"><script src="https://cdn.example/x.js"></script>', "http://localhost:5173/", "http://localhost:5173"))
      .toEqual(["http://localhost:5173/assets/index-a.js", "http://localhost:5173/assets/v.js"]);
    expect(referencedScripts('import{a}from"./chunk-b.js";__vite__mapDeps(["assets/c.js"]);import("/src/x.tsx")', "http://localhost:5173/assets/index-a.js", "http://localhost:5173").sort())
      .toEqual(["http://localhost:5173/assets/c.js", "http://localhost:5173/assets/chunk-b.js", "http://localhost:5173/src/x.tsx"]);
  });
  it("probes a built preview through its chunks and a dev server through the client module", async () => {
    const origin = "http://localhost:4173";
    const site = (files) => async (url) => { if (url in files) return files[url]; throw new Error("404"); };
    const built = await probeTarget({ origin, fetchText: site({
      [`${origin}/`]: `<meta name="build-sha" content="${"b".repeat(40)}"><script type="module" src="/assets/index.js"></script>`,
      [`${origin}/src/integrations/supabase/client.ts`]: "<!doctype html>",
      [`${origin}/assets/index.js`]: 'import"./auth.js";',
      [`${origin}/assets/auth.js`]: `createClient("https://${TEST_SUPABASE_REF}.supabase.co","key")`,
    }) });
    expect(built).toEqual({ supabaseRefs: [TEST_SUPABASE_REF], buildSha: "b".repeat(40), filesScanned: 3 });
    expect(verifyTestTarget(built)).toEqual({ ok: true, ref: TEST_SUPABASE_REF });
    const dev = await probeTarget({ origin, fetchText: site({
      [`${origin}/`]: '<meta name="build-sha" content="">',
      [`${origin}/src/integrations/supabase/client.ts`]: `const __vite_import_meta_env__ = {"VITE_SUPABASE_URL": "https://${PROD_SUPABASE_REF}.supabase.co"};`,
    }) });
    expect(dev.buildSha).toBeNull();
    expect(verifyTestTarget(dev)).toEqual({ ok: false, problem: expect.stringMatching(/PRODUCTION/) });
    const blind = await probeTarget({ origin, fetchText: site({ [`${origin}/`]: "<html>Vercel login</html>" }) });
    expect(verifyTestTarget(blind)).toEqual({ ok: false, problem: expect.stringMatching(/^Không đọc được/) });
    expect(verifyTestTarget({ supabaseRefs: [TEST_SUPABASE_REF, "abcdefghijklmnopqrst"] }).ok).toBe(false);
    expect(verifyTestTarget({ supabaseRefs: ["abcdefghijklmnopqrst"] }).ok).toBe(false);
    // Bounded crawl: an endless chain stops at maxFiles without a verdict.
    const endless = await probeTarget({ origin, maxFiles: 5, fetchText: async (url) => url === `${origin}/` ? '<script src="/assets/0.js"></script>' : `import"./${Number(url.match(/(\d+)\.js$/)?.[1] ?? 0) + 1}.js";` });
    expect(endless.filesScanned).toBe(5);
    expect(verifyTestTarget(endless).ok).toBe(false);
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
function writeReceipt({ git, put }, name, patch = {}, { commit: doCommit = true } = {}) {
  const commit = git("rev-parse", "HEAD");
  const r = createLocalE2eReceipt({
    commit, fleetTree: git("rev-parse", "HEAD:.e2e-fleet"), target: { kind: "loopback", origin: "http://127.0.0.1:5173" }, ...IDENTITY,
    runner: { node: process.version, playwright: "1.61.1" }, runId: "0b6c7a52-6a55-4b40-9a59-3b1f4bb2a002",
    // Committer time is floored to seconds, so "now" is never before the commit.
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), specs: [row(SPEC_A)],
  });
  put(`${LOCAL_E2E_EVIDENCE_DIR}/${name}.json`, JSON.stringify({ ...r, ...patch }));
  git("add", "-A");
  if (doCommit) git("commit", "-qm", `receipt ${name}`);
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
  it("staged mode reads receipt and fleet tree from the index, not from HEAD", () => {
    const fx = gitFixture(); const base = fx.git("rev-parse", "HEAD");
    fx.put(SPEC_A, "test('a2', () => {});\n"); fx.git("add", "-A"); fx.git("commit", "-qm", "spec");
    // Receipt only staged (gate:truoc-push before the receipt commit): accepted.
    writeReceipt(fx, "staged-only", {}, { commit: false });
    expect(fleetBlocked(planFromGit({ root: fx.root, mode: "staged", base, head: "HEAD" }))).toBe(false);
    expect(fleetBlocked(planFromGit({ root: fx.root, mode: "commit", base, head: "HEAD" }))).toBe(true);
    fx.git("commit", "-qm", "receipt");
    // Spec edited in the index after the run: the staged fleet tree differs, so blocked.
    fx.put(SPEC_A, "test('a3', () => {});\n"); fx.git("add", SPEC_A);
    expect(fleetBlocked(planFromGit({ root: fx.root, mode: "staged", base, head: "HEAD" }))).toBe(true);
  });
});
