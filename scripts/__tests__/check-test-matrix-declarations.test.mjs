// Sổ cho ba phép kiểm khai báo mới của scripts/check-test-matrix.mjs.
//
// Bộ đột biến trên FILE THẬT (8 ca: job không tồn tại · mất expiry · expiry hết
// hạn · mất blockedFromCi · matrix bỏ cờ · matrix thừa cờ · CI thêm cờ · đổi tên
// bước ⇒ exit 3) đã chạy tay lúc thêm gate và bắt đủ 8/8. Không đưa nó vào đây
// vì nó ghi đè ci-gates.yml và test chạy song song sẽ giẫm lên nhau.
//
// Cái ghim ở đây là hai thứ dễ mục hơn: hàm bóc cờ `--exclude` (phần dễ viết sai
// nhất) và các bất biến khai báo mà gate dựa vào.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

import { coExcludeCuaBuoc, jobCuaWorkflow, lenhCuaBuoc, validateRegistrySuite, assignSuites, trackedTestFiles } from "../check-test-matrix.mjs";
import { selectionDigest } from '../lib/selected-vitest.mjs';
import { getGate } from '../lib/gate-registry.mjs';

const matrix = JSON.parse(readFileSync(new URL("../../tooling/test-matrix.json", import.meta.url), "utf8"));
const CI = ".github/workflows/ci-gates.yml";

describe('registry suite proof rejects false declarations', () => {
  const suite = { id: 'example', runner: 'node --test', ciJobs: [{ workflow: CI, job: 'quality-gates' }] };
  const doc = { jobs: { 'quality-gates': { steps: [{ run: 'node scripts/ci-run-gates.mjs --job quality-gates' }] } } };
  const gate = { id: 'suite:example', job: 'quality-gates', command: 'node', args: ['--test', 'scripts/example.test.mjs'] };
  const check = (patch = {}) => validateRegistrySuite({ suite, doc, files: ['scripts/example.test.mjs'], resolveGate: () => gate, ...patch });
  it('rejects missing executor, wrong job, wrong runner, missing files and extra files', () => {
    expect(check()).toEqual([]);
    expect(check({ doc: { jobs: {} } }).length).toBeGreaterThan(0);
    expect(check({ resolveGate: () => ({ ...gate, job: 'other' }) }).length).toBeGreaterThan(0);
    expect(check({ resolveGate: () => ({ ...gate, args: ['node_modules/vitest/vitest.mjs', 'run', 'scripts/example.test.mjs'] }) }).length).toBeGreaterThan(0);
    expect(check({ resolveGate: () => ({ ...gate, args: ['--test'] }) }).length).toBeGreaterThan(0);
    expect(check({ resolveGate: () => ({ ...gate, args: [...gate.args, 'scripts/extra.test.mjs'] }) }).length).toBeGreaterThan(0);
    expect(check({ files: [] }).length).toBeGreaterThan(0);
  });
  it('binds a bounded Vitest launcher to precisely the matrix-owned selection', () => {
    const files = ['src/example.test.ts'];
    const selected = { ...suite, id: 'app-unit', runner: 'vitest' };
    const args = ['scripts/run-selected-vitest.mjs', '--plan', '.gate-evidence/plan.json', '--selection-digest', selectionDigest(files)];
    // Stub resolver covers the whole-selection launcher only; real parts are checked below.
    const checkSelection = (override = args) => check({ suite: selected, files, registry: {}, resolveGate: () => ({ ...gate, args: override }) });
    expect(checkSelection()).toEqual([]);
    expect(checkSelection([...args.slice(0, -1), selectionDigest(['src/other.test.ts'])]).length).toBeGreaterThan(0);
    expect(checkSelection([args[0], '--plan', 'different.json', ...args.slice(3)]).length).toBeGreaterThan(0);
    expect(checkSelection([...args, '--extra']).length).toBeGreaterThan(0);
    expect(checkSelection(['scripts/other-launcher.mjs', ...args.slice(1)]).length).toBeGreaterThan(0);
  });
});

