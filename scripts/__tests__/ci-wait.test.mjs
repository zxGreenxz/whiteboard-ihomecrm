// Sổ cho scripts/ci-wait.mjs: chờ CI một commit mà KHÔNG BAO GIỜ ghi lên GitHub.
import { describe, expect, it } from "vitest";

import { choCi, dongRun, jobDo, phanLoaiRuns } from "../ci-wait.mjs";

const SHA = "a".repeat(40);
const run = (id, extra = {}) => ({ id, run_number: id, name: "CI Gates", path: ".github/workflows/ci-gates.yml", head_branch: "main", event: "push", head_sha: SHA, status: "completed", conclusion: "success", ...extra });

describe("phân loại run", () => {
  it("PR, schedule và run huỷ đã có run sau chỉ được liệt kê, không quyết định", () => {
    const runs = [run(1, { conclusion: "cancelled" }), run(2), run(3, { event: "pull_request", head_branch: "feature/x", conclusion: "failure" }), run(4, { event: "schedule", conclusion: "failure" }), run(5, { path: "other.yml", status: "in_progress", conclusion: null })];
    const kq = phanLoaiRuns(runs);
    expect(kq.thamQuyen.map((r) => r.id)).toEqual([2, 5]);
    expect(kq.khac.map((r) => r.id)).toEqual([1, 3, 4]);
    expect(kq.chuaXong.map((r) => r.id)).toEqual([5]);
    expect(kq.do).toEqual([]);
    expect(dongRun(runs[2], false)).toContain("không tính");
    expect(dongRun(runs[4], true)).toMatch(/^⏳/);
  });

  it("in job đỏ cùng bước đỏ; job xanh/bỏ qua không in", () => {
    expect(jobDo([
      { name: "security-gates", status: "completed", conclusion: "failure", steps: [{ name: "Execute", conclusion: "failure" }, { name: "Upload", conclusion: "success" }] },
      { name: "gate-aggregate", status: "completed", conclusion: "cancelled", steps: [] },
      { name: "quality-gates", status: "completed", conclusion: "success", steps: [] },
      { name: "reconcile-money", status: "completed", conclusion: "skipped", steps: [] },
      { name: "vitest-tests", status: "in_progress", conclusion: null, steps: [] },
    ])).toEqual(["security-gates (failure) › Execute", "gate-aggregate (cancelled)"]);
  });
});

describe("choCi", () => {
  function harness(timeline, { busy = [], jobs = [] } = {}) {
    let time = 0;
    const paths = [];
    const logs = [];
    const request = async (path) => {
      paths.push(path);
      if (path.includes("branch=main&status=")) return { workflow_runs: path.includes("in_progress") ? busy : [] };
      if (path.includes("/jobs?")) return { total_count: jobs.length, jobs };
      if (path.startsWith(`/repos/o/r/actions/runs?head_sha=${SHA}`)) {
        const runs = timeline.length > 1 ? timeline.shift() : timeline[0];
        if (runs instanceof Error) throw runs;
        return { total_count: runs.length, workflow_runs: runs };
      }
      throw new Error(`Unexpected ${path}`);
    };
    const go = (waitMs = 120) => choCi({ repo: "o/r", sha: SHA, token: "fixture", request, waitMs, pollMs: 30, now: () => time, sleep: async (ms) => { time += ms; }, log: (line) => logs.push(line) });
    return { go, paths, logs, clock: () => time };
  }

  it("chờ tới khi mọi run có thẩm quyền xong; PR đỏ không chặn", async () => {
    const h = harness([[], [run(1, { status: "in_progress", conclusion: null })], [run(1), run(2, { event: "pull_request", head_branch: "x", conclusion: "failure" })]]);
    const result = await h.go();
    expect(result.code).toBe(0);
    expect(h.clock()).toBe(60);
    // Chỉ đọc: mọi lời gọi là đường GET của danh sách run/job.
    expect(h.paths.every((p) => p.startsWith("/repos/o/r/actions/runs"))).toBe(true);
  });

  it("run đỏ ⇒ 1 và in job/bước đỏ", async () => {
    const jobs = [{ name: "security-gates", status: "completed", conclusion: "failure", steps: [{ name: "Execute selected gates", conclusion: "failure" }] }];
    const h = harness([[run(1, { conclusion: "failure" })]], { jobs });
    const result = await h.go();
    expect(result.code).toBe(1);
    expect(h.logs.join("\n")).toContain("security-gates (failure) › Execute selected gates");
  });

  it.each([
    ["chưa có run nào", [[]]],
    ["run còn chạy tới hạn", [[run(1, { status: "in_progress", conclusion: null })]]],
    ["chỉ có run PR", [[run(1, { event: "pull_request", head_branch: "x" })]]],
  ])("%s ⇒ 3, không phải xanh", async (_name, timeline) => {
    const h = harness(timeline);
    expect((await h.go()).code).toBe(3);
    expect(h.clock()).toBe(120);
  });

  it("lỗi API ⇒ 3 ngay", async () => {
    expect((await harness([new Error("GitHub API 403")]).go()).code).toBe(3);
  });

  it("cảnh báo khi main đang có run của commit khác", async () => {
    const h = harness([[run(1)]], { busy: [run(9, { head_sha: "b".repeat(40), status: "in_progress" }), run(10, { status: "in_progress" })] });
    await h.go();
    expect(h.logs[0]).toMatch(/^⚠ 1 run khác đang chạy\/chờ trên main \(bbbbbbbb\)/);
  });
});
