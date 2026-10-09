import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createGatePlan, planFromGit, isCosmeticChange } from "../lib/gate-plan.mjs";
import { GATE_REGISTRY, getGate, isOfflineBrowserSelection } from "../lib/gate-registry.mjs";

const snapshot = { base: "base", head: "head", tree: "tree", source: "fixture" };
const changed = (path, before, after, extra = {}) => ({ path, before, after, status: "M", ...extra });
const plan = (changes, extra = {}) => createGatePlan({ changes, snapshot, ...extra });
const button = 'export const Button = () => <button onClick={openDialog} className="p-2">Mở</button>;';

describe("scope is a conservative proof, never a filename shortcut", () => {
  it('requires Android build/native evidence and keeps bank inbox browser fixtures bounded', () => {
    const android = plan([changed('extensions/sms-webhook/android/app/src/main/java/vn/ihome/smsgateway/GatewayWork.java', 'before', 'after')]);
    expect(android.requiredExternalWorkflows).toContainEqual(expect.objectContaining({
      workflow: '.github/workflows/android-gateway.yml', jobs: ['build'], suiteIds: expect.arrayContaining(['android-gateway', 'android-device']),
    }));
    const fixture = '.e2e-fleet/specs/bank-events.spec.ts';
    const browser = plan([changed(fixture, 'before', 'after')], { testFiles: [fixture] });
    expect(browser.gateIds).toContain('suite:e2e-bank-events');
    expect(isOfflineBrowserSelection('e2e-bank-events', [fixture])).toBe(true);
    expect(isOfflineBrowserSelection('e2e-bank-events', [fixture, '.e2e-fleet/specs/real-bank.spec.ts'])).toBe(false);
    expect(isOfflineBrowserSelection('e2e-fleet', [fixture])).toBe(false);
  });
  it("executes the exact offline product suite without substituting it for money or live UI evidence", () => {
    const file = '.e2e-fleet/specs/personal-finance-product.spec.ts';
    const p = plan([changed(file, 'old test', 'new test'), changed('src/components/personal-finance/CompanyFinance.tsx', button, button.replace('openDialog', 'savePayment'))], { testFiles: [file] });
    expect(p.unavailable.filter((item) => item.suiteId.startsWith('e2e-'))).toEqual([]);
    expect(p.gateIds).toEqual(expect.arrayContaining(['suite:e2e-personal-finance-product', 'reconcile-money', 'reconcile-money-v2']));
    expect(p.browserRequirements).toContainEqual(expect.objectContaining({ status: 'required', paths: ['src/components/personal-finance/CompanyFinance.tsx'] }));
    const gate = getGate('suite:e2e-personal-finance-product', p);
    expect(gate.args).toContain(file);
    expect(gate.args).not.toContain('--grep');
    const real = '.e2e-fleet/specs/personal-finance-real.spec.ts';
    expect(plan([changed(real, 'old test', 'new test')], { testFiles: [real] }).unavailable).toContainEqual(expect.objectContaining({ suiteId: 'e2e-fleet' }));
    for (const [id, files] of [['e2e-fleet', [file]], ['e2e-personal-finance-product', [real]], ['e2e-personal-finance-product', [file, real]], ['e2e-personal-finance-product', []]]) {
      expect(isOfflineBrowserSelection(id, files)).toBe(false);
    }
    expect(() => getGate('suite:e2e-personal-finance-product', { suiteSelections: [{ id: 'e2e-personal-finance-product', files: [file, real] }] })).toThrow(/approved offline/);
  });
  it("retains infrastructure review, published-doc build and changed-test inventory obligations", () => {
    expect(plan([changed("infra/network-center-worker/src/index.ts", "a", "b")]).crossReview).toBe(true);
    expect(plan([changed("docs/huong-dan-su-dung/test.md", "a", "b")]).gateIds).toContain("docs-build");
    expect(plan([changed("scripts/__tests__/gate-plan.test.mjs", "a", "b")], { testFiles: ["scripts/__tests__/gate-plan.test.mjs"] }).generatorIds).toContain("generate-repository-inventory");
  });
  it("CI runs a large app-unit selection and the timezone check as required parallel parts", () => {
    const many = Array.from({ length: 250 }, (_, i) => `src/lib/__tests__/part${String(i).padStart(3, "0")}.test.ts`);
    const ci = plan([], { full: true, environment: "ci", testFiles: many });
    const parts = ["suite:app-unit-shard-1", "suite:app-unit-shard-2", "suite:app-unit-shard-3"];
    expect(ci.gateIds).toEqual(expect.arrayContaining([...parts, "check-timezone-shard-1", "check-timezone-shard-4"]));
    expect(ci.gateIds).not.toContain("suite:app-unit");
    expect(ci.requiredJobs).toEqual(expect.arrayContaining(["vitest-tests", "vitest-tests-2", "vitest-tests-3", "timezone-gate", "timezone-gate-4"]));
    // Every part resolves to its own job; no job runs two parts of the same selection.
    expect(new Set(parts.map((id) => getGate(id, ci).job)).size).toBe(3);
    const local = plan([], { full: true, environment: "local", testFiles: many });
    expect(local.gateIds).toContain("suite:app-unit");
    expect(local.gateIds.filter((id) => id.startsWith("suite:app-unit-shard"))).toEqual([]);
    const small = plan([], { full: true, environment: "ci", testFiles: many.slice(0, 199) });
    expect(small.gateIds).toContain("suite:app-unit");
    expect(small.requiredJobs).not.toContain("vitest-tests-2");
  });
  it("a policy that names a single part still requires every part of its group", () => {
    const riskMap = JSON.parse(readFileSync(new URL("../../tooling/risk-map.json", import.meta.url), "utf8"));
    const narrowed = { ...riskMap, gateProfiles: { ...riskMap.gateProfiles, "docs-only": [...riskMap.gateProfiles["docs-only"], "check-timezone-shard-2"] } };
    const p = plan([changed("docs/he-thong/24-platform-delivery.md", "a", "b")], { riskMap: narrowed });
    expect(p.gateIds.filter((id) => id.startsWith("check-timezone-shard-"))).toEqual(["check-timezone-shard-1", "check-timezone-shard-2", "check-timezone-shard-3", "check-timezone-shard-4"]);
    expect(p.requiredJobs).toEqual(expect.arrayContaining(["timezone-gate", "timezone-gate-2", "timezone-gate-3", "timezone-gate-4"]));
  });
  it("new app modules retain strict checks regardless of UI scope", () => {
    const p = plan([changed("src/components/quick-entry/NewView.tsx", "", button, { status: "A" })]);
    expect(p.gateIds).toEqual(expect.arrayContaining(["check-new-modules-strict", "check-strict-islands"]));
  });
  it("live guards remain reachable from schema or money obligations", () => {
    const p = plan([changed("supabase/migrations/20261006000001_test.sql", "", "alter table public.rooms add column example text;"), changed("src/hooks/useInvoices.ts", "savePayment(1)", "savePayment(2)")]);
    for (const gate of Object.values(GATE_REGISTRY).filter((g) => g.evidenceClass === "live")) expect(p.gateIds, gate.id).toContain(gate.id);
  });
  it("prepares generated sources before views and checks which consume them", () => {
    const p = plan([changed("supabase/migrations/20261006000001_test.sql", "", "select 1;", { status: "A" })]);
    const index = (id) => p.generatorIds.indexOf(id);
    expect(index("gen-supabase-types")).toBeLessThan(index("normalize-supabase-types"));
    expect(index("generate-rpc-surface")).toBeLessThan(index("generate-docs-views"));
    expect(index("generate-repository-inventory")).toBeLessThan(index("generate-docs-views"));
    expect(index("generate-docs-views")).toBeLessThan(index("check-doc-counts"));
  });
  it("ordinary docs avoid application build, DB generators and application tests", () => {
    const p = plan([changed("docs/he-thong/rooms.md", "old", "new")]);
    expect(p.profiles).toEqual(["docs-only"]);
    expect(p.gateIds).toContain("check-docs");
    expect(p.gateIds).not.toContain("app-build");
    expect(p.gateIds).not.toContain("reconcile-money");
    expect(p.generatorIds).not.toContain("gen-supabase-types");
  });
  it("prose and synthetic test literals do not demand a live database", () => {
    const p = plan([changed("docs/engineering/note.md", "before", "Use organization_id, jwt and savePayment() for documentation.")]);
    expect(p.profiles).toEqual(["docs-only"]);
    const t = plan([changed("scripts/__tests__/gate-plan.test.mjs", "before", "const fixture = 'savePayment income_expenses organization_id';")], { testFiles: ["scripts/__tests__/gate-plan.test.mjs"] });
    expect(t.gateIds).not.toContain("reconcile-money");
    expect(t.gateIds).not.toContain("measure-org-leak");
    expect(plan([changed("src/components/invoices/README.md", "old", "new")]).profiles).toEqual(["docs-only"]);
    expect(plan([changed("infra/network-center-worker/README.md", "old", "new")]).fullFallback).toBe(false);
  });
  it("a JSX label/spacing edit is cosmetic but handler changes are not", () => {
    const p = "src/components/quick-entry/QuickEntryComposer.tsx";
    expect(isCosmeticChange(changed(p, button, button.replace("Mở", "Mở nhanh").replace("p-2", "p-3")))).toBe(true);
    expect(isCosmeticChange(changed(p, button, button.replace("openDialog", "savePayment")))).toBe(false);
    expect(isCosmeticChange(changed(p, button, button.replace("p-2", "hidden")))).toBe(false);
    expect(isCosmeticChange(changed(p, button.replace("p-2", "h-10"), button.replace("p-2", "h-0")))).toBe(false);
  });
  it("a changed payment argument is financial; an unrelated dialog handler stays scoped", () => {
    const path = "src/components/quick-entry/QuickEntryComposer.tsx";
    const before = 'const submit = () => savePayment(10); export const Button = () => <button onClick={openDialog}>Mở</button>;';
    expect(plan([changed(path, before, before.replace("10", "20"))]).gateIds).toContain("reconcile-money-v2");
    expect(plan([changed(path, before, before.replace("openDialog", "openHelp"))]).gateIds).not.toContain("reconcile-money-v2");
  });
  it("changing a leaf script runs its owned suite without building unrelated UI", () => {
    const p = plan([changed("scripts/check-docs.mjs", "const old = 1;", "const old = 2;")], { testFiles: ["scripts/__tests__/check-docs.test.mjs"] });
    expect(p.fullFallback).toBe(false);
    expect(p.gateIds).toContain("suite:app-unit");
    expect(p.gateIds).not.toContain("app-build");
  });
  it("verification tooling naming permission gates does not demand a live database", () => {
    for (const path of ["scripts/check-agent-contract.mjs", "scripts/kiem-nhanh-truoc-push.mjs", "scripts/lib/gate-plan.mjs", "scripts/lib/gate-registry.mjs"]) {
      const p = plan([changed(path, "const ids = [];", "const ids = ['check-permission-catalog', 'policy', 'income_expenses'];")]);
      expect(p.profiles, path).not.toContain("money-auth");
      expect(p.gateIds, path).not.toContain("measure-org-leak");
      expect(p.gateIds, path).not.toContain("reconcile-money");
      expect(p.gateIds, path).not.toContain("check-realtime-descriptors");
    }
  });
  it("live publication verification follows realtime/schema inputs", () => {
    expect(plan([changed("src/lib/realtime/syncTables.ts", "const tables = ['one'];", "const tables = ['two'];")]).gateIds).toContain("check-realtime-descriptors");
    expect(plan([changed("supabase/migrations/20261006000001_test.sql", "", "alter publication supabase_realtime add table public.test;")]).gateIds).toContain("check-realtime-descriptors");
  });
  it("an affected UI viewport remains an explicit browser requirement without a mapped spec", () => {
    const p = plan([changed("src/components/quick-entry/QuickEntryComposer.tsx", button, button.replace("Mở", "Mở nhanh"))]);
    expect(p.browserRequirements).toContainEqual(expect.objectContaining({ status: "required", viewports: ["affected"] }));
    const mixed = plan([changed("src/components/quick-entry/QuickEntryComposer.tsx", button, button.replace("Mở", "Mở nhanh")), changed("public/demos/personal-finance/app.js", "old()", "newAction()")], { testFiles: [".e2e-fleet/specs/personal-finance-demo.spec.ts"] });
    expect(mixed.browserRequirements).toContainEqual(expect.objectContaining({ status: "required", paths: ["src/components/quick-entry/QuickEntryComposer.tsx"] }));
    const shared = plan([changed("src/components/ui/button.tsx", button, button.replace("p-2", "p-3"))]);
    expect(shared.browserRequirements).toContainEqual(expect.objectContaining({ viewports: ["desktop", "mobile"] }));
  });
  it("a payment handler in an otherwise ordinary component escalates money", () => {
    const p = plan([changed("src/components/quick-entry/QuickEntryComposer.tsx", button, button.replace("openDialog", "savePayment"))]);
    expect(p.profiles).toContain("money-auth");
    expect(p.gateIds).toEqual(expect.arrayContaining(["reconcile-money", "reconcile-money-v2"]));
  });
  it("comments naming payment do not create or remove financial evidence", () => {
    const p = plan([changed("src/components/quick-entry/QuickEntryComposer.tsx", button, `// savePayment()\n${button.replace("Mở", "Mở nhanh")}`)]);
    expect(p.profiles).toContain("cosmetic-ui");
    expect(p.profiles).not.toContain("money-auth");
  });
  it("unknown files, policy changes and explicit full select full active, never deferred", () => {
    for (const changes of [[changed("unmapped/opaque.xyz", "a", "b")], [changed("tooling/risk-map.json", "{}", "{}")]]) {
      const p = plan(changes);
      expect(p.fullFallback).toBe(true);
      expect(p.gateIds).toContain("app-build");
      expect(p.gateIds.some((id) => id.includes("copilot"))).toBe(false);
      expect(p.deferred.length).toBeGreaterThan(0);
    }
    expect(plan([changed("docs/README.md", "a", "b")], { full: true }).fullFallback).toBe(true);
  });
  it("renaming a sensitive file into docs keeps the old path obligations", () => {
    const p = plan([changed("docs/archive/invoices.ts", "old", "new", { status: "R100", oldPath: "src/hooks/useInvoices.ts" })]);
    expect(p.gateIds).toEqual(expect.arrayContaining(["reconcile-money", "reconcile-money-v2"]));
  });
  it("schema and auth combine duties and require live evidence", () => {
    const p = plan([changed("supabase/migrations/202610060001_policy.sql", "", "CREATE POLICY safe ON public.rooms USING (organization_id = auth.uid());", { status: "A" })]);
    expect(p.profiles).toEqual(expect.arrayContaining(["schema", "money-auth"]));
    expect(p.gateIds).toEqual(expect.arrayContaining(["check-migration-provenance", "test-cross-tenant"]));
    expect(p.generatorIds).toContain("gen-supabase-types");
  });
  it("deferred tests are never selected while shared migration tests stay active", () => {
    const p = plan([changed("tooling/test-matrix.json", "a", "b")], { testFiles: ["src/copilot/__tests__/foo.test.ts", "src/lib/__tests__/copilotSafetyMigration.test.ts"] });
    const files = p.suiteSelections.flatMap((s) => s.files);
    expect(files).toContain("src/lib/__tests__/copilotSafetyMigration.test.ts");
    expect(files).not.toContain("src/copilot/__tests__/foo.test.ts");
  });
  it("full core scope does not steal a Node 22 package workflow", () => {
    const p = plan([changed("tooling/risk-map.json", "{}", "{}")], { testFiles: ["infra/network-center-worker/src/foo.test.ts", "supabase/functions/network-watchdog/index.test.ts"] });
    expect(p.requiredExternalWorkflows).toEqual([]);
    expect(p.unavailable).toEqual([]);
  });
  it("direct external package changes explicitly require its original workflow", () => {
    const p = plan([changed("infra/network-center-worker/src/main.ts", "a", "b")], { testFiles: ["infra/network-center-worker/src/foo.test.ts"] });
    expect(p.requiredExternalWorkflows).toContainEqual(expect.objectContaining({ workflow: ".github/workflows/network-center-validation.yml", suiteIds: ["network-center-worker"] }));
    expect(p.gateIds).not.toContain("suite:network-center-worker");
    expect(p.unavailable).toEqual([]);
  });
});

