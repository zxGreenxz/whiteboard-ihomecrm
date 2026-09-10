// Sổ cho phần đánh giá của scripts/promote-to-production.mjs.
//
// Ca quan trọng nhất: một bước FAIL bên trong một job `continue-on-error` làm
// GitHub đặt `conclusion: failure` cho BƯỚC nhưng `success` cho JOB. Mọi công cụ
// đọc kết luận ở mức job — kể cả trang Checks của GitHub — hiển thị màu xanh.
//
// Repo này CÓ dùng continue-on-error (đăng ký ở tooling/known-gaps.yaml), nên
// đây không phải rủi ro lý thuyết: nếu promote đọc mức job thì nó sẽ phát hành
// một commit có gate đỏ và không ai thấy gì bất thường.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { danhGiaJobs, locRunsDanhGia, readGateEvidence, waitForGateEvidence } from "../promote-to-production.mjs";

const buoc = (name, conclusion, status = "completed") => ({ name, conclusion, status });
// `status` mặc định "completed": phần lớn ca nói về job đã xong. Ca job đang
// chạy khai status tường minh — chính ca đó đã bắt được lỗi xếp nhầm loại.
const job = (name, conclusion, steps, status = "completed") => ({ name, conclusion, steps, status });

describe("locRunsDanhGia", () => {
  // Cú push `production` kích hoạt CI mới trên nhánh đó — gồm cả run đang chạy
  // chính script promote. Không lọc thì script chấm điểm run chứa chính nó
  // (không bao giờ completed khi đang chấm) ⇒ job promotion đỏ VĨNH VIỄN trên
  // nhánh production. Đo thật 13/08/2026, run 31722280140: cùng SHA xanh trọn
  // trên main mà job này đỏ vì 51 bước "chưa xong" toàn của các run tiếng-vọng.
  it("loại run trên nhánh production — kể cả run đang chạy chính script này", () => {
    const runs = [
      { id: 1, head_branch: "main", status: "completed" },
      { id: 2, head_branch: "production", status: "in_progress" },
      { id: 3, head_branch: "production", status: "completed" },
    ];
    expect(locRunsDanhGia(runs).map((r) => r.id)).toEqual([1]);
  });

  it("không còn run nào sau khi lọc ⇒ trả rỗng để main() fail closed (exit 3)", () => {
    expect(locRunsDanhGia([{ id: 2, head_branch: "production" }])).toEqual([]);
    expect(locRunsDanhGia(undefined)).toEqual([]);
  });
});