describe("coExcludeCuaBuoc", () => {
  const dung = (run, name = "B") => yaml.load(`jobs:\n  j:\n    steps:\n      - name: ${name}\n        run: ${run}\n`);

  it("bóc được cờ trong chuỗi gấp `run: >` — đây là dạng thật trong ci-gates.yml", () => {
    const doc = dung(">\n          npx vitest run src\n          --exclude 'a/**'\n          --exclude 'b/**'");
    expect(coExcludeCuaBuoc(doc, "B")).toEqual(["a/**", "b/**"]);
  });

  it("nhận cả nháy kép và không nháy", () => {
    const doc = dung(`npx vitest --exclude "a/**" --exclude b/**`);
    expect(coExcludeCuaBuoc(doc, "B")).toEqual(["a/**", "b/**"]);
  });

  it("bước KHÔNG TỒN TẠI trả null, KHÔNG trả [] — hai thứ này khác nhau", () => {
    // Nếu trả [] thì đổi tên bước sẽ đọc thành "CI không loại gì" và gate im
    // lặng bỏ qua phép đối chiếu. Gate xử null bằng exit 3 chính vì vậy.
    expect(coExcludeCuaBuoc(dung("npx vitest --exclude 'a/**'"), "Ten khac")).toBeNull();
  });

  it("bước có thật nhưng không có cờ nào trả [] — phân biệt được với null", () => {
    expect(coExcludeCuaBuoc(dung("npx vitest run src"), "B")).toEqual([]);
  });
});

describe("jobCuaWorkflow", () => {
  it("đọc được job của ci-gates.yml", () => {
    const jobs = jobCuaWorkflow(CI);
    expect(jobs).not.toBeNull();
    expect(jobs.has("quality-gates")).toBe(true);
  });

  it("file không tồn tại trả null (không ném, không trả tập rỗng giả vờ hợp lệ)", () => {
    expect(jobCuaWorkflow(".github/workflows/khong-co-that.yml")).toBeNull();
  });
});

describe("lenhCuaBuoc", () => {
  const doc = yaml.load("jobs:\n  demo:\n    steps:\n      - name: Controlled\n        run: node --test a.test.mjs b.test.mjs\n");

  it("trả đúng lệnh của step trong đúng job", () => {
    expect(lenhCuaBuoc(doc, "demo", "Controlled")).toBe("node --test a.test.mjs b.test.mjs");
  });

  it("trả null nếu job hoặc step không tồn tại", () => {
    expect(lenhCuaBuoc(doc, "other", "Controlled")).toBeNull();
    expect(lenhCuaBuoc(doc, "demo", "Other")).toBeNull();
  });
});