const repoRoot = new URL("../../", import.meta.url);
const gitRepo = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
function historicalChanges(sha) {
  return gitRepo(["diff", "--name-only", `${sha}^`, sha]).trim().split(/\r?\n/).map((path) => changed(path, gitRepo(["show", `${sha}^:${path}`]), gitRepo(["show", `${sha}:${path}`])));
}
describe("real historical changes", () => {
  it("fd1ac609 changes Lucide glyphs only, not route or permission", () => {
    for (const path of ["src/components/layout/Sidebar.tsx", "src/pages/home/launcherTiles.ts"]) {
      const c = changed(path, gitRepo(["show", `fd1ac609^:${path}`]), gitRepo(["show", `fd1ac609:${path}`]));
      expect(isCosmeticChange(c), path).toBe(true);
      const p = plan([c]);
      expect(p.profiles).toContain("cosmetic-ui");
      expect(p.fullFallback).toBe(false);
      expect(p.gateIds).not.toContain("reconcile-money");
    }
  });
  it("the complete 872ec823 commit runs only offline demo, docs and secret checks", () => {
    const changes = historicalChanges("872ec823");
    expect(changes.map((c) => c.path)).toEqual([".e2e-fleet/specs/personal-finance-demo.spec.ts", "docs/prototypes/personal-finance.md", "public/demos/personal-finance/app.js", "public/demos/personal-finance/styles.css"]);
    const p = plan(changes, {
      testFiles: [".e2e-fleet/specs/personal-finance-demo.spec.ts", "src/hooks/quick-entry/__tests__/useQuickEntrySave.test.ts"],
    });
    expect(p.profiles).toContain("ui-behavior");
    expect(p.profiles).not.toContain("money-auth");
    expect(p.fullFallback).toBe(false);
    expect(p.suiteSelections.flatMap((s) => s.files)).toEqual([".e2e-fleet/specs/personal-finance-demo.spec.ts"]);
    expect(p.gateIds).toContain("suite:e2e-personal-finance-demo");
    expect(p.gateIds).toEqual(["check-baseline-doc", "check-doc-counts", "check-docs", "generate-docs-views", "secret-scan", "suite:e2e-personal-finance-demo"]);
    expect(p.unavailable).toEqual([]);
  });
  it("mixing the offline demo with a real payment handler keeps application and money gates", () => {
    const changes = [...historicalChanges("872ec823"), changed("src/components/quick-entry/QuickEntryComposer.tsx", button, button.replace("openDialog", "savePayment"))];
    const p = plan(changes, { testFiles: [".e2e-fleet/specs/personal-finance-demo.spec.ts", "src/hooks/quick-entry/__tests__/useQuickEntrySave.test.ts"] });
    expect(p.gateIds).toEqual(expect.arrayContaining(["app-build", "bundle-inventory", "check-ts-baseline", "reconcile-money", "reconcile-money-v2", "suite:e2e-personal-finance-demo"]));
  });
  it("mixing demo and a real cosmetic edit unions their scopes without the demo spec's app logic ratchets", () => {
    const changes = [...historicalChanges("872ec823"), changed("src/components/quick-entry/QuickEntryComposer.tsx", button, button.replace("p-2", "p-3"))];
    const p = plan(changes, { testFiles: [".e2e-fleet/specs/personal-finance-demo.spec.ts", "src/hooks/quick-entry/__tests__/useQuickEntrySave.test.ts"] });
    expect(p.gateIds).toEqual(expect.arrayContaining(["app-build", "bundle-inventory", "check-ts-baseline", "suite:e2e-personal-finance-demo", "suite:app-unit"]));
    expect(p.gateIds).not.toContain("check-strict-islands");
    expect(p.gateIds).not.toContain("check-route-guards");
    expect(p.gateIds).not.toContain("check-money-table-dml");
  });
  it("adding a real money RPC to an offline demo prevents the demo-only shortcut", () => {
    const path = "public/demos/personal-finance/app.js";
    const p = plan([changed(path, "function save() {}", "function save() { supabase.rpc('record_payment', { amount: 10 }); }")], { testFiles: [".e2e-fleet/specs/personal-finance-demo.spec.ts"] });
    expect(p.gateIds).toEqual(expect.arrayContaining(["reconcile-money", "reconcile-money-v2"]));
  });
});