describe("GitHub evidence readiness", () => {
  const run = (overrides = {}) => ({ id: 1, name: "CI Gates", head_branch: "main", status: "completed", conclusion: "success", ...overrides });
  const greenJobs = () => [job("quality-gates", "success", [buoc("test", "success")])];
  const read = (runs, jobs = greenJobs()) => readGateEvidence("owner/repo", "abc123", "test-token", async (path) => {
    if (path === "/repos/owner/repo/actions/runs?head_sha=abc123&per_page=100") {
      return { total_count: runs.length, workflow_runs: runs };
    }
    if (path === "/repos/owner/repo/actions/runs/1/jobs?per_page=100") {
      return { total_count: jobs.length, jobs };
    }
    throw new Error(`Unexpected API request: ${path}`);
  });

  it("requires completed run evidence even when visible jobs have already passed", async () => {
    const result = await read([run({ status: "in_progress", conclusion: null })]);
    expect(result.verdict.datDieuKien).toBe(false);
    expect(result.verdict.dangChay).toContain("CI Gates (run in_progress)");
  });

  it.each(["failure", "cancelled", "timed_out"])("rejects a completed %s run even if job listing looks green", async (conclusion) => {
    const result = await read([run({ conclusion })]);
    expect(result.verdict.datDieuKien).toBe(false);
    expect(result.verdict.doGate).toContain(`CI Gates (run ${conclusion})`);
  });

  it("no runs and no jobs remain missing evidence, never a vacuous pass", async () => {
    expect((await read([])).verdict.datDieuKien).toBe(false);
    expect((await read([run()], [])).verdict.datDieuKien).toBe(false);
  });

  it("a success job without step evidence is not a verified gate", async () => {
    expect((await read([run()], [job("quality-gates", "success", [])])).verdict.datDieuKien).toBe(false);
  });

  it("fails closed when a paginated API response is incomplete", async () => {
    await expect(readGateEvidence("owner/repo", "abc123", "test-token", async () => ({
      total_count: 101, workflow_runs: [run()],
    }))).rejects.toThrow(/incomplete/i);
  });

  it("does not approve from a truncated jobs page", async () => {
    await expect(readGateEvidence("owner/repo", "abc123", "test-token", async (path) =>
      path.includes("/jobs?")
        ? { total_count: 101, jobs: greenJobs() }
        : { total_count: 1, workflow_runs: [run()] },
    )).rejects.toThrow(/incomplete/i);
  });

  it("completed success still checks swallowed step failure", async () => {
    const result = await read([run()], [job("quality-gates", "success", [buoc("test", "failure")])]);
    expect(result.verdict.nuot).toEqual(["CI Gates / quality-gates › test"]);
    expect(result.verdict.datDieuKien).toBe(false);
  });

  it("preserves non-production scope and accepts completed green evidence", async () => {
    const result = await read([run(), run({ id: 2, head_branch: "production", status: "in_progress", conclusion: null })]);
    expect(result.verdict.datDieuKien).toBe(true);
    expect(result.jobs).toHaveLength(1);
  });

  const pending = { jobs: [], verdict: { datDieuKien: false, doGate: [], nuot: [], dangChay: ["CI pending"] } };
  const green = { jobs: greenJobs(), verdict: { datDieuKien: true, doGate: [], nuot: [], dangChay: [] } };
  function clock() {
    let time = 0;
    return { waitMs: 30, pollMs: 10, now: () => time, sleep: async (ms) => { time += ms; } };
  }

  it("waits for same-SHA queued CI to finish before returning success", async () => {
    const timeline = [pending, pending, green];
    const result = await waitForGateEvidence(async () => timeline.shift(), clock());
    expect(result.verdict.datDieuKien).toBe(true);
  });

  it("returns unverified evidence at the deadline without treating timeout as success", async () => {
    const options = clock();
    const result = await waitForGateEvidence(async () => pending, options);
    expect(result.verdict.datDieuKien).toBe(false);
    expect(options.now()).toBe(30);
  });

  it.each(["doGate", "nuot"])("does not retry an actual %s failure while another job is pending", async (kind) => {
    const options = clock();
    const failed = { ...pending, verdict: { ...pending.verdict, [kind]: ["test failed"] } };
    const result = await waitForGateEvidence(async () => failed, options);
    expect(result.verdict[kind]).toEqual(["test failed"]);
    expect(options.now()).toBe(0);
  });

  it("does not retry API errors or hide them behind a later green result", async () => {
    const options = clock();
    await expect(waitForGateEvidence(async () => { throw new Error("GitHub API 403"); }, options)).rejects.toThrow("GitHub API 403");
    expect(options.now()).toBe(0);
  });

  it("default remains a single dry-run observation without waiting", async () => {
    expect(await waitForGateEvidence(async () => pending)).toBe(pending);
  });
});

describe("promotion CLI exit codes", () => {
  const script = fileURLToPath(new URL("../promote-to-production.mjs", import.meta.url));
  const successfulJob = job("ci", "success", [buoc("test", "success")]);
  it.each([
    ["missing jobs", [], 200, 3],
    ["queued job", [job("ci", null, [], "queued")], 200, 3],
    ["failed step hidden by job success", [job("ci", "success", [buoc("test", "failure")])], 200, 1],
    ["verified green dry run", [successfulJob], 200, 0],
    ["API failure", [successfulJob], 403, 3],
  ])("%s", (_name, jobs, apiStatus, expected) => {
    const fixture = `globalThis.fetch = async (url) => {
      if (!url.startsWith('https://api.github.com/')) throw new Error('Unexpected URL');
      const body = url.includes('/jobs?')
        ? ${JSON.stringify({ total_count: jobs.length, jobs })}
        : { total_count: 1, workflow_runs: [{ id: 1, name: 'CI Gates', head_branch: 'main', status: 'completed', conclusion: 'success' }] };
      return new Response(JSON.stringify(body), { status: ${apiStatus} });
    };`;
    const result = spawnSync(process.execPath, [
      "--import", `data:text/javascript;base64,${Buffer.from(fixture).toString("base64")}`,
      script, "--sha", "a".repeat(40), "--wait-seconds", "0",
    ], { encoding: "utf8", env: { ...process.env, GH_TOKEN: "fixture-only", GITHUB_TOKEN: "" }, timeout: 10_000 });
    expect(result.status, result.stderr).toBe(expected);
    if (expected === 0) expect(result.stdout).toContain("dry-run — chạy lại với --apply");
    else expect(result.stdout).not.toContain("✅ Mọi bước đều xanh");
  });
});