describe("bất biến khai báo của test-matrix.json", () => {
  it("mọi suite đều khai ciJobs — thiếu là gate không biết đối chiếu vào đâu", () => {
    for (const s of matrix.suites) {
      expect(Array.isArray(s.ciJobs), `${s.id} phải có ciJobs`).toBe(true);
    }
  });

  it("suite không chạy CI phải có reason + expiry + exitCondition", () => {
    for (const s of matrix.suites.filter((x) => x.status !== 'deferred' && (x.ciJobs ?? []).length === 0)) {
      expect(s.blockedFromCi?.reason?.length, `${s.id}`).toBeGreaterThan(29);
      expect(s.blockedFromCi?.expiry, `${s.id}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.blockedFromCi?.exitCondition, `${s.id}`).toBeTruthy();
    }
  });

  it("app-unit registry executes precisely the matrix-owned files", () => {
    const s = matrix.suites.find((x) => x.id === "app-unit");
    const doc = yaml.load(readFileSync(new URL(`../../${CI}`, import.meta.url), "utf8"));
    const files = assignSuites(trackedTestFiles(matrix.ignore), matrix.suites).bySuite.get(s.id);
    expect(files.length).toBeGreaterThan(100);
    expect(validateRegistrySuite({ suite: s, doc, files })).toEqual([]);
  });

  it("full root Vitest parts each have one independent owner with its own pinned installation", () => {
    const suite = matrix.suites.find((s) => s.id === "app-unit");
    const doc = yaml.load(readFileSync(new URL(`../../${CI}`, import.meta.url), "utf8"));
    // Part 1 stays in vitest-tests; parts 2..3 run beside it when CI splits a large selection.
    expect(suite.ciJobs).toEqual(["vitest-tests", "vitest-tests-2", "vitest-tests-3"].map((job) => ({ workflow: CI, job })));
    const runtimes = JSON.parse(readFileSync(new URL("../../tooling/runtime-matrix.json", import.meta.url), "utf8"));
    for (const { job: id } of suite.ciJobs) {
      const job = doc.jobs[id];
      expect(job, `declared Vitest owner ${id} must exist`).toBeDefined();
      // Waiting for `preflight` (~10 s, reads `pr_da_xanh`) is allowed since 01/10/2026;
      // waiting for quality-gates or another part is not.
      expect([job.needs].flat(), "Vitest must not wait for quality-gates").not.toContain("quality-gates");
      expect([undefined, "preflight"]).toContain(job.needs);
      const run = lenhCuaBuoc(doc, id, 'Execute selected gates and write receipts');
      expect(run, "declared Vitest owner must execute its test step").not.toBeNull();
      expect(run).toBe(`node scripts/ci-run-gates.mjs --job ${id}`);
      const owners = Object.values(doc.jobs).filter((candidate) =>
        candidate.steps?.some((step) => step.run === `node scripts/ci-run-gates.mjs --job ${id}`));
      expect(owners).toHaveLength(1);
      const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout.with["fetch-depth"]).toBe(0);
      expect(checkout.with["persist-credentials"]).toBe(false);
      const node = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
      expect(node.with["node-version"]).toBe(runtimes.workflows.find((entry) => entry.path === CI).node);
      expect(node.with.cache).toBe("npm");
      expect(job.steps.some((step) => step.run?.trim() === "npm ci")).toBe(true);
    }
  });

  it("a CI part that is undeclared, unexecuted or runs another command is rejected", () => {
    const s = matrix.suites.find((x) => x.id === "app-unit");
    const doc = yaml.load(readFileSync(new URL(`../../${CI}`, import.meta.url), "utf8"));
    const files = assignSuites(trackedTestFiles(matrix.ignore), matrix.suites).bySuite.get(s.id);
    const undeclared = { ...s, ciJobs: s.ciJobs.filter((entry) => entry.job !== "vitest-tests-3") };
    expect(validateRegistrySuite({ suite: undeclared, doc, files })).toContain("app-unit: shard job vitest-tests-3 is not declared in ciJobs");
    const withoutJob = { ...doc, jobs: { ...doc.jobs, "vitest-tests-2": { steps: [] } } };
    expect(validateRegistrySuite({ suite: s, doc: withoutJob, files })).toContain("app-unit: missing registry executor in shard job vitest-tests-2");
    const resolveGate = (id, plan) => { const gate = getGate(id, plan); return id.endsWith("-shard-2") ? { ...gate, args: gate.args.slice(0, -2) } : gate; };
    expect(validateRegistrySuite({ suite: s, doc, files, resolveGate })).toContain("app-unit: shard 2/3 runs a different command");
  });

  it("suite có ciCommandStep khai đúng lệnh đang chạy trong workflow", () => {
    for (const s of matrix.suites.filter((suite) => suite.status !== 'deferred' && suite.ciExecutor !== 'gate-registry' && suite.ciCommandStep)) {
      const target = s.ciJobs[0];
      const doc = yaml.load(readFileSync(new URL(`../../${target.workflow}`, import.meta.url), "utf8"));
      expect(lenhCuaBuoc(doc, target.job, s.ciCommandStep), s.id).toBe(s.command);
    }
  });

  it("chống-xanh-rỗng: đủ 5 suite và bước Vitest loại ít nhất 9 đường", () => {
    // Sàn này tồn tại vì hai ca trên vẫn xanh khi cả hai phía cùng rỗng.
    // Hạ 9→5 và 12→9 ngày 30/08/2026: xóa OpenClaw rút 6 suite + 3 cờ exclude —
    // teo THẬT do xóa hệ con, không phải hai phía cùng rỗng.
    expect(matrix.suites.length).toBeGreaterThanOrEqual(5);
    expect(matrix.suites.find((x) => x.id === "app-unit").excludes.length).toBeGreaterThanOrEqual(9);
  });
});