const fixtures = [];
function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "ihome-gate-plan-")); fixtures.push(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put = (path, text) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
  git("init", "-q"); git("config", "user.name", "Gate fixture"); git("config", "user.email", "fixture@example.test"); git("config", "core.autocrlf", "false");
  put("docs/guide.md", "one");
  for (const file of ["tooling/risk-map.json", "tooling/test-matrix.json"]) put(file, readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"));
  git("add", "docs/guide.md", "tooling/risk-map.json", "tooling/test-matrix.json"); git("commit", "-qm", "base");
  return { root, git, put };
}
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("Git snapshot selection", () => {
  it("CI compares executed bytes instead of rejecting a legacy mixed-EOL blob reported dirty by Git", () => {
    const { root, git, put } = gitFixture();
    const path = 'supabase/migrations/legacy.sql'; const bytes = 'select 1;\r\nselect 2;\n';
    put('.gitattributes', '*.sql text eol=lf\n'); git('add', '.gitattributes');
    const object = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: bytes, encoding: 'utf8' }).trim();
    git('update-index', '--add', '--cacheinfo', '100644', object, path); put(path, bytes); git('commit', '-qm', 'legacy');
    expect(git('diff', '--name-only')).toContain(path);
    expect(planFromGit({ root, mode: 'commit', base: 'HEAD^', environment: 'ci' }).executionMismatches).toEqual([]);
    put(path, bytes + 'select 3;\n');
    expect(planFromGit({ root, mode: 'commit', base: 'HEAD^', environment: 'ci' }).executionMismatches).toContain(path);
  });
  it("binds external job display names to the workflow in the selected snapshot", () => {
    const { root, git, put } = gitFixture();
    put(".github/workflows/network-center-validation.yml", "jobs:\n  validate:\n    name: Verifiers, tests, build\n  worker-powershell-windows:\n    name: Worker PowerShell suites (Windows)\n");
    put("infra/network-center-worker/sample.test.ts", "test('fixture', () => {});");
    git("add", ".github/workflows/network-center-validation.yml", "infra/network-center-worker/sample.test.ts");
    const obligation = planFromGit({ root, mode: "staged" }).requiredExternalWorkflows[0];
    expect(obligation.jobIds).toEqual(["validate", "worker-powershell-windows"]);
    expect(obligation.jobs).toEqual(["Verifiers, tests, build", "Worker PowerShell suites (Windows)"]);
  });
  it("staged reads index bytes; unstaged payment and untracked files cannot masquerade as staged", () => {
    const { root, git, put } = gitFixture();
    put("docs/guide.md", "staged"); git("add", "docs/guide.md"); put("docs/guide.md", "unstaged"); put("other.txt", "untracked");
    const p = planFromGit({ root, mode: "staged" });
    expect(p.changedPaths).toEqual(["docs/guide.md"]);
    expect(p.snapshot.source).toBe("index");
    expect(p.executionMismatches).toContain("docs/guide.md");
    expect(p.profiles).toEqual(["docs-only"]);
  });
  it("explicit push before/after includes every commit, not only HEAD~1", () => {
    const { root, git, put } = gitFixture(); const base = git("rev-parse", "HEAD");
    put("src/hooks/useInvoices.ts", "export const savePayment = () => 1;"); git("add", "src/hooks/useInvoices.ts"); git("commit", "-qm", "money");
    put("docs/guide.md", "two"); git("add", "docs/guide.md"); git("commit", "-qm", "docs");
    const p = planFromGit({ root, mode: "commit", base, head: "HEAD", environment: "ci" });
    expect(p.changedPaths).toEqual(expect.arrayContaining(["src/hooks/useInvoices.ts", "docs/guide.md"]));
    expect(p.profiles).toContain("money-auth");
  });
  it("missing base falls back full; an invalid explicit base does not become empty safe diff", () => {
    const { root } = gitFixture();
    expect(planFromGit({ root, mode: "commit" }).fullFallback).toBe(true);
    expect(() => planFromGit({ root, mode: "commit", base: "missing-ref" })).toThrow();
  });
  it("deleting scope policy fails closed instead of using working-copy defaults", () => {
    const { root, git } = gitFixture(); git("rm", "tooling/risk-map.json");
    expect(() => planFromGit({ root, mode: "staged" })).toThrow(/policy/i);
  });
  it("untracked executable inputs are reported as different executed bytes", () => {
    const { root, put, git } = gitFixture(); put("docs/guide.md", "two"); git("add", "docs/guide.md");
    put("scripts/surprise.mjs", "export const surprise = 1;");
    expect(planFromGit({ root, mode: "staged" }).executionMismatches).toContain("scripts/surprise.mjs");
  });
});