describe("danhGiaJobs", () => {
  it("mọi bước xanh ⇒ đủ điều kiện promote", () => {
    const kq = danhGiaJobs([job("ci / gates", "success", [buoc("a", "success"), buoc("b", "success")])]);
    expect(kq.datDieuKien).toBe(true);
    expect(kq.doGate).toEqual([]);
    expect(kq.nuot).toEqual([]);
  });

  it("BƯỚC fail mà JOB success ⇒ bắt được, xếp vào nhóm `nuot`", () => {
    // Đây chính là hình dạng mà continue-on-error tạo ra.
    const kq = danhGiaJobs([job("ci / gates", "success", [buoc("gate X", "failure")])]);
    expect(kq.datDieuKien).toBe(false);
    expect(kq.nuot).toEqual(["ci / gates › gate X"]);
    expect(kq.doGate).toEqual([]); // tách riêng: nó KHÁC một job đỏ bình thường
  });

  it("bước fail và job cũng fail ⇒ nhóm `doGate`, không lẫn vào `nuot`", () => {
    const kq = danhGiaJobs([job("ci / gates", "failure", [buoc("gate Y", "failure")])]);
    expect(kq.doGate).toEqual(["ci / gates › gate Y"]);
    expect(kq.nuot).toEqual([]);
  });

  it("timed_out cũng là fail — hết giờ không phải là qua", () => {
    const kq = danhGiaJobs([job("ci", "success", [buoc("chậm", "timed_out")])]);
    expect(kq.nuot).toEqual(["ci › chậm"]);
  });

  it("bước CHƯA XONG ⇒ chưa kết luận được, KHÔNG đọc thành xanh", () => {
    const kq = danhGiaJobs([job("ci", null, [buoc("đang chạy", null, "in_progress")], "in_progress")]);
    expect(kq.datDieuKien).toBe(false);
    expect(kq.dangChay).toEqual(["ci › đang chạy"]);
  });

  it("job đỏ mà KHÔNG bước nào đỏ (huỷ, runner chết) vẫn bị chặn", () => {
    // Nếu chỉ duyệt bước thì ca này lọt: danh sách bước rỗng hoặc toàn success.
    const kq = danhGiaJobs([job("ci", "cancelled", [buoc("a", "success")])]);
    expect(kq.datDieuKien).toBe(false);
    expect(kq.doGate[0]).toContain("cancelled");
  });

  it("job `skipped` không bị tính là đỏ", () => {
    expect(danhGiaJobs([job("ci", "skipped", [])]).datDieuKien).toBe(true);
  });

  it.each(["queued", "in_progress"])("job %s chưa có bước vẫn chặn phát hành", (status) => {
    const result = danhGiaJobs([job("ci", null, [], status)]);
    expect(result.datDieuKien).toBe(false);
    expect(result.dangChay).toEqual([`ci (job ${status})`]);
    expect(result.doGate).toEqual([]);
  });

  it("job còn chạy dù bước cuối vừa xong vẫn chưa đủ bằng chứng", () => {
    const result = danhGiaJobs([job("ci", null, [buoc("a", "success")], "in_progress")]);
    expect(result.datDieuKien).toBe(false);
    expect(result.dangChay).toEqual(["ci (job in_progress)"]);
  });

  it("không có job nào ⇒ đủ điều kiện theo hàm này — chặn nằm ở phía gọi", () => {
    // Hàm thuần không biết "0 job" là bất thường; phía gọi thoát 3 khi API trả
    // rỗng. Ghim ranh giới trách nhiệm đó ở đây để không ai nhét sàn vào nhầm chỗ.
    expect(danhGiaJobs([]).datDieuKien).toBe(true);
  });

  it("nhiều job trộn lẫn: gom đủ cả ba nhóm, không nhóm nào nuốt nhóm nào", () => {
    const kq = danhGiaJobs([
      job("w1 / a", "success", [buoc("ok", "success"), buoc("nuot", "failure")]),
      job("w1 / b", "failure", [buoc("do", "failure")]),
      job("w2 / c", null, [buoc("cho", null, "queued")], "in_progress"),
    ]);
    expect(kq.nuot).toEqual(["w1 / a › nuot"]);
    expect(kq.doGate).toEqual(["w1 / b › do"]);
    expect(kq.dangChay).toEqual(["w2 / c › cho"]);
    expect(kq.datDieuKien).toBe(false);
  });
});
